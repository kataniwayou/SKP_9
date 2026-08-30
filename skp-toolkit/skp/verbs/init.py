import argparse
import pathlib

from skp.clients.api import BaseApi
from skp.clients.cluster import ClusterClient, detect_binary
from skp.clients.es import Elastic
from skp.clients.http import HttpClient, Unreachable
from skp.clients.pg import Postgres
from skp.clients.prom import Prometheus
from skp.clients.rabbit import Rabbit
from skp.clients.redis import Redis
from skp.profile import Profile, default_home
from skp.result import EXIT_OK, EXIT_UNREACHABLE, Result

PROBE_ORDER = ["cluster", "postgres", "redis", "rabbitmq",
               "elasticsearch", "prometheus", "baseapi"]

DEFAULT_ENDPOINTS = {
    "baseapi": "http://baseapi-service:8080",
    "prometheus": "http://prometheus:9090",
    "elasticsearch": "http://elasticsearch:9200",
}


class ClusterProbe:
    """Adapts ClusterClient to the ping() shape the probe table expects."""

    def __init__(self, cluster):
        self.cluster = cluster

    def ping(self) -> bool:
        try:
            self.cluster.run(["get", "pods", "-o", "name"])
            return True
        except Unreachable:
            return False


class MissingBinary:
    """Stands in for the cluster client when neither oc nor kubectl is installed.

    A table with four rows missing is harder to act on than one with four named
    red rows, so the absence is reported per target rather than raised.
    """

    def __init__(self, detail: str):
        self.detail = detail

    def ping(self) -> bool:
        return False

    def exec(self, workload: str, argv: list[str]) -> str:
        raise Unreachable(workload, self.detail)

    def run(self, argv: list[str], target: str = "cluster") -> str:
        raise Unreachable(target, self.detail)


def build_clients(profile: Profile) -> dict:
    try:
        cluster = ClusterClient(profile.project, binary=detect_binary())
    except Unreachable as exc:
        cluster = MissingBinary(exc.detail)
    token = profile.token
    endpoints = {**DEFAULT_ENDPOINTS, **profile.endpoints}
    return {
        "cluster": ClusterProbe(cluster),
        "postgres": Postgres(cluster),
        "redis": Redis(cluster),
        "rabbitmq": Rabbit(cluster),
        "elasticsearch": Elastic(HttpClient(endpoints["elasticsearch"])),
        "prometheus": Prometheus(HttpClient(endpoints["prometheus"])),
        "baseapi": BaseApi(HttpClient(endpoints["baseapi"], token=token)),
    }


def probe(clients: dict) -> list[tuple[str, bool, str]]:
    """Ask every target once, in a fixed order, and never raise.

    An unreachable store must surface here, as a named red row -- not three days
    later as an empty result some verb reports as 'nothing found'.
    """
    rows: list[tuple[str, bool, str]] = []
    for name in PROBE_ORDER:
        client = clients[name]
        try:
            check = getattr(client, "ping", None) or getattr(client, "ready", None)
            if check is None:
                raise AttributeError(f"{name} client exposes neither ping() nor ready()")
            ok, detail = bool(check()), ""
        except Exception as exc:  # a probe reports; it does not propagate
            ok, detail = False, str(exc)
        rows.append((name, ok, detail))
    return rows


def render_table(rows: list[tuple[str, bool, str]]) -> str:
    width = max(len(name) for name, _, _ in rows)
    out = []
    for name, ok, detail in rows:
        status = "ok" if ok else "UNREACHABLE"
        line = f"  {name.ljust(width)}  {status}"
        out.append(f"{line}  {detail}".rstrip())
    return "\n".join(out)


def run(argv: list[str]) -> Result:
    parser = argparse.ArgumentParser(prog="skp init")
    parser.add_argument("--home", default=str(default_home()))
    parser.add_argument("--source-root", required=True)
    parser.add_argument("--cluster-url", required=True)
    parser.add_argument("--project", required=True)
    parser.add_argument("--token", default="")
    parser.add_argument("--endpoint", action="append", default=[],
                        metavar="NAME=URL", help="override a derived endpoint")
    parser.add_argument("--refresh", action="store_true")
    ns = parser.parse_args(argv)

    endpoints = dict(DEFAULT_ENDPOINTS)
    for pair in ns.endpoint:
        name, _, url = pair.partition("=")
        endpoints[name] = url

    profile = Profile(
        home=pathlib.Path(ns.home),
        source_root=ns.source_root,
        cluster_url=ns.cluster_url,
        project=ns.project,
        endpoints=endpoints,
    )
    profile.save(token=ns.token)

    rows = probe(build_clients(profile))
    lines = [f"memory folder: {profile.home}", "", render_table(rows)]
    dead = [name for name, ok, _ in rows if not ok]
    if dead:
        return Result(EXIT_UNREACHABLE,
                      [*lines, "", f"unreachable: {', '.join(dead)}"],
                      next_command="skp doctor")
    return Result(EXIT_OK, lines, next_command="skp map --intent observe")
