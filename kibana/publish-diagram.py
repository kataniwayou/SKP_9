#!/usr/bin/env python3
"""
Draws a workflow's diagram from the live graph and publishes it to the workflow row.

THE OPERATOR'S PROCESS IS THREE STEPS, and this is the middle one:

    1. create the workflow entities through the BaseApi
    2. python kibana/publish-diagram.py <workflow-name>
    3. look at the dashboard, or run tools/verify-diagram-render.js

NOTHING IS PRE-BAKED. The drawing is read from the live graph on every run, so it is current by
construction rather than because someone remembered to redraw it. An earlier design kept a registry
mapping two workflow names to two committed HTML pages; that published a drawing authored on some
earlier date, and capped the pipeline at whichever workflows somebody had added to the dict. The
stored `description` is not consulted either, and for good reason - this workflow's own still reads
six hops while the live graph has ten.

WHAT A SCRIPT CANNOT DRAW. Authored judgement does not survive this: an annotation like
"archive-document - the container branch", and a step's Cancelled paths, which exist only in
processor source and never in the API. A hand-drawn page can carry them; this cannot. That is the
price of the drawing being current, and it is why docs/diagrams/workflow-diagram-prompt.md remains -
it is the layout contract this implements, and the place those judgements are described.

THE GATE REFUSES TO PUBLISH A BROKEN DRAWING. It is structural and runs on coordinates: every
failure edge reaches the sink, nothing leaves the viewBox, no attribute is declared twice, and the
SVG parses. Text metrics need a real renderer and belong to step 3 - a duplicated `xmlns` once
served as 200 image/svg+xml with correct bytes and rendered as nothing at all, which only a browser
noticed.
"""
import argparse
import json
import os
import re
import sys
import urllib.request
import xml.dom.minidom

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# The design system lives in a committed page, which is ALSO the golden that
# tools/verify-diagram-style.py compares against. One source, two consumers: a palette change moves
# both, and neither can drift without the style checker saying so. That page is not a publish
# source - it stopped being one when this script started drawing.
STYLE_REFERENCE = os.path.join(ROOT, "docs", "diagrams", "filefetcher-archiveexpander-chain.html")

# 1580 IS A CONTRACT, NOT A COMPUTED VALUE. Every drawing is served into the same dashboard panel,
# so they must share a width or the panel rescales as the operator switches workflow. Deriving it
# from the node count gave 1574 for this graph - six pixels, invisible by eye, caught by the style
# checker.
VB_W, VB_H = 1580, 520
X0, PITCH, W, H = 40, 192, 150, 86
YT, YF = 120, 340
BUS_Y = YF - 40

# ABOVE the boxes, not beside the edge. The gaps between boxes are 42px and `archive-document`
# renders ~96px wide, so a label centred on the edge spills over the box on either side and lands on
# the processor name. Measured: eight collisions.
LABEL_Y = YT - 10


def api(base, path):
    with urllib.request.urlopen(f"{base}/api/v1/{path}", timeout=30) as r:
        return json.load(r)


