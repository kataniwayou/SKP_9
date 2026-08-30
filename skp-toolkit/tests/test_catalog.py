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

    def test_two_surfaces_sharing_an_id_is_a_failure(self):
        annotations = self.all_intents()
        collided = [*SURFACES, Surface("redis", "redis.Root", "read key", "other-value")]
        problems = check(build(collided, annotations), collided, annotations)
        self.assertTrue(any("redis.Root" in p and "duplicate" in p.lower() for p in problems))


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
