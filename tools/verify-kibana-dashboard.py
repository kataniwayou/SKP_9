#!/usr/bin/env python3
"""
Executable form of section 9 of docs/superpowers/specs/2026-09-22-kibana-operator-dashboard-design.md,
as amended by section 13.7.

Every check prints PASS or FAIL with the measured numbers beside it, and the script exits non-zero
if any check failed. Check 8 (a drill-down click) is not here: it is a UI action and is listed in
docs/testing/kibana-operator-dashboard.md as the one manual step.

WHAT CHANGED WHEN THE ELASTICSEARCH OBJECTS WENT AWAY:

  * Checks 2 and 3 are DELETED. They tested that an ingest pipeline's enrichment landed and that an
    unmatched id survived it. There is no pipeline, no enrich policy and no lookup index, so there
    is nothing for them to test. Deleting a check can hide a regression, so each deletion is named
    here rather than being silently absent.
  * The counted set is now one clause, and it is asserted against the dashboard's own query rather
    than a pipeline-written flag (check 10).
  * Names are fields on the records, set by the orchestrator and the processors from L2; this
    script reads the same keys (skp:{wf|step|proc}:{id} name) and compares on name_version.
  * Check 12 no longer asserts that a never-run step is listable. The naming records that made that
    true were removed from OrchestrationService; see that method and check 12's own docstring.
  * Check 5 skips kafka-importer and kafka-exporter by design (no input key and a no-data branch)
    and fails on any other entry-less record.

RUN THIS FROM POWERSHELL against live port-forwards:
    ./k8s/port-forward-realstack.ps1
    python tools/verify-kibana-dashboard.py
"""
import argparse
import glob
import json
import re
import os
import sys
import time

import requests

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "offline"))
import skp_names

DEFAULT_REDIS = ("localhost", 6380)
DEFAULT_ES = "http://localhost:19200"
DEFAULT_KIBANA = "http://localhost:15601"
DATA_STREAM = "logs-generic.otel-default"

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXPORT = os.path.join(ROOT, "kibana", "kibana-export.ndjson")
# Beside this script, not in kibana/: kibana/ is what gets imported into Kibana, and these 13
# documents are synthetic test data that never leaves a scratch index.
FIXTURE = os.path.join(ROOT, "tools", "classification-fixture.json")
# WHERE THE DIAGRAMS LIVE NOW. They were files under kibana/diagrams/, rendered to PNG and served
# by an nginx; they are rows on the workflow table, served by the BaseApi. The directory is gone, so
# globbing it silently found nothing and this check PASSED while verifying zero drawings - the worst
# outcome available to it. It reads what is actually served instead.
DEFAULT_API = "http://localhost:18080"

# The chain this dashboard is VALIDATED against, not the one it is built for (spec section 1).
VALIDATION_WORKFLOW = "filefetcher-archiveexpander-chain_1.0.0"

# THE COUNTED SET, as Elasticsearch query DSL. The dashboard states it as KQL; check 10 asserts that
# the two say the same thing by pinning the KQL string, and the fixture proves the semantics on the
# templates live traffic never produces.
COUNTED_KQL = 'attributes.Result:* and not resource.attributes.service.name:"orchestrator"'

# The dashboard that owns COUNTED_KQL. Named so check 11 can say "this one states the rule"
# rather than "there is one dashboard".
OUTCOMES_DASHBOARD = "skp-operator-outcomes"

# Processors whose counted records legitimately carry no EntryId since 2026-09-29: a source step's
# dispatch has no input key, and the exporter reports Completed through a branch with no data.
EXPECTED_ENTRYLESS = {"kafka-importer", "kafka-exporter"}

# A refusal: the one Error record GatedQueueConsumer writes, on both sides, when it rejects a
# delivery without requeue and the broker dead-letters it. THE SEVERITY HALF IS LOAD-BEARING, not
# decoration -- attributes.Queue also rides Information-level startup lines ("consumption admitted
# ... consuming {Queue}", "reply queue {Queue} bound", 15 of them in the live store) and the two
# WARNING-level requeue lines, which are not parks and must never be counted as lost work. Error +
# Queue is exactly the park branch, both halves of it: the one that landed and the one where the
# channel died before the broker was told.
#
# NO BRACES IN THIS CLAUSE, deliberately: it never needs to name attributes.{OriginalFormat}, so
# nothing here depends on how Kibana's KQL grammar treats { and }. The table separates "parked" from
# "NOT parked" with a phrase match on body.text instead -- match_only_text, so it answers a phrase
# query, which the keyword attributes.* fields do not.
REFUSED_KQL = 'severity_text:"Error" and attributes.Queue:*'

# The dashboard hosts FOUR atoms since 2026-09-26: a step outcome (one record per step), a
# whitelist lookup (one record per field checked), a refusal (one record per message thrown away),
# and a run boundary (one record per fire, and one per branch end). Its query is their union, with
# COUNTED_KQL kept verbatim as a parenthesised clause so the rule is still stated exactly once in
# the export.
#
# THE REFUSAL CLAUSE HAD TO GO HERE, not only on the panel. The dashboard query and its filter AND
# with every panel's own query, and both previously admitted only a record carrying Result or
# WhitelistVerdict -- a refusal carries neither, so the refusal table rendered permanently empty
# until this clause existed. Widening it moves no count: checked against the live store, the
# outcome selector under the widened filter still matches 181,732 records and zero refusals.
# The run-boundary selector. Exactly the two records the orchestrator tags with a RunPosition: the
# fire's entry dispatch and a branch's terminal outcome. Nothing else in the store carries the field.
#
# THIS CLAUSE HAD TO GO IN THE DASHBOARD QUERY FOR A SHARPER REASON THAN THE REFUSAL ONE. Both
# boundary records were excluded, and by DIFFERENT clauses: "dispatched an entry step" carries no
# Result at all, and the terminal record carries one but is emitted BY the orchestrator, which
# COUNTED_KQL excludes by name. So the pie would have rendered permanently empty on both slices --
# the same failure the refusal table shipped with, twice over.
RUNPOSITION_KQL = "attributes.RunPosition:*"

