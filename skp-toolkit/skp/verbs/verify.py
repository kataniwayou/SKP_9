"""``skp verify``: take the catalog's falsifiable claims to the running system.

``compile.py`` (``skp init``) proves the catalog is complete and internally
consistent. It proves nothing about whether the catalog is *true* -- three
real defects (Postgres table names, the Elasticsearch data stream default,
undocumented Prometheus labels) were fully catalogued, fully covered, zero
compile problems, and factually wrong about the live system. This module is
the missing check.

Three outcomes per claim, not two:

- CONFIRMED    -- the live system agrees.
- REFUTED      -- the live system contradicts the catalog. A real defect.
- NOT_OBSERVED -- the claim could not be exercised on a healthy system right
  now (a fault-path template's attribute, an empty key family). Legitimate,
  not a failure -- collapsing this into REFUTED makes the whole verb cry
  wolf.

A fourth outcome, at the component level rather than the per-claim level:
UNVERIFIABLE -- the store could not be reached at all, so nothing under it
was checked. "I could not check" and "the catalog is wrong" must never
render the same, so this drives a different exit code (EXIT_UNREACHABLE)
than a genuine refutation (EXIT_VERDICT).

NOT_APPLICABLE claims (a templated queue name, a POST route, a message
template) are reported for transparency but never affect the exit code.

This module never writes to or consumes from any store: every check below
is a read (SELECT count, list_queues, an instant query, a bounded search, a
GET, a bounded SCAN). It reuses ``skp init``'s ``build_clients``/``probe``
and ``skp map``'s ``load_catalog``/``by_component`` rather than inventing a
second probing implementation -- ``probe()`` answers "is it reachable",
which is a different question from the one this file answers: "is the
claim true".
"""
import argparse
import pathlib
import re
from collections import Counter, namedtuple

from skp.clients.http import Unreachable
from skp.profile import Profile, ProfileMissing, default_home, not_compiled, not_initialised
from skp.result import EXIT_OK, EXIT_UNREACHABLE, EXIT_VERDICT, Result
from skp.verbs.init import build_clients, probe
from skp.verbs.map import by_component, load_catalog

CONFIRMED = "CONFIRMED"
REFUTED = "REFUTED"
NOT_OBSERVED = "NOT_OBSERVED"
UNVERIFIABLE = "UNVERIFIABLE"
NOT_APPLICABLE = "NOT_APPLICABLE"

# Order claims are tallied and rendered in -- REFUTED first, so the thing
# that fails the command is never buried under a wall of CONFIRMED lines.
VERDICTS = (REFUTED, CONFIRMED, NOT_OBSERVED, UNVERIFIABLE, NOT_APPLICABLE)

Claim = namedtuple("Claim", ["component", "surface_id", "verdict", "message"])

# Catalog component name -> the key it lives under in build_clients()'s dict.
# Six of seven match themselves; the API component is catalogued as "api"
# but the client (and probe()'s row) is named "baseapi".
COMPONENT_CLIENT_KEY = {
    "postgres": "postgres",
    "redis": "redis",
    "rabbitmq": "rabbitmq",
    "elasticsearch": "elasticsearch",
    "prometheus": "prometheus",
    "api": "baseapi",
    "cluster": "cluster",
}


# ---------------------------------------------------------------------
# postgres
# ---------------------------------------------------------------------

_RELATION_MISSING = re.compile(r"does not exist", re.IGNORECASE)


def check_postgres(entries: list[dict], client) -> list[Claim]:
    """Each catalogued table's id already *is* the real (snake_case) table
    name (``pg_tables`` builds ``postgres.<table>``), so no parsing is
    needed to recover it. ``relation ... does not exist`` is the one
    Postgres error this defect actually produces (see the C1 fix note in
    ``extract.pg_tables``) -- anything else is a query that failed for some
    other reason, which is a claim skp verify could not check, not one it
    disproved.
    """
    claims = []
    for entry in entries:
        table = entry["id"].split(".", 1)[1]
        try:
            rows = client.rows(f"SELECT count(*) FROM {table}")
        except Unreachable as exc:
            if _RELATION_MISSING.search(exc.detail):
                claims.append(Claim("postgres", entry["id"], REFUTED,
                              f"catalog claims table {table!r} exists -- live: "
                              f"{exc.detail.strip().splitlines()[0]}"))
            else:
                claims.append(Claim("postgres", entry["id"], UNVERIFIABLE,
                              f"SELECT count(*) FROM {table} failed -- {exc.detail}"))
            continue
        count = rows[0][0] if rows and rows[0] else "0"
        claims.append(Claim("postgres", entry["id"], CONFIRMED, f"table {table}: {count} row(s)"))
    return claims


