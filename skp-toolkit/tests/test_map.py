import json
import pathlib
import tempfile
import unittest

from skp.result import EXIT_VERDICT
from skp.verbs.map import by_component, by_intent, by_question, load_catalog, render

ENTRIES = [
    {"id": "redis.Root", "component": "redis", "operation": "read key",
     "detail": "skp:{workflowId}", "intents": ["observe", "investigate"],
     "answers": "whether a workflow is projected right now",
     "never_for": "the definition — that is Postgres", "write_authority": "none",
     "cost": "cheap", "verb": "skp observe projected"},
    {"id": "postgres.Workflows", "component": "postgres",
     "operation": 'SELECT ... FROM "Workflows"', "detail": "Workflows",
     "intents": ["design"], "answers": "which workflows are defined",
     "never_for": "what is running now", "write_authority": "none",
     "cost": "cheap", "verb": "skp author list"},
    {"id": "elasticsearch.StepReturned", "component": "elasticsearch",
     "operation": "search by attributes.{OriginalFormat}",
     "detail": "the step returned after {ElapsedMs}ms", "intents": ["investigate"],
     "answers": "why a run stopped at a given step",
     "never_for": "current state — ES is history", "write_authority": "none",
     "cost": "bounded", "verb": "skp investigate trace"},
]


class QueryTests(unittest.TestCase):
    def test_by_component_selects_one_store(self):
        self.assertEqual([e["id"] for e in by_component(ENTRIES, "redis")], ["redis.Root"])

    def test_by_intent_crosses_components(self):
        found = {e["id"] for e in by_intent(ENTRIES, "investigate")}
        self.assertEqual(found, {"redis.Root", "elasticsearch.StepReturned"})

    def test_by_intent_is_empty_for_an_uncovered_intent(self):
        self.assertEqual(by_intent(ENTRIES, "remediate"), [])

    def test_by_question_ranks_the_matching_answer_first(self):
        ranked = by_question(ENTRIES, "why did a run stop")
        self.assertEqual(ranked[0]["id"], "elasticsearch.StepReturned")

    def test_by_question_returns_nothing_rather_than_a_bad_guess(self):
        self.assertEqual(by_question(ENTRIES, "kubernetes ingress certificate"), [])


class RenderTests(unittest.TestCase):
    def test_render_shows_the_never_for_field(self):
        text = render([ENTRIES[0]])
        self.assertIn("redis.Root", text)
        self.assertIn("NEVER: the definition — that is Postgres", text)
        self.assertIn("skp observe projected", text)


class LoadTests(unittest.TestCase):
    def test_load_reads_the_compiled_catalog(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = pathlib.Path(tmp)
            (home / "model").mkdir()
            (home / "model" / "catalog.json").write_text(
                json.dumps(ENTRIES), encoding="utf-8")
            self.assertEqual(len(load_catalog(home)), 3)
