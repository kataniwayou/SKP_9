#!/usr/bin/env python3
"""
Feeds the GUID -> name lookup that the logs@custom enrich processors read, then re-executes the
policy so the change is actually visible to ingest.

WHY THE BASEAPI AND NOT POSTGRES. One query against the database would replace three HTTP reads,
but it binds this tool to someone else's schema and needs credentials nothing else in tools/
carries -- the existing scripts talk to Kafka and to the API over the network, never to a
datastore directly. The volume makes the cost irrelevant: six workflows, forty-two steps, ten
processors. The API route is a live read of Postgres with no cache in front of it
(BaseService.ListAsync -> Repository.ListAsync -> _set.ToListAsync), so it IS the source of truth.

RE-EXECUTING THE POLICY IS NOT OPTIONAL AND IS WHY THIS IS A SCRIPT. The enrich processor reads a
point-in-time SNAPSHOT of the lookup index, materialised into a hidden .enrich-* index when the
policy is executed. Adding a row changes NOTHING until the policy runs again. Leaving that step to
the operator is the single most likely way for a freshly published workflow to show GUIDs, so this
tool always does it last and offers no flag to skip it.

THE OLD .enrich-* INDEX IS CLEANED UP BY ELASTICSEARCH ITSELF after a successful execute. Do not
delete it by hand: a delete racing a live ingest fails documents that were mid-pipeline.

ENRICHMENT IS FORWARD-ONLY. Running this does not fix documents already in the log index; they
keep their GUIDs forever. There is no reindex.

RUN THIS FROM POWERSHELL, against live port-forwards:
    ./k8s/port-forward-realstack.ps1
    python tools/sync-entity-names.py
"""
import argparse
import json
import sys

import requests

DEFAULT_API = "http://localhost:18080"
DEFAULT_ES = "http://localhost:19200"
INDEX = "skp-entity-names"
POLICY = "skp-entity-lookup"

# route suffix -> the entity_kind stamped on its rows
ROUTES = (("workflows", "workflow"), ("steps", "step"), ("processors", "processor"))


def load_body(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def fetch_entities(api_url, timeout):
    """Three list reads, flattened into lookup rows. No client-side join is needed: every route
    already returns `id` and `name` on each element."""
    rows = []
    for route, kind in ROUTES:
        response = requests.get(f"{api_url}/api/v1/{route}", timeout=timeout)
        response.raise_for_status()
        for entity in response.json():
            rows.append({
                "entity_id": entity["id"],
                "entity_name": entity["name"],
                "entity_kind": kind,
            })
    return rows


def ensure_index(es_url, mapping, timeout):
    """Create the index if absent. An existing index is left alone -- the mapping is three keyword
    fields and has no reason to change, and recreating it would drop rows a concurrent reader is
    using."""
    if requests.head(f"{es_url}/{INDEX}", timeout=timeout).status_code == 200:
        return "exists"
    response = requests.put(f"{es_url}/{INDEX}", json=mapping, timeout=timeout)
    response.raise_for_status()
    return "created"


def bulk_index(es_url, rows, timeout):
    """Upsert by _id = entity_id, so a renamed entity replaces its row rather than duplicating it.

    A row for a DELETED entity is not removed here. It is harmless -- nothing will ever look that
    GUID up again -- and a delete pass would have to distinguish "the API no longer lists it" from
    "the API read failed", which is a far worse failure mode than a stale row.
    """
    lines = []
    for row in rows:
        lines.append(json.dumps({"index": {"_index": INDEX, "_id": row["entity_id"]}}))
        lines.append(json.dumps(row))
    payload = ("\n".join(lines) + "\n").encode("utf-8")
    response = requests.post(f"{es_url}/_bulk?refresh=true", data=payload,
                             headers={"Content-Type": "application/x-ndjson"}, timeout=timeout)
    response.raise_for_status()
    body = response.json()
    if body.get("errors"):
        failed = [item for item in body["items"] if item["index"].get("error")]
        raise RuntimeError(f"bulk reported {len(failed)} failed row(s): {failed[:3]}")
    return len(rows)


def ensure_policy(es_url, policy_body, timeout):
    """PUT is idempotent for an unchanged body, but Elasticsearch REJECTS a changed policy in
    place, so an edit to enrich-policy.json needs the policy deleted first. Say so rather than
    failing opaquely."""
    response = requests.put(f"{es_url}/_enrich/policy/{POLICY}", json=policy_body, timeout=timeout)
    if response.status_code == 400 and "already exists" in response.text:
        return "exists (delete it first if enrich-policy.json changed)"
    response.raise_for_status()
    return "created"


def execute_policy(es_url, timeout):
    response = requests.post(
        f"{es_url}/_enrich/policy/{POLICY}/_execute?wait_for_completion=true", timeout=timeout)
    response.raise_for_status()
    return response.json().get("status", {}).get("phase")


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--api-url", default=DEFAULT_API)
    parser.add_argument("--es-url", default=DEFAULT_ES)
    parser.add_argument("--index-body", default="elastic/entity-names-index.json")
    parser.add_argument("--policy-body", default="elastic/enrich-policy.json")
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--dry-run", action="store_true",
                        help="read the API and print the rows; touch nothing in Elasticsearch")
    args = parser.parse_args()

    rows = fetch_entities(args.api_url, args.timeout)
    print(f"read {len(rows)} entities from {args.api_url}")
    if args.dry_run:
        for row in rows:
            print(f"  {row['entity_kind']:<9} {row['entity_id']}  {row['entity_name']}")
        return 0

    print(f"index {INDEX}: {ensure_index(args.es_url, load_body(args.index_body), args.timeout)}")
    print(f"indexed {bulk_index(args.es_url, rows, args.timeout)} row(s)")
    print(f"policy {POLICY}: "
          f"{ensure_policy(args.es_url, load_body(args.policy_body), args.timeout)}")
    phase = execute_policy(args.es_url, args.timeout)
    print(f"policy executed: phase={phase}")
    if phase != "COMPLETE":
        print("ERROR: policy execution did not complete; enrichment will keep using the previous "
              "snapshot", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