def read_graph(base, workflow_name):
    """Step 1 of the drawing: the live entities, never the stored description."""
    workflows = api(base, "workflows")
    matches = [w for w in workflows
               if f'{w["name"]}_{w["version"]}' == workflow_name or w["name"] == workflow_name]
    if not matches:
        known = sorted(f'{w["name"]}_{w["version"]}' for w in workflows)
        sys.exit(f"no workflow named {workflow_name}\n  known: " + "\n         ".join(known))
    wf = matches[0]

    steps = {s["id"]: s for s in api(base, "steps")}
    procs = {p["id"]: p for p in api(base, "processors")}
    schemas = {s["id"]: s for s in api(base, "schemas")}
    assigns = {a["id"]: a for a in api(base, "assignments")}

    by_step = {}
    for aid in wf.get("assignmentIds") or []:
        a = assigns.get(aid)
        if a:
            by_step.setdefault(a.get("stepId"), []).append(a)

    reachable, frontier = {}, list(wf.get("entryStepIds") or [])
    while frontier:
        sid = frontier.pop(0)
        if sid in reachable or sid not in steps:
            continue
        reachable[sid] = steps[sid]
        frontier += steps[sid].get("nextStepIds") or []

    # The sink is whatever admits a failure (entryCondition 2) and whatever follows it.
    sink = [sid for sid, s in reachable.items() if s["entryCondition"] == 2]
    fail_chain = []
    if sink:
        cur = sink[0]
        while cur:
            fail_chain.append(cur)
            nxt = [n for n in (steps[cur].get("nextStepIds") or []) if n in steps]
            cur = nxt[0] if nxt else None

    spine, cur = [], (wf.get("entryStepIds") or [None])[0]
    while cur:
        spine.append(cur)
        nxt = [n for n in (steps[cur].get("nextStepIds") or [])
               if n in steps and n not in fail_chain]
        cur = nxt[-1] if nxt else None      # a fork's later branch continues the line

    return dict(wf=wf, steps=steps, procs=procs, schemas=schemas, by_step=by_step,
                spine=spine, fail_chain=fail_chain)


def style_block(used_classes):
    """The reference page's :root plus only the rules the drawing references.

    The page's stylesheet is mostly chrome. Carrying all of it would couple the image to a layout it
    is no longer part of, and the drawing is served on its own.
    """
    text = open(STYLE_REFERENCE, encoding="utf-8").read()
    css = text[text.index("<style>") + 7:text.index("</style>")]
    root = re.search(r":root\s*\{(.*?)\}", css, re.S).group(1)
    kept = []
    for m in re.finditer(r"([^{}]+)\{([^{}]*)\}", css):
        selector, decls = m.group(1).strip(), m.group(2)
        if selector.startswith("@") or selector == ":root":
            continue
        if any(("." + c) in selector for c in used_classes):
            kept.append("%s {%s}" % (selector, decls))
    return "  <style>\n    :root {%s}\n    %s\n  </style>\n" % (root, "\n    ".join(kept))


