#!/usr/bin/env python3
"""
Copies the live filefetcher-archiveexpander-chain 1.0.0 into objectfetcher-archiveexpander-chain
1.0.0, the same ten steps with object-fetcher and object-persister at the two ends.

    original step            copy                     processor
    ---------------------------------------------------------------------------------
    split-importer           obj-importer             kafka-importer   (own topic + group)
    split-filefetcher        obj-filefetcher          file-fetcher   -> object-fetcher
    split-filepersister      obj-filepersister        file-persister -> object-persister
    split-exporter           obj-exporter             kafka-exporter   (own topic)
    export-outcome           obj-export-outcome       kafka-exporter   (own topic)
    every other step         obj-<name>               unchanged

THE COPY NEVER SHARES A TOPIC OR A CONSUMER GROUP WITH THE ORIGINAL. Both chains run at once, and a
shared group would split the records between the two importers, each stealing half of the other's
input. The importer reads skp-object-paths under skp-objectchain; the exporter after the persister
writes skp-object-documents; the exporter after record-outcome writes skp-object-failures. The two
exporters are told apart by what feeds them, not by their names.

Everything else is copied verbatim: descriptions, versions, entry conditions, every other payload,
the cache binding (chain-artists) and the cron. Steps are created first with no edges and then given
their mapped successors, because record-outcome is a fan-in that most of the graph points at
(docs/rebuild-filefetcher-archiveexpander-chain.md, steps 4 and 5).

The three topics are created on the dev broker with --if-not-exists, so a rerun is harmless there.
The workflow is not: the script refuses to run if the target name+version already exists.

Usage:
    python tools/copy-object-chain.py --dry-run
    python tools/copy-object-chain.py --start
"""

import argparse
import json
import subprocess
import sys
import urllib.error
import urllib.request

DEFAULT_BASEAPI = "http://localhost:18080"
SOURCE = ("filefetcher-archiveexpander-chain", "1.0.0")
TARGET = ("objectfetcher-archiveexpander-chain", "1.0.0")
DESCRIPTION = "copy of filefetcher-archiveexpander-chain 1.0.0 with object-fetcher / object-persister at the ends"

PROCESSOR_SWAP = {"file-fetcher": "object-fetcher", "file-persister": "object-persister"}
IMPORTER_TOPIC, IMPORTER_GROUP = "skp-object-paths", "skp-objectchain"
DOCUMENTS_TOPIC, FAILURES_TOPIC = "skp-object-documents", "skp-object-failures"
DESTINATION_URI = "s3://skp-out/"
KAFKA_CONTAINER = "skp-kafka"