# ---------------------------------------------------------------------
# rabbitmq
# ---------------------------------------------------------------------

def check_rabbitmq(entries: list[dict], client) -> list[Claim]:
    """A queue name's own ``detail`` is the value ``queues()`` extracted from
    source -- concrete (``orchestrator-control``) or templated
    (``processor-{processorId}``, still carrying its ``{`` placeholder since
    ``expression_bodies`` preserves it). Templated names and the two
    dead-letter *exchanges* (``rabbitmq.processor.DeadLetterExchange``,
    ``rabbitmq.orchestrator.DeadLetterExchange``) are not queues at all --
    ``rabbitmqctl list_queues`` will never list them, and that absence is
    not a defect.
    """
    try:
        live = {q["name"] for q in client.queues()}
    except Unreachable as exc:
        return [Claim("rabbitmq", e["id"], UNVERIFIABLE, f"list_queues failed -- {exc.detail}")
                for e in entries]

    claims = []
    for entry in entries:
        name = entry["detail"]
        local = entry["id"].rsplit(".", 1)[-1]
        if "{" in name:
            claims.append(Claim("rabbitmq", entry["id"], NOT_APPLICABLE,
                          f"templated name, not a concrete queue: {name}"))
        elif local == "DeadLetterExchange":
            claims.append(Claim("rabbitmq", entry["id"], NOT_APPLICABLE,
                          f"exchange, not a queue: {name}"))
        elif name in live:
            claims.append(Claim("rabbitmq", entry["id"], CONFIRMED, f"queue {name!r} present"))
        else:
            claims.append(Claim("rabbitmq", entry["id"], REFUTED,
                          f"catalog claims queue {name!r} exists -- absent from "
                          f"rabbitmqctl list_queues"))
    return claims


# ---------------------------------------------------------------------
# elasticsearch
# ---------------------------------------------------------------------

_ES_PATH = re.compile(r"^(?:search by|read) (.+)$")


def _flatten_paths(obj, prefix: str = "") -> set[str]:
    """Every dotted path reachable in a (possibly nested) dict, built by
    joining container keys with ``.`` at each level -- which reconstructs a
    catalogued path like ``resource.attributes.service.instance.id``
    whether the document actually nests four objects deep, or nests two
    (``resource`` -> ``attributes``) and then holds a flat key that itself
    contains dots (``service.instance.id``). Either shape produces the same
    joined string, so this does not need to know which one the live mapping
    uses.
    """
    paths: set[str] = set()
    if isinstance(obj, dict):
        for key, value in obj.items():
            path = f"{prefix}.{key}" if prefix else key
            paths.add(path)
            paths |= _flatten_paths(value, path)
    return paths


