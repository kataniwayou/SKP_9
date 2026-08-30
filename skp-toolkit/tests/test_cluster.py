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
