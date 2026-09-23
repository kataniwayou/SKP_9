#!/usr/bin/env python3
"""
Publishes a workflow's diagram to the BaseApi, which serves it to the dashboard.

WHAT THIS REPLACES. build-diagram-panels.py rendered each drawing to PNG at 2x, base64'd the
results into a ConfigMap and stood an nginx in front of it. The filenames were workflow ids
resolved at BUILD time, so a graph rebuilt on another cluster orphaned every image. The BaseApi
resolves the id at REQUEST time, so a drawing follows its workflow and there is nothing to
regenerate - which retires the PNG render, the ConfigMap, the manifest and the nginx with it.

WHAT SURVIVED is extract_svg(), lifted verbatim. The drawing's styling lives in the page's <style>
block rather than on its elements, so lifting the <svg> out of the HTML gives an unstyled skeleton;
this inlines only the rules the drawing actually references. That step is unchanged by where the
result is stored.

SVG IS NOW WHAT IS STORED, not an intermediate. The two drawings are 5.6 KB and 15.8 KB against
83 KB and 195 KB rendered, stay sharp at whatever width the panel gives them, and there is no
headless Chrome anywhere in this path.

ENRICHING A WORKFLOW IS THE OPERATOR'S CHOICE. Nothing calls this automatically. A workflow that
never gets a diagram serves the placeholder indefinitely, which is an ordinary state and says so on
its face.

    python kibana/publish-diagram.py simple-abc_1.0.0
    python kibana/publish-diagram.py --all
"""
import argparse
import os
import re
import sys

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Keyed by the live EntityName - {name}_{version}, what Elasticsearch holds and what the dashboard's
# field formatters render. The page is the hand-authored source of truth, captured from the live API
# by the task in docs/diagrams/workflow-diagram-prompt.md.
DIAGRAMS = {
    "filefetcher-archiveexpander-chain_1.0.0": "docs/diagrams/filefetcher-archiveexpander-chain.html",
    "simple-abc_1.0.0":                        "docs/diagrams/simple-abc.html",
}

DATA_STREAM = "logs-generic.otel-default"


def workflow_ids(es_url):
    """EntityName -> id, read from the naming records the BaseApi writes at start time.

    No time window: those records are written once per explicit start, so a recent window would
    resolve nothing for a workflow that has not been started lately.
    """
    body = {"size": 0,
            "query": {"bool": {"filter": [{"exists": {"field": "attributes.EntityName"}},
                                          {"term": {"attributes.EntityKind": "workflow"}}]}},
            "aggs": {"w": {"terms": {"field": "attributes.WorkflowId", "size": 200},
                           "aggs": {"latest": {"top_hits": {
                               "size": 1, "sort": [{"@timestamp": {"order": "desc"}}],
                               "_source": ["attributes.EntityName"]}}}}}}
    r = requests.post(f"{es_url}/{DATA_STREAM}/_search", json=body, timeout=60)
    r.raise_for_status()
    return {b["latest"]["hits"]["hits"][0]["_source"]["attributes"]["EntityName"]: b["key"]
            for b in r.json()["aggregations"]["w"]["buckets"]}


