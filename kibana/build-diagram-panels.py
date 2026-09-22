#!/usr/bin/env python3
"""
Builds one diagram image per workflow, named by workflow id, and points the dashboard's diagram
panel at the folder that serves them.

WHY THE FILENAME IS THE WORKFLOW ID. The panel does not know which diagram to show until an operator
picks a workflow, and Kibana has no way to express "look up an image for this value" except by
building a URL out of it. So the image IS addressed by the id:

    kibana/diagrams/<workflowId>.png        served over http
    markdown:  {{#each _all}}![](<base>/{{label}}.png){{/each}}

The panel is TSVB markdown rather than the plain Markdown panel, and that is the whole trick. A
Markdown panel runs no query, so it cannot react to anything - the previous diagram panel was a
fixed image that stayed the same whatever you selected. TSVB runs a query, so it honours the
Workflow control, the dashboard filter and the time range. Splitting that query by
attributes.WorkflowId makes each series label the id itself, which is what the template turns into
a filename.

    WHAT HAPPENS WHEN THERE IS NO IMAGE, which is the behaviour this was built for. Two independent
    ways nothing renders, and both were tested:
      * the workflow has no records in the window -> the query returns no series -> {{#each}}
        iterates zero times -> no markdown at all.
      * the workflow has records but no file -> the request 404s -> the img has EMPTY ALT TEXT, and
        a broken image with no alt collapses to nothing. With alt text it would show a placeholder
        icon and the alt string, which is why the alt is deliberately empty.

THE SOURCE OF TRUTH IS THE HTML, and nothing downstream is hand-maintained:

    docs/diagrams/<name>.html   hand-authored, captured from the live API
      |  extract_svg()          strips the page, inlines only the rules the drawing uses
      v
    kibana/diagrams/<name>.svg  committed, self-contained
      |  render_png()           headless Chrome at 2x
      v
    kibana/diagrams/<id>.png    committed, and what the browser fetches

THE ID IS RESOLVED AT BUILD TIME, FROM ELASTICSEARCH, and that matters on any cluster but this one.
The registry below is keyed by workflow NAME, because a name is reproduced byte-for-byte when the
graph is rebuilt while every id is freshly minted. Rebuild the graph elsewhere and the diagrams must
be renamed - which is what re-running this does.

    python kibana/build-diagram-panels.py --es http://localhost:19200 --base-url http://localhost:18097
"""
import argparse
import base64
import glob
import json
import os
import re
import subprocess
import sys
import tempfile

ROOT    = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXPORT  = os.path.join(ROOT, "kibana", "kibana-export.ndjson")
OUT_DIR = os.path.join(ROOT, "kibana", "diagrams")

DATA_STREAM  = "logs-generic.otel-default"
DASHBOARD_ID = "skp-operator-outcomes"
PANEL_INDEX  = "p3"

# Keyed by workflow NAME. A workflow with no entry here simply has no diagram, and the panel renders
# nothing for it - which is the point of the design rather than a gap in it.
DIAGRAMS = {
    "filefetcher-archiveexpander-chain": "docs/diagrams/filefetcher-archiveexpander-chain.html",
    "simple-abc":                        "docs/diagrams/simple-abc.html",
}

# Kibana's grid is 48 columns and a row is ~31px. Both drawings are about 3:1, so at full width each
# needs ~560px, and TSVB adds a header and a "Last value" badge on top of that. 21 rows clipped the
# last legend line; 23 does not.
#
# ONE PANEL SERVES EVERY WORKFLOW and cannot resize itself per selection, so it is sized for the
# tallest diagram. A shorter one leaves white space below it, which is the cheaper failure.
#
# WITH NO WORKFLOW SELECTED AND SEVERAL IN RANGE, the template iterates over all of them and the
# diagrams STACK. That is the honest rendering of "you have not narrowed it down yet", and picking a
# workflow collapses it to one.
PANEL_W, PANEL_H = 48, 23

SCALE = 2


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

    return ('<?xml version="1.0" encoding="UTF-8"?>\n'
            + head + "\n" + style + body[head_end:] + "\n</svg>\n"), len(kept), size


def find_chrome(explicit):
    if explicit:
        return explicit
    for pattern in (
        os.path.expanduser("~/AppData/Local/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-win64/chrome-headless-shell.exe"),
        os.path.expanduser("~/AppData/Local/ms-playwright/chromium-*/chrome-win64/chrome.exe"),
        "/usr/bin/chromium", "/usr/bin/google-chrome",
    ):
        found = sorted(glob.glob(pattern))
        if found:
            return found[-1]
    sys.exit("no Chromium found - pass --chrome /path/to/chrome")


