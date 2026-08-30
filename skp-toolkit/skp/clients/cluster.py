import shutil
import subprocess

from skp.clients.http import Unreachable

DEFAULT_TIMEOUT = 30


def detect_binary(which=shutil.which) -> str:
    """``oc`` first: on OpenShift it is the one that carries the login context."""
    for candidate in ("oc", "kubectl"):
        if which(candidate):
            return candidate
    raise Unreachable("cluster", "neither 'oc' nor 'kubectl' is on PATH")


class ClusterClient:
    def __init__(self, project: str, binary: str = "oc",
                 runner=subprocess.run, timeout: int = DEFAULT_TIMEOUT):
        self.project = project
        self.binary = binary
        self._run = runner
        self.timeout = timeout

    def run(self, argv: list[str], target: str = "cluster") -> str:
        command = [self.binary, "-n", self.project, *argv]
        completed = self._run(command, capture_output=True, text=True, timeout=self.timeout)
        if completed.returncode != 0:
            raise Unreachable(target, (completed.stderr or completed.stdout).strip())
        return (completed.stdout or "").strip()

    def exec(self, workload: str, argv: list[str]) -> str:
        return self.run(["exec", workload, "--", *argv], target=workload)

    def version(self) -> str:
        return self.run(["version", "--output=json"])