def esc(s):
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def render(g):
    """Step 2: the drawing, laid out from the graph."""
    steps, procs, schemas, by_step = g["steps"], g["procs"], g["schemas"], g["by_step"]
    spine, fail_chain = g["spine"], g["fail_chain"]

    pos = {sid: (X0 + PITCH * i, YT) for i, sid in enumerate(spine)}
    for i, sid in enumerate(fail_chain):
        pos[sid] = (520 + 240 * i, YF)

    def out_schema(sid):
        p = procs[steps[sid]["processorId"]]
        return (schemas.get(p.get("outputSchemaId")) or {}).get("name")

    def config(sid):
        # The payload arrives as a JSON STRING. Iterating it directly walks its characters and
        # paints `{, "` into every box - which renders perfectly and says nothing.
        raw = (by_step.get(sid) or [{}])[0].get("payload")
        try:
            cfg = json.loads(raw) if isinstance(raw, str) else (raw or {})
        except (ValueError, TypeError):
            cfg = {}
        return ", ".join(list(cfg)[:2]) if cfg else "no config"

    body, used = [], set()

    def emit(markup, *classes):
        used.update(classes)
        body.append(markup)

    for i, sid in enumerate(spine + fail_chain):
        s = steps[sid]
        p = procs[s["processorId"]]
        x, y = pos[sid]
        if sid in fail_chain:
            cls = "node-box-fail" if s["entryCondition"] == 2 else "node-box"
            cfg_cls = "n-cfg-fail" if s["entryCondition"] == 2 else "n-cfg"
            cfg_txt, hop = f'entryCondition {s["entryCondition"]}', None
        else:
            cls = "node-box-fork" if p["name"] == "sk-normalizer" else "node-box"
            cfg_cls, cfg_txt, hop = "n-cfg", config(sid), i + 1
        emit(f'    <rect class="{cls}" x="{x}" y="{y}" width="{W}" height="{H}" rx="3"/>\n', cls)
        emit(f'    <text class="n-proc" x="{x+W//2}" y="{y+40}" text-anchor="middle">{esc(p["name"])}'
             f'<tspan class="n-proc-ver">_{esc(p["version"])}</tspan></text>\n',
             "n-proc", "n-proc-ver")
        emit(f'    <text class="n-step" x="{x+W//2}" y="{y+59}" text-anchor="middle">{esc(s["name"])}'
             f'<tspan class="n-step-ver">_{esc(s["version"])}</tspan></text>\n',
             "n-step", "n-step-ver")
        emit(f'    <text class="{cfg_cls}" x="{x+W//2}" y="{y+74}" text-anchor="middle">{esc(cfg_txt)}</text>\n',
             cfg_cls)
        if hop is not None:
            emit(f'    <circle class="hop-disc" cx="{x+12}" cy="{y+12}" r="9"/>\n', "hop-disc")
            emit(f'    <text class="hop-num" x="{x+12}" y="{y+15}" text-anchor="middle">{hop}</text>\n',
                 "hop-num")

    # A LABEL NAMES THE SCHEMA THE EDGE CARRIES, and nothing else. An edge whose source declares no
    # output schema gets none: captioning it with the entry condition would name a property of the
    # step at its far end.
    for i in range(len(spine) - 1):
        a, b = spine[i], spine[i + 1]
        x1, x2, y = pos[a][0] + W, pos[b][0], YT + H // 2
        emit(f'    <line class="edge-ok" x1="{x1}" y1="{y}" x2="{x2}" y2="{y}"/>\n', "edge-ok")
        sc = out_schema(a)
        if sc:
            emit(f'    <text class="lbl-schema" x="{(x1+x2)//2}" y="{LABEL_Y}" text-anchor="middle">{esc(sc)}</text>\n',
                 "lbl-schema")
            emit(f'    <circle class="gate" cx="{(x1+x2)//2}" cy="{y}" r="3.5"/>\n', "gate")

    # THE FAILURE EDGES RUN ONTO A BUS AND THEN INTO THE SINK. A stub that stops in white space
    # draws something that LOOKS like an edge and connects nothing, leaving the reader to infer the
    # destination - the one thing a wiring diagram exists to remove. No prose annotation either: the
    # drawing already says "any step that fails" by where the edges go.
    if fail_chain and spine:
        xs = [pos[sid][0] + W // 2 for sid in spine]
        for cx in xs:
            emit(f'    <line class="edge-fail" x1="{cx}" y1="{YT+H}" x2="{cx}" y2="{BUS_Y}"/>\n',
                 "edge-fail")
        sink_cx = pos[fail_chain[0]][0] + W // 2
        emit(f'    <line class="edge-fail" x1="{min(xs)}" y1="{BUS_Y}" x2="{max(xs)}" y2="{BUS_Y}"/>\n',
             "edge-fail")
        emit(f'    <line class="edge-fail" x1="{sink_cx}" y1="{BUS_Y}" x2="{sink_cx}" y2="{YF}"/>\n',
             "edge-fail")
    for i in range(len(fail_chain) - 1):
        a, b = fail_chain[i], fail_chain[i + 1]
        x1, x2, y = pos[a][0] + W, pos[b][0], YF + H // 2
        emit(f'    <line class="edge-ok" x1="{x1}" y1="{y}" x2="{x2}" y2="{y}"/>\n', "edge-ok")

    emit(f'  <text class="legend-txt" x="{X0}" y="{VB_H-24}">{len(spine)} steps on the success path, '
         f'{len(fail_chain)} on the failure sink, drawn from the live graph</text>\n', "legend-txt")

    label = f'{g["wf"]["name"]}: {len(spine)} steps left to right'
    if fail_chain:
        label += f', failures drop to {steps[fail_chain[0]]["name"]}'
    head = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {VB_W} {VB_H}" '
            f'width="{VB_W}" height="{VB_H}" role="img" aria-label="{esc(label)}">\n')
    return ('<?xml version="1.0" encoding="UTF-8"?>\n' + head + style_block(used)
            + "".join(body) + "</svg>\n"), pos


