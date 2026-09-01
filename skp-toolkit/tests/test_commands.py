"""The verb surface: what is invocable, what is a declared gap, what is drift."""

import json
import pathlib
import unittest

from skp.commands import INVOCABLE, PLANNED, resolve

ANNOTATIONS = pathlib.Path(__file__).resolve().parents[1] / "skp" / "annotations"


class ResolveTests(unittest.TestCase):
    def test_an_invocable_command_resolves_to_itself(self):
        ok, why = resolve("skp observe queues")
        self.assertTrue(ok)
        self.assertEqual(why, "skp observe queues")

    def test_arguments_do_not_make_a_new_command(self):
        """``skp verify --component rabbitmq`` is ``skp verify`` invoked
        correctly. Matching whole strings would turn every argument into an
        unknown command."""
        ok, why = resolve("skp verify --component rabbitmq")
        self.assertTrue(ok)
        self.assertEqual(why, "skp verify")

    def test_a_planned_verb_passes_and_says_so(self):
        """Section 6.5: a capability with no verb is a gap in the shipped
        system, REPORTED rather than hidden -- so it must not fail the check,
        and it must not be silent either."""
        ok, why = resolve("skp author get --entity steps")
        self.assertTrue(ok)
        self.assertTrue(why.startswith("planned:"))
        self.assertIn("unbuilt", why)

    def test_an_undeclared_verb_fails(self):
        ok, why = resolve("skp observe metric")
        self.assertFalse(ok)
        self.assertIn("names no command", why)

    def test_an_empty_verb_is_not_a_failure(self):
        """An entry claiming no verb claims nothing false."""
        self.assertEqual(resolve(""), (True, "no verb claimed"))

    def test_longest_prefix_wins(self):
        """``skp operate verify`` must not be swallowed by ``skp verify`` or by
        a shorter ``skp operate`` entry that does not exist."""
        ok, why = resolve("skp operate verify --workflow abc")
        self.assertTrue(ok)
        self.assertEqual(why, "skp operate verify")

    def test_no_planned_verb_is_also_invocable(self):
        """A verb in both tables is a contradiction: it says the capability is
        unbuilt while the command exists. The prefix search would hide it, so
        it is asserted directly."""
        for planned in PLANNED:
            self.assertNotIn(planned, INVOCABLE, f"{planned} is both planned and invocable")


class EveryAnnotationVerbResolvesTests(unittest.TestCase):
    """The guard that keeps the catalog's instructions honest.

    A ``verb`` field is an instruction the offline model executes. One naming a
    command that does not exist spends its single attempt on an argparse usage
    error, which is indistinguishable from the system being broken -- the exact
    failure this bundle exists to prevent, reintroduced by the catalog itself.
    """

    def test_every_verb_named_by_an_annotation_resolves(self):
        dangling = []
        for path in sorted(ANNOTATIONS.glob("*.json")):
            for cid, entry in json.loads(path.read_text(encoding="utf-8")).items():
                verb = entry.get("verb", "")
                ok, why = resolve(verb)
                if not ok:
                    dangling.append(f"{cid} -> {verb!r} ({why})")
        self.assertEqual(dangling, [], "\n".join(dangling))

    def test_the_annotations_are_not_empty(self):
        """Guards the test above against passing vacuously if the glob breaks."""
        total = sum(len(json.loads(p.read_text(encoding="utf-8")))
                    for p in ANNOTATIONS.glob("*.json"))
        self.assertGreater(total, 100)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
