from skp.clients.http import Unreachable


class Postgres:
    """Authoritative for the *definition*: entities and the three junction tables.

    Never for what is currently running — that is L2's answer, and the two
    legitimately diverge between a PUT and the next start.
    """

    def __init__(self, cluster, workload: str = "sts/postgres"):
        self.cluster = cluster
        self.workload = workload

    def rows(self, sql: str) -> list[list[str]]:
        script = 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "$1"'
        out = self.cluster.exec(self.workload, ["sh", "-c", script, "sh", sql])
        return [line.split("|") for line in out.splitlines() if line.strip()]

    def ping(self) -> bool:
        try:
            self.cluster.exec(self.workload, ["pg_isready"])
            return True
        except Unreachable:
            return False
