#!/usr/bin/env python3
"""Run every panel expression in grafana/dashboards/ against a live Prometheus.

Two failures this catches that importing the JSON does not:

  parse errors   -- Grafana accepts any string as an expr and shows the error only
                    when a human opens the panel.
  silent empties -- an expression that parses but matches nothing. Most of the fault
                    panels are SUPPOSED to be empty on a healthy system, which is why
                    they end in `or vector(0)`; this script is what proves the
                    fallback is actually there rather than assumed.

Grafana variables are substituted with permissive values, so a pass here means the
expression is valid for the widest selection an operator can make.

    python grafana/check-expressions.py [prometheus-url]
"""

import json
import pathlib
import re
import sys
import urllib.parse
import urllib.request

PROM = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:19090"
DASH = pathlib.Path(__file__).parent / "dashboards"

# The real values at the current cadence, not permissive stand-ins, because these two are
# the whole point of the resolution work: the datasource declares timeInterval 15s (matching
# the 15s scrape), so Grafana's $__interval on a stat is 15s and $__rate_interval is floored
# at 4x that = 60s. Substituting the OLD cadence's 1m/5m here would certify queries the
# boards no longer run -- and did, until this comment was written.
#
# grafana/chaos-probe.py substitutes the same two for the same reason; if you change one,
# change both. ($__range stays deliberately wide at 1h: it is an operator choice, not a
# cadence constant, and a wide range is the widest selection to validate against.)
#
# The _s / _ms forms MUST be listed, and resolve() MUST substitute longest-key-first. Without both,
# "$__range" is replaced inside "$__range_s" and leaves the literal "1hs", which Prometheus rejects
# with a bare HTTP 400 -- a failure that reads like a broken query rather than a broken substitution.
SUBS = {
    "$__rate_interval_ms": "60000",
    "$__rate_interval": "60s",
    "$__interval_ms": "15000",
    "$__interval": "15s",
    "$__range_s": "3600",
    "$__range": "1h",
    "$service_name": ".*",
    "$service_version": ".*",
    "$service_instance_id": ".*",
    "$processorId": ".*",
    "$processor": ".*",
    "$role": ".*",
    # skp-runtime.json predates the other four and names its variables differently --
    # $source is the process shape (webapi / worker) and $pod is the replica. Missing
    # these silently reported all 17 of its panels as empty.
    "$source": ".*",
    "$pod": ".*",
}


def resolve(expr):
    # Longest key first: every "_s" / "_ms" variable has a shorter variable as its prefix, so
    # insertion order alone is too fragile a guarantee for something that fails as a bare HTTP 400.
    for k in sorted(SUBS, key=len, reverse=True):
        expr = expr.replace(k, SUBS[k])
    return expr


def walk(panels):
    for p in panels:
        yield p
        yield from walk(p.get("panels", []))


def query(expr):
    url = f"{PROM}/api/v1/query?" + urllib.parse.urlencode({"query": expr})
    with urllib.request.urlopen(url, timeout=20) as r:
        return json.load(r)


# THE LIVENESS-COUPLING CHECK IS GONE, WITH THE ALERT RULES IT CHECKED.
#
# It asserted that the `*_over_time` windows in the skp-rules.yml block of
# k8s/02-configmaps.yaml equalled the LIVENESS constant the boards were generated from --
# the same decision expressed twice, because Prometheus cannot read a generator. There is
# no second copy any more: this project ships no alert rules and will not, because in
# production Prometheus is ORG-OWNED and its rule set is not a lever available here.
# LIVENESS now lives only in the board JSON, so there is nothing left to drift against.


def main():
    parse_errors, empties, ok = [], [], 0

    for path in sorted(DASH.glob("*.json")):
        board = json.load(path.open(encoding="utf-8"))
        print(f"\n{board['title']}  ({path.name})")

        for panel in walk(board["panels"]):
            for t in panel.get("targets", []):
                raw = t.get("expr", "")
                if not raw:
                    continue
                expr = resolve(raw)
                try:
                    res = query(expr)
                except Exception as e:                       # noqa: BLE001
                    parse_errors.append((board["title"], panel["title"], str(e)))
                    print(f"   ERROR   {panel['title']}: {e}")
                    continue

                if res.get("status") != "success":
                    msg = res.get("error", "")
                    parse_errors.append((board["title"], panel["title"], msg))
                    print(f"   ERROR   {panel['title']}: {msg}")
                elif not res["data"]["result"]:
                    empties.append((board["title"], panel["title"], raw))
                    print(f"   empty   {panel['title']}")
                else:
                    ok += 1

    print("\n" + "=" * 70)
    print(f"{ok} expressions returning data · {len(empties)} empty · "
          f"{len(parse_errors)} invalid")

    if empties:
        print("\nEmpty (must be intentional -- a fault panel with `or vector(0)` "
              "still returns a value, so anything listed here truly matches nothing):")
        for board, panel, raw in empties:
            print(f"  {board} / {panel}")
            print(f"      {raw[:150]}")

    return 1 if parse_errors else 0


if __name__ == "__main__":
    sys.exit(main())
