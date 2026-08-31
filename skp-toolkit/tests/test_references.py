import unittest

from skp import references
from skp.verbs import doctor

FIVE = ["cycle", "missingStep", "schemaEdge",
        "payloadConfigSchema", "processorLiveness"]


class ReferenceTests(unittest.TestCase):
    def test_every_shipped_gate_has_a_reference_file(self):
        for gate in FIVE:
            self.assertTrue(references.path_for(gate).exists(),
                            f"no reference file for gate {gate}")

    def test_camel_case_becomes_a_kebab_slug(self):
        self.assertEqual(references.slug_for("schemaEdge"), "gate-schema-edge")

    def test_an_unknown_gate_gets_a_slug_rather_than_an_exception(self):
        """doctor must survive a gate the toolkit has never seen -- that is
        exactly the case the coverage check exists to report."""
        self.assertEqual(references.slug_for("brandNewGate"), "gate-brand-new-gate")
        self.assertFalse(references.path_for("brandNewGate").exists())

    def test_the_see_string_is_repo_relative(self):
        self.assertEqual(references.reference_for("cycle"),
                         "references/gate-cycle.md")


class GateReferenceRowTests(unittest.TestCase):
    def test_full_coverage_is_a_passing_row(self):
        rows = doctor.gate_reference_rows(FIVE)
        self.assertEqual(rows[0][0], "gate references")
        self.assertTrue(rows[0][1])

    def test_a_gate_with_no_file_fails_and_is_named(self):
        name, ok, detail = doctor.gate_reference_rows(["cycle", "brandNewGate"])[0]
        self.assertFalse(ok)
        self.assertIn("brandNewGate", detail)

    def test_no_gates_at_all_fails_rather_than_passing_vacuously(self):
        """An empty list must not read as 'all covered'. A check that passes
        when it had nothing to check is the signature defect of this build."""
        name, ok, detail = doctor.gate_reference_rows([])[0]
        self.assertFalse(ok)
        self.assertIn("gates.json", detail)


if __name__ == "__main__":
    unittest.main()
