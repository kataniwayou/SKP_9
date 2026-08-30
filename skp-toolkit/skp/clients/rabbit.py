import json

from skp.clients.http import Unreachable


class Rabbit:
    """Authoritative for stuck work.

    Read through ``rabbitmqctl`` only. The HTTP management API is off-limits:
    the broker is org-owned and its owners monitor it (see
    2026-08-22-pipeline-metrics-design.md).
    """

    def __init__(self, cluster, workload: str = "sts/rabbitmq"):
        self.cluster = cluster
        self.workload = workload
        self.last_error = ""

    def queues(self) -> list[dict]:
        out = self.cluster.exec(self.workload, [
            "rabbitmqctl", "list_queues", "name", "messages", "consumers",
            "--formatter=json",
        ])
        return json.loads(out) if out else []

    def exchanges(self) -> list[dict]:
        """The catalogued dead-letter surfaces (``DeadLetterExchange``) name
        exchanges, not queues -- ``list_queues`` will never list them and that
        absence is not a defect. Read-only, same as ``queues()``."""
        out = self.cluster.exec(self.workload, [
            "rabbitmqctl", "list_exchanges", "name",
            "--formatter=json",
        ])
        return json.loads(out) if out else []

    def ping(self) -> bool:
        try:
            self.cluster.exec(self.workload, ["rabbitmqctl", "status", "--formatter=json"])
            return True
        except Unreachable as exc:
            self.last_error = exc.detail
            return False
