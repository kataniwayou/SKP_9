from skp.clients.http import Unreachable


class Redis:
    """Authoritative for what is projected (L1/L2) and what is in flight (blobs)."""

    def __init__(self, cluster, workload: str = "sts/redis"):
        self.cluster = cluster
        self.workload = workload

    def _cli(self, *argv: str) -> str:
        return self.cluster.exec(self.workload, ["redis-cli", *argv])

    def keys(self, pattern: str) -> list[str]:
        """Every key matching ``pattern``, read with ``SCAN`` rather than
        ``KEYS``.

        I9: ``KEYS`` is O(N) over the whole keyspace and blocks the server
        for the duration -- an investigation that mutates the system it is
        investigating (spec §15's own named risk), and ``skp:data:*`` on a
        live system is exactly the unbounded case. ``SCAN`` walks the
        keyspace in cursor-driven pages instead. The signature is unchanged.
        """
        found: list[str] = []
        cursor = "0"
        while True:
            out = self._cli("SCAN", cursor, "MATCH", pattern, "COUNT", "1000")
            lines = [line for line in out.splitlines() if line.strip()]
            if not lines:
                break
            cursor, *batch = lines
            found.extend(batch)
            if cursor == "0":
                break
        return found

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
