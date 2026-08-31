import pathlib
import tempfile
import unittest

from skp import state


class StateTests(unittest.TestCase):
    def test_a_recorded_value_comes_back(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = pathlib.Path(tmp)
            state.record(home, "workflow", "abc")
            self.assertEqual(state.recall(home, "workflow"), "abc")

    def test_recall_of_something_never_recorded_is_none_not_an_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(state.recall(pathlib.Path(tmp), "workflow"))

    def test_an_unknown_key_raises_rather_than_writing_dead_state(self):
        """A typo'd key that silently wrote would produce state nothing ever
        reads, and the model would be told 'no previous workflow' forever."""
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):
                state.record(pathlib.Path(tmp), "wrokflow", "abc")

    def test_corrupt_state_recalls_as_none_rather_than_raising(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = pathlib.Path(tmp)
            (home / "state").mkdir()
            (home / "state" / "workflow.json").write_text("{not json",
                                                          encoding="utf-8")
            self.assertIsNone(state.recall(home, "workflow"))


if __name__ == "__main__":
    unittest.main()
