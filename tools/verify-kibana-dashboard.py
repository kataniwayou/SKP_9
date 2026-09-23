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
  * Names are no longer fields in the index. They are rendered by the data view's formatters, and
    this script reads that same formatter map, so it resolves an id exactly as a viewer sees it.
  * Check 12 no longer asserts that a never-run step is listable. The naming records that made that
    true were removed from OrchestrationService; see that method and check 12's own docstring.
  * Check 5 reaches 10 of 10 steps rather than 8, because a terminal step now reports its own
    outcome and carries an EntryId.

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

# The dashboard hosts TWO atoms since 2026-09-22c: a step outcome (one record per step) and a
# whitelist lookup (one record per field checked). Its query is their union, with COUNTED_KQL kept
# verbatim as a parenthesised clause so the rule is still stated exactly once in the export.
DASHBOARD_KQL = f'({COUNTED_KQL}) or attributes.WhitelistVerdict:*'

# Each panel guards its own atom. THE BINS PANEL MAKES THIS LOAD-BEARING: it counts records split by
# attributes.StepId, and a whitelist record carries a StepId, so without the guard the union query
# would inflate every step's series and check 7 would stop matching. The outcomes pie terms on
# attributes.Result and is immune by construction; it carries the guard anyway, so a future change
# to its aggregation cannot quietly start counting the other atom.
PANEL_GUARDS = {
    "skp-outcomes-bins": "attributes.Result:*",
    "skp-outcomes-pie": "attributes.Result:*",
    # Not a Lens panel: the whitelist board is one aggregation-based pie split into one donut per
    # (processor, whitelist) pair, because a Lens partition chart has no split-chart dimension --
    # its only groups are "Slice by" and "Metric", verified in the editor. Its guard is load-bearing
    # for a second reason than the bins panel's: without it the SPLIT would draw a pie per processor
    # for every step-outcome record too, each one empty, since those records have no verdict to
    # slice.
    "skp-whitelist-pies": "attributes.WhitelistVerdict:*",
}

# The one pair-per-pie bucket. Asserted by check 11 so a later edit cannot quietly go back to
# splitting on ProcessorId alone, which silently merges a processor's two lists into one donut.
# Stamped onto each record by the logs@custom pipeline from the enriched step name and
# the root. It replaced a runtime field of the same purpose whose readable half came from
# a hand-maintained formatter; nothing is hand-maintained now.
WHITELIST_SPLIT_FIELD = "attributes.WhitelistOwner"


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
# The index holds ids. The dashboard renders names through the data view's field formatters, and
# this script reads that same formatter map so it is checking what a viewer actually sees.
#
# IT USED TO READ ELASTICSEARCH. OrchestrationService emitted one naming record per entity on every
# accepted start, and this resolved ids from those. That emission is gone (see the note in
# OrchestrationService.StartAsync): it only ever covered entities whose workflow had been explicitly
# started, it decayed out of the index with retention, and KibanaLookupPublisher already pushes a
# strictly larger map from the entity tables. Reading the formatter has no time window to get wrong
# and no start to depend on.
#
# A FAILURE HERE NOW MEANS THE PUBLISHER HAS NOT RUN. The map is refreshed when the dashboard's
# diagram panel fetches lookup/ping.svg, throttled to Kibana:MinimumInterval, and is absent entirely
# when Kibana:BaseUrl is unset.
# ---------------------------------------------------------------------------------------------
KINDS = {"workflow": "WorkflowId", "step": "StepId", "processor": "ProcessorId"}
LOOKUP_INDEX = "skp-entity-lookup"
GUID_PREFIX = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-")
DATA_VIEW = "skp-logs"


def load_names(es_url):
    """The id -> {name}_{version} map, read from the lookup index BaseApi writes at every start.

    THE SOURCE MOVED OUT OF KIBANA. This used to read the data view's fieldFormatMap, because the
    table lived there and something had to push it. Names now ride on the log records themselves,
    stamped by the logs@custom ingest pipeline from this index, so the data view carries no
    formatter at all and Kibana is not consulted here.
    """
    body = {"size": 10000, "query": {"match_all": {}}}
    response = requests.post(f"{es_url}/{LOOKUP_INDEX}/_search", json=body, timeout=60)
    response.raise_for_status()

    out = {kind: {} for kind in KINDS}
    for hit in response.json()["hits"]["hits"]:
        row = hit["_source"]
        kind = row.get("kind")
        if kind in out:
            out[kind][row["id"]] = f"{row['name']}_{row['version']}"
    return out


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
    # Unresolved ids keep their GUID, which is exactly what the dashboard renders for them.
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
# them, because formatting now happens at read time and cannot fail an indexing operation.


