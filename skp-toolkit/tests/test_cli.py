import contextlib
import io
import pathlib
import tempfile
import unittest

from skp.cli import main, render_output
from skp.profile import Profile
from skp.result import EXIT_NOT_INITIALISED, EXIT_USAGE, Result


class ZeroArgTests(unittest.TestCase):
    def test_zero_arguments_is_an_invitation_not_a_None_literal(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = main([])
        self.assertEqual(code, EXIT_USAGE)
        self.assertNotIn("None", out.getvalue())
        self.assertIn("NEXT:", out.getvalue())


class SystemExitEscapeTests(unittest.TestCase):
    """I4: a missing required flag must not escape as a bare argparse usage
    dump exiting 2 (which collides with EXIT_NOT_INITIALISED)."""

    def test_a_missing_required_flag_becomes_a_Result_not_exit_2(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            code = main(["init", "--source-root", "/src"])  # missing --cluster-url/--project
        self.assertNotEqual(code, EXIT_NOT_INITIALISED)
        self.assertEqual(code, EXIT_USAGE)
        self.assertIn("NEXT:", out.getvalue())

    def test_help_is_not_treated_as_a_usage_error(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            code = main(["map", "--help"])
        self.assertEqual(code, 0)


class RedactionTests(unittest.TestCase):
    """I5: profile.redact() must actually sit between a Result and stdout."""

    def test_a_token_in_the_rendered_output_is_masked_when_a_profile_exists(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = pathlib.Path(tmp) / ".skp"
            Profile(home=home, source_root="/src", cluster_url="https://c",
                    project="skp", endpoints={}).save(token="sha256~SECRETVALUE")

            result = Result(0, ["Authorization: Bearer sha256~SECRETVALUE"])
            rendered = render_output(result, ["--home", str(home)])

        self.assertNotIn("SECRETVALUE", rendered)
        self.assertIn("<token from profile>", rendered)

    def test_no_profile_means_no_redaction_attempted_and_no_crash(self):
        result = Result(0, ["plain output, nothing to hide"])
        rendered = render_output(result, ["--home", "/does/not/exist"])
        self.assertEqual(rendered, "plain output, nothing to hide")


if __name__ == "__main__":
    unittest.main()
