import json
import pathlib
import tempfile
import unittest

from skp.clients.http import Unreachable
from skp.result import EXIT_OK, EXIT_UNREACHABLE, EXIT_VERDICT
from skp.verbs import investigate
from skp.verbs.investigate import FAIL, PASS, UNKNOWN, CaseFile, Rung

# ---------------------------------------------------------------------
# fakes
# ---------------------------------------------------------------------


class FakeRedis:
    def __init__(self, present_keys=(), values=None, fail=None):
        self.present = set(present_keys)
        self.values = values or {}
        self.fail = fail

    def keys(self, pattern):
        if self.fail:
            raise Unreachable("redis", self.fail)
        return [k for k in self.present if k == pattern]

    def get(self, key):
        if self.fail:
            raise Unreachable("redis", self.fail)
        return self.values.get(key, "")


class FakeElastic:
    """``search()`` filters ``self.records`` against every ``term`` clause in
    the request -- the same shape ``investigate._es_search`` builds -- and
    ignores the ``range`` (time-bound) clause, which a fake clock has no
    business asserting on.
    """

    def __init__(self, records=(), fail=None):
        self.records = list(records)
        self.fail = fail
        self.calls = []

    def search(self, body):
        self.calls.append(body)
        if self.fail:
            raise Unreachable("elasticsearch", self.fail)
        filters = body["query"]["bool"]["filter"]
        out = []
        for rec in self.records:
            attrs = rec.get("attributes", {})
            ok = True
            for f in filters:
                if "term" not in f:
                    continue
                (field, value), = f["term"].items()
                key = field.split(".", 1)[1]
                if attrs.get(key) != value:
                    ok = False
                    break
            if ok:
                out.append(rec)
        return out


class FakeRabbit:
    def __init__(self, queues=(), fail=None):
        self._queues = list(queues)
        self.fail = fail

    def queues(self):
        if self.fail:
            raise Unreachable("rabbitmq", self.fail)
        return self._queues


def rec(template, **attrs):
    return {"attributes": {"{OriginalFormat}": template, **attrs}}


def clients(redis=None, es=None, rabbit=None):
    return {"redis": redis or FakeRedis(), "elasticsearch": es or FakeElastic(),
            "rabbitmq": rabbit or FakeRabbit()}


def load_real_entries():
    import skp.compile.driver as driver
    with tempfile.TemporaryDirectory() as tmp:
        entries, problems = driver.compile_catalog(
            pathlib.Path(__file__).resolve().parent.parent.parent / "src",
            pathlib.Path(__file__).resolve().parent.parent / "skp" / "annotations",
            pathlib.Path(tmp))
        assert not problems, problems
        return [e.to_dict() for e in entries]


ENTRIES = load_real_entries()


# ---------------------------------------------------------------------
# the ladder
# ---------------------------------------------------------------------


class OriginalFormatFilterTests(unittest.TestCase):
    """The live cluster mangles the em dash in a handful of templates
    (TerminalCompleted among them) past Elasticsearch's own ingestion --
    an exact ``term`` match built from the catalog's clean template text
    would silently match nothing on a real terminal record."""

    def test_a_template_without_an_em_dash_is_an_exact_term(self):
        f = investigate._original_format_filter("running the step")
        self.assertEqual(f, {"term": {"attributes.{OriginalFormat}": "running the step"}})

    def test_a_template_with_an_em_dash_is_a_prefix_up_to_it(self):
        template = ("the terminal step completed with {Result} — no successor "
                    "accepts it, the run ends here")
        f = investigate._original_format_filter(template)
        self.assertEqual(f, {"prefix": {"attributes.{OriginalFormat}":
                                        "the terminal step completed with {Result} "}})


