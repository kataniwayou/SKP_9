import csv
import io

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
        # I9: `-tAc` with the default `|` separator, split on "|", silently
        # misaligns every column after a cell that itself contains a pipe -- a
        # JSON schema definition with an alternation is exactly that cell, and
        # exactly the realistic case for the Schemas table. `-t` still
        # suppresses the header/footer; `--csv` makes the row shape unambiguous
        # regardless of what a cell contains.
        script = 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t --csv -c "$1"'
        out = self.cluster.exec(self.workload, ["sh", "-c", script, "sh", sql])
        if not out.strip():
            return []
        return [row for row in csv.reader(io.StringIO(out)) if row]

    def ping(self) -> bool:
        try:
            self.cluster.exec(self.workload, ["pg_isready"])
            return True
        except Unreachable:
            return False
