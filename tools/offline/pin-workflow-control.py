"""Point the operator board's Workflow control at this environment's full workflow name.

The board opens on one workflow, because pie shares across two workflows describe neither. Names now
carry a GUID suffix that differs per environment, so the pinned value is rewritten per stack from L2
before the export is imported. Run it on dev (then commit) and on the offline machine (before import).

THE WORKFLOW ID COMES FROM BASEAPI'S REGISTRY, NOT FROM SCANNING L2. D8 never deletes skp:name:*
keys, and a rebuild re-creates a workflow row with a fresh GUID - so after any rebuild L2 can hold
several filefetcher-archiveexpander-chain_1.0.0-<suffix> names, only one of which is live. Matching
against GET {api_url}/api/v1/workflows finds the row BaseApi will actually run when the workflow next
starts; --workflow-id skips this lookup when the id is already known.
"""
import argparse
import json
import sys
import urllib.request

import skp_names

DASHBOARD = "skp-operator-outcomes"


def _live_workflow_id(api_url, name_version):
    with urllib.request.urlopen(f"{api_url}/api/v1/workflows", timeout=30) as r:
        workflows = json.load(r)
    return [wf["id"] for wf in workflows if f'{wf["name"]}_{wf["version"]}' == name_version]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--workflow", required=True, help="the workflow's name_version, e.g. filefetcher-archiveexpander-chain_1.0.0")
    ap.add_argument("--api-url", default="http://localhost:18080")
    ap.add_argument("--workflow-id", default=None,
                    help="skip the BaseApi registry lookup and use this id directly")
    ap.add_argument("--redis-host", default="localhost")
    ap.add_argument("--redis-port", type=int, default=6380)
    ap.add_argument("--export", default="kibana/kibana-export.ndjson")
    args = ap.parse_args()

    if args.workflow_id:
        workflow_id = args.workflow_id
    else:
        try:
            matches = _live_workflow_id(args.api_url, args.workflow)
        except Exception as exc:  # noqa: BLE001
            print(f"could not read {args.api_url}/api/v1/workflows: {type(exc).__name__}: {exc}")
            return 1
        if len(matches) != 1:
            print(f"expected exactly one live workflow named {args.workflow} at {args.api_url}, "
                  f"found {matches or 'none'} - pass --workflow-id to skip this lookup")
            return 1
        workflow_id = matches[0]

    full = skp_names.read_name(args.redis_host, args.redis_port, workflow_id)
    if full is None:
        print(f"no name in L2 for workflow {workflow_id} - start it once on this stack")
        return 1

    lines = open(args.export, encoding="utf-8").read().split("\n")
    pinned = 0
    for i, line in enumerate(lines):
        if not line.strip():
            continue
        o = json.loads(line)
        if o.get("id") != DASHBOARD:
            continue
        group = o["attributes"]["controlGroupInput"]
        panels = json.loads(group["panelsJSON"])
        for panel in panels.values():
            explicit = panel.get("explicitInput", {})
            if explicit.get("fieldName") == "attributes.WorkflowName":
                explicit["selectedOptions"] = [full]
                pinned += 1
        group["panelsJSON"] = json.dumps(panels, ensure_ascii=False)
        lines[i] = json.dumps(o, ensure_ascii=False)

    if pinned != 1:
        print(f"expected one Workflow control on {DASHBOARD}, found {pinned}")
        return 1
    open(args.export, "w", encoding="utf-8", newline="\n").write("\n".join(lines))
    print(f"{DASHBOARD}: Workflow control pinned to {full}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
