from skp.clients.http import Unreachable


class Prometheus:
    """Authoritative for rates and per-replica health.

    ``instance`` is the scrape target, not the replica. Per-replica queries must
    group on ``service_instance_id``.
    """

    def __init__(self, http):
        self.http = http

    def query(self, expr: str) -> list[dict]:
        payload = self.http.get_json("/api/v1/query", {"query": expr}) or {}
        if payload.get("status") != "success":
            return []
        return payload.get("data", {}).get("result", [])

    def ready(self) -> bool:
        try:
            self.http.get_text("/-/healthy")
            return True
        except Unreachable:
            return False
