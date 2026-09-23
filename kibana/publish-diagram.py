#!/usr/bin/env python3
"""
Draws a workflow's diagram from the live graph and publishes it to the workflow row.

THE OPERATOR'S PROCESS IS THREE STEPS, and this is the middle one:

    1. create the workflow entities through the BaseApi
    2. python kibana/publish-diagram.py <workflow-name>

THE RENDER CHECK IS NOT A THIRD STEP ANY MORE. It was tools/verify-diagram-render.js, run by hand
against the drawing ALREADY on the workflow row - so anything only a browser can see was published
first and discovered later, if ever. It runs here now, on the candidate, and a failure refuses the
publish. Verifying the artefact you are about to publish is strictly stronger than verifying the
one you already did.

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
import math
import os
import re
import sys
import urllib.request
import xml.dom.minidom

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# THE STYLE SYSTEM LIVES HERE, not in a workflow's page. It used to be scraped with a regex out of
# docs/diagrams/filefetcher-archiveexpander-chain.html at every publish, which made a script that
# draws ANY workflow depend on the committed page of ONE - rename or delete that file and every
# drawing loses its styling. That page has since been deleted, which this survived precisely
# because the coupling was cut first. The tokens and rules below are that page's, carried over verbatim, so
# the rendered output is unchanged; what changed is that the generic script no longer reaches into
# a specific workflow's artefact to find out what a box looks like.
#
# Only rules the drawing actually references are emitted - see style_block. The page carried 76,
# of which a drawing can use these.
STYLE_ROOT = """
    --ground: #EEF0EC;
    --sheet: #FAFBF8;
    --ink: #191D1A;
    --muted: #667069;
    --rule: #D0D6CE;
    --rule-soft: #E1E6DF;
    --ok: #0E6B5E;
    --ok-soft: rgba(14, 107, 94, 0.10);
    --fail: #A8481A;
    --fail-soft: rgba(168, 72, 26, 0.10);
    --sans: "IBM Plex Sans Condensed", "Helvetica Neue", Arial, sans-serif;
    --serif: "IBM Plex Serif", Georgia, "Times New Roman", serif;
    --mono: "IBM Plex Mono", ui-monospace, "Cascadia Mono", Consolas, monospace;