def extract_svg(html_text):
    """The page's single <svg>, made to stand on its own.

    The drawing's styling lives in the document's <style> block, not on the elements, so lifting the
    <svg> out gives an unstyled skeleton. Only the rules the drawing references are inlined: the
    page's stylesheet is mostly chrome, and dragging it along would couple the image to the page's
    layout.
    """
    lines = html_text.split("\n")
    style_start = next(i for i, l in enumerate(lines) if "<style>" in l)
    style_end   = next(i for i, l in enumerate(lines) if i > style_start and "</style>" in l)
    svg_start   = next(i for i, l in enumerate(lines) if "<svg" in l)
    svg_end     = next(i for i, l in enumerate(lines) if i > svg_start and "</svg>" in l)

    css = "\n".join(lines[style_start:style_end + 1]).split("<style>", 1)[1].rsplit("</style>", 1)[0]
    svg = "\n".join(lines[svg_start:svg_end + 1])

    used = {c for grp in re.findall(r'class="([^"]+)"', svg) for c in grp.split()}
    root = re.search(r":root\s*\{(.*?)\}", css, re.S).group(1)

    kept = []
    for m in re.finditer(r"([^{}]+)\{([^{}]*)\}", css):
        selector, body = m.group(1).strip(), m.group(2)
        if selector.startswith("@") or selector == ":root":
            continue
        if any(("." + c) in selector for c in used):
            kept.append("%s {%s}" % (selector, body))

    style = "  <style>\n    :root {%s}\n    %s\n  </style>\n" % (root, "\n    ".join(kept))
    body = svg.replace("</svg>", "").rstrip()
    head_end = body.index(">") + 1
    head = body[:head_end].replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" ', 1)

    viewbox = re.search(r'viewBox="0 0 ([\d.]+) ([\d.]+)"', head)
    size = (int(float(viewbox.group(1))), int(float(viewbox.group(2)))) if viewbox else (1600, 540)

    # AN INTRINSIC SIZE IS NOT OPTIONAL HERE, and its absence is invisible until it reaches a
    # browser. The page's <svg> is sized by the page's own CSS and carries only a viewBox, which
    # is enough while it lives in that page. Served on its own and referenced by an <img> with no
    # width - exactly what the dashboard's markdown emits - a viewBox-only SVG has no intrinsic
    # width, so the browser falls back to the 300px default for a replaced element and the
    # drawing renders as a thumbnail. The retired PNGs never showed this: a bitmap's intrinsic
    # size is its pixel size, so they arrived at 3200px and were scaled DOWN to fit.
    head = head.replace("<svg ", '<svg width="%d" height="%d" ' % size, 1)

    return ('<?xml version="1.0" encoding="UTF-8"?>\n'
            + head + "\n" + style + body[head_end:] + "\n</svg>\n"), len(kept), size


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("workflow", nargs="?", help="EntityName, e.g. simple-abc_1.0.0")
    ap.add_argument("--all", action="store_true", help="publish every drawing in the registry")
    ap.add_argument("--es", default="http://localhost:19200")
    ap.add_argument("--api", default="http://localhost:18080")
    ap.add_argument("--dry-run", action="store_true", help="extract and check, publish nothing")
    args = ap.parse_args()

    if not args.all and not args.workflow:
        sys.exit("name a workflow, or pass --all")
    targets = sorted(DIAGRAMS) if args.all else [args.workflow]
    unknown = [t for t in targets if t not in DIAGRAMS]
    if unknown:
        sys.exit(f"no page registered for {unknown} - known: {sorted(DIAGRAMS)}")

    ids = {} if args.dry_run else workflow_ids(args.es)

    published = 0
    for name in targets:
        html = open(os.path.join(ROOT, DIAGRAMS[name]), encoding="utf-8").read()
        svg, rules, size = extract_svg(html)

        if args.dry_run:
            print(f"{name:44s} {size[0]}x{size[1]}  {rules:2d} rules  {len(svg)/1024:5.1f} KB  "
                  f"(dry run, not published)")
            continue

        workflow_id = ids.get(name)
        if not workflow_id:
            # Same cause as the old build script's skip: the naming records are written on an
            # explicit start and never by the cron, so a workflow that has only ever run on a
            # schedule has no id to resolve.
            print(f"{name:44s} no naming record, so no id - start it once and re-run")
            continue

        r = requests.put(f"{args.api}/api/v1/workflows/{workflow_id}/diagram",
                         data=svg.encode("utf-8"),
                         headers={"Content-Type": "image/svg+xml"}, timeout=60)
        if r.status_code == 404:
            print(f"{name:44s} {workflow_id} is not a workflow the API knows - stale id?")
            continue
        r.raise_for_status()
        published += 1
        print(f"{name:44s} {size[0]}x{size[1]}  {rules:2d} rules  {len(svg)/1024:5.1f} KB  ->  "
              f"{workflow_id}  {r.status_code}")

    if published:
        print(f"\npublished {published}; the dashboard serves them at "
              f"{args.api}/api/v1/workflows/<workflowId>.svg")
    return 0


if __name__ == "__main__":
    sys.exit(main())
