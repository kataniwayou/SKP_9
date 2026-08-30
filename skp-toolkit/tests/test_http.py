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


class _FakeResponse:
    """A minimal stand-in for ``http.client.HTTPResponse`` -- carries a
    ``.status`` attribute the shared ``fake_opener``/``io.BytesIO`` fixture
    above does not, since only ``probe_status`` ever reads one.
    """

    def __init__(self, status: int, body: bytes = b""):
        self.status = status
        self._body = body

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        return False


class ProbeStatusTests(unittest.TestCase):
    """``probe_status`` backs ``skp verify --probe-writes`` -- the one path
    in this client that must hand back a 2xx as data, not raise past it,
    since a 2xx is the one outcome the probe most needs to see.
    """

    def test_a_2xx_is_returned_not_raised(self):
        client = HttpClient("http://api:8080", opener=lambda req, timeout=None: _FakeResponse(202))
        self.assertEqual(client.probe_status("POST", "/api/v1.0/orchestration/start", {}), 202)

    def test_a_4xx_from_http_error_is_returned_not_raised(self):
        def boom(request, timeout=None):
            raise urllib.error.HTTPError("http://api:8080/x", 400, "Bad Request", {}, io.BytesIO(b""))

        client = HttpClient("http://api:8080", opener=boom)
        self.assertEqual(client.probe_status("POST", "/api/v1.0/workflows", {}), 400)

    def test_a_5xx_from_http_error_is_also_returned_not_raised(self):
        def boom(request, timeout=None):
            raise urllib.error.HTTPError("http://api:8080/x", 500, "Boom", {}, io.BytesIO(b""))

        client = HttpClient("http://api:8080", opener=boom)
        self.assertEqual(client.probe_status("DELETE", "/api/v1.0/workflows/x", {}), 500)

    def test_a_transport_failure_still_raises_Unreachable(self):
        def boom(request, timeout=None):
            raise urllib.error.URLError("connection refused")

        client = HttpClient("http://api:8080", opener=boom)
        with self.assertRaises(Unreachable):
            client.probe_status("POST", "/api/v1.0/workflows", {})

    def test_the_method_and_json_body_are_sent_as_given(self):
        seen: list = []

        def capture(request, timeout=None):
            seen.append(request)
            return _FakeResponse(400)

        client = HttpClient("http://api:8080", opener=capture)
        client.probe_status("PUT", "/api/v1.0/workflows/deadbeef", {})
        self.assertEqual(seen[0].get_method(), "PUT")
        self.assertEqual(seen[0].data, b"{}")
        self.assertEqual(seen[0].get_header("Content-type"), "application/json")
