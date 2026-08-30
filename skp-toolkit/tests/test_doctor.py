import json
import pathlib
import tempfile
import unittest

from skp.profile import Profile
from skp.verbs.doctor import diagnose

CATALOG = [{"id": "redis.Root", "component": "redis", "operation": "read key",
            "detail": "skp:{workflowId}", "intents": ["observe"],
            "answers": "x", "never_for": "y", "write_authority": "none",
            "cost": "cheap", "verb": "skp observe projected"}]


class Probeable:
    def __init__(self, ok=True):
        self._ok = ok

    def ping(self):
        return self._ok

    ready = ping


def clients(**overrides):
    base = {name: Probeable() for name in
            ("cluster", "postgres", "redis", "rabbitmq", "elasticsearch",
             "prometheus", "baseapi")}
    base.update(overrides)
    return base


class DoctorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        self.source = self.root / "src" / "Queues.cs"
        self.source.parent.mkdir(parents=True)
        self.source.write_text("original", encoding="utf-8")

        self.home = self.root / ".skp"
        self.profile = Profile(home=self.home, source_root=str(self.source.parent),
                               cluster_url="https://c", project="skp", endpoints={})
        self.profile.save(token="")

        model = self.home / "model"
        model.mkdir(exist_ok=True)
        catalog_path = model / "catalog.json"
        catalog_path.write_text(json.dumps(CATALOG), encoding="utf-8")

        from skp.compile.lock import build_lock_two_roots
        lock = build_lock_two_roots([self.source], self.source.parent,
                                    [catalog_path], model)
        (model / "compile.lock").write_text(json.dumps(lock), encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def names(self, rows):
        return [name for name, _, _ in rows]

    def test_a_healthy_bundle_passes_every_check(self):
        rows = diagnose(self.profile, clients())
        self.assertTrue(all(ok for _, ok, _ in rows), rows)
        self.assertIn("source drift", self.names(rows))
        self.assertIn("generated files", self.names(rows))
        self.assertIn("catalog present", self.names(rows))

    def test_an_edited_source_fails_the_drift_check_and_names_the_file(self):
        self.source.write_text("edited", encoding="utf-8")
        rows = {name: (ok, detail) for name, ok, detail in diagnose(self.profile, clients())}
        ok, detail = rows["source drift"]
        self.assertFalse(ok)
        self.assertIn("Queues.cs", detail)

    def test_an_edited_catalog_fails_the_generated_check(self):
        (self.home / "model" / "catalog.json").write_text("[]", encoding="utf-8")
        rows = {name: (ok, detail) for name, ok, detail in diagnose(self.profile, clients())}
        self.assertFalse(rows["generated files"][0])

    def test_an_unreachable_store_is_its_own_named_check(self):
        rows = {name: (ok, detail) for name, ok, detail
                in diagnose(self.profile, clients(redis=Probeable(False)))}
        self.assertFalse(rows["reachability: redis"][0])