# The run-boundary pie's own query, since 2026-10-01 an ES|QL panel. ENTRY is the fires in range --
# every CorrelationId with an entry record; TERMINAL is every branch end whose CorrelationId is one
# of those fires, however far it fanned out. A terminal of a fire that entered before the range is
# not counted. Lens cannot express this: it needs a per-CorrelationId join ("has an entry"), and a
# Lens pie counts each slice independently, which is what the record-counting pie before it did.
# Kept byte-identical to the export so check 11 catches the panel drifting from it.
RUNPOSITION_ESQL = (
    "FROM logs-generic.otel-default\n"
    "| WHERE attributes.RunPosition IS NOT NULL\n"
    "| EVAL e = CASE(attributes.RunPosition == \"entry\", 1, 0),\n"
    "       t = CASE(attributes.RunPosition == \"terminal\", 1, 0)\n"
    "| STATS e = MAX(e), t = SUM(t) BY attributes.CorrelationId, attributes.WorkflowName\n"
    "| WHERE e == 1\n"
    "| STATS entry = COUNT(*), terminal = SUM(t) BY attributes.WorkflowName\n"
    "| EVAL boundary = [\"entry\", \"terminal\"]\n"
    "| MV_EXPAND boundary\n"
    "| EVAL count = CASE(boundary == \"entry\", entry, terminal)\n"
    "| KEEP boundary, attributes.WorkflowName, count"
)

DASHBOARD_KQL = (
    f'({COUNTED_KQL}) or attributes.WhitelistVerdict:* or ({REFUSED_KQL}) or {RUNPOSITION_KQL}')

# Each panel guards its own atom, and must do so WITHOUT relying on the dashboard query to have
# excluded anything -- see the outcome panels below for what that assumption cost.
# THE BINS PANEL MAKES THIS LOAD-BEARING: it counts records split by
# attributes.StepId, and a whitelist record carries a StepId, so without the guard the union query
# would inflate every step's series and check 7 would stop matching. The outcomes pie terms on
# attributes.Result -- which was wrongly described here as "immune by construction", the exact
# assumption that later failed when a record carrying BOTH Result and RunPosition was admitted.
PANEL_GUARDS = {
    # COUNTED_KQL, not a bare "attributes.Result:*" -- and the difference is a defect that shipped.
    # The orchestrator exclusion used to live ONLY inside the dashboard query's first clause, so
    # these two panels leaned on it instead of stating it. Adding a fourth clause for run boundaries
    # broke that: an orchestrator TERMINAL record carries attributes.Result AND attributes.RunPosition,
    # so it entered through the new clause, sailed past a guard that only asked for Result, and
    # doubled the terminal step. Measured on simple-abc: stepA/stepB/stepC went from 120/120/120 to
    # 120/120/240, reporting 25/25/50 where the truth is 33/33/33.
    #
    # Each panel guards its own atom, completely. A guard that is only correct because of what some
    # OTHER clause happens to exclude is not a guard.
    "skp-outcomes-bins": COUNTED_KQL,
    "skp-outcomes-pie": COUNTED_KQL,
    # Not a Lens panel: the whitelist board is one aggregation-based pie split into one donut per
    # (processor, whitelist) pair, because a Lens partition chart has no split-chart dimension --
    # its only groups are "Slice by" and "Metric", verified in the editor. Its guard is load-bearing
    # for a second reason than the bins panel's: without it the SPLIT would draw a pie per processor
    # for every step-outcome record too, each one empty, since those records have no verdict to
    # slice.
    "skp-whitelist-pies": "attributes.WhitelistVerdict:*",
    # The refusal table. Its guard is load-bearing in the same direction as the bins panel's and for
    # a sharper reason: a refusal record carries StepId and WorkflowId, so without the guard the
    # union query would let step outcomes into a panel whose whole claim is "this work was thrown
    # away", and an operator would read 181,732 completed steps as lost messages.
    "skp-parked-table": REFUSED_KQL,
    # The run-boundary pie. An ES|QL panel, so its guard is its whole query: the WHERE on
    # attributes.RunPosition is what keeps every other atom out -- each carries a CorrelationId, and
    # without it the per-CorrelationId join would see outcomes, lookups and refusals as runs.
    "skp-runposition-pie": RUNPOSITION_ESQL,
}

# The one pair-per-pie bucket. Asserted by check 11 so a later edit cannot quietly go back to
# splitting on ProcessorId alone, which silently merges a processor's two lists into one donut.
# multi_terms on the two fields directly -- StepName is set on the record by the processor itself
# from L2, and WhitelistRoot rides the record as before. No computed field and no pipeline any more.
WHITELIST_SPLIT_FIELDS = ["attributes.StepName", "attributes.WhitelistRoot"]


class Checks:
    """Collects results so one failure does not hide the checks after it."""

    def __init__(self):
        self.failures = 0

    def report(self, number, title, ok, detail):
        print(f"[{'PASS' if ok else 'FAIL'}] check {number}: {title} - {detail}")
        if not ok:
            self.failures += 1
        return ok


# ---------------------------------------------------------------------------------------------
# Names
#
# The orchestrator and the processors stamp {name}_{version}-{suffix} onto their own records,
# resolved from skp:{wf|step|proc}:{id} name in L2 at the moment each record is built; this script reads that
# same store instead of Elasticsearch, so it resolves an id exactly as BaseApi resolved it.
# ---------------------------------------------------------------------------------------------
DATA_VIEW = "skp-logs"


