# SKP toolkit, phases 1–2: Ground and Compile — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the foundation of the SKP toolkit — a profile and memory folder, seven infrastructure clients, `skp init`, and a compiler that generates the capability catalog from the C# sources with drift and coverage checks — exposed as `skp init`, `skp map` and `skp doctor`.

**Architecture:** A stdlib-only Python package. HTTP targets (BaseAPI, Elasticsearch, Prometheus) go through `urllib.request`; Postgres, Redis and RabbitMQ go through `oc exec` / `kubectl exec` into their pods, exactly as `k8s/README.md` already does. Every command returns a `Result` carrying an exit code and a `NEXT:` breadcrumb. The catalog is *generated* from `src/` by regex extractors and merged with hand-written annotation files; a missing annotation is a compile error, not a silent gap.

**Tech Stack:** Python 3.11, stdlib only (`urllib`, `subprocess`, `json`, `re`, `hashlib`, `argparse`, `dataclasses`, `unittest`). No third-party packages, no pip at runtime.

**Spec:** `docs/superpowers/specs/2026-08-30-skp-skill-bundle-design.md`

## Global Constraints

- **Stdlib only.** No `pip install`, ever. The target machine is offline. The repo's existing Python (`grafana/*.py`) is already stdlib-only; follow it.
- **Tests use `unittest`, run with `python -m unittest discover -s skp-toolkit/tests -t skp-toolkit`.** pytest is not installed and must not be added.
- **Python 3.11.** `from __future__ import annotations` is unnecessary; `X | None` syntax is available.
- **No RabbitMQ HTTP management API.** No `:15672`, no `/api/queues`. Broker facts come from `rabbitmqctl` via exec. (Constraint inherited from `2026-08-22-pipeline-metrics-design.md`.)
- **The token is never printed.** Any string rendered to stdout passes through `profile.redact()`.
- **Reads are unrestricted; this plan implements no writes at all.** Phases 1–2 are read-only against every store.
- **Every user-facing failure names a `NEXT:` command or a `SEE:` reference.** A bare traceback is a defect.
- **Generated files are never hand-edited.** Their hashes live in `compile.lock`.
- **Exit codes are fixed** (Task 1): `0` ok, `1` usage, `2` not initialised, `3` verdict-is-no, `4` unreachable, `5` drift.
- Workload names in this cluster, used verbatim: `sts/postgres`, `sts/redis`, `sts/rabbitmq`, `deploy/prometheus`, `deploy/baseapi-service`.

---

### Task 1: Package skeleton, `Result`, and the `NEXT:` contract

**Files:**
- Create: `skp-toolkit/skp/__init__.py`
- Create: `skp-toolkit/skp/result.py`
- Create: `skp-toolkit/skp/__main__.py`
- Create: `skp-toolkit/skp/cli.py`
- Create: `skp-toolkit/tests/__init__.py`
- Test: `skp-toolkit/tests/test_result.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `Result(code: int, lines: list[str], next_command: str | None, reference: str | None)` with `.render() -> str`; module constants `EXIT_OK=0, EXIT_USAGE=1, EXIT_NOT_INITIALISED=2, EXIT_VERDICT=3, EXIT_UNREACHABLE=4, EXIT_DRIFT=5`; `cli.main(argv: list[str]) -> int`.

- [ ] **Step 1: Write the failing test**

```python
# skp-toolkit/tests/test_result.py
import unittest

from skp.result import EXIT_VERDICT, Result


class RenderTests(unittest.TestCase):
    def test_next_is_the_last_line(self):
        r = Result(EXIT_VERDICT, ["start rejected at gate 'schemaEdge'"],
                   next_command="skp map --component api")
        self.assertEqual(
            r.render(),
            "start rejected at gate 'schemaEdge'\nNEXT: skp map --component api",
        )

    def test_reference_precedes_next(self):
        r = Result(EXIT_VERDICT, ["rejected"],
                   next_command="skp doctor",
                   reference="references/gate-schema-edge.md")
        self.assertEqual(
            r.render(),
            "rejected\nSEE: references/gate-schema-edge.md\nNEXT: skp doctor",
        )

    def test_plain_result_renders_only_its_lines(self):
        self.assertEqual(Result(0, ["ok"]).render(), "ok")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd skp-toolkit && python -m unittest tests.test_result -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'skp'`

- [ ] **Step 3: Write minimal implementation**

```python
# skp-toolkit/skp/__init__.py
"""The SKP toolkit: deterministic verbs over a compiled capability catalog."""
```

```python
# skp-toolkit/skp/result.py
from dataclasses import dataclass, field

EXIT_OK = 0
EXIT_USAGE = 1
EXIT_NOT_INITIALISED = 2
EXIT_VERDICT = 3
EXIT_UNREACHABLE = 4
EXIT_DRIFT = 5


@dataclass
class Result:
    """What every verb returns.

    ``next_command`` is not decoration. A small model does not hold a plan across
    turns, so each verb names the one command that follows it.
    """

    code: int
    lines: list[str] = field(default_factory=list)
    next_command: str | None = None
    reference: str | None = None

    def render(self) -> str:
        out = list(self.lines)
        if self.reference:
            out.append(f"SEE: {self.reference}")
        if self.next_command:
            out.append(f"NEXT: {self.next_command}")
        return "\n".join(out)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd skp-toolkit && python -m unittest tests.test_result -v`
Expected: PASS (3 tests)

- [ ] **Step 5: Add the CLI entry point**

```python
# skp-toolkit/skp/cli.py
import argparse

from skp.result import EXIT_USAGE, Result

GROUPS: dict[str, object] = {}
"""Group name -> callable(args: list[str]) -> Result. Populated by later tasks."""


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="skp", add_help=True)
    parser.add_argument("group", nargs="?", help="command group")
    parser.add_argument("rest", nargs=argparse.REMAINDER)
    ns = parser.parse_args(argv)

    if ns.group is None or ns.group not in GROUPS:
        known = ", ".join(sorted(GROUPS)) or "none registered"
        result = Result(EXIT_USAGE,
                        [f"unknown command group {ns.group!r}. known: {known}"],
                        next_command="skp init")
    else:
        result = GROUPS[ns.group](ns.rest)

    print(result.render())
    return result.code
```

```python
# skp-toolkit/skp/__main__.py
import sys

from skp.cli import main

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
```

```python
# skp-toolkit/tests/__init__.py
```

- [ ] **Step 6: Verify the entry point runs**

Run: `cd skp-toolkit && python -m skp nosuchgroup`
Expected: prints `unknown command group 'nosuchgroup'. known: none registered` then `NEXT: skp init`, exit code 1

- [ ] **Step 7: Commit**

```bash
git add skp-toolkit/
git commit -m "feat(skp): package skeleton, Result and the NEXT: contract"
```

---

### Task 2: Profile and the memory folder

**Files:**
- Create: `skp-toolkit/skp/profile.py`
- Test: `skp-toolkit/tests/test_profile.py`

**Interfaces:**
- Consumes: `skp.result.Result`, `EXIT_NOT_INITIALISED`.
- Produces: `Profile(home: Path, source_root: str, cluster_url: str, project: str, endpoints: dict[str, str])`; `Profile.save()`; `Profile.load(home: Path) -> Profile`; `Profile.token -> str`; `ProfileMissing`; `redact(text: str, token: str) -> str`; `default_home() -> Path`; `not_initialised() -> Result`.

- [ ] **Step 1: Write the failing test**

```python
# skp-toolkit/tests/test_profile.py
import json
import pathlib
import tempfile
import unittest

from skp.profile import Profile, ProfileMissing, not_initialised, redact
from skp.result import EXIT_NOT_INITIALISED


class ProfileTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = pathlib.Path(self.tmp.name) / ".skp"

    def tearDown(self):
        self.tmp.cleanup()

    def make(self) -> Profile:
        return Profile(
            home=self.home,
            source_root="/repo/src",
            cluster_url="https://api.dev.example:6443",
            project="skp",
            endpoints={"prometheus": "http://prometheus:9090"},
        )

    def test_token_is_not_written_into_profile_json(self):
        self.make().save(token="sha256~SECRETVALUE")
        text = (self.home / "profile.json").read_text(encoding="utf-8")
        self.assertNotIn("SECRETVALUE", text)
        self.assertEqual(json.loads(text)["project"], "skp")

    def test_token_round_trips_through_its_own_file(self):
        self.make().save(token="sha256~SECRETVALUE")
        self.assertEqual(Profile.load(self.home).token, "sha256~SECRETVALUE")

    def test_load_without_init_raises(self):
        with self.assertRaises(ProfileMissing):
            Profile.load(self.home)

    def test_not_initialised_routes_back_to_init(self):
        result = not_initialised()
        self.assertEqual(result.code, EXIT_NOT_INITIALISED)
        self.assertEqual(result.next_command, "skp init")

    def test_redact_masks_every_occurrence(self):
        masked = redact("Bearer S3CRET and again S3CRET", "S3CRET")
        self.assertEqual(masked, "Bearer <token from profile> and again <token from profile>")

    def test_redact_is_a_no_op_for_an_empty_token(self):
        self.assertEqual(redact("nothing to hide", ""), "nothing to hide")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd skp-toolkit && python -m unittest tests.test_profile -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'skp.profile'`

- [ ] **Step 3: Write minimal implementation**

```python
# skp-toolkit/skp/profile.py
import json
import os
import pathlib
from dataclasses import asdict, dataclass, field

from skp.result import EXIT_NOT_INITIALISED, Result

TOKEN_MASK = "<token from profile>"


class ProfileMissing(Exception):
    """No memory folder here yet. The caller should return ``not_initialised()``."""


def default_home() -> pathlib.Path:
    return pathlib.Path.home() / ".skp"


def redact(text: str, token: str) -> str:
    """Replace the token wherever it appears. Called on every rendered string."""
    if not token:
        return text
    return text.replace(token, TOKEN_MASK)


def not_initialised() -> Result:
    return Result(
        EXIT_NOT_INITIALISED,
        ["no memory folder — this machine has not been initialised"],
        next_command="skp init",
    )


@dataclass
class Profile:
    home: pathlib.Path
    source_root: str
    cluster_url: str
    project: str
    endpoints: dict[str, str] = field(default_factory=dict)

    # ---- persistence -------------------------------------------------

    def save(self, token: str) -> None:
        """Write the profile and, separately, the token.

        The token lives in its own file so that ``profile.json`` can be read,
        pasted and diffed freely. ``chmod`` is best-effort: on Windows it only
        toggles the read-only bit, so the separation — not the mode — is what
        carries the guarantee.
        """
        self.home.mkdir(parents=True, exist_ok=True)
        for sub in ("model", "state", "cases"):
            (self.home / sub).mkdir(exist_ok=True)

        body = asdict(self)
        body["home"] = str(self.home)
        (self.home / "profile.json").write_text(
            json.dumps(body, indent=2, sort_keys=True), encoding="utf-8")

        token_path = self.home / "token"
        token_path.write_text(token, encoding="utf-8")
        try:
            os.chmod(token_path, 0o600)
        except OSError:
            pass

    @classmethod
    def load(cls, home: pathlib.Path | None = None) -> "Profile":
        home = home or default_home()
        path = home / "profile.json"
        if not path.exists():
            raise ProfileMissing(str(path))
        body = json.loads(path.read_text(encoding="utf-8"))
        return cls(
            home=pathlib.Path(body["home"]),
            source_root=body["source_root"],
            cluster_url=body["cluster_url"],
            project=body["project"],
            endpoints=body.get("endpoints", {}),
        )

    # ---- accessors ---------------------------------------------------

    @property
    def token(self) -> str:
        path = self.home / "token"
        return path.read_text(encoding="utf-8") if path.exists() else ""

    def redact(self, text: str) -> str:
        return redact(text, self.token)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd skp-toolkit && python -m unittest tests.test_profile -v`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add skp-toolkit/skp/profile.py skp-toolkit/tests/test_profile.py
git commit -m "feat(skp): profile, memory folder layout and token redaction"
```

---

### Task 3: HTTP client

**Files:**
- Create: `skp-toolkit/skp/clients/__init__.py`
- Create: `skp-toolkit/skp/clients/http.py`
- Test: `skp-toolkit/tests/test_http.py`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `HttpClient(base: str, token: str = "", timeout: float = 10.0, opener=urllib.request.urlopen)` with `.get_json(path: str, params: dict | None = None) -> object` and `.post_json(path: str, body: object) -> object`; `Unreachable(Exception)` carrying `.target` and `.detail`.

The `opener` parameter exists so tests never touch a network. Every later client that speaks HTTP takes an `HttpClient`.

- [ ] **Step 1: Write the failing test**

```python
# skp-toolkit/tests/test_http.py
import io
import json
import unittest
import urllib.error

from skp.clients.http import HttpClient, Unreachable


def fake_opener(payload: object, capture: list | None = None):
    def _open(request, timeout=None):
        if capture is not None:
            capture.append(request)
        return io.BytesIO(json.dumps(payload).encode("utf-8"))
    return _open


class HttpClientTests(unittest.TestCase):
    def test_get_json_returns_decoded_body(self):
        client = HttpClient("http://api:8080", opener=fake_opener({"status": "Healthy"}))
        self.assertEqual(client.get_json("/health/ready"), {"status": "Healthy"})

    def test_get_json_builds_the_url_with_params(self):
        seen: list = []
        client = HttpClient("http://prom:9090", opener=fake_opener({}, seen))
        client.get_json("/api/v1/query", {"query": "up"})
        self.assertEqual(seen[0].full_url, "http://prom:9090/api/v1/query?query=up")

    def test_token_becomes_an_authorization_header(self):
        seen: list = []
        client = HttpClient("http://api:8080", token="T0K", opener=fake_opener({}, seen))
        client.get_json("/x")
        self.assertEqual(seen[0].get_header("Authorization"), "Bearer T0K")

    def test_no_token_means_no_authorization_header(self):
        seen: list = []
        client = HttpClient("http://api:8080", opener=fake_opener({}, seen))
        client.get_json("/x")
        self.assertIsNone(seen[0].get_header("Authorization"))

    def test_post_json_sends_a_json_body(self):
        seen: list = []
        client = HttpClient("http://api:8080", opener=fake_opener({}, seen))
        client.post_json("/api/v1.0/orchestration/start", "abc")
        self.assertEqual(seen[0].data, b'"abc"')
        self.assertEqual(seen[0].get_header("Content-type"), "application/json")

    def test_a_transport_error_becomes_Unreachable(self):
        def boom(request, timeout=None):
            raise urllib.error.URLError("connection refused")

        client = HttpClient("http://es:9200", opener=boom)
        with self.assertRaises(Unreachable) as caught:
            client.get_json("/")
        self.assertEqual(caught.exception.target, "http://es:9200")
        self.assertIn("connection refused", caught.exception.detail)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd skp-toolkit && python -m unittest tests.test_http -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'skp.clients'`

