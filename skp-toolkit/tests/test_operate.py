import json
import unittest

from skp.clients.http import Unreachable
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
    {"id": "redis.Step", "component": "redis", "operation": "read key",
     "detail": "skp:{workflowId}:{stepId}"},
    {"id": "rabbitmq.processor.Work", "component": "rabbitmq", "operation": "list_queues",
     "detail": "processor-{processorId}"},
    {"id": "rabbitmq.processor.Dead", "component": "rabbitmq", "operation": "list_queues",
     "detail": "processor-{processorId}.dead"},
    {"id": "rabbitmq.processor.Post", "component": "rabbitmq", "operation": "list_queues",
     "detail": "processor-{processorId}-post"},
    {"id": "rabbitmq.processor.PostDead", "component": "rabbitmq", "operation": "list_queues",
     "detail": "processor-{processorId}-post.dead"},
    {"id": "elasticsearch.EntryDispatched", "component": "elasticsearch",
     "operation": "search", "detail": "dispatched an entry step"},
    {"id": "elasticsearch.RunningTheStep", "component": "elasticsearch",
     "operation": "search", "detail": "running the step"},
    {"id": "elasticsearch.EntryStepCompleted", "component": "elasticsearch",
     "operation": "search", "detail": "the entry step completed with {Result}"},
    {"id": "elasticsearch.TerminalCompleted", "component": "elasticsearch",
     "operation": "search",
     "detail": ("the terminal step completed with {Result} — "
               "no successor accepts it, the run ends here")},
]


def _detail(entry_id: str) -> str:
    return next(e["detail"] for e in ENTRIES if e["id"] == entry_id)


# The exact literal templates the C# side emits, read off the same ENTRIES
# fixture ``operate.py`` itself now reads by catalog id (C1) -- kept here
# purely as fixture data for building fake ES hits, never as a name
# production code hardcodes.
DISPATCHED_TPL = _detail("elasticsearch.EntryDispatched")
RUNNING_TPL = _detail("elasticsearch.RunningTheStep")
ENTRY_COMPLETED_TPL = _detail("elasticsearch.EntryStepCompleted")
TERMINAL_COMPLETED_TPL = _detail("elasticsearch.TerminalCompleted")

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
                    # I4: a fixture that forgets to script a method used to
                    # get (None, None) back -- a silent lie a caller could
                    # easily mistake for a real "no reply" outcome, deferring
                    # the failure to some unrelated assertion downstream.
                    # Fail loudly, at the call, instead.
                    if method not in outer._replies:
                        raise AssertionError(
                            f"FakeApi has no scripted reply for method {method!r}")
                    return outer._replies[method]
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


class ScriptedPg:
    """A postgres fake that answers differently depending on which query is
    asked, keyed by a substring of the SQL. observe_run issues two distinct
    queries against the same client (entry-condition, then processor
    mapping) and a fixture needs to tell them apart."""

    def __init__(self, by_substring):
        self._by_substring = by_substring

    def rows(self, sql):
        for substring, rows in self._by_substring.items():
            if substring in sql:
                return rows
        return []


class FakeRabbit:
    def __init__(self, queues=()):
        self._queues = list(queues)

    def queues(self):
        return self._queues


class FakeElastic:
    """``search()`` filters records against every ``term`` clause in the
    request -- the same shape ``investigate._es_search`` builds -- and
    against ``prefix`` clauses too (I4: ``investigate._original_format_filter``
    emits a ``prefix`` clause, not ``term``, for any template carrying the
    em-dash the live cluster mangles, e.g. ``TerminalCompleted`` -- ignoring
    it meant a query for one template silently matched every other
    template's records too, since ``{OriginalFormat}`` was the one filter
    that could have told them apart). ``range`` stays ignored -- a fixture
    with no real clock has no business asserting on it."""

    def __init__(self, records=()):
        self.records = list(records)

    def search(self, body):
        filters = body["query"]["bool"]["filter"]
        out = []
        for rec in self.records:
            attrs = rec.get("attributes", {})
            if self._matches(attrs, filters):
                out.append(rec)
        return out

    @staticmethod
    def _matches(attrs, filters):
        for f in filters:
            if "term" in f:
                (field, value), = f["term"].items()
                key = field.split(".", 1)[1]
                if attrs.get(key) != value:
                    return False
            elif "prefix" in f:
                (field, value), = f["prefix"].items()
                key = field.split(".", 1)[1]
                if not str(attrs.get(key, "")).startswith(value):
                    return False
            # "range" clauses are ignored -- no real clock in a fixture.
        return True


