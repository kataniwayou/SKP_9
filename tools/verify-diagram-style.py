#!/usr/bin/env python3
"""
Style-invariant check for workflow diagrams.

WHY THIS IS NOT A DIFF. The drawings are generated from the live graph by an agentic task, so two
runs of the same prompt never produce identical coordinates, and the graph itself moves underneath
them - sk-normalizer was inserted at hop 4 on 2026-09-12 and the AlphaBeta fork on 2026-09-14, and
the prompt's own history records three of six facts going stale in a day. A byte or geometry diff
would therefore fail for reasons that are not defects.

WHAT IS ACTUALLY INVARIANT is the visual identity: the token palette, the type ladder, the drawing
width and the class vocabulary. Those are fixed regardless of what the graph says, so they are what
this asserts. Content - node counts, labels, height - is expected to differ and is never compared.

THE REFERENCE IS THE RICHEST DRAWING. filefetcher-archiveexpander-chain carries failure, cancel and
fork paths, so its class vocabulary is a superset of any simpler workflow's. simple-abc uses 13 of
its 26 classes. A candidate emitting a class the reference does not have is drawing something the
design system has no treatment for; a candidate MISSING classes is just a simpler workflow.

    python tools/verify-diagram-style.py                      # both committed goldens
    python tools/verify-diagram-style.py --candidate out.html # a fresh dry-run against the reference
"""
import argparse, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Keyed by the live EntityName, which is {name}_{version} - what Elasticsearch actually holds and
# what the dashboard's field formatters render. The bare name is only an artefact of the build
# script's registry, which strips the suffix to look itself up.
WORKFLOWS = {
    "filefetcher-archiveexpander-chain_1.0.0": "docs/diagrams/filefetcher-archiveexpander-chain.html",
    "simple-abc_1.0.0":                        "docs/diagrams/simple-abc.html",
}
REFERENCE = "filefetcher-archiveexpander-chain_1.0.0"


def facts(path):
    """The style invariants, read from a .html page or an extracted .svg - the <style> block and the
    <svg> element look the same in both."""
    text = open(path, encoding="utf-8").read()
    svg = text[text.index("<svg"):text.rindex("</svg>") + 6] if "<svg" in text else text
    root = re.search(r":root\s*\{(.*?)\}", text, re.S)
    # An extracted .svg inlines its own <style>, so the token DEFINITIONS sit inside the <svg>.
    # Scanning them as stray colours would fail every extracted file for declaring its palette,
    # which is the one place a literal belongs. Strip the style block before hunting literals.
    drawing = re.sub(r"<style>.*?</style>", "", svg, flags=re.S)
    return {
        "vars":   dict(re.findall(r"(--[a-z0-9-]+):\s*([^;]+?)\s*(?=;|$)", root.group(1))) if root else {},
        "sizes":  {s.strip() for s in re.findall(r"font-size:\s*([^;}]+)", text)},
        "fams":   {f.strip() for f in re.findall(r"font-family:\s*([^;}]+)", text)},
        "classes": {c for g in re.findall(r'class="([^"]+)"', svg) for c in g.split()},
        "width":  (lambda m: float(m.group(1)) if m else None)(
                      re.search(r'viewBox="0 0 ([\d.]+) [\d.]+"', svg)),
        "stray":  sorted({h for h in re.findall(r"#[0-9a-fA-F]{3,8}\b", drawing)}),
    }


def compare(name, cand, ref):
    """Returns a list of failures. Content may differ freely; identity may not."""
    out = []
    if cand["vars"] != ref["vars"]:
        for k in sorted(set(ref["vars"]) | set(cand["vars"])):
            a, b = ref["vars"].get(k), cand["vars"].get(k)
            if a != b:
                out.append(f"token {k}: reference {a!r}, candidate {b!r}")
    if cand["width"] != ref["width"]:
        out.append(f"viewBox width {cand['width']}, reference {ref['width']}")
    for f in sorted(cand["fams"] - ref["fams"]):
        out.append(f"font-family {f!r} is not one of the reference stacks")
    for s in sorted(cand["sizes"] - ref["sizes"]):
        out.append(f"font-size {s!r} is off the reference ladder")
    for c in sorted(cand["classes"] - ref["classes"]):
        out.append(f"class {c!r} has no treatment in the design system")
    if cand["stray"]:
        out.append(f"hard-coded colour(s) in the drawing, not tokens: {', '.join(cand['stray'])}")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--candidate", help="a fresh dry-run page to check against the reference")
    ap.add_argument("--reference", default=REFERENCE, help="which workflow is the golden")
    args = ap.parse_args()

    ref = facts(os.path.join(ROOT, WORKFLOWS[args.reference]))
    print(f"reference  {args.reference}")
    print(f"           {len(ref['vars'])} tokens, {len(ref['classes'])} classes, "
          f"width {ref['width']:.0f}, ladder {len(ref['sizes'])}\n")

    targets = ([("candidate", args.candidate)] if args.candidate
               else [(n, os.path.join(ROOT, p)) for n, p in sorted(WORKFLOWS.items())])

    failed = 0
    for name, path in targets:
        if not os.path.exists(path):
            print(f"FAIL {name}\n       no such file: {path}")
            failed += 1
            continue
        problems = compare(name, facts(path), ref)
        if problems:
            failed += 1
            print(f"FAIL {name}")
            for p in problems:
                print(f"       {p}")
        else:
            print(f"ok   {name}")
    print()
    if failed:
        print(f"{failed} of {len(targets)} failed")
    else:
        print(f"all {len(targets)} consistent with {args.reference}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
