import unittest

from skp.verbs.init import probe, render_table


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
