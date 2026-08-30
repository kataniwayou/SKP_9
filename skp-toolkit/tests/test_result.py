import unittest

from skp.result import EXIT_VERDICT, Result


class RenderTests(unittest.TestCase):
    def test_next_is_the_last_line(self):
        r = Result(EXIT_VERDICT, ["start rejected at gate 'schemaEdge'"],
                   next_command="skp map --component api")
        self.assertEqual(
            r.render(),
            "start rejected at gate 'schemaEdge'\nNEXT: skp map --component api",
        )

    def test_reference_precedes_next(self):
        r = Result(EXIT_VERDICT, ["rejected"],
                   next_command="skp doctor",
                   reference="references/gate-schema-edge.md")
        self.assertEqual(
            r.render(),
            "rejected\nSEE: references/gate-schema-edge.md\nNEXT: skp doctor",
        )

    def test_plain_result_renders_only_its_lines(self):
        self.assertEqual(Result(0, ["ok"]).render(), "ok")