- [ ] **Step 3: Write minimal implementation**

```python
# skp-toolkit/skp/clients/__init__.py
"""Thin, stdlib-only clients. One per component in the capability catalog."""
```

```python
# skp-toolkit/skp/clients/http.py
import json
import urllib.error
import urllib.parse
import urllib.request


class Unreachable(Exception):
    """A target did not answer. Reported as a named red row, never as a traceback."""

    def __init__(self, target: str, detail: str):
        super().__init__(f"{target}: {detail}")
        self.target = target
        self.detail = detail


class HttpClient:
    def __init__(self, base: str, token: str = "", timeout: float = 10.0,
                 opener=urllib.request.urlopen):
        self.base = base.rstrip("/")
        self.token = token
        self.timeout = timeout
        self._open = opener

    def _request(self, path: str, params: dict | None, data: bytes | None):
        url = self.base + path
        if params:
            url = f"{url}?{urllib.parse.urlencode(params)}"
        request = urllib.request.Request(url, data=data)
        if self.token:
            request.add_header("Authorization", f"Bearer {self.token}")
        if data is not None:
            request.add_header("Content-Type", "application/json")
        try:
            with self._open(request, timeout=self.timeout) as response:
                raw = response.read()
        except urllib.error.HTTPError as exc:
            raise Unreachable(self.base, f"HTTP {exc.code} for {path}") from exc
        except (urllib.error.URLError, OSError) as exc:
            raise Unreachable(self.base, str(getattr(exc, "reason", exc))) from exc
        return json.loads(raw) if raw else None

    def get_json(self, path: str, params: dict | None = None):
        return self._request(path, params, None)

    def post_json(self, path: str, body):
        return self._request(path, None, json.dumps(body).encode("utf-8"))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd skp-toolkit && python -m unittest tests.test_http -v`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add skp-toolkit/skp/clients/ skp-toolkit/tests/test_http.py
git commit -m "feat(skp): stdlib HTTP client with structured unreachability"
```

---

### Task 4: Cluster client

**Files:**
- Create: `skp-toolkit/skp/clients/cluster.py`
- Test: `skp-toolkit/tests/test_cluster.py`

**Interfaces:**
- Consumes: `skp.clients.http.Unreachable`.
- Produces: `ClusterClient(project: str, binary: str = "oc", runner=subprocess.run)` with `.exec(workload: str, argv: list[str]) -> str`, `.run(argv: list[str]) -> str`, `.version() -> str`; `detect_binary(which=shutil.which) -> str`.

`oc` and `kubectl` take identical arguments for everything used here, so one client covers both clusters — which is what makes kind and OpenShift two profiles of one procedure.

- [ ] **Step 1: Write the failing test**

```python
# skp-toolkit/tests/test_cluster.py
import subprocess
import unittest

from skp.clients.cluster import ClusterClient, detect_binary
from skp.clients.http import Unreachable


class FakeRunner:
    def __init__(self, stdout="", returncode=0, stderr=""):
        self.calls: list[list[str]] = []
        self.result = subprocess.CompletedProcess([], returncode, stdout, stderr)

    def __call__(self, argv, capture_output=True, text=True, timeout=None):
        self.calls.append(argv)
        return self.result


class ClusterClientTests(unittest.TestCase):
    def test_exec_builds_the_canonical_command(self):
        runner = FakeRunner(stdout="PONG\n")
        client = ClusterClient("skp", binary="oc", runner=runner)
        self.assertEqual(client.exec("sts/redis", ["redis-cli", "PING"]), "PONG")
        self.assertEqual(
            runner.calls[0],
            ["oc", "-n", "skp", "exec", "sts/redis", "--", "redis-cli", "PING"],
        )

    def test_kubectl_is_addressed_identically(self):
        runner = FakeRunner(stdout="ok\n")
        ClusterClient("skp", binary="kubectl", runner=runner).exec("sts/redis", ["true"])
        self.assertEqual(runner.calls[0][0], "kubectl")

    def test_a_nonzero_exit_becomes_Unreachable_carrying_stderr(self):
        runner = FakeRunner(returncode=1, stderr="error: pod not found\n")
        client = ClusterClient("skp", binary="oc", runner=runner)
        with self.assertRaises(Unreachable) as caught:
            client.exec("sts/redis", ["redis-cli", "PING"])
        self.assertEqual(caught.exception.target, "sts/redis")
        self.assertIn("pod not found", caught.exception.detail)

    def test_detect_prefers_oc_when_both_exist(self):
        self.assertEqual(detect_binary(which=lambda n: f"/usr/bin/{n}"), "oc")

    def test_detect_falls_back_to_kubectl(self):
        self.assertEqual(
            detect_binary(which=lambda n: "/usr/bin/kubectl" if n == "kubectl" else None),
            "kubectl",
        )

    def test_detect_raises_when_neither_is_installed(self):
        with self.assertRaises(Unreachable):
            detect_binary(which=lambda n: None)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd skp-toolkit && python -m unittest tests.test_cluster -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'skp.clients.cluster'`

- [ ] **Step 3: Write minimal implementation**

```python
# skp-toolkit/skp/clients/cluster.py
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd skp-toolkit && python -m unittest tests.test_cluster -v`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add skp-toolkit/skp/clients/cluster.py skp-toolkit/tests/test_cluster.py
git commit -m "feat(skp): cluster client over oc|kubectl exec"
```

---

### Task 5: Exec-based store clients — Postgres, Redis, RabbitMQ

**Files:**
- Create: `skp-toolkit/skp/clients/pg.py`
- Create: `skp-toolkit/skp/clients/redis.py`
- Create: `skp-toolkit/skp/clients/rabbit.py`
- Test: `skp-toolkit/tests/test_stores_exec.py`

**Interfaces:**
- Consumes: `ClusterClient` (Task 4), `Unreachable` (Task 3).
- Produces:
  - `Postgres(cluster: ClusterClient, workload: str = "sts/postgres")` with `.rows(sql: str) -> list[list[str]]` and `.ping() -> bool`.
  - `Redis(cluster: ClusterClient, workload: str = "sts/redis")` with `.keys(pattern: str) -> list[str]`, `.get(key: str) -> str`, `.ttl(key: str) -> int`, `.smembers(key: str) -> list[str]`, `.ping() -> bool`.
  - `Rabbit(cluster: ClusterClient, workload: str = "sts/rabbitmq")` with `.queues() -> list[dict]` (each `{"name", "messages", "consumers"}`) and `.ping() -> bool`.

`psql -tAc` gives pipe-separated, unaligned, header-free rows — the only shape worth parsing. Credentials come from the pod's own environment (`skp-dev-secrets`), so no secret is ever passed on a command line.

- [ ] **Step 1: Write the failing test**

```python
# skp-toolkit/tests/test_stores_exec.py
import json
import unittest

from skp.clients.pg import Postgres
from skp.clients.rabbit import Rabbit
from skp.clients.redis import Redis


class FakeCluster:
    def __init__(self, stdout=""):
        self.calls: list[tuple[str, list[str]]] = []
        self.stdout = stdout

    def exec(self, workload, argv):
        self.calls.append((workload, argv))
        return self.stdout


class PostgresTests(unittest.TestCase):
    def test_rows_splits_on_pipes_and_newlines(self):
        cluster = FakeCluster("a|1\nb|2")
        rows = Postgres(cluster).rows("SELECT name, n FROM t")
        self.assertEqual(rows, [["a", "1"], ["b", "2"]])

    def test_empty_output_is_no_rows(self):
        self.assertEqual(Postgres(FakeCluster("")).rows("SELECT 1"), [])

    def test_credentials_are_read_from_the_pod_environment(self):
        cluster = FakeCluster("1")
        Postgres(cluster).rows("SELECT 1")
        workload, argv = cluster.calls[0]
        self.assertEqual(workload, "sts/postgres")
        self.assertEqual(argv[0], "sh")
        self.assertIn('psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc', argv[2])
        self.assertIn("SELECT 1", argv[2])


class RedisTests(unittest.TestCase):
    def test_keys_returns_one_entry_per_line(self):
        cluster = FakeCluster("skp:proc:a\nskp:proc:b")
        self.assertEqual(Redis(cluster).keys("skp:proc:*"), ["skp:proc:a", "skp:proc:b"])
        self.assertEqual(cluster.calls[0][1], ["redis-cli", "KEYS", "skp:proc:*"])

    def test_no_keys_is_an_empty_list_not_a_blank_entry(self):
        self.assertEqual(Redis(FakeCluster("")).keys("nope:*"), [])

    def test_ttl_is_an_int(self):
        self.assertEqual(Redis(FakeCluster("40")).ttl("skp:proc:a:pod-1"), 40)

    def test_ping_is_true_only_on_PONG(self):
        self.assertTrue(Redis(FakeCluster("PONG")).ping())
        self.assertFalse(Redis(FakeCluster("")).ping())


class RabbitTests(unittest.TestCase):
    def test_queues_are_read_as_json_not_scraped_from_columns(self):
        payload = json.dumps([
            {"name": "orchestrator-result", "messages": 3, "consumers": 2},
            {"name": "orchestrator-result.dead", "messages": 0, "consumers": 0},
        ])
        cluster = FakeCluster(payload)
        queues = Rabbit(cluster).queues()
        self.assertEqual(queues[0]["name"], "orchestrator-result")
        self.assertEqual(queues[0]["messages"], 3)
        self.assertIn("--formatter=json", cluster.calls[0][1])

    def test_the_management_http_api_is_never_addressed(self):
        cluster = FakeCluster("[]")
        Rabbit(cluster).queues()
        flat = " ".join(cluster.calls[0][1])
        self.assertNotIn("15672", flat)
        self.assertNotIn("/api/queues", flat)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd skp-toolkit && python -m unittest tests.test_stores_exec -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'skp.clients.pg'`

- [ ] **Step 3: Write minimal implementation**

```python
# skp-toolkit/skp/clients/pg.py
from skp.clients.http import Unreachable


class Postgres:
    """Authoritative for the *definition*: entities and the three junction tables.

    Never for what is currently running — that is L2's answer, and the two
    legitimately diverge between a PUT and the next start.
    """

    def __init__(self, cluster, workload: str = "sts/postgres"):
        self.cluster = cluster
        self.workload = workload

    def rows(self, sql: str) -> list[list[str]]:
        script = f'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "{sql}"'
        out = self.cluster.exec(self.workload, ["sh", "-c", script])
        return [line.split("|") for line in out.splitlines() if line.strip()]

    def ping(self) -> bool:
        try:
            self.cluster.exec(self.workload, ["pg_isready"])
            return True
        except Unreachable:
            return False
```

```python
# skp-toolkit/skp/clients/redis.py
from skp.clients.http import Unreachable


class Redis:
    """Authoritative for what is projected (L1/L2) and what is in flight (blobs)."""

    def __init__(self, cluster, workload: str = "sts/redis"):
        self.cluster = cluster
        self.workload = workload

    def _cli(self, *argv: str) -> str:
        return self.cluster.exec(self.workload, ["redis-cli", *argv])

    def keys(self, pattern: str) -> list[str]:
        return [k for k in self._cli("KEYS", pattern).splitlines() if k.strip()]

    def get(self, key: str) -> str:
        return self._cli("GET", key)

    def ttl(self, key: str) -> int:
        return int(self._cli("TTL", key) or -2)

    def smembers(self, key: str) -> list[str]:
        return [m for m in self._cli("SMEMBERS", key).splitlines() if m.strip()]

    def ping(self) -> bool:
        try:
            return self._cli("PING") == "PONG"
        except Unreachable:
            return False
```

```python
# skp-toolkit/skp/clients/rabbit.py
import json

from skp.clients.http import Unreachable


class Rabbit:
    """Authoritative for stuck work.

    Read through ``rabbitmqctl`` only. The HTTP management API is off-limits:
    the broker is org-owned and its owners monitor it (see
    2026-08-22-pipeline-metrics-design.md).
    """

    def __init__(self, cluster, workload: str = "sts/rabbitmq"):
        self.cluster = cluster
        self.workload = workload

    def queues(self) -> list[dict]:
        out = self.cluster.exec(self.workload, [
            "rabbitmqctl", "list_queues", "name", "messages", "consumers",
            "--formatter=json",
        ])
        return json.loads(out) if out else []

    def ping(self) -> bool:
        try:
            self.cluster.exec(self.workload, ["rabbitmqctl", "status", "--formatter=json"])
            return True
        except Unreachable:
            return False
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd skp-toolkit && python -m unittest tests.test_stores_exec -v`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add skp-toolkit/skp/clients/pg.py skp-toolkit/skp/clients/redis.py skp-toolkit/skp/clients/rabbit.py skp-toolkit/tests/test_stores_exec.py
git commit -m "feat(skp): Postgres, Redis and RabbitMQ clients over exec"
```

---

### Task 6: HTTP-based store clients — BaseAPI, Elasticsearch, Prometheus

**Files:**
- Create: `skp-toolkit/skp/clients/api.py`
- Create: `skp-toolkit/skp/clients/es.py`
- Create: `skp-toolkit/skp/clients/prom.py`
- Test: `skp-toolkit/tests/test_stores_http.py`

**Interfaces:**
- Consumes: `HttpClient`, `Unreachable` (Task 3).
- Produces:
  - `BaseApi(http: HttpClient)` with `.list(entity: str) -> list[dict]`, `.get(entity: str, id: str) -> dict`, `.by_source_hash(h: str) -> dict`, `.ready() -> bool`; constant `API_PREFIX = "/api/v1.0"`.
  - `Elastic(http: HttpClient)` with `.search(body: dict) -> list[dict]` returning `_source` documents, and `.ready() -> bool`.
  - `Prometheus(http: HttpClient)` with `.query(expr: str) -> list[dict]` returning the `result` array, and `.ready() -> bool`.

- [ ] **Step 1: Write the failing test**

```python
# skp-toolkit/tests/test_stores_http.py
import unittest

from skp.clients.api import API_PREFIX, BaseApi
from skp.clients.es import Elastic
from skp.clients.prom import Prometheus


class FakeHttp:
    def __init__(self, payload=None):
        self.payload = payload
        self.gets: list[tuple[str, dict | None]] = []
        self.posts: list[tuple[str, object]] = []

    def get_json(self, path, params=None):
        self.gets.append((path, params))
        return self.payload

    def post_json(self, path, body):
        self.posts.append((path, body))
        return self.payload