def es_hit(template, **attrs):
    """A hit exactly as ``skp.clients.es.Elastic.search`` returns it: already
    unwrapped from ``_source``, matching how ``investigate.py``'s own rungs
    read hits (``hits[0].get("attributes", {})``)."""
    return {"attributes": {"{OriginalFormat}": template, **attrs}}


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
            "completed": False, "running": False, "dispatched": False,
            "unscoped": False}

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

    def test_parked_beats_wedged_and_names_a_processor_not_a_step(self):
        verdict, lines = operate.resolve_verdict(
            self.obs(parked=["p1"], wedged=["p2"]))
        self.assertEqual(verdict, "parked-at-processor-p1")
        self.assertTrue(any("dead" in ln for ln in lines))

    def test_wedged_beats_failed_and_names_a_processor_not_a_step(self):
        verdict, _ = operate.resolve_verdict(
            self.obs(wedged=["p2"], failed=["s3"]))
        self.assertEqual(verdict, "wedged-at-processor-p2")

    def test_failed_beats_completed_and_still_names_a_step(self):
        """Unlike parked/wedged, `failed` is read from the ES StepId
        attribute and genuinely names a step -- it must NOT be renamed to
        `failed-at-processor-...`."""
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

    def test_never_started_names_the_dispatch_when_one_happened(self):
        """A dispatch record inside the window with nothing after it is
        still `never-started` (the set stays closed at seven), but printing
        "no dispatch record" would be a lie -- one exists."""
        verdict, lines = operate.resolve_verdict(self.obs(dispatched=True))
        self.assertEqual(verdict, "never-started")
        self.assertFalse(any("no dispatch" in ln for ln in lines))
        self.assertTrue(any("dispatch record exists" in ln for ln in lines))

    def test_unscoped_appends_an_evidence_line_without_changing_the_verdict(self):
        verdict, lines = operate.resolve_verdict(self.obs(unscoped=True))
        self.assertEqual(verdict, "never-started")
        self.assertTrue(any("could not be attributed" in ln for ln in lines))

    def test_unscoped_note_rides_along_with_a_healthy_verdict_too(self):
        """Even a good-news verdict must not imply the queue check happened
        when it did not -- unscoped is orthogonal to which verdict won."""
        verdict, lines = operate.resolve_verdict(
            self.obs(completed=True, unscoped=True))
        self.assertEqual(verdict, "completed")
        self.assertTrue(any("could not be attributed" in ln for ln in lines))

    def test_every_verdict_is_one_of_the_seven(self):
        """The set is closed. A new state must earn its own remedy -- it must
        not be silently folded into a neighbour."""
        flat = {"completed", "running", "frozen", "never-started"}
        prefixes = ("failed-at-", "parked-at-processor-", "wedged-at-processor-")
        for kwargs in ({"frozen": True}, {"parked": ["p"]}, {"wedged": ["p"]},
                       {"failed": ["s"]}, {"completed": True},
                       {"running": True}, {}):
            verdict, lines = operate.resolve_verdict(self.obs(**kwargs))
            self.assertTrue(verdict in flat or verdict.startswith(prefixes),
                            f"{verdict} is outside the closed set")
            self.assertTrue(lines, f"{verdict} carried no evidence")


PROC_IN = "11111111-1111-1111-1111-111111111111"
PROC_OUT = "22222222-2222-2222-2222-222222222222"


def _healthy_pg():
    """entry_condition not Never (not frozen) and this workflow's one step
    maps to PROC_IN."""
    return ScriptedPg({
        "workflow_entry_steps": [["4"]],
        "processor_id": [[PROC_IN]],
    })


