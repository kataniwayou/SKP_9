import json
import pathlib
import tempfile
import unittest
import unittest.mock as mock

from skp.compile.driver import collect_surfaces, compile_catalog
from skp.compile.lock import MISSING, stale_sources
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
            # I6: "cluster" is always present -- cluster_operations() does not
            # read source_root at all, so it appears even for this fixture tree.
            self.assertEqual(components,
                             {"redis", "rabbitmq", "elasticsearch",
                              "postgres", "prometheus", "api", "cluster"})

    def test_cluster_operations_do_not_depend_on_source_root(self):
        from skp.compile.driver import cluster_operations
        ids = {s.id for s in cluster_operations()}
        self.assertEqual(ids, {
            "cluster.get_pods", "cluster.logs", "cluster.rollout_status",
            "cluster.get_json", "api.health.ready", "api.health.live",
            "api.health.startup"})


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


class ApiVersionTrackingTests(unittest.TestCase):
    """Trivial one-liner: extract.API_PREFIX is hardcoded to "/api/v1.0" while
    the real version lives in [ApiVersion("1.0")] on BaseController.cs, which
    was not in _source_paths at all. Tracked at minimum, so an edit to that
    file (a version bump, realistically) registers as source drift instead of
    the hardcoded prefix silently going stale with no signal anywhere."""

    def test_base_controller_cs_is_tracked_and_an_edit_is_drift(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            src = fake_source_root(root)
            api_version_path = src / "BaseApi.Core" / "Controllers" / "BaseController.cs"
            api_version_path.parent.mkdir(parents=True, exist_ok=True)
            api_version_path.write_text('[ApiVersion("1.0")]', encoding="utf-8")

            notes = root / "annotations"
            notes.mkdir()
            (notes / "empty.json").write_text("{}", encoding="utf-8")
            out = root / "model"
            compile_catalog(src, notes, out)
            lock = json.loads((out / "compile.lock").read_text(encoding="utf-8"))
            self.assertIn("BaseApi.Core/Controllers/BaseController.cs", lock["sources"])

            api_version_path.write_text('[ApiVersion("2.0")]', encoding="utf-8")
            self.assertIn("BaseApi.Core/Controllers/BaseController.cs",
                          stale_sources(lock, src))


class NewFileDriftTests(unittest.TestCase):
    """I8: stale_sources used to walk only paths the lock already knew, so a
    newly *added* controller (or *Metrics.cs) file was undetectable -- the
    catalog lacks its surfaces and doctor reports "in step with source"."""

    def test_adding_a_controller_file_registers_as_drift(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            src = fake_source_root(root)
            # fake_source_root omits BaseController.cs (see ApiVersionTrackingTests);
            # create it so the lock's SOURCE_MAP entries are all present, and the
            # "fresh lock reports nothing" assertion below tests a genuinely clean
            # state rather than tripping over an unrelated MISSING fixed path (C2).
            api_version_path = src / "BaseApi.Core" / "Controllers" / "BaseController.cs"
            api_version_path.parent.mkdir(parents=True, exist_ok=True)
            api_version_path.write_text('[ApiVersion("1.0")]', encoding="utf-8")
            notes = root / "annotations"
            notes.mkdir()
            (notes / "empty.json").write_text("{}", encoding="utf-8")
            out = root / "model"
            compile_catalog(src, notes, out)
            lock = json.loads((out / "compile.lock").read_text(encoding="utf-8"))

            self.assertEqual(stale_sources(lock, src), [])

            new_controller = src / "BaseApi.Service" / "Features" / "Extra" / "ExtraController.cs"
            new_controller.parent.mkdir(parents=True, exist_ok=True)
            new_controller.write_text(
                "public sealed class ExtraController : ControllerBase { }",
                encoding="utf-8")

            self.assertNotEqual(stale_sources(lock, src), [])


class RenameDriftTests(unittest.TestCase):
    """C2: renaming a SOURCE_MAP fixed path left both the stored and the
    current hash as MISSING, so ``_changed`` saw them as equal and
    ``stale_sources`` reported [] -- doctor's "source drift" row read "in
    step with source" while the catalog was missing everything that file's
    extractor produced."""

    def test_a_renamed_source_is_drift_after_recompile(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            src = fake_source_root(root)
            api_version_path = src / "BaseApi.Core" / "Controllers" / "BaseController.cs"
            api_version_path.parent.mkdir(parents=True, exist_ok=True)
            api_version_path.write_text('[ApiVersion("1.0")]', encoding="utf-8")

            notes = root / "annotations"
            notes.mkdir()
            (notes / "empty.json").write_text("{}", encoding="utf-8")
            out = root / "model"

            compile_catalog(src, notes, out)

            templates_path = (src / "tests" / "BaseApi.Tests" / "Live" /
                              "Resilience" / "Templates.cs")
            templates_path.rename(templates_path.parent / "TemplatesRenamed.cs")

            # Recompile against the renamed tree: the new lock records MISSING
            # for the old SOURCE_MAP path, same as the filesystem now shows.
            compile_catalog(src, notes, out)
            lock = json.loads((out / "compile.lock").read_text(encoding="utf-8"))

            stale = stale_sources(lock, src)
            self.assertIn("tests/BaseApi.Tests/Live/Resilience/Templates.cs", stale)


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


_ALL_FIXTURE_IDS = [
    "redis.Root", "rabbitmq.processor.IdentityQuery", "rabbitmq.orchestrator.Control",
    "elasticsearch.RunningTheStep", "postgres.Schemas", "prometheus.pipeline_queue_depth",
    "api.workflows.get", "api.workflows.get_id", "api.workflows.post",
    "api.workflows.put_id", "api.workflows.delete_id",
]
_NOTE = {"intents": ["observe"], "answers": "x", "never_for": "y",
         "write_authority": "none", "cost": "cheap", "verb": "skp map"}


class RenameDriftTests(unittest.TestCase):
    """C2: renaming a source file must not make its component vanish quietly."""

    def test_renaming_a_source_file_orphans_its_annotations(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            src = fake_source_root(root)
            notes = root / "annotations"
            notes.mkdir()
            (notes / "all.json").write_text(
                json.dumps({i: _NOTE for i in _ALL_FIXTURE_IDS}), encoding="utf-8")
            out = root / "model"

            _, problems_before = compile_catalog(src, notes, out)
            self.assertFalse(
                any("RunningTheStep" in p for p in problems_before), problems_before)

            templates_path = src / "tests/BaseApi.Tests/Live/Resilience/Templates.cs"
            templates_path.rename(templates_path.with_name("LogTemplates.cs"))

            _, problems_after = compile_catalog(src, notes, out)
            self.assertTrue(
                any("elasticsearch.RunningTheStep" in p
                    and "annotated but not discovered" in p
                    for p in problems_after), problems_after)


class MissingFixedPathTests(unittest.TestCase):
    """C2: a missing SOURCE_MAP path is a named compile problem and a MISSING
    lock entry, not an empty string quietly fed to an extractor."""

    def test_a_missing_source_map_path_is_reported_by_name(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            src = fake_source_root(root)
            (src / "BaseApi.Service" / "AppDbContext.cs").unlink()
            notes = root / "annotations"
            notes.mkdir()
            (notes / "empty.json").write_text("{}", encoding="utf-8")
            out = root / "model"

            _, problems = compile_catalog(src, notes, out)
            self.assertTrue(
                any("BaseApi.Service/AppDbContext.cs" in p for p in problems), problems)

            lock = json.loads((out / "compile.lock").read_text(encoding="utf-8"))
            self.assertEqual(lock["sources"]["BaseApi.Service/AppDbContext.cs"], MISSING)
