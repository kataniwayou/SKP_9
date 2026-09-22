#!/usr/bin/env python3
"""
Executable form of section 9 of docs/superpowers/specs/2026-09-22-kibana-operator-dashboard-design.md.

Every check prints PASS or FAIL with the measured numbers beside it, and the script exits non-zero
if any check failed. Check 8 (a drill-down click) is not here: it is a UI action and is listed in
docs/testing/kibana-operator-dashboard.md as the one manual step.

RUN THIS FROM POWERSHELL against live port-forwards:
    ./k8s/port-forward-realstack.ps1
    python tools/verify-kibana-dashboard.py
"""
import argparse
import sys

import requests

DEFAULT_ES = "http://localhost:19200"
DEFAULT_KIBANA = "http://localhost:15601"
DEFAULT_API = "http://localhost:18080"
DATA_STREAM = "logs-generic.otel-default"

# The chain this dashboard is VALIDATED against, not the one it is built for (spec section 1).
VALIDATION_WORKFLOW = "filefetcher-archiveexpander-chain"


class Checks:
    """Collects results so one failure does not hide the checks after it."""

    def __init__(self):
        self.failures = 0

    def report(self, number, title, ok, detail):
        print(f"[{'PASS' if ok else 'FAIL'}] check {number}: {title} - {detail}")
        if not ok:
            self.failures += 1
        return ok


def check_1_kibana_reaches_es(checks, kibana_url):
    """Kibana is up and its Elasticsearch connection is green."""
    try:
        response = requests.get(f"{kibana_url}/api/status", timeout=15)
        body = response.json()
        overall = body["status"]["overall"]["level"]
        es_plugin = body["status"]["core"]["elasticsearch"]["level"]
    except Exception as exc:  # noqa: BLE001 - any failure here IS the check failing
        return checks.report(1, "Kibana reaches ES", False, f"{type(exc).__name__}: {exc}")
    ok = overall == "available" and es_plugin == "available"
    return checks.report(1, "Kibana reaches ES", ok,
                         f"overall={overall} elasticsearch={es_plugin}")


def check_2a_lookup_is_populated(checks, es_url, api_url):
    """The lookup index holds one row per live entity, and the policy has been executed.

    This is the precondition half of spec check 2: enrichment cannot land if the lookup is
    empty or the policy was never executed after the last sync.
    """
    try:
        counts = {}
        for kind, route in (("workflow", "workflows"), ("step", "steps"),
                            ("processor", "processors")):
            live = requests.get(f"{api_url}/api/v1/{route}", timeout=15).json()
            hit = requests.post(f"{es_url}/skp-entity-names/_count",
                                json={"query": {"term": {"entity_kind": kind}}},
                                timeout=15).json()
            counts[kind] = (len(live), hit.get("count", -1))
        policies = requests.get(f"{es_url}/_enrich/policy/skp-entity-lookup", timeout=15).json()
        enrich_indices = requests.get(
            f"{es_url}/_cat/indices/.enrich-skp-entity-lookup*?format=json", timeout=15).json()
    except Exception as exc:  # noqa: BLE001
        return checks.report("2a", "Lookup populated", False, f"{type(exc).__name__}: {exc}")

    matched = all(live == indexed for live, indexed in counts.values())
    has_policy = bool(policies.get("policies"))
    executed = len(enrich_indices) > 0
    detail = ", ".join(f"{k}: api={v[0]} index={v[1]}" for k, v in counts.items())
    detail += f", policy={has_policy}, .enrich-* indices={len(enrich_indices)}"
    return checks.report("2a", "Lookup populated", matched and has_policy and executed, detail)


