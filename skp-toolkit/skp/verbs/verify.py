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

NOT_APPLICABLE claims -- a write verb this read-only command must never
exercise by default, or a route with more path parameters than this file
has a rule to resolve -- are reported for transparency (each with a reason
stating *why* it cannot be checked, not merely that it was skipped) but
never affect the exit code. A templated queue name and a message template
are NOT applicable skips: both are resolved and actually checked (see
``check_rabbitmq`` and ``check_elasticsearch``).

By default this module never writes to or consumes from any store: every
check is a read (SELECT count, list_queues, an instant query, a bounded
search, a GET, a bounded SCAN). It reuses ``skp init``'s
``build_clients``/``probe`` and ``skp map``'s ``load_catalog``/``by_component``
rather than inventing a second probing implementation -- ``probe()``
answers "is it reachable", which is a different question from the one this
file answers: "is the claim true".

**``--probe-writes`` is the one opt-in exception**, and it bends the
strictly-read-only guarantee on purpose rather than by accident -- which is
exactly why it must be asked for, not discovered. ``BaseApi.Service``
controllers carry ``[ApiController]``, so ASP.NET's model-state validation
short-circuits a malformed request to HTTP 400 *before the action body ever
runs* -- ``CreateAsync``/``UpdateAsync``/``DeleteAsync`` are never entered,
so nothing is created, updated or deleted. That gives a route-existence
proof this file can extract without ever performing the write it is proving
exists:

- Every catalogued write route (17 of them: ``POST``/``PUT``/``DELETE`` on
  the five entity controllers, plus ``POST orchestration/start`` and
  ``POST orchestration/stop``) is sent an empty JSON object (``{}``) as its
  body -- a positional record with any required field fails to bind against
  ``{}``, and ``orchestration/start``/``stop`` bind a bare ``Guid`` from the
  body, which ``{}`` cannot satisfy either.
- A route with an ``{id}`` placeholder (every ``PUT``/``DELETE``) gets a
  freshly generated ``uuid4`` in that placeholder -- never an id read from
  the live system. A real id plus some unexpected server behaviour is the
  one path that could actually delete or overwrite something; a guid this
  process just generated cannot collide with a real row.
- 400/405/422 confirms the route: wired, and the request was rejected
  before the action ran. 404 on a route with **no** id placeholder
  (``POST``) means the path itself did not match anything -- the catalogued
  route does not exist, a real refutation. 404 on a route **with** an id
  placeholder is the not-found handler doing exactly its job for a guid
  guaranteed not to exist -- proof the route ran and rejected the request,
  not proof it is missing -- so it is treated the same as 400/405/422.
  **Any 2xx is REFUTED, loudly**, flagged with a ``MUTATION WARNING`` in its
  message: it would mean model-state validation did not short-circuit the
  way this whole probe assumes, and the request may actually have written
  something. 5xx and transport failures are UNVERIFIABLE -- a probe that
  could not get a clean answer either way.

Without the flag, every write claim stays NOT_APPLICABLE, its reason now
naming the remedy (``rerun with --probe-writes``) rather than just stating
the limitation.
"""
import argparse
import pathlib
import re
import uuid
from collections import Counter, namedtuple

from skp.clients.http import Unreachable
from skp.profile import Profile, ProfileMissing, default_home, not_compiled, not_initialised
from skp.result import EXIT_OK, EXIT_UNREACHABLE, EXIT_VERDICT, Result
from skp.verbs.init import build_clients, probe
from skp.verbs.investigate import _original_format_filter
from skp.verbs.map import by_component, load_catalog
from skp.verbs.observe import _fill

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
    needed to recover it. The identifier is double-quoted in the query --
    unquoted, Postgres folds it to lowercase before matching, so a
    regression back to the PascalCase ``DbSet`` property name (the C1
    defect this verb exists to catch) would fold to the real lowercase
    table and silently pass. Quoted, the comparison is exact: the catalog
    claims one specific spelling, and only that spelling confirms it.
    ``relation ... does not exist`` is the one Postgres error this defect
    actually produces (see the C1 fix note in ``extract.pg_tables``) --
    anything else is a query that failed for some other reason, which is a
    claim skp verify could not check, not one it disproved.
    """
    claims = []
    for entry in entries:
        table = entry["id"].split(".", 1)[1]
        try:
            rows = client.rows(f'SELECT count(*) FROM "{table}"')
        except Unreachable as exc:
            if _RELATION_MISSING.search(exc.detail):
                claims.append(Claim("postgres", entry["id"], REFUTED,
                              f"catalog claims table {table!r} exists -- live: "
                              f"{exc.detail.strip().splitlines()[0]}"))
            else:
                claims.append(Claim("postgres", entry["id"], UNVERIFIABLE,
                              f'SELECT count(*) FROM "{table}" failed -- {exc.detail}'))
            continue
        count = rows[0][0] if rows and rows[0] else "0"
        claims.append(Claim("postgres", entry["id"], CONFIRMED, f"table {table}: {count} row(s)"))
    return claims


