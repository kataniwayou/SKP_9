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
  before the action ran. **404 is decided by the response body, not by
  whether the route happens to carry an ``{id}`` placeholder** -- a
  catalogue-side fact the server never sees and which would make the check
  unable to fail on the very thing it claims to prove. ASP.NET's own
  ``NotFoundExceptionHandler`` writes a ProblemDetails body (``title``,
  ``status``, ...) when routing matched and the action actually ran and
  then found nothing; a 404 that never reached a controller -- the path
  itself matched no route -- comes back with an empty body, straight from
  routing. So a 404 with a ProblemDetails body is CONFIRMED (proof the
  route is wired); a 404 with an empty or non-ProblemDetails body is
  REFUTED (the catalogued route does not exist). One rule, applied
  identically whether or not the route has an id placeholder --
  ``_looks_like_problem_details``.
  **Any 2xx is REFUTED, loudly**, flagged with a ``MUTATION WARNING`` in its
  message: it would mean model-state validation did not short-circuit the
  way this whole probe assumes, and the request may actually have written
  something. 5xx and transport failures are UNVERIFIABLE -- a probe that
  could not get a clean answer either way.

Without the flag, every write claim stays NOT_APPLICABLE, its reason now
naming the remedy (``rerun with --probe-writes``) rather than just stating
the limitation.

**``--probe-runs`` is the other opt-in write**, narrower than
``--probe-writes``: it only ever touches the one ``redis.ExecutionData``
claim (``skp:data:*``), and only when it is otherwise empty (nothing in
flight -- the normal idle-system case). It starts exactly one *existing*
workflow through ``orchestration/start`` (never creates one) and polls for
the key family to appear, then reports what it did either way. Off by
default for the same reason ``--probe-writes`` is: starting a workflow is a
write, even though -- unlike ``--probe-writes``'s deliberately-rejected
probes -- this one is a real, accepted start. See ``apply_probe_runs``.

Every claim's own message states, in place of a bare skip, *why* it was not
confirmed -- and increasingly, that reason distinguishes two different
things: **could not be checked** (UNVERIFIABLE: the store did not answer)
versus **cannot be checked, structurally, by design** (a
``PERMANENT EXCLUSION`` marker in the message). The ratio line in
``render_report`` reads that marker to report an honest achievable ceiling
alongside the raw percentage, rather than implying 100% is reachable when it
structurally is not. No surface carries that marker in the current build.
"""
import argparse
import json
import pathlib
import re
import time
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

_PROCESSOR_QUEUE = re.compile(
    r"^processor-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"
    r"(-post)?(\.dead)?$")
"""Matches all four of a processor's queues.

