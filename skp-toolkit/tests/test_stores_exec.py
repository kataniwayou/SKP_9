import json
import unittest

from skp.clients.http import Unreachable
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


class FailingCluster:
    """exec() always raises Unreachable, carrying a detail a ping() must
    not discard (Important 1)."""

    def __init__(self, detail: str):
        self.detail = detail

    def exec(self, workload, argv):
        raise Unreachable(workload, self.detail)


class PagedFakeCluster:
    """Returns a different scripted response per call, in order -- for
    testing SCAN's cursor-driven pagination, which a single fixed stdout
    (FakeCluster) cannot simulate."""

    def __init__(self, responses: list[str]):
        self.calls: list[tuple[str, list[str]]] = []
        self._responses = list(responses)

    def exec(self, workload, argv):
        self.calls.append((workload, argv))
        return self._responses.pop(0)


class PostgresTests(unittest.TestCase):
    def test_rows_are_parsed_as_csv(self):
        cluster = FakeCluster("a,1\nb,2")
        rows = Postgres(cluster).rows("SELECT name, n FROM t")
        self.assertEqual(rows, [["a", "1"], ["b", "2"]])

    def test_a_value_containing_a_pipe_survives_intact(self):
        # I9: `-tAc` with the default `|` separator silently misaligned every
        # column after a cell that itself contains a pipe -- a JSON schema
        # definition with an alternation is exactly that realistic cell.
        cluster = FakeCluster("a,json|schema\nb,2")
        rows = Postgres(cluster).rows("SELECT name, schema FROM t")
        self.assertEqual(rows[0], ["a", "json|schema"])

    def test_empty_output_is_no_rows(self):
        self.assertEqual(Postgres(FakeCluster("")).rows("SELECT 1"), [])

    def test_credentials_are_read_from_the_pod_environment(self):
        cluster = FakeCluster("1")
        Postgres(cluster).rows("SELECT 1")
        workload, argv = cluster.calls[0]
        self.assertEqual(workload, "sts/postgres")
        self.assertEqual(argv[0], "sh")
        self.assertIn('psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t --csv -c', argv[2])
        self.assertEqual(argv[4], "SELECT 1")

    def test_a_double_quoted_identifier_survives_intact(self):
        cluster = FakeCluster("x")
        Postgres(cluster).rows('SELECT "Name" FROM "Workflows"')
        argv = cluster.calls[0][1]
        self.assertEqual(argv[4], 'SELECT "Name" FROM "Workflows"')
        self.assertNotIn("Workflows", argv[2])

    def test_ping_records_the_unreachable_detail_as_last_error(self):
        pg = Postgres(FailingCluster("pod not found"))
        self.assertFalse(pg.ping())
        self.assertEqual(pg.last_error, "pod not found")


class RedisTests(unittest.TestCase):
    def test_keys_returns_one_entry_per_line(self):
        cluster = FakeCluster("0\nskp:proc:a\nskp:proc:b")
        self.assertEqual(Redis(cluster).keys("skp:proc:*"), ["skp:proc:a", "skp:proc:b"])
        self.assertEqual(cluster.calls[0][1],
                         ["redis-cli", "SCAN", "0", "MATCH", "skp:proc:*", "COUNT", "1000"])

    def test_no_keys_is_an_empty_list_not_a_blank_entry(self):
        self.assertEqual(Redis(FakeCluster("0")).keys("nope:*"), [])

    def test_KEYS_is_never_issued(self):
        # I9: KEYS is O(N) and blocks the server for the duration -- exactly
        # the "an investigation mutates the system it is investigating" risk.
        cluster = FakeCluster("0\nskp:proc:a")
        Redis(cluster).keys("skp:proc:*")
        self.assertNotIn("KEYS", cluster.calls[0][1])
        self.assertIn("SCAN", cluster.calls[0][1])

    def test_keys_pages_through_multiple_SCAN_cursors(self):
        cluster = PagedFakeCluster(["17\nskp:proc:a", "0\nskp:proc:b"])
        self.assertEqual(Redis(cluster).keys("skp:proc:*"), ["skp:proc:a", "skp:proc:b"])
        self.assertEqual(len(cluster.calls), 2)
        self.assertEqual(cluster.calls[1][1],
                         ["redis-cli", "SCAN", "17", "MATCH", "skp:proc:*", "COUNT", "1000"])

    def test_ttl_is_an_int(self):
        self.assertEqual(Redis(FakeCluster("40")).ttl("skp:proc:a:pod-1"), 40)

    def test_ping_is_true_only_on_PONG(self):
        self.assertTrue(Redis(FakeCluster("PONG")).ping())
        self.assertFalse(Redis(FakeCluster("")).ping())

    def test_a_key_reemitted_across_scan_pages_is_returned_once(self):
        # Minor 3: SCAN may re-emit a key across cursor iterations (KEYS
        # never did) -- the second page repeats "skp:proc:a".
        cluster = PagedFakeCluster(["17\nskp:proc:a", "0\nskp:proc:a\nskp:proc:b"])
        self.assertEqual(Redis(cluster).keys("skp:proc:*"), ["skp:proc:a", "skp:proc:b"])

    def test_ping_records_the_unreachable_detail_as_last_error(self):
        redis = Redis(FailingCluster("connection refused"))
        self.assertFalse(redis.ping())
        self.assertEqual(redis.last_error, "connection refused")


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

    def test_ping_records_the_unreachable_detail_as_last_error(self):
        rabbit = Rabbit(FailingCluster("node down"))
        self.assertFalse(rabbit.ping())
        self.assertEqual(rabbit.last_error, "node down")
