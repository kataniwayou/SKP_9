from skp.clients.http import Unreachable


class Elastic:
    """Authoritative for run history.

    Callers bound every query on time and workflow: this index holds millions of
    documents on a shared cluster and an unbounded aggregation looks like a hang.
    """

    # C2: the real live data stream is "logs-generic.otel-default" (a dot before
    # "otel", not a hyphen) -- "logs-generic-default" 404s on the live cluster.
    # ~10.08M documents as of 2026-08-30 and growing; see
    # skp.compile.driver.elasticsearch_index(), which catalogues this same
    # default as a surface rather than leaving it something only this file says.
    def __init__(self, http, index: str = "logs-generic.otel-default"):
        self.http = http
        self.index = index

    def search(self, body: dict) -> list[dict]:
        payload = self.http.post_json(f"/{self.index}/_search", body) or {}
        hits = payload.get("hits", {}).get("hits", [])
        return [hit.get("_source", {}) for hit in hits]

    def ready(self) -> bool:
        try:
            self.http.get_json("/")
            return True
        except Unreachable:
            return False