def check_elasticsearch(entries: list[dict], client, sample_size: int = 200) -> list[Claim]:
    """The index/data stream is checked for existence (a plain bounded GET,
    never an aggregation); every ``elasticsearch.attr.*`` claim is sought in
    one bounded recent sample, sorted newest-first and capped at
    ``sample_size`` -- never an unbounded scan of a ~10M-document stream.
    Absent from the sample is NOT_OBSERVED, never REFUTED: four templates
    are fault-path records that do not fire on a healthy system, and their
    attributes (``Queue``, ``Reason``, ``Type``, ``WorkflowCount``)
    legitimately appear nowhere else. Message templates themselves
    (``elasticsearch.<TemplateName>``) are not attribute claims -- every one
    shares the literal operation text ``search by attributes.{OriginalFormat}``,
    so running the same attribute-path check on them would silently collide
    with the real ``original_format`` envelope field; they are reported
    NOT_APPLICABLE instead.
    """
    claims = []
    index_entries = [e for e in entries if e["id"] == "elasticsearch.index"]
    attr_entries = [e for e in entries if e["id"].startswith("elasticsearch.attr.")]
    other_entries = [e for e in entries
                     if e["id"] != "elasticsearch.index"
                     and not e["id"].startswith("elasticsearch.attr.")]

    for entry in other_entries:
        claims.append(Claim("elasticsearch", entry["id"], NOT_APPLICABLE,
                      "message template -- skp verify checks the index and "
                      "catalogued attributes only, not template text"))

    for entry in index_entries:
        claimed = entry["operation"].split(": ", 1)[-1]
        try:
            client.http.get_json(f"/{claimed}")
        except Unreachable as exc:
            if "HTTP 404" in exc.detail:
                claims.append(Claim("elasticsearch", entry["id"], REFUTED,
                              f"catalog claims default data stream {claimed!r} -- "
                              f"live: HTTP 404 (not found)"))
            else:
                claims.append(Claim("elasticsearch", entry["id"], UNVERIFIABLE,
                              f"could not check data stream {claimed!r} -- {exc.detail}"))
        else:
            claims.append(Claim("elasticsearch", entry["id"], CONFIRMED,
                          f"data stream {claimed!r} exists"))

    if not attr_entries:
        return claims

    try:
        hits = client.search({"size": sample_size, "sort": [{"@timestamp": {"order": "desc"}}]})
    except Unreachable as exc:
        claims += [Claim("elasticsearch", e["id"], UNVERIFIABLE,
                         f"bounded sample query failed -- {exc.detail}") for e in attr_entries]
        return claims

    observed: set[str] = set()
    for hit in hits:
        observed |= _flatten_paths(hit)

    for entry in attr_entries:
        match = _ES_PATH.match(entry["operation"])
        path = match.group(1) if match else entry["operation"]
        if path in observed:
            claims.append(Claim("elasticsearch", entry["id"], CONFIRMED,
                          f"{path} present in a {len(hits)}-document sample"))
        else:
            claims.append(Claim("elasticsearch", entry["id"], NOT_OBSERVED,
                          f"{path} not seen in a {len(hits)}-document recent sample "
                          f"-- may be a fault-path field or simply not recently written"))
    return claims


# ---------------------------------------------------------------------
# prometheus
# ---------------------------------------------------------------------

_METRIC_DETAIL = re.compile(r"^(\S+) \| (.+)$")
_TRAILING_SCOPE_NOTE = re.compile(r"\s*\([^()]*\)\s*$")

_SCRAPE_PLUMBING_EXACT = {"instance", "job", "otel_scope_name"}
_SCRAPE_PLUMBING_PREFIX = ("telemetry_sdk_", "exported_")


def _is_plumbing(label: str) -> bool:
    return label in _SCRAPE_PLUMBING_EXACT or label.startswith(_SCRAPE_PLUMBING_PREFIX)


def parse_metric_detail(detail: str):
    """``extract._metric_detail``'s three shapes, reversed.

    Returns ``(otel_name, labels)``. ``labels`` is ``None`` when the
    extractor itself never resolved a call site for this instrument (a
    parse miss, not a claim of zero labels) -- there is nothing to compare
    against reality in that case. An empty list means the extractor
    positively found the instrument and recorded that it carries no tags.
    A domain suffix (``disposition={acked|requeued|parked}``) is stripped
    down to the bare label name -- skp verify checks label *presence*, not
    the completeness of a hand-derived value domain.
    """
    match = _METRIC_DETAIL.match(detail)
    if not match:
        return None, None
    name, rest = match.group(1), match.group(2)
    if rest.startswith("no call site found"):
        return name, None
    if rest.startswith("no labels"):
        return name, []
    if rest.startswith("labels: "):
        body = _TRAILING_SCOPE_NOTE.sub("", rest[len("labels: "):])
        labels = [part.split("=", 1)[0].strip() for part in body.split(", ") if part.strip()]
        return name, labels
    return name, None