def load_names(redis_host, redis_port):
    """{id: name_version} for every entity BaseApi has ever started, read from skp:{wf|step|proc}:{id} name in L2.

    THE SOURCE MOVED OUT OF ELASTICSEARCH. The skp-entity-lookup index and the logs@custom pipeline
    are gone; the processes stamp names on their own records and the keys in L2 are the single store.
    Names carry a GUID suffix that differs per environment, so every comparison below is on the
    base name (name_version) and the expected-count literals stay environment-independent.
    """
    return {i: skp_names.base_name(n) for i, n in skp_names.read_names(redis_host, redis_port).items()}


# Spec section 4.4, re-keyed to {name}_{version} per section 13.7. The versions are NOT all 1.0.0 and
# were read off the live rows rather than assumed - kafka-importer is at 2.2.0 and kafka-exporter at
# 1.2.0.
PER_CYCLE_TOTAL = 30
PER_CYCLE_BY_PROCESSOR = {
    "kafka-importer_2.2.0": 5,
    "file-fetcher_1.0.0": 5,
    "archive-expander_1.0.0": 4,
    "sk-normalizer_1.0.0": 4,
    "outcome-recorder_1.0.0": 3,
    "archive-collapser_1.0.0": 2,
    "file-persister_1.0.0": 2,
    "kafka-exporter_1.2.0": 5,
}
PER_CYCLE_BY_RESULT = {"Completed": 26, "Failed": 3, "Cancelled": 1}
PER_CYCLE_BY_STEP = {
    "split-filefetcher_1.0.0": 5,
    "split-importer_1.0.0": 5,
    "split-archiveexpander_1.0.0": 4,
    "export-outcome_1.0.0": 3,
    "record-outcome_1.0.0": 3,
    "sk-normalizer-sample_1.0.0": 3,
    "split-archivecollapser_1.0.0": 2,
    "split-exporter_1.0.0": 2,
    "split-filepersister_1.0.0": 2,
    "sk-normalizer-alphabeta_1.0.0": 1,
}


def _counted_query(window, workflow_id=None):
    """Spec 13.4: a Result is present and the emitter is not the orchestrator.

    ONE CLAUSE. The old rule needed two - a processor-side clause plus a carve-out that reached into
    the orchestrator's records for a terminal step's success and then had to exclude the Failed and
    Cancelled halves of that same template to avoid counting them twice. A terminal step now reports
    its own outcome, so there is nothing exceptional left to carve out.

    service.name rather than a scope.name prefix: both express "not the orchestrator", and this one
    survives a namespace rename in BaseProcessor.Core.
    """
    query = {
        "bool": {
            "filter": [{"exists": {"field": "attributes.Result"}},
                       {"range": {"@timestamp": {"gte": window}}}],
            "must_not": [{"term": {"resource.attributes.service.name": "orchestrator"}}],
        }
    }
    if workflow_id:
        query["bool"]["filter"].append({"term": {"attributes.WorkflowId": workflow_id}})
    return query


def _terms(es_url, field, window, workflow_id=None, size=50, names=None):
    body = {"size": 0, "query": _counted_query(window, workflow_id),
            "aggs": {"by": {"terms": {"field": field, "size": size}}}}
    result = requests.post(f"{es_url}/{DATA_STREAM}/_search", json=body, timeout=30).json()
    buckets = {b["key"]: b["doc_count"] for b in result["aggregations"]["by"]["buckets"]}
    if names is None:
        return buckets
    # Unresolved ids keep their GUID suffix fallback, which is exactly what the dashboard renders for them.
    return {names.get(k, k): v for k, v in buckets.items()}


def check_1_kibana_reaches_es(checks, kibana_url):
    """Kibana is up and its Elasticsearch connection is green."""
    try:
        body = requests.get(f"{kibana_url}/api/status", timeout=15).json()
        overall = body["status"]["overall"]["level"]
        es_plugin = body["status"]["core"]["elasticsearch"]["level"]
    except Exception as exc:  # noqa: BLE001 - any failure here IS the check failing
        return checks.report(1, "Kibana reaches ES", False, f"{type(exc).__name__}: {exc}")
    ok = overall == "available" and es_plugin == "available"
    return checks.report(1, "Kibana reaches ES", ok, f"overall={overall} elasticsearch={es_plugin}")


# checks 2 and 3 are DELETED - spec 13.7. They tested that ingest-time enrichment landed on a new
# document and that a document with an unmatched id survived the pipeline rather than being dropped.
# Both were about an ingest pipeline and an enrich policy that no longer exist. Nothing replaces
# them, because the name is now stamped by the process that writes the record and cannot fail an
# indexing operation.


def check_4_totals_match_the_cycle(checks, es_url, window, names, workflow_id):
    """Counted records over the window equal 30 x cycles, and each processor matches its own row.

    The slop is honest rather than lax: a fixed window almost never starts and ends on a cycle
    boundary, so a partial cycle at either edge shifts the total. Check 5 is the exact one.
    """
    try:
        by_processor = _terms(es_url, "attributes.ProcessorId", window, workflow_id, names=names)
    except Exception as exc:  # noqa: BLE001
        return checks.report(4, "Totals match the cycle", False, f"{type(exc).__name__}: {exc}")

    importer = by_processor.get("kafka-importer_2.2.0", 0)
    if importer < 5:
        return checks.report(4, "Totals match the cycle", False,
                             f"too little traffic to derive cycles (kafka-importer={importer})")
    cycles = importer / PER_CYCLE_BY_PROCESSOR["kafka-importer_2.2.0"]

    total = sum(by_processor.values())
    expected_total = PER_CYCLE_TOTAL * cycles
    total_ok = abs(total - expected_total) <= PER_CYCLE_TOTAL

    off = {}
    for name, per_cycle in PER_CYCLE_BY_PROCESSOR.items():
        expected = per_cycle * cycles
        seen = by_processor.get(name, 0)
        if abs(seen - expected) > max(2.0, expected * 0.25):
            off[name] = f"{seen} vs {expected:.0f}"

    ok = total_ok and not off
    return checks.report(4, "Totals match the cycle", ok,
                         f"cycles={cycles:.1f} total={total} expected={expected_total:.0f} "
                         f"off_by_processor={off or 'none'}")