class BaseApiTests(unittest.TestCase):
    def test_list_uses_the_versioned_plural_route(self):
        http = FakeHttp([{"id": "1"}])
        self.assertEqual(BaseApi(http).list("workflows"), [{"id": "1"}])
        self.assertEqual(http.gets[0][0], f"{API_PREFIX}/workflows")

    def test_by_source_hash_lowercases_the_segment(self):
        http = FakeHttp({"id": "1"})
        BaseApi(http).by_source_hash("ABCDEF")
        self.assertEqual(http.gets[0][0], f"{API_PREFIX}/processors/by-source-hash/abcdef")


class ElasticTests(unittest.TestCase):
    def test_search_unwraps_hits_to_sources(self):
        http = FakeHttp({"hits": {"hits": [{"_source": {"body": {"text": "x"}}}]}})
        self.assertEqual(Elastic(http).search({"size": 1}), [{"body": {"text": "x"}}])

    def test_an_empty_result_set_is_an_empty_list(self):
        self.assertEqual(Elastic(FakeHttp({"hits": {"hits": []}})).search({}), [])


class PrometheusTests(unittest.TestCase):
    def test_query_returns_the_result_array(self):
        http = FakeHttp({"status": "success", "data": {"result": [{"value": [0, "1"]}]}})
        self.assertEqual(Prometheus(http).query("up"), [{"value": [0, "1"]}])
        self.assertEqual(http.gets[0], ("/api/v1/query", {"query": "up"}))

    def test_a_failed_query_returns_nothing_rather_than_raising(self):
        self.assertEqual(Prometheus(FakeHttp({"status": "error"})).query("bad{"), [])
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd skp-toolkit && python -m unittest tests.test_stores_http -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'skp.clients.api'`

- [ ] **Step 3: Write minimal implementation**

```python
# skp-toolkit/skp/clients/api.py
from skp.clients.http import Unreachable

API_PREFIX = "/api/v1.0"


class BaseApi:
    """The only write authority in the system. Phases 1-2 read only."""

    def __init__(self, http):
        self.http = http

    def list(self, entity: str) -> list[dict]:
        return self.http.get_json(f"{API_PREFIX}/{entity}") or []

    def get(self, entity: str, id: str) -> dict:
        return self.http.get_json(f"{API_PREFIX}/{entity}/{id}")

    def by_source_hash(self, source_hash: str) -> dict:
        # Matching is byte-exact against a stored lowercase 64-char hex string, so an
        # uppercase variant 404s past a row that exists. Normalise here, once.
        return self.http.get_json(
            f"{API_PREFIX}/processors/by-source-hash/{source_hash.lower()}")

    def ready(self) -> bool:
        try:
            self.http.get_json("/health/ready")
            return True
        except Unreachable:
            return False
```

```python
# skp-toolkit/skp/clients/es.py
from skp.clients.http import Unreachable


class Elastic:
    """Authoritative for run history.

    Callers bound every query on time and workflow: this index holds millions of
    documents on a shared cluster and an unbounded aggregation looks like a hang.
    """

    def __init__(self, http, index: str = "logs-generic-default"):
        self.http = http
        self.index = index

    def search(self, body: dict) -> list[dict]:
        payload = self.http.post_json(f"/{self.index}/_search", body) or {}
        hits = payload.get("hits", {}).get("hits", [])
        return [hit.get("_source", {}) for hit in hits]

    def ready(self) -> bool:
        try:
            self.http.get_json("/")
            return True
        except Unreachable:
            return False
```

```python
# skp-toolkit/skp/clients/prom.py
from skp.clients.http import Unreachable


class Prometheus:
    """Authoritative for rates and per-replica health.

    ``instance`` is the scrape target, not the replica. Per-replica queries must
    group on ``service_instance_id``.
    """

    def __init__(self, http):
        self.http = http

    def query(self, expr: str) -> list[dict]:
        payload = self.http.get_json("/api/v1/query", {"query": expr}) or {}
        if payload.get("status") != "success":
            return []
        return payload.get("data", {}).get("result", [])

    def ready(self) -> bool:
        try:
            self.http.get_json("/-/healthy")
            return True
        except Unreachable:
            return False
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd skp-toolkit && python -m unittest tests.test_stores_http -v`
Expected: PASS (6 tests)

Note: `Prometheus.ready()` calls `/-/healthy`, which returns plain text rather than JSON. `HttpClient._request` calls `json.loads` on a non-empty body, so this raises `json.JSONDecodeError`, not `Unreachable`.

- [ ] **Step 5: Write the failing test for the non-JSON probe**

```python
# append to skp-toolkit/tests/test_stores_http.py
import io
import unittest as _unittest

from skp.clients.http import HttpClient


class PlainTextProbeTests(_unittest.TestCase):
    def test_a_plain_text_body_does_not_crash_the_probe(self):
        def opener(request, timeout=None):
            return io.BytesIO(b"Prometheus Server is Healthy.\n")

        self.assertTrue(Prometheus(HttpClient("http://prom:9090", opener=opener)).ready())
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd skp-toolkit && python -m unittest tests.test_stores_http.PlainTextProbeTests -v`
Expected: FAIL with `json.decoder.JSONDecodeError: Expecting value`

- [ ] **Step 7: Add a text accessor and use it for the probe**

```python
# in skp-toolkit/skp/clients/http.py — replace _request's return and add get_text

    def _fetch(self, path: str, params: dict | None, data: bytes | None) -> bytes:
        url = self.base + path
        if params:
            url = f"{url}?{urllib.parse.urlencode(params)}"
        request = urllib.request.Request(url, data=data)
        if self.token:
            request.add_header("Authorization", f"Bearer {self.token}")
        if data is not None:
            request.add_header("Content-Type", "application/json")
        try:
            with self._open(request, timeout=self.timeout) as response:
                return response.read()
        except urllib.error.HTTPError as exc:
            raise Unreachable(self.base, f"HTTP {exc.code} for {path}") from exc
        except (urllib.error.URLError, OSError) as exc:
            raise Unreachable(self.base, str(getattr(exc, "reason", exc))) from exc

    def _request(self, path: str, params: dict | None, data: bytes | None):
        raw = self._fetch(path, params, data)
        return json.loads(raw) if raw else None

    def get_text(self, path: str, params: dict | None = None) -> str:
        return self._fetch(path, params, None).decode("utf-8", errors="replace")
```

```python
# in skp-toolkit/skp/clients/prom.py — the probe reads text, not JSON

    def ready(self) -> bool:
        try:
            self.http.get_text("/-/healthy")
            return True
        except Unreachable:
            return False
```

Add `get_text` to the `FakeHttp` stub in the test module so the other tests keep working:

```python
# in skp-toolkit/tests/test_stores_http.py, inside FakeHttp

    def get_text(self, path, params=None):
        self.gets.append((path, params))
        return "ok"
```

- [ ] **Step 8: Run the whole module to verify everything passes**

Run: `cd skp-toolkit && python -m unittest tests.test_stores_http tests.test_http -v`
Expected: PASS (13 tests)

- [ ] **Step 9: Commit**

```bash
git add skp-toolkit/skp/clients/ skp-toolkit/tests/test_stores_http.py skp-toolkit/tests/test_http.py
git commit -m "feat(skp): BaseAPI, Elasticsearch and Prometheus clients"
```

---

### Task 7: `skp init` — collect, write, probe

**Files:**
- Create: `skp-toolkit/skp/verbs/__init__.py`
- Create: `skp-toolkit/skp/verbs/init.py`
- Modify: `skp-toolkit/skp/cli.py` (register the group)
- Test: `skp-toolkit/tests/test_init.py`

**Interfaces:**
- Consumes: `Profile` (Task 2), all seven clients (Tasks 3–6), `Result` (Task 1).
- Produces: `build_clients(profile: Profile) -> dict[str, object]`; `probe(clients: dict) -> list[tuple[str, bool, str]]` returning `(name, ok, detail)` in a fixed order; `run(argv: list[str]) -> Result`; `DEFAULT_ENDPOINTS: dict[str, str]`.

Compilation is wired into `init` in Task 12, once the compiler exists. Until then `init` resolves, writes and probes.

- [ ] **Step 1: Write the failing test**

```python
# skp-toolkit/tests/test_init.py
import pathlib
import tempfile
import unittest

from skp.result import EXIT_OK, EXIT_UNREACHABLE
from skp.verbs.init import probe, render_table


class Probeable:
    def __init__(self, ok):
        self._ok = ok

    def ping(self):
        return self._ok

    ready = ping


class ProbeTests(unittest.TestCase):
    def clients(self, **overrides):
        base = {name: Probeable(True) for name in
                ("cluster", "postgres", "redis", "rabbitmq", "elasticsearch",
                 "prometheus", "baseapi")}
        base.update(overrides)
        return base

    def test_probe_reports_all_seven_targets_in_a_fixed_order(self):
        rows = probe(self.clients())
        self.assertEqual(
            [name for name, _, _ in rows],
            ["cluster", "postgres", "redis", "rabbitmq", "elasticsearch",
             "prometheus", "baseapi"],
        )
        self.assertTrue(all(ok for _, ok, _ in rows))

    def test_one_dead_target_is_a_named_red_row_not_a_crash(self):
        rows = probe(self.clients(elasticsearch=Probeable(False)))
        failed = [name for name, ok, _ in rows if not ok]
        self.assertEqual(failed, ["elasticsearch"])

    def test_the_table_marks_each_row_and_names_the_dead_one(self):
        table = render_table(probe(self.clients(redis=Probeable(False))))
        self.assertIn("redis", table)
        self.assertIn("UNREACHABLE", table)
        self.assertIn("ok", table)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd skp-toolkit && python -m unittest tests.test_init -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'skp.verbs'`

- [ ] **Step 3: Write minimal implementation**

```python
# skp-toolkit/skp/verbs/__init__.py
"""One module per command group. Each exposes ``run(argv) -> Result``."""
```

```python
# skp-toolkit/skp/verbs/init.py
import argparse
import pathlib

from skp.clients.api import BaseApi
from skp.clients.cluster import ClusterClient, detect_binary
from skp.clients.es import Elastic
from skp.clients.http import HttpClient, Unreachable
from skp.clients.pg import Postgres
from skp.clients.prom import Prometheus
from skp.clients.rabbit import Rabbit
from skp.clients.redis import Redis
from skp.profile import Profile, default_home
from skp.result import EXIT_OK, EXIT_UNREACHABLE, Result

PROBE_ORDER = ["cluster", "postgres", "redis", "rabbitmq",
               "elasticsearch", "prometheus", "baseapi"]

DEFAULT_ENDPOINTS = {
    "baseapi": "http://baseapi-service:8080",
    "prometheus": "http://prometheus:9090",
    "elasticsearch": "http://elasticsearch:9200",
}


class ClusterProbe:
    """Adapts ClusterClient to the ping() shape the probe table expects."""

    def __init__(self, cluster):
        self.cluster = cluster

    def ping(self) -> bool:
        try:
            self.cluster.run(["get", "pods", "-o", "name"])
            return True
        except Unreachable:
            return False


def build_clients(profile: Profile) -> dict:
    cluster = ClusterClient(profile.project, binary=detect_binary())
    token = profile.token
    endpoints = {**DEFAULT_ENDPOINTS, **profile.endpoints}
    return {
        "cluster": ClusterProbe(cluster),
        "postgres": Postgres(cluster),
        "redis": Redis(cluster),
        "rabbitmq": Rabbit(cluster),
        "elasticsearch": Elastic(HttpClient(endpoints["elasticsearch"])),
        "prometheus": Prometheus(HttpClient(endpoints["prometheus"])),
        "baseapi": BaseApi(HttpClient(endpoints["baseapi"], token=token)),
    }


def probe(clients: dict) -> list[tuple[str, bool, str]]:
    """Ask every target once, in a fixed order, and never raise.

    An unreachable store must surface here, as a named red row -- not three days
    later as an empty result some verb reports as 'nothing found'.
    """
    rows: list[tuple[str, bool, str]] = []
    for name in PROBE_ORDER:
        client = clients[name]
        check = getattr(client, "ping", None) or getattr(client, "ready")
        try:
            ok, detail = bool(check()), ""
        except Exception as exc:  # a probe reports; it does not propagate
            ok, detail = False, str(exc)
        rows.append((name, ok, detail))
    return rows


def render_table(rows: list[tuple[str, bool, str]]) -> str:
    width = max(len(name) for name, _, _ in rows)
    out = []
    for name, ok, detail in rows:
        status = "ok" if ok else "UNREACHABLE"
        line = f"  {name.ljust(width)}  {status}"
        out.append(f"{line}  {detail}".rstrip())
    return "\n".join(out)


def run(argv: list[str]) -> Result:
    parser = argparse.ArgumentParser(prog="skp init")
    parser.add_argument("--home", default=str(default_home()))
    parser.add_argument("--source-root", required=True)
    parser.add_argument("--cluster-url", required=True)
    parser.add_argument("--project", required=True)
    parser.add_argument("--token", default="")
    parser.add_argument("--endpoint", action="append", default=[],
                        metavar="NAME=URL", help="override a derived endpoint")
    parser.add_argument("--refresh", action="store_true")
    ns = parser.parse_args(argv)

    endpoints = dict(DEFAULT_ENDPOINTS)
    for pair in ns.endpoint:
        name, _, url = pair.partition("=")
        endpoints[name] = url

    profile = Profile(
        home=pathlib.Path(ns.home),
        source_root=ns.source_root,
        cluster_url=ns.cluster_url,
        project=ns.project,
        endpoints=endpoints,
    )
    profile.save(token=ns.token)

    rows = probe(build_clients(profile))
    lines = [f"memory folder: {profile.home}", "", render_table(rows)]
    dead = [name for name, ok, _ in rows if not ok]
    if dead:
        return Result(EXIT_UNREACHABLE,
                      [*lines, "", f"unreachable: {', '.join(dead)}"],
                      next_command="skp doctor")
    return Result(EXIT_OK, lines, next_command="skp map --intent observe")
```

```python
# in skp-toolkit/skp/cli.py — replace the empty GROUPS dict

from skp.verbs import init as init_verb

