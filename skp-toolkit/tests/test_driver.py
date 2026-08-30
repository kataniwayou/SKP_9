import json
import pathlib
import tempfile
import unittest
import unittest.mock as mock

from skp.compile.driver import collect_surfaces, compile_catalog
from skp.result import EXIT_DRIFT
from skp.verbs.init import run as init_run

L2 = '''
public static class L2ProjectionKeys
{
    public const string Prefix = "skp:";
    public static string Root(Guid workflowId) => $"{Prefix}{workflowId:D}";
}
'''
PQ = 'public static class ProcessorQueues { public const string IdentityQuery = "processor-identity-query"; }'
OQ = 'public static class OrchestratorQueues { public const string Control = "orchestrator-control"; }'
TPL = 'internal static class Templates { public const string RunningTheStep = "running the step"; }'
DBC = 'public DbSet<SchemaEntity> Schemas => Set<SchemaEntity>();'
MET = 'internal const string DepthInstrument = "pipeline.queue.depth";'
CTL = '''
public sealed class WorkflowsController :
    BaseController<WorkflowEntity, WorkflowCreateDto, WorkflowUpdateDto, WorkflowReadDto> { }
'''


def fake_source_root(root: pathlib.Path) -> pathlib.Path:
    src = root / "src"
    files = {
        "Messaging.Contracts/Projections/L2ProjectionKeys.cs": L2,
        "Messaging.Contracts/ProcessorQueues.cs": PQ,
        "Messaging.Contracts/OrchestratorQueues.cs": OQ,
        "tests/BaseApi.Tests/Live/Resilience/Templates.cs": TPL,
        "BaseApi.Service/AppDbContext.cs": DBC,
        "Messaging.Transport/QueueDepthMetrics.cs": MET,
        "BaseApi.Service/Features/Workflow/WorkflowController.cs": CTL,
    }
    for rel, text in files.items():
        path = src / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    return src


class CollectTests(unittest.TestCase):
    def test_surfaces_are_collected_from_every_component(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = fake_source_root(pathlib.Path(tmp))
            components = {s.component for s in collect_surfaces(src)}
            self.assertEqual(components,
                             {"redis", "rabbitmq", "elasticsearch",
                              "postgres", "prometheus", "api"})


class CompileTests(unittest.TestCase):
    def test_missing_annotations_are_reported_and_named(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            src = fake_source_root(root)
            notes = root / "annotations"
            notes.mkdir()
            (notes / "empty.json").write_text("{}", encoding="utf-8")
            out = root / "model"
            _, problems = compile_catalog(src, notes, out)
            self.assertTrue(any("redis.Root" in p for p in problems))

    def test_the_catalog_and_lock_are_written_even_when_checks_fail(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            src = fake_source_root(root)
            notes = root / "annotations"
            notes.mkdir()
            (notes / "empty.json").write_text("{}", encoding="utf-8")
            out = root / "model"
            compile_catalog(src, notes, out)
            catalog = json.loads((out / "catalog.json").read_text(encoding="utf-8"))
            self.assertTrue(any(e["id"] == "redis.Root" for e in catalog))
            self.assertIn("sources", json.loads(
                (out / "compile.lock").read_text(encoding="utf-8")))

    def test_lock_records_both_the_sources_and_the_generated_catalog(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            src = fake_source_root(root)
            notes = root / "annotations"
            notes.mkdir()
            (notes / "empty.json").write_text("{}", encoding="utf-8")
            out = root / "model"
            compile_catalog(src, notes, out)
            lock = json.loads((out / "compile.lock").read_text(encoding="utf-8"))
            self.assertIn("Messaging.Contracts/ProcessorQueues.cs", lock["sources"])
            self.assertIn("catalog.json", lock["generated"])


class CatalogErrorTests(unittest.TestCase):
    def test_contradictory_annotations_return_a_result_not_a_traceback(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            src = fake_source_root(root)
            notes = root / "annotations"
            notes.mkdir()
            entry = {"intents": ["observe"], "answers": "x", "never_for": "y",
                     "write_authority": "none", "cost": "cheap", "verb": "skp map"}
            (notes / "a.json").write_text(json.dumps({"redis.Root": entry}), encoding="utf-8")
            (notes / "b.json").write_text(json.dumps({"redis.Root": entry}), encoding="utf-8")

            home = root / ".skp"
            with mock.patch("skp.verbs.init.ANNOTATIONS_DIR", notes):
                result = init_run([
                    "--home", str(home),
                    "--source-root", str(src),
                    "--cluster-url", "https://cluster.invalid",
                    "--project", "skp",
                ])

        self.assertEqual(result.code, EXIT_DRIFT)
        self.assertEqual(result.next_command, "skp doctor")
        self.assertTrue(any("redis.Root" in line for line in result.lines))
        self.assertTrue(any("a.json" in line for line in result.lines))