class ObserveRunScopingTests(unittest.TestCase):
    """The regression cover for the unscoped-broker-scan defect: a stuck
    queue belonging to a processor that backs some OTHER workflow must never
    surface as this workflow's verdict, and one that backs THIS workflow
    must."""

    def clients(self, rabbit_queues, pg=None, redis_keys=None):
        return {
            "elasticsearch": FakeElastic([]),
            "redis": FakeRedis({f"skp:{WF}:*": [redis_keys if redis_keys is not None
                                                 else [f"skp:{WF}:{STEP}"]]}),
            "postgres": pg or _healthy_pg(),
            "rabbitmq": FakeRabbit(rabbit_queues),
        }

    def test_a_wedged_processor_outside_the_workflow_is_not_reported(self):
        clients = self.clients([
            {"name": f"processor-{PROC_OUT}", "messages": 5, "consumers": 0},
        ])
        obs = operate.observe_run(ENTRIES, clients, WF)
        self.assertEqual(obs["wedged"], [])
        self.assertEqual(obs["parked"], [])
        self.assertFalse(obs["unscoped"])

    def test_a_wedged_processor_inside_the_workflow_is_reported(self):
        clients = self.clients([
            {"name": f"processor-{PROC_IN}", "messages": 5, "consumers": 0},
        ])
        obs = operate.observe_run(ENTRIES, clients, WF)
        self.assertEqual(obs["wedged"], [PROC_IN])

    def test_a_parked_processor_outside_the_workflow_is_not_reported(self):
        clients = self.clients([
            {"name": f"processor-{PROC_OUT}.dead", "messages": 3, "consumers": 0},
        ])
        obs = operate.observe_run(ENTRIES, clients, WF)
        self.assertEqual(obs["parked"], [])

    def test_a_parked_processor_inside_the_workflow_is_reported(self):
        clients = self.clients([
            {"name": f"processor-{PROC_IN}.dead", "messages": 3, "consumers": 0},
        ])
        obs = operate.observe_run(ENTRIES, clients, WF)
        self.assertEqual(obs["parked"], [PROC_IN])

    def test_a_branch_parked_on_the_post_lane_is_reported(self):
        """The regression this rewrite exists for.

        The old reader split every live queue name on ``.dead`` and took the
        remainder as a processor id, so ``processor-<guid>-post.dead`` yielded
        ``<guid>-post``, matched no row, and was skipped in silence. The verdict
        then fell through to wedged or running -- a different remedy for the
        same condition.
        """
        clients = self.clients([
            {"name": f"processor-{PROC_IN}-post.dead", "messages": 2, "consumers": 0},
        ])
        obs = operate.observe_run(ENTRIES, clients, WF)
        self.assertEqual(obs["parked"], [PROC_IN])
        self.assertEqual(
            obs["parked_queues"][PROC_IN], [f"processor-{PROC_IN}-post.dead"])

    def test_the_post_lane_verdict_names_the_lane_and_the_guard(self):
        """One verdict, because the remedy is the same -- but the evidence has
        to say which lane, since the post lane parks for a reason the work lane
        cannot have."""
        clients = self.clients([
            {"name": f"processor-{PROC_IN}-post.dead", "messages": 2, "consumers": 0},
        ])
        obs = operate.observe_run(ENTRIES, clients, WF)
        verdict, evidence = operate.resolve_verdict(obs)
        self.assertEqual(verdict, f"parked-at-processor-{PROC_IN}")
        body = " ".join(evidence)
        self.assertIn(f"processor-{PROC_IN}-post.dead", body)
        self.assertIn("provenance guard", body)

    def test_a_wedged_post_lane_is_reported(self):
        """The post lane has its own gated consumer, so it can lose its reader
        while the work lane keeps one. Depth with no consumer is wedged
        whichever lane it is."""
        clients = self.clients([
            {"name": f"processor-{PROC_IN}-post", "messages": 4, "consumers": 0},
        ])
        obs = operate.observe_run(ENTRIES, clients, WF)
        self.assertEqual(obs["wedged"], [PROC_IN])

    def test_a_post_lane_outside_the_workflow_is_still_not_reported(self):
        """Scoping survives the extra lanes -- the defect fixed here must not
        reintroduce the unscoped-scan defect this class was written for."""
        clients = self.clients([
            {"name": f"processor-{PROC_OUT}-post.dead", "messages": 3, "consumers": 0},
            {"name": f"processor-{PROC_OUT}-post", "messages": 3, "consumers": 0},
        ])
        obs = operate.observe_run(ENTRIES, clients, WF)
        self.assertEqual(obs["parked"], [])
        self.assertEqual(obs["wedged"], [])

    def test_the_evidence_falls_back_when_the_caller_resolved_no_queues(self):
        """resolve_verdict is called directly by fixtures that carry no
        parked_queues key; it must name both lanes rather than raise."""
        obs = {"frozen": False, "parked": ["p1"], "wedged": [], "failed": [],
               "completed": False, "running": False, "dispatched": False,
               "unscoped": False}
        verdict, evidence = operate.resolve_verdict(obs)
        self.assertEqual(verdict, "parked-at-processor-p1")
        self.assertIn("two dead-letter queues", " ".join(evidence))

    def test_no_l2_projection_is_unscoped_not_a_false_all_clear(self):
        """Empty processor set (no skp:{workflowId}:{stepId} keys) must not
        fall back to an unscoped scan -- parked/wedged stay empty and the
        gap is recorded as `unscoped`, never reported as a clean queue."""
        clients = self.clients(
            [{"name": f"processor-{PROC_IN}", "messages": 9, "consumers": 0}],
            redis_keys=[])
        obs = operate.observe_run(ENTRIES, clients, WF)
        self.assertEqual(obs["wedged"], [])
        self.assertEqual(obs["parked"], [])
        self.assertTrue(obs["unscoped"])