def check_5_one_witness_per_step(checks, es_url, window):
    """No (StepId, ExecutionId, EntryId) triple carries more than one counted record. EXACT.

    THE KEY IS THREE FIELDS, NOT TWO. The design specified (StepId, ExecutionId), which is wrong:
    this chain FANS OUT, so one step legitimately completes several times inside a single execution
    -- file-persister runs twice per cycle and archive-collapser once per normalizer branch, all
    sharing one ExecutionId. EntryId separates the branches. Keyed on two fields this check reports
    ~15 "duplicates" per 10 minutes on a perfectly healthy run.

    TWO PROCESSORS ARE SKIPPED BY DESIGN since 2026-09-29. kafka-importer's outcomes belong to a
    source step, which has no input key, and kafka-exporter reports Completed through a branch with
    no data. ExecutionLogScope omits an empty EntryId, so neither can join the triple. Any other
    processor appearing among the skips fails the check.

    ONE RESIDUAL GAP, and it is smaller than the one it replaced: a step that is BOTH an entry step
    and a terminal step produced its own input, so its EntryId is Guid.Empty and ExecutionLogScope
    omits it. No workflow in the cluster has such a step; a one-step workflow would. Check 4's
    per-processor assertion is the guard, as it was for kafka-exporter before.
    """
    body = {
        "size": 0,
        "query": _counted_query(window),
        "aggs": {
            "with_entry": {
                "filter": {"exists": {"field": "attributes.EntryId"}},
                "aggs": {"triples": {"multi_terms": {
                    "terms": [{"field": "attributes.StepId"},
                              {"field": "attributes.ExecutionId"},
                              {"field": "attributes.EntryId"}],
                    "size": 10000, "min_doc_count": 2}}},
            },
            "no_entry": {"filter": {"bool": {"must_not": [{"exists": {"field": "attributes.EntryId"}}]}},
                         "aggs": {"services": {"terms": {"field": "resource.attributes.service.name",
                                                         "size": 20}}}},
        },
    }
    try:
        result = requests.post(f"{es_url}/{DATA_STREAM}/_search", json=body, timeout=60).json()
        offenders = result["aggregations"]["with_entry"]["triples"]["buckets"]
        checked = result["aggregations"]["with_entry"]["doc_count"]
        skipped = result["aggregations"]["no_entry"]["doc_count"]
        skip_services = {b["key"]: b["doc_count"]
                         for b in result["aggregations"]["no_entry"]["services"]["buckets"]}
    except Exception as exc:  # noqa: BLE001
        return checks.report(5, "One witness per step", False, f"{type(exc).__name__}: {exc}")

    unexpected = {s: n for s, n in skip_services.items() if s not in EXPECTED_ENTRYLESS}
    detail = (f"{checked} records checked, {skipped} skipped for want of an EntryId "
              f"({skip_services or 'none'})")
    if offenders:
        sample = [(b["key"], b["doc_count"]) for b in offenders[:3]]
        return checks.report(5, "One witness per step", False,
                             f"{len(offenders)} duplicated triple(s), e.g. {sample} - {detail}")
    # Skips are expected from the importer (source step) and the exporter (no-data branch) only. A
    # skip from anything else means a new entry-less outcome shape was introduced, and the operator
    # notes need to say so.
    return checks.report(5, "One witness per step", not unexpected,
                         f"no duplicated triple - {detail}"
                         + (f"; UNEXPECTED entry-less records from {unexpected}" if unexpected else ""))


def check_6_every_step_has_a_bin(checks, es_url, window, names, workflow_id):
    """All TEN steps appear as their own series, which is what the bins chart draws.

    Split on step rather than processor: sk-normalizer serves two steps and kafka-exporter serves
    two, so a per-processor view collapses four steps into two bars and hides which is failing.

    export-outcome and split-exporter are the ones that matter here. They emitted ZERO
    processor-side records until the terminal outcome was added, and their bars existed only by
    virtue of the orchestrator carve-out this design removed.
    """
    try:
        by_step = _terms(es_url, "attributes.StepId", window, workflow_id, names=names)
    except Exception as exc:  # noqa: BLE001
        return checks.report(6, "Every step has a bin", False, f"{type(exc).__name__}: {exc}")
    missing = [s for s in PER_CYCLE_BY_STEP if by_step.get(s, 0) == 0]
    return checks.report(6, "Every step has a bin", not missing,
                         f"{len(by_step)}/{len(PER_CYCLE_BY_STEP)} series present, "
                         f"missing={missing or 'none'}")


def check_7_pie_matches_bins(checks, es_url, window, names, workflow_id):
    """The three Result slices sum to the bins total, in roughly 26:3:1 per cycle."""
    try:
        by_result = _terms(es_url, "attributes.Result", window, workflow_id, size=10)
        by_processor = _terms(es_url, "attributes.ProcessorId", window, workflow_id, names=names)
    except Exception as exc:  # noqa: BLE001
        return checks.report(7, "Pie matches bins", False, f"{type(exc).__name__}: {exc}")
    sums_match = sum(by_result.values()) == sum(by_processor.values())
    only_three = set(by_result) <= set(PER_CYCLE_BY_RESULT)
    completed = by_result.get("Completed", 0)
    ratios_ok = True
    if completed:
        for name, per_cycle in PER_CYCLE_BY_RESULT.items():
            expected = completed * per_cycle / PER_CYCLE_BY_RESULT["Completed"]
            if abs(by_result.get(name, 0) - expected) > max(2.0, expected * 0.25):
                ratios_ok = False
    ok = sums_match and only_three and ratios_ok
    return checks.report(7, "Pie matches bins", ok,
                         f"by_result={by_result} sum_equals_bins={sums_match} "
                         f"only_three_values={only_three} ratio_ok={ratios_ok}")