def check_2b_enrichment_lands(checks, es_url):
    """A document indexed AFTER the pipeline was installed carries the four skp fields.

    Scoped to the last 10 minutes precisely because enrichment is forward-only (spec 6.3): an
    unscoped query would find 24M pre-install documents and report a false failure.
    """
    body = {
        "size": 1,
        "query": {"bool": {"filter": [
            {"term": {"skp.outcome_record": True}},
            {"range": {"@timestamp": {"gte": "now-10m"}}},
        ]}},
        "sort": [{"@timestamp": "desc"}],
    }
    try:
        hits = requests.post(f"{es_url}/{DATA_STREAM}/_search", json=body, timeout=20).json()
        docs = hits["hits"]["hits"]
    except Exception as exc:  # noqa: BLE001
        return checks.report(2, "Enrichment lands", False, f"{type(exc).__name__}: {exc}")
    if not docs:
        return checks.report(2, "Enrichment lands", False,
                             "no skp.outcome_record document in the last 10m - is the feed running?")
    skp = docs[0]["_source"].get("skp", {})
    present = [f for f in ("workflow_name", "step_name", "processor_name", "outcome_record")
               if f in skp]
    return checks.report(2, "Enrichment lands", len(present) == 4, f"fields present: {present}")


def check_3_unmatched_ids_survive(checks, es_url):
    """An unresolvable GUID leaves the document intact rather than failing it.

    Runs through _simulate rather than indexing junk into the live data stream.
    """
    doc = {
        "pipeline": {"processors": [{"pipeline": {"name": "logs@custom"}}]},
        "docs": [{"_source": {
            "scope": {"name": "BaseProcessor.Core.Processing.ProcessedDataHandler"},
            "attributes": {"Result": "Completed",
                           "{OriginalFormat}": "branch completed in {ElapsedMs}ms",
                           "WorkflowId": "00000000-0000-0000-0000-000000000000"}}}],
    }
    try:
        result = requests.post(f"{es_url}/_ingest/pipeline/_simulate", json=doc, timeout=20).json()
        source = result["docs"][0]["doc"]["_source"]
    except Exception as exc:  # noqa: BLE001
        return checks.report(3, "Unmatched ids survive", False, f"{type(exc).__name__}: {exc}")
    skp = source.get("skp", {})
    ok = (source.get("attributes", {}).get("Result") == "Completed"
          and skp.get("outcome_record") is True
          and "workflow_name" not in skp
          and "enrich_error" not in skp)
    return checks.report(3, "Unmatched ids survive", ok, f"skp={skp}")


# Spec section 4.4, measured over 45 cycles. One cycle of five files yields 30 counted outcomes.
# Cycles are derived from kafka-importer, which emits exactly one Completed per file and never
# fails in a healthy run, so it is the only processor whose count IS the cycle count.
PER_CYCLE_TOTAL = 30
PER_CYCLE_BY_PROCESSOR = {
    "kafka-importer": 5,
    "file-fetcher": 5,
    "archive-expander": 4,
    "sk-normalizer": 4,
    "outcome-recorder": 3,
    "archive-collapser": 2,
    "file-persister": 2,
    "kafka-exporter": 5,
}
PER_CYCLE_BY_RESULT = {"Completed": 26, "Failed": 3, "Cancelled": 1}


def _counted_query(window, workflow=None):
    filters = [
        {"term": {"skp.outcome_record": True}},
        {"range": {"@timestamp": {"gte": window}}},
    ]
    if workflow:
        filters.append({"term": {"skp.workflow_name": workflow}})
    return {"bool": {"filter": filters}}


def _terms(es_url, field, window, workflow=None, size=50):
    body = {"size": 0, "query": _counted_query(window, workflow),
            "aggs": {"by": {"terms": {"field": field, "size": size}}}}
    result = requests.post(f"{es_url}/{DATA_STREAM}/_search", json=body, timeout=30).json()
    return {b["key"]: b["doc_count"] for b in result["aggregations"]["by"]["buckets"]}


