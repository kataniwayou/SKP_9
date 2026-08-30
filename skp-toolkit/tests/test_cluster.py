import subprocess
import unittest

from skp.clients.cluster import ClusterClient, active_server, detect_binary, normalise_server
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


class ScriptedRunner:
    """Returns `config_result` for a `config view` call (the server-identity
    probe) and `result` for everything else, so tests can tell the
    enforcement check apart from the call it guards."""

    def __init__(self, stdout="", returncode=0, stderr="", server=""):
        self.calls: list[list[str]] = []
        self.result = subprocess.CompletedProcess([], returncode, stdout, stderr)
        self.config_result = subprocess.CompletedProcess([], 0, server, "")

    def __call__(self, argv, capture_output=True, text=True, timeout=None):
        self.calls.append(argv)
        if "config" in argv and "view" in argv:
            return self.config_result
        return self.result


class ExpectedServerTests(unittest.TestCase):
    """cluster_url section: ClusterClient enforces the profile's cluster_url
    against the active kube context, once per process."""

    def test_a_matching_server_passes_and_the_call_proceeds(self):
        runner = ScriptedRunner(stdout="ok", server="https://cluster.example:6443")
        client = ClusterClient("skp", binary="oc", runner=runner,
                               expected_server="https://cluster.example:6443")
        self.assertEqual(client.run(["get", "pods"]), "ok")

    def test_a_mismatched_server_raises_naming_both(self):
        runner = ScriptedRunner(stdout="ok", server="https://other.example:6443")
        client = ClusterClient("skp", binary="oc", runner=runner,
                               expected_server="https://cluster.example:6443")
        with self.assertRaises(Unreachable) as caught:
            client.run(["get", "pods"])
        self.assertIn("cluster.example", caught.exception.detail)
        self.assertIn("other.example", caught.exception.detail)

    def test_verification_happens_once_not_per_call(self):
        runner = ScriptedRunner(stdout="ok", server="https://cluster.example:6443")
        client = ClusterClient("skp", binary="oc", runner=runner,
                               expected_server="https://cluster.example:6443")
        client.run(["get", "pods"])
        client.run(["get", "pods"])
        client.run(["get", "pods"])
        config_calls = [c for c in runner.calls if "config" in c and "view" in c]
        self.assertEqual(len(config_calls), 1)

    def test_no_expected_server_means_no_verification_call(self):
        runner = ScriptedRunner(stdout="ok")
        client = ClusterClient("skp", binary="oc", runner=runner)
        client.run(["get", "pods"])
        self.assertFalse(any("config" in c and "view" in c for c in runner.calls))


class NormaliseServerTests(unittest.TestCase):
    def test_a_trailing_slash_is_ignored(self):
        self.assertEqual(normalise_server("https://c:6443/"), normalise_server("https://c:6443"))

    def test_localhost_and_127_0_0_1_are_equal(self):
        self.assertEqual(normalise_server("https://127.0.0.1:6443"),
                         normalise_server("https://localhost:6443"))

    def test_a_default_port_spelled_out_is_equal_to_the_bare_form(self):
        self.assertEqual(normalise_server("https://cluster.example:443"),
                         normalise_server("https://cluster.example"))

    def test_genuinely_different_hosts_are_not_equal(self):
        self.assertNotEqual(normalise_server("https://cluster-a.example"),
                            normalise_server("https://cluster-b.example"))

    def test_a_scheme_less_url_defaults_to_https_like_the_bare_form(self):
        # Minor 4: urlsplit("cluster.example:6443") parses scheme=
        # "cluster.example" and an empty host -- normalising to
        # "cluster.example://" instead of defaulting the missing scheme.
        self.assertEqual(normalise_server("cluster.example:6443"),
                         normalise_server("https://cluster.example:6443"))


class ActiveServerTests(unittest.TestCase):
    def test_reads_the_server_from_config_view(self):
        runner = FakeRunner(stdout="https://cluster.example:6443\n")
        self.assertEqual(active_server("oc", runner=runner), "https://cluster.example:6443")
        self.assertIn("config", runner.calls[0])

    def test_a_failed_config_view_is_Unreachable(self):
        runner = FakeRunner(returncode=1, stderr="no context set")
        with self.assertRaises(Unreachable):
            active_server("oc", runner=runner)

    def test_an_empty_server_is_Unreachable(self):
        runner = FakeRunner(stdout="")
        with self.assertRaises(Unreachable):
            active_server("oc", runner=runner)
