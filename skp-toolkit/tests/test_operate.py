import json
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

FREEZE_ENTRIES = ENTRIES + [
    {"id": "api.steps.get_id", "component": "api",
     "operation": "GET /api/v1.0/steps/{id}", "detail": "steps"},
    {"id": "api.steps.put_id", "component": "api",
     "operation": "PUT /api/v1.0/steps/{id}", "detail": "steps"},
]

STEP = "eb42edf2-062d-48be-896e-7860a7370b12"


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
    def __init__(self, reply=None, raises=None, replies=None):
        # For backwards compatibility: accept single reply tuple, or a dict
        # mapping method -> reply tuple. If replies dict, use it; else use reply.
        if replies is not None:
            self._replies = replies
        elif reply is not None:
            # Single reply for all calls (backwards compat)
            self._replies = {}
            self._default_reply = reply
        else:
            self._replies = {}
            self._default_reply = None
        self._raises = raises
        outer = self

        class _Http:
            calls = []

            @staticmethod
            def probe_status(method, path, body):
                outer.http.calls.append((method, path, body))
                if outer._raises:
                    raise outer._raises
                # Look up reply by method; fall back to default for backwards compat
                if outer._replies:
                    return outer._replies.get(method, (None, None))
                return outer._default_reply

        self.http = _Http()


class FakePg:
    """Mirrors the real client: rows(sql) -> list[list[str]]. Values are
    strings because psql --csv yields text, which is why the verb compares
    against "5" and not 5."""

    def __init__(self, rows):
        self._rows = rows

    def rows(self, sql):
        return self._rows


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


class FreezeTests(unittest.TestCase):
    def test_freeze_reports_that_it_lands_on_the_next_start(self):
        step_obj = {"id": STEP, "name": "step-A", "version": "1.0.0",
                    "entryCondition": 4, "description": None}
        get_reply = (200, json.dumps(step_obj))
        clients = {"baseapi": FakeApi(replies={"GET": get_reply, "PUT": (204, "")}),
                   "postgres": FakePg([["5"]])}
        result = operate.freeze(FREEZE_ENTRIES, clients, STEP, confirm=True)
        self.assertEqual(result.code, EXIT_OK)
        self.assertIn("NEXT start", result.render())
        self.assertIn("skp operate start", result.render())

    def test_put_body_is_get_response_with_only_entry_condition_changed(self):
        step_obj = {"id": STEP, "name": "step-A", "version": "1.0.0",
                    "description": None, "entryCondition": 4}
        get_reply = (200, json.dumps(step_obj))
        clients = {"baseapi": FakeApi(replies={"GET": get_reply, "PUT": (204, "")}),
                   "postgres": FakePg([["5"]])}
        operate.freeze(FREEZE_ENTRIES, clients, STEP, confirm=True)
        # Verify two calls were made: GET then PUT
        self.assertEqual(len(clients["baseapi"].http.calls), 2)
        get_call, put_call = clients["baseapi"].http.calls
        # GET call has no body
        self.assertEqual(get_call[0], "GET")
        self.assertIsNone(get_call[2])
        # PUT call has the modified step object
        self.assertEqual(put_call[0], "PUT")
        put_body = put_call[2]
        # Body must include name and version from GET
        self.assertEqual(put_body["name"], "step-A")
        self.assertEqual(put_body["version"], "1.0.0")
        # And must have entryCondition set to NEVER
        self.assertEqual(put_body["entryCondition"], operate.NEVER)

    def test_a_row_that_did_not_change_is_a_verdict(self):
        step_obj = {"id": STEP, "name": "step-A", "version": "1.0.0",
                    "entryCondition": 4}
        get_reply = (200, json.dumps(step_obj))
        clients = {"baseapi": FakeApi(replies={"GET": get_reply, "PUT": (204, "")}),
                   "postgres": FakePg([["1"]])}
        result = operate.freeze(FREEZE_ENTRIES, clients, STEP, confirm=True)
        self.assertEqual(result.code, EXIT_VERDICT)
        self.assertIn("entry_condition", result.render())

    def test_freeze_never_claims_dispatching_has_stopped(self):
        """The projection keeps firing until it is replaced, so any wording
        that implies immediate effect is false at the moment it is printed."""
        step_obj = {"id": STEP, "name": "step-A", "version": "1.0.0",
                    "entryCondition": 4}
        get_reply = (200, json.dumps(step_obj))
        clients = {"baseapi": FakeApi(replies={"GET": get_reply, "PUT": (204, "")}),
                   "postgres": FakePg([["5"]])}
        text = operate.freeze(FREEZE_ENTRIES, clients, STEP, confirm=True).render()
        self.assertNotIn("stopped dispatching", text)
        self.assertIn("projection", text)

    def test_without_confirmation_it_refuses(self):
        clients = {"baseapi": FakeApi((204, "")), "postgres": FakePg([])}
        result = operate.freeze(FREEZE_ENTRIES, clients, STEP, confirm=False)
        self.assertEqual(result.code, EXIT_USAGE)
        self.assertEqual(clients["baseapi"].http.calls, [])

    def test_invalid_uuid_is_rejected_before_any_api_call(self):
        clients = {"baseapi": FakeApi((204, "")), "postgres": FakePg([])}
        result = operate.freeze(FREEZE_ENTRIES, clients, "not-a-uuid", confirm=True)
        self.assertEqual(result.code, EXIT_USAGE)
        self.assertEqual(clients["baseapi"].http.calls, [])

    def test_failing_get_does_not_issue_put(self):
        clients = {"baseapi": FakeApi(replies={"GET": (404, "not found"), "PUT": (204, "")}),
                   "postgres": FakePg([])}
        result = operate.freeze(FREEZE_ENTRIES, clients, STEP, confirm=True)
        self.assertEqual(result.code, EXIT_VERDICT)
        self.assertIn("404", result.render())
        # Only the GET call should have been made
        self.assertEqual(len(clients["baseapi"].http.calls), 1)
        self.assertEqual(clients["baseapi"].http.calls[0][0], "GET")


