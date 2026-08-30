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

    def _fetch(self, path: str, params: dict | None, data: bytes | None) -> bytes:
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
                return response.read()
        except urllib.error.HTTPError as exc:
            raise Unreachable(self.base, f"HTTP {exc.code} for {path}") from exc
        except (urllib.error.URLError, OSError) as exc:
            raise Unreachable(self.base, str(getattr(exc, "reason", exc))) from exc

    def _request(self, path: str, params: dict | None, data: bytes | None):
        raw = self._fetch(path, params, data)
        return json.loads(raw) if raw else None

    def get_json(self, path: str, params: dict | None = None):
        return self._request(path, params, None)

    def get_text(self, path: str, params: dict | None = None) -> str:
        return self._fetch(path, params, None).decode("utf-8", errors="replace")

    def post_json(self, path: str, body):
        return self._request(path, None, json.dumps(body).encode("utf-8"))

    def probe_status(self, method: str, path: str, body) -> int:
        """Send ``body`` via an explicit HTTP verb and return the raw status
        code -- 2xx included, never raised as :class:`Unreachable`.

        Used only by ``skp verify --probe-writes``. Every other method on
        this client treats a non-2xx response as a failure (``Unreachable``,
        carrying ``HTTP <code>`` in its detail) because a read that gets
        anything but 2xx genuinely failed. A write probe is different: 400,
        404 and 405 are its *expected*, successful outcomes (proof the route
        rejected a deliberately invalid request before doing anything), and
        the one status this probe must not silently swallow is 2xx -- the
        one outcome that would mean the request actually went through. So
        this method surfaces every status the same way, as a plain return
        value, and leaves the verdict (CONFIRMED/REFUTED/UNVERIFIABLE) to
        the caller. Only a genuine transport failure -- no response at all --
        still raises ``Unreachable``.
        """
        url = self.base + path
        data = json.dumps(body).encode("utf-8")
        request = urllib.request.Request(url, data=data, method=method)
        if self.token:
            request.add_header("Authorization", f"Bearer {self.token}")
        request.add_header("Content-Type", "application/json")
        try:
            with self._open(request, timeout=self.timeout) as response:
                response.read()
                return response.status
        except urllib.error.HTTPError as exc:
            return exc.code
        except (urllib.error.URLError, OSError) as exc:
            raise Unreachable(self.base, str(getattr(exc, "reason", exc))) from exc