def check_4_totals_match_the_cycle(checks, es_url, window):
    """Counted records over the window equal 30 x cycles, within one cycle of edge slop.

    The slop is honest rather than lax: a fixed time window almost never starts and ends on a
    cycle boundary, so a partial cycle at either edge shifts the total. That is exactly why
    check 5 exists and is exact -- this one catches gross miscounting, check 5 catches the
    subtle kind.
    """
    try:
        by_processor = _terms(es_url, "skp.processor_name", window, VALIDATION_WORKFLOW)
    except Exception as exc:  # noqa: BLE001
        return checks.report(4, "Totals match the cycle", False, f"{type(exc).__name__}: {exc}")
    importer = by_processor.get("kafka-importer", 0)
    if importer < 5:
        return checks.report(4, "Totals match the cycle", False,
                             f"only {importer} kafka-importer records in {window}; "
                             "is the feed running?")
    cycles = importer / 5.0
    total = sum(by_processor.values())
    expected = PER_CYCLE_TOTAL * cycles
    ok = abs(total - expected) <= PER_CYCLE_TOTAL

    # PER-PROCESSOR, not just the total, because this is what guards the terminal-step half that
    # check 5 cannot reach: a terminal outcome counted twice reads as kafka-exporter at ~10 per
    # cycle against its expected 5, while the grand total could still look plausible.
    off = {}
    for name, per_cycle in PER_CYCLE_BY_PROCESSOR.items():
        seen = by_processor.get(name, 0)
        want = per_cycle * cycles
        if abs(seen - want) > max(float(per_cycle), want * 0.25):
            off[name] = f"{seen} vs ~{want:.0f}"
            ok = False
    return checks.report(4, "Totals match the cycle", ok,
                         f"cycles={cycles:.1f} total={total} expected~{expected:.0f} "
                         f"per_processor_off={off or 'none'} by_processor={by_processor}")


def check_5_one_witness_per_step(checks, es_url, window):
    """No (StepId, ExecutionId, EntryId) triple carries more than one counted record. EXACT.

    THE KEY IS THREE FIELDS, NOT TWO, AND THAT IS NOT A DETAIL. The design specified
    (StepId, ExecutionId), which is wrong: this chain FANS OUT, so one step legitimately
    completes several times inside a single execution -- file-persister runs twice per cycle and
    archive-collapser once per normalizer branch, all sharing one ExecutionId. EntryId is what
    separates the branches. Keyed on two fields this check reports ~15 "duplicates" per 10
    minutes on a perfectly healthy run, which is worse than no check at all: it would be muted,
    and then it could not do the job section 4.2 built it for.

    ONE SLICE IS NOT COVERED HERE: the terminal-step COMPLETED records, which is kafka-exporter
    and nothing else. Measured, those carry no EntryId, so two legitimate branch terminations are
    indistinguishable from one outcome logged twice. Terminal-CANCELLED records DO carry one and
    are checked normally -- which matters, because the terminal-Cancelled duplicate is exactly the
    section 4.2 defect, and this check catches it directly rather than by inference.

    `attributes.role` does NOT close the gap: orchestrator-result is a shared competing-consumer
    queue and is deliberately NOT leader-gated, so role only records which replica happened to
    take that branch. Filtering to role=leader drops real outcomes -- measured, leader records
    covered 12 of 27 distinct pairs.

    What guards the uncovered slice is check 4's PER-PROCESSOR assertion: a terminal Completed
    counted twice reads as kafka-exporter at ~10 per cycle against its expected 5. That is weaker
    than what this check gives the rest, and the operator notes say so.
    """
    body = {
        "size": 0,
        "query": _counted_query(window),
        "aggs": {
            "with_entry": {
                "filter": {"exists": {"field": "attributes.EntryId"}},
                "aggs": {"triples": {
                    "multi_terms": {
                        "terms": [{"field": "attributes.StepId"},
                                  {"field": "attributes.ExecutionId"},
                                  {"field": "attributes.EntryId"}],
                        "size": 10000,
                        "min_doc_count": 2,
                    }}},
            },
            "no_entry": {"filter": {"bool": {
                "must_not": [{"exists": {"field": "attributes.EntryId"}}]}}},
        },
    }
    try:
        result = requests.post(f"{es_url}/{DATA_STREAM}/_search", json=body, timeout=60).json()
        offenders = result["aggregations"]["with_entry"]["triples"]["buckets"]
        checked = result["aggregations"]["with_entry"]["doc_count"]
        skipped = result["aggregations"]["no_entry"]["doc_count"]
    except Exception as exc:  # noqa: BLE001
        return checks.report(5, "One witness per step", False, f"{type(exc).__name__}: {exc}")
    detail = (f"{checked} records checked, {skipped} terminal records skipped (no EntryId; "
              f"covered by check 4 per-processor)")
    if not offenders:
        return checks.report(5, "One witness per step", True,
                             f"no duplicated triple - {detail}")
    sample = [(b["key"], b["doc_count"]) for b in offenders[:3]]
    return checks.report(5, "One witness per step", False,
                         f"{len(offenders)} duplicated triple(s), e.g. {sample} - {detail}")