def check_9_generic_across_workflows(checks, es_url, kibana_url, window, names):
    """The dashboard's objects exist under their fixed ids, and more than one workflow has counted
    records.

    The UI half -- selecting a second workflow and watching the panels repopulate -- is a click and
    lives in the operator notes. What is checkable here is the precondition that makes it work.
    """
    # skp-outcome-records is GONE. It was a saved search nothing opened: the pie's drilldown is an
    # OPEN_IN_DISCOVER_DRILLDOWN, which always opens the panel's own data view and cannot be pointed
    # at a saved search - verified in the drilldown edit form, which offers only a name, a trigger
    # and open-in-new-tab, and in the create form, which offers only Go to Dashboard, Open in
    # Discover and Go to URL. The dashboard held no reference to it either.
    expected_objects = {"skp-logs", "skp-outcomes-bins", "skp-outcomes-pie",
                        "skp-operator-outcomes"}
    try:
        found = requests.get(
            f"{kibana_url}/api/saved_objects/_find"
            "?type=dashboard&type=lens&type=search&type=index-pattern&per_page=100",
            headers={"kbn-xsrf": "true"}, timeout=20).json()
        ids = {obj["id"] for obj in found.get("saved_objects", [])}
        by_workflow = _terms(es_url, "attributes.WorkflowId", window, names=names)
    except Exception as exc:  # noqa: BLE001
        return checks.report(9, "Genuinely generic", False, f"{type(exc).__name__}: {exc}")
    missing_objects = expected_objects - ids
    ok = not missing_objects and len(by_workflow) >= 2
    return checks.report(9, "Genuinely generic", ok,
                         f"workflows with counted records={list(by_workflow)}, "
                         f"missing saved objects={missing_objects or 'none'}")


def check_10_rule_classifies_the_fixture(checks, es_url):
    """The counted set, run against the twelve-and-one document fixture.

    WHY A FIXTURE AT ALL, when there is live traffic. Three of the templates carrying
    attributes.Result -- an input-schema rejection, an output-schema rejection and an unhandled
    transform fault -- do not fire in a healthy run, and they are the three an operator most needs
    to see. Live measurement can never cover them. This is the successor to the pipeline's
    _simulate fixture, which tested the same thing against an ingest pipeline that no longer exists.

    WHAT THIS DOES NOT PROVE. The dashboard states the rule as KQL; this runs the equivalent query
    DSL. The two are tied together by check 11, which pins the KQL string, and by the fact that
    Kibana renders the expected series from it. There is no Kibana endpoint that will evaluate a KQL
    string on demand, so an exact KQL-versus-DSL equality cannot be asserted from a script.
    """
    index = "skp-classification-fixture"
    try:
        fixture = json.load(open(FIXTURE, encoding="utf-8"))
        docs = fixture["docs"]

        requests.delete(f"{es_url}/{index}", timeout=30)
        # The real data stream maps every string as a keyword via an all_strings_to_keywords
        # dynamic template. Reproduce that, or `term` queries here would silently miss.
        requests.put(f"{es_url}/{index}", timeout=30, json={"mappings": {"dynamic_templates": [
            {"all_strings_to_keywords": {"match_mapping_type": "string",
                                         "mapping": {"type": "keyword"}}}]}}).raise_for_status()

        bulk = []
        for doc in docs:
            bulk.append(json.dumps({"index": {"_id": doc["id"]}}))
            bulk.append(json.dumps(doc["_source"]))
        requests.post(f"{es_url}/{index}/_bulk?refresh=true",
                      data="\n".join(bulk) + "\n",
                      headers={"Content-Type": "application/x-ndjson"}, timeout=60).raise_for_status()

        query = {"bool": {"filter": [{"exists": {"field": "attributes.Result"}}],
                          "must_not": [{"term": {"resource.attributes.service.name": "orchestrator"}}]}}
        hits = requests.post(f"{es_url}/{index}/_search",
                             json={"size": 100, "query": query, "_source": False}, timeout=30).json()
        counted = {h["_id"] for h in hits["hits"]["hits"]}
    except Exception as exc:  # noqa: BLE001
        return checks.report(10, "Rule classifies the fixture", False, f"{type(exc).__name__}: {exc}")
    finally:
        requests.delete(f"{es_url}/{index}", timeout=30)

    expected = {d["id"] for d in docs if d["counted"]}
    wrong_in = counted - expected
    wrong_out = expected - counted
    ok = not wrong_in and not wrong_out
    return checks.report(10, "Rule classifies the fixture", ok,
                         f"{len(counted)}/{len(expected)} counted of {len(docs)} documents, "
                         f"counted_but_should_not={sorted(wrong_in) or 'none'}, "
                         f"not_counted_but_should_be={sorted(wrong_out) or 'none'}")


