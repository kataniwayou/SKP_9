import pathlib
import tempfile
import unittest

from skp.compile.lock import build_lock, edited_generated, stale_sources


class LockTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        self.source = self.root / "Queues.cs"
        self.generated = self.root / "catalog.json"
        self.source.write_text("original", encoding="utf-8")
        self.generated.write_text("generated", encoding="utf-8")
        self.lock = build_lock([self.source], [self.generated], self.root)

    def tearDown(self):
        self.tmp.cleanup()

    def test_a_fresh_lock_reports_nothing(self):
        self.assertEqual(stale_sources(self.lock, self.root), [])
        self.assertEqual(edited_generated(self.lock, self.root), [])

    def test_a_changed_source_is_drift(self):
        self.source.write_text("edited", encoding="utf-8")
        self.assertEqual(stale_sources(self.lock, self.root), ["Queues.cs"])
        self.assertEqual(edited_generated(self.lock, self.root), [])

    def test_a_changed_generated_file_is_a_hand_edit_not_drift(self):
        self.generated.write_text("someone fixed this by hand", encoding="utf-8")
        self.assertEqual(edited_generated(self.lock, self.root), ["catalog.json"])
        self.assertEqual(stale_sources(self.lock, self.root), [])

    def test_a_deleted_source_is_drift(self):
        self.source.unlink()
        self.assertEqual(stale_sources(self.lock, self.root), ["Queues.cs"])

    def test_paths_are_recorded_relative_to_the_root(self):
        self.assertEqual(sorted(self.lock["sources"]), ["Queues.cs"])
