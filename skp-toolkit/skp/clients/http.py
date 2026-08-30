import json
import urllib.error
import urllib.parse
import urllib.request


class Unreachable(Exception):
    """A target did not answer. Reported as a named red row, never as a traceback."""

    def __init__(self, target: str, detail: str):
        super().__init__(f"{target}: {detail}")
        self.target = target
        self.detail = detail


class HttpClient:
    def __init__(self, base: str, token: str = "", timeout: float = 10.0,
                 opener=urllib.request.urlopen):
        self.base = base.rstrip("/")
        self.token = token
        self.timeout = timeout
        self._open = opener

    def _request(self, path: str, params: dict | None, data: bytes | None):
        url = self.base + path
        if params:
            url = f"{url}?{urllib.parse.urlencode(params)}"
        request = urllib.request.Request(url, data=data)
        if self.token:
            request.add_header("Authorization", f"Bearer {self.token}")
        if data is not None:
            request.add_header("Content-Type", "application/json")
        try:
            with self._open(request, timeout=self.timeout) as response:
                raw = response.read()
        except urllib.error.HTTPError as exc:
            raise Unreachable(self.base, f"HTTP {exc.code} for {path}") from exc
        except (urllib.error.URLError, OSError) as exc:
            raise Unreachable(self.base, str(getattr(exc, "reason", exc))) from exc
        return json.loads(raw) if raw else None

    def get_json(self, path: str, params: dict | None = None):
        return self._request(path, params, None)

    def post_json(self, path: str, body):
        return self._request(path, None, json.dumps(body).encode("utf-8"))
