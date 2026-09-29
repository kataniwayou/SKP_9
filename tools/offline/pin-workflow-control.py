"""Point the operator board's Workflow control at this environment's full workflow name.

The board opens on one workflow, because pie shares across two workflows describe neither. Names now
carry a GUID suffix that differs per environment, so the pinned value is rewritten per stack from L2
before the export is imported. Run it on dev (then commit) and on the offline machine (before import).
"""
import argparse
import json
import sys

import skp_names

DASHBOARD = "skp-operator-outcomes"


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--workflow", required=True, help="the workflow's name_version, e.g. filefetcher-archiveexpander-chain_1.0.0")
    ap.add_argument("--redis-host", default="localhost")
    ap.add_argument("--redis-port", type=int, default=6380)
    ap.add_argument("--export", default="kibana/kibana-export.ndjson")
    args = ap.parse_args()

    matches = [n for n in skp_names.read_names(args.redis_host, args.redis_port).values()
               if skp_names.base_name(n) == args.workflow]
    if len(matches) != 1:
        print(f"expected exactly one name in L2 for {args.workflow}, found {matches or 'none'} - "
              f"start the workflow once on this stack")
        return 1
    full = matches[0]

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