GROUPS = {"init": init_verb.run}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd skp-toolkit && python -m unittest tests.test_init -v`
Expected: PASS (3 tests)

- [ ] **Step 5: Run the whole suite**

Run: `cd skp-toolkit && python -m unittest discover -s tests -t . -v`
Expected: PASS, no failures, no errors

- [ ] **Step 6: Commit**

```bash
git add skp-toolkit/skp/verbs/ skp-toolkit/skp/cli.py skp-toolkit/tests/test_init.py
git commit -m "feat(skp): skp init writes the profile and probes seven targets"
```

---

### Task 8: The C# literal extractor

**Files:**
- Create: `skp-toolkit/skp/compile/__init__.py`
- Create: `skp-toolkit/skp/compile/csharp.py`
- Test: `skp-toolkit/tests/test_csharp.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `const_strings(text: str) -> dict[str, str]`; `expression_bodies(text: str) -> dict[str, str]`; `literals_matching(text: str, prefix: str) -> list[str]`; `unescape(raw: str) -> str`.

This is the load-bearing parser. `Templates.cs` contains multi-line `+`-concatenated constants with `—` escapes, and `L2ProjectionKeys.cs` contains interpolated expression bodies with format specifiers — both shapes must round-trip exactly, because every downstream extractor depends on them.

- [ ] **Step 1: Write the failing test**

```python
# skp-toolkit/tests/test_csharp.py
import unittest

from skp.compile.csharp import const_strings, expression_bodies, literals_matching, unescape

TEMPLATES = '''
internal static class Templates
{
    public const string EntryDispatched = "dispatched an entry step";
    public const string HandedOff =
        "handed off to {NextStepId} on {NextProcessorId} with {NextEntryId}";
    public const string TerminalCompleted =
        "the terminal step completed with {Result} \\u2014 no successor accepts it";
    public const string RefusingNotParked =
        "refusing message of type {Type} on {Queue} \\u2014 NOT parked: the channel was gone before "
        + "the broker was told, so it will be redelivered rather than dead-lettered";
}
'''

KEYS = '''
public static class L2ProjectionKeys
{
    public const string Prefix = "skp:";
    public static string ParentIndex() => Prefix;
    public static string Root(Guid workflowId) => $"{Prefix}{workflowId:D}";
    public static string PerInstance(Guid processorId, string instanceId)
        => $"{Prefix}proc:{processorId:D}:{instanceId}";
}
'''


class ConstStringTests(unittest.TestCase):
    def test_single_line_constant(self):
        self.assertEqual(
            const_strings(TEMPLATES)["EntryDispatched"], "dispatched an entry step")

    def test_constant_wrapped_onto_the_next_line(self):
        self.assertEqual(
            const_strings(TEMPLATES)["HandedOff"],
            "handed off to {NextStepId} on {NextProcessorId} with {NextEntryId}")

    def test_unicode_escapes_are_decoded_to_the_real_character(self):
        value = const_strings(TEMPLATES)["TerminalCompleted"]
        self.assertIn("—", value)
        self.assertNotIn("\\u2014", value)

    def test_concatenated_constant_is_joined_in_order(self):
        value = const_strings(TEMPLATES)["RefusingNotParked"]
        self.assertTrue(value.startswith("refusing message of type {Type}"))
        self.assertTrue(value.endswith("redelivered rather than dead-lettered"))
        self.assertIn("gone before the broker was told", value)

    def test_every_declared_constant_is_found(self):
        self.assertEqual(
            sorted(const_strings(TEMPLATES)),
            ["EntryDispatched", "HandedOff", "RefusingNotParked", "TerminalCompleted"])


class ExpressionBodyTests(unittest.TestCase):
    def test_interpolated_body_keeps_its_placeholders(self):
        self.assertEqual(expression_bodies(KEYS)["Root"], "{Prefix}{workflowId}")

    def test_format_specifiers_are_stripped(self):
        self.assertEqual(
            expression_bodies(KEYS)["PerInstance"], "{Prefix}proc:{processorId}:{instanceId}")

    def test_a_body_that_is_a_bare_identifier_is_not_a_literal(self):
        self.assertNotIn("ParentIndex", expression_bodies(KEYS))


class LiteralScanTests(unittest.TestCase):
    def test_prefix_scan_finds_instrument_names_and_dedupes(self):
        text = 'x("pipeline.queue.depth"); y("pipeline.queue.depth"); z("other.thing");'
        self.assertEqual(literals_matching(text, "pipeline."), ["pipeline.queue.depth"])


class UnescapeTests(unittest.TestCase):
    def test_escaped_quote_and_backslash(self):
        self.assertEqual(unescape('a \\"b\\" c'), 'a "b" c')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd skp-toolkit && python -m unittest tests.test_csharp -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'skp.compile'`

- [ ] **Step 3: Write minimal implementation**

```python
# skp-toolkit/skp/compile/__init__.py
"""Generation of the capability catalog from the C# sources.

Nothing in here is hand-maintained data. If a fact about the system can be read
from source, it is read from source -- a transcribed catalog is recall with extra
steps, and fails the same silent way when the code moves.
"""
```

```python
# skp-toolkit/skp/compile/csharp.py
import re

_CONST = re.compile(
    r"(?:public|internal|private)\s+const\s+string\s+(\w+)\s*=\s*(.*?);",
    re.DOTALL)
_EXPR = re.compile(
    r"public\s+static\s+string\s+(\w+)\s*\([^)]*\)\s*=>\s*(.*?);",
    re.DOTALL)
_LITERAL = re.compile(r'"((?:[^"\\]|\\.)*)"')
_SPECIFIER = re.compile(r"\{(\w+):[^}]*\}")


def unescape(raw: str) -> str:
    """Decode the escapes C# source uses, without touching anything else.

    ``codecs.decode(..., 'unicode_escape')`` would corrupt any non-ASCII byte
    already present, so the substitutions are explicit and ordered.
    """
    out = re.sub(r"\\u([0-9a-fA-F]{4})", lambda m: chr(int(m.group(1), 16)), raw)
    return out.replace('\\"', '"').replace("\\\\", "\\")


def _joined_literals(rhs: str) -> str:
    """Every string literal in a right-hand side, concatenated in source order.

    This is what handles ``"a " + "b"`` spanning lines without needing to parse
    the ``+`` operator at all.
    """
    return "".join(unescape(m.group(1)) for m in _LITERAL.finditer(rhs))


def const_strings(text: str) -> dict[str, str]:
    return {name: _joined_literals(rhs) for name, rhs in _CONST.findall(text)}


def expression_bodies(text: str) -> dict[str, str]:
    """Interpolated expression-bodied string methods, placeholders preserved.

    ``{workflowId:D}`` becomes ``{workflowId}``: the specifier is a rendering
    detail, and the key family is what the catalog records.
    """
    found: dict[str, str] = {}
    for name, rhs in _EXPR.findall(text):
        literal = _LITERAL.search(rhs)
        if not literal:
            continue  # a body returning a bare identifier is not a key format
        found[name] = _SPECIFIER.sub(r"{\1}", unescape(literal.group(1)))
    return found


def literals_matching(text: str, prefix: str) -> list[str]:
    """Every distinct string literal starting with ``prefix``, sorted.

    Used for instrument names, where the declaration shapes vary too much to be
    worth matching but the value's prefix is uniform.
    """
    seen = {m.group(1) for m in _LITERAL.finditer(text)
            if m.group(1).startswith(prefix)}
    return sorted(seen)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd skp-toolkit && python -m unittest tests.test_csharp -v`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add skp-toolkit/skp/compile/ skp-toolkit/tests/test_csharp.py
git commit -m "feat(skp): C# literal extractor for consts, expression bodies and scans"
```

---

### Task 9: Extractors — Redis keys, queues, log templates

**Files:**
- Create: `skp-toolkit/skp/compile/extract.py`
- Test: `skp-toolkit/tests/test_extract_runtime.py`

**Interfaces:**
- Consumes: `const_strings`, `expression_bodies`, `literals_matching` (Task 8).
- Produces: `Surface(component: str, id: str, operation: str, detail: str)` dataclass; `redis_keys(text: str) -> list[Surface]`; `queues(processor_text: str, orchestrator_text: str) -> list[Surface]`; `templates(text: str) -> list[Surface]`. Every `Surface.id` is `f"{component}.{name}"` and is the join key for annotations.

- [ ] **Step 1: Write the failing test**

```python
# skp-toolkit/tests/test_extract_runtime.py
import unittest

from skp.compile.extract import queues, redis_keys, templates

KEYS = '''
public static class L2ProjectionKeys
{
    public const string Prefix = "skp:";
    public static string Root(Guid workflowId) => $"{Prefix}{workflowId:D}";
    public static string Step(Guid workflowId, Guid stepId) => $"{Prefix}{workflowId:D}:{stepId:D}";
    public static string ExecutionData(Guid id) => $"{Prefix}data:{id:D}";
}
'''

PROCESSOR_QUEUES = '''
public static class ProcessorQueues
{
    public const string IdentityQuery = "processor-identity-query";
    public static string Work(Guid processorId) => $"processor-{processorId:D}";
    public const string DeadLetterExchange = "processor-dlx";
}
'''

ORCHESTRATOR_QUEUES = '''
public static class OrchestratorQueues
{
    public const string Control = "orchestrator-control";
    public const string Result = "orchestrator-result";
}
'''

TEMPLATES = '''
internal static class Templates
{
    public const string RunningTheStep = "running the step";
    public const string StepReturned = "the step returned after {ElapsedMs}ms";
}
'''


class RedisKeyTests(unittest.TestCase):
    def test_the_prefix_is_substituted_not_left_as_a_placeholder(self):
        by_id = {s.id: s for s in redis_keys(KEYS)}
        self.assertEqual(by_id["redis.Root"].detail, "skp:{workflowId}")
        self.assertEqual(by_id["redis.ExecutionData"].detail, "skp:data:{id}")

    def test_every_key_family_is_a_surface_on_the_redis_component(self):
        surfaces = redis_keys(KEYS)
        self.assertEqual(sorted(s.id for s in surfaces),
                         ["redis.ExecutionData", "redis.Root", "redis.Step"])
        self.assertTrue(all(s.component == "redis" for s in surfaces))


class QueueTests(unittest.TestCase):
    def test_constant_and_templated_queues_are_both_surfaces(self):
        by_id = {s.id: s for s in queues(PROCESSOR_QUEUES, ORCHESTRATOR_QUEUES)}
        self.assertEqual(by_id["rabbitmq.IdentityQuery"].detail, "processor-identity-query")
        self.assertEqual(by_id["rabbitmq.Work"].detail, "processor-{processorId}")
        self.assertEqual(by_id["rabbitmq.Control"].detail, "orchestrator-control")

    def test_both_source_files_contribute(self):
        ids = {s.id for s in queues(PROCESSOR_QUEUES, ORCHESTRATOR_QUEUES)}
        self.assertIn("rabbitmq.DeadLetterExchange", ids)
        self.assertIn("rabbitmq.Result", ids)


class TemplateTests(unittest.TestCase):
    def test_each_template_is_a_surface_carrying_its_text(self):
        by_id = {s.id: s for s in templates(TEMPLATES)}
        self.assertEqual(by_id["elasticsearch.StepReturned"].detail,
                         "the step returned after {ElapsedMs}ms")
        self.assertEqual(by_id["elasticsearch.StepReturned"].operation,
                         "search by attributes.{OriginalFormat}")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd skp-toolkit && python -m unittest tests.test_extract_runtime -v`
Expected: FAIL with `ImportError: cannot import name 'queues' from 'skp.compile.extract'`

- [ ] **Step 3: Write minimal implementation**

```python
# skp-toolkit/skp/compile/extract.py
from dataclasses import dataclass

from skp.compile.csharp import const_strings, expression_bodies, literals_matching


@dataclass(frozen=True)
class Surface:
    """One thing the system exposes, as read from source.

    ``id`` is the join key: an annotation file supplies this id's intents and
    prose, and an id with no annotation fails the build.
    """

    component: str
    id: str
    operation: str
    detail: str


def _surface(component: str, name: str, operation: str, detail: str) -> Surface:
    return Surface(component, f"{component}.{name}", operation, detail)


def redis_keys(text: str) -> list[Surface]:
    prefix = const_strings(text).get("Prefix", "")
    out = []
    for name, body in expression_bodies(text).items():
        out.append(_surface("redis", name, "read key", body.replace("{Prefix}", prefix)))
    return sorted(out, key=lambda s: s.id)


def queues(processor_text: str, orchestrator_text: str) -> list[Surface]:
    out = []
    for text in (processor_text, orchestrator_text):
        for name, value in const_strings(text).items():
            out.append(_surface("rabbitmq", name, "list_queues", value))
        for name, body in expression_bodies(text).items():
            out.append(_surface("rabbitmq", name, "list_queues", body))
    return sorted(out, key=lambda s: s.id)


def templates(text: str) -> list[Surface]:
    return sorted(
        (_surface("elasticsearch", name, "search by attributes.{OriginalFormat}", value)
         for name, value in const_strings(text).items()),
        key=lambda s: s.id)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd skp-toolkit && python -m unittest tests.test_extract_runtime -v`
Expected: PASS (6 tests)

- [ ] **Step 5: Verify against the real sources, not just fixtures**

```python
# skp-toolkit/tests/test_extract_real_sources.py
import pathlib
import unittest

from skp.compile.extract import queues, redis_keys, templates

SRC = pathlib.Path(__file__).resolve().parents[2] / "src"


def read(rel: str) -> str:
    return (SRC / rel).read_text(encoding="utf-8")


@unittest.skipUnless(SRC.exists(), "run from inside the repo")
class RealSourceTests(unittest.TestCase):
    def test_the_six_documented_key_families_are_all_found(self):
        found = {s.id for s in redis_keys(
            read("Messaging.Contracts/Projections/L2ProjectionKeys.cs"))}
        self.assertEqual(found, {
            "redis.ParentIndex", "redis.Root", "redis.Step",
            "redis.PerInstance", "redis.InstanceIndex", "redis.ExecutionData",
        })

    def test_the_execution_blob_key_carries_the_documented_shape(self):
        by_id = {s.id: s for s in redis_keys(
            read("Messaging.Contracts/Projections/L2ProjectionKeys.cs"))}
        self.assertTrue(by_id["redis.ExecutionData"].detail.startswith("skp:data:"))

    def test_the_three_orchestrator_queues_are_found(self):
        found = {s.detail for s in queues(
            read("Messaging.Contracts/ProcessorQueues.cs"),
            read("Messaging.Contracts/OrchestratorQueues.cs"))}
        for name in ("orchestrator-control", "orchestrator-result",
                     "orchestrator-result-post", "processor-identity-query"):
            self.assertIn(name, found)

    def test_the_ten_ledger_templates_are_found(self):
        found = {s.detail for s in templates(
            read("tests/BaseApi.Tests/Live/Resilience/Templates.cs"))}
        for text in ("running the step", "the step returned after {ElapsedMs}ms",
                     "dispatched an entry step",
                     "the entry step completed with {Result}"):
            self.assertIn(text, found)
