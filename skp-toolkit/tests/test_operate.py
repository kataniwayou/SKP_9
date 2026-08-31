import unittest

from skp.result import EXIT_OK, EXIT_UNREACHABLE, EXIT_USAGE, EXIT_VERDICT
from skp.verbs import operate

WF = "4cd8af45-1295-43db-ab2e-e955dd82b5c5"

ENTRIES = [
    {"id": "api.orchestration.post_start", "component": "api",
     "operation": "POST /api/v1.0/orchestration/start", "detail": "orchestration"},
    {"id": "api.orchestration.post_stop", "component": "api",
     "operation": "POST /api/v1.0/orchestration/stop", "detail": "orchestration"},
    {"id": "redis.Root", "component": "redis", "operation": "read key",
     "detail": "skp:{workflowId}"},
]


class FakeRedis:
    """Returns a scripted sequence per pattern, so a key that appears on the
    second poll can be distinguished from one that never appears."""

    def __init__(self, sequences):
        self._sequences = {k: list(v) for k, v in sequences.items()}

    def keys(self, pattern):
        seq = self._sequences.get(pattern)
        if not seq:
            return []
        return seq.pop(0)


class FakeApi:
    def __init__(self, reply, raises=None):
        self._reply = reply
        self._raises = raises
        outer = self

        class _Http:
            calls = []

            @staticmethod
            def probe_status(method, path, body):
                outer.http.calls.append((method, path, body))
                if outer._raises:
                    raise outer._raises
                return outer._reply

        self.http = _Http()


class StartTests(unittest.TestCase):
    def test_a_202_is_not_started_until_the_root_key_appears(self):
        clients = {"baseapi": FakeApi((202, "")),
                   "redis": FakeRedis({f"skp:{WF}": [[], [f"skp:{WF}"]]})}
        result = operate.start(ENTRIES, clients, WF, confirm=True,
                               attempts=2, poll_s=0)
        self.assertEqual(result.code, EXIT_OK)
        self.assertIn("projected", result.render())

    def test_a_202_whose_projection_never_lands_is_a_verdict(self):
        clients = {"baseapi": FakeApi((202, "")),
                   "redis": FakeRedis({f"skp:{WF}": [[], []]})}
        result = operate.start(ENTRIES, clients, WF, confirm=True,
                               attempts=2, poll_s=0)
        self.assertEqual(result.code, EXIT_VERDICT)
        self.assertIn("accepted, not applied", result.render())

    def test_a_422_from_start_names_the_gate_and_reference(self):
        body = ('{"detail":"Processor is not live.","errors":'
                '{"gate":"processorLiveness","offending":'
                '{"procId":"p","reason":"no healthy replica"}}}')
        clients = {"baseapi": FakeApi((422, body)), "redis": FakeRedis({})}
        result = operate.start(ENTRIES, clients, WF, confirm=True,
                               attempts=1, poll_s=0)
        self.assertEqual(result.code, EXIT_VERDICT)
        self.assertEqual(result.reference,
                         "references/gate-processor-liveness.md")

    def test_without_confirmation_it_refuses_and_never_calls_the_api(self):
        clients = {"baseapi": FakeApi((202, "")), "redis": FakeRedis({})}
        result = operate.start(ENTRIES, clients, WF, confirm=False,
                               attempts=1, poll_s=0)
        self.assertEqual(result.code, EXIT_USAGE)
        self.assertEqual(clients["baseapi"].http.calls, [])

    def test_a_transport_failure_is_unreachable(self):
        clients = {"baseapi": FakeApi((0, ""), raises=OSError("boom")),
                   "redis": FakeRedis({})}
        result = operate.start(ENTRIES, clients, WF, confirm=True,
                               attempts=1, poll_s=0)
        self.assertEqual(result.code, EXIT_UNREACHABLE)

    def test_an_unparseable_422_names_the_status_rather_than_crashing(self):
        clients = {"baseapi": FakeApi((422, "<html>nope</html>")),
                   "redis": FakeRedis({})}
        result = operate.start(ENTRIES, clients, WF, confirm=True,
                               attempts=1, poll_s=0)
        self.assertEqual(result.code, EXIT_VERDICT)
        self.assertIn("422", result.render())

    def test_a_422_with_no_gate_key_is_a_verdict_not_a_crash(self):
        clients = {"baseapi": FakeApi((422, '{"detail":"nope"}')),
                   "redis": FakeRedis({})}
        result = operate.start(ENTRIES, clients, WF, confirm=True,
                               attempts=1, poll_s=0)
        self.assertEqual(result.code, EXIT_VERDICT)


class StopTests(unittest.TestCase):
    def test_without_confirmation_it_refuses_and_never_calls_the_api(self):
        clients = {"baseapi": FakeApi((202, "")), "redis": FakeRedis({})}
        result = operate.stop(ENTRIES, clients, WF, confirm=False,
                              attempts=1, poll_s=0)
        self.assertEqual(result.code, EXIT_USAGE)
        self.assertEqual(clients["baseapi"].http.calls, [])

    def test_stop_waits_for_the_root_key_to_disappear(self):
        clients = {"baseapi": FakeApi((202, "")),
                   "redis": FakeRedis({f"skp:{WF}": [[f"skp:{WF}"], []]})}
        result = operate.stop(ENTRIES, clients, WF, confirm=True,
                              attempts=2, poll_s=0)
        self.assertEqual(result.code, EXIT_OK)
        self.assertIn("gone from L2", result.render())

    def test_a_projection_that_survives_the_stop_is_a_verdict(self):
        clients = {"baseapi": FakeApi((202, "")),
                   "redis": FakeRedis({f"skp:{WF}": [[f"skp:{WF}"],
                                                     [f"skp:{WF}"]]})}
        result = operate.stop(ENTRIES, clients, WF, confirm=True,
                              attempts=2, poll_s=0)
        self.assertEqual(result.code, EXIT_VERDICT)
        self.assertIn("queued, not applied", result.render())


if __name__ == "__main__":
    unittest.main()
