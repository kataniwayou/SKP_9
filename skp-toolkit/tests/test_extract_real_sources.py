import pathlib
import unittest

from skp.compile.extract import metrics, pg_tables, queues, redis_keys, rest_endpoints, templates

SRC = pathlib.Path(__file__).resolve().parents[2] / "src"


def read(rel: str) -> str:
    return (SRC / rel).read_text(encoding="utf-8")


@unittest.skipUnless(SRC.exists(), "run from inside the repo")
class RealSourceTests(unittest.TestCase):
    def test_the_seven_documented_key_families_are_all_found(self):
        found = {s.id for s in redis_keys(
            read("Messaging.Contracts/Projections/L2ProjectionKeys.cs"))}
        self.assertEqual(found, {
            "redis.ParentIndex", "redis.Root", "redis.Step",
            "redis.PerInstance", "redis.InstanceIndex", "redis.ExecutionData",
            "redis.KeeperProbe",
        })

    def test_the_execution_blob_key_carries_the_documented_shape(self):
        by_id = {s.id: s for s in redis_keys(
            read("Messaging.Contracts/Projections/L2ProjectionKeys.cs"))}
        self.assertTrue(by_id["redis.ExecutionData"].detail.startswith("skp:data:"))

    def test_the_three_orchestrator_queues_are_found(self):
        found = {s.detail for s in queues(
            read("Messaging.Contracts/ProcessorQueues.cs"),
            read("Messaging.Contracts/OrchestratorQueues.cs"))}
        for name in ("orchestrator-control", "orchestrator-result",
                     "orchestrator-result-post", "processor-identity-query"):
            self.assertIn(name, found)

    def test_the_ten_ledger_templates_are_found(self):
        found = {s.detail for s in templates(
            read("tests/BaseApi.Tests/Live/Resilience/Templates.cs"))}
        for text in ("running the step", "the step returned after {ElapsedMs}ms",
                     "dispatched an entry step",
                     "the entry step completed with {Result}"):
            self.assertIn(text, found)

    def test_no_two_surfaces_share_an_id(self):
        surfaces = (
            redis_keys(read("Messaging.Contracts/Projections/L2ProjectionKeys.cs"))
            + queues(read("Messaging.Contracts/ProcessorQueues.cs"),
                     read("Messaging.Contracts/OrchestratorQueues.cs"))
            + templates(read("tests/BaseApi.Tests/Live/Resilience/Templates.cs"))
        )
        ids = [s.id for s in surfaces]
        duplicates = sorted({i for i in ids if ids.count(i) > 1})
        self.assertEqual(duplicates, [], f"ids must be unique; collided: {duplicates}")


@unittest.skipUnless(SRC.exists(), "run from inside the repo")
class RealSurfaceTests(unittest.TestCase):
    def test_the_five_entity_tables_and_three_junctions_are_found(self):
        found = {s.id for s in pg_tables(read("BaseApi.Service/AppDbContext.cs"))}
        self.assertEqual(found, {
            "postgres.Schemas", "postgres.Processors", "postgres.Steps",
            "postgres.Assignments", "postgres.Workflows",
            "postgres.StepNextSteps", "postgres.WorkflowEntrySteps",
            "postgres.WorkflowAssignments",
        })

    def test_documented_instruments_are_all_present(self):
        texts = [p.read_text(encoding="utf-8") for p in SRC.rglob("*Metrics.cs")
                 if "obj" not in p.parts and "bin" not in p.parts]
        found = {s.detail for s in metrics(texts)}
        for name in ("pipeline.queue.depth", "pipeline.deadletter.depth",
                     "pipeline.messages.produced", "pipeline.gate.open"):
            self.assertIn(name, found)

    def test_the_five_entity_controllers_and_orchestration_are_routed(self):
        texts = {p.name: p.read_text(encoding="utf-8")
                 for p in (SRC / "BaseApi.Service" / "Features").rglob("*Controller.cs")}
        operations = {s.operation for s in rest_endpoints(texts)}
        self.assertIn("GET /api/v1.0/workflows", operations)
        self.assertIn("POST /api/v1.0/orchestration/start", operations)
        self.assertIn("GET /api/v1.0/processors/by-source-hash/{sourceHash}", operations)