The ``-post`` group was added after the 2026-08-31 split. Without it a
decommissioned processor left two orphans this check could never report: the
regex is fully anchored, so ``processor-<guid>-post`` simply did not match and
fell through the loop as though it were somebody else's queue. The same
anchoring bug that hid the post queue from the Grafana board hid it here, and
in both places it reads as a clean result rather than a missing one."""


def _orphaned_processor_queues(live: set[str], processor_ids: list[str]) -> tuple[list[str], list[str]]:
    """The other half of the same drift ``check_rabbitmq``'s per-template loop
    already reports from the catalog side (a registered processor with no
    matching queue): live queues shaped like a per-processor queue
    (``processor-<guid>`` or its ``.dead`` sibling) whose guid matches no row
    currently in ``processors``. Read-only, from the ``queues()`` call
    already made -- no extra broker round-trip.
    """
    known = {pid.lower() for pid in processor_ids}
    work, dead = [], []
    for name in sorted(live):
        match = _PROCESSOR_QUEUE.match(name)
        if not match or match.group(1) in known:
            continue
        # group(3) is the ``.dead`` suffix; group(2) is ``-post``. A dead queue
        # is a dead queue whichever lane it belongs to -- the operator's action
        # is the same -- so the two orphan buckets stay split by live/dead, not
        # by lane, and the names themselves say which lane.
        (dead if match.group(3) else work).append(name)
    return work, dead


def _orphan_note(live: set[str], processor_ids: list[str]) -> str:
    work, dead = _orphaned_processor_queues(live, processor_ids)
    if not work and not dead:
        return ""
    parts = []
    if work:
        parts.append(f"{len(work)} live work queue(s) matching no processors row: "
                     f"{', '.join(work)}")
    if dead:
        parts.append(f"{len(dead)} .dead queue(s) matching no processors row: {', '.join(dead)}")
    return (" | broker-side orphan(s) (queue exists, no processors row -- clean up by deleting "
            "the queue, or by restoring the processors row if this is drift, not decommission): "
            + "; ".join(parts))


def _processor_deployment_status(processor_id: str, redis_client) -> str:
    """Distinguishes "never deployed" from "deployed, then its queue was
    removed" for one processor id with a missing queue -- read-only, via the
    ``redis.InstanceIndex`` SET key (``skp:proc:<id>``), which by its own
    catalogued semantics "outlives a dead replica's entry key": its mere
    existence means at least one replica registered at some point, whether
    or not any is alive right now. Absence means no replica has ever
    registered, which is a materially different remedy (deploy it, versus
    investigate why a live processor's queue disappeared).
    """
    if redis_client is None:
        return "deployment status unknown -- redis unreachable, could not check skp:proc:<id>"
    try:
        keys = redis_client.keys(f"skp:proc:{processor_id}")
    except Unreachable:
        return "deployment status unknown -- redis unreachable, could not check skp:proc:<id>"
    if keys:
        return ("has registered at least one replica in the past (skp:proc:" + processor_id +
                " exists) -- its queue existed and was removed; clean up on the broker/registry "
                "side, not by deploying")
    return ("has never registered a replica (no skp:proc:" + processor_id + " key) -- likely "
            "never deployed; clean up by deploying it, or by removing the stale processors row")


def check_rabbitmq(entries: list[dict], client, processor_ids: list[str] | None = None,
                   redis_client=None, instance_ids: list[str] | None = None) -> list[Claim]:
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

    A REFUTED templated claim is made actionable, not just flagged: its
    message names which processor id(s) are missing a queue, and --
    read-only, via ``redis_client``/``_processor_deployment_status`` -- for
    each one, whether it has ever registered a live replica (its queue was
    removed after the fact) or never has (likely never deployed). It also
    carries ``_orphan_note``: the reverse drift, live broker queues shaped
    like a per-processor queue that match no row in ``processors`` at all --
    both halves of the same bidirectional defect, named explicitly enough to
    act on rather than just diagnosed as broken.
    """
    try:
        live = {q["name"] for q in client.queues()}
    except Unreachable as exc:
        return [Claim("rabbitmq", e["id"], UNVERIFIABLE, f"list_queues failed -- {exc.detail}")
                for e in entries]

    exchanges_ok = True
    exchanges_err = ""
    live_exchanges: set[str] = set()
    # Any member whose name ends in "Exchange" is an exchange -- three classes
    # declare a DeadLetterExchange and OrchestratorFanout also declares a plain
    # Exchange. Matching the exact string "DeadLetterExchange" sent that one to
    # list_queues, where an exchange can never appear, and REFUTED it: the
    # catalog was right and the checker was wrong, which is the worse direction.
    if any(e["id"].rsplit(".", 1)[-1].endswith("Exchange") for e in entries):
        try:
            live_exchanges = {x["name"] for x in client.exchanges()}
        except Unreachable as exc:
            exchanges_ok = False
            exchanges_err = exc.detail

    claims = []
    for entry in entries:
        name = entry["detail"]
        local = entry["id"].rsplit(".", 1)[-1]
        if local.endswith("Exchange"):
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
        elif "{instanceId}" in name:
            # The fan-out queues are named for orchestrator REPLICAS, not
            # processors, so processor_ids cannot fill them. Resolved from
            # telemetry rather than from the broker being checked: the fan-out
            # consumers are exactly the exporters of pipeline.leader, and asking
            # the broker which queues exist to decide which queues should exist
            # is not a check.
            #
            # This is the one check that can catch the failure the fan-out
            # annotation warns about. The queues are non-exclusive, so a replica
            # whose name does not resolve to its own queue raises nothing and
            # logs nothing -- the broadcast quietly becomes a competing-consumer
            # load balance and two replicas of three run on a stale L1.
            if instance_ids is None:
                claims.append(Claim("rabbitmq", entry["id"], UNVERIFIABLE,
                              f"templated name {name!r} -- could not resolve orchestrator "
                              f"replica ids (prometheus was unreachable)"))
            elif not instance_ids:
                claims.append(Claim("rabbitmq", entry["id"], NOT_OBSERVED,
                              f"templated name {name!r} -- no orchestrator replicas "
                              f"exporting pipeline.leader to resolve it against"))
            else:
                resolved = [_fill(name, instanceId=iid) for iid in instance_ids]
                missing = [r for r in resolved if r not in live]
                if missing:
                    claims.append(Claim("rabbitmq", entry["id"], REFUTED,
                                  f"catalog claims {name!r} resolves to a live queue for "
                                  f"every orchestrator replica -- missing: "
                                  f"{', '.join(missing)}. These queues are non-exclusive, "
                                  f"so a replica without its own queue does not fail "
                                  f"loudly: the broadcast degrades into a competing-"
                                  f"consumer load balance and the replicas that miss an "
                                  f"announcement keep a stale L1"))
                else:
                    claims.append(Claim("rabbitmq", entry["id"], CONFIRMED,
                                  f"{len(resolved)} replica queue(s) present: "
                                  f"{', '.join(resolved)}"))
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
                missing_pids = [pid for pid, r in zip(processor_ids, resolved) if r not in live]
                missing = [r for r in resolved if r not in live]
                orphan_note = _orphan_note(live, processor_ids)
                if missing:
                    status = "; ".join(
                        f"{pid}: {_processor_deployment_status(pid, redis_client)}"
                        for pid in missing_pids)
                    claims.append(Claim("rabbitmq", entry["id"], REFUTED,
                                  f"catalog claims {name!r} resolves to a live queue "
                                  f"for every registered processor -- missing: "
                                  f"{', '.join(missing)}. {status}{orphan_note}"))
                else:
                    claims.append(Claim("rabbitmq", entry["id"], CONFIRMED,
                                  f"{name!r} resolved and present for all "
                                  f"{len(resolved)} registered processor(s){orphan_note}"))
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


RETENTION_NOTE = "~17 days of retention"  # see skp.clients.es.Elastic


def check_elasticsearch(entries: list[dict], client) -> list[Claim]:
    """The index/data stream is checked for existence (a plain bounded GET,
    never an aggregation); every ``elasticsearch.<Template>`` and
    ``elasticsearch.attr.*`` claim gets its own bounded existence query
    (``Elastic.exists`` -- ``size=0``, ``track_total_hits`` capped at 1)
    across the *entire* data stream, not a recent sample.

    **This replaced a shared 200-document newest-first sample that hid
    genuine matches.** Seven fault-path claims (three templates --
    ``RefusingAndParking``, ``StoreUnreachable``, ... -- plus the attributes
    ``Queue``, ``Reason``, ``Type``, ``WorkflowCount``) were reported
    NOT_OBSERVED under the old sample even though the stream holds ~17 days
    of retention including past chaos-scenario runs that emit exactly these
    records: the sample simply never happened to land on one. A per-claim
    ``size=0``/``track_total_hits=1`` query costs the same whether the true
    count is 0 or 10 million (Elasticsearch can stop at the first match), so
    checking the *whole* stream per claim is no more expensive than the old
    shared sample, and it does not miss history the sample could not see.

    Message templates (``elasticsearch.<TemplateName>``) match on
    ``attributes.{OriginalFormat}`` -- each one's own ``detail`` is the raw
    template text, exactly what that field carries verbatim on a real
    record. A handful carry an em dash the OTel pipeline mangles in transit;
    ``investigate._original_format_filter`` (reused, not re-solved here)
    switches those to a prefix match up to the dash.

    A claim that still returns zero hits after searching the full retention
    is a *meaningful* NOT_OBSERVED now -- not "the sample missed it", but "no
    document in ~17 days of retention has this", which the message states
    explicitly.
    """
    claims = []
    index_entries = [e for e in entries if e["id"] == "elasticsearch.index"]
    attr_entries = [e for e in entries if e["id"].startswith("elasticsearch.attr.")]
    template_entries = [e for e in entries
                        if e["id"] != "elasticsearch.index"
                        and not e["id"].startswith("elasticsearch.attr.")]

    for entry in template_entries:
        template = entry["detail"]
        try:
            found = client.exists([_original_format_filter(template)])
        except Unreachable as exc:
            claims.append(Claim("elasticsearch", entry["id"], UNVERIFIABLE,
                          f"existence query failed -- {exc.detail}"))
            continue
        if found:
            claims.append(Claim("elasticsearch", entry["id"], CONFIRMED,
                          f"attributes.{{OriginalFormat}} matches this template at least once "
                          f"(existence check across {RETENTION_NOTE})"))
        else:
            claims.append(Claim("elasticsearch", entry["id"], NOT_OBSERVED,
                          f"no document in {RETENTION_NOTE} has attributes.{{OriginalFormat}} "
                          f"matching this template -- a genuine absence, not a sampling artifact"))

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

    for entry in attr_entries:
        match = _ES_PATH.match(entry["operation"])
        path = match.group(1) if match else entry["operation"]
        try:
            found = client.exists([{"exists": {"field": path}}])
        except Unreachable as exc:
            claims.append(Claim("elasticsearch", entry["id"], UNVERIFIABLE,
                          f"existence query failed -- {exc.detail}"))
            continue
        if found:
            claims.append(Claim("elasticsearch", entry["id"], CONFIRMED,
                          f"{path} present on at least one document (existence check across "
                          f"{RETENTION_NOTE})"))
        else:
            claims.append(Claim("elasticsearch", entry["id"], NOT_OBSERVED,
                          f"no document in {RETENTION_NOTE} has {path} -- a genuine absence, "
                          f"not a sampling artifact"))
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


def _looks_like_problem_details(body: str) -> bool:
    """Does ``body`` carry the RFC 9110 ProblemDetails shape ASP.NET's
    exception-handler chain writes (``title``, ``status``, ...)?

    This is the fact that actually distinguishes the two things a 404 can
    mean here, observed live against both: ``DELETE`` on a real (but
    id-absent) route returns a *body-bearing* 404 -- routing matched, the
    action ran, ``NotFoundExceptionHandler`` produced this -- while
    ``DELETE`` on a path that matches no route at all returns a bare,
    *empty* 404 straight from routing, before any controller runs. Whether
    the catalogued route happens to have an ``{id}`` placeholder is a fact
    about the catalog, not the server, and using it instead of this would
    let the check confirm a route that had actually been removed -- see the
    module docstring.
    """
    if not body or not body.strip():
        return False
    try:
        parsed = json.loads(body)
    except (json.JSONDecodeError, ValueError):
        return False
    return isinstance(parsed, dict) and "title" in parsed and "status" in parsed


def _classify_write_status(status: int, body: str) -> tuple[str, str, bool]:
    """Maps one ``--probe-writes`` HTTP status (and its response body) to
    ``(verdict, reason, is_mutation_warning)`` -- see the module docstring
    for the full rationale. Split out from ``_probe_write`` so the mapping
    itself (the part the assumption actually lives in) is unit-testable
    against bare status/body pairs, with no HTTP client involved at all.
    """
    if status in _WRITE_CONFIRM_STATUSES:
        return CONFIRMED, "route wired, request rejected before the action ran", False
    if status == 404:
        if _looks_like_problem_details(body):
            return (CONFIRMED,
                    "route wired -- 404 carries a ProblemDetails body, proof routing "
                    "matched and the not-found handler ran for a guid guaranteed not "
                    "to exist", False)
        return (REFUTED,
                "catalogued route does not exist -- 404 with no ProblemDetails body, "
                "proof routing itself never matched", False)
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
    note = ""
    if placeholders:
        guid = str(uuid.uuid4())
        for placeholder in placeholders:
            path = path.replace("{" + placeholder + "}", guid)
        note = f" (id={guid}, freshly generated -- cannot exist)"

    try:
        status, body = client.http.probe_status(method, path, {})
    except Unreachable as exc:
        return Claim("api", entry["id"], UNVERIFIABLE,
                    f"{method} {path} with an empty body{note} -- transport failure, "
                    f"not a response: {exc.detail}")

    verdict, why, is_mutation = _classify_write_status(status, body)
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

_DATA_FAMILY_ID = "redis.ExecutionData"
_ORCH_START_ID = "api.orchestration.post_start"
# 60s at 50ms, and the WINDOW is the part that matters. Measured on the live
# cluster, the delay from a 200 OK on orchestration/start to the first
# skp:data:* key was 2.39s, 9.98s and 8.83s across three consecutive runs --
# the orchestrator does not dispatch on the request thread, so the first blob
# lands on its own schedule. The old bound was 20 x 0.5s = exactly 10s, which
# put the observed worst case ON the deadline: the same command reported
# CONFIRMED or NOT_OBSERVED on an unchanged system depending on which side of
# 10s that run happened to fall. That is a flaky verdict, and a verdict that
# flips is worse than one that is merely pessimistic -- it teaches a reader to
# discount the ratio. 60s is six times the measured worst case; the finer poll
# is secondary, and only bounds how much of a short-lived blob's life can be
# stepped over once the window is wide enough to contain it.
_PROBE_RUN_ATTEMPTS = 1200
_PROBE_RUN_POLL_S = 0.05


def _tight_scan(client, pattern: str, window_s: float, poll_s: float) -> list[str]:
    """Re-issues ``SCAN MATCH pattern`` every ``poll_s`` for up to ``window_s``
    trying to catch a key that is live only briefly -- one written and deleted
    inside a single tick, or one that exists only while a run is in flight.
    Still read-only, still bounded: worst case is ``window_s`` seconds of cheap
    SCANs, not an unbounded wait.
    """
    deadline = time.monotonic() + window_s
    while True:
        keys = client.keys(pattern)
        if keys:
            return keys
        if time.monotonic() >= deadline:
            return []
        time.sleep(poll_s)


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


def _resolve_operation_path(entries: list[dict], surface_id: str) -> str | None:
    for entry in entries:
        if entry["id"] == surface_id:
            return entry["operation"].split(" ", 1)[1]
    return None


def start_workflow_for_probe(entries: list[dict], clients: dict) -> tuple[str | None, str]:
    """Starts exactly one real workflow through BaseAPI so ``skp:data:*`` can
    be caught genuinely in flight -- see ``--probe-runs`` in the module
    docstring. **Uses an existing workflow id from the live system; never
    creates one.** Returns ``(workflow_id, note)``; ``workflow_id`` is
    ``None`` when nothing could be started, and ``note`` says why (or, on
    success, what was started and through which route) -- either way this
    is folded into the claim's message, never silently dropped.

    ``orchestration/start`` binds a bare ``Guid`` from the body (see the
    module docstring's ``--probe-writes`` section on the same controller) --
    the body sent here is the real workflow id, JSON-encoded as a bare
    string, which is exactly what a real client sends to actually start it.
    """
    try:
        workflows = clients["baseapi"].list("workflows")
    except Unreachable as exc:
        return None, f"could not list workflows to find one to start -- {exc.detail}"
    workflow_id = _first_field(workflows, "id")
    if workflow_id is None:
        return None, "no workflow registered on the live system to start"
    path = _resolve_operation_path(entries, _ORCH_START_ID)
    if path is None:
        return None, f"{_ORCH_START_ID} route not found in the catalog"
    try:
        clients["baseapi"].http.post_json(path, str(workflow_id))
    except Unreachable as exc:
        return None, f"POST {path} with workflow id {workflow_id} failed -- {exc.detail}"
    return str(workflow_id), f"started workflow {workflow_id} via POST {path}"


def apply_probe_runs(claims: list[Claim], entries: list[dict], clients: dict,
                     reachable: dict[str, bool]) -> list[Claim]:
    """``--probe-runs`` opt-in: only touches the one ``redis.ExecutionData``
    claim (``skp:data:*``), and only when the plain read-only check above
    already found it empty. Starts exactly one workflow (never more), polls
    ``skp:data:*`` for up to ``_PROBE_RUN_ATTEMPTS * _PROBE_RUN_POLL_S``
    seconds, and folds the outcome into that one claim -- a caught key
    upgrades it to CONFIRMED; anything else appends the reason to its
    existing NOT_OBSERVED message rather than replacing it, so the ordinary
    "nothing in flight" fact is not lost.
    """
    idx = next((i for i, c in enumerate(claims)
               if c.surface_id == _DATA_FAMILY_ID and c.verdict == NOT_OBSERVED), None)
    if idx is None:
        return claims
    if not reachable.get("baseapi"):
        claims[idx] = claims[idx]._replace(
            message=claims[idx].message + " -- --probe-runs could not start a workflow: "
                                           "baseapi unreachable")
        return claims

    workflow_id, note = start_workflow_for_probe(entries, clients)
    if workflow_id is None:
        claims[idx] = claims[idx]._replace(message=claims[idx].message + f" -- --probe-runs: {note}")
        return claims

    keys = _tight_scan(clients["redis"], "skp:data:*",
                       _PROBE_RUN_ATTEMPTS * _PROBE_RUN_POLL_S, _PROBE_RUN_POLL_S)
    if keys:
        claims[idx] = Claim("redis", _DATA_FAMILY_ID, CONFIRMED,
                            f"{len(keys)} key(s) matching skp:data:* -- caught in flight after "
                            f"{note} (--probe-runs)")
    else:
        claims[idx] = claims[idx]._replace(
            message=claims[idx].message + f" -- --probe-runs: {note}, but skp:data:* never "
                                           f"appeared within {_PROBE_RUN_ATTEMPTS * _PROBE_RUN_POLL_S:.0f}s "
                                           f"of polling")
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

def _resolve_instance_ids(clients: dict, reachable: dict[str, bool]) -> list[str] | None:
    """Orchestrator replica ids, for ``check_rabbitmq`` to fill
    ``orchestrator-control.{instanceId}`` with.

    Sourced from ``pipeline.leader``, which only the orchestrator exports and
    which every replica exports (one reporting 1, the rest 0) -- so its
    ``service_instance_id`` values are exactly the set of replicas that should
    each own a fan-out queue. Deliberately NOT sourced from the broker: asking
    which queues exist in order to decide which queues should exist confirms
    nothing.

    The live series carries the ``_ratio`` suffix OpenTelemetry appends for a
    unitless gauge, so the bare name is tried first and the observed rendering
    second -- the same pair ``skp observe gate`` already handles rather than
    hardcoding whichever one happens to work today.

    ``None`` means Prometheus could not be reached (a gap, UNVERIFIABLE);
    ``[]`` means it answered and no replica is exporting (NOT_OBSERVED).
    """
    if not reachable.get("prometheus"):
        return None
    for expr in ("pipeline_leader", "pipeline_leader_ratio"):
        try:
            series = clients["prometheus"].query(expr)
        except Unreachable:
            return None
        except Exception:  # pragma: no cover -- defensive, mirrors check_prometheus
            series = []
        if series:
            return sorted({s.get("metric", {}).get("service_instance_id")
                           for s in series
                           if s.get("metric", {}).get("service_instance_id")})
    return []


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
               probe_writes: bool = False, probe_runs: bool = False) -> list[Claim]:
    """Gate on reachability once, per component, the same way ``skp doctor``
    does -- reusing ``init.probe()`` rather than a second probing
    implementation. A component that does not answer gets every one of its
    claims marked UNVERIFIABLE without a single query being attempted
    against it: "I could not check" must never be produced by actually
    trying and getting a confusing half-answer.

    ``probe_writes`` only ever affects the ``api`` component -- see
    ``check_api``/``_probe_write`` and the module docstring. ``probe_runs``
    only ever affects the one ``redis.ExecutionData`` claim -- see
    ``apply_probe_runs`` -- and needs the *full* catalog (not just the redis
    component's own entries) to find the ``orchestration/start`` route, so it
    is applied here rather than inside ``check_redis``.
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
            redis_claims = check_redis(comp_entries, clients["redis"])
            if probe_runs:
                redis_claims = apply_probe_runs(redis_claims, entries, clients, reachable)
            claims += redis_claims
        elif comp == "rabbitmq":
            processor_ids = _resolve_processor_ids(clients, reachable)
            redis_for_status = clients.get("redis") if reachable.get("redis") else None
            claims += check_rabbitmq(comp_entries, clients["rabbitmq"], processor_ids,
                                     redis_for_status,
                                     _resolve_instance_ids(clients, reachable))
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
                  show_skips: bool = False, probe_writes: bool = False,
                  probe_runs: bool = False) -> list[str]:
    """A skip nobody can enumerate is indistinguishable from a claim that was
    never true (module docstring). So every NOT_OBSERVED/NOT_APPLICABLE claim
    is either listed here by id with its one-line reason (``--skips``), or --
    when the caller has not asked for the full list -- a pointer that says
    exactly how many there are and how to see them. The pointer always
    prints when skips exist; only the enumeration itself is gated, so the
    gap in what was confirmed is never invisible even in the terse form.
    """
    header = ("skp verify" + (f" --component {component}" if component else "")
              + (" --probe-writes" if probe_writes else "")
              + (" --probe-runs" if probe_runs else ""))
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
    refuted_n = sum(1 for c in claims if c.verdict == REFUTED)
    permanent = [c for c in claims if "PERMANENT EXCLUSION" in c.message]
    pct = round(100 * confirmed / total) if total else 0
    ratio = f"confirmed {confirmed}/{total} ({pct}%)"
    if refuted_n or permanent:
        ceiling = total - refuted_n - len(permanent)
        notes = []
        if refuted_n:
            notes.append(f"{refuted_n} refuted (system defect, not a toolkit gap)")
        if permanent:
            notes.append(f"{len(permanent)} permanently excluded (structurally unobservable -- "
                         f"see below)")
        ratio += " -- " + "; ".join(notes) + f"; maximum achievable {ceiling}/{total}"
    lines.append(ratio)
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
            show_skips: bool = False, probe_writes: bool = False,
            probe_runs: bool = False) -> Result:
    claims = verify_all(entries, clients, component=component, probe_writes=probe_writes,
                        probe_runs=probe_runs)
    lines = render_report(claims, component, show_skips=show_skips, probe_writes=probe_writes,
                          probe_runs=probe_runs)

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
    parser.add_argument("--probe-runs", action="store_true",
                        help="opt-in: when skp:data:* is empty (nothing in flight), start "
                             "exactly one existing workflow through BaseAPI and poll for the "
                             "key family to appear, to confirm it while genuinely in flight. "
                             "Starting a workflow is a write (though it creates no rows -- see "
                             "the module docstring), so this is off by default like "
                             "--probe-writes.")
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
                    show_skips=ns.skips, probe_writes=ns.probe_writes,
                    probe_runs=ns.probe_runs)
