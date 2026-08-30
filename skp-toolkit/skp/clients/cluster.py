import shutil
import subprocess
import urllib.parse

from skp.clients.http import Unreachable

DEFAULT_TIMEOUT = 30

_DEFAULT_PORTS = {"https": 443, "http": 80}


def detect_binary(which=shutil.which) -> str:
    """``oc`` first: on OpenShift it is the one that carries the login context."""
    for candidate in ("oc", "kubectl"):
        if which(candidate):
            return candidate
    raise Unreachable("cluster", "neither 'oc' nor 'kubectl' is on PATH")


def normalise_server(url: str) -> str:
    """Collapse the cosmetic differences a real cluster URL can vary by:
    a trailing slash, a default port spelled out explicitly, and
    ``127.0.0.1`` vs ``localhost``. A check that false-alarms on these
    trains operators to ignore it, which is worse than not checking."""
    parsed = urllib.parse.urlsplit(url.strip())
    scheme = (parsed.scheme or "https").lower()
    host = (parsed.hostname or "").lower()
    if host == "127.0.0.1":
        host = "localhost"
    port = parsed.port
    netloc = host if port is None or port == _DEFAULT_PORTS.get(scheme) else f"{host}:{port}"
    path = parsed.path.rstrip("/")
    return f"{scheme}://{netloc}{path}"


def active_server(binary: str, runner=subprocess.run, timeout: int = DEFAULT_TIMEOUT) -> str:
    """The server URL of the currently active kube context, read the same way
    ``skp init`` derives ``--cluster-url`` when it is not given explicitly."""
    command = [binary, "config", "view", "--minify", "-o",
               "jsonpath={.clusters[0].cluster.server}"]
    completed = runner(command, capture_output=True, text=True, timeout=timeout)
    if completed.returncode != 0:
        raise Unreachable("cluster", (completed.stderr or completed.stdout).strip())
    server = (completed.stdout or "").strip()
    if not server:
        raise Unreachable("cluster", "no active kube context (config view returned nothing)")
    return server


class ClusterClient:
    def __init__(self, project: str, binary: str = "oc",
                 runner=subprocess.run, timeout: int = DEFAULT_TIMEOUT,
                 expected_server: str | None = None):
        self.project = project
        self.binary = binary
        self._run = runner
        self.timeout = timeout
        self.expected_server = expected_server
        self._verified = False

    def _verify_server(self) -> None:
        """Runs once per process, on the first ``run()`` call. A profile can
        name one cluster while the ambient kubeconfig actually points at
        another; every verb built on ``build_clients`` goes through this,
        so the mismatch is caught before any answer is attributed to the
        wrong system."""
        if self._verified or self.expected_server is None:
            self._verified = True
            return
        actual = active_server(self.binary, runner=self._run, timeout=self.timeout)
        if normalise_server(actual) != normalise_server(self.expected_server):
            raise Unreachable(
                "cluster",
                f"profile names {self.expected_server}; the active context is {actual}")
        self._verified = True

    def run(self, argv: list[str], target: str = "cluster") -> str:
        self._verify_server()
        command = [self.binary, "-n", self.project, *argv]
        completed = self._run(command, capture_output=True, text=True, timeout=self.timeout)
        if completed.returncode != 0:
            raise Unreachable(target, (completed.stderr or completed.stdout).strip())
        return (completed.stdout or "").strip()

    def exec(self, workload: str, argv: list[str]) -> str:
        return self.run(["exec", workload, "--", *argv], target=workload)

    def version(self) -> str:
        return self.run(["version", "--output=json"])
