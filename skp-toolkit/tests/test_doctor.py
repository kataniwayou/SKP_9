import json
import pathlib
import tempfile
import unittest

from skp.profile import Profile
from skp.result import EXIT_DRIFT, EXIT_UNREACHABLE
from skp.verbs.doctor import diagnose, run_with, verb_reference_rows

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
        (model / "gates.json").write_text(
            json.dumps(["cycle", "missingStep", "schemaEdge",
                        "payloadConfigSchema", "processorLiveness"]),
            encoding="utf-8")

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

    def test_malformed_lock_json_is_a_named_failure_not_a_crash(self):
        (self.home / "model" / "compile.lock").write_text("{not json", encoding="utf-8")
        rows = {name: (ok, detail) for name, ok, detail in diagnose(self.profile, clients())}
        self.assertFalse(rows["source drift"][0])
        self.assertFalse(rows["generated files"][0])

    def test_malformed_catalog_json_is_a_named_failure_not_a_crash(self):
        (self.home / "model" / "catalog.json").write_text("[{", encoding="utf-8")
        rows = {name: (ok, detail) for name, ok, detail in diagnose(self.profile, clients())}
        self.assertFalse(rows["catalog present"][0])

    def test_a_catalog_that_is_not_a_list_of_dicts_is_a_named_failure(self):
        (self.home / "model" / "catalog.json").write_text('"a string"', encoding="utf-8")
        rows = {name: (ok, detail) for name, ok, detail in diagnose(self.profile, clients())}
        self.assertFalse(rows["catalog present"][0])

    def test_a_vanished_source_root_reports_drift_rather_than_raising(self):
        self.source.unlink()
        rows = {name: (ok, detail) for name, ok, detail in diagnose(self.profile, clients())}
        self.assertFalse(rows["source drift"][0])
        self.assertIn("Queues.cs", rows["source drift"][1])

    def test_only_unreachable_stores_does_not_advise_recompiling(self):
        result = run_with(self.profile, clients(redis=Probeable(False)))
        self.assertNotEqual(result.next_command, "skp init --refresh")
        self.assertTrue(any("this is the system, not the toolkit" in line
                            for line in result.lines))
        self.assertTrue(any("redis" in line for line in result.lines))

    def test_a_reachability_only_failure_is_EXIT_UNREACHABLE_not_EXIT_DRIFT(self):
        # I10: the branch's own text says "this is the system, not the toolkit" --
        # the exit code has to agree, and NEXT: must not loop back into the doctor
        # run that just produced it.
        result = run_with(self.profile, clients(redis=Probeable(False)))
        self.assertEqual(result.code, EXIT_UNREACHABLE)
        self.assertNotEqual(result.next_command, "skp doctor")

    def test_a_toolkit_failure_alongside_a_dead_store_still_gets_the_toolkit_fix(self):
        # Merge-blocking minor: mixed-failure precedence. A toolkit check (source
        # drift, generated files, catalog present) failing alongside a dead store
        # must still recommend the toolkit remedy, not the "this is the system"
        # reachability message -- recompiling is the actionable step either way.
        self.source.write_text("edited", encoding="utf-8")
        result = run_with(self.profile, clients(redis=Probeable(False)))
        self.assertEqual(result.next_command, "skp init --refresh")
        self.assertFalse(any("this is the system, not the toolkit" in line
                             for line in result.lines))

    def test_a_missing_gate_reference_is_a_toolkit_fix_not_a_reachability_outage(self):
        # Regression for the fix-round-1 finding: "gate references" was a new
        # failing check name with no FIXES entry, so run_with's "no entry in
        # FIXES means only reachability failed" assumption silently broke --
        # a bad gates.json rendered as EXIT_UNREACHABLE with "the toolkit
        # checks pass", which is false, and a remedy (skp map --intent
        # observe) that cannot fix a missing reference file.
        (self.home / "model" / "gates.json").write_text(
            json.dumps(["cycle", "brandNewGate"]), encoding="utf-8")
        result = run_with(self.profile, clients())
        self.assertNotEqual(result.code, EXIT_UNREACHABLE)
        self.assertEqual(result.code, EXIT_DRIFT)
        self.assertFalse(any("the toolkit checks pass" in line
                             for line in result.lines))
        self.assertTrue(any("brandNewGate" in line for line in result.lines))


class VerbReferenceRowTests(unittest.TestCase):
    """The sibling of the gate-reference check, for the same reason.

    A gate with no reference file sends the model to READ something that is not
    there; a verb naming no command sends it to RUN something that is not
    there, and the argparse usage error it gets back is indistinguishable from
    the system being broken.
    """

    def row(self, entries):
        rows = verb_reference_rows(entries)
        self.assertEqual(len(rows), 1)
        return rows[0]

    def test_an_invocable_verb_passes(self):
        name, ok, detail = self.row([{"id": "a", "verb": "skp observe queues"}])
        self.assertEqual(name, "verb references")
        self.assertTrue(ok)
        self.assertIn("1 entries", detail)

    def test_a_dangling_verb_fails_and_names_the_entry(self):
        _, ok, detail = self.row([{"id": "prometheus.x", "verb": "skp observe metric"}])
        self.assertFalse(ok)
        self.assertIn("prometheus.x", detail)
        self.assertIn("skp observe metric", detail)

    def test_a_planned_verb_passes_and_is_counted(self):
        """Reported rather than hidden: declaring a verb planned buys silence
        from the exit code and nothing from the output."""
        _, ok, detail = self.row([{"id": "a", "verb": "skp author list --entity steps"}])
        self.assertTrue(ok)
        self.assertIn("1 name a declared planned verb", detail)

    def test_an_entry_with_no_verb_is_not_a_failure(self):
        _, ok, _ = self.row([{"id": "a"}])
        self.assertTrue(ok)

    def test_an_empty_catalog_fails_rather_than_passing_vacuously(self):
        """"Nothing to check" and "everything checked" must not render alike --
        the same ruling gate_reference_rows already makes."""
        _, ok, detail = self.row([])
        self.assertFalse(ok)
        self.assertIn("no catalog entries", detail)

    def test_the_real_annotations_all_resolve(self):
        """The check must pass against what actually ships, or it is a check
        nobody can leave switched on."""
        import json
        entries = []
        root = pathlib.Path(__file__).resolve().parents[1] / "skp" / "annotations"
        for path in sorted(root.glob("*.json")):
            for cid, note in json.loads(path.read_text(encoding="utf-8")).items():
                entries.append({"id": cid, "verb": note.get("verb", "")})
        _, ok, detail = self.row(entries)
        self.assertTrue(ok, detail)