```

- [ ] **Step 6: Run it against the real files**

Run: `cd skp-toolkit && python -m unittest tests.test_extract_real_sources -v`
Expected: PASS (4 tests). A failure here means the extractor's shape assumptions are wrong — fix the extractor, never the assertion.

- [ ] **Step 7: Commit**

```bash
git add skp-toolkit/skp/compile/extract.py skp-toolkit/tests/test_extract_runtime.py skp-toolkit/tests/test_extract_real_sources.py
git commit -m "feat(skp): extract Redis key families, queues and log templates"
```

---

### Task 10: Extractors — metrics, REST endpoints, Postgres tables

**Files:**
- Modify: `skp-toolkit/skp/compile/extract.py`
- Test: `skp-toolkit/tests/test_extract_surfaces.py`

**Interfaces:**
- Consumes: `Surface`, `_surface`, `literals_matching`, `const_strings` (Tasks 8–9).
- Produces: `metrics(texts: list[str]) -> list[Surface]`; `rest_endpoints(controller_texts: dict[str, str]) -> list[Surface]`; `pg_tables(dbcontext_text: str) -> list[Surface]`.

`rest_endpoints` takes `{filename: text}` because the controller *class name* determines the route token: `WorkflowsController` serves `/api/v1.0/workflows`.

- [ ] **Step 1: Write the failing test**

```python
# skp-toolkit/tests/test_extract_surfaces.py
import unittest

from skp.compile.extract import metrics, pg_tables, rest_endpoints

METRICS_A = 'internal const string DepthInstrument = "pipeline.queue.depth";'
METRICS_B = 'Meter.CreateCounter<long>(\n  "pipeline.messages.consumed", "{message}");'

WORKFLOW_CONTROLLER = '''
public sealed class WorkflowsController :
    BaseController<WorkflowEntity, WorkflowCreateDto, WorkflowUpdateDto, WorkflowReadDto>
{
}
'''

PROCESSOR_CONTROLLER = '''
public sealed class ProcessorsController :
    BaseController<ProcessorEntity, ProcessorCreateDto, ProcessorUpdateDto, ProcessorReadDto>
{
    [HttpGet("by-source-hash/{sourceHash}")]
    public async Task<ActionResult<ProcessorReadDto>> GetBySourceHash(string sourceHash) => null;
}
'''

ORCHESTRATION_CONTROLLER = '''
public sealed class OrchestrationController : ControllerBase
{
    [HttpPost("start")]
    public async Task<IActionResult> Start() => null;

    [HttpPost("stop")]
    public async Task<IActionResult> Stop() => null;
}
'''

DBCONTEXT = '''
    public DbSet<SchemaEntity> Schemas => Set<SchemaEntity>();
    public DbSet<StepNextSteps> StepNextSteps => Set<StepNextSteps>();
'''


class MetricTests(unittest.TestCase):
    def test_instruments_are_found_across_files_and_declaration_shapes(self):
        found = {s.detail for s in metrics([METRICS_A, METRICS_B])}
        self.assertEqual(found, {"pipeline.queue.depth", "pipeline.messages.consumed"})

    def test_the_id_is_derived_from_the_instrument_name(self):
        by_detail = {s.detail: s for s in metrics([METRICS_A])}
        self.assertEqual(by_detail["pipeline.queue.depth"].id,
                         "prometheus.pipeline_queue_depth")

    def test_non_pipeline_literals_are_ignored(self):
        self.assertEqual(metrics(['x("http.server.duration");']), [])


class RestTests(unittest.TestCase):
    def test_an_entity_controller_yields_the_five_inherited_verbs(self):
        surfaces = rest_endpoints({"WorkflowController.cs": WORKFLOW_CONTROLLER})
        self.assertEqual(
            sorted(s.operation for s in surfaces),
            ["DELETE /api/v1.0/workflows/{id}",
             "GET /api/v1.0/workflows",
             "GET /api/v1.0/workflows/{id}",
             "POST /api/v1.0/workflows",
             "PUT /api/v1.0/workflows/{id}"])

    def test_a_declared_route_is_added_to_the_inherited_five(self):
        operations = {s.operation for s in
                      rest_endpoints({"ProcessorController.cs": PROCESSOR_CONTROLLER})}
        self.assertIn("GET /api/v1.0/processors/by-source-hash/{sourceHash}", operations)
        self.assertEqual(len(operations), 6)

    def test_a_plain_controller_yields_only_its_declared_routes(self):
        operations = {s.operation for s in
                      rest_endpoints({"OrchestrationController.cs": ORCHESTRATION_CONTROLLER})}
        self.assertEqual(operations, {"POST /api/v1.0/orchestration/start",
                                      "POST /api/v1.0/orchestration/stop"})


class PgTests(unittest.TestCase):
    def test_entity_and_junction_tables_are_both_surfaces(self):
        by_id = {s.id: s for s in pg_tables(DBCONTEXT)}
        self.assertEqual(sorted(by_id), ["postgres.Schemas", "postgres.StepNextSteps"])
        self.assertEqual(by_id["postgres.Schemas"].operation, 'SELECT ... FROM "Schemas"')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd skp-toolkit && python -m unittest tests.test_extract_surfaces -v`
Expected: FAIL with `ImportError: cannot import name 'metrics' from 'skp.compile.extract'`

- [ ] **Step 3: Write minimal implementation**

```python
# append to skp-toolkit/skp/compile/extract.py
import re

_DBSET = re.compile(r"DbSet<\w+>\s+(\w+)\s*=>")
_CONTROLLER_CLASS = re.compile(r"class\s+(\w+)Controller\b")
_INHERITS_BASE = re.compile(r"BaseController<")
_HTTP_ATTR = re.compile(r'\[Http(Get|Post|Put|Delete)(?:\("([^"]*)"\))?\]')

API_PREFIX = "/api/v1.0"

INHERITED_VERBS = [
    ("GET", ""),
    ("GET", "{id}"),
    ("POST", ""),
    ("PUT", "{id}"),
    ("DELETE", "{id}"),
]


def metrics(texts: list[str]) -> list[Surface]:
    """Every ``pipeline.*`` instrument, across every declaration shape.

    Matching the declaration syntax would mean tracking four Meter.Create* forms
    plus the ``const string ...Instrument`` convention. The value's prefix is
    uniform where the syntax is not, so the scan is on the value.
    """
    names: set[str] = set()
    for text in texts:
        names.update(literals_matching(text, "pipeline."))
    return sorted(
        (Surface("prometheus", f"prometheus.{name.replace('.', '_')}",
                 f"instant query on {name}", name) for name in names),
        key=lambda s: s.id)


def _route_token(class_name: str) -> str:
    """``WorkflowsController`` -> ``workflows``. The [controller] token convention."""
    return class_name.lower()


def rest_endpoints(controller_texts: dict[str, str]) -> list[Surface]:
    out: list[Surface] = []
    for text in controller_texts.values():
        match = _CONTROLLER_CLASS.search(text)
        if not match:
            continue
        token = _route_token(match.group(1))
        base = f"{API_PREFIX}/{token}"

        if _INHERITS_BASE.search(text):
            for verb, tail in INHERITED_VERBS:
                path = f"{base}/{tail}" if tail else base
                out.append(Surface("api", f"api.{token}.{verb.lower()}{'_id' if tail else ''}",
                                   f"{verb} {path}", token))

        for verb, tail in _HTTP_ATTR.findall(text):
            if not tail:
                continue  # an undecorated attribute on a BaseController subclass is inherited
            path = f"{base}/{tail}"
            slug = re.sub(r"[^a-z0-9]+", "_", tail.lower()).strip("_")
            out.append(Surface("api", f"api.{token}.{verb.lower()}_{slug}",
                               f"{verb.upper()} {path}", token))
    return sorted(out, key=lambda s: s.id)


def pg_tables(dbcontext_text: str) -> list[Surface]:
    return sorted(
        (_surface("postgres", name, f'SELECT ... FROM "{name}"', name)
         for name in _DBSET.findall(dbcontext_text)),
        key=lambda s: s.id)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd skp-toolkit && python -m unittest tests.test_extract_surfaces -v`
Expected: PASS (7 tests)

- [ ] **Step 5: Verify against the real sources**

```python
# append to skp-toolkit/tests/test_extract_real_sources.py
from skp.compile.extract import metrics, pg_tables, rest_endpoints


@unittest.skipUnless(SRC.exists(), "run from inside the repo")
class RealSurfaceTests(unittest.TestCase):
    def test_the_five_entity_tables_and_three_junctions_are_found(self):
        found = {s.id for s in pg_tables(read("BaseApi.Service/AppDbContext.cs"))}
        self.assertEqual(found, {
            "postgres.Schemas", "postgres.Processors", "postgres.Steps",
            "postgres.Assignments", "postgres.Workflows",
            "postgres.StepNextSteps", "postgres.WorkflowEntrySteps",
            "postgres.WorkflowAssignments",
        })

    def test_documented_instruments_are_all_present(self):
        texts = [p.read_text(encoding="utf-8") for p in SRC.rglob("*Metrics.cs")
                 if "obj" not in p.parts and "bin" not in p.parts]
        found = {s.detail for s in metrics(texts)}
        for name in ("pipeline.queue.depth", "pipeline.deadletter.depth",
                     "pipeline.messages.produced", "pipeline.gate.open"):
            self.assertIn(name, found)

    def test_the_five_entity_controllers_and_orchestration_are_routed(self):
        texts = {p.name: p.read_text(encoding="utf-8")
                 for p in (SRC / "BaseApi.Service" / "Features").rglob("*Controller.cs")}
        operations = {s.operation for s in rest_endpoints(texts)}
        self.assertIn("GET /api/v1.0/workflows", operations)
        self.assertIn("POST /api/v1.0/orchestration/start", operations)
        self.assertIn("GET /api/v1.0/processors/by-source-hash/{sourceHash}", operations)
```

- [ ] **Step 6: Run it**

Run: `cd skp-toolkit && python -m unittest tests.test_extract_real_sources -v`
Expected: PASS (7 tests)

- [ ] **Step 7: Commit**

```bash
git add skp-toolkit/skp/compile/extract.py skp-toolkit/tests/test_extract_surfaces.py skp-toolkit/tests/test_extract_real_sources.py
git commit -m "feat(skp): extract metrics, REST routes and Postgres tables"
```

---

### Task 11: Catalog assembly, annotations, and the coverage checks

**Files:**
- Create: `skp-toolkit/skp/compile/catalog.py`
- Create: `skp-toolkit/skp/annotations/README.md`
- Create: `skp-toolkit/skp/annotations/redis.json`
- Test: `skp-toolkit/tests/test_catalog.py`

**Interfaces:**
- Consumes: `Surface` (Task 9).
- Produces: `INTENTS: tuple[str, ...]`; `Entry` dataclass with fields `id, component, operation, detail, intents, answers, never_for, write_authority, cost, verb`; `load_annotations(dir: Path) -> dict[str, dict]`; `build(surfaces: list[Surface], annotations: dict) -> list[Entry]`; `check(entries, surfaces, annotations) -> list[str]` returning failure messages; `CatalogError(Exception)`.

An unannotated surface is a build failure — that is what makes coverage provable rather than believed. An intent with no entries is also a failure, because it means the shipped bundle claims a category it cannot serve.

- [ ] **Step 1: Write the failing test**

```python
# skp-toolkit/tests/test_catalog.py
import json
import pathlib
import tempfile
import unittest

from skp.compile.catalog import INTENTS, build, check, load_annotations
from skp.compile.extract import Surface

SURFACES = [
    Surface("redis", "redis.Root", "read key", "skp:{workflowId}"),
    Surface("redis", "redis.ExecutionData", "read key", "skp:data:{id}"),
]

ANNOTATIONS = {
    "redis.Root": {
        "intents": ["observe", "investigate"],
        "answers": "whether a workflow is projected right now",
        "never_for": "the workflow's definition — that is Postgres",
        "write_authority": "none",
        "cost": "cheap",
        "verb": "skp observe projected",
    },
    "redis.ExecutionData": {
        "intents": ["investigate", "remediate"],
        "answers": "whether a step's output blob landed",
        "never_for": "counting throughput — no TTL means old keys linger",
        "write_authority": "gated",
        "cost": "cheap",
        "verb": "skp investigate blob",
    },
}


class BuildTests(unittest.TestCase):
    def test_an_entry_merges_the_surface_with_its_annotation(self):
        entry = {e.id: e for e in build(SURFACES, ANNOTATIONS)}["redis.Root"]
        self.assertEqual(entry.detail, "skp:{workflowId}")
        self.assertEqual(entry.intents, ["observe", "investigate"])
        self.assertEqual(entry.verb, "skp observe projected")

    def test_entries_come_back_sorted_by_id(self):
        self.assertEqual([e.id for e in build(SURFACES, ANNOTATIONS)],
                         ["redis.ExecutionData", "redis.Root"])


class CheckTests(unittest.TestCase):
    def all_intents(self):
        annotations = {k: dict(v) for k, v in ANNOTATIONS.items()}
        annotations["redis.Root"]["intents"] = list(INTENTS)
        return annotations

    def test_a_fully_annotated_catalog_with_every_intent_covered_passes(self):
        annotations = self.all_intents()
        entries = build(SURFACES, annotations)
        self.assertEqual(check(entries, SURFACES, annotations), [])

    def test_an_unannotated_surface_is_a_failure_naming_the_id(self):
        annotations = self.all_intents()
        del annotations["redis.ExecutionData"]
        problems = check(build(SURFACES, annotations), SURFACES, annotations)
        self.assertTrue(any("redis.ExecutionData" in p for p in problems))

    def test_an_entry_with_no_intents_is_a_failure(self):
        annotations = self.all_intents()
        annotations["redis.ExecutionData"]["intents"] = []
        problems = check(build(SURFACES, annotations), SURFACES, annotations)
        self.assertTrue(any("no intent" in p for p in problems))

    def test_an_unknown_intent_is_a_failure(self):
        annotations = self.all_intents()
        annotations["redis.ExecutionData"]["intents"] = ["diagnose"]
        problems = check(build(SURFACES, annotations), SURFACES, annotations)
        self.assertTrue(any("diagnose" in p for p in problems))

    def test_an_intent_with_no_coverage_is_reported_as_a_product_gap(self):
        problems = check(build(SURFACES, ANNOTATIONS), SURFACES, ANNOTATIONS)
        self.assertTrue(any("no capability serves intent 'design'" in p for p in problems))


