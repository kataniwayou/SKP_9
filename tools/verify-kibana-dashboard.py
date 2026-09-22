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
  * Names are no longer fields in the index. They are rendered by the data view's formatters, so
    this script resolves ids to names itself, from the same records the formatter generator reads.
  * Check 5 reaches 10 of 10 steps rather than 8, because a terminal step now reports its own
    outcome and carries an EntryId.

RUN THIS FROM POWERSHELL against live port-forwards:
    ./k8s/port-forward-realstack.ps1
    python tools/verify-kibana-dashboard.py
"""
import argparse
import json
import os
import sys
import time

import requests

DEFAULT_ES = "http://localhost:19200"
DEFAULT_KIBANA = "http://localhost:15601"
DATA_STREAM = "logs-generic.otel-default"

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXPORT = os.path.join(ROOT, "kibana", "kibana-export.ndjson")
FIXTURE = os.path.join(ROOT, "kibana", "classification-fixture.json")

# The chain this dashboard is VALIDATED against, not the one it is built for (spec section 1).
VALIDATION_WORKFLOW = "filefetcher-archiveexpander-chain_1.0.0"

# THE COUNTED SET, as Elasticsearch query DSL. The dashboard states it as KQL; check 10 asserts that
# the two say the same thing by pinning the KQL string, and the fixture proves the semantics on the
# templates live traffic never produces.
COUNTED_KQL = 'attributes.Result:* and not resource.attributes.service.name:"orchestrator"'


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
# The index holds ids. The dashboard renders names through data-view formatters, which is a Kibana
# concern this script cannot see, so it resolves ids the same way the formatter generator does -
# from the records OrchestrationService writes when a workflow is started.
#
# NO TIME WINDOW ON THIS QUERY. Those records are written on an explicit start and not again, so a
# workflow started last week emitted its pairs last week. Bounding this by the measurement window
# would resolve nothing.
# ---------------------------------------------------------------------------------------------
KINDS = {"workflow": "WorkflowId", "step": "StepId", "processor": "ProcessorId"}


def load_names(es_url):
    body = {"size": 0, "query": {"bool": {"filter": [{"exists": {"field": "attributes.EntityName"}}]}},
            "aggs": {}}
    for kind, field in KINDS.items():
        body["aggs"][kind] = {
            "terms": {"field": f"attributes.{field}", "size": 1000},
            "aggs": {"latest": {"top_hits": {"size": 1, "sort": [{"@timestamp": {"order": "desc"}}],
                                             "_source": ["attributes.EntityName",
                                                         "attributes.EntityKind"]}}}}
    aggs = requests.post(f"{es_url}/{DATA_STREAM}/_search", json=body, timeout=60).json()["aggregations"]
    out = {}
    for kind in KINDS:
        pairs = {}
        for bucket in aggs[kind]["buckets"]:
            source = bucket["latest"]["hits"]["hits"][0]["_source"]["attributes"]
            if source.get("EntityKind") == kind:
                pairs[bucket["key"]] = source["EntityName"]
        out[kind] = pairs
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
    expected_objects = {"skp-logs", "skp-outcomes-bins", "skp-outcomes-pie",
                        "skp-outcome-records", "skp-operator-outcomes"}
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

    queries, unknown_keys = [], []
    for obj in objects:
        if obj.get("type") == "dashboard":
            source = json.loads(obj["attributes"]["kibanaSavedObjectMeta"]["searchSourceJSON"])
            queries.append(source.get("query", {}).get("query", ""))
        if obj.get("type") == "index-pattern":
            for field, fmt in json.loads(obj["attributes"].get("fieldFormatMap", "{}")).items():
                if "unknownKeyValue" in fmt.get("params", {}):
                    unknown_keys.append(field)

    raw = open(EXPORT, encoding="utf-8").read()
    stale = raw.count("skp.outcome_record") + raw.count("skp.step_name") + \
        raw.count("skp.workflow_name") + raw.count("skp.processor_name")

    ok = queries == [COUNTED_KQL] and not unknown_keys and stale == 0
    return checks.report(11, "Export states the rule once", ok,
                         f"dashboard_query_matches={queries == [COUNTED_KQL]}, "
                         f"stale_enrichment_references={stale}, "
                         f"formatters_setting_unknownKeyValue={unknown_keys or 'none'}")


def check_12_published_steps_are_nameable(checks, es_url, names):
    """Every step the bins chart expects has a naming record, so the dropdown can list it.

    THE POINT IS THE STEP THAT HAS NEVER RUN. A dropdown is populated from one field's values, and
    the Step control reads attributes.StepId. Because OrchestrationService writes the naming record
    under that same field rather than a generic EntityId, a published step has a record carrying its
    StepId from the moment its workflow is started - whether or not it has ever executed. With the
    control group ignoring the query and the time range, that is what puts it in the list.

    What this asserts is that the naming records exist and resolve. The never-run case is covered by
    construction rather than by a workflow that has genuinely never run, and that limitation is
    stated here rather than implied.
    """
    resolved = set(names["step"].values())
    missing = [s for s in PER_CYCLE_BY_STEP if s not in resolved]
    ok = not missing
    return checks.report(12, "Published steps are nameable", ok,
                         f"{len(resolved)} steps have naming records, "
                         f"missing={missing or 'none'}")


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
        print(f"could not load id->name pairs: {type(exc).__name__}: {exc}")
        return 1

    workflow_id = next((i for i, n in names["workflow"].items() if n == VALIDATION_WORKFLOW), None)
    if workflow_id is None:
        print(f"no naming record for {VALIDATION_WORKFLOW} - start it once so it emits its pairs")
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

    print()
    print(f"{checks.failures} check(s) failed")
    return 1 if checks.failures else 0


if __name__ == "__main__":
    sys.exit(main())
