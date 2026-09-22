#!/usr/bin/env python3
"""
Writes the id -> name lookup into the data view's field formatters, in kibana/kibana-export.ndjson.

WHAT REPLACED WHAT. The dashboard used to read enriched name fields (skp.step_name and friends)
that an Elasticsearch ingest pipeline wrote at index time, fed by an enrich policy over a lookup
index, kept fresh by a script that called the BaseApi. That is four server-side objects and two
cluster privileges. On an Elasticsearch this project does not own, it is also a claim on
logs@custom, which is a single cluster-wide slot shared with every other team.

Now the panels aggregate on the RAW ID and Kibana maps id -> label when it draws. Nothing is
written to Elasticsearch at all; the whole mechanism is one attribute on one saved object.

    Section 6.1 of the spec dismissed this option, saying a formatter "does not create a field the
    Controls panel or an aggregation can use". That is true and it is beside the point, because
    nothing here aggregates on the name - the aggregation runs on the id and only the rendering of
    each bucket changes. Verified on the live Kibana 8.15.5: both the options-list control and the
    Lens legend honour the formatter.

AND IT COVERS ALL HISTORY, which the thing it replaces could not. Enrichment applied to newly
indexed documents only, so any range predating the install showed raw GUIDs for ever. Formatting
happens at read time, so it applies to every record ever written.

TWO HONEST COSTS, both accepted deliberately:

  * FREE-TEXT SEARCH REGRESSES. Names exist only at render time, so an operator filtering in KQL or
    hunting in Discover has to type the GUID. The label is for reading, not for querying.
  * A VERSION BUMP RELABELS HISTORY. This is a flat map applied to all of time, and Version is
    mutable on the same row. {name}_{version} therefore means "what this entity is called now", not
    what it was called when the record was written. The alternative is an as-of join, which is the
    design being removed.

WHERE THE PAIRS COME FROM, and why not from the BaseApi. OrchestrationService logs one record per
entity when a workflow is started, carrying the id under the SAME field name the execution records
use, plus EntityName. This reads them back out of the log store. Sourcing them from the API instead
would put a live dependency on the API at the moment someone needs a dashboard, on a machine where
it may not be reachable from wherever this is run.

    THE WINDOW IS ALL OF TIME, AND THAT IS NOT LAZINESS. Those records are written on an explicit
    start and not again - the cron fires from the orchestrator, against an ids-only projection, and
    never comes through the BaseApi. A workflow started last week emitted its pairs once, last week.
    Searching a recent window would find nothing and silently produce an empty map.

    A workflow whose start has aged out of the index has no pairs at all and its ids stay raw until
    it is next started. That is the one operational cost of sourcing this from logs, and it is why
    --since exists but defaults to nothing.

Run after publishing or renaming anything, then re-import the export.

    python kibana/generate-field-formatters.py
"""
import argparse
import json
import os
import sys

import requests

ROOT   = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXPORT = os.path.join(ROOT, "kibana", "kibana-export.ndjson")

DEFAULT_ES  = "http://localhost:19200"
DATA_STREAM = "logs-generic.otel-default"
DATA_VIEW   = "skp-logs"

# The entity kinds, the field the BaseApi writes the id under, and the field the dashboard
# aggregates on. They are the same field, which is the whole trick: a published step has a record
# naming it from the moment its workflow is started, so it can appear in a dropdown before it has
# ever run.
KINDS = {
    "workflow":  "WorkflowId",
    "step":      "StepId",
    "processor": "ProcessorId",
}

# The whitelist board's split field. It is a RUNTIME field on the data view, not an attribute on the
# record: `{StepId} · {WhitelistRoot}`, one value per (step, list) pair. A formatter applies to
# a runtime field exactly as it does to an indexed one -- verified on 8.15.5 -- so the same id->name
# mechanism that labels the dropdowns labels each pie.
#
# THE STEP IS THE OWNER, NOT THE PROCESSOR. cacheAddress lives on the step payload, so it differs
# between two steps of the same workflow; a step resolves to exactly one processor, which makes the
# processor derivable and therefore redundant in the key. Keying on the processor merged two steps
# that gate on the same list, and named a processor of which only some steps gate anything.
WHITELIST_PAIR_FIELD = "whitelist_owner"


