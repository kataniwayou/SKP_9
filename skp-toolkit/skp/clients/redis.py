from skp.clients.http import Unreachable


class Redis:
    """Authoritative for what is projected (L1/L2) and what is in flight (blobs)."""

    def __init__(self, cluster, workload: str = "sts/redis"):
        self.cluster = cluster
        self.workload = workload

    def _cli(self, *argv: str) -> str:
        return self.cluster.exec(self.workload, ["redis-cli", *argv])

    def keys(self, pattern: str) -> list[str]:
        return [k for k in self._cli("KEYS", pattern).splitlines() if k.strip()]

    def get(self, key: str) -> str:
        return self._cli("GET", key)

    def ttl(self, key: str) -> int:
        return int(self._cli("TTL", key) or -2)

    def smembers(self, key: str) -> list[str]:
        return [m for m in self._cli("SMEMBERS", key).splitlines() if m.strip()]

    def ping(self) -> bool:
        try:
            return self._cli("PING") == "PONG"
        except Unreachable:
            return False