class LadderCompletionTests(unittest.TestCase):
    def test_a_run_that_passes_every_rung_has_no_boundary(self):
        wf, corr, step, entry, proc = "wf-1", "corr1", "step-1", "entry-1", "proc-1"
        es = FakeElastic(records=[
            rec("dispatched an entry step", WorkflowId=wf, CorrelationId=corr,
                StepId=step, EntryId=entry, ProcessorId=proc),
            rec("running the step", CorrelationId=corr, StepId=step),
            rec("the step returned after {ElapsedMs}ms", CorrelationId=corr, StepId=step),
            rec("branch completed in {ElapsedMs}ms", CorrelationId=corr, StepId=step, EntryId=entry),
            rec("the entry step completed with {Result}", CorrelationId=corr),
            rec("advanced {SuccessorCount} successor(s) in {ElapsedMs}ms", CorrelationId=corr),
            rec("the terminal step completed with {Result} — no successor accepts it, "
                "the run ends here", CorrelationId=corr),
        ])
        rabbit = FakeRabbit(queues=[{"name": f"processor-{proc}", "messages": 0, "consumers": 1},
                                    {"name": "orchestrator-result", "messages": 0, "consumers": 3}])
        redis = FakeRedis(present_keys={f"skp:{wf}"})

        rungs = investigate.run_ladder(ENTRIES, clients(redis, es, rabbit), wf, "24h",
                                       correlation_id=corr)
        boundary, message, code = investigate.boundary_and_verdict(rungs)

        self.assertIsNone(boundary)
        self.assertEqual(code, EXIT_OK)
        self.assertTrue(all(r.verdict == PASS for r in rungs))

    def test_a_run_not_even_projected_stops_at_rung_one(self):
        rungs = investigate.run_ladder(ENTRIES, clients(), "wf-ghost", "24h")
        boundary, message, code = investigate.boundary_and_verdict(rungs)
        self.assertEqual(rungs[0].verdict, FAIL)
        self.assertEqual(boundary, (None, 1))
        self.assertEqual(code, EXIT_VERDICT)


class LadderBoundaryTests(unittest.TestCase):
    """A middle rung failing is the whole point of the ladder: the boundary
    must name the LAST rung that passed and the FIRST that failed, not just
    "something is wrong somewhere".
    """

    def test_present_at_five_absent_at_six_is_a_named_boundary(self):
        wf, corr, step, entry = "wf-1", "corr1", "step-1", "entry-1"
        es = FakeElastic(records=[
            rec("dispatched an entry step", WorkflowId=wf, CorrelationId=corr,
                StepId=step, EntryId=entry, ProcessorId="proc-1"),
            rec("running the step", CorrelationId=corr, StepId=step),
            rec("the step returned after {ElapsedMs}ms", CorrelationId=corr, StepId=step),
            # no "branch completed" record -- the author returned without sending
        ])
        redis = FakeRedis(present_keys={f"skp:{wf}"})
        rabbit = FakeRabbit(queues=[{"name": "processor-proc-1", "messages": 0, "consumers": 1}])

        rungs = investigate.run_ladder(ENTRIES, clients(redis, es, rabbit), wf, "24h",
                                       correlation_id=corr)
        boundary, message, code = investigate.boundary_and_verdict(rungs)

        self.assertEqual(boundary, (5, 6))
        self.assertEqual(code, EXIT_VERDICT)
        self.assertIn("returned without sending", message)
        # rungs past the boundary are still evaluated and reported, not hidden
        self.assertEqual(rungs[6].number, 7)

    def test_zero_consumers_at_three_is_named_as_no_ready_replica(self):
        wf, corr = "wf-1", "corr1"
        es = FakeElastic(records=[
            rec("dispatched an entry step", WorkflowId=wf, CorrelationId=corr,
                StepId="step-1", EntryId="entry-1", ProcessorId="proc-1"),
            # no "running the step" -- nobody consumed it
        ])
        redis = FakeRedis(present_keys={f"skp:{wf}"})
        rabbit = FakeRabbit(queues=[{"name": "processor-proc-1", "messages": 3, "consumers": 0}])

        rungs = investigate.run_ladder(ENTRIES, clients(redis, es, rabbit), wf, "24h",
                                       correlation_id=corr)
        boundary, message, code = investigate.boundary_and_verdict(rungs)

        self.assertEqual(boundary, (3, 4))
        self.assertEqual(code, EXIT_VERDICT)
        self.assertIn("no ready replica", message)
        self.assertIn("zero consumers", rungs[2].evidence)

    def test_a_boundary_with_no_canned_rule_still_reports_evidence(self):
        wf, corr = "wf-1", "corr1"
        es = FakeElastic(records=[])  # rung 2 fails outright: no dispatch at all
        redis = FakeRedis(present_keys={f"skp:{wf}"})  # but rung 1 passed

        rungs = investigate.run_ladder(ENTRIES, clients(redis, es), wf, "24h", correlation_id=corr)
        boundary, message, code = investigate.boundary_and_verdict(rungs)

        self.assertEqual(boundary, (1, 2))
        self.assertEqual(code, EXIT_VERDICT)
        self.assertIn("no rule for this transition", message)
        self.assertIn(rungs[1].evidence, message)