"""

STYLE_RULES = {
    ".node-box": "fill: var(--sheet); stroke: var(--rule); stroke-width: 1.4;",
    ".node-box-fork": "fill: var(--ok-soft); stroke: var(--ok); stroke-width: 1.4;",
    ".node-box-fail": "fill: var(--fail-soft); stroke: var(--fail); stroke-width: 1.4;",
    ".n-proc": "fill: var(--ink); font-family: var(--sans); font-size: 11.5px; font-weight: 600;",
    ".n-proc-ver": "fill: var(--muted); font-size: 9px; font-weight: 500;",
    ".n-step": "fill: var(--muted); font-family: var(--mono); font-size: 8.5px;",
    ".n-step-ver": "fill: var(--muted); font-size: 7.5px;",
    ".n-cfg": "fill: var(--ok); font-family: var(--mono); font-size: 10.5px;",
    ".n-cfg-fail": "fill: var(--fail); font-family: var(--mono); font-size: 10.5px;",
    ".edge-ok": "stroke: var(--ok); stroke-width: 1.6; fill: none;",
    ".edge-fail": "stroke: var(--fail); stroke-width: 1.4; fill: none; stroke-dasharray: 5 4;",
    ".edge-cancel": "stroke: var(--muted); stroke-width: 1.4; fill: none; stroke-dasharray: 2 4; stroke-linecap: round;",
    ".lbl-cancel": "fill: var(--muted); font-family: var(--sans); font-size: 11.5px; font-weight: 600;",
    # ARROWHEADS, NOT A DISC. The disc sat at the MIDDLE of each edge and said nothing about
    # direction - on a left-to-right chain that is readable, on a bypass that doubles back it is
    # not. A head that touches the target rectangle states the direction of every edge in the same
    # way. Filled rather than stroked, which is why these are polygons: the render check requires a
    # stroke on every path and line, and a filled arrowhead legitimately has none.
    ".arrow": "fill: var(--ok);",
    ".arrow-fail": "fill: var(--fail);",
    ".lbl-schema": "fill: var(--muted); font-family: var(--mono); font-size: 10px;",
    ".lbl-fail": "fill: var(--fail); font-family: var(--sans); font-size: 11.5px; font-weight: 600;",
    ".lbl-note": "fill: var(--muted); font-family: var(--sans); font-size: 11.5px;",
    ".lbl-out": "fill: var(--ink); font-family: var(--mono); font-size: 11px;",
    ".legend-txt": "fill: var(--muted); font-family: var(--sans); font-size: 12px;",
    # New with the bypass arc: an edge that skips a column is the same stroke as any success edge,
    # drawn as a path rather than a line, so it needs no colour of its own - only the fill reset
    # that a path requires and a line does not.
    # BOTH CLASSES, ALWAYS. This rule only resets the fill a <path> needs and a <line> does not;
    # the stroke comes from .edge-ok. Emitted alone it renders a path with no stroke - present in
    # the DOM, counted by the gate, invisible on screen. Which is the same failure the missing edge
    # was: structurally there, visually absent.
    ".edge-bypass": "fill: none;",
    # The legend band. Monospace so the key lists column up under each other.
    ".lg-step": "fill: var(--ink); font: 600 11px ui-monospace, monospace;",
    ".lg-cfg": "fill: var(--ink-soft); font: 11px ui-monospace, monospace;",
    # A KEY AND ITS VALUE ARE DIFFERENT THINGS AND LOOK IT. The line was a list of keys, so one
    # colour was enough; `topic: skp-paths, messageCount: 25` in a single colour is a wall.
    ".lg-key": "fill: var(--ink-soft);",
    ".lg-val": "fill: var(--ink);",
    ".lg-punct": "fill: var(--muted);",
    # The schedule, above the drawing. Same size as the caption below it - they are the two lines
    # that describe the run rather than the graph.
    ".head-cron": "fill: var(--muted); font: 11px ui-monospace, monospace;",
    ".head-cron-val": "fill: var(--ink); font-weight: 600;",
}

# THE LEGEND BAND IS AS TALL AS IT HAS LINES. It was sized for the worst case - eight rows,
# whatever the graph - so simple-abc drew three lines and then 80px of ruled nothing. The argument
# for the worst case was that the panel keeps its height between workflows; the panel scales the
# image either way, so all a fixed band bought was a smaller drawing with white underneath it.
# Measured on simple-abc: 236px of empty lane above the band, and five ruled-but-empty rows in it.
LEGEND_DY = 16

# THE WIDTH IS THE DRAWING'S, NOT A ROUND NUMBER. It was 1580 for every workflow - the width a
# ten-step spine needs - on the reasoning that a shared width stops the panel rescaling between
# workflows. What it actually bought was a three-step drawing occupying a third of its own canvas:
# the panel is a full dashboard row, it scales the image to fit, and a canvas two thirds empty
# means everything on it renders two thirds smaller, with a band of white between the boxes and the
# assignment lines below them. So the width is computed from what is drawn - the rightmost box,
# the legend's longest line, the caption - plus one left-margin's worth of air on the right.
#
# TEXT IS ESTIMATED, NOT MEASURED. Python has no text engine; the estimate below is deliberately
# generous, and the render check measures the real thing in a browser and refuses to publish
# anything whose content escapes the viewBox. An estimate that is short fails loudly rather than
# clipping a legend line.
#
# THE HEIGHT IS DERIVED THE SAME WAY, and for the same reason. The failure row sat at a fixed
# y=276 whether or not the graph had a failure sink, so a workflow with none - simple-abc - drew an
# empty 236px lane between its boxes and its assignment lines, measured in a browser. The legend
# now starts under the LOWEST ROW THAT WAS ACTUALLY DRAWN, which is the failure row when there is
# one and the success row when there is not.
VB_W_MIN = 420                  # a one-step drawing still wants a readable caption under it
VB_W_PAD = 40                   # air on the right, matching X0 on the left
X0, PITCH, W, H = 40, 192, 150, 86

# THE DRAWING SITS AS HIGH AS THE LANES ABOVE IT ALLOW. YT was 120, which left most of a viewBox
# height of empty white above the first row - wasted in a panel that is always shorter than the
# drawing wants to be. What has to fit above the boxes is only two things: the bypass lane and the
# schema labels, so YT is the sum of those plus a small margin rather than a round number.
# THE STRIP ABOVE THE DRAWING carries the workflow's schedule. It is a property of the run, not of
# any one step, so it goes where a reader looks first and nowhere near a box. Every y below is
# derived from these three, so the strip is added once here rather than at each use.
HEAD_H = 26
HEAD_Y = 16

YT, YF = 56 + HEAD_H, 276 + HEAD_H
BUS_Y = YF - 40

# ABOVE the boxes, not beside the edge. The gaps between boxes are 42px and `archive-document`
# renders ~96px wide, so a label centred on the edge spills over the box on either side and lands on
# the processor name. Measured: eight collisions.
LABEL_Y = YT - 10

# THE BYPASS LANE, above the schema labels at LABEL_Y. An edge that skips a column cannot run along
# the row - the boxes between are in the way - so it goes up, across and back down. Anything lower
# collides with the labels it passes; this is the top margin.
BYPASS_Y = 18 + HEAD_H

# The bypass edge's schema label, ABOVE its lane. The row labels at LABEL_Y belong to the edges
# running along the row; a bypass runs up here, so its label follows it rather than staying behind
# with edges it is not.
BYPASS_LABEL_Y = BYPASS_Y - 6

# The gap between the lowest row of boxes and the first legend line, and the strip under the
# caption. Both are margins now rather than terms in a fixed total - see render().
LEGEND_GAP = 26
CAPTION_BAND = 36


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

    # EVERY SUCCESS EDGE, not only the ones the spine happens to walk. The spine is a LINE and a
    # graph is not: at a fork it keeps one successor and drops the rest, which is how
    # sk-normalizer-sample -> split-archivecollapser disappeared from a drawing that was otherwise
    # correct. Positions still come from the spine; what is drawn comes from here.
    on_spine = set(spine)
    edges = []
    for sid in spine:
        for n in (steps[sid].get("nextStepIds") or []):
            if n in on_spine and n != sid:
                edges.append((sid, n))

    return dict(wf=wf, steps=steps, procs=procs, schemas=schemas, by_step=by_step,
                spine=spine, fail_chain=fail_chain, edges=edges)


def style_block(used_classes):
    """The tokens, plus only the rules the drawing references.

    Emitting all of them would carry chrome the image is not part of: the drawing is served on
    its own, not inside the page these came from.
    """
    kept = [sel + " {" + decls + "}" for sel, decls in STYLE_RULES.items()
            if any(("." + c) == sel for c in used_classes)]
    parts = ["  <style>", "    :root {" + STYLE_ROOT.strip() + "}"]
    parts += ["    " + k for k in kept]
    parts += ["  </style>", ""]
    return chr(10).join(parts)


def esc(s):
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def fmt_value(v):
    """What a payload value reads as on one line.

    Strings unquoted - they are the common case and the quotes are noise; everything else as
    compact JSON, so a list stays a list and `4` is not mistaken for "4".
    """
    if isinstance(v, str):
        return v
    if isinstance(v, bool) or v is None:
        return json.dumps(v)
    if isinstance(v, (int, float)):
        return repr(v)
    return json.dumps(v, separators=(", ", ": "))


def cfg_text(pairs):
    """The same line as plain text - what the width estimate and the gate compare against."""
    return ", ".join(f"{k}: {v}" for k, v in pairs) if pairs else "no config"


def text_w(s, size, mono=True):
    """A generous upper estimate of rendered width, in user units.

    Generous on purpose: this decides the canvas width, and the browser check refuses to publish a
    drawing whose content escapes it. Erring wide costs whitespace; erring narrow costs a publish.
    """
    return len(str(s)) * size * (0.62 if mono else 0.58)


def render(g):
    """Step 2: the drawing, laid out from the graph.

    Returns the SVG and what the gate needs to judge it: where the boxes went, which edges were
    drawn, which of those carry a schema label, and the canvas the drawing sized for itself.
    """
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
        # EVERY KEY AND ITS VALUE. This was list(cfg)[:2] because the box is 150px wide, so
        # split-filefetcher showed two of its three and lost allowedExtensions - the whitelist that
        # decides one of the chain's five outcomes - with nothing to say a key was hidden. Then it
        # was every key and no value, which names what a step is configured BY and never what it is
        # configured TO: `topic` on two Kafka steps says they both read a topic, not that one reads
        # skp-paths and the other writes skp-documents. The band has the width for the pair, and
        # the canvas grows if it does not.
        return [(k, fmt_value(v)) for k, v in cfg.items()]

    body, used = [], set()

    def emit(markup, *classes):
        used.update(classes)
        body.append(markup)

    # NO ORDINAL ON A BOX, and none on its assignment line either. A numeral is only a reading
    # order, and this drawing already states one everywhere it is true: the spine runs left to
    # right and the arrowheads say which way each edge points. What the numeral added was a second
    # naming scheme for the same step - the box says `sk-normalizer-sample`, the legend line says
    # `sk-normalizer-sample`, and the numeral said `4`, which is a fact about the layout rather
    # than about the graph. It also went stale the moment the spine changed: insert a step and
    # every numeral after it means a different box than it did in the last drawing anyone saw.
    for sid in spine + fail_chain:
        s = steps[sid]
        p = procs[s["processorId"]]
        x, y = pos[sid]
        cls = ("node-box-fail" if s["entryCondition"] == 2 else "node-box") if sid in fail_chain \
            else ("node-box-fork" if p["name"] == "sk-normalizer" else "node-box")
        # ENTRY CONDITION ON EVERY BOX, not only the failure sink. It is the one property that
        # decides whether a step runs when its predecessor failed, and showing it on some boxes
        # and not others read as "these steps have one and those do not". Config keys are in
        # the legend band; this is a single short token and belongs on the box.
        cfg_cls = "n-cfg-fail" if s["entryCondition"] == 2 else "n-cfg"
        cfg_txt = f'entryCondition {s["entryCondition"]}'
        emit(f'    <rect class="{cls}" x="{x}" y="{y}" width="{W}" height="{H}" rx="3"/>\n', cls)
        emit(f'    <text class="n-proc" x="{x+W//2}" y="{y+40}" text-anchor="middle">{esc(p["name"])}'
             f'<tspan class="n-proc-ver">_{esc(p["version"])}</tspan></text>\n',
             "n-proc", "n-proc-ver")
        emit(f'    <text class="n-step" x="{x+W//2}" y="{y+59}" text-anchor="middle">{esc(s["name"])}'
             f'<tspan class="n-step-ver">_{esc(s["version"])}</tspan></text>\n',
             "n-step", "n-step-ver")
        emit(f'    <text class="{cfg_cls}" x="{x+W//2}" y="{y+74}" text-anchor="middle">{esc(cfg_txt)}</text>\n',
             cfg_cls)

    # A LABEL NAMES THE SCHEMA THE EDGE CARRIES, and nothing else. An edge whose source declares no
    # output schema gets none: captioning it with the entry condition would name a property of the
    # step at its far end.
    # EVERY EDGE, not only the neighbours the spine walks. The spine is a LINE and a graph is not:
    # at a fork it keeps one successor and drops the rest, which is how
    # sk-normalizer-sample -> split-archivecollapser vanished from a drawing that was otherwise
    # correct and passed its own gate. Positions still come from the spine; what is DRAWN comes
    # from the edge list.
    def arrow(x, y, facing, cls="arrow"):
        """A filled head whose TIP touches the rectangle, so the edge visibly terminates on it."""
        if facing == "right":
            pts = f"{x},{y} {x-9},{y-4.5} {x-9},{y+4.5}"
        else:   # down
            pts = f"{x},{y} {x-4.5},{y-9} {x+4.5},{y-9}"
        emit(f'    <polygon class="{cls}" points="{pts}"/>\n', cls)

    # WHICH EDGES GOT A LABEL, so the gate can check that every edge carrying a schema says so.
    # The fanout's bypass went unlabelled for exactly as long as nothing compared the two: the
    # label was emitted in the adjacent-edge branch only, so the one edge on the drawing that a
    # reader cannot follow by eye was also the one with no schema on it.
    col = {sid: k for k, sid in enumerate(spine)}
    drawn, labelled = set(), set()

    def schema_label(cx, ly, sc):
        emit(f'    <text class="lbl-schema" x="{cx}" y="{ly}" text-anchor="middle">{esc(sc)}</text>\n',
             "lbl-schema")

    for a, b in g["edges"]:
        ca, cb = col[a], col[b]
        y = YT + H // 2
        if cb == ca + 1:
            x1, x2 = pos[a][0] + W, pos[b][0]
            emit(f'    <line class="edge-ok" x1="{x1}" y1="{y}" x2="{x2}" y2="{y}"/>\n', "edge-ok")
            sc = out_schema(a)
            if sc:
                schema_label((x1 + x2) // 2, LABEL_Y, sc)
                labelled.add((a, b))
            arrow(x2, y, "right")
        else:
            # A BYPASS: the source reaches a step further along without passing through the boxes
            # between, so it cannot run on the row. STRAIGHT SEGMENTS ONLY - up into the lane,
            # across, and back down - matching every other wire on the drawing. A curve here was
            # the only non-straight line in the diagram and read as a different KIND of edge.
            xa, xb = pos[a][0] + W // 2, pos[b][0] + W // 2
            emit(f'    <path class="edge-ok edge-bypass" d="M {xa} {YT} L {xa} {BYPASS_Y} '
                 f'L {xb} {BYPASS_Y} L {xb} {YT}"/>\n', "edge-ok", "edge-bypass")
            # THE BYPASS CARRIES A SCHEMA LIKE ANY OTHER EDGE. It was drawn without one - the label
            # lived in the branch above - so on the chain's fanout the only edge whose route is not
            # obvious was also the only one that did not say what it carries.
            sc = out_schema(a)
            if sc:
                schema_label((xa + xb) // 2, BYPASS_LABEL_Y, sc)
                labelled.add((a, b))
            arrow(xb, YT, "down")
        drawn.add((a, b))

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
        arrow(sink_cx, YF, "down", "arrow-fail")
    for i in range(len(fail_chain) - 1):
        a, b = fail_chain[i], fail_chain[i + 1]
        x1, x2, y = pos[a][0] + W, pos[b][0], YF + H // 2
        emit(f'    <line class="edge-ok" x1="{x1}" y1="{y}" x2="{x2}" y2="{y}"/>\n', "edge-ok")
        arrow(x2, y, "right")

    # THE BAND STARTS UNDER THE LOWEST ROW THAT EXISTS. `pos` holds only the steps that were
    # drawn, so a graph with no failure sink has no failure row and the legend rises to meet the
    # boxes instead of clearing a lane that nothing is in.
    legend_y0 = max(y for _x, y in pos.values()) + H + LEGEND_GAP
    vb_h = legend_y0 + LEGEND_DY * len(spine) + CAPTION_BAND

    # THE LEGEND BAND. The config keys used to sit inside the 150px rectangle, truncated to two
    # with nothing to say more existed. They hang off the step's NAME down here, where there is
    # width for the whole list - the name is what ties a line to its box now that neither carries
    # a numeral, and it is the same string the box prints.
    for k, sid in enumerate(spine):
        ly = legend_y0 + LEGEND_DY * k
        emit(f'    <text class="lg-step" x="{X0}" y="{ly}">{esc(steps[sid]["name"])}</text>\n',
             "lg-step")
        pairs = config(sid)
        if pairs:
            spans = []
            for n, (k, v) in enumerate(pairs):
                sep = '<tspan class="lg-punct">, </tspan>' if n else ""
                spans.append(f'{sep}<tspan class="lg-key">{esc(k)}</tspan>'
                             f'<tspan class="lg-punct">: </tspan>'
                             f'<tspan class="lg-val">{esc(v)}</tspan>')
            emit(f'    <text class="lg-cfg" x="{X0+260}" y="{ly}">' + "".join(spans) + '</text>\n',
                 "lg-cfg", "lg-key", "lg-val", "lg-punct")
        else:
            emit(f'    <text class="lg-cfg" x="{X0+260}" y="{ly}">no config</text>\n', "lg-cfg")

    # THE SCHEDULE, ABOVE THE DRAWING AND TO THE LEFT. A workflow with no cron is not a workflow
    # that runs continuously - it is one nothing starts, which the drawing should say rather than
    # leave as an empty strip the reader reads as "no opinion".
    cron = (g["wf"].get("cronExpression") or "").strip()
    cron_txt = cron if cron else "no cron - started by hand"
    emit(f'  <text class="head-cron" x="{X0}" y="{HEAD_Y}">cron <tspan class="head-cron-val">'
         f'{esc(cron_txt)}</tspan></text>\n', "head-cron", "head-cron-val")

    caption = (f'{len(spine)} steps on the success path, '
               f'{len(fail_chain)} on the failure sink, drawn from the live graph')
    emit(f'  <text class="legend-txt" x="{X0}" y="{vb_h-24}">{esc(caption)}</text>\n', "legend-txt")

    # THE CANVAS IS SIZED TO WHAT IS ON IT. Three things can be rightmost: the last box on a row, a
    # legend line, or the caption. The legend lines are often the widest - the config keys were
    # moved down here precisely because they do not fit inside a 150px box - so a width taken from
    # the boxes alone would clip them.
    right = [max(x for x, _y in pos.values()) + W,
             X0 + text_w(caption, 12, mono=False),
             X0 + text_w("cron " + cron_txt, 11)]
    for sid in spine:
        right.append(X0 + text_w(steps[sid]["name"], 11))
        right.append(X0 + 260 + text_w(cfg_text(config(sid)), 11))
    vb_w = max(VB_W_MIN, int(math.ceil(max(right) + VB_W_PAD)))

    label = f'{g["wf"]["name"]}: {len(spine)} steps left to right'
    if fail_chain:
        label += f', failures drop to {steps[fail_chain[0]]["name"]}'
    head = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {vb_w} {vb_h}" '
            f'width="{vb_w}" height="{vb_h}" role="img" aria-label="{esc(label)}">\n')
    svg = ('<?xml version="1.0" encoding="UTF-8"?>\n' + head + style_block(used)
           + "".join(body) + "</svg>\n")
    return svg, dict(pos=pos, drawn=drawn, labelled=labelled, vb_w=vb_w, vb_h=vb_h,
                     cron=cron_txt)


# THE BROWSER CHECK, RUN ON THE CANDIDATE BEFORE IT IS PUBLISHED. It used to be
# tools/verify-diagram-render.js, a separate step 3 an operator ran by hand against the drawing
# ALREADY on the workflow row - so a drawing that renders as nothing was published first and
# discovered afterwards, if at all. That is not hypothetical: an arc carrying a class that set no
# stroke passed the coordinate gate, reached the row, and served to the dashboard invisible.
#
# WHY A BROWSER AT ALL. The gate above is arithmetic on coordinates and cannot see rendering. A
# duplicated xmlns once served 200 image/svg+xml with correct bytes and drew nothing; text metrics
# need a real text engine; and a stroke-less path is present in the DOM and absent on screen.
RENDER_CHECK_JS = r"""
const { chromium } = require('playwright');
const FILE = process.argv[2], VB_W = Number(process.argv[3]), WRAP = process.argv[4];

