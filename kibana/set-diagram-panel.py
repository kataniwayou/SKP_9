#!/usr/bin/env python3
"""
Points the dashboard's diagram panel at the BaseApi, which now serves the drawings.

WHAT THIS REPLACES. build-diagram-panels.py rendered every diagram to PNG, base64'd them into
k8s/25-diagrams.yaml and stood an nginx in front of the ConfigMap. That worked, but the filenames
were workflow ids resolved at BUILD time, so rebuilding the graph on another cluster orphaned every
image and forced a re-run. Serving from the BaseApi resolves the id at REQUEST time, so a diagram
follows its workflow through any rebuild and there is nothing to regenerate.

The panel mechanism is unchanged and is still the whole trick: TSVB runs a query, so it honours the
Workflow control, the dashboard filter and the time range; splitting that query by
attributes.WorkflowId makes each series label the id itself, and the template turns the id into a
URL. Only the URL moved.

    {{#each _all}}![](<base>/{{label}}.svg){{/each}}

WHY THE ID IS LAST IN THE PATH. The template can only concatenate a base with the label, so the
route has to end with the id - hence `{id}.svg` on the controller rather than `{id}/diagram`.

SVG, NOT PNG. The stored drawing is its own source: 5.6 KB and 15.8 KB against 83 KB and 195 KB
rendered, sharp at whatever width the panel gives it, and no headless Chrome anywhere.

EMPTY ALT TEXT IS STILL LOAD-BEARING, for a smaller set of cases than before. A workflow with no
published diagram now answers 200 with a placeholder, so absence of a DRAWING is visible. Empty alt
still covers absence of the SERVER: if the forward is down, the panel collapses to nothing rather
than showing broken-image icons.

    python kibana/set-diagram-panel.py --base-url http://localhost:18080/api/v1/workflows
"""
import argparse
import json
import os
import sys

ROOT   = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXPORT = os.path.join(ROOT, "kibana", "kibana-export.ndjson")

DATA_STREAM  = "logs-generic.otel-default"
DASHBOARD_ID = "skp-operator-outcomes"
PANEL_INDEX  = "p3"

# Unchanged from the PNG panel: the grid is 48 columns, a row is ~31px, and the panel is sized for
# the TALLEST drawing because one panel serves every workflow and cannot resize per selection.
PANEL_W, PANEL_H = 48, 23


def tsvb_panel(base_url):
    markdown = "{{#each _all}}![](%s/{{label}}.svg)\n{{/each}}" % base_url.rstrip("/")
    params = {
        "id": "diagram", "type": "markdown",
        "index_pattern": DATA_STREAM, "time_field": "@timestamp",
        "interval": "", "axis_position": "left",
        # Scrollbars on: with no workflow selected the drawings stack, and a fixed-height panel
        # would silently hide every one after the first.
        "markdown": markdown, "markdown_scrollbars": 1, "markdown_openLinksInNewTab": 1,
        "series": [{"id": "s1", "label": "", "split_mode": "terms",
                    "terms_field": "attributes.WorkflowId", "terms_size": "20",
                    "metrics": [{"id": "m1", "type": "count"}]}],
        "use_kibana_indexes": False,
    }
    return {
        "version": "8.15.5", "type": "visualization",
        "gridData": {"x": 0, "y": 0, "w": PANEL_W, "h": PANEL_H, "i": PANEL_INDEX},
        "panelIndex": PANEL_INDEX,
        "title": "Workflow diagram - what feeds what",
        "embeddableConfig": {"savedVis": {
            "title": "", "description": "", "type": "metrics", "params": params, "uiState": {},
            "data": {"aggs": [], "searchSource": {"query": {"query": "", "language": "kuery"},
                                                  "filter": []}}}},
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default="http://localhost:18080/api/v1/workflows",
                    help="the workflows collection, as the OPERATOR'S BROWSER sees it - the browser "
                         "fetches the drawing, not Kibana")
    args = ap.parse_args()

    panel, lines, wrote = tsvb_panel(args.base_url), [], False
    for raw in open(EXPORT, encoding="utf-8"):
        raw = raw.strip()
        if not raw:
            continue
        obj = json.loads(raw)
        if obj.get("type") == "dashboard" and obj.get("id") == DASHBOARD_ID:
            panels = [p for p in json.loads(obj["attributes"]["panelsJSON"])
                      if p.get("panelIndex") != PANEL_INDEX]
            if panels:
                top = min(p["gridData"]["y"] for p in panels)
                for other in panels:
                    other["gridData"]["y"] += PANEL_H - top
            panels.insert(0, panel)
            obj["attributes"]["panelsJSON"] = json.dumps(panels)
            wrote = True
        lines.append(json.dumps(obj))
    if not wrote:
        sys.exit(f"dashboard {DASHBOARD_ID} not found in {EXPORT}")
    with open(EXPORT, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(lines) + "\n")

    print(f"panel  {args.base_url}/<workflowId>.svg")
    print(f"export {os.path.relpath(EXPORT, ROOT)} - re-import it into Kibana")


if __name__ == "__main__":
    sys.exit(main())
