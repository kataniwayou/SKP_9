#!/usr/bin/env python3
"""Range-query every panel expression across a fault window and segment it before / during / after.

The companion to chaos-timeline.js, and the reason findings can be stated as facts rather
than impressions. The timeline says what a panel SHOWED; this says what the panel COULD
have shown -- both what its values did and which of its SERIES stopped.

That last part is not a refinement. chaos-timeline.js renders at now-15m and records legend
text, and a Grafana legend lists every series with data anywhere in the range -- so a run
shorter than the range cannot show a name disappear, whatever the lines do. Judged that way,
a panel that correctly ended a departed replica's line was reported as broken. Series
presence is only available here, from the range data, which is why it lives here. A panel that stayed green while its own expression moved is a rendering or
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

# $__rate_interval and $__interval carry the REAL values Grafana computes at the current
# cadence -- timeInterval 15s (matching the scrape) gives $__interval 15s and floors
# $__rate_interval at 4x that = 60s. Kept identical to grafana/check-expressions.py's SUBS
# on purpose: a probe that replays the boards at a different window than the gate that
# certifies them is measuring a third thing that nobody looks at. Change one, change both.
# $__range stays 10m here (and 1h there) because it IS an operator choice rather than a
# cadence constant, and a chaos scenario is minutes long.
SUBS = {
    "$__rate_interval": "60s", "$__interval": "15s", "$__range": "10m",
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


def fingerprint(metric):
    """A stable name for one series: its label set, minus the metric name.

    __name__ is dropped because a panel's expression may rename or aggregate away the
    metric while the identity that matters -- which replica, which queue -- lives in the
    remaining labels.
    """
    return ",".join(f"{k}={v}" for k, v in sorted(metric.items()) if k != "__name__")


def real(v):
    """A sample that would render. NaN draws blank rather than zero, so it is not one."""
    try:
        f = float(v)
    except ValueError:
        return False
    return f == f                               # NaN != NaN


def spans(series, lo, hi):
    """fingerprint -> (first, last) real-sample timestamp inside [lo, hi].

    The reading present() cannot give. Whether a series is ABSENT from a window depends on
    where you put the window, and a departed replica keeps drawing for up to a rate window
    after its last export -- legitimately, that is what rate() does. So a set difference
    over a hand-chosen fault window reports "still present" for a line that has plainly
    ended, and the only way to make it say otherwise is to move the window until it agrees,
    which is not measuring.

    Where a line ENDS is a property of the series, not of the window, so this asks that
    instead.
    """
    out = {}
    for s in series:
        fp = fingerprint(s.get("metric", {}))
        ts = [t for t, v in s.get("values", []) if lo <= t <= hi and real(v)]
        if not ts:
            continue
        prev = out.get(fp)
        first, last = min(ts), max(ts)
        out[fp] = (min(prev[0], first), max(prev[1], last)) if prev else (first, last)
    return out


def present(series, lo, hi):
    """Fingerprints of the series carrying at least one real sample in [lo, hi).

    Presence, not value. A replica idling at zero is PRESENT; a replica whose line stopped
    is not. seg() cannot make that distinction because it pools every series' samples into
    one list, so one departure among several peers leaves the pool still full. NaN does not
    count -- it renders blank rather than zero, and seg() already drops it.
    """
    return {fingerprint(s.get("metric", {}))
            for s in series
            for ts, v in s.get("values", [])
            if lo <= ts < hi and real(v)}


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

    step_s = float(args.step.rstrip("s")) if args.step.endswith("s") else float(args.step)
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
                pb = present(series, start.timestamp(), fts)
                pd = present(series, fts, hts)
                pa = present(series, hts, end.timestamp())
                left, arrived = sorted(pb - pd), sorted(pd - pb)
                sp = spans(series, start.timestamp(), end.timestamp())
                ended = sorted((fp, last) for fp, (_, last) in sp.items()
                               if end.timestamp() - last > 2 * step_s)
                legend = (t.get("legendFormat") or "").strip()
                name = f"{panel['title']}"[:44] + (f" [{legend[:6]}]" if legend else "")
                # Moved = the during-segment left the range the before-segment occupied.
                moved = bool(b and d) and (max(d) > max(b) * 1.5 + 1e-9 or min(d) < min(b) - 1e-9)
                flag = " <<" if moved else ("  ~" if (b and not d) else "   ")
                if left:
                    flag += f" -{len(left)}"
                if arrived:
                    flag += f" +{len(arrived)}"
                if ended:
                    flag += f" end{len(ended)}"
                print(f"   {name:50}{len(series):>4}  {describe(b)} {describe(d)} {describe(a)}{flag}")
                for fp, last in ended:
                    print(f"{'':56}line ENDS at +{last - start.timestamp():.0f}s "
                          f"(window +0..+{end.timestamp() - start.timestamp():.0f}s): {fp[:110]}")
                for fp in arrived:
                    print(f"{'':56}series arrives during fault: {fp[:110]}")
                rows.append({"board": board["title"], "panel": panel["title"], "legend": legend,
                             "expr": raw, "series": len(series), "before": b, "during": d,
                             "after": a, "moved": moved,
                             "series_before": len(pb), "series_during": len(pd),
                             "series_after": len(pa), "left": left, "arrived": arrived,
                             "ended": [{"series": fp,
                                        "at": round(last - start.timestamp(), 1)}
                                       for fp, last in ended]})

    if args.out:
        pathlib.Path(args.out).write_text(json.dumps(rows, indent=1), encoding="utf-8")
        print(f"\n-> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