def check_11_export_states_the_rule_once(checks):
    """The rule lives in the dashboard's query, once, and nowhere else in the export.

    This is what replaces the pipeline-written flag as the single definition. It also catches the
    failure the old design was designed around: the rule restated across four Kibana objects that
    then drift apart.

    It additionally asserts that unknownKeyValue is ABSENT from every formatter - now a guard
    against re-introducing one, not a live mechanism: the current data view carries no formatters
    at all, and names ride on the records themselves. Setting it would make every unmapped entity
    render as one shared string, so two unlabelled steps would collapse into a single legend
    bucket. This check keeps that from silently coming back.
    """
    try:
        objects = [json.loads(line) for line in open(EXPORT, encoding="utf-8") if line.strip()]
    except Exception as exc:  # noqa: BLE001
        return checks.report(11, "Export states the rule once", False, f"{type(exc).__name__}: {exc}")

    queries, unknown_keys, option_scope = {}, [], []
    filters_by_dashboard, panel_queries, vis_states = {}, {}, {}
    for obj in objects:
        if obj.get("type") == "dashboard":
            source = json.loads(obj["attributes"]["kibanaSavedObjectMeta"]["searchSourceJSON"])
            # KEYED BY DASHBOARD, not appended, since 2026-09-22c. The export carries a second
            # dashboard now (skp-whitelist-verdicts), which states a DIFFERENT rule over a
            # DIFFERENT atom -- one record per whitelist lookup rather than one per step outcome.
            # A flat list made "the rule is stated once" and "there is exactly one dashboard" the
            # same assertion, and only the first of those was ever the point.
            queries[obj["id"]] = source.get("query", {}).get("query", "")
            # THE CONTROLS IGNORE THE QUERY but NOT the time range, so their option lists are
            # what is relevant to the window on screen - 2 workflows and 13 steps over 15 minutes
            # here, 6 and 40 over 30 days. Ignoring the time range as well was tried and reverted:
            # it drew the lists from every id ever indexed, 156 workflows and 780 steps against a
            # registry of 6 and 42, and it offered a 15-minute view workflows that last ran a week
            # earlier. A dashboard FILTER bounds the wide end, because ignoreFilters is
            # deliberately left false.
            #
            # It admits a record that carries a Result or is a naming record, which is a SUPERSET
            # of the counted set - so it bounds the dropdowns without moving a single count.
            filters_by_dashboard[obj["id"]] = source.get("filter", [])
            for flt in source.get("filter", []):
                option_scope.append(json.dumps(flt.get("query", {}), sort_keys=True))
        if obj.get("type") == "lens":
            # A KQL panel states its query under "query", an ES|QL panel under "esql".
            query = obj["attributes"]["state"].get("query", {})
            panel_queries[obj["id"]] = query.get("query") or query.get("esql", "")
        if obj.get("type") == "visualization":
            source = json.loads(obj["attributes"]["kibanaSavedObjectMeta"]["searchSourceJSON"])
            panel_queries[obj["id"]] = source.get("query", {}).get("query", "")
            vis_states[obj["id"]] = json.loads(obj["attributes"].get("visState", "{}"))
        if obj.get("type") == "index-pattern":
            for field, fmt in json.loads(obj["attributes"].get("fieldFormatMap", "{}")).items():
                if "unknownKeyValue" in fmt.get("params", {}):
                    unknown_keys.append(field)

    raw = raw_export = open(EXPORT, encoding="utf-8").read()
    stale = raw.count("skp.outcome_record") + raw.count("skp.step_name") + \
        raw.count("skp.workflow_name") + raw.count("skp.processor_name")

    # attributes.EntityName IS NO LONGER ONE OF THESE. The bound used to admit naming records,
    # emitted once per entity on an accepted start so a published-but-never-run step still appeared
    # in a dropdown. Those records were removed long before this change and the live dashboard has
    # not referenced them since -- the repo export merely kept saying so. What bounds the option
    # lists now is a record carrying an outcome or a whitelist verdict, which is a superset of the
    # counted set and therefore moves no count.
    scoped = any('"attributes.WhitelistVerdict"' in f and '"attributes.Result"' in f
                 for f in option_scope)

    # The outcomes dashboard states the rule, and no other object may restate it -- that second
    # half is what the original flat comparison was really enforcing, and it is kept explicitly.
    states_rule = queries.get(OUTCOMES_DASHBOARD) == DASHBOARD_KQL
    # Still exactly once, now measured over the whole file rather than over dashboard queries:
    # the rule is a clause inside DASHBOARD_KQL, and no other object may repeat it.
    # Backslashes stripped first: searchSourceJSON is a JSON string inside a JSON object, so the
    # quotes in the rule are escaped once or twice depending on nesting depth. Counting the raw
    # bytes finds nothing and reads as "the rule is stated zero times", which is not a state the
    # file can be in.
    # ONE PER PLACE THAT IS SUPPOSED TO STATE IT, not one full stop. Until 2026-09-26 this asserted
    # restated == 1: the rule lived only in the dashboard query and the two outcome panels leaned on
    # it. That is precisely what let a fourth dashboard clause admit orchestrator terminal records
    # into panels whose guard only asked for attributes.Result, doubling the terminal step. The
    # panels now state the rule themselves, so the expected count is the dashboard plus each panel
    # guarded by it -- and an occurrence ANYWHERE ELSE still fails, which is the drift this check
    # exists to catch. Drift WITHIN a guarded panel is caught by missing_guards below, which compares
    # each panel's query to its guard verbatim.
    expected_restatements = 1 + sum(1 for g in PANEL_GUARDS.values() if g == COUNTED_KQL)
    restated = raw_export.replace("\\", "").count(COUNTED_KQL)

    missing_guards = sorted(
        i for i, expected in PANEL_GUARDS.items() if panel_queries.get(i) != expected)

    split = [a for a in vis_states.get("skp-whitelist-pies", {}).get("aggs", [])
             if a.get("schema") == "split"]
    pair_split = (len(split) == 1 and split[0].get("type") == "multi_terms"
                  and split[0]["params"].get("fields") == WHITELIST_SPLIT_FIELDS)

    # EVERY dashboard's controls must be bounded, not just the outcomes one: an unbounded Workflow
    # dropdown lists every id in the window whether or not the board can say anything about it.
    unbounded = sorted(i for i, f in filters_by_dashboard.items() if not f)

    ok = (states_rule and restated == expected_restatements and not unbounded and not missing_guards
          and pair_split and not unknown_keys and stale == 0 and scoped)
    return checks.report(11, "Export states the rule once", ok,
                         f"dashboard_query_matches={states_rule}, "
                         f"rule_stated_times={restated}/{expected_restatements}, "
                         f"panels_missing_their_guard={missing_guards or 'none'}, "
                         f"whitelist_splits_on_the_pair={pair_split}, "
                         f"dashboards_with_unbounded_controls={unbounded or 'none'}, "
                         f"stale_enrichment_references={stale}, "
                         f"formatters_reintroducing_unknownKeyValue={unknown_keys or 'none'}, "
                         f"control_options_bounded={scoped}")


