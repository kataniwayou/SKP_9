import json
import pathlib
import tempfile
import unittest

from skp.compile import extract
from skp.compile.driver import compile_catalog

SRC = pathlib.Path(__file__).resolve().parents[2] / "src"
ANNOTATIONS = pathlib.Path(__file__).resolve().parents[1] / "skp" / "annotations"
GATE_FILE = ("BaseApi.Service/Features/Orchestration/"
             "OrchestrationValidationException.cs")


class GateExtractionTests(unittest.TestCase):
    def test_the_factories_are_found_in_declaration_order(self):
        text = """
        public static OrchestrationValidationException Cycle(x y)
            => new(
                "cycle",
                "Workflow contains a cycle",
                $"detail", new CycleOffending(y));

        public static OrchestrationValidationException MissingStep(x y)
            => new(
                "missingStep",
                "Workflow references a missing step",
                $"detail", new MissingStepOffending(y));
        """
        self.assertEqual(extract.gates(text), ["cycle", "missingStep"])

    def test_a_title_is_not_mistaken_for_a_discriminator(self):
        """Only the FIRST argument of a `=> new(` factory counts. Titles and
        details are quoted strings too, and a looser match would catalogue
        prose as a gate -- doctor would then demand a reference file for
        'Workflow contains a cycle'."""
        text = '''
        public static OrchestrationValidationException Cycle(x)
            => new(
                "cycle",
                "Workflow contains a cycle",
                $"A cycle was detected", new CycleOffending(x));
        '''
        self.assertEqual(extract.gates(text), ["cycle"])

    def test_a_commented_out_factory_is_not_a_gate(self):
        text = '''
        // => new("ghost", "Ghost", $"d", new X());
        public static OrchestrationValidationException Cycle(x)
            => new("cycle", "Workflow contains a cycle", $"d", new X());
        '''
        self.assertEqual(extract.gates(text), ["cycle"])


@unittest.skipUnless(SRC.exists(), "run from inside the repo")
class RealGateSourceTests(unittest.TestCase):
    def test_the_live_source_yields_exactly_the_five_documented_gates(self):
        text = (SRC / GATE_FILE).read_text(encoding="utf-8")
        self.assertEqual(
            extract.gates(text),
            ["cycle", "missingStep", "schemaEdge",
             "payloadConfigSchema", "processorLiveness"])

    def test_compile_writes_gates_json_beside_the_catalog(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = pathlib.Path(tmp)
            compile_catalog(SRC, ANNOTATIONS, out)
            written = json.loads((out / "gates.json").read_text(encoding="utf-8"))
        self.assertEqual(written[0], "cycle")
        self.assertEqual(len(written), 5)


if __name__ == "__main__":
    unittest.main()