# ---------------------------------------------------------------------
# rabbitmq
# ---------------------------------------------------------------------

def check_rabbitmq(entries: list[dict], client, processor_ids: list[str] | None = None) -> list[Claim]:
    """A queue name's own ``detail`` is the value ``queues()`` extracted from
    source -- concrete (``orchestrator-control``) or templated
    (``processor-{processorId}``, still carrying its ``{`` placeholder since
    ``expression_bodies`` preserves it).

    A templated name is resolved, not skipped: every id in ``processor_ids``
    (the caller's job -- ``verify_all`` resolves them from the ``processors``
    table or the BaseAPI list, since this function only owns the rabbitmq
    client) fills the placeholder via ``_fill``, and each concrete name is
    checked against ``list_queues`` the same as a literal one. This is the
    whole point of resolving a template: a resolved name that is genuinely
    absent is REFUTED, not waved through as NOT_APPLICABLE. ``processor_ids
    is None`` means the caller could not resolve any -- both API and
    Postgres were unreachable -- which is UNVERIFIABLE (a gap in what this
    run could check), distinct from ``[]`` (resolution worked and found zero
    processors registered, a fact worth NOT_OBSERVED, not a failure).

    The two dead-letter *exchanges* (``rabbitmq.processor.DeadLetterExchange``,
    ``rabbitmq.orchestrator.DeadLetterExchange``) are not queues at all --
    ``rabbitmqctl list_queues`` will never list them -- so they are checked
    against ``list_exchanges`` instead, read-only exactly like ``queues()``.
    """
    try:
        live = {q["name"] for q in client.queues()}
    except Unreachable as exc:
        return [Claim("rabbitmq", e["id"], UNVERIFIABLE, f"list_queues failed -- {exc.detail}")
                for e in entries]

    exchanges_ok = True
    exchanges_err = ""
    live_exchanges: set[str] = set()
    if any(e["id"].rsplit(".", 1)[-1] == "DeadLetterExchange" for e in entries):
        try:
            live_exchanges = {x["name"] for x in client.exchanges()}
        except Unreachable as exc:
            exchanges_ok = False
            exchanges_err = exc.detail

    claims = []
    for entry in entries:
        name = entry["detail"]
        local = entry["id"].rsplit(".", 1)[-1]
        if local == "DeadLetterExchange":
            if not exchanges_ok:
                claims.append(Claim("rabbitmq", entry["id"], UNVERIFIABLE,
                              f"list_exchanges failed -- {exchanges_err}"))
            elif name in live_exchanges:
                claims.append(Claim("rabbitmq", entry["id"], CONFIRMED,
                              f"exchange {name!r} present"))
            else:
                claims.append(Claim("rabbitmq", entry["id"], REFUTED,
                              f"catalog claims exchange {name!r} exists -- absent from "
                              f"rabbitmqctl list_exchanges"))
        elif "{" in name:
            if processor_ids is None:
                claims.append(Claim("rabbitmq", entry["id"], UNVERIFIABLE,
                              f"templated name {name!r} -- could not resolve real "
                              f"processor ids (both the processors API and Postgres "
                              f"were unreachable)"))
            elif not processor_ids:
                claims.append(Claim("rabbitmq", entry["id"], NOT_OBSERVED,
                              f"templated name {name!r} -- no processors registered "
                              f"to resolve it against"))
            else:
                resolved = [_fill(name, processorId=pid) for pid in processor_ids]
                missing = [r for r in resolved if r not in live]
                if missing:
                    claims.append(Claim("rabbitmq", entry["id"], REFUTED,
                                  f"catalog claims {name!r} resolves to a live queue "
                                  f"for every registered processor -- missing: "
                                  f"{', '.join(missing)}"))
                else:
                    claims.append(Claim("rabbitmq", entry["id"], CONFIRMED,
                                  f"{name!r} resolved and present for all "
                                  f"{len(resolved)} registered processor(s)"))
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
    legitimately appear nowhere else.

    Message templates (``elasticsearch.<TemplateName>``) ARE checkable, and
    are checked -- each one's own ``detail`` (the raw template text, e.g.
    ``"entry step {StepId} dispatched"``) is exactly what
    ``attributes.{OriginalFormat}`` carries verbatim on a real record, so a
    bounded term (or, for the handful whose template contains an em dash
    mangled by the OTel pipeline, prefix -- ``investigate._original_format_filter``,
    reused rather than re-solved here) query against that one field answers
    the claim directly. It is bounded by ``size=1``, not a time range: a term
    lookup on an indexed field costs the same whether the stream holds ten
    documents or ten million, so a result-count cap is what "bounded" means
    here (the sibling attribute check below bounds by time instead, because
    ``present in a recent sample`` is a different question than ``was this
    template ever emitted``). A template that never appears is NOT_OBSERVED,
    not REFUTED -- some are fault-path records that legitimately do not fire
    on a healthy system, and this check cannot tell "never happens" apart
    from "did not happen in a snapshot" any more than the attribute check
    below can.
    """
    claims = []
    index_entries = [e for e in entries if e["id"] == "elasticsearch.index"]
    attr_entries = [e for e in entries if e["id"].startswith("elasticsearch.attr.")]
    template_entries = [e for e in entries
                        if e["id"] != "elasticsearch.index"
                        and not e["id"].startswith("elasticsearch.attr.")]

    for entry in template_entries:
        template = entry["detail"]
        query = {"size": 1, "query": {"bool": {"filter": [_original_format_filter(template)]}}}
        try:
            hits = client.search(query)
        except Unreachable as exc:
            claims.append(Claim("elasticsearch", entry["id"], UNVERIFIABLE,
                          f"template query failed -- {exc.detail}"))
            continue
        if hits:
            claims.append(Claim("elasticsearch", entry["id"], CONFIRMED,
                          "attributes.{OriginalFormat} matches this template at least once"))
        else:
            claims.append(Claim("elasticsearch", entry["id"], NOT_OBSERVED,
                          "attributes.{OriginalFormat} never matches this template -- "
                          "likely a fault-path record that does not fire on a healthy system"))

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
    series name and confirm every claimed label is actually a key on a live
    series. A claimed-but-absent label is REFUTED -- this is the C3 defect
    class. A present-but-uncatalogued label is noted, never failed: scrape
    plumbing legitimately is not ours.

    **Name resolution is one optional trailing segment, not an enumerated
    list.** OTel dots become underscores, and the exporter appends the
    Prometheus type suffix (``_total``, ``_bucket``/``_sum``/``_count``) --
    but first, when the instrument was created with a non-empty ``unit:``,
    an OTel-derived unit segment (``_seconds`` for unit ``s``, ``_ratio``
    for unit ``1``, ...). A regression here is exactly how 9 of these 16
    instruments were originally found NOT_OBSERVED though a live series
    existed for every one of them: e.g. ``pipeline.consumer.duration`` (unit
    ``s``) is really named ``pipeline_consumer_duration_seconds_bucket``,
    and a query for ``pipeline_consumer_duration(_total|_bucket|_sum|_count)?``
    matches nothing. Rather than hand-list every OTel unit string this
    codebase happens to use today, the regex accepts any single trailing
    ``_word`` segment (``(_\\w+)?``) after the base name -- exactly as
    already-generic as the sibling attribute-path check.

    Zero live series at the query instant is not immediately NOT_OBSERVED: a
    plain instant query only sees a series with a sample inside Prometheus's
    own 5-minute lookback window, and an instrument that legitimately fires
    less often than that would otherwise be misreported as absent. A second,
    still-bounded probe -- ``count_over_time(...[1h])``, one more read, no
    aggregation beyond a per-series count -- answers "did this exist at all
    recently" before giving up. Zero series on *both* probes is NOT_OBSERVED,
    not REFUTED -- an instrument that truly has not fired is not proof the
    catalog is wrong.

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
        # PromQL string literals interpret backslash escapes themselves (Go string
        # rules), so a literal single-backslash \w for the regex engine underneath
        # has to be written as \\w on the wire -- one Python-level escape to get
        # each backslash character into the string, doubled again for PromQL's own
        # unescaping. Confirmed against the live cluster: a single \w 400s with
        # "unknown escape sequence" before ever reaching the regex engine.
        expr = f'{{__name__=~"^{base}(_\\\\w+)?$"}}'
        try:
            series = client.query(expr)
        except Exception as exc:  # pragma: no cover -- Prometheus.query() itself never raises
            claims.append(Claim("prometheus", entry["id"], UNVERIFIABLE, f"query failed -- {exc}"))
            continue

        range_note = ""
        if not series:
            try:
                series = client.query(f'count_over_time({expr}[1h])')
            except Exception as exc:  # pragma: no cover -- Prometheus.query() itself never raises
                claims.append(Claim("prometheus", entry["id"], UNVERIFIABLE, f"query failed -- {exc}"))
                continue
            if series:
                range_note = " (no sample at the query instant -- found via a 1h range existence check)"

        if not series:
            claims.append(Claim("prometheus", entry["id"], NOT_OBSERVED,
                          f"no live series matching {base}* -- neither an instant query nor a "
                          f"1h range existence check found one; the instrument may not have "
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
            extra_note = f"; uncatalogued live label(s): {', '.join(extra)}" if extra else ""
            claims.append(Claim("prometheus", entry["id"], CONFIRMED,
                          f"{len(series)} live series, every claimed label present"
                          f"{extra_note}{range_note}"))

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
_API_PLACEHOLDER = re.compile(r"\{(\w+)\}")


def _field_values(items: list, field_lower: str) -> list:
    """Every value, in order, of the key on each dict in ``items`` whose
    lowercased name matches ``field_lower`` -- case-insensitive because the
    live API's JSON casing (camelCase, e.g. ``sourceHash``) is a fact about
    the running system, not something this file should assume."""
    out = []
    for item in items:
        if not isinstance(item, dict):
            continue
        for key, value in item.items():
            if key.lower() == field_lower:
                out.append(value)
                break
    return out


def _first_field(items: list, field_lower: str):
    values = _field_values(items, field_lower)
    return values[0] if values else None


def _check_get(claims: list[Claim], entry: dict, client, path: str, note: str = "") -> None:
    try:
        client.http.get_json(path)
    except Unreachable as exc:
        status = _HTTP_STATUS.match(exc.detail)
        if status:
            claims.append(Claim("api", entry["id"], REFUTED,
                          f"catalog claims GET {path} -> 2xx{note} -- live: HTTP {status.group(1)}"))
        else:
            claims.append(Claim("api", entry["id"], UNVERIFIABLE,
                          f"GET {path} failed -- {exc.detail}"))
    else:
        claims.append(Claim("api", entry["id"], CONFIRMED, f"GET {path} -> 2xx{note}"))


_WRITE_CONFIRM_STATUSES = (400, 405, 422)


def _classify_write_status(status: int, has_id: bool) -> tuple[str, str, bool]:
    """Maps one ``--probe-writes`` HTTP status to ``(verdict, reason,
    is_mutation_warning)`` -- see the module docstring for the full
    rationale. Split out from ``_probe_write`` so the mapping itself (the
    part the assumption actually lives in) is unit-testable against bare
    status codes, with no HTTP client involved at all.
    """
    if status in _WRITE_CONFIRM_STATUSES:
        return CONFIRMED, "route wired, request rejected before the action ran", False
    if status == 404:
        if has_id:
            return (CONFIRMED,
                    "route wired -- 404 via the not-found handler for a guid guaranteed "
                    "not to exist", False)
        return REFUTED, "catalogued route does not exist", False
    if 200 <= status < 300:
        return (REFUTED,
                "expected the request to be rejected before the action ran; a 2xx means "
                "that did not happen, and this request may have mutated state", True)
    return UNVERIFIABLE, f"unexpected status {status} -- neither a rejection nor a 2xx", False


def _probe_write(entry: dict, client) -> Claim:
    """Sends the one deliberately-invalid probe for a single catalogued
    write route and returns its verdict. See the module docstring for what
    is sent and why nothing can be written.
    """
    method, path = entry["operation"].split(" ", 1)
    placeholders = _API_PLACEHOLDER.findall(path)
    has_id = bool(placeholders)
    note = ""
    if has_id:
        guid = str(uuid.uuid4())
        for placeholder in placeholders:
            path = path.replace("{" + placeholder + "}", guid)
        note = f" (id={guid}, freshly generated -- cannot exist)"

    try:
        status = client.http.probe_status(method, path, {})
    except Unreachable as exc:
        return Claim("api", entry["id"], UNVERIFIABLE,
                    f"{method} {path} with an empty body{note} -- transport failure, "
                    f"not a response: {exc.detail}")

    verdict, why, is_mutation = _classify_write_status(status, has_id)
    tag = "MUTATION WARNING: " if is_mutation else ""
    return Claim("api", entry["id"], verdict,
                f"{tag}{method} {path} with an empty body{note} -> HTTP {status} -- {why}")


def check_api(entries: list[dict], client, probe_writes: bool = False) -> list[Claim]:
    """Only a ``GET`` route is exercised by default -- every other verb is a
    write, reported NOT_APPLICABLE naming the remedy (``--probe-writes``),
    not a bare "skipped". With ``probe_writes=True`` every write route is
    instead sent through ``_probe_write`` (see the module docstring).

    A single ``{id}`` (or ``{sourceHash}``) placeholder on a ``GET`` route is
    resolved, not waved through: the entity's own list route
    (``entry["detail"]``, already confirmed or refuted by its own catalog
    entry) is fetched once per entity and cached, and the first row's
    matching field fills the placeholder -- ``{sourceHash}`` lowercased
    first, since matching is byte-exact against a stored lowercase hex
    string (the catalogued trap). Zero rows to resolve from is NOT_OBSERVED
    (nothing exists to check against, not a defect); the list route itself
    failing is UNVERIFIABLE (a gap in what this run could check). A ``GET``
    route with more than one placeholder, or one this file has no
    field-matching rule for, stays NOT_APPLICABLE -- an honest "cannot
    safely resolve this". (A write route's ``{id}`` never goes through this
    resolution at all -- ``_probe_write`` always fills it with a freshly
    generated guid instead, by design.)

    An ``Unreachable`` whose detail starts with an HTTP status is the server
    actually answering with something other than 2xx (REFUTED); anything
    else is a connection-level failure this specific request hit despite
    the overall reachability probe passing, which is a claim skp verify
    could not check rather than one it disproved.
    """
    claims: list[Claim] = []
    list_cache: dict[str, list | Unreachable] = {}

    def fetch_list(entity: str):
        if entity not in list_cache:
            try:
                list_cache[entity] = client.list(entity)
            except Unreachable as exc:
                list_cache[entity] = exc
        return list_cache[entity]

    for entry in entries:
        operation = entry["operation"]
        entity = entry["detail"]
        if not operation.startswith("GET "):
            if probe_writes:
                claims.append(_probe_write(entry, client))
            else:
                verb = operation.split(" ", 1)[0]
                claims.append(Claim("api", entry["id"], NOT_APPLICABLE,
                              f"{verb} -- write verb, not exercised read-only by default "
                              f"-- rerun with --probe-writes to confirm the route is wired "
                              f"(a deliberately invalid body proves it without writing "
                              f"anything)"))
            continue

        path = operation[len("GET "):]
        placeholders = _API_PLACEHOLDER.findall(path)
        if not placeholders:
            _check_get(claims, entry, client, path)
            continue
        if len(placeholders) > 1:
            claims.append(Claim("api", entry["id"], NOT_APPLICABLE,
                          f"{len(placeholders)} path parameters -- nothing safe to "
                          f"resolve them from: {operation}"))
            continue

        placeholder = placeholders[0]
        items = fetch_list(entity)
        if isinstance(items, Unreachable):
            claims.append(Claim("api", entry["id"], UNVERIFIABLE,
                          f"could not resolve a real {{{placeholder}}} -- GET /{entity} "
                          f"failed: {items.detail}"))
            continue

        value = _first_field(items, placeholder.lower())
        if value is None:
            claims.append(Claim("api", entry["id"], NOT_OBSERVED,
                          f"no {entity} row to resolve {{{placeholder}}} from -- "
                          f"GET /{entity} returned 0 item(s)"))
            continue

        resolved = str(value).lower() if "hash" in placeholder.lower() else str(value)
        resolved_path = path.replace("{" + placeholder + "}", resolved)
        _check_get(claims, entry, client, resolved_path,
                  note=f" (resolved {{{placeholder}}}={resolved})")
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

def _resolve_processor_ids(clients: dict, reachable: dict[str, bool]) -> list[str] | None:
    """Real processor ids for ``check_rabbitmq`` to fill ``processor-{processorId}``
    with -- the BaseAPI list preferred (the same route ``check_api`` already
    exercises), Postgres as a fallback when the API is the one that is down.
    ``None`` means neither source could be reached this run (a gap, reported
    UNVERIFIABLE per templated entry); ``[]`` means a source answered and
    genuinely found zero processors registered (NOT_OBSERVED, not a gap).
    """
    if reachable.get("baseapi"):
        try:
            items = clients["baseapi"].list("processors")
        except Unreachable:
            items = None
        if items is not None:
            return [str(v) for v in _field_values(items, "id")]
    if reachable.get("postgres"):
        try:
            rows = clients["postgres"].rows('SELECT id FROM "processors"')
        except Unreachable:
            rows = None
        if rows is not None:
            return [str(row[0]) for row in rows if row]
    return None


def verify_all(entries: list[dict], clients: dict, component: str | None = None,
               probe_writes: bool = False) -> list[Claim]:
    """Gate on reachability once, per component, the same way ``skp doctor``
    does -- reusing ``init.probe()`` rather than a second probing
    implementation. A component that does not answer gets every one of its
    claims marked UNVERIFIABLE without a single query being attempted
    against it: "I could not check" must never be produced by actually
    trying and getting a confusing half-answer.

    ``probe_writes`` only ever affects the ``api`` component -- see
    ``check_api``/``_probe_write`` and the module docstring.
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
            processor_ids = _resolve_processor_ids(clients, reachable)
            claims += check_rabbitmq(comp_entries, clients["rabbitmq"], processor_ids)
        elif comp == "elasticsearch":
            claims += check_elasticsearch(comp_entries, clients["elasticsearch"])
        elif comp == "prometheus":
            claims += check_prometheus(comp_entries, clients["prometheus"])
        elif comp == "api":
            claims += check_api(comp_entries, clients["baseapi"], probe_writes=probe_writes)
        elif comp == "cluster":
            claims += check_cluster(comp_entries, clients["cluster"].cluster)
    return claims