class LadderUnreachableTests(unittest.TestCase):
    """The one hard requirement from the brief: an unreachable store must
    yield "cannot determine", never a false PASS or FAIL."""

    def test_an_unreachable_store_is_unknown_not_a_false_verdict(self):
        wf = "wf-1"
        redis = FakeRedis(fail="connection refused")
        rungs = investigate.run_ladder(ENTRIES, clients(redis), wf, "24h")
        self.assertEqual(rungs[0].verdict, UNKNOWN)
        self.assertIn("unreachable", rungs[0].evidence)

        boundary, message, code = investigate.boundary_and_verdict(rungs)
        self.assertEqual(code, EXIT_UNREACHABLE)
        self.assertIn("cannot determine", message)

    def test_a_missing_processor_id_is_unknown_not_a_false_fail(self):
        # rung 2 fails cleanly (no dispatch at all) -- rung 3 has no ProcessorId
        # to check a queue against, and that is a different situation from a
        # queue that was checked and found missing.
        wf = "wf-1"
        redis = FakeRedis(present_keys={f"skp:{wf}"})
        es = FakeElastic(records=[])
        rungs = investigate.run_ladder(ENTRIES, clients(redis, es), wf, "24h")
        self.assertEqual(rungs[1].verdict, FAIL)   # rung 2: no fire
        self.assertEqual(rungs[2].verdict, UNKNOWN)  # rung 3: cannot determine
        self.assertIn("cannot determine", rungs[2].evidence)

    def test_a_processor_override_lets_the_ladder_continue_past_a_dead_rung_two(self):
        wf = "wf-1"
        redis = FakeRedis(present_keys={f"skp:{wf}"})
        es = FakeElastic(records=[])
        rabbit = FakeRabbit(queues=[{"name": "processor-proc-x", "messages": 0, "consumers": 1}])
        rungs = investigate.run_ladder(ENTRIES, clients(redis, es, rabbit), wf, "24h",
                                       processor_override="proc-x")
        self.assertEqual(rungs[2].verdict, PASS)
        self.assertIn("processor-proc-x", rungs[2].evidence)


# ---------------------------------------------------------------------
# case file
# ---------------------------------------------------------------------


class CaseFileTests(unittest.TestCase):
    def test_findings_are_on_disk_after_every_rung_not_only_at_the_end(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "case.json"
            case = CaseFile(path, "wf-1", None)
            case.record(Rung(1, "is it projected?", PASS, "present"))

            # Read back mid-investigation: a crash right here must not lose rung 1.
            on_disk = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(len(on_disk["rungs"]), 1)
            self.assertEqual(on_disk["rungs"][0]["verdict"], "PASS")

            case.record(Rung(2, "did a fire happen?", FAIL, "no dispatch"))
            case.finish((1, 2), "no rule for this transition", EXIT_VERDICT)

            on_disk = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(len(on_disk["rungs"]), 2)
            self.assertEqual(on_disk["boundary"], [1, 2])
            self.assertEqual(on_disk["exit_code"], EXIT_VERDICT)

    def test_trace_writes_a_case_file_under_the_home_cases_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = pathlib.Path(tmp)
            redis = FakeRedis()  # workflow not projected
            result = investigate.trace(ENTRIES, clients(redis), home, "wf-missing")
            self.assertEqual(result.code, EXIT_VERDICT)
            cases = list((home / "cases").glob("wf-missing-*.json"))
            self.assertEqual(len(cases), 1)
            data = json.loads(cases[0].read_text(encoding="utf-8"))
            self.assertEqual(data["workflow_id"], "wf-missing")
            self.assertEqual(len(data["rungs"]), 9)


if __name__ == "__main__":
    unittest.main()