class VerdictTests(unittest.TestCase):
    BASE = {"frozen": False, "parked": [], "wedged": [], "failed": [],
            "completed": False, "running": False, "dispatched": False}

    def obs(self, **kw):
        merged = dict(self.BASE)
        merged.update(kw)
        return merged

    def test_frozen_beats_never_started(self):
        self.assertEqual(operate.resolve_verdict(self.obs(frozen=True))[0],
                         "frozen")

    def test_frozen_beats_wedged(self):
        verdict, _ = operate.resolve_verdict(self.obs(frozen=True, wedged=["s2"]))
        self.assertEqual(verdict, "frozen")

    def test_parked_beats_wedged_and_names_the_step(self):
        verdict, lines = operate.resolve_verdict(
            self.obs(parked=["s1"], wedged=["s2"]))
        self.assertEqual(verdict, "parked-at-s1")
        self.assertTrue(any("dead" in ln for ln in lines))

    def test_wedged_beats_failed(self):
        self.assertEqual(
            operate.resolve_verdict(self.obs(wedged=["s2"], failed=["s3"]))[0],
            "wedged-at-s2")

    def test_failed_beats_completed(self):
        self.assertEqual(
            operate.resolve_verdict(self.obs(failed=["s3"], completed=True))[0],
            "failed-at-s3")

    def test_completed_beats_running(self):
        self.assertEqual(
            operate.resolve_verdict(self.obs(completed=True, running=True))[0],
            "completed")

    def test_running_when_only_steps_are_moving(self):
        self.assertEqual(
            operate.resolve_verdict(self.obs(running=True, dispatched=True))[0],
            "running")

    def test_nothing_at_all_is_never_started(self):
        verdict, lines = operate.resolve_verdict(self.obs())
        self.assertEqual(verdict, "never-started")
        self.assertTrue(any("no dispatch" in ln for ln in lines))

    def test_every_verdict_is_one_of_the_seven(self):
        """The set is closed. A new state must earn its own remedy -- it must
        not be silently folded into a neighbour."""
        flat = {"completed", "running", "frozen", "never-started"}
        prefixes = ("failed-at-", "parked-at-", "wedged-at-")
        for kwargs in ({"frozen": True}, {"parked": ["s"]}, {"wedged": ["s"]},
                       {"failed": ["s"]}, {"completed": True},
                       {"running": True}, {}):
            verdict, lines = operate.resolve_verdict(self.obs(**kwargs))
            self.assertTrue(verdict in flat or verdict.startswith(prefixes),
                            f"{verdict} is outside the closed set")
            self.assertTrue(lines, f"{verdict} carried no evidence")


if __name__ == "__main__":
    unittest.main()
