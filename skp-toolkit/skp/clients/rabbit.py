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

    def queues(self) -> list[dict]:
        out = self.cluster.exec(self.workload, [
            "rabbitmqctl", "list_queues", "name", "messages", "consumers",
            "--formatter=json",
        ])
        return json.loads(out) if out else []

    def ping(self) -> bool:
        try:
            self.cluster.exec(self.workload, ["rabbitmqctl", "status", "--formatter=json"])
            return True
        except Unreachable:
            return False
