#!/usr/bin/env python3
"""Range-query every panel expression across a fault window and segment it before / during / after.

The companion to chaos-timeline.js, and the reason findings can be stated as facts rather
than impressions. The timeline says what a panel SHOWED; this says what the panel COULD
have shown. A panel that stayed green while its own expression moved is a rendering or
thresholding defect. A panel that stayed green while its expression stayed flat is a
missing signal -- a different finding with a different fix.

    python grafana/chaos-probe.py --fault-at 2026-08-23T18:04:12Z --heal-at 2026-08-23T18:05:12Z

Pads the window by --pad seconds either side so "before" and "after" have something in them.
"""

import argparse
import json
import pathlib
import statistics
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

DASH = pathlib.Path(__file__).parent / "dashboards"

SUBS = {
    "$__rate_interval": "1m", "$__interval": "30s", "$__range": "10m",
    "$service_name": ".*", "$service_version": ".*", "$service_instance_id": ".*",
    "$processorId": ".*", "$processor": ".*", "$role": ".*",
    "$source": ".*", "$pod": ".*",
}


def resolve(expr):
    for k, v in SUBS.items():
        expr = expr.replace(k, v)
    return expr


def walk(panels):
    for p in panels:
        yield p
        yield from walk(p.get("panels", []))


def parse_ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)


def query_range(prom, expr, start, end, step):
    url = f"{prom}/api/v1/query_range?" + urllib.parse.urlencode(
        {"query": expr, "start": start.timestamp(), "end": end.timestamp(), "step": step})
    with urllib.request.urlopen(url, timeout=40) as r:
        return json.load(r)


def seg(series, lo, hi):
    """Every sample from every series whose timestamp falls in [lo, hi)."""
    vals = []
    for s in series:
        for ts, v in s.get("values", []):
            if lo <= ts < hi:
                try:
                    f = float(v)
                except ValueError:
                    continue
                if f == f:                      # drop NaN -- it renders blank, not zero
                    vals.append(f)
    return vals


def describe(vals):
    if not vals:
        return "        --        "
    return f"{min(vals):9.3g}/{statistics.fmean(vals):9.3g}/{max(vals):9.3g}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prom", default="http://localhost:19090")
    ap.add_argument("--fault-at", required=True)
    ap.add_argument("--heal-at", required=True)
    ap.add_argument("--pad", type=int, default=180)
    ap.add_argument("--step", default="15s")
    ap.add_argument("--out")
    args = ap.parse_args()

    fault, heal = parse_ts(args.fault_at), parse_ts(args.heal_at)
    start, end = fault - timedelta(seconds=args.pad), heal + timedelta(seconds=args.pad)
    fts, hts = fault.timestamp(), heal.timestamp()

    print(f"window  {start:%H:%M:%S} .. [{fault:%H:%M:%S} fault .. {heal:%H:%M:%S} heal] .. {end:%H:%M:%S}")
    print(f"{'panel':52} {'series':>6}  {'before min/mean/max':^30} {'during':^30} {'after':^30}")

    rows = []
    for path in sorted(DASH.glob("*.json")):
        board = json.load(path.open(encoding="utf-8"))
        print(f"\n-- {board['title']}")
        for panel in walk(board["panels"]):
            for t in panel.get("targets", []):
                raw = t.get("expr", "")
                if not raw:
                    continue
                try:
                    res = query_range(args.prom, resolve(raw), start, end, args.step)
                except Exception as e:                       # noqa: BLE001
                    print(f"   ERROR {panel['title']}: {e}")
                    continue
                if res.get("status") != "success":
                    print(f"   ERROR {panel['title']}: {res.get('error')}")
                    continue
                series = res["data"]["result"]
                b = seg(series, start.timestamp(), fts)
                d = seg(series, fts, hts)
                a = seg(series, hts, end.timestamp())
                legend = (t.get("legendFormat") or "").strip()
                name = f"{panel['title']}"[:44] + (f" [{legend[:6]}]" if legend else "")
                # Moved = the during-segment left the range the before-segment occupied.
                moved = bool(b and d) and (max(d) > max(b) * 1.5 + 1e-9 or min(d) < min(b) - 1e-9)
                flag = " <<" if moved else ("  ~" if (b and not d) else "   ")
                print(f"   {name:50}{len(series):>4}  {describe(b)} {describe(d)} {describe(a)}{flag}")
                rows.append({"board": board["title"], "panel": panel["title"], "legend": legend,
                             "expr": raw, "series": len(series), "before": b, "during": d,
                             "after": a, "moved": moved})

    if args.out:
        pathlib.Path(args.out).write_text(json.dumps(rows, indent=1), encoding="utf-8")
        print(f"\n-> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