class ObserveRunElasticsearchShapeTests(unittest.TestCase):
    """Elastic.search() already strips `_source` -- these guard against
    observe_run re-wrapping a lookup in a `_source` key that was never
    there, which would silently zero out every ES-derived observation."""

    def test_a_failed_completion_record_is_read(self):
        clients = {
            "elasticsearch": FakeElastic([
                es_hit(ENTRY_COMPLETED_TPL, WorkflowId=WF, Result="Failed",
                       StepId="s9"),
            ]),
            "redis": FakeRedis({f"skp:{WF}:*": [[f"skp:{WF}:{STEP}"]]}),
            "postgres": _healthy_pg(),
            "rabbitmq": FakeRabbit([]),
        }
        obs = operate.observe_run(ENTRIES, clients, WF)
        self.assertEqual(obs["failed"], ["s9"])

    def test_a_dispatch_record_is_read(self):
        clients = {
            "elasticsearch": FakeElastic([
                es_hit(DISPATCHED_TPL, WorkflowId=WF,
                       CorrelationId="c" * 32),
            ]),
            "redis": FakeRedis({f"skp:{WF}:*": [[f"skp:{WF}:{STEP}"]]}),
            "postgres": _healthy_pg(),
            "rabbitmq": FakeRabbit([]),
        }
        obs = operate.observe_run(ENTRIES, clients, WF)
        self.assertTrue(obs["dispatched"])
        # I4: this single dispatch record used to also satisfy the
        # terminal-completed query (the fake ignored {OriginalFormat}
        # entirely), so `completed` came back silently True. It must not.
        self.assertFalse(obs["completed"])

    def test_an_entry_completion_alone_never_sets_completed(self):
        """A regression that would fail if ``elasticsearch.EntryStepCompleted``
        and ``elasticsearch.TerminalCompleted`` were ever swapped in
        ``observe_run``'s catalog lookups: an ordinary (non-terminal) entry
        step completing must never be read as the run having ended -- only a
        genuine terminal record may set ``completed``."""
        clients = {
            "elasticsearch": FakeElastic([
                es_hit(ENTRY_COMPLETED_TPL, WorkflowId=WF, Result="Succeeded",
                       StepId="s1"),
            ]),
            "redis": FakeRedis({f"skp:{WF}:*": [[f"skp:{WF}:{STEP}"]]}),
            "postgres": _healthy_pg(),
            "rabbitmq": FakeRabbit([]),
        }
        obs = operate.observe_run(ENTRIES, clients, WF)
        self.assertFalse(obs["completed"])
        self.assertEqual(obs["failed"], [])

    def test_a_terminal_completion_record_sets_completed(self):
        clients = {
            "elasticsearch": FakeElastic([
                es_hit(TERMINAL_COMPLETED_TPL, WorkflowId=WF, Result="Succeeded",
                       StepId="s1"),
            ]),
            "redis": FakeRedis({f"skp:{WF}:*": [[f"skp:{WF}:{STEP}"]]}),
            "postgres": _healthy_pg(),
            "rabbitmq": FakeRabbit([]),
        }
        obs = operate.observe_run(ENTRIES, clients, WF)
        self.assertTrue(obs["completed"])


