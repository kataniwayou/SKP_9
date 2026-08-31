import unittest

from skp.result import (EXIT_NOT_INITIALISED, EXIT_OK, EXIT_UNREACHABLE,
                        EXIT_USAGE, EXIT_VERDICT)
from skp.verbs import author

WF = "4cd8af45-1295-43db-ab2e-e955dd82b5c5"

ENTRIES = [{"id": "api.orchestration.post_start", "component": "api",
            "operation": "POST /api/v1.0/orchestration/start",
            "detail": "orchestration"}]


class FakeHttp:
    def __init__(self, reply, raises=None):
        self._reply = reply
        self._raises = raises
        self.calls = []

    def probe_status(self, method, path, body):
        self.calls.append((method, path, body))
        if self._raises:
            raise self._raises
        return self._reply


class FakeApi:
    def __init__(self, reply, raises=None):
        self.http = FakeHttp(reply, raises)


def clients_for(status, text, raises=None):
    return {"baseapi": FakeApi((status, text), raises)}


class ValidateTests(unittest.TestCase):
    def test_without_confirmation_it_refuses_and_never_calls_the_api(self):
        clients = clients_for(202, "")
        result = author.validate(ENTRIES, clients, WF, confirm_start=False)
        self.assertEqual(result.code, EXIT_USAGE)
        self.assertEqual(clients["baseapi"].http.calls, [])
        self.assertIn("--confirm-start", result.render())

    def test_a_422_names_the_gate_and_its_reference_file(self):
        body = ('{"title":"Schema-edge mismatch between steps","status":422,'
                '"detail":"Schema-edge mismatch on edge.",'
                '"errors":{"gate":"schemaEdge","offending":'
                '{"parentStepId":"a","childStepId":"b"}}}')
        result = author.validate(ENTRIES, clients_for(422, body), WF,
                                 confirm_start=True)
        self.assertEqual(result.code, EXIT_VERDICT)
        self.assertIn("schemaEdge", result.render())
        self.assertIn("parentStepId", result.render())
        self.assertEqual(result.reference, "references/gate-schema-edge.md")

    def test_a_404_is_a_verdict_about_the_workflow_not_a_gate(self):
        body = ('{"title":"Not Found","status":404,'
                '"detail":"WorkflowEntity with id \'x\' was not found."}')
        result = author.validate(ENTRIES, clients_for(404, body), WF,
                                 confirm_start=True)
        self.assertEqual(result.code, EXIT_VERDICT)
        self.assertIsNone(result.reference)
        self.assertIn("not found", result.render().lower())

    def test_a_202_reports_that_the_workflow_is_now_running(self):
        result = author.validate(ENTRIES, clients_for(202, ""), WF,
                                 confirm_start=True)
        self.assertEqual(result.code, EXIT_OK)
        self.assertIn("RUNNING", result.render())
        self.assertIn("skp operate verify", result.render())

    def test_an_unparseable_422_names_the_status_rather_than_crashing(self):
        result = author.validate(ENTRIES, clients_for(422, "<html>nope</html>"),
                                 WF, confirm_start=True)
        self.assertEqual(result.code, EXIT_VERDICT)
        self.assertIn("422", result.render())

    def test_a_transport_failure_is_unreachable_not_a_verdict(self):
        """UNVERIFIABLE and REFUTED are different answers -- the same ruling
        skp verify makes. A store that did not answer has not rejected."""
        result = author.validate(ENTRIES, clients_for(0, "", raises=OSError("boom")),
                                 WF, confirm_start=True)
        self.assertEqual(result.code, EXIT_UNREACHABLE)


APPLY_ENTRIES = ENTRIES + [
    {"id": f"api.{name}.post", "component": "api",
     "operation": f"POST /api/v1.0/{name}", "detail": name}
    for name in ("schemas", "processors", "steps", "assignments", "workflows")
]


class ApplyTests(unittest.TestCase):
    def test_sections_are_posted_in_foreign_key_order(self):
        posted = []

        class RecordingApi:
            class http:
                @staticmethod
                def probe_status(method, path, body):
                    posted.append(path)
                    return (201, '{"id":"x"}')

        spec = {"workflows": [{"n": 1}], "schemas": [{"n": 2}],
                "assignments": [{"n": 3}], "processors": [{"n": 4}],
                "steps": [{"n": 5}]}
        result = author.apply(APPLY_ENTRIES, {"baseapi": RecordingApi()}, spec,
                              confirm_write=True)
        self.assertEqual(result.code, EXIT_OK)
        self.assertEqual(posted, [
            "/api/v1.0/schemas", "/api/v1.0/processors", "/api/v1.0/steps",
            "/api/v1.0/assignments", "/api/v1.0/workflows"])

    def test_a_rejected_section_stops_the_apply_and_names_what_landed(self):
        """Half an applied definition is a real state somebody has to clean
        up, so the verb must say exactly how far it got."""
        calls = []

        class FailingApi:
            class http:
                @staticmethod
                def probe_status(method, path, body):
                    calls.append(path)
                    if "processors" in path:
                        return (400, '{"detail":"Name is required."}')
                    return (201, '{"id":"x"}')

        spec = {"schemas": [{"n": 1}], "processors": [{"n": 2}], "steps": [{"n": 3}]}
        result = author.apply(APPLY_ENTRIES, {"baseapi": FailingApi()}, spec,
                              confirm_write=True)
        self.assertEqual(result.code, EXIT_VERDICT)
        self.assertIn("Name is required", result.render())
        self.assertIn("1 schemas", result.render())
        self.assertNotIn("/api/v1.0/steps", calls)

    def test_without_confirmation_nothing_is_posted(self):
        class Forbidden:
            class http:
                @staticmethod
                def probe_status(method, path, body):
                    raise AssertionError("must not be called")

        result = author.apply(APPLY_ENTRIES, {"baseapi": Forbidden()},
                              {"schemas": [{}]}, confirm_write=False)
        self.assertEqual(result.code, EXIT_USAGE)

    def test_an_unknown_section_is_refused_before_any_write(self):
        class Forbidden:
            class http:
                @staticmethod
                def probe_status(method, path, body):
                    raise AssertionError("must not be called")

        result = author.apply(APPLY_ENTRIES, {"baseapi": Forbidden()},
                              {"widgets": [{}]}, confirm_write=True)
        self.assertEqual(result.code, EXIT_USAGE)
        self.assertIn("widgets", result.render())


if __name__ == "__main__":
    unittest.main()
