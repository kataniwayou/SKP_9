from skp.clients.http import Unreachable

API_PREFIX = "/api/v1.0"


class BaseApi:
    """The only write authority in the system. Phases 1-2 read only."""

    def __init__(self, http):
        self.http = http

    def list(self, entity: str) -> list[dict]:
        return self.http.get_json(f"{API_PREFIX}/{entity}") or []

    def get(self, entity: str, id: str) -> dict:
        return self.http.get_json(f"{API_PREFIX}/{entity}/{id}")

    def by_source_hash(self, source_hash: str) -> dict:
        # Matching is byte-exact against a stored lowercase 64-char hex string, so an
        # uppercase variant 404s past a row that exists. Normalise here, once.
        return self.http.get_json(
            f"{API_PREFIX}/processors/by-source-hash/{source_hash.lower()}")

    def ready(self) -> bool:
        try:
            self.http.get_json("/health/ready")
            return True
        except Unreachable:
            return False