class LoadTests(unittest.TestCase):
    def test_annotation_files_merge_across_the_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            (root / "redis.json").write_text(json.dumps({"redis.Root": ANNOTATIONS["redis.Root"]}),
                                             encoding="utf-8")
            (root / "extra.json").write_text(
                json.dumps({"redis.ExecutionData": ANNOTATIONS["redis.ExecutionData"]}),
                encoding="utf-8")
            self.assertEqual(sorted(load_annotations(root)),
                             ["redis.ExecutionData", "redis.Root"])
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd skp-toolkit && python -m unittest tests.test_catalog -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'skp.compile.catalog'`

- [ ] **Step 3: Write minimal implementation**

```python
# skp-toolkit/skp/compile/catalog.py
import json
import pathlib
from dataclasses import dataclass, field

INTENTS = ("design", "control", "observe", "analyze",
           "investigate", "verify", "remediate")
"""Closed, and closed is load-bearing: an open vocabulary lets a model invent a
category, find nothing, and improvise."""


class CatalogError(Exception):
    """The catalog does not describe the system. Never recoverable at runtime."""


@dataclass
class Entry:
    id: str
    component: str
    operation: str
    detail: str
    intents: list[str] = field(default_factory=list)
    answers: str = ""
    never_for: str = ""
    write_authority: str = "none"
    cost: str = "cheap"
    verb: str = ""

    def to_dict(self) -> dict:
        return {
            "id": self.id, "component": self.component, "operation": self.operation,
            "detail": self.detail, "intents": self.intents, "answers": self.answers,
            "never_for": self.never_for, "write_authority": self.write_authority,
            "cost": self.cost, "verb": self.verb,
        }


def load_annotations(directory: pathlib.Path) -> dict[str, dict]:
    merged: dict[str, dict] = {}
    for path in sorted(directory.glob("*.json")):
        merged.update(json.loads(path.read_text(encoding="utf-8")))
    return merged


def build(surfaces, annotations: dict[str, dict]) -> list[Entry]:
    entries = []
    for surface in surfaces:
        note = annotations.get(surface.id, {})
        entries.append(Entry(
            id=surface.id,
            component=surface.component,
            operation=surface.operation,
            detail=surface.detail,
            intents=list(note.get("intents", [])),
            answers=note.get("answers", ""),
            never_for=note.get("never_for", ""),
            write_authority=note.get("write_authority", "none"),
            cost=note.get("cost", "cheap"),
            verb=note.get("verb", ""),
        ))
    return sorted(entries, key=lambda e: e.id)


def check(entries: list[Entry], surfaces, annotations: dict[str, dict]) -> list[str]:
    """Every problem, not just the first: a build that fails four ways should say so."""
    problems: list[str] = []

    for surface in surfaces:
        if surface.id not in annotations:
            problems.append(
                f"{surface.id}: discovered in source but has no annotation "
                f"(add it to skp/annotations/)")

    for entry in entries:
        if not entry.intents:
            problems.append(f"{entry.id}: no intent — every capability must be categorised")
        for intent in entry.intents:
            if intent not in INTENTS:
                problems.append(
                    f"{entry.id}: unknown intent {intent!r} — the taxonomy is closed: "
                    f"{', '.join(INTENTS)}")

    covered = {i for entry in entries for i in entry.intents}
    for intent in INTENTS:
        if intent not in covered:
            problems.append(
                f"no capability serves intent {intent!r} — that is a gap in the "
                f"shipped system, not in this file")

    return problems
```

```python
# skp-toolkit/skp/annotations/redis.json
```
```json
{
  "redis.ParentIndex": {
    "intents": ["observe"],
    "answers": "which workflows are projected at all",
    "never_for": "the set of workflows that exist — that is Postgres",
    "write_authority": "none",
    "cost": "cheap",
    "verb": "skp observe projected"
  },
  "redis.Root": {
    "intents": ["observe", "investigate", "verify"],
    "answers": "whether one workflow is projected right now",
    "never_for": "the workflow's definition — L2 is a projection and legitimately lags a PUT until the next start",
    "write_authority": "none",
    "cost": "cheap",
    "verb": "skp observe projected"
  },
  "redis.Step": {
    "intents": ["observe", "investigate"],
    "answers": "the projected shape of one step inside a running workflow",
    "never_for": "the step's edges — those live in the StepNextSteps junction",
    "write_authority": "none",
    "cost": "cheap",
    "verb": "skp observe projected"
  },
  "redis.PerInstance": {
    "intents": ["observe", "investigate", "verify"],
    "answers": "one replica's liveness, with its status and interval",
    "never_for": "deciding a replica is gone — stale at 2x the interval but present until 4x, so absent and unhealthy are different answers",
    "write_authority": "none",
    "cost": "cheap",
    "verb": "skp observe liveness"
  },
  "redis.InstanceIndex": {
    "intents": ["observe", "analyze"],
    "answers": "how many replicas of a processor have ever registered",
    "never_for": "a live replica count — membership outlives a dead replica's entry key",
    "write_authority": "none",
    "cost": "cheap",
    "verb": "skp observe liveness"
  },
  "redis.ExecutionData": {
    "intents": ["investigate", "remediate"],
    "answers": "whether a step's output blob landed under its entry id",
    "never_for": "throughput — these keys carry no TTL, so a lingering blob is a leak to report, not garbage awaiting collection",
    "write_authority": "gated",
    "cost": "cheap",
    "verb": "skp investigate blob"
  }
}
```

```markdown
<!-- skp-toolkit/skp/annotations/README.md -->
# Annotations

The hand-written half of the catalog, and the only hand-written half.

Everything else is read from `src/`. These files supply what no extractor can
produce: which intents a capability serves, what it authoritatively answers,
and — most valuable — **what it must never be used for**.

One JSON file per component, keyed by the surface id the extractor emits
(`redis.Root`, `api.workflows.get`, `prometheus.pipeline_queue_depth`).

A surface with no entry here **fails the build**. That is deliberate: it is what
makes catalog coverage provable rather than believed. When `compile.py` reports
an unannotated id, add it here — do not silence the check.

Do not edit generated files to work around a missing annotation. Generated files
are overwritten on the next `skp init --refresh`, and `skp doctor` reports the
edit.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd skp-toolkit && python -m unittest tests.test_catalog -v`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add skp-toolkit/skp/compile/catalog.py skp-toolkit/skp/annotations/ skp-toolkit/tests/test_catalog.py
git commit -m "feat(skp): catalog assembly with coverage and intent checks"
```

---

### Task 12: `compile.lock` — source drift and hand-edit detection

**Files:**
- Create: `skp-toolkit/skp/compile/lock.py`
- Test: `skp-toolkit/tests/test_lock.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `hash_file(path: Path) -> str`; `build_lock(sources: list[Path], generated: list[Path], root: Path) -> dict`; `stale_sources(lock: dict, root: Path) -> list[str]`; `edited_generated(lock: dict, root: Path) -> list[str]`.

Two different failures, deliberately separated: a **stale source** means the C# moved and nobody recompiled; an **edited generated file** means someone fixed a skill by hand and is about to lose that fix.

- [ ] **Step 1: Write the failing test**

```python
# skp-toolkit/tests/test_lock.py
import pathlib
import tempfile
import unittest

from skp.compile.lock import build_lock, edited_generated, stale_sources


class LockTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        self.source = self.root / "Queues.cs"
        self.generated = self.root / "catalog.json"
        self.source.write_text("original", encoding="utf-8")
        self.generated.write_text("generated", encoding="utf-8")
        self.lock = build_lock([self.source], [self.generated], self.root)

    def tearDown(self):
        self.tmp.cleanup()

    def test_a_fresh_lock_reports_nothing(self):
        self.assertEqual(stale_sources(self.lock, self.root), [])
        self.assertEqual(edited_generated(self.lock, self.root), [])

    def test_a_changed_source_is_drift(self):
        self.source.write_text("edited", encoding="utf-8")
        self.assertEqual(stale_sources(self.lock, self.root), ["Queues.cs"])
        self.assertEqual(edited_generated(self.lock, self.root), [])

    def test_a_changed_generated_file_is_a_hand_edit_not_drift(self):
        self.generated.write_text("someone fixed this by hand", encoding="utf-8")
        self.assertEqual(edited_generated(self.lock, self.root), ["catalog.json"])
        self.assertEqual(stale_sources(self.lock, self.root), [])

    def test_a_deleted_source_is_drift(self):
        self.source.unlink()
        self.assertEqual(stale_sources(self.lock, self.root), ["Queues.cs"])

    def test_paths_are_recorded_relative_to_the_root(self):
        self.assertEqual(sorted(self.lock["sources"]), ["Queues.cs"])
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd skp-toolkit && python -m unittest tests.test_lock -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'skp.compile.lock'`

- [ ] **Step 3: Write minimal implementation**

```python
# skp-toolkit/skp/compile/lock.py
import hashlib
import pathlib

MISSING = "<missing>"


def hash_file(path: pathlib.Path) -> str:
    """Newline-normalised, so a checkout on Windows and one on Linux agree.

    The same reason SourceHash.targets normalises: a hash that disagrees across
    platforms turns a correct bundle into a permanent drift warning.
    """
    if not path.exists():
        return MISSING
    raw = path.read_bytes().replace(b"\r\n", b"\n")
    return hashlib.sha256(raw).hexdigest()


def _relative(path: pathlib.Path, root: pathlib.Path) -> str:
    return path.relative_to(root).as_posix()


def build_lock(sources, generated, root: pathlib.Path) -> dict:
    return {
        "sources": {_relative(p, root): hash_file(p) for p in sources},
        "generated": {_relative(p, root): hash_file(p) for p in generated},
    }


def _changed(section: dict, root: pathlib.Path) -> list[str]:
    return sorted(rel for rel, digest in section.items()
                  if hash_file(root / rel) != digest)


def stale_sources(lock: dict, root: pathlib.Path) -> list[str]:
    """The C# moved and nobody recompiled. Fix: skp init --refresh."""
    return _changed(lock.get("sources", {}), root)


def edited_generated(lock: dict, root: pathlib.Path) -> list[str]:
    """Someone edited a generated file. Fix: edit its input instead.

    Reported rather than reverted -- silently overwriting the edit is the failure
    this check exists to prevent.
    """
    return _changed(lock.get("generated", {}), root)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd skp-toolkit && python -m unittest tests.test_lock -v`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add skp-toolkit/skp/compile/lock.py skp-toolkit/tests/test_lock.py
git commit -m "feat(skp): compile.lock separates source drift from hand-edits"
```

---

### Task 13: The compiler driver, wired into `skp init`

**Files:**
- Create: `skp-toolkit/skp/compile/driver.py`
- Modify: `skp-toolkit/skp/verbs/init.py` (call the compiler after saving the profile)
- Test: `skp-toolkit/tests/test_driver.py`

**Interfaces:**
- Consumes: every extractor (Tasks 9–10), `build`/`check`/`load_annotations` (Task 11), `build_lock` (Task 12).
- Produces: `SOURCE_MAP: dict[str, str]` (logical name → path relative to the source root); `collect_surfaces(source_root: Path) -> list[Surface]`; `compile_catalog(source_root: Path, annotations_dir: Path, out_dir: Path) -> tuple[list[Entry], list[str]]` writing `catalog.json` and `compile.lock`.

- [ ] **Step 1: Write the failing test**

```python
# skp-toolkit/tests/test_driver.py
import json
import pathlib
import tempfile
import unittest

from skp.compile.driver import collect_surfaces, compile_catalog

L2 = '''
public static class L2ProjectionKeys
{
    public const string Prefix = "skp:";
    public static string Root(Guid workflowId) => $"{Prefix}{workflowId:D}";
}
'''
PQ = 'public static class ProcessorQueues { public const string IdentityQuery = "processor-identity-query"; }'
OQ = 'public static class OrchestratorQueues { public const string Control = "orchestrator-control"; }'
TPL = 'internal static class Templates { public const string RunningTheStep = "running the step"; }'
DBC = 'public DbSet<SchemaEntity> Schemas => Set<SchemaEntity>();'
MET = 'internal const string DepthInstrument = "pipeline.queue.depth";'
CTL = '''
public sealed class WorkflowsController :
    BaseController<WorkflowEntity, WorkflowCreateDto, WorkflowUpdateDto, WorkflowReadDto> { }
'''


def fake_source_root(root: pathlib.Path) -> pathlib.Path:
    src = root / "src"
    files = {
        "Messaging.Contracts/Projections/L2ProjectionKeys.cs": L2,
        "Messaging.Contracts/ProcessorQueues.cs": PQ,
        "Messaging.Contracts/OrchestratorQueues.cs": OQ,
        "tests/BaseApi.Tests/Live/Resilience/Templates.cs": TPL,
        "BaseApi.Service/AppDbContext.cs": DBC,
        "Messaging.Transport/QueueDepthMetrics.cs": MET,
        "BaseApi.Service/Features/Workflow/WorkflowController.cs": CTL,
    }
    for rel, text in files.items():
        path = src / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    return src


class CollectTests(unittest.TestCase):
    def test_surfaces_are_collected_from_every_component(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = fake_source_root(pathlib.Path(tmp))
            components = {s.component for s in collect_surfaces(src)}
            self.assertEqual(components,
                             {"redis", "rabbitmq", "elasticsearch",
                              "postgres", "prometheus", "api"})


class CompileTests(unittest.TestCase):
    def test_missing_annotations_are_reported_and_named(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            src = fake_source_root(root)
            notes = root / "annotations"
            notes.mkdir()
            (notes / "empty.json").write_text("{}", encoding="utf-8")
            out = root / "model"
            _, problems = compile_catalog(src, notes, out)
            self.assertTrue(any("redis.Root" in p for p in problems))

    def test_the_catalog_and_lock_are_written_even_when_checks_fail(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            src = fake_source_root(root)
            notes = root / "annotations"
            notes.mkdir()
            (notes / "empty.json").write_text("{}", encoding="utf-8")
            out = root / "model"
            compile_catalog(src, notes, out)
            catalog = json.loads((out / "catalog.json").read_text(encoding="utf-8"))
            self.assertTrue(any(e["id"] == "redis.Root" for e in catalog))
            self.assertIn("sources", json.loads(
                (out / "compile.lock").read_text(encoding="utf-8")))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd skp-toolkit && python -m unittest tests.test_driver -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'skp.compile.driver'`

- [ ] **Step 3: Write minimal implementation**

