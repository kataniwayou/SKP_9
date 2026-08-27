#!/usr/bin/env python3
"""Prove every `pipeline.*` instrument the code declares has a live series.

The gap this closes. Two instruments went silent this week and nothing noticed:
`pipeline.deadletter.depth`, orphaned when its meter moved and the host's `AddMeter`
list did not follow, and `pipeline.gate.trips`, whose zero seed was pushed from a
hosted-service constructor before any MeterProvider existed and so reached no reader
at all. Neither is a build error -- an instrument with no subscriber and an instrument
with no measurement both compile and both run. Neither is a test failure either: the
suite asserts metrics through a `MeterListener` it constructs FIRST, which sees pushed
measurements the real provider never gets. Both defects survive every check the repo
had except reading a board and noticing it was empty.

What "live" means here. Not that the name exists -- a name can outlive its data, and
`pipeline_gate_trips_total` was found in Prometheus carrying no current samples while
the panel keyed to it drew nothing. An instant query only returns a series with a
sample inside the staleness window, so a name that has gone quiet reads as absent,
which is the reading that matches what an operator sees.

Suffixes are discovered, not predicted. The exported name is the instrument name with
dots swapped for underscores, plus whatever the collector appends for the unit and the
type -- `_total` for a counter, `_seconds` for a duration, `_ratio` for a gauge whose
unit is "1". Getting that mapping wrong in this script would invent orphans, so it
matches by prefix against the names Prometheus actually holds instead.

    python grafana/audit-instruments.py [prometheus-url]

Exit code is 1 if any declared instrument has no live series.
"""

import json
import pathlib
import re
import sys
import urllib.parse
import urllib.request

PROM = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:19090"
SRC = pathlib.Path(__file__).resolve().parent.parent / "src"

# Every `pipeline.*` string literal in production code. The names are declared as consts
# or passed straight to a Create* call, so a literal scan finds all of them -- and finds
# them in the source of truth rather than in a list here that could drift out of date.
# A hand-maintained inventory would have listed both of this week's orphans as present.
NAME = re.compile(r'"(pipeline\.[a-z0-9._]+)"')


def declared():
    names = {}
    for path in SRC.rglob("*.cs"):
        if "tests" in path.parts or "obj" in path.parts or "bin" in path.parts:
            continue
        for name in NAME.findall(path.read_text(encoding="utf-8")):
            names.setdefault(name, path.relative_to(SRC).as_posix())
    return dict(sorted(names.items()))


def get(path, params):
    url = f"{PROM}/api/v1/{path}?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.load(r)


def main():
    instruments = declared()
    if not instruments:
        print("no pipeline.* instruments found in src/ -- is the path right?")
        return 1

    exported = set(get("label/__name__/values", {})["data"])

    orphans = []
    print(f"{len(instruments)} declared instruments, Prometheus at {PROM}\n")

    for name, source in instruments.items():
        base = name.replace(".", "_")
        # The exported name is `base`, or `base` plus a unit/type suffix. Anchored on an
        # underscore so pipeline_gate_open cannot claim pipeline_gate_probe_duration.
        matches = sorted(n for n in exported if n == base or n.startswith(base + "_"))

        live = []
        for m in matches:
            result = get("query", {"query": f"count({m})"})["data"]["result"]
            if result:
                live.append((m, int(float(result[0]["value"][1]))))

        if live:
            shown = ", ".join(f"{m} x{c}" for m, c in live)
            print(f"  ok      {name:<34} {shown}")
        else:
            why = "name present, no current samples" if matches else "no exported name"
            print(f"  ORPHAN  {name:<34} {why}  [{source}]")
            orphans.append(name)

    print()
    if orphans:
        print(f"{len(orphans)} orphaned instrument(s): {', '.join(orphans)}")
        print("An instrument with no live series cannot express the failure it exists to catch.")
        return 1

    print(f"all {len(instruments)} instruments have at least one live series")
    return 0


if __name__ == "__main__":
    sys.exit(main())