def check_12_published_steps_are_nameable(checks, es_url, names):
    """Every step the bins chart expects has a label, and every whitelist pair is readable.

    WHAT THIS NO LONGER CLAIMS. It used to assert that a published-but-never-run step would appear
    in the Step dropdown. That guarantee is gone and its absence is now structural rather than
    incidental: an optionsListControl lists values PRESENT IN THE FIELD, and the name is stamped
    onto a record by the process that writes it, so a step that has never executed has no record
    and therefore no entry. Publishing more rows cannot change that - only running the step can.

    NOTHING IS HAND-MAINTAINED HERE ANY MORE. The whitelist board splits on the pair
    attributes.StepName + attributes.WhitelistRoot, one pie per pair, both fields read straight off
    each record - StepName is set by the processor itself from L2, WhitelistRoot as before. It used
    to split on a runtime field whose lookup was keyed by pairs OBSERVED IN THE DATA and derivable
    from no entity, which nothing regenerated - a newly gated step drew a pie titled "{GUID} - {root}"
    until somebody hand-edited the export. A pair is now unreadable only when the step's own name was
    unresolved in L2, which is the same failure the id fallback already reports, so this check reads
    the records rather than the export.
    """
    resolved = set(names.values())
    missing = [s for s in PER_CYCLE_BY_STEP if s not in resolved]

    body = {"size": 0,
            "query": {"bool": {"filter": [{"exists": {"field": "attributes.WhitelistVerdict"}}]}},
            "aggs": {"pairs": {"multi_terms": {
                "terms": [{"field": "attributes.StepName"}, {"field": "attributes.WhitelistRoot"}],
                "size": 1000}}}}
    try:
        agg = requests.post(f"{es_url}/{DATA_STREAM}/_search", json=body, timeout=60).json()
        pairs = [tuple(b["key"]) for b in agg["aggregations"]["pairs"]["buckets"]]
    except Exception as exc:  # noqa: BLE001
        return checks.report(12, "Published steps are nameable", False,
                             f"whitelist pair read failed: {type(exc).__name__}: {exc}")

    # An unreadable pair is one whose step name is the D2 fallback (the id suffix alone).
    unlabelled = sorted(f"{s} · {r}" for s, r in pairs if skp_names.is_fallback(s))

    ok = not missing and not unlabelled
    return checks.report(12, "Published steps are nameable", ok,
                         f"{len(resolved)} steps carry a name in L2, "
                         f"missing={missing or 'none'}, "
                         f"whitelist_pairs={len(pairs)}, "
                         f"unlabelled_pairs={unlabelled or 'none'}")


def _get_json(url):
    import urllib.request, json as _json
    with urllib.request.urlopen(url, timeout=30) as r:
        return _json.load(r)


def _get_text(url):
    """None when the row is not a workflow the API knows; the served body otherwise."""
    import urllib.request, urllib.error
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            return r.read().decode("utf-8")
    except urllib.error.HTTPError:
        return None


def _live_workflow_id(api_url, name_version):
    """The workflow id(s) in BaseApi's registry whose name_version matches. Ideally exactly one.

    Workflow and step name keys are never deleted, and a rebuild re-creates a workflow row with a fresh GUID - so
    L2 can hold several filefetcher-archiveexpander-chain_1.0.0-<suffix> names after any rebuild,
    only one of which is live. Scanning load_names() for a match would silently pick an arbitrary,
    possibly dead id; the registry has exactly one row per (name, version) and is the source of
    truth for which id BaseApi will actually run.
    """
    workflows = _get_json(f"{api_url}/api/v1/workflows")
    return [wf["id"] for wf in workflows if f'{wf["name"]}_{wf["version"]}' == name_version]