def render_report(claims: list[Claim], component: str | None = None,
                  show_skips: bool = False, probe_writes: bool = False) -> list[str]:
    """A skip nobody can enumerate is indistinguishable from a claim that was
    never true (module docstring). So every NOT_OBSERVED/NOT_APPLICABLE claim
    is either listed here by id with its one-line reason (``--skips``), or --
    when the caller has not asked for the full list -- a pointer that says
    exactly how many there are and how to see them. The pointer always
    prints when skips exist; only the enumeration itself is gated, so the
    gap in what was confirmed is never invisible even in the terse form.
    """
    header = ("skp verify" + (f" --component {component}" if component else "")
              + (" --probe-writes" if probe_writes else ""))
    lines = [header, ""]

    mutation = [c for c in claims if c.message.startswith("MUTATION WARNING")]
    if mutation:
        lines.append(f"*** MUTATION WARNING ({len(mutation)}) -- a write-route probe got "
                     f"2xx instead of a rejection; the request may have mutated state. "
                     f"This means the probe's core assumption -- that [ApiController] "
                     f"model-state validation always short-circuits before the action runs "
                     f"-- did not hold for these routes: ***")
        for c in mutation:
            lines.append(f"  {c.surface_id}: {c.message}")
        lines.append("")

    by_comp: dict[str, list[Claim]] = {}
    for claim in claims:
        by_comp.setdefault(claim.component, []).append(claim)

    for comp in sorted(by_comp):
        comp_claims = by_comp[comp]
        counts = Counter(c.verdict for c in comp_claims)
        summary = ", ".join(f"{counts[v]} {v.lower()}" for v in VERDICTS if counts[v])
        lines.append(f"  {comp}: {summary}  ({len(comp_claims)} catalogued)")
    lines.append("")

    total = len(claims)
    confirmed = sum(1 for c in claims if c.verdict == CONFIRMED)
    pct = round(100 * confirmed / total) if total else 0
    lines.append(f"confirmed {confirmed}/{total} ({pct}%)")
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

    skipped = [c for c in claims if c.verdict in (NOT_OBSERVED, NOT_APPLICABLE)]
    if skipped:
        if show_skips:
            lines.append(f"SKIPPED ({len(skipped)}) -- not confirmed, not refuted; every one, "
                         f"by id:")
            for c in skipped:
                lines.append(f"  {c.surface_id} [{c.verdict}]: {c.message}")
        else:
            lines.append(f"{len(skipped)} claim(s) not confirmed (not_observed / "
                         f"not_applicable) -- rerun with --skips to list every one by id")
        lines.append("")

    if not refuted and not unverifiable:
        lines.append("no refutations -- every checkable claim is confirmed or legitimately "
                     "not observed")

    return lines