def gate(svg, g, pos):
    """Structural checks, on coordinates. Text metrics need a browser - that is step 3."""
    problems = []
    try:
        xml.dom.minidom.parseString(svg.encode("utf-8"))
    except Exception as exc:                                    # noqa: BLE001
        problems.append(f"the SVG does not parse: {exc}")

    head = svg[svg.index("<svg"):svg.index(">", svg.index("<svg"))]
    for attr in ("xmlns", "width", "height", "viewBox"):
        seen = len(re.findall(r"\s%s=" % attr, head))
        if seen != 1:
            problems.append(f"<svg> declares {attr} {seen} times, expected once")

    for sid, (x, y) in pos.items():
        if x < 0 or y < 0 or x + W > VB_W or y + H > VB_H:
            problems.append(f'{g["steps"][sid]["name"]} at ({x},{y}) leaves the viewBox')

    if g["fail_chain"] and g["spine"]:
        fails = re.findall(
            r'<line class="edge-fail" x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"', svg)
        verticals = [f for f in fails if f[0] == f[2]]
        horizontals = [f for f in fails if f[1] == f[3]]
        if len(horizontals) != 1:
            problems.append(f"expected exactly one bus, found {len(horizontals)}")
        if len(verticals) != len(g["spine"]) + 1:
            problems.append(
                f'expected {len(g["spine"])+1} vertical failure edges, found {len(verticals)}')
        for x1, _y1, _x2, y2 in verticals:
            if float(y2) not in (float(BUS_Y), float(YF)):
                problems.append(f"failure edge at x={x1} ends at y={y2} - it dangles")
    return problems


def main():
    ap = argparse.ArgumentParser(
        description="Draw a workflow's diagram from the live graph and publish it.")
    ap.add_argument("workflow", help="EntityName, e.g. simple-abc_1.0.0")
    ap.add_argument("--api", default="http://localhost:18080")
    ap.add_argument("--dry-run", action="store_true", help="draw and gate, publish nothing")
    ap.add_argument("--out", help="also write the SVG here, for inspection")
    args = ap.parse_args()

    g = read_graph(args.api, args.workflow)
    svg, pos = render(g)
    print(f'{args.workflow:44s} {len(g["spine"])} on the spine, '
          f'{len(g["fail_chain"])} on the sink, {len(svg)/1024:.1f} KB')

    problems = gate(svg, g, pos)
    if problems:
        print("\nGATE FAILED - nothing published:")
        for p in problems:
            print("  -", p)
        return 1
    print("  gate passed: edges terminate, nothing escapes the viewBox, the SVG parses")

    if args.out:
        open(args.out, "w", encoding="utf-8", newline="\n").write(svg)
        print(f"  wrote {args.out}")
    if args.dry_run:
        print("  dry run - nothing published")
        return 0

    req = urllib.request.Request(
        f'{args.api}/api/v1/workflows/{g["wf"]["id"]}/diagram',
        data=svg.encode("utf-8"), method="PUT",
        headers={"Content-Type": "image/svg+xml"})
    with urllib.request.urlopen(req, timeout=60) as r:
        code = r.status
    print(f'  published to {g["wf"]["id"]} ({code})')
    print(f'  served at    {args.api}/api/v1/workflows/{g["wf"]["id"]}.svg')
    print("\nStep 3: open the dashboard, or run tools/verify-diagram-render.js")
    return 0


if __name__ == "__main__":
    sys.exit(main())
