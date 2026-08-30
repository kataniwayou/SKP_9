import pathlib
import tempfile
import unittest

from skp.compile.lock import build_lock, build_lock_two_roots, edited_generated, stale_sources


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


class ManifestGlobTests(unittest.TestCase):
    """build_lock_two_roots(..., manifest_globs=[...]) records the matched
    file *set*, so a file added later -- one stale_sources could never see
    by walking only known paths -- registers as drift too."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        self.source_dir = self.root / "src"
        self.source_dir.mkdir()
        self.generated_dir = self.root / "model"
        self.generated_dir.mkdir()
        (self.source_dir / "AController.cs").write_text("a", encoding="utf-8")
        self.catalog = self.generated_dir / "catalog.json"
        self.catalog.write_text("[]", encoding="utf-8")
        self.lock = build_lock_two_roots(
            list(self.source_dir.glob("*Controller.cs")), self.source_dir,
            [self.catalog], self.generated_dir, manifest_globs=["*Controller.cs"])

    def tearDown(self):
        self.tmp.cleanup()

    def test_a_fresh_manifest_reports_nothing(self):
        self.assertEqual(stale_sources(self.lock, self.source_dir), [])

    def test_a_newly_added_matching_file_is_drift(self):
        (self.source_dir / "BController.cs").write_text("b", encoding="utf-8")
        self.assertNotEqual(stale_sources(self.lock, self.source_dir), [])

    def test_a_removed_matching_file_is_also_drift(self):
        (self.source_dir / "AController.cs").unlink()
        self.assertNotEqual(stale_sources(self.lock, self.source_dir), [])

    def test_no_manifest_globs_means_the_old_behaviour_is_unchanged(self):
        lock = build_lock_two_roots(
            list(self.source_dir.glob("*Controller.cs")), self.source_dir,
            [self.catalog], self.generated_dir)
        self.assertNotIn("manifests", lock)