def read_pairs(es_url, since):
    """Latest name per id, over every record the BaseApi has written.

    LATEST, not first: a version bump writes a new pair for the same id, and the newest is what the
    entity is called now. Sorting by @timestamp and letting later rows overwrite earlier ones is
    enough - there is no need for a top_hits aggregation at this volume.
    """
    filters = [{"exists": {"field": "attributes.EntityName"}}]
    if since:
        filters.append({"range": {"@timestamp": {"gte": since}}})

    body = {
        "size": 0,
        "query": {"bool": {"filter": filters}},
        "aggs": {},
    }
    for kind, field in KINDS.items():
        body["aggs"][kind] = {
            "terms": {"field": f"attributes.{field}", "size": 1000},
            "aggs": {"latest": {"top_hits": {
                "size": 1,
                "sort": [{"@timestamp": {"order": "desc"}}],
                "_source": ["attributes.EntityName", "attributes.EntityKind"]}}},
        }

    response = requests.post(f"{es_url}/{DATA_STREAM}/_search", json=body, timeout=60)
    response.raise_for_status()
    aggs = response.json()["aggregations"]

    maps = {}
    for kind in KINDS:
        pairs = {}
        for bucket in aggs[kind]["buckets"]:
            source = bucket["latest"]["hits"]["hits"][0]["_source"]["attributes"]
            # An id field is present on records of other kinds too (an execution record carries all
            # three). Only trust a bucket whose own record declares this kind.
            if source.get("EntityKind") == kind:
                pairs[bucket["key"]] = source["EntityName"]
        maps[kind] = pairs
    return maps


def read_whitelist_pairs(es_url):
    """Every (step, list) pair that has actually produced a verdict.

    Sourced from the verdict records rather than from any registry, for the same reason the id->name
    pairs are: no live API dependency at the moment someone needs a dashboard. A pair that has never
    logged a lookup has no entry and renders as `{GUID} · {root}` until this is re-run -- the
    same honest failure a workflow whose start has aged out already has.
    """
    body = {
        "size": 0,
        "query": {"bool": {"filter": [{"exists": {"field": "attributes.WhitelistVerdict"}}]}},
        "aggs": {"steps": {
            "terms": {"field": "attributes.StepId", "size": 1000},
            "aggs": {"roots": {"terms": {"field": "attributes.WhitelistRoot", "size": 1000}}}}},
    }
    response = requests.post(f"{es_url}/{DATA_STREAM}/_search", json=body, timeout=60)
    response.raise_for_status()

    pairs = []
    for step in response.json()["aggregations"]["steps"]["buckets"]:
        for root in step["roots"]["buckets"]:
            pairs.append((step["key"], root["key"]))
    return pairs


def field_format_map(maps, whitelist_pairs=()):
    """The data view's fieldFormatMap: one static_lookup per id field.

    unknownKeyValue IS OMITTED, AND THAT IS A TESTED CHOICE, not an oversight. With no value set,
    Kibana renders an unmapped key as the key itself - the raw GUID. Setting it to a string would
    render EVERY unmapped entity as that one string, so a newly published step would not merely be
    unlabelled, it would be indistinguishable from every other unlabelled step, and two of them
    would collapse into a single bucket label in a legend. A raw GUID is ugly and correct; a shared
    placeholder is tidy and wrong.
    """
    formats = {}
    for kind, field in KINDS.items():
        if not maps[kind]:
            continue
        formats[f"attributes.{field}"] = {
            "id": "static_lookup",
            "params": {"lookupEntries": [{"key": k, "value": v}
                                         for k, v in sorted(maps[kind].items(), key=lambda kv: kv[1])]},
        }

    # The composite. Its key is the raw runtime value the aggregation buckets on; its label swaps
    # the step's GUID for the name the dropdowns use and leaves the root alone, since the root IS
    # its own name.
    entries = []
    for step_id, root in whitelist_pairs:
        raw = f"{step_id} · {root}"
        entries.append({"key": raw, "value": f"{maps['step'].get(step_id, step_id)} · {root}"})
    if entries:
        formats[WHITELIST_PAIR_FIELD] = {
            "id": "static_lookup",
            "params": {"lookupEntries": sorted(entries, key=lambda e: e["value"])},
        }
    return formats


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--es", default=DEFAULT_ES)
    ap.add_argument("--since", default=None,
                    help="only read pairs newer than this (default: all of time - see the module docstring)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    maps = read_pairs(args.es, args.since)
    for kind in KINDS:
        print(f"{kind:10s} {len(maps[kind]):3d} mapped")

    whitelist_pairs = read_whitelist_pairs(args.es)
    print(f"{'whitelist':10s} {len(whitelist_pairs):3d} (step, list) pair(s)")
    if not any(maps.values()):
        sys.exit("no id->name pairs found - has any workflow been started since the BaseApi was rolled?")

    formats = field_format_map(maps, whitelist_pairs)
    if args.dry_run:
        print(json.dumps(formats, indent=1)[:1500])
        return

    lines, wrote = [], False
    for raw in open(EXPORT, encoding="utf-8"):
        raw = raw.strip()
        if not raw:
            continue
        obj = json.loads(raw)
        if obj.get("type") == "index-pattern" and obj.get("id") == DATA_VIEW:
            obj["attributes"]["fieldFormatMap"] = json.dumps(formats)
            wrote = True
        lines.append(json.dumps(obj))

    if not wrote:
        sys.exit(f"data view {DATA_VIEW} not found in {EXPORT}")

    with open(EXPORT, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(lines) + "\n")
    print(f"\nwrote fieldFormatMap for {len(formats)} fields into {os.path.relpath(EXPORT, ROOT)}")


if __name__ == "__main__":
    main()
