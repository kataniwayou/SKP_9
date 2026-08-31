import pathlib
import tempfile
import unittest

from skp.compile.driver import compile_catalog

REPO = pathlib.Path(__file__).resolve().parents[2]
SRC = REPO / "src"
ANNOTATIONS = REPO / "skp-toolkit" / "skp" / "annotations"


@unittest.skipUnless(SRC.exists(), "run from inside the repo")
class CompletenessTests(unittest.TestCase):
    def test_the_real_sources_compile_with_no_problems(self):
        with tempfile.TemporaryDirectory() as tmp:
            _, problems = compile_catalog(SRC, ANNOTATIONS, pathlib.Path(tmp))
        self.assertEqual(problems, [], "\n".join(problems))

    def test_every_component_is_represented(self):
        # I6: all seven components from spec §6.3, including "cluster" --
        # annotation-only, since there is no C# to extract it from (see
        # driver.cluster_operations()). This assertion used to pin the
        # six-component set as if cluster's absence were correct; it was the
        # one test positioned to catch that gap, and it was ratifying it.
        with tempfile.TemporaryDirectory() as tmp:
            entries, _ = compile_catalog(SRC, ANNOTATIONS, pathlib.Path(tmp))
        self.assertEqual(
            {e.component for e in entries},
            {"api", "cluster", "postgres", "redis", "rabbitmq", "elasticsearch", "prometheus"})

    def test_the_surface_count_reflects_the_added_dimensions(self):
        # 104 baseline + 3 prometheus.label.* resource surfaces + 23
        # elasticsearch.attr.* surfaces (12 message-scoped placeholders, 5
        # ExecutionLogScope dispatch-scope ids, 1 CorrelationId, 5 hand-listed
        # envelope fields) = 130. The 16 existing prometheus.pipeline_* ids
        # are unchanged by the dimensions wave -- it adds labels to their
        # `detail`, not new surfaces.
        #
        # Fix round (I5) adds two more hand-listed envelope fields --
        # elasticsearch.attr.service_instance_id and .source -- closing the
        # per-replica gap attr.service_name's own never_for pointed at with no
        # surface to land on. 130 + 2 = 132. The role fix (C1, orchestrator
        # wave) is not a count change: PipelineAmbientTag.AppendTo adds a
        # label to five existing prometheus.pipeline_* surfaces' `detail`,
        # the same shape as the original wave's label additions, not a new
        # id.
        #
        # Live-fixes round: I1 adds three more hand-listed prometheus.label.*
        # surfaces -- le, service_version, source -- 132 + 3 = 135. C2
        # catalogues the Elasticsearch index name itself as a new surface,
        # elasticsearch.index -- 135 + 1 = 136. C1 (the snake_case fix) is
        # not a count change: it corrects the eight existing postgres.* ids'
        # casing, it does not add or remove any.
        #
        # Verification round: L2ProjectionKeys.KeeperProbe was deleted from the
        # C# as dead code -- it had no call site anywhere in src/, so nothing
        # ever wrote the key and no observer could ever catch it. The surface
        # goes with the code that declared it. 136 - 1 = 135.
        with tempfile.TemporaryDirectory() as tmp:
            entries, _ = compile_catalog(SRC, ANNOTATIONS, pathlib.Path(tmp))
        self.assertEqual(len(entries), 135)
