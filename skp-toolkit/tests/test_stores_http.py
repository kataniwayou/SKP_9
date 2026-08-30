import io
import unittest
import unittest as _unittest

from skp.clients.api import API_PREFIX, BaseApi
from skp.clients.es import Elastic
from skp.clients.prom import Prometheus
from skp.clients.http import HttpClient


class FakeHttp:
    def __init__(self, payload=None):
        self.payload = payload
        self.gets: list[tuple[str, dict | None]] = []
        self.posts: list[tuple[str, object]] = []

    def get_json(self, path, params=None):
        self.gets.append((path, params))
        return self.payload

    def get_text(self, path, params=None):
        self.gets.append((path, params))
        return "ok"

    def post_json(self, path, body):
        self.posts.append((path, body))
        return self.payload


class BaseApiTests(unittest.TestCase):
    def test_list_uses_the_versioned_plural_route(self):
        http = FakeHttp([{"id": "1"}])
        self.assertEqual(BaseApi(http).list("workflows"), [{"id": "1"}])
        self.assertEqual(http.gets[0][0], f"{API_PREFIX}/workflows")

    def test_by_source_hash_lowercases_the_segment(self):
        http = FakeHttp({"id": "1"})
        BaseApi(http).by_source_hash("ABCDEF")
        self.assertEqual(http.gets[0][0], f"{API_PREFIX}/processors/by-source-hash/abcdef")


class ElasticTests(unittest.TestCase):
    def test_search_unwraps_hits_to_sources(self):
        http = FakeHttp({"hits": {"hits": [{"_source": {"body": {"text": "x"}}}]}})
        self.assertEqual(Elastic(http).search({"size": 1}), [{"body": {"text": "x"}}])

    def test_an_empty_result_set_is_an_empty_list(self):
        self.assertEqual(Elastic(FakeHttp({"hits": {"hits": []}})).search({}), [])


class PrometheusTests(unittest.TestCase):
    def test_query_returns_the_result_array(self):
        http = FakeHttp({"status": "success", "data": {"result": [{"value": [0, "1"]}]}})
        self.assertEqual(Prometheus(http).query("up"), [{"value": [0, "1"]}])
        self.assertEqual(http.gets[0], ("/api/v1/query", {"query": "up"}))

    def test_a_failed_query_returns_nothing_rather_than_raising(self):
        self.assertEqual(Prometheus(FakeHttp({"status": "error"})).query("bad{"), [])


class PlainTextProbeTests(_unittest.TestCase):
    def test_a_plain_text_body_does_not_crash_the_probe(self):
        def opener(request, timeout=None):
            return io.BytesIO(b"Prometheus Server is Healthy.\n")

        self.assertTrue(Prometheus(HttpClient("http://prom:9090", opener=opener)).ready())