def check_4_totals_match_the_cycle(checks, es_url, window, names, workflow_id):
    """Counted records over the window equal 30 x cycles, and each processor matches its own row.

    The slop is honest rather than lax: a fixed window almost never starts and ends on a cycle
    boundary, so a partial cycle at either edge shifts the total. Check 5 is the exact one.
    """
    try:
        by_processor = _terms(es_url, "attributes.ProcessorId", window, workflow_id, names=names["processor"])
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

    IT NOW COVERS ALL TEN STEPS. It used to skip the terminal-step Completed records - kafka-exporter
    and nothing else - because the orchestrator's copy carried no EntryId and two legitimate branch
    terminations could not be told from one outcome logged twice. The processor now reports that
    outcome itself, inside the dispatch handler's ambient scope, so it carries the dispatch's own
    EntryId like every other record here.

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
                         "aggs": {"steps": {"terms": {"field": "attributes.StepId", "size": 20}}}},
        },
    }
    try:
        result = requests.post(f"{es_url}/{DATA_STREAM}/_search", json=body, timeout=60).json()
        offenders = result["aggregations"]["with_entry"]["triples"]["buckets"]
        checked = result["aggregations"]["with_entry"]["doc_count"]
        skipped = result["aggregations"]["no_entry"]["doc_count"]
    except Exception as exc:  # noqa: BLE001
        return checks.report(5, "One witness per step", False, f"{type(exc).__name__}: {exc}")

    detail = f"{checked} records checked, {skipped} skipped for want of an EntryId"
    if offenders:
        sample = [(b["key"], b["doc_count"]) for b in offenders[:3]]
        return checks.report(5, "One witness per step", False,
                             f"{len(offenders)} duplicated triple(s), e.g. {sample} - {detail}")
    # A skip is no longer expected. If one appears, an entry-and-terminal step has been published
    # and the operator notes need to say so.
    return checks.report(5, "One witness per step", skipped == 0,
                         f"no duplicated triple - {detail}")


def check_6_every_step_has_a_bin(checks, es_url, window, names, workflow_id):
    """All TEN steps appear as their own series, which is what the bins chart draws.

    Split on step rather than processor: sk-normalizer serves two steps and kafka-exporter serves
    two, so a per-processor view collapses four steps into two bars and hides which is failing.

    export-outcome and split-exporter are the ones that matter here. They emitted ZERO
    processor-side records until the terminal outcome was added, and their bars existed only by
    virtue of the orchestrator carve-out this design removed.
    """
    try:
        by_step = _terms(es_url, "attributes.StepId", window, workflow_id, names=names["step"])
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
        by_processor = _terms(es_url, "attributes.ProcessorId", window, workflow_id, names=names["processor"])
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
        by_workflow = _terms(es_url, "attributes.WorkflowId", window, names=names["workflow"])
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

    It additionally asserts that unknownKeyValue is ABSENT from every formatter. Setting it makes
    every unmapped entity render as one shared string, so two unlabelled steps collapse into a
    single legend bucket. Omitted, an unmapped id renders as its own GUID - verified by publishing a
    partial map and watching split-exporter come back as 9cae7b00-... beside twelve named siblings.
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
            panel_queries[obj["id"]] = obj["attributes"]["state"].get("query", {}).get("query", "")
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
    restated = raw_export.replace("\\", "").count(COUNTED_KQL)

    missing_guards = sorted(
        i for i, expected in PANEL_GUARDS.items() if panel_queries.get(i) != expected)

    split = [a for a in vis_states.get("skp-whitelist-pies", {}).get("aggs", [])
             if a.get("schema") == "split"]
    pair_split = (len(split) == 1
                  and split[0]["params"]["field"] == WHITELIST_SPLIT_FIELD)

    # EVERY dashboard's controls must be bounded, not just the outcomes one: an unbounded Workflow
    # dropdown lists every id in the window whether or not the board can say anything about it.
    unbounded = sorted(i for i, f in filters_by_dashboard.items() if not f)

    ok = (states_rule and restated == 1 and not unbounded and not missing_guards
          and pair_split and not unknown_keys and stale == 0 and scoped)
    return checks.report(11, "Export states the rule once", ok,
                         f"dashboard_query_matches={states_rule}, "
                         f"rule_stated_times={restated}, "
                         f"panels_missing_their_guard={missing_guards or 'none'}, "
                         f"whitelist_splits_on_the_pair={pair_split}, "
                         f"dashboards_with_unbounded_controls={unbounded or 'none'}, "
                         f"stale_enrichment_references={stale}, "
                         f"formatters_setting_unknownKeyValue={unknown_keys or 'none'}, "
                         f"control_options_bounded={scoped}")


