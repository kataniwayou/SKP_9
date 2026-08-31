import unittest

from skp.result import EXIT_OK, EXIT_UNREACHABLE, EXIT_USAGE, EXIT_VERDICT
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


if __name__ == "__main__":
    unittest.main()