def check_13_diagram_agrees_with_the_dashboard(checks, es_url, names, api_url=DEFAULT_API):
    """Every name drawn on the chain diagram is a name the dashboard renders, and the diagram's
    step-to-processor wiring matches what the index actually shows.

    WHY THIS IS A CORRECTNESS CHECK AND NOT A TIDINESS ONE. Nothing in this system makes a name
    unique. There is no unique index on Name, and none on (Name, Version) either - a processor's
    identity is its SourceHash, and a step's is its id. Two steps called `split-importer` at 1.0.0
    and 2.0.0 can coexist, each with its own row, and a workflow can reference either. So a diagram
    labelled with a bare name does not identify a node: the moment a second version is published it
    points at two rows with no way to tell which, and it can silently describe the wrong one.

    That is why the diagram carries {name}_{version}, exactly as the records themselves carry it -
    there is no field formatter involved any more. This check is what keeps the two from drifting -
    the diagram is hand-authored and was
    captured from the live API on a particular day, so a rename or a version bump is otherwise
    invisible to it.

    THE PAIRING HALF READS THE INDEX, NOT THE API. Any counted record carries both StepId and
    ProcessorId, so the real wiring can be observed rather than asked for. A step that has not run
    in the window cannot be checked this way and is reported as unverified rather than passed.
    """
    try:
        # EVERY diagram, not just the chain's. Each workflow now has its own, and a rename in any of
        # them desyncs that workflow's panel from its bars just as silently.
        # EVERY PUBLISHED diagram, read from the API - not from disk, and not the placeholder.
        # A workflow nobody has drawn serves a card that says so; parsing it would count its caption
        # as a step name.
        diagram_steps, diagram_procs, pairs = [], [], []
        drawn, unpublished = [], []
        for wf in _get_json(f"{api_url}/api/v1/workflows"):
            label = f'{wf["name"]}_{wf["version"]}'
            svg = _get_text(f'{api_url}/api/v1/workflows/{wf["id"]}.svg')
            if svg is None:
                continue
            if "No diagram published" in svg:
                unpublished.append(label)
                continue
            drawn.append(label)

            # <text class="n-step">split-importer<tspan class="n-step-ver">_1.0.0</tspan></text>
            def labels(cls, _svg=svg):
                out = []
                for m in re.finditer(r'<text class="%s"[^>]*>([^<]*)(?:<tspan[^>]*>([^<]*)</tspan>)?' % cls, _svg):
                    out.append((m.group(1) or "") + (m.group(2) or ""))
                return out
            steps, procs = labels("n-step"), labels("n-proc")
            diagram_steps += steps
            diagram_procs += procs
            pairs += list(zip(steps, procs))

        # A CHECK THAT VERIFIES NOTHING MUST SAY SO. With no diagram published there is nothing to
        # compare, and reporting that as a pass is how this check went blind in the first place.
        if not drawn:
            return checks.report(13, "Diagram agrees with the dashboard", False,
                                 f"no workflow has a published diagram - nothing to verify "
                                 f"({len(unpublished)} serving the placeholder)")
    except Exception as exc:  # noqa: BLE001
        return checks.report(13, "Diagram agrees with the dashboard", False, f"{type(exc).__name__}: {exc}")

    rendered_steps = set(names.values())
    rendered_procs = set(names.values())
    unknown = ([s for s in diagram_steps if s not in rendered_steps] +
               [p for p in diagram_procs if p not in rendered_procs])

    # The wiring the index actually shows, keyed by the same {name}_{version} labels.
    body = {"size": 0, "query": {"bool": {"filter": [{"exists": {"field": "attributes.Result"}}]}},
            "aggs": {"pairs": {"multi_terms": {
                "terms": [{"field": "attributes.StepId"}, {"field": "attributes.ProcessorId"}],
                "size": 200}}}}
    try:
        buckets = requests.post(f"{es_url}/{DATA_STREAM}/_search", json=body, timeout=60).json()
        observed = {}
        for bucket in buckets["aggregations"]["pairs"]["buckets"]:
            step_id, processor_id = bucket["key"]
            step = names.get(step_id)
            processor = names.get(processor_id)
            if step and processor:
                observed.setdefault(step, set()).add(processor)
    except Exception as exc:  # noqa: BLE001
        return checks.report(13, "Diagram agrees with the dashboard", False, f"{type(exc).__name__}: {exc}")

    wrong, unverified = [], []
    for step, processor in pairs:
        if step not in observed:
            unverified.append(step)
        elif processor not in observed[step]:
            wrong.append(f"{step} drawn on {processor}, index says {sorted(observed[step])}")

    ok = not unknown and not wrong
    return checks.report(13, "Diagram agrees with the dashboard", ok,
                         f"{len(diagram_steps)} steps / {len(set(diagram_procs))} processors drawn, "
                         f"names_not_on_dashboard={unknown or 'none'}, "
                         f"wiring_mismatch={wrong or 'none'}, "
                         f"unverified_no_traffic={unverified or 'none'}")


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--kibana-url", default=DEFAULT_KIBANA)
    parser.add_argument("--es-url", default=DEFAULT_ES)
    parser.add_argument("--api-url", default=DEFAULT_API)
    parser.add_argument("--redis-host", default=DEFAULT_REDIS[0])
    parser.add_argument("--redis-port", type=int, default=DEFAULT_REDIS[1])
    parser.add_argument("--window", default="now-30m",
                        help="ES date-math lower bound for the counting checks. Unlike the previous "
                             "design there is no forward-only enrichment window to stay inside - "
                             "each record is stamped with its name by the process that wrote it, so "
                             "there is nothing an ingest-time window could miss. The bound is only "
                             "about having enough cycles to compare against.")
    args = parser.parse_args()

    checks = Checks()
    try:
        names = load_names(args.redis_host, args.redis_port)
    except Exception as exc:  # noqa: BLE001
        print(f"could not read skp:{{wf|step|proc}}:{{id}} name from Redis at {args.redis_host}:{args.redis_port}: "
              f"{type(exc).__name__}: {exc}")
        return 1

    # THE LIVE WORKFLOW ID COMES FROM THE REGISTRY, NOT FROM SCANNING names. See _live_workflow_id.
    try:
        matches = _live_workflow_id(args.api_url, VALIDATION_WORKFLOW)
    except Exception as exc:  # noqa: BLE001
        print(f"could not read {args.api_url}/api/v1/workflows: {type(exc).__name__}: {exc}")
        return 1
    if len(matches) != 1:
        print(f"expected exactly one live workflow named {VALIDATION_WORKFLOW} at {args.api_url}, "
              f"found {matches or 'none'} - start that workflow once so BaseApi registers it")
        return 1
    workflow_id = matches[0]

    check_1_kibana_reaches_es(checks, args.kibana_url)
    check_4_totals_match_the_cycle(checks, args.es_url, args.window, names, workflow_id)
    check_5_one_witness_per_step(checks, args.es_url, args.window)
    check_6_every_step_has_a_bin(checks, args.es_url, args.window, names, workflow_id)
    check_7_pie_matches_bins(checks, args.es_url, args.window, names, workflow_id)
    check_9_generic_across_workflows(checks, args.es_url, args.kibana_url, args.window, names)
    check_10_rule_classifies_the_fixture(checks, args.es_url)
    check_11_export_states_the_rule_once(checks)
    check_12_published_steps_are_nameable(checks, args.es_url, names)
    check_13_diagram_agrees_with_the_dashboard(checks, args.es_url, names, api_url=args.api_url)

    print()
    print(f"{checks.failures} check(s) failed")
    return 1 if checks.failures else 0


if __name__ == "__main__":
    sys.exit(main())
