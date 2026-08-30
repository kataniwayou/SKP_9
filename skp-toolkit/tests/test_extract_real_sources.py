import pathlib
import unittest

from skp.compile.extract import queues, redis_keys, templates

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
