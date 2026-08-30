import json
import unittest

from skp.clients.pg import Postgres
from skp.clients.rabbit import Rabbit
from skp.clients.redis import Redis


class FakeCluster:
    def __init__(self, stdout=""):
        self.calls: list[tuple[str, list[str]]] = []
        self.stdout = stdout

    def exec(self, workload, argv):
        self.calls.append((workload, argv))
        return self.stdout


class PostgresTests(unittest.TestCase):
    def test_rows_splits_on_pipes_and_newlines(self):
        cluster = FakeCluster("a|1\nb|2")
        rows = Postgres(cluster).rows("SELECT name, n FROM t")
        self.assertEqual(rows, [["a", "1"], ["b", "2"]])

    def test_empty_output_is_no_rows(self):
        self.assertEqual(Postgres(FakeCluster("")).rows("SELECT 1"), [])

    def test_credentials_are_read_from_the_pod_environment(self):
        cluster = FakeCluster("1")
        Postgres(cluster).rows("SELECT 1")
        workload, argv = cluster.calls[0]
        self.assertEqual(workload, "sts/postgres")
        self.assertEqual(argv[0], "sh")
        self.assertIn('psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc', argv[2])
        self.assertIn("SELECT 1", argv[2])


class RedisTests(unittest.TestCase):
    def test_keys_returns_one_entry_per_line(self):
        cluster = FakeCluster("skp:proc:a\nskp:proc:b")
        self.assertEqual(Redis(cluster).keys("skp:proc:*"), ["skp:proc:a", "skp:proc:b"])
        self.assertEqual(cluster.calls[0][1], ["redis-cli", "KEYS", "skp:proc:*"])

    def test_no_keys_is_an_empty_list_not_a_blank_entry(self):
        self.assertEqual(Redis(FakeCluster("")).keys("nope:*"), [])

    def test_ttl_is_an_int(self):
        self.assertEqual(Redis(FakeCluster("40")).ttl("skp:proc:a:pod-1"), 40)

    def test_ping_is_true_only_on_PONG(self):
        self.assertTrue(Redis(FakeCluster("PONG")).ping())
        self.assertFalse(Redis(FakeCluster("")).ping())


class RabbitTests(unittest.TestCase):
    def test_queues_are_read_as_json_not_scraped_from_columns(self):
        payload = json.dumps([
            {"name": "orchestrator-result", "messages": 3, "consumers": 2},
            {"name": "orchestrator-result.dead", "messages": 0, "consumers": 0},
        ])
        cluster = FakeCluster(payload)
        queues = Rabbit(cluster).queues()
        self.assertEqual(queues[0]["name"], "orchestrator-result")
        self.assertEqual(queues[0]["messages"], 3)
        self.assertIn("--formatter=json", cluster.calls[0][1])

    def test_the_management_http_api_is_never_addressed(self):
        cluster = FakeCluster("[]")
        Rabbit(cluster).queues()
        flat = " ".join(cluster.calls[0][1])
        self.assertNotIn("15672", flat)
        self.assertNotIn("/api/queues", flat)
