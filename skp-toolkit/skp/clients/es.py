from skp.clients.http import Unreachable


class Elastic:
    """Authoritative for run history.

    Callers bound every query on time and workflow: this index holds millions of
    documents on a shared cluster and an unbounded aggregation looks like a hang.
    """

    def __init__(self, http, index: str = "logs-generic-default"):
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
