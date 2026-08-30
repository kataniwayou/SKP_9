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
        with tempfile.TemporaryDirectory() as tmp:
            entries, _ = compile_catalog(SRC, ANNOTATIONS, pathlib.Path(tmp))
        self.assertEqual(
            {e.component for e in entries},
            {"api", "postgres", "redis", "rabbitmq", "elasticsearch", "prometheus"})
