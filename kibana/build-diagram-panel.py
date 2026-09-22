#!/usr/bin/env python3
"""
Rebuilds the chain-diagram panel inside kibana/kibana-export.ndjson.

WHY THIS EXISTS AT ALL. The dashboard shows a step-outcome bar per step, labelled with a step name,
and a reader who does not already know the workflow cannot tell from the bars what feeds what. The
block diagram answers that, and Kibana has no panel that will take the diagram's own HTML.

WHAT KIBANA ACTUALLY ACCEPTS, measured against 8.15.5 on 2026-09-22 with four variants rendered on
a scratch dashboard:

    markdown  ![](data:image/png;base64,...)   RENDERS
    markdown  ![](http://host/diagram.svg)     RENDERS
    markdown  ![](data:image/svg+xml;base64,)  fails - emitted as literal text
    markdown  <img src="...">                  fails - raw HTML is stripped

So SVG is not blocked as a FORMAT, only as a data URI, and a raster data URI is the one route that
needs no origin to serve from. That matters more than it looks: this dashboard is going to an
offline cluster owned by someone else, where there is nowhere to host a file and nothing may be left
running. A PNG data URI travels inside the export itself.

    There is no iframe panel, no raw-HTML panel, and the Markdown panel sanitizes inline <svg>.
    Those were established earlier and are still true. They are simply not the whole option space,
    which is how the first survey reached the wrong answer.

THE RASTER IS GENERATED, NEVER HAND-EDITED, and that is what keeps it from drifting away from the
diagram it depicts:

    docs/diagrams/filefetcher-archiveexpander-chain.html   <- the source of truth, captured from the
      |                                                       live API on 2026-09-15
      |  extract_svg()        strips the page, inlines the 24 CSS rules the drawing actually uses
      v
    docs/diagrams/filefetcher-archiveexpander-chain.svg    <- committed, self-contained, ~15 KB
      |
      |  render_png()         headless Chrome at --force-device-scale-factor=2
      v
    a base64 PNG, written straight into the dashboard's markdown panel (no file on disk)

Re-run this after any edit to the HTML. Nothing downstream is hand-maintained.

    python kibana/build-diagram-panel.py

Needs a Chromium binary. It finds the one Playwright installed; pass --chrome to point elsewhere.
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

ROOT   = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HTML   = os.path.join(ROOT, "docs", "diagrams", "filefetcher-archiveexpander-chain.html")
SVG    = os.path.join(ROOT, "docs", "diagrams", "filefetcher-archiveexpander-chain.svg")
EXPORT = os.path.join(ROOT, "kibana", "kibana-export.ndjson")

DASHBOARD_ID = "skp-operator-outcomes"
PANEL_INDEX  = "p3"

# The viewBox of the drawing. The render is sized to this so the PNG carries no letterboxing, and
# the panel height below is derived from the same ratio rather than guessed.
VIEW_W, VIEW_H = 1580, 520

# Kibana's grid is 48 columns; a row is ~31px at the default row height. A full-width panel is about
# 1870px, so a 3.04:1 drawing needs ~615px, which is 20 rows plus one for the panel title.
#
# THE FIRST ATTEMPT USED h=18 AND CLIPPED THE FAILURE ROW off the bottom - the outcome-recorder and
# its exporter, which is the half of the diagram a reader consults when something has gone wrong.
PANEL_W, PANEL_H = 48, 21

# 2x, and the choice is measured. 1x is legible but goes soft the moment a reader maximises the
# panel, which is exactly when they are looking hardest. 3x costs 410 KB in the export and is not
# visibly better than 2x on any display this runs on.
SCALE = 2


def extract_svg(html_text):
    """The page's single <svg>, made to stand on its own.

    The drawing's styling lives in the document's <style> block, not on the elements, so lifting the
    <svg> out of the page gives an unstyled skeleton. This inlines the rules it actually references.

    RULES ARE KEPT BY THE CLASSES THE DRAWING USES, not by copying the stylesheet wholesale. The
    page's stylesheet is mostly chrome - the sheet, the title block, the step ledger, the prose
    below - and dragging it along would triple the file and couple the diagram to the page's layout.
    """
    lines = html_text.split("\n")

    style_start = next(i for i, l in enumerate(lines) if "<style>" in l)
    style_end   = next(i for i, l in enumerate(lines) if i > style_start and "</style>" in l)
    svg_start   = next(i for i, l in enumerate(lines) if "<svg" in l)
    svg_end     = next(i for i, l in enumerate(lines) if i > svg_start and "</svg>" in l)

    css = "\n".join(lines[style_start:style_end + 1]).split("<style>", 1)[1].rsplit("</style>", 1)[0]
    svg = "\n".join(lines[svg_start:svg_end + 1])

    used = {c for grp in re.findall(r'class="([^"]+)"', svg) for c in grp.split()}

    # The rules reference var(--ink) and friends, so :root comes along whole.
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
    # The xmlns is required once this is a document rather than a fragment in an HTML page.
    head = body[:head_end].replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" ', 1)

    return ('<?xml version="1.0" encoding="UTF-8"?>\n'
            + head + "\n" + style + body[head_end:] + "\n</svg>\n"), len(used), len(kept)


def find_chrome(explicit):
    if explicit:
        return explicit
    # Playwright's headless shell is the likeliest thing present on a dev machine here.
    for pattern in (
        os.path.expanduser("~/AppData/Local/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-win64/chrome-headless-shell.exe"),
        os.path.expanduser("~/AppData/Local/ms-playwright/chromium-*/chrome-win64/chrome.exe"),
        "/usr/bin/chromium", "/usr/bin/google-chrome",
    ):
        found = sorted(glob.glob(pattern))
        if found:
            return found[-1]
    sys.exit("no Chromium found - pass --chrome /path/to/chrome")


def render_png(chrome, svg_path, scale):
    """Screenshot the SVG headless.

    file:// is used deliberately: the renderer loads it without complaint, so the build step needs
    no web server. (A browser AUTOMATION tool may refuse the file: protocol - that is a policy in the
    tool, not in Chrome, and it does not apply here.)
    """
    out = os.path.join(tempfile.mkdtemp(), "diagram.png")
    subprocess.run(
        [chrome, "--headless", "--disable-gpu", "--hide-scrollbars", "--no-sandbox",
         "--force-device-scale-factor=%d" % scale,
         "--window-size=%d,%d" % (VIEW_W + 20, VIEW_H + 20),
         "--screenshot=" + out, "--virtual-time-budget=5000",
         "file:///" + svg_path.replace("\\", "/")],
        check=True, capture_output=True)
    if not os.path.exists(out):
        sys.exit("the renderer produced no file")
    return open(out, "rb").read()


def markdown_panel(png_bytes):
    """A BY-VALUE panel, carrying the image in the dashboard rather than in a saved visualization.

    By-reference would put a second saved object in the export whose only content is one image, and
    it would need a fixed id of its own to survive re-import - one more thing to collide with on a
    shared Space for no gain. Nothing else will ever reuse this panel.
    """
    uri = "data:image/png;base64," + base64.b64encode(png_bytes).decode()
    return {
        "version": "8.15.5",
        "type": "visualization",
        # y=0: THE DIAGRAM IS THE FIRST THING ON THE DASHBOARD. The bars are labelled per step, and
        # a reader who does not already know the workflow cannot interpret them until they know what
        # feeds what. Orientation first, then the data it makes readable.
        "gridData": {"x": 0, "y": 0, "w": PANEL_W, "h": PANEL_H, "i": PANEL_INDEX},
        "panelIndex": PANEL_INDEX,
        "title": "The chain - what feeds what",
        "embeddableConfig": {"savedVis": {
            "title": "", "description": "", "type": "markdown",
            "params": {"fontSize": 12, "openLinksInNewTab": False,
                       "markdown": "![filefetcher-archiveexpander-chain](%s)" % uri},
            "uiState": {},
            "data": {"aggs": [], "searchSource": {"query": {"query": "", "language": "kuery"},
                                                  "filter": []}}}},
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--chrome", help="path to a Chromium binary")
    ap.add_argument("--scale", type=int, default=SCALE)
    args = ap.parse_args()

    svg_text, used, kept = extract_svg(open(HTML, encoding="utf-8").read())
    with open(SVG, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(svg_text)
    print("svg     %s  (%d classes used, %d rules inlined, %.1f KB)"
          % (os.path.relpath(SVG, ROOT), used, kept, len(svg_text.encode()) / 1024))

    png = render_png(find_chrome(args.chrome), SVG, args.scale)
    print("png     %dx  %.1f KB raw, %.1f KB as base64"
          % (args.scale, len(png) / 1024, len(base64.b64encode(png)) / 1024))

    panel = markdown_panel(png)

    lines, wrote = [], False
    for raw in open(EXPORT, encoding="utf-8"):
        raw = raw.strip()
        if not raw:
            continue
        obj = json.loads(raw)
        if obj.get("type") == "dashboard" and obj.get("id") == DASHBOARD_ID:
            panels = [p for p in json.loads(obj["attributes"]["panelsJSON"])
                      if p.get("panelIndex") != PANEL_INDEX]

            # THE OTHER PANELS ARE RE-FLOWED, not left where they were. The diagram sits at the top,
            # so everything else has to start below it -- and their offset depends on PANEL_H, which
            # changes whenever the drawing's aspect ratio does. Hardcoding their y values here would
            # mean a silent overlap the next time the diagram got taller.
            #
            # Their RELATIVE order and spacing is preserved: the topmost existing panel is pinned
            # directly under the diagram and the rest keep their gaps. This script owns its own
            # panel's position and nothing else's.
            if panels:
                top = min(p["gridData"]["y"] for p in panels)
                for other in panels:
                    other["gridData"]["y"] += PANEL_H - top

            panels.insert(0, panel)
            obj["attributes"]["panelsJSON"] = json.dumps(panels)
            wrote = True
            print("layout  diagram at y=0, %d panel(s) re-flowed below it" % len(panels[1:]))
        lines.append(json.dumps(obj))

    if not wrote:
        sys.exit("dashboard %s not found in %s" % (DASHBOARD_ID, EXPORT))

    with open(EXPORT, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(lines) + "\n")
    print("export  %s  (%.1f KB)"
          % (os.path.relpath(EXPORT, ROOT), os.path.getsize(EXPORT) / 1024))


if __name__ == "__main__":
    main()