def check_prometheus(entries: list[dict], client) -> list[Claim]:
    """Two families of claim, in one pass so the second can reuse what the
    first observed.

    ``prometheus.pipeline_*`` claims one instrument each: resolve the real
    series name (OTel dots -> underscores; a counter gains ``_total``, a
    histogram ``_bucket``/``_sum``/``_count`` -- queried as one alternation
    rather than assumed, since the catalog does not record which shape an
    instrument is) and confirm every claimed label is actually a key on a
    live series. A claimed-but-absent label is REFUTED -- this is the C3
    defect class. A present-but-uncatalogued label is noted, never failed:
    scrape plumbing legitimately is not ours. Zero live series at all is
    NOT_OBSERVED, not REFUTED -- an instrument that has not fired recently
    is not proof the catalog is wrong.

    ``prometheus.label.*`` claims a resource- or histogram-level label
    (``service_instance_id``, ``le``, ...) that is not tied to one
    instrument. Checked against the union of labels already observed above
    rather than a fresh query: cheaper, and it is exactly what "does this
    label appear on a live series" means.
    """
    claims = []
    observed_all: set[str] = set()

    instrument_entries = [e for e in entries if e["id"].startswith("prometheus.pipeline_")]
    label_entries = [e for e in entries if e["id"].startswith("prometheus.label.")]

    for entry in instrument_entries:
        name, labels = parse_metric_detail(entry["detail"])
        if name is None:
            claims.append(Claim("prometheus", entry["id"], UNVERIFIABLE,
                          "could not parse an instrument name out of the catalog detail"))
            continue
        base = name.replace(".", "_")
        try:
            series = client.query(f'{{__name__=~"^{base}(_total|_bucket|_sum|_count)?$"}}')
        except Exception as exc:  # pragma: no cover -- Prometheus.query() itself never raises
            claims.append(Claim("prometheus", entry["id"], UNVERIFIABLE, f"query failed -- {exc}"))
            continue

        if not series:
            claims.append(Claim("prometheus", entry["id"], NOT_OBSERVED,
                          f"no live series matching {base}* -- instrument may not have "
                          f"fired recently"))
            continue

        observed = set()
        for s in series:
            observed |= (set(s.get("metric", {})) - {"__name__"})
        observed_all |= observed

        if labels is None:
            claims.append(Claim("prometheus", entry["id"], NOT_OBSERVED,
                          f"{len(series)} live series, but the extractor never resolved "
                          f"this instrument's claimed labels -- nothing to compare"))
            continue

        missing = [label for label in labels if label not in observed]
        if missing:
            claims.append(Claim("prometheus", entry["id"], REFUTED,
                          f"claims label(s) {', '.join(missing)} -- live series carry: "
                          f"{', '.join(sorted(observed)) or '(none)'}"))
        else:
            extra = sorted(label for label in observed - set(labels) if not _is_plumbing(label))
            note = f"; uncatalogued live label(s): {', '.join(extra)}" if extra else ""
            claims.append(Claim("prometheus", entry["id"], CONFIRMED,
                          f"{len(series)} live series, every claimed label present{note}"))

    for entry in label_entries:
        label = entry["id"].rsplit(".", 1)[-1]
        if label in observed_all:
            claims.append(Claim("prometheus", entry["id"], CONFIRMED,
                          f"label {label!r} seen on a live series checked this run"))
        else:
            claims.append(Claim("prometheus", entry["id"], NOT_OBSERVED,
                          f"label {label!r} not seen on any live series checked this run "
                          f"-- e.g. processorId only appears on a processor host, le only "
                          f"on a histogram"))

    return claims


# ---------------------------------------------------------------------
# api
# ---------------------------------------------------------------------

_HTTP_STATUS = re.compile(r"^HTTP (\d+)")


def check_api(entries: list[dict], client) -> list[Claim]:
    """Only a catalogued ``GET`` route with no path parameter is checked --
    a route needing an id has nothing safe to substitute, and every other
    verb is a write this read-only command must never perform. An
    ``Unreachable`` whose detail starts with an HTTP status is the server
    actually answering with something other than 2xx (REFUTED); anything
    else is a connection-level failure this specific request hit despite
    the overall reachability probe passing, which is a claim skp verify
    could not check rather than one it disproved.
    """
    claims = []
    for entry in entries:
        operation = entry["operation"]
        if not operation.startswith("GET "):
            claims.append(Claim("api", entry["id"], NOT_APPLICABLE,
                          f"not a read: {operation}"))
            continue
        path = operation[len("GET "):]
        if "{" in path:
            claims.append(Claim("api", entry["id"], NOT_APPLICABLE,
                          f"requires a path parameter: {operation}"))
            continue
        try:
            client.http.get_json(path)
        except Unreachable as exc:
            status = _HTTP_STATUS.match(exc.detail)
            if status:
                claims.append(Claim("api", entry["id"], REFUTED,
                              f"catalog claims GET {path} -> 2xx -- live: HTTP {status.group(1)}"))
            else:
                claims.append(Claim("api", entry["id"], UNVERIFIABLE,
                              f"GET {path} failed -- {exc.detail}"))
        else:
            claims.append(Claim("api", entry["id"], CONFIRMED, f"GET {path} -> 2xx"))
    return claims