// WHAT COUNTS AS WASTED CANVAS. Both numbers are the ones the layout aims for plus a little
// slack - the right margin also absorbs the difference between Python's estimate of a text's
// width and what the browser actually renders.
const MAX_GAP = 48;        // boxes to the first assignment line
const MAX_MARGIN = 160;    // any side, between the drawing and the edge of its canvas
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1700, height: 900 } });
  const fail = [];
  const url = FILE;   // a file:// URL built by the caller - no path munging in here

  // A) through the panel's own mechanism: a bare <img> with empty alt, where a failed load is
  // invisible rather than showing a broken-image icon.
  // A FILE-ORIGIN WRAPPER, not setContent. A page created by setContent has an about:blank
  // origin, and Chromium refuses to load a file:// subresource into it - the <img> then
  // reports naturalWidth 0, which is indistinguishable from the drawing being broken.
  await page.goto(WRAP, { waitUntil: 'load' });
  await page.waitForTimeout(1200);
  const img = await page.evaluate(() => { const i = document.getElementById('d');
    return { ok: i.complete && i.naturalWidth > 0, nw: i.naturalWidth, nh: i.naturalHeight }; });
  if (!img.ok) fail.push('the image did not load in an <img> tag');
  if (img.nw !== VB_W) fail.push('intrinsic width ' + img.nw + ', the drawing declares ' + VB_W);

  // B) the document itself, for geometry, text metrics and strokes.
  await page.goto(url, { waitUntil: 'load' });
  const d = await page.evaluate(() => {
    const s = document.querySelector('svg');
    const bb = e => { const b = e.getBBox(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
    const strokeless = [];
    for (const e of s.querySelectorAll('path, line')) {
      const cs = getComputedStyle(e);
      if (cs.stroke === 'none' || cs.strokeWidth === '0px')
        strokeless.push(e.getAttribute('class') || e.tagName);
    }
    return { vb: s.getAttribute('viewBox').split(' ').map(Number),
             w: s.getAttribute('width'), h: s.getAttribute('height'),
             boxes: s.querySelectorAll('rect[class^="node-box"]').length,
             boxBottom: Math.max(...[...s.querySelectorAll('rect[class^="node-box"]')]
                                   .map(e => bb(e).y + bb(e).h)),
             legendTop: Math.min(...[...s.querySelectorAll('text.lg-step, text.lg-cfg')]
                                   .map(e => bb(e).y), Infinity),
             texts: [...s.querySelectorAll('text')].map(t => ({ s: t.textContent.trim(), ...bb(t) })),
             root: bb(s), strokeless };
  });
  if (+d.w !== d.vb[2] || +d.h !== d.vb[3])
    fail.push('width/height ' + d.w + 'x' + d.h + ' disagrees with viewBox');
  if (img.nh !== d.vb[3]) fail.push('the <img> reported ' + img.nh + ' tall, the SVG says ' + d.vb[3]);
  if (d.boxes === 0) fail.push('a drawing with no step boxes');

  // THE CHECK THAT WAS MISSING EVERYWHERE. A stroke-less path is in the DOM, counted by any
  // structural gate, and invisible on screen - the same failure as an edge that was never drawn.
  for (const c of d.strokeless) fail.push('element renders no stroke: ' + c);

  d.texts.forEach((t, i) => { if (t.w === 0) fail.push('text[' + i + '] "' + t.s + '" measured 0px wide'); });
  for (let i = 0; i < d.texts.length; i++)
    for (let j = i + 1; j < d.texts.length; j++) {
      const a = d.texts[i], b = d.texts[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h)
        fail.push('text overlap: "' + a.s + '" x "' + b.s + '"');
    }
  const r = d.root;
  if (r.x < 0 || r.y < 0 || r.x + r.w > d.vb[2] || r.y + r.h > d.vb[3])
    fail.push('content escapes the viewBox');

  // THE CANVAS IS NO BIGGER THAN THE DRAWING. Both of these were real: a fixed 1580-wide canvas
  // scaled a three-step drawing down to a third of the panel, and a failure row at a fixed y left
  // 236px of empty lane between the boxes and the assignment lines of a graph that has no failure
  // sink. Neither is visible to a gate that only asks whether content fits.
  const margins = { left: r.x, top: r.y, right: d.vb[2] - (r.x + r.w), bottom: d.vb[3] - (r.y + r.h) };
  for (const [side, m] of Object.entries(margins))
    if (m > MAX_MARGIN) fail.push('wasted canvas: ' + Math.round(m) + 'px of ' + side + ' margin');
  if (isFinite(d.legendTop)) {
    const gap = d.legendTop - d.boxBottom;
    if (gap > MAX_GAP)
      fail.push('wasted canvas: ' + Math.round(gap) + 'px between the boxes and the assignment lines');
    if (gap < 0) fail.push('the assignment lines run into the boxes');
  }

  console.log('RENDER ' + d.boxes + ' boxes, ' + d.texts.length + ' texts, '
    + Math.round(d.legendTop - d.boxBottom) + 'px boxes-to-legend, margins '
    + Object.values(margins).map(Math.round).join('/') + ' measured');
  fail.forEach(f => console.log('FAIL ' + f));
  process.exit(fail.length ? 1 : 0);
})();
"""


def render_check(svg_text, vb_w):
    """Render the candidate in a real browser. Returns a list of problems; [] means it draws."""
    import pathlib, subprocess, tempfile
    # THE TEMP SCRIPT LIVES IN grafana/, NOT IN /tmp. Node resolves `require` against the
    # directory of the FILE, not the working directory, and playwright is installed under
    # grafana/node_modules - the same copy tools/verify-kibana-panels.js uses. A script written
    # anywhere else cannot find it however the cwd is set.
    node_cwd = os.path.join(ROOT, "grafana")
    with tempfile.TemporaryDirectory(dir=node_cwd) as tmp:
        cand = os.path.join(tmp, "candidate.svg")
        with open(cand, "w", encoding="utf-8") as fh:
            fh.write(svg_text)
        with open(os.path.join(tmp, "wrap.html"), "w", encoding="utf-8") as fh:
            fh.write('<body style="margin:0"><img id="d" src="candidate.svg" alt=""></body>')
        js = os.path.join(tmp, "check.js")
        with open(js, "w", encoding="utf-8") as fh:
            fh.write(RENDER_CHECK_JS)
        try:
            r = subprocess.run(["node", js, pathlib.Path(cand).as_uri(), str(vb_w),
                                pathlib.Path(os.path.join(tmp, "wrap.html")).as_uri()], cwd=node_cwd,
                               capture_output=True, text=True, timeout=180)
        except (OSError, subprocess.TimeoutExpired) as exc:
            # NOT a silent pass. A publisher that treats "could not check" as "fine" is worse than
            # one with no check, because the operator believes the drawing was verified.
            return ["could not run the render check: %s" % exc]
        for line in r.stdout.splitlines():
            if line.startswith("RENDER "):
                print("  " + line[7:] + " - rendered in a browser")
        return [l[5:] for l in r.stdout.splitlines() if l.startswith("FAIL ")] or (
            [] if r.returncode == 0 else ["render check exited %s: %s" % (r.returncode, r.stderr[:200])])


def gate(svg, g, art):
    """Structural checks, on coordinates. Text metrics need a browser - that is render_check."""
    problems = []
    pos, drawn, vb_w, vb_h = art["pos"], art["drawn"], art["vb_w"], art["vb_h"]

    # EVERY EDGE IN THE GRAPH IS IN THE DRAWING. This is the check that was missing: the old gate
    # verified that failure edges reach the sink and that nothing leaves the viewBox, but never
    # that the success edges EXIST - so a drawing that silently dropped a fork passed it. An
    # omission here is invisible by eye: the result is a clean, plausible, wrong diagram.
    missing = [(a, b) for a, b in g["edges"] if (a, b) not in drawn]
    for a, b in missing:
        problems.append("edge not drawn: %s -> %s"
                        % (g["steps"][a]["name"], g["steps"][b]["name"]))

    # AND EVERY EDGE THAT CARRIES A SCHEMA SAYS WHICH. The label was emitted only in the
    # adjacent-edge branch, so the chain's fanout - the one edge whose route a reader cannot follow
    # by eye - was also the only one with no schema on it, on a drawing where six others had one.
    # Nothing compared the two, which is why it survived. An edge whose source declares no output
    # schema is correctly bare and is not asked for a label.
    for a, b in g["edges"]:
        proc = g["procs"][g["steps"][a]["processorId"]]
        sc = (g["schemas"].get(proc.get("outputSchemaId")) or {}).get("name")
        if sc and (a, b) not in art["labelled"]:
            problems.append("edge carries %s but is unlabelled: %s -> %s"
                            % (sc, g["steps"][a]["name"], g["steps"][b]["name"]))

    # AND EVERY CONFIG KEY AND VALUE IS PRESENT VERBATIM. The keys were truncated to two for years
    # because nothing compared what was drawn against what the assignment holds; the values were
    # absent for as long again, and a rule that checks only keys cannot tell `topic: skp-paths`
    # from `topic: skp-documents` - the difference between the step that reads and the one that
    # writes. An escaped value is compared escaped, since that is what the drawing contains.
    for sid in g["spine"]:
        raw = (g["by_step"].get(sid) or [{}])[0].get("payload")
        try:
            cfg = json.loads(raw) if isinstance(raw, str) else (raw or {})
        except (ValueError, TypeError):
            cfg = {}
        for key, val in cfg.items():
            if esc(key) not in svg:
                problems.append("config key missing from drawing: %s on %s"
                                % (key, g["steps"][sid]["name"]))
            shown = esc(fmt_value(val))
            if shown not in svg:
                problems.append("config value missing from drawing: %s = %s on %s"
                                % (key, shown, g["steps"][sid]["name"]))

    # AND THE SCHEDULE IS THE ROW'S. The strip above the drawing is the one thing on it that no
    # step owns, so nothing else would catch it going stale - and a diagram that states a cron the
    # workflow does not have is worse than one that states none.
    cron = (g["wf"].get("cronExpression") or "").strip()
    if cron and f'>{esc(cron)}<' not in svg:
        problems.append("the drawing does not carry the workflow's cron: %s" % cron)
    if not cron and "no cron" not in svg:
        problems.append("the workflow has no cron and the drawing does not say so")
    if cron and art["cron"] != cron:
        problems.append("the drawing's cron %r is not the row's %r" % (art["cron"], cron))
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
        if x < 0 or y < 0 or x + W > vb_w or y + H > vb_h:
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
    svg, art = render(g)
    print(f'{args.workflow:44s} {len(g["spine"])} on the spine, '
          f'{len(g["fail_chain"])} on the sink, {art["vb_w"]}x{art["vb_h"]}, '
          f'{len(svg)/1024:.1f} KB')

    problems = gate(svg, g, art)
    if problems:
        print("\nGATE FAILED - nothing published:")
        for p in problems:
            print("  -", p)
        return 1
    print("  gate passed: every edge drawn and labelled, nothing escapes the viewBox, "
          "the SVG parses")

    # THE RENDER CHECK RUNS BEFORE THE PUT, not after. It was a separate script an operator ran
    # by hand against the drawing already on the row, so anything only a browser can see was
    # published first and found later, if ever. Verifying the artefact you are about to publish
    # is strictly stronger than verifying the one you already did.
    rendered = render_check(svg, art["vb_w"])
    if rendered:
        print(chr(10) + "RENDER CHECK FAILED - nothing published:")
        for r in rendered:
            print("  -", r)
        return 1

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
    print(chr(10) + "Open the dashboard to see it in place.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