def render_png(chrome, svg_path, size, scale):
    """Screenshot the SVG headless. file:// is used deliberately, so no web server is needed to
    BUILD the images - only to SERVE them."""
    out = os.path.join(tempfile.mkdtemp(), "diagram.png")
    subprocess.run(
        [chrome, "--headless", "--disable-gpu", "--hide-scrollbars", "--no-sandbox",
         "--force-device-scale-factor=%d" % scale,
         "--window-size=%d,%d" % (size[0] + 20, size[1] + 20),
         "--screenshot=" + out, "--virtual-time-budget=5000",
         "file:///" + svg_path.replace("\\", "/")],
        check=True, capture_output=True)
    if not os.path.exists(out):
        sys.exit("the renderer produced no file")
    return open(out, "rb").read()


def workflow_ids(es_url):
    """name -> id, read from the naming records the BaseApi writes at start time.

    Same source as the field formatters, and no time window for the same reason: those records are
    written once per explicit start, so a recent window would resolve nothing.
    """
    body = {"size": 0,
            "query": {"bool": {"filter": [{"exists": {"field": "attributes.EntityName"}},
                                          {"term": {"attributes.EntityKind": "workflow"}}]}},
            "aggs": {"w": {"terms": {"field": "attributes.WorkflowId", "size": 200},
                           "aggs": {"latest": {"top_hits": {
                               "size": 1, "sort": [{"@timestamp": {"order": "desc"}}],
                               "_source": ["attributes.EntityName"]}}}}}}
    import requests
    r = requests.post(f"{es_url}/{DATA_STREAM}/_search", json=body, timeout=60)
    r.raise_for_status()
    out = {}
    for b in r.json()["aggregations"]["w"]["buckets"]:
        label = b["latest"]["hits"]["hits"][0]["_source"]["attributes"]["EntityName"]
        out[label.rsplit("_", 1)[0]] = b["key"]      # strip the _version suffix
    return out


