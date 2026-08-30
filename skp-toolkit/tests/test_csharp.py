import pathlib
import unittest

from skp.compile.csharp import const_strings, expression_bodies, literals_matching, unescape

TEMPLATES = '''
internal static class Templates
{
    public const string EntryDispatched = "dispatched an entry step";
    public const string HandedOff =
        "handed off to {NextStepId} on {NextProcessorId} with {NextEntryId}";
    public const string TerminalCompleted =
        "the terminal step completed with {Result} \\u2014 no successor accepts it";
    public const string RefusingNotParked =
        "refusing message of type {Type} on {Queue} \\u2014 NOT parked: the channel was gone before "
        + "the broker was told, so it will be redelivered rather than dead-lettered";
}
'''

KEYS = '''
public static class L2ProjectionKeys
{
    public const string Prefix = "skp:";
    public static string ParentIndex() => Prefix;
    public static string Root(Guid workflowId) => $"{Prefix}{workflowId:D}";
    public static string PerInstance(Guid processorId, string instanceId)
        => $"{Prefix}proc:{processorId:D}:{instanceId}";
}
'''


class ConstStringTests(unittest.TestCase):
    def test_single_line_constant(self):
        self.assertEqual(
            const_strings(TEMPLATES)["EntryDispatched"], "dispatched an entry step")

    def test_constant_wrapped_onto_the_next_line(self):
        self.assertEqual(
            const_strings(TEMPLATES)["HandedOff"],
            "handed off to {NextStepId} on {NextProcessorId} with {NextEntryId}")

    def test_unicode_escapes_are_decoded_to_the_real_character(self):
        value = const_strings(TEMPLATES)["TerminalCompleted"]
        self.assertIn("—", value)
        self.assertNotIn("\\u2014", value)

    def test_concatenated_constant_is_joined_in_order(self):
        value = const_strings(TEMPLATES)["RefusingNotParked"]
        self.assertTrue(value.startswith("refusing message of type {Type}"))
        self.assertTrue(value.endswith("redelivered rather than dead-lettered"))
        self.assertIn("gone before the broker was told", value)

    def test_every_declared_constant_is_found(self):
        self.assertEqual(
            sorted(const_strings(TEMPLATES)),
            ["EntryDispatched", "HandedOff", "RefusingNotParked", "TerminalCompleted"])

    def test_a_semicolon_inside_a_value_does_not_truncate_it(self):
        text = 'public const string A = "send; continuing";\npublic const string B = "next";'
        found = const_strings(text)
        self.assertEqual(found["A"], "send; continuing")
        self.assertEqual(found["B"], "next")


class ExpressionBodyTests(unittest.TestCase):
    def test_interpolated_body_keeps_its_placeholders(self):
        self.assertEqual(expression_bodies(KEYS)["Root"], "{Prefix}{workflowId}")

    def test_format_specifiers_are_stripped(self):
        self.assertEqual(
            expression_bodies(KEYS)["PerInstance"], "{Prefix}proc:{processorId}:{instanceId}")

    def test_a_body_that_is_a_bare_identifier_is_not_a_literal(self):
        self.assertNotIn("ParentIndex", expression_bodies(KEYS))

    def test_a_bare_identifier_body_resolves_against_the_consts(self):
        bodies = expression_bodies(KEYS, const_strings(KEYS))
        self.assertEqual(bodies["ParentIndex"], "skp:")

    def test_a_semicolon_inside_an_expression_body_does_not_truncate_it(self):
        text = 'public static string K(Guid id) => $"a;b:{id:D}";'
        self.assertEqual(expression_bodies(text)["K"], "a;b:{id}")


class LiteralScanTests(unittest.TestCase):
    def test_prefix_scan_finds_instrument_names_and_dedupes(self):
        text = 'x("pipeline.queue.depth"); y("pipeline.queue.depth"); z("other.thing");'
        self.assertEqual(literals_matching(text, "pipeline."), ["pipeline.queue.depth"])


class UnescapeTests(unittest.TestCase):
    def test_escaped_quote_and_backslash(self):
        self.assertEqual(unescape('a \\"b\\" c'), 'a "b" c')

    def test_an_escaped_backslash_before_u_hex_is_not_a_unicode_escape(self):
        self.assertEqual(unescape(r"C:\\u1234path"), r"C:\u1234path")

    def test_escaped_quote_and_unicode_still_decode(self):
        self.assertEqual(unescape(r'say \"hi\" \u2014 ok'), 'say "hi" — ok')


class RealTemplateTests(unittest.TestCase):
    SRC = pathlib.Path(__file__).resolve().parents[2] / "src"

    @unittest.skipUnless(SRC.exists(), "run from inside the repo")
    def test_templates_carrying_semicolons_extract_their_full_text(self):
        text = (self.SRC / "tests/BaseApi.Tests/Live/Resilience/Templates.cs").read_text(
            encoding="utf-8")
        found = const_strings(text)
        self.assertEqual(found["EntryDispatchSendFailed"],
                         "the entry-step dispatch failed to send; continuing")
        self.assertEqual(found["ProcessorLoopsRetired"],
                         "processor healthy; startup loops retired")


if __name__ == "__main__":
    unittest.main()
