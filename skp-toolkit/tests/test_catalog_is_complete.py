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

    def test_the_surface_count_reflects_the_added_cluster_component(self):
        # 97 catalogued surfaces + 7 cluster/api.health surfaces = 104. This
        # is the one fix in the wave that legitimately changes the baseline
        # count, and it should fail loudly if that count ever drifts again.
        with tempfile.TemporaryDirectory() as tmp:
            entries, _ = compile_catalog(SRC, ANNOTATIONS, pathlib.Path(tmp))
        self.assertEqual(len(entries), 104)