def http_json(method, url, body=None):
    data = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(url, data=data, method=method,
                                     headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            text = response.read().decode("utf-8")
            return response.status, (json.loads(text) if text else None)
    except urllib.error.HTTPError as error:
        raise SystemExit(f"{method} {url} -> {error.code}: {error.read().decode('utf-8', 'replace')}")


def copy_name(name):
    return "obj-" + name[len("split-"):] if name.startswith("split-") else "obj-" + name


def read_source(api):
    _, workflows = http_json("GET", f"{api}/workflows")
    by_key = {(w["name"], w["version"]): w for w in workflows}
    if TARGET in by_key:
        raise SystemExit(f"{TARGET[0]} {TARGET[1]} already exists: {by_key[TARGET]['id']}")
    if SOURCE not in by_key:
        raise SystemExit(f"{SOURCE[0]} {SOURCE[1]} not found")
    workflow = by_key[SOURCE]

    steps, pending = {}, list(workflow["entryStepIds"])
    while pending:
        step_id = pending.pop()
        if step_id in steps:
            continue
        _, steps[step_id] = http_json("GET", f"{api}/steps/{step_id}")
        pending.extend(steps[step_id]["nextStepIds"] or [])

    assignments = [http_json("GET", f"{api}/assignments/{a}")[1] for a in workflow["assignmentIds"]]
    return workflow, steps, assignments


def plan_copy(api, steps, assignments):
    """The copied steps and assignments, keyed by source step id; ids still unresolved."""
    _, processors = http_json("GET", f"{api}/processors")
    name_of = {p["id"]: p["name"] for p in processors}
    id_of = {p["name"]: p["id"] for p in processors}

    feeds = {}  # step id -> names of the processors feeding it
    for step in steps.values():
        for next_id in step["nextStepIds"] or []:
            feeds.setdefault(next_id, set()).add(name_of[step["processorId"]])

    plan = {}
    for step_id, step in steps.items():
        source_processor = name_of[step["processorId"]]
        target_processor = PROCESSOR_SWAP.get(source_processor, source_processor)
        plan[step_id] = {
            "step": {
                "name": copy_name(step["name"]),
                "version": step["version"],
                "description": step["description"],
                "processorId": id_of.get(target_processor),
                "nextStepIds": None,
                "entryCondition": step["entryCondition"],
            },
            "source": step,
            "processor": target_processor,
            "feeds": feeds.get(step_id, set()),
        }

    for assignment in assignments:
        entry = plan[assignment["stepId"]]
        payload = json.loads(assignment["payload"])
        processor = name_of[entry["source"]["processorId"]]
        if processor == "kafka-importer":
            payload.update(topic=IMPORTER_TOPIC, consumerGroup=IMPORTER_GROUP)
        elif processor == "file-persister":
            payload = {"destinationUri": DESTINATION_URI}
        elif processor == "kafka-exporter":
            if "file-persister" in entry["feeds"]:
                payload["topic"] = DOCUMENTS_TOPIC
            elif "outcome-recorder" in entry["feeds"]:
                payload["topic"] = FAILURES_TOPIC
            else:
                raise SystemExit(f"exporter step {entry['source']['name']} is fed by neither the "
                                 f"persister nor record-outcome: {sorted(entry['feeds'])}")
        entry["assignment"] = {
            "name": copy_name(assignment["name"]),
            "version": assignment["version"],
            "description": assignment["description"],
            "payload": json.dumps(payload),
        }
    return plan


def print_plan(plan):
    for step_id, entry in plan.items():
        step = entry["step"]
        nexts = [plan[n]["step"]["name"] for n in entry["source"]["nextStepIds"] or []]
        resolved = step["processorId"] or "NOT REGISTERED"
        print(f"step {step['name']:<26} {entry['processor']:<18} ({resolved}) "
              f"entry={step['entryCondition']} next={nexts}")
        assignment = entry.get("assignment")
        print(f"     assignment {assignment['name'] if assignment else 'NONE'}: "
              f"{assignment['payload'] if assignment else ''}")
    print(f"{len(plan)} steps, {sum(1 for e in plan.values() if 'assignment' in e)} assignments")


def create_topics():
    for topic in (IMPORTER_TOPIC, DOCUMENTS_TOPIC, FAILURES_TOPIC):
        subprocess.run(["docker", "exec", KAFKA_CONTAINER, "/opt/kafka/bin/kafka-topics.sh",
                        "--bootstrap-server", "localhost:9092", "--create", "--if-not-exists",
                        "--topic", topic, "--partitions", "1", "--replication-factor", "1"],
                       check=True)


def create(api, workflow, plan):
    missing = sorted({e["processor"] for e in plan.values() if not e["step"]["processorId"]})
    if missing:
        raise SystemExit(f"processor rows not registered: {missing}")

    new_id = {}
    for step_id, entry in plan.items():
        _, created = http_json("POST", f"{api}/steps", entry["step"])
        new_id[step_id] = created["id"]
    for step_id, entry in plan.items():
        nexts = entry["source"]["nextStepIds"]
        if nexts:
            http_json("PUT", f"{api}/steps/{new_id[step_id]}",
                      {**entry["step"], "nextStepIds": [new_id[n] for n in nexts]})

    assignment_ids = []
    for step_id, entry in plan.items():
        if "assignment" in entry:
            _, created = http_json("POST", f"{api}/assignments",
                                   {**entry["assignment"], "stepId": new_id[step_id]})
            assignment_ids.append(created["id"])

    _, created = http_json("POST", f"{api}/workflows", {
        "name": TARGET[0],
        "version": TARGET[1],
        "description": DESCRIPTION,
        "entryStepIds": [new_id[s] for s in workflow["entryStepIds"]],
        "assignmentIds": assignment_ids,
        "cacheIds": workflow["cacheIds"],
        "cronExpression": workflow["cronExpression"],
    })
    return created["id"]


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--baseapi", default=DEFAULT_BASEAPI)
    parser.add_argument("--dry-run", action="store_true", help="print the copy and touch nothing")
    parser.add_argument("--start", action="store_true", help="start the new workflow at the end")
    args = parser.parse_args()
    api = f"{args.baseapi}/api/v1"

    workflow, steps, assignments = read_source(api)
    plan = plan_copy(api, steps, assignments)
    print_plan(plan)
    if args.dry_run:
        return

    create_topics()
    workflow_id = create(api, workflow, plan)
    print(f"created {TARGET[0]} {TARGET[1]}: {workflow_id}")
    if args.start:
        status, _ = http_json("POST", f"{api}/orchestration/start", workflow_id)
        print(f"start -> {status}")


if __name__ == "__main__":
    sys.exit(main())