```python
# skp-toolkit/skp/compile/driver.py
import json
import pathlib

from skp.compile import extract
from skp.compile.catalog import Entry, build, check, load_annotations
from skp.compile.lock import build_lock

SOURCE_MAP = {
    "l2_keys": "Messaging.Contracts/Projections/L2ProjectionKeys.cs",
    "processor_queues": "Messaging.Contracts/ProcessorQueues.cs",
    "orchestrator_queues": "Messaging.Contracts/OrchestratorQueues.cs",
    "templates": "tests/BaseApi.Tests/Live/Resilience/Templates.cs",
    "dbcontext": "BaseApi.Service/AppDbContext.cs",
}

CONTROLLER_GLOB = "BaseApi.Service/Features/**/*Controller.cs"
METRICS_GLOB = "**/*Metrics.cs"


def _read(root: pathlib.Path, rel: str) -> str:
    path = root / rel
    return path.read_text(encoding="utf-8") if path.exists() else ""


def _source_paths(source_root: pathlib.Path) -> list[pathlib.Path]:
    paths = [source_root / rel for rel in SOURCE_MAP.values()]
    paths += sorted(source_root.glob(CONTROLLER_GLOB))
    paths += [p for p in sorted(source_root.glob(METRICS_GLOB))
              if "obj" not in p.parts and "bin" not in p.parts]
    return [p for p in paths if p.exists()]


def collect_surfaces(source_root: pathlib.Path) -> list[extract.Surface]:
    surfaces: list[extract.Surface] = []
    surfaces += extract.redis_keys(_read(source_root, SOURCE_MAP["l2_keys"]))
    surfaces += extract.queues(_read(source_root, SOURCE_MAP["processor_queues"]),
                               _read(source_root, SOURCE_MAP["orchestrator_queues"]))
    surfaces += extract.templates(_read(source_root, SOURCE_MAP["templates"]))
    surfaces += extract.pg_tables(_read(source_root, SOURCE_MAP["dbcontext"]))
    surfaces += extract.metrics([
        p.read_text(encoding="utf-8") for p in sorted(source_root.glob(METRICS_GLOB))
        if "obj" not in p.parts and "bin" not in p.parts])
    surfaces += extract.rest_endpoints({
        p.name: p.read_text(encoding="utf-8")
        for p in sorted(source_root.glob(CONTROLLER_GLOB))})
    return sorted(surfaces, key=lambda s: s.id)


def compile_catalog(source_root: pathlib.Path, annotations_dir: pathlib.Path,
                    out_dir: pathlib.Path) -> tuple[list[Entry], list[str]]:
    """Write the catalog and the lock, and return every problem found.

    The catalog is written even when checks fail: a partial catalog plus a named
    list of gaps is more useful than nothing plus an exception, and `skp doctor`
    is the thing that refuses to call it healthy.
    """
    surfaces = collect_surfaces(source_root)
    annotations = load_annotations(annotations_dir)
    entries = build(surfaces, annotations)
    problems = check(entries, surfaces, annotations)

    out_dir.mkdir(parents=True, exist_ok=True)
    catalog_path = out_dir / "catalog.json"
    catalog_path.write_text(
        json.dumps([e.to_dict() for e in entries], indent=2, sort_keys=True),
        encoding="utf-8")

    lock = build_lock(_source_paths(source_root), [catalog_path], source_root.parent)
    (out_dir / "compile.lock").write_text(
        json.dumps(lock, indent=2, sort_keys=True), encoding="utf-8")
    return entries, problems
```

Note: `build_lock` records paths relative to `source_root.parent`, so the catalog under the memory folder cannot be expressed relative to it. Fix by locking the two roots separately.

- [ ] **Step 4: Write the failing test for the two-root lock**

```python
# append to skp-toolkit/tests/test_driver.py

    def test_lock_records_both_the_sources_and_the_generated_catalog(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            src = fake_source_root(root)
            notes = root / "annotations"
            notes.mkdir()
            (notes / "empty.json").write_text("{}", encoding="utf-8")
            out = root / "model"
            compile_catalog(src, notes, out)
            lock = json.loads((out / "compile.lock").read_text(encoding="utf-8"))
            self.assertIn("Messaging.Contracts/ProcessorQueues.cs", lock["sources"])
            self.assertIn("catalog.json", lock["generated"])
```

- [ ] **Step 5: Run it to verify it fails**

Run: `cd skp-toolkit && python -m unittest tests.test_driver.CompileTests.test_lock_records_both_the_sources_and_the_generated_catalog -v`
Expected: FAIL with `ValueError: ... is not in the subpath of ...`

- [ ] **Step 6: Lock each root against itself**

```python
# in skp-toolkit/skp/compile/lock.py — add a two-root builder

def build_lock_two_roots(sources, source_root: pathlib.Path,
                         generated, generated_root: pathlib.Path) -> dict:
    """Sources and generated files live under different roots, so each is
    recorded relative to its own. One shared root would force absolute paths,
    which do not survive the bundle being moved."""
    return {
        "sources": {_relative(p, source_root): hash_file(p) for p in sources},
        "generated": {_relative(p, generated_root): hash_file(p) for p in generated},
    }
```

```python
# in skp-toolkit/skp/compile/driver.py — replace the lock call

from skp.compile.lock import build_lock_two_roots

    lock = build_lock_two_roots(_source_paths(source_root), source_root,
                                [catalog_path], out_dir)
```

- [ ] **Step 7: Run the driver tests**

Run: `cd skp-toolkit && python -m unittest tests.test_driver -v`
Expected: PASS (4 tests)

- [ ] **Step 8: Wire compilation into `skp init`**

```python
# in skp-toolkit/skp/verbs/init.py — imports and the tail of run()

import pathlib as _pathlib

from skp.compile.driver import compile_catalog

ANNOTATIONS_DIR = _pathlib.Path(__file__).resolve().parent.parent / "annotations"

# ... inside run(), after profile.save(token=ns.token):

    entries, problems = compile_catalog(
        _pathlib.Path(ns.source_root), ANNOTATIONS_DIR, profile.home / "model")

    rows = probe(build_clients(profile))
    lines = [f"memory folder: {profile.home}",
             f"catalogued {len(entries)} capabilities from {ns.source_root}",
             "", render_table(rows)]

    dead = [name for name, ok, _ in rows if not ok]
    if problems:
        return Result(EXIT_DRIFT,
                      [*lines, "", f"{len(problems)} catalog problem(s):",
                       *(f"  {p}" for p in problems)],
                      next_command="skp doctor")
    if dead:
        return Result(EXIT_UNREACHABLE,
                      [*lines, "", f"unreachable: {', '.join(dead)}"],
                      next_command="skp doctor")
    return Result(EXIT_OK, lines, next_command="skp map --intent observe")
```

Also extend the import of exit codes at the top of `init.py`:

```python
from skp.result import EXIT_DRIFT, EXIT_OK, EXIT_UNREACHABLE, Result
```

- [ ] **Step 9: Run the whole suite**

Run: `cd skp-toolkit && python -m unittest discover -s tests -t . -v`
Expected: PASS, no failures, no errors

- [ ] **Step 10: Commit**

```bash
git add skp-toolkit/
git commit -m "feat(skp): compiler driver, wired into skp init"
```

---

### Task 14: `skp map` — the two-axis lookup

**Files:**
- Create: `skp-toolkit/skp/verbs/map.py`
- Modify: `skp-toolkit/skp/cli.py` (register the group)
- Test: `skp-toolkit/tests/test_map.py`

**Interfaces:**
- Consumes: `Profile` (Task 2), `catalog.json` written by Task 13, `Result` (Task 1).
- Produces: `load_catalog(home: Path) -> list[dict]`; `by_component(entries, name) -> list[dict]`; `by_intent(entries, intent) -> list[dict]`; `by_question(entries, question) -> list[dict]`; `render(entries) -> str`; `run(argv) -> Result`.

`by_question` scores each entry's `answers` text against the question's words. It is deliberately crude: its job is to narrow seven components to one or two, after which the model reads real entries. A wrong ranking costs a second lookup; an invented queue name costs a wrong answer.

- [ ] **Step 1: Write the failing test**

```python
# skp-toolkit/tests/test_map.py
import json
import pathlib
import tempfile
import unittest

from skp.result import EXIT_VERDICT
from skp.verbs.map import by_component, by_intent, by_question, load_catalog, render

ENTRIES = [
    {"id": "redis.Root", "component": "redis", "operation": "read key",
     "detail": "skp:{workflowId}", "intents": ["observe", "investigate"],
     "answers": "whether a workflow is projected right now",
     "never_for": "the definition — that is Postgres", "write_authority": "none",
     "cost": "cheap", "verb": "skp observe projected"},
    {"id": "postgres.Workflows", "component": "postgres",
     "operation": 'SELECT ... FROM "Workflows"', "detail": "Workflows",
     "intents": ["design"], "answers": "which workflows are defined",
     "never_for": "what is running now", "write_authority": "none",
     "cost": "cheap", "verb": "skp author list"},
    {"id": "elasticsearch.StepReturned", "component": "elasticsearch",
     "operation": "search by attributes.{OriginalFormat}",
     "detail": "the step returned after {ElapsedMs}ms", "intents": ["investigate"],
     "answers": "why a run stopped at a given step",
     "never_for": "current state — ES is history", "write_authority": "none",
     "cost": "bounded", "verb": "skp investigate trace"},
]


class QueryTests(unittest.TestCase):
    def test_by_component_selects_one_store(self):
        self.assertEqual([e["id"] for e in by_component(ENTRIES, "redis")], ["redis.Root"])

    def test_by_intent_crosses_components(self):
        found = {e["id"] for e in by_intent(ENTRIES, "investigate")}
        self.assertEqual(found, {"redis.Root", "elasticsearch.StepReturned"})

    def test_by_intent_is_empty_for_an_uncovered_intent(self):
        self.assertEqual(by_intent(ENTRIES, "remediate"), [])

    def test_by_question_ranks_the_matching_answer_first(self):
        ranked = by_question(ENTRIES, "why did a run stop")
        self.assertEqual(ranked[0]["id"], "elasticsearch.StepReturned")

    def test_by_question_returns_nothing_rather_than_a_bad_guess(self):
        self.assertEqual(by_question(ENTRIES, "kubernetes ingress certificate"), [])


class RenderTests(unittest.TestCase):
    def test_render_shows_the_never_for_field(self):
        text = render([ENTRIES[0]])
        self.assertIn("redis.Root", text)
        self.assertIn("NEVER: the definition — that is Postgres", text)
        self.assertIn("skp observe projected", text)


class LoadTests(unittest.TestCase):
    def test_load_reads_the_compiled_catalog(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = pathlib.Path(tmp)
            (home / "model").mkdir()
            (home / "model" / "catalog.json").write_text(
                json.dumps(ENTRIES), encoding="utf-8")
            self.assertEqual(len(load_catalog(home)), 3)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd skp-toolkit && python -m unittest tests.test_map -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'skp.verbs.map'`

- [ ] **Step 3: Write minimal implementation**

```python
# skp-toolkit/skp/verbs/map.py
import argparse
import json
import pathlib
import re

from skp.profile import Profile, ProfileMissing, default_home, not_initialised
from skp.result import EXIT_OK, EXIT_VERDICT, Result

STOPWORDS = {"a", "an", "the", "did", "do", "does", "is", "are", "was", "were",
             "why", "what", "which", "where", "how", "to", "of", "in", "on",
             "at", "for", "i", "my", "it", "that", "this"}


def load_catalog(home: pathlib.Path) -> list[dict]:
    path = home / "model" / "catalog.json"
    if not path.exists():
        raise ProfileMissing(str(path))
    return json.loads(path.read_text(encoding="utf-8"))


def by_component(entries: list[dict], name: str) -> list[dict]:
    return [e for e in entries if e["component"] == name]


def by_intent(entries: list[dict], intent: str) -> list[dict]:
    return [e for e in entries if intent in e.get("intents", [])]


def _words(text: str) -> set[str]:
    return {w for w in re.findall(r"[a-z]+", text.lower()) if w not in STOPWORDS}


def by_question(entries: list[dict], question: str) -> list[dict]:
    """Rank by word overlap with each entry's ``answers`` text.

    Crude on purpose: this narrows seven components to one or two, and the model
    reads real entries after that. Entries with no overlap are dropped rather
    than ranked last -- returning nothing is a better answer than a bad guess.
    """
    asked = _words(question)
    scored = []
    for entry in entries:
        overlap = len(asked & _words(entry.get("answers", "")))
        if overlap:
            scored.append((overlap, entry["id"], entry))
    scored.sort(key=lambda t: (-t[0], t[1]))
    return [entry for _, _, entry in scored]


def render(entries: list[dict]) -> str:
    blocks = []
    for entry in entries:
        block = [
            f"{entry['id']}  [{', '.join(entry.get('intents', []))}]",
            f"  {entry['operation']}   -> {entry['detail']}",
            f"  ANSWERS: {entry.get('answers', '')}",
        ]
        if entry.get("never_for"):
            block.append(f"  NEVER: {entry['never_for']}")
        if entry.get("verb"):
            block.append(f"  VERB: {entry['verb']}")
        blocks.append("\n".join(block))
    return "\n\n".join(blocks)


def run(argv: list[str]) -> Result:
    parser = argparse.ArgumentParser(prog="skp map")
    parser.add_argument("--home", default=str(default_home()))
    parser.add_argument("--component")
    parser.add_argument("--intent")
    parser.add_argument("--answers")
    ns = parser.parse_args(argv)

    home = pathlib.Path(ns.home)
    try:
        entries = load_catalog(home)
    except ProfileMissing:
        return not_initialised()

    if ns.component:
        found, what = by_component(entries, ns.component), f"component {ns.component!r}"
    elif ns.intent:
        found, what = by_intent(entries, ns.intent), f"intent {ns.intent!r}"
    elif ns.answers:
        found, what = by_question(entries, ns.answers), f"question {ns.answers!r}"
    else:
        components = sorted({e["component"] for e in entries})
        return Result(EXIT_OK,
                      [f"{len(entries)} capabilities across: {', '.join(components)}"],
                      next_command="skp map --component <name>")

    if not found:
        return Result(EXIT_VERDICT,
                      [f"no catalog entry for {what}",
                       "this is a gap, not a reason to guess — report it"],
                      next_command="skp map")
    return Result(EXIT_OK, [render(found)])
```

