import argparse
import inspect
import pathlib

from skp.clients.api import BaseApi
from skp.clients.cluster import ClusterClient, active_server, detect_binary
from skp.clients.es import Elastic
from skp.clients.http import HttpClient, Unreachable
from skp.clients.pg import Postgres
from skp.clients.prom import Prometheus
from skp.clients.rabbit import Rabbit
from skp.clients.redis import Redis
from skp.compile.catalog import CatalogError
from skp.compile.driver import compile_catalog
from skp.profile import Profile, ProfileMissing, default_home, not_initialised
from skp.result import EXIT_DRIFT, EXIT_OK, EXIT_UNREACHABLE, EXIT_USAGE, Result

PROBE_ORDER = ["cluster", "postgres", "redis", "rabbitmq",
               "elasticsearch", "prometheus", "baseapi"]

DEFAULT_ENDPOINTS = {
    "baseapi": "http://baseapi-service:8080",
    "prometheus": "http://prometheus:9090",
    "elasticsearch": "http://elasticsearch:9200",
    # C2: the index/data stream is overridable through the same --endpoint
    # mechanism as the three URLs above -- not a URL itself, but the
    # mechanism only ever stores and hands back a string, so reusing it here
    # is cheap and keeps every profile override in one place instead of
    # inventing a second flag. Defaults to Elastic's own default rather than
    # a second hardcoded literal, for the same reason
    # driver.elasticsearch_index() does.
    "elasticsearch-index": inspect.signature(Elastic.__init__).parameters["index"].default,
}

ANNOTATIONS_DIR = pathlib.Path(__file__).resolve().parent.parent / "annotations"


class ClusterProbe:
    """Adapts ClusterClient to the ping() shape the probe table expects."""

    def __init__(self, cluster):
        self.cluster = cluster
        self.last_error = ""

    def ping(self) -> bool:
        try:
            self.cluster.run(["get", "pods", "-o", "name"])
            return True
        except Unreachable as exc:
            self.last_error = exc.detail
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
        cluster = ClusterClient(profile.project, binary=detect_binary(),
                                expected_server=profile.cluster_url)
    except Unreachable as exc:
        cluster = MissingBinary(exc.detail)
    token = profile.token
    endpoints = {**DEFAULT_ENDPOINTS, **profile.endpoints}
    return {
        "cluster": ClusterProbe(cluster),
        "postgres": Postgres(cluster),
        "redis": Redis(cluster),
        "rabbitmq": Rabbit(cluster),
        "elasticsearch": Elastic(HttpClient(endpoints["elasticsearch"]),
                                 index=endpoints["elasticsearch-index"]),
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
            if not ok:
                # A clean `False` (no exception) can still carry a reason: a
                # ping() that caught its own Unreachable records *why* on the
                # instance (see ClusterProbe/Postgres/Redis/Rabbit) rather
                # than discarding it -- without this, a cluster_url mismatch
                # renders as an unexplained dead row (Important 1).
                detail = getattr(client, "last_error", "") or ""
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
    parser.add_argument("--source-root")
    parser.add_argument("--cluster-url")
    parser.add_argument("--project")
    parser.add_argument("--token", default=None)
    parser.add_argument("--endpoint", action="append", default=[],
                        metavar="NAME=URL", help="override a derived endpoint")
    parser.add_argument("--refresh", action="store_true")
    ns = parser.parse_args(argv)

    home = pathlib.Path(ns.home)

    stored: Profile | None = None
    if ns.refresh:
        try:
            stored = Profile.load(home)
        except ProfileMissing:
            return not_initialised()

        source_root = ns.source_root if ns.source_root is not None else stored.source_root
        cluster_url = ns.cluster_url if ns.cluster_url is not None else stored.cluster_url
        project = ns.project if ns.project is not None else stored.project
    else:
        # --cluster-url is not in this required list: spec §5 says init asks
        # only for what it cannot derive, and the cluster's own active
        # context supplies it below when the flag is absent.
        missing = [flag for flag, value in
                   (("--source-root", ns.source_root),
                    ("--project", ns.project)) if value is None]
        if missing:
            return Result(EXIT_USAGE,
                          [f"missing required flag(s): {', '.join(missing)}"],
                          next_command="skp init --source-root <path> "
                                       "--cluster-url <url> --project <name>")
        source_root = ns.source_root
        cluster_url = ns.cluster_url
        project = ns.project

    if cluster_url is None:
        # A supplied --cluster-url is an assertion (verified once ClusterClient
        # starts making calls); an absent one is derived from the active
        # kube context, the same context every later call will use.
        try:
            cluster_url = active_server(detect_binary())
        except Unreachable as exc:
            return Result(EXIT_UNREACHABLE,
                          [f"could not derive --cluster-url from the active kube "
                           f"context: {exc.detail}",
                           "pass --cluster-url explicitly"],
                          next_command="skp init --source-root <path> "
                                       "--cluster-url <url> --project <name>")

    # Endpoint resolution layers, in order: the built-in defaults, then a
    # stored profile's overrides (--refresh only — there is nothing stored on
    # a fresh init), then --endpoint flags actually passed on this call.
    endpoints = dict(DEFAULT_ENDPOINTS)
    if stored is not None:
        endpoints.update(stored.endpoints)
    for pair in ns.endpoint:
        name, sep, url = pair.partition("=")
        if not sep or name not in DEFAULT_ENDPOINTS:
            # I7: an unknown or mistyped --endpoint name used to be accepted,
            # persisted, and then never read by anything -- it looks applied
            # and silently is not. postgres/redis/rabbitmq are not
            # configurable this way; their workloads are hardcoded in
            # pg.py/redis.py/rabbit.py (a deliberate deferral, see the brief).
            valid = ", ".join(sorted(DEFAULT_ENDPOINTS))
            return Result(EXIT_USAGE,
                          [f"--endpoint {pair!r}: expected NAME=URL with NAME one of: {valid}"],
                          next_command="skp init --endpoint <name>=<url> ...")
        endpoints[name] = url

    profile = Profile(
        home=home,
        source_root=source_root,
        cluster_url=cluster_url,
        project=project,
        endpoints=endpoints,
    )
    profile.save(token=ns.token)

    try:
        entries, problems = compile_catalog(
            pathlib.Path(source_root), ANNOTATIONS_DIR, profile.home / "model")
    except CatalogError as exc:
        return Result(EXIT_DRIFT,
                      [f"memory folder: {profile.home}",
                       "the annotation files contradict each other:",
                       *(f"  {line}" for line in str(exc).splitlines())],
                      next_command="skp doctor")

    rows = probe(build_clients(profile))
    lines = [f"memory folder: {profile.home}",
             f"catalogued {len(entries)} capabilities from {source_root}",
             "", render_table(rows)]

    dead = [name for name, ok, _ in rows if not ok]
    if problems:
        return Result(EXIT_DRIFT,
                      [*lines, "", f"{len(problems)} catalog problem(s):",
                       *(f"  {p}" for p in problems)],
                      next_command="skp doctor")
    if dead:
        return Result(EXIT_UNREACHABLE,
                      [*lines, "", f"unreachable: {', '.join(dead)}"],
                      next_command="skp doctor")
    return Result(EXIT_OK, lines, next_command="skp map --intent observe")
