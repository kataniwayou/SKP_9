import pathlib
import unittest
import unittest.mock

from skp.clients.http import Unreachable
from skp.profile import Profile
from skp.verbs.init import build_clients, probe, render_table


class Probeable:
    def __init__(self, ok):
        self._ok = ok

    def ping(self):
        return self._ok

    ready = ping


class ProbeTests(unittest.TestCase):
    def clients(self, **overrides):
        base = {name: Probeable(True) for name in
                ("cluster", "postgres", "redis", "rabbitmq", "elasticsearch",
                 "prometheus", "baseapi")}
        base.update(overrides)
        return base

    def test_probe_reports_all_seven_targets_in_a_fixed_order(self):
        rows = probe(self.clients())
        self.assertEqual(
            [name for name, _, _ in rows],
            ["cluster", "postgres", "redis", "rabbitmq", "elasticsearch",
             "prometheus", "baseapi"],
        )
        self.assertTrue(all(ok for _, ok, _ in rows))

    def test_one_dead_target_is_a_named_red_row_not_a_crash(self):
        rows = probe(self.clients(elasticsearch=Probeable(False)))
        failed = [name for name, ok, _ in rows if not ok]
        self.assertEqual(failed, ["elasticsearch"])

    def test_the_table_marks_each_row_and_names_the_dead_one(self):
        table = render_table(probe(self.clients(redis=Probeable(False))))
        self.assertIn("redis", table)
        self.assertIn("UNREACHABLE", table)
        self.assertIn("ok", table)

    def test_probe_survives_a_client_missing_both_methods(self):
        class Neither:
            pass

        rows = probe(self.clients(baseapi=Neither()))
        self.assertEqual(len(rows), 7)
        failed = [(name, detail) for name, ok, detail in rows if not ok]
        self.assertEqual(len(failed), 1)
        self.assertIn("neither ping() nor ready()", failed[0][1])

    def test_probe_survives_a_client_whose_check_raises(self):
        class Boom:
            def ping(self):
                raise RuntimeError("connection reset")

        rows = probe(self.clients(redis=Boom()))
        detail = [d for name, ok, d in rows if name == "redis"][0]
        self.assertIn("connection reset", detail)


class MissingBinaryTests(unittest.TestCase):
    def test_no_cluster_cli_still_yields_seven_clients(self):
        profile = Profile(home=pathlib.Path("."), source_root="/src",
                          cluster_url="https://c", project="skp", endpoints={})
        with unittest.mock.patch("skp.verbs.init.detect_binary",
                                 side_effect=Unreachable("cluster", "no oc or kubectl")):
            clients = build_clients(profile)
        self.assertEqual(len(clients), 7)
        self.assertFalse(clients["postgres"].ping())
        self.assertFalse(clients["cluster"].ping())