def check_7_pie_matches_bins(checks, es_url, window):
    """The three Result slices sum to the bins total, in roughly 26:3:1 per cycle."""
    try:
        by_result = _terms(es_url, "attributes.Result", window, VALIDATION_WORKFLOW, size=10)
        by_processor = _terms(es_url, "skp.processor_name", window, VALIDATION_WORKFLOW)
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


def check_6_every_processor_has_a_bin(checks, es_url, window):
    """All eight participating processors appear, including the terminal-step-only kafka-exporter.

    kafka-exporter is the one that proves the terminal-step clause of spec 4.1 is doing its job:
    it emits ZERO processor-side records, so without that clause its bin is simply absent and an
    operator reads a working export step as a dead one.
    """
    try:
        by_processor = _terms(es_url, "skp.processor_name", window, VALIDATION_WORKFLOW)
    except Exception as exc:  # noqa: BLE001
        return checks.report(6, "Every processor has a bin", False, f"{type(exc).__name__}: {exc}")
    missing = [p for p in PER_CYCLE_BY_PROCESSOR if by_processor.get(p, 0) == 0]
    return checks.report(6, "Every processor has a bin", not missing,
                         f"{len(by_processor)} series present, missing={missing or 'none'}")


def check_9_generic_across_workflows(checks, es_url, kibana_url, window):
    """The dashboard's objects exist under their fixed ids, and more than one workflow has
    counted, named records.

    The UI half of spec check 9 -- selecting a second workflow in the control and watching the
    panels repopulate -- is a click and lives in the operator notes. What is checkable here is the
    precondition that makes it work: the data is keyed on workflow NAME, and a second workflow is
    present in it. This check therefore FAILS while only one workflow is being driven, which is a
    statement about the traffic and not about the dashboard.
    """
    expected_objects = {"skp-logs", "skp-outcomes-bins", "skp-outcomes-pie",
                        "skp-outcome-records", "skp-operator-outcomes"}
    try:
        found = requests.get(
            f"{kibana_url}/api/saved_objects/_find"
            "?type=dashboard&type=lens&type=search&type=index-pattern&per_page=100",
            headers={"kbn-xsrf": "true"}, timeout=20).json()
        ids = {obj["id"] for obj in found.get("saved_objects", [])}
        by_workflow = _terms(es_url, "skp.workflow_name", window)
    except Exception as exc:  # noqa: BLE001
        return checks.report(9, "Genuinely generic", False, f"{type(exc).__name__}: {exc}")
    missing_objects = expected_objects - ids
    ok = not missing_objects and len(by_workflow) >= 2
    return checks.report(9, "Genuinely generic", ok,
                         f"workflows with counted records={list(by_workflow)}, "
                         f"missing saved objects={missing_objects or 'none'}")


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--kibana-url", default=DEFAULT_KIBANA)
    parser.add_argument("--es-url", default=DEFAULT_ES)
    parser.add_argument("--api-url", default=DEFAULT_API)
    parser.add_argument("--window", default="now-30m",
                        help="ES date-math lower bound. It must sit AFTER the pipeline "
                             "was installed: enrichment is forward-only, older records "
                             "are unenriched, and a wide window reports false failures.")
    args = parser.parse_args()

    checks = Checks()
    check_1_kibana_reaches_es(checks, args.kibana_url)
    check_2a_lookup_is_populated(checks, args.es_url, args.api_url)
    check_2b_enrichment_lands(checks, args.es_url)
    check_3_unmatched_ids_survive(checks, args.es_url)
    check_4_totals_match_the_cycle(checks, args.es_url, args.window)
    check_5_one_witness_per_step(checks, args.es_url, args.window)
    check_7_pie_matches_bins(checks, args.es_url, args.window)
    check_6_every_processor_has_a_bin(checks, args.es_url, args.window)
    check_9_generic_across_workflows(checks, args.es_url, args.kibana_url, args.window)

    print()
    print(f"{checks.failures} check(s) failed")
    return 1 if checks.failures else 0


if __name__ == "__main__":
    sys.exit(main())
