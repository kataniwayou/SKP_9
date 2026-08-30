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

    def exists(self, filter_clauses: list[dict]) -> bool:
        """Does any document in the *whole* data stream match ``filter_clauses``,
        right now -- across the full ~17-day retention, not a recent sample?

        ``size: 0`` -- no document body is ever fetched, only whether one
        matches. ``track_total_hits: 1`` caps the count Elasticsearch has to
        accumulate before it can stop looking: the answer to "does at least
        one exist" costs the same whether the true count is 0 or 10 million,
        because the query can stop at the first match. This is what makes a
        per-claim existence query cheap enough to run once per catalogued
        template/attribute rather than sharing one bounded recent sample --
        the earlier approach that hid genuine matches sitting in
        chaos-scenario history outside the sampled window (skp verify, C2026-08-30).
        """
        body = {"size": 0, "track_total_hits": 1,
                "query": {"bool": {"filter": filter_clauses}}}
        payload = self.http.post_json(f"/{self.index}/_search", body) or {}
        total = payload.get("hits", {}).get("total", {})
        value = total.get("value", 0) if isinstance(total, dict) else total
        return bool(value)

    def ready(self) -> bool:
        try:
            self.http.get_json("/")
            return True
        except Unreachable:
            return False