class VerifyUsageTests(unittest.TestCase):
    def test_an_invalid_workflow_id_is_a_usage_error_not_a_crash(self):
        result = operate.verify(ENTRIES, {}, "not-a-uuid", "1h")
        self.assertEqual(result.code, EXIT_USAGE)
        self.assertIn("not a UUID", result.render())


class RaisingElastic:
    def search(self, body):
        raise Unreachable("elasticsearch", "no answer")


class RaisingRedis:
    def keys(self, pattern):
        raise Unreachable("redis", "no answer")


class RaisingPostgres:
    def rows(self, sql):
        raise Unreachable("postgres", "no answer")


class RaisingRabbit:
    def queues(self):
        raise Unreachable("rabbitmq", "no answer")


class VerifyUnreachableTests(unittest.TestCase):
    """I2: ``operate verify`` had no transport-failure path at all --
    ``observe_run`` called Postgres, Redis, RabbitMQ and Elasticsearch with
    no exception handling, so a down peripheral produced a Python traceback
    and exit 1 instead of ``EXIT_UNREACHABLE``. One of each peripheral,
    each raising in turn, must come back as a named row, never a crash."""

    def test_elasticsearch_unreachable_is_EXIT_UNREACHABLE(self):
        clients = {"elasticsearch": RaisingElastic(), "redis": FakeRedis({}),
                   "postgres": FakePg([]), "rabbitmq": FakeRabbit([])}
        result = operate.verify(ENTRIES, clients, WF, "1h")
        self.assertEqual(result.code, EXIT_UNREACHABLE)
        self.assertEqual(result.next_command, "skp doctor")

    def test_redis_unreachable_is_EXIT_UNREACHABLE(self):
        clients = {"elasticsearch": FakeElastic([]), "redis": RaisingRedis(),
                   "postgres": FakePg([]), "rabbitmq": FakeRabbit([])}
        result = operate.verify(ENTRIES, clients, WF, "1h")
        self.assertEqual(result.code, EXIT_UNREACHABLE)
        self.assertEqual(result.next_command, "skp doctor")

    def test_postgres_unreachable_is_EXIT_UNREACHABLE(self):
        clients = {"elasticsearch": FakeElastic([]),
                   "redis": FakeRedis({f"skp:{WF}:*": [[f"skp:{WF}:{STEP}"]]}),
                   "postgres": RaisingPostgres(), "rabbitmq": FakeRabbit([])}
        result = operate.verify(ENTRIES, clients, WF, "1h")
        self.assertEqual(result.code, EXIT_UNREACHABLE)
        self.assertEqual(result.next_command, "skp doctor")

    def test_rabbitmq_unreachable_is_EXIT_UNREACHABLE(self):
        clients = {"elasticsearch": FakeElastic([]),
                   "redis": FakeRedis({f"skp:{WF}:*": [[f"skp:{WF}:{STEP}"]]}),
                   "postgres": _healthy_pg(), "rabbitmq": RaisingRabbit()}
        result = operate.verify(ENTRIES, clients, WF, "1h")
        self.assertEqual(result.code, EXIT_UNREACHABLE)
        self.assertEqual(result.next_command, "skp doctor")


if __name__ == "__main__":
    unittest.main()