```python
# in skp-toolkit/skp/cli.py — extend GROUPS

from skp.verbs import init as init_verb
from skp.verbs import map as map_verb

GROUPS = {"init": init_verb.run, "map": map_verb.run}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd skp-toolkit && python -m unittest tests.test_map -v`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add skp-toolkit/skp/verbs/map.py skp-toolkit/skp/cli.py skp-toolkit/tests/test_map.py
git commit -m "feat(skp): skp map, the two-axis capability lookup"
```

---

### Task 15: `skp doctor`

**Files:**
- Create: `skp-toolkit/skp/verbs/doctor.py`
- Modify: `skp-toolkit/skp/cli.py` (register the group)
- Test: `skp-toolkit/tests/test_doctor.py`

**Interfaces:**
- Consumes: `Profile` (Task 2), `stale_sources` / `edited_generated` (Task 12), `compile_catalog` (Task 13), `probe` (Task 7), `load_catalog` (Task 14).
- Produces: `diagnose(profile: Profile, clients: dict) -> list[tuple[str, bool, str]]` returning `(check_name, ok, detail)`; `run(argv) -> Result`.

`doctor` is the answer to "is the toolkit wrong, or is the system wrong". Each check is named, and each failure carries the command that fixes it.

- [ ] **Step 1: Write the failing test**

```python
# skp-toolkit/tests/test_doctor.py
import json
import pathlib
import tempfile
import unittest

from skp.profile import Profile
from skp.verbs.doctor import diagnose

CATALOG = [{"id": "redis.Root", "component": "redis", "operation": "read key",
            "detail": "skp:{workflowId}", "intents": ["observe"],
            "answers": "x", "never_for": "y", "write_authority": "none",
            "cost": "cheap", "verb": "skp observe projected"}]


class Probeable:
    def __init__(self, ok=True):
        self._ok = ok

    def ping(self):
        return self._ok

    ready = ping


def clients(**overrides):
    base = {name: Probeable() for name in
            ("cluster", "postgres", "redis", "rabbitmq", "elasticsearch",
             "prometheus", "baseapi")}
    base.update(overrides)
    return base


class DoctorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        self.source = self.root / "src" / "Queues.cs"
        self.source.parent.mkdir(parents=True)
        self.source.write_text("original", encoding="utf-8")

        self.home = self.root / ".skp"
        self.profile = Profile(home=self.home, source_root=str(self.source.parent),
                               cluster_url="https://c", project="skp", endpoints={})
        self.profile.save(token="")

        model = self.home / "model"
        model.mkdir(exist_ok=True)
        catalog_path = model / "catalog.json"
        catalog_path.write_text(json.dumps(CATALOG), encoding="utf-8")

        from skp.compile.lock import build_lock_two_roots
        lock = build_lock_two_roots([self.source], self.source.parent,
                                    [catalog_path], model)
        (model / "compile.lock").write_text(json.dumps(lock), encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def names(self, rows):
        return [name for name, _, _ in rows]

    def test_a_healthy_bundle_passes_every_check(self):
        rows = diagnose(self.profile, clients())
        self.assertTrue(all(ok for _, ok, _ in rows), rows)
        self.assertIn("source drift", self.names(rows))
        self.assertIn("generated files", self.names(rows))
        self.assertIn("catalog present", self.names(rows))

    def test_an_edited_source_fails_the_drift_check_and_names_the_file(self):
        self.source.write_text("edited", encoding="utf-8")
        rows = {name: (ok, detail) for name, ok, detail in diagnose(self.profile, clients())}
        ok, detail = rows["source drift"]
        self.assertFalse(ok)
        self.assertIn("Queues.cs", detail)

    def test_an_edited_catalog_fails_the_generated_check(self):
        (self.home / "model" / "catalog.json").write_text("[]", encoding="utf-8")
        rows = {name: (ok, detail) for name, ok, detail in diagnose(self.profile, clients())}
        self.assertFalse(rows["generated files"][0])

    def test_an_unreachable_store_is_its_own_named_check(self):
        rows = {name: (ok, detail) for name, ok, detail
                in diagnose(self.profile, clients(redis=Probeable(False)))}
        self.assertFalse(rows["reachability: redis"][0])
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd skp-toolkit && python -m unittest tests.test_doctor -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'skp.verbs.doctor'`

- [ ] **Step 3: Write minimal implementation**

```python
# skp-toolkit/skp/verbs/doctor.py
import argparse
import json
import pathlib

from skp.compile.lock import edited_generated, stale_sources
from skp.profile import Profile, ProfileMissing, default_home, not_initialised
from skp.result import EXIT_DRIFT, EXIT_OK, Result
from skp.verbs.init import build_clients, probe

FIXES = {
    "source drift": "skp init --refresh",
    "generated files": "edit the annotation, not the generated file — then skp init --refresh",
    "catalog present": "skp init --refresh",
}


def diagnose(profile: Profile, clients: dict) -> list[tuple[str, bool, str]]:
    """Every check, always run. A doctor that stops at the first problem hides
    the second one, and two problems at once is the normal case after a move."""
    rows: list[tuple[str, bool, str]] = []
    model = profile.home / "model"
    lock_path = model / "compile.lock"
    catalog_path = model / "catalog.json"

    if lock_path.exists():
        lock = json.loads(lock_path.read_text(encoding="utf-8"))
        stale = stale_sources(lock, pathlib.Path(profile.source_root))
        rows.append(("source drift", not stale,
                     ", ".join(stale) if stale else "in step with source"))
        edited = edited_generated(lock, model)
        rows.append(("generated files", not edited,
                     ", ".join(edited) if edited else "unmodified"))
    else:
        rows.append(("source drift", False, "no compile.lock"))
        rows.append(("generated files", False, "no compile.lock"))

    if catalog_path.exists():
        entries = json.loads(catalog_path.read_text(encoding="utf-8"))
        untagged = [e["id"] for e in entries if not e.get("intents")]
        rows.append(("catalog present", not untagged,
                     f"{len(entries)} entries" if not untagged
                     else f"{len(untagged)} untagged: {', '.join(untagged[:3])}"))
    else:
        rows.append(("catalog present", False, "no catalog.json"))

    for name, ok, detail in probe(clients):
        rows.append((f"reachability: {name}", ok, detail or ("ok" if ok else "no answer")))

    return rows


def run(argv: list[str]) -> Result:
    parser = argparse.ArgumentParser(prog="skp doctor")
    parser.add_argument("--home", default=str(default_home()))
    ns = parser.parse_args(argv)

    try:
        profile = Profile.load(pathlib.Path(ns.home))
    except ProfileMissing:
        return not_initialised()

    rows = diagnose(profile, build_clients(profile))
    width = max(len(name) for name, _, _ in rows)
    lines = [f"  {name.ljust(width)}  {'ok' if ok else 'FAIL'}  {detail}".rstrip()
             for name, ok, detail in rows]

    failed = [name for name, ok, _ in rows if not ok]
    if failed:
        first_fix = next((FIXES[name] for name in failed if name in FIXES), "skp init --refresh")
        return Result(EXIT_DRIFT, [*lines, "", f"{len(failed)} check(s) failed"],
                      next_command=first_fix)
    return Result(EXIT_OK, lines)
```

```python
# in skp-toolkit/skp/cli.py — extend GROUPS

from skp.verbs import doctor as doctor_verb
from skp.verbs import init as init_verb
from skp.verbs import map as map_verb

GROUPS = {"init": init_verb.run, "map": map_verb.run, "doctor": doctor_verb.run}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd skp-toolkit && python -m unittest tests.test_doctor -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Run the whole suite**

Run: `cd skp-toolkit && python -m unittest discover -s tests -t . -v`
Expected: PASS, no failures, no errors

- [ ] **Step 6: Commit**

```bash
git add skp-toolkit/skp/verbs/doctor.py skp-toolkit/skp/cli.py skp-toolkit/tests/test_doctor.py
git commit -m "feat(skp): skp doctor names each failed check and its fix"
```

---

### Task 16: Annotate every real surface until the build is clean

**Files:**
- Create: `skp-toolkit/skp/annotations/api.json`
- Create: `skp-toolkit/skp/annotations/postgres.json`
- Create: `skp-toolkit/skp/annotations/rabbitmq.json`
- Create: `skp-toolkit/skp/annotations/elasticsearch.json`
- Create: `skp-toolkit/skp/annotations/prometheus.json`
- Test: `skp-toolkit/tests/test_catalog_is_complete.py`

**Interfaces:**
- Consumes: `compile_catalog` (Task 13), the real `src/` tree.
- Produces: no new code — a passing completeness test against the real repo.

This is the task that turns "coverage is enforced" into "coverage is achieved". It is deliberately last: the checks must exist and fail before the annotations are worth writing.

- [ ] **Step 1: Write the failing test**

```python
# skp-toolkit/tests/test_catalog_is_complete.py
import pathlib
import tempfile
import unittest

from skp.compile.driver import compile_catalog

REPO = pathlib.Path(__file__).resolve().parents[2]
SRC = REPO / "src"
ANNOTATIONS = REPO / "skp-toolkit" / "skp" / "annotations"


@unittest.skipUnless(SRC.exists(), "run from inside the repo")
class CompletenessTests(unittest.TestCase):
    def test_the_real_sources_compile_with_no_problems(self):
        with tempfile.TemporaryDirectory() as tmp:
            _, problems = compile_catalog(SRC, ANNOTATIONS, pathlib.Path(tmp))
        self.assertEqual(problems, [], "\n".join(problems))

    def test_every_component_is_represented(self):
        with tempfile.TemporaryDirectory() as tmp:
            entries, _ = compile_catalog(SRC, ANNOTATIONS, pathlib.Path(tmp))
        self.assertEqual(
            {e.component for e in entries},
            {"api", "postgres", "redis", "rabbitmq", "elasticsearch", "prometheus"})
```

- [ ] **Step 2: Run it to see exactly what is unannotated**

Run: `cd skp-toolkit && python -m unittest tests.test_catalog_is_complete -v`
Expected: FAIL, listing every surface id with no annotation — this list is the work order for Step 3.

- [ ] **Step 3: Write one annotation file per component**

Every id the failure named gets an entry in the file for its component. Use this shape, and write `never_for` from the source's own reasoning rather than inventing it:

```json
{
  "api.workflows.get": {
    "intents": ["design", "observe"],
    "answers": "which workflows are defined, with their entry steps and cron",
    "never_for": "whether a workflow is currently running — that is Redis L2",
    "write_authority": "read",
    "cost": "cheap",
    "verb": "skp author list"
  },
  "api.orchestration.post_start": {
    "intents": ["control"],
    "answers": "accepting one workflow for projection, after five synchronous gates",
    "never_for": "confirming the workflow is projected — 202 means accepted, not applied",
    "write_authority": "baseapi",
    "cost": "cheap",
    "verb": "skp operate start"
  }
}
```

Facts to carry into the `never_for` fields, each already established in the source:

- `postgres.*` — never for what is running now; L2 holds the projection and legitimately lags a PUT until the next start.
- `postgres.StepNextSteps` / `WorkflowEntrySteps` / `WorkflowAssignments` — these junctions are the source of truth for edges and bindings; the entities carry neither.
- `rabbitmq.Work` — never for identifying a processor; the queue name embeds the id, and a rebuilt processor keeps its id.
- `rabbitmq.*Dead` — never assume a parked message is readable; reading one requires consuming it.
- `elasticsearch.*` — never for current state; ES is history. And a `WorkflowId` filter alone cannot identify a run, because the control-plane endpoints log it too.
- `prometheus.*` — never group on `instance` for a per-replica question; `instance` is the scrape target. Use `service_instance_id`.
- `api.processors.get_by_source_hash` — never send a mixed-case hash; matching is byte-exact lowercase and an uppercase variant 404s past a row that exists.

- [ ] **Step 4: Re-run until clean**

Run: `cd skp-toolkit && python -m unittest tests.test_catalog_is_complete -v`
Expected: PASS (2 tests). If an intent is reported as uncovered, that is a real gap — annotate a capability that genuinely serves it rather than tagging one falsely.

- [ ] **Step 5: Run the whole suite**

Run: `cd skp-toolkit && python -m unittest discover -s tests -t . -v`
Expected: PASS, no failures, no errors

- [ ] **Step 6: Compile against the live repo and read the output**

Run: `cd skp-toolkit && python -m skp init --home ../.skp-dev --source-root ../src --cluster-url https://localhost --project skp`
Expected: prints the catalogued capability count and a seven-row reachability table. Unreachable rows are expected without a cluster; the catalog line must show a non-zero count.

- [ ] **Step 7: Commit**

```bash
git add skp-toolkit/skp/annotations/ skp-toolkit/tests/test_catalog_is_complete.py
git commit -m "feat(skp): annotate every discovered surface; catalog coverage is clean"
```

---

## Self-Review

**Spec coverage.** §4 bundle shape → Tasks 1, 3–6, 8–13. §4.1 naming → Task 1 (`GROUPS`), 14, 15. §4.2 `NEXT:` and error-names-remedy → Task 1 (`Result.reference`/`next_command`), used in 7, 14, 15. §5 init and memory folder → Tasks 2, 7, 13. §6.1 closed taxonomy → Task 11 (`INTENTS`). §6.2 entry fields → Task 11 (`Entry`). §6.3 components → Tasks 5, 6, 9, 10, 16. §6.4 both query axes → Task 14. §6.5 completeness → Tasks 11, 16. §8 write authority → recorded per entry (Task 11); no write path is implemented in this plan, matching "reads only". §12 update paths and generated-never-edited → Task 12 (`edited_generated`), 15. §13.1 structural verification → Task 15.

**Deferred to later plans, deliberately:** §7 investigation and the cut-point ladder; §9 the skills themselves; §10 the developer capability surface; §11 the SourceHash rule; §13.2–13.4 behavioural and model-facing evaluation. Each needs the catalog this plan produces.

**Placeholder scan.** No TBDs. Every code step carries runnable code. Task 16 Step 3 is the one step that names work rather than showing all of it — unavoidable, since the ids come from Step 2's output, so it ships a worked example plus the seven facts to encode.

**Type consistency.** `Surface(component, id, operation, detail)` is constructed identically in Tasks 9 and 10 and consumed in 11 and 13. `Entry.to_dict()` keys match every key `map.render` reads. `probe()` returns `(name, ok, detail)` in Task 7 and is consumed with that shape in Task 15. `build_lock_two_roots` replaces `build_lock` in the driver (Task 13 Step 6) while `build_lock` stays for its own tests. `EXIT_DRIFT` is imported in Tasks 13 and 15.

**One correction made during review:** Task 6 originally had `Prometheus.ready()` calling `/-/healthy` through `get_json`, which raises `JSONDecodeError` on that endpoint's plain-text body. Steps 5–7 now add `get_text` and a test that catches it.