def tsvb_panel(base_url):
    """A TSVB markdown panel, split by workflow id.

    EMPTY ALT TEXT IS LOAD-BEARING - see the module docstring. `![](url)` renders nothing when the
    file is missing; `![alt](url)` renders a broken-image icon and the alt string.
    """
    markdown = "{{#each _all}}![](%s/{{label}}.png)\n{{/each}}" % base_url.rstrip("/")
    params = {
        "id": "diagram", "type": "markdown",
        "index_pattern": DATA_STREAM, "time_field": "@timestamp",
        "interval": "", "axis_position": "left",
        # SCROLLBARS ON. With no workflow selected and several in range the diagrams stack, and a
        # fixed-height panel would silently hide every one after the first - the reader would not
        # know a second existed. Scrolling is ugly and honest. Selecting a workflow collapses it
        # to one diagram and the scrollbar goes away, which is the intended way to use it.
        "markdown": markdown, "markdown_scrollbars": 1, "markdown_openLinksInNewTab": 1,
        # terms on the id, so each series label IS the id and the template can build a filename.
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


MANIFEST = os.path.join(ROOT, "k8s", "25-diagrams.yaml")

HEADER = """# ============================================================================
# skp-diagrams - a static file server for the per-workflow diagram images.
# ============================================================================
# GENERATED BY kibana/build-diagram-panels.py. Do not hand-edit: the binaryData below is
# regenerated from docs/diagrams/*.html on every build, and the KEYS ARE WORKFLOW IDS, which
# change whenever the graph is rebuilt on a different cluster.
#
# WHY THIS EXISTS AT ALL. The dashboard's diagram panel builds an image URL out of the selected
# workflow's id, so the images have to be fetchable over http. They cannot be data URIs: a data URI
# is fixed at build time and cannot vary with a selection, which is exactly what this panel does.
#
# THE OPERATOR'S BROWSER FETCHES THESE, NOT KIBANA. So this must be reachable from wherever the
# dashboard is opened, and the --base-url passed to the build script must match. On this cluster
# that is the port-forward on 18097; elsewhere it is whatever serves it.
#
# A ConfigMap rather than a baked image: two PNGs totalling a few hundred KB, against a 1 MiB
# ConfigMap limit, and this way a rebuild is a kubectl apply rather than a build-load-roll cycle.
# If the diagrams ever outgrow that limit, bake an image instead.
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: skp-diagrams
  namespace: skp
binaryData:
"""

BODY = """---
apiVersion: v1
kind: Service
metadata:
  name: skp-diagrams
  namespace: skp
spec:
  type: ClusterIP
  selector:
    app: skp-diagrams
  ports:
    - name: http
      port: 80
      targetPort: 8080
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: skp-diagrams
  namespace: skp
spec:
  replicas: 1
  selector:
    matchLabels:
      app: skp-diagrams
  template:
    metadata:
      labels:
        app: skp-diagrams
    spec:
      containers:
        - name: nginx
          # nginx-unprivileged listens on 8080 as a non-root user, so no securityContext juggling
          # and no privileged port. Already present on the node from earlier work; if a pull is
          # needed on an offline machine, side-load it the way 24-kibana.yaml documents.
          image: nginxinc/nginx-unprivileged:1.27-alpine
          ports:
            - containerPort: 8080
          volumeMounts:
            - name: diagrams
              mountPath: /usr/share/nginx/html
              readOnly: true
          resources:
            requests:
              memory: 32Mi
            limits:
              memory: 64Mi
          readinessProbe:
            # /index.html, not / : nginx will not list a directory and answers / with 403, which
            # a probe reads as unhealthy. See write_manifest().
            httpGet:
              path: /index.html
              port: 8080
            initialDelaySeconds: 3
      volumes:
        - name: diagrams
          configMap:
            name: skp-diagrams
"""


def write_manifest(built):
    """The ConfigMap keys are the served filenames, which are the workflow ids.

    AN index.html IS INCLUDED, and it is not decoration. nginx refuses a directory listing, so
    `GET /` returns 403 - which a readiness probe reads as "not ready" and the Deployment never
    comes up. Probing a PNG instead is not an option: the filenames are workflow ids and change per
    cluster, so the probe path would have to be regenerated too. An index is a fixed path that is
    always there, and it doubles as a way to see what the server actually holds.
    """
    lines = [HEADER]
    for _name, workflow_id, _size in built:
        blob = base64.b64encode(open(os.path.join(OUT_DIR, workflow_id + ".png"), "rb").read()).decode()
        lines.append("  %s.png: %s\n" % (workflow_id, blob))

    index = ["<!doctype html><meta charset=utf-8><title>skp diagrams</title>",
             "<h1>skp workflow diagrams</h1>",
             "<p>Served for the Kibana operator dashboard. Filenames are workflow ids.</p>", "<ul>"]
    for name, workflow_id, _size in built:
        index.append('<li><a href="%s.png">%s.png</a> &mdash; %s</li>' % (workflow_id, workflow_id, name))
    index.append("</ul>")
    lines.append("data:\n  index.html: |\n")
    for line in index:
        lines.append("    %s\n" % line)

    lines.append(BODY)
    with open(MANIFEST, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("".join(lines))
    return os.path.getsize(MANIFEST)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--es", default="http://localhost:19200")
    ap.add_argument("--base-url", default="http://localhost:18097",
                    help="where the diagrams folder is served from, as the OPERATOR'S BROWSER sees "
                         "it - the browser fetches the image, not Kibana")
    ap.add_argument("--chrome")
    ap.add_argument("--scale", type=int, default=SCALE)
    args = ap.parse_args()

    ids = workflow_ids(args.es)
    os.makedirs(OUT_DIR, exist_ok=True)
    chrome = find_chrome(args.chrome)

    built, skipped = [], []
    for name, rel in sorted(DIAGRAMS.items()):
        workflow_id = ids.get(name)
        if not workflow_id:
            skipped.append(name)
            continue
        html = open(os.path.join(ROOT, rel), encoding="utf-8").read()
        svg_text, rules, size = extract_svg(html)
        svg_path = os.path.join(OUT_DIR, name + ".svg")
        with open(svg_path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(svg_text)
        png = render_png(chrome, svg_path, size, args.scale)
        png_path = os.path.join(OUT_DIR, workflow_id + ".png")
        with open(png_path, "wb") as fh:
            fh.write(png)
        built.append((name, workflow_id, len(png)))
        print(f"{name:36s} {size[0]}x{size[1]}  {rules:2d} rules  ->  {workflow_id}.png  "
              f"{len(png)/1024:6.1f} KB")

    if skipped:
        print(f"\nno naming record, so no id, so no image: {skipped}")
        print("  start those workflows once and re-run")
    if not built:
        sys.exit("nothing built")

    panel = tsvb_panel(args.base_url)
    lines, wrote = [], False
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

    size = write_manifest(built)
    print(f"\nk8s    {os.path.relpath(MANIFEST, ROOT)}  ({size/1024:.1f} KB) - kubectl apply -f it")

    total = sum(b[2] for b in built)
    print(f"\npanel  TSVB markdown at {args.base_url}/<workflowId>.png")
    print(f"export {os.path.relpath(EXPORT, ROOT)}  ({os.path.getsize(EXPORT)/1024:.1f} KB - the "
          f"images are NO LONGER inside it)")
    print(f"images {len(built)} files, {total/1024:.1f} KB total, in {os.path.relpath(OUT_DIR, ROOT)}")


if __name__ == "__main__":
    main()