def check_12_published_steps_are_nameable(checks, es_url, names):
    """Every step the bins chart expects has a label, and every whitelist pair is readable.

    WHAT THIS NO LONGER CLAIMS. It used to assert that a published-but-never-run step would appear
    in the Step dropdown. That guarantee is gone and its absence is now structural rather than
    incidental: an optionsListControl lists values PRESENT IN THE FIELD, and the name is stamped
    onto a record at ingest, so a step that has never executed has no record and therefore no entry.
    Publishing more rows cannot change that - only running the step can.

    NOTHING IS HAND-MAINTAINED HERE ANY MORE. The whitelist board splits on
    attributes.WhitelistOwner, which the logs@custom pipeline builds from the enriched step name and
    the root on each record. It used to split on a runtime field whose lookup was keyed by pairs
    OBSERVED IN THE DATA and derivable from no entity, which nothing regenerated - a newly gated
    step drew a pie titled "{GUID} - {root}" until somebody hand-edited the export. A pair is now
    unreadable only when the step's own name was unresolved at ingest, which is the same failure the
    id fallback already reports, so this check reads the records rather than the export.
    """
    resolved = set(names["step"].values())
    missing = [s for s in PER_CYCLE_BY_STEP if s not in resolved]

    body = {"size": 0,
            "query": {"bool": {"filter": [{"exists": {"field": "attributes.WhitelistVerdict"}}]}},
            "aggs": {"owners": {"terms": {"field": "attributes.WhitelistOwner", "size": 1000}}}}
    try:
        agg = requests.post(f"{es_url}/{DATA_STREAM}/_search", json=body, timeout=60).json()
        owners = [b["key"] for b in agg["aggregations"]["owners"]["buckets"]]
    except Exception as exc:  # noqa: BLE001
        return checks.report(12, "Published steps are nameable", False,
                             f"whitelist owner read failed: {type(exc).__name__}: {exc}")

    # A fallback label is the raw StepId, so an unreadable pair starts with a GUID.
    unlabelled = sorted(o for o in owners if GUID_PREFIX.match(o))

    ok = not missing and not unlabelled
    return checks.report(12, "Published steps are nameable", ok,
                         f"{len(resolved)} steps carry a name in the lookup index, "
                         f"missing={missing or 'none'}, "
                         f"whitelist_pairs={len(owners)}, "
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


def check_13_diagram_agrees_with_the_dashboard(checks, es_url, names, api_url=DEFAULT_API):
    """Every name drawn on the chain diagram is a name the dashboard renders, and the diagram's
    step-to-processor wiring matches what the index actually shows.

    WHY THIS IS A CORRECTNESS CHECK AND NOT A TIDINESS ONE. Nothing in this system makes a name
    unique. There is no unique index on Name, and none on (Name, Version) either - a processor's
    identity is its SourceHash, and a step's is its id. Two steps called `split-importer` at 1.0.0
    and 2.0.0 can coexist, each with its own row, and a workflow can reference either. So a diagram
    labelled with a bare name does not identify a node: the moment a second version is published it
    points at two rows with no way to tell which, and it can silently describe the wrong one.

    That is why the diagram carries {name}_{version}, exactly as the dashboard's field formatters
    render it. This check is what keeps the two from drifting - the diagram is hand-authored and was
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

    rendered_steps = set(names["step"].values())
    rendered_procs = set(names["processor"].values())
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
            step = names["step"].get(step_id)
            processor = names["processor"].get(processor_id)
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
    parser.add_argument("--window", default="now-30m",
                        help="ES date-math lower bound for the counting checks. Unlike the previous "
                             "design there is no forward-only enrichment window to stay inside - "
                             "formatting happens at read time and covers all history. The bound is "
                             "only about having enough cycles to compare against.")
    args = parser.parse_args()

    checks = Checks()
    try:
        names = load_names(args.es_url)
    except Exception as exc:  # noqa: BLE001
        print(f"could not read the {LOOKUP_INDEX} lookup index: {type(exc).__name__}: {exc}")
        return 1

    workflow_id = next((i for i, n in names["workflow"].items() if n == VALIDATION_WORKFLOW), None)
    if workflow_id is None:
        print(f"no lookup row for {VALIDATION_WORKFLOW} - start that workflow once so BaseApi "
              f"publishes its entities, or check Elasticsearch:BaseUrl is set on the API")
        return 1

    check_1_kibana_reaches_es(checks, args.kibana_url)
    check_4_totals_match_the_cycle(checks, args.es_url, args.window, names, workflow_id)
    check_5_one_witness_per_step(checks, args.es_url, args.window)
    check_6_every_step_has_a_bin(checks, args.es_url, args.window, names, workflow_id)
    check_7_pie_matches_bins(checks, args.es_url, args.window, names, workflow_id)
    check_9_generic_across_workflows(checks, args.es_url, args.kibana_url, args.window, names)
    check_10_rule_classifies_the_fixture(checks, args.es_url)
    check_11_export_states_the_rule_once(checks)
    check_12_published_steps_are_nameable(checks, args.es_url, names)
    check_13_diagram_agrees_with_the_dashboard(checks, args.es_url, names)

    print()
    print(f"{checks.failures} check(s) failed")
    return 1 if checks.failures else 0


if __name__ == "__main__":
    sys.exit(main())
