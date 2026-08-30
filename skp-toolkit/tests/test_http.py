import io
import json
import unittest
import urllib.error

from skp.clients.http import HttpClient, Unreachable


def fake_opener(payload: object, capture: list | None = None):
    def _open(request, timeout=None):
        if capture is not None:
            capture.append(request)
        return io.BytesIO(json.dumps(payload).encode("utf-8"))
    return _open


class HttpClientTests(unittest.TestCase):
    def test_get_json_returns_decoded_body(self):
        client = HttpClient("http://api:8080", opener=fake_opener({"status": "Healthy"}))
        self.assertEqual(client.get_json("/health/ready"), {"status": "Healthy"})

    def test_get_json_builds_the_url_with_params(self):
        seen: list = []
        client = HttpClient("http://prom:9090", opener=fake_opener({}, seen))
        client.get_json("/api/v1/query", {"query": "up"})
        self.assertEqual(seen[0].full_url, "http://prom:9090/api/v1/query?query=up")

    def test_token_becomes_an_authorization_header(self):
        seen: list = []
        client = HttpClient("http://api:8080", token="T0K", opener=fake_opener({}, seen))
        client.get_json("/x")
        self.assertEqual(seen[0].get_header("Authorization"), "Bearer T0K")

    def test_no_token_means_no_authorization_header(self):
        seen: list = []
        client = HttpClient("http://api:8080", opener=fake_opener({}, seen))
        client.get_json("/x")
        self.assertIsNone(seen[0].get_header("Authorization"))

    def test_post_json_sends_a_json_body(self):
        seen: list = []
        client = HttpClient("http://api:8080", opener=fake_opener({}, seen))
        client.post_json("/api/v1.0/orchestration/start", "abc")
        self.assertEqual(seen[0].data, b'"abc"')
        self.assertEqual(seen[0].get_header("Content-type"), "application/json")

    def test_a_transport_error_becomes_Unreachable(self):
        def boom(request, timeout=None):
            raise urllib.error.URLError("connection refused")

        client = HttpClient("http://es:9200", opener=boom)
        with self.assertRaises(Unreachable) as caught:
            client.get_json("/")
        self.assertEqual(caught.exception.target, "http://es:9200")
        self.assertIn("connection refused", caught.exception.detail)