# ---------------------------------------------------------------------
# redis
# ---------------------------------------------------------------------

_PLACEHOLDER = re.compile(r"\{[^}]*\}")


def check_redis(entries: list[dict], client) -> list[Claim]:
    """Every ``{placeholder}`` in a catalogued key pattern becomes ``*`` for
    a ``SCAN MATCH``. Zero keys is NOT_OBSERVED, never REFUTED: a key
    family that is empty because nothing is mid-flight (``skp:data:*`` on
    an idle system) is normal, not wrong -- there is no live-system fact
    that contradicts "this key pattern exists in the schema".
    """
    claims = []
    for entry in entries:
        pattern = _PLACEHOLDER.sub("*", entry["detail"])
        try:
            keys = client.keys(pattern)
        except Unreachable as exc:
            claims.append(Claim("redis", entry["id"], UNVERIFIABLE,
                          f"SCAN {pattern} failed -- {exc.detail}"))
            continue
        if keys:
            claims.append(Claim("redis", entry["id"], CONFIRMED,
                          f"{len(keys)} key(s) matching {pattern}"))
        else:
            claims.append(Claim("redis", entry["id"], NOT_OBSERVED,
                          f"no live keys matching {pattern}"))
    return claims


# ---------------------------------------------------------------------
# cluster
# ---------------------------------------------------------------------

def check_cluster(entries: list[dict], raw_cluster) -> list[Claim]:
    """The four ``cluster.*`` operations, exercised read-only against a
    workload every skp-toolkit client already assumes exists
    (``sts/postgres`` -- see ``clients/pg.py``) rather than a hardcoded
    guess. None of these has a live-system fact to contradict the way a
    missing table or queue does -- "does `oc get pods` still work" is a
    mechanism question, not a factual claim -- so a failure here is
    UNVERIFIABLE, never REFUTED. ``rollout status`` is bounded with
    ``--timeout=5s`` so a genuinely stuck rollout cannot hang this command.
    """
    by_id = {e["id"]: e for e in entries}
    claims = []
    pods: list[str] = []

    if "cluster.get_pods" in by_id:
        entry = by_id["cluster.get_pods"]
        try:
            out = raw_cluster.run(["get", "pods", "-o", "name"])
        except Unreachable as exc:
            claims.append(Claim("cluster", entry["id"], UNVERIFIABLE, str(exc)))
        else:
            pods = [line for line in out.splitlines() if line.strip()]
            claims.append(Claim("cluster", entry["id"],
                          CONFIRMED if pods else NOT_OBSERVED,
                          f"{len(pods)} pod(s)" if pods else "no pods in project"))

    if "cluster.get_json" in by_id:
        entry = by_id["cluster.get_json"]
        try:
            raw_cluster.run(["get", "sts/postgres", "-o", "json"])
        except Unreachable as exc:
            claims.append(Claim("cluster", entry["id"], UNVERIFIABLE, str(exc)))
        else:
            claims.append(Claim("cluster", entry["id"], CONFIRMED,
                          "get sts/postgres -o json succeeded"))

    if "cluster.rollout_status" in by_id:
        entry = by_id["cluster.rollout_status"]
        try:
            raw_cluster.run(["rollout", "status", "sts/postgres", "--timeout=5s"])
        except Unreachable as exc:
            claims.append(Claim("cluster", entry["id"], UNVERIFIABLE, str(exc)))
        else:
            claims.append(Claim("cluster", entry["id"], CONFIRMED,
                          "rollout status sts/postgres succeeded"))

    if "cluster.logs" in by_id:
        entry = by_id["cluster.logs"]
        pod = next((p.split("/", 1)[-1] for p in pods if "postgres" in p),
                  pods[0].split("/", 1)[-1] if pods else None)
        if pod is None:
            claims.append(Claim("cluster", entry["id"], NOT_OBSERVED,
                          "no pod available in this project to read logs from"))
        else:
            try:
                raw_cluster.run(["logs", pod, "--tail=1"])
            except Unreachable as exc:
                claims.append(Claim("cluster", entry["id"], UNVERIFIABLE, str(exc)))
            else:
                claims.append(Claim("cluster", entry["id"], CONFIRMED,
                              f"logs {pod} --tail=1 succeeded"))

    return claims