def run_with(entries: list[dict], clients: dict, component: str | None = None,
            show_skips: bool = False, probe_writes: bool = False) -> Result:
    claims = verify_all(entries, clients, component=component, probe_writes=probe_writes)
    lines = render_report(claims, component, show_skips=show_skips, probe_writes=probe_writes)

    if any(c.verdict == REFUTED for c in claims):
        return Result(EXIT_VERDICT, lines, next_command="skp doctor")
    if any(c.verdict == UNVERIFIABLE for c in claims):
        return Result(EXIT_UNREACHABLE, lines, next_command="skp verify")
    return Result(EXIT_OK, lines, next_command="skp map --intent observe")


def run(argv: list[str]) -> Result:
    parser = argparse.ArgumentParser(prog="skp verify")
    parser.add_argument("--home", default=str(default_home()))
    parser.add_argument("--component", choices=sorted(COMPONENT_CLIENT_KEY))
    parser.add_argument("--skips", action="store_true",
                        help="list every NOT_OBSERVED/NOT_APPLICABLE claim by id")
    parser.add_argument("--probe-writes", action="store_true",
                        help="opt-in: send a deliberately invalid body to every catalogued "
                             "POST/PUT/DELETE route (a fresh random guid for {id} routes, "
                             "never a real one) to confirm it is wired. [ApiController] "
                             "model-state validation rejects the request before the action "
                             "runs, so nothing is created, updated or deleted -- a 2xx is "
                             "reported REFUTED with a loud MUTATION WARNING instead of a "
                             "pass. Off by default so skp verify stays strictly read-only "
                             "unless asked otherwise.")
    ns = parser.parse_args(argv)

    home = pathlib.Path(ns.home)
    if not (home / "profile.json").exists():
        return not_initialised()

    try:
        profile = Profile.load(home)
        entries = load_catalog(home)
    except ProfileMissing:
        return not_compiled(home)

    return run_with(entries, build_clients(profile), component=ns.component,
                    show_skips=ns.skips, probe_writes=ns.probe_writes)