# ---------------------------------------------------------------------
# orchestration
# ---------------------------------------------------------------------

def verify_all(entries: list[dict], clients: dict, component: str | None = None) -> list[Claim]:
    """Gate on reachability once, per component, the same way ``skp doctor``
    does -- reusing ``init.probe()`` rather than a second probing
    implementation. A component that does not answer gets every one of its
    claims marked UNVERIFIABLE without a single query being attempted
    against it: "I could not check" must never be produced by actually
    trying and getting a confusing half-answer.
    """
    rows = probe(clients)
    reachable = {name: ok for name, ok, _ in rows}
    detail_by = {name: detail for name, _, detail in rows}

    wanted = [component] if component else list(COMPONENT_CLIENT_KEY)
    claims: list[Claim] = []
    for comp in wanted:
        comp_entries = by_component(entries, comp)
        client_key = COMPONENT_CLIENT_KEY[comp]
        if not reachable.get(client_key, False):
            reason = detail_by.get(client_key) or "no answer"
            claims += [Claim(comp, e["id"], UNVERIFIABLE, f"{comp} unreachable -- {reason}")
                      for e in comp_entries]
            continue

        if comp == "postgres":
            claims += check_postgres(comp_entries, clients["postgres"])
        elif comp == "redis":
            claims += check_redis(comp_entries, clients["redis"])
        elif comp == "rabbitmq":
            claims += check_rabbitmq(comp_entries, clients["rabbitmq"])
        elif comp == "elasticsearch":
            claims += check_elasticsearch(comp_entries, clients["elasticsearch"])
        elif comp == "prometheus":
            claims += check_prometheus(comp_entries, clients["prometheus"])
        elif comp == "api":
            claims += check_api(comp_entries, clients["baseapi"])
        elif comp == "cluster":
            claims += check_cluster(comp_entries, clients["cluster"].cluster)
    return claims


def render_report(claims: list[Claim], component: str | None = None) -> list[str]:
    header = "skp verify" + (f" --component {component}" if component else "")
    lines = [header, ""]

    by_comp: dict[str, list[Claim]] = {}
    for claim in claims:
        by_comp.setdefault(claim.component, []).append(claim)

    for comp in sorted(by_comp):
        comp_claims = by_comp[comp]
        counts = Counter(c.verdict for c in comp_claims)
        summary = ", ".join(f"{counts[v]} {v.lower()}" for v in VERDICTS if counts[v])
        lines.append(f"  {comp}: {summary}  ({len(comp_claims)} catalogued)")
    lines.append("")

    refuted = [c for c in claims if c.verdict == REFUTED]
    if refuted:
        lines.append(f"REFUTED ({len(refuted)}) -- the catalog is wrong about these:")
        for c in refuted:
            lines.append(f"  {c.surface_id}: {c.message}")
        lines.append("")

    unverifiable = [c for c in claims if c.verdict == UNVERIFIABLE]
    if unverifiable:
        comps = sorted({c.component for c in unverifiable})
        lines.append(f"UNVERIFIABLE ({len(unverifiable)}) -- could not be checked, not "
                     f"disproved: {', '.join(comps)}")
        lines.append("")

    if not refuted and not unverifiable:
        lines.append("no refutations -- every checkable claim is confirmed or legitimately "
                     "not observed")

    return lines


def run_with(entries: list[dict], clients: dict, component: str | None = None) -> Result:
    claims = verify_all(entries, clients, component=component)
    lines = render_report(claims, component)

    if any(c.verdict == REFUTED for c in claims):
        return Result(EXIT_VERDICT, lines, next_command="skp doctor")
    if any(c.verdict == UNVERIFIABLE for c in claims):
        return Result(EXIT_UNREACHABLE, lines, next_command="skp verify")
    return Result(EXIT_OK, lines, next_command="skp map --intent observe")


def run(argv: list[str]) -> Result:
    parser = argparse.ArgumentParser(prog="skp verify")
    parser.add_argument("--home", default=str(default_home()))
    parser.add_argument("--component", choices=sorted(COMPONENT_CLIENT_KEY))
    ns = parser.parse_args(argv)

    home = pathlib.Path(ns.home)
    if not (home / "profile.json").exists():
        return not_initialised()

    try:
        profile = Profile.load(home)
        entries = load_catalog(home)
    except ProfileMissing:
        return not_compiled(home)

    return run_with(entries, build_clients(profile), component=ns.component)
