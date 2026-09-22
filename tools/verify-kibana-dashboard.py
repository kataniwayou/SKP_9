#!/usr/bin/env python3
"""
Executable form of section 9 of docs/superpowers/specs/2026-09-22-kibana-operator-dashboard-design.md.

Every check prints PASS or FAIL with the measured numbers beside it, and the script exits non-zero
if any check failed. Check 8 (a drill-down click) is not here: it is a UI action and is listed in
docs/testing/kibana-operator-dashboard.md as the one manual step.

RUN THIS FROM POWERSHELL against live port-forwards:
    ./k8s/port-forward-realstack.ps1
    python tools/verify-kibana-dashboard.py
"""
import argparse
import sys

import requests

DEFAULT_ES = "http://localhost:19200"
DEFAULT_KIBANA = "http://localhost:15601"
DEFAULT_API = "http://localhost:18080"
DATA_STREAM = "logs-generic.otel-default"

# The chain this dashboard is VALIDATED against, not the one it is built for (spec section 1).
VALIDATION_WORKFLOW = "filefetcher-archiveexpander-chain"


class Checks:
    """Collects results so one failure does not hide the checks after it."""

    def __init__(self):
        self.failures = 0

    def report(self, number, title, ok, detail):
        print(f"[{'PASS' if ok else 'FAIL'}] check {number}: {title} - {detail}")
        if not ok:
            self.failures += 1
        return ok


def check_1_kibana_reaches_es(checks, kibana_url):
    """Kibana is up and its Elasticsearch connection is green."""
    try:
        response = requests.get(f"{kibana_url}/api/status", timeout=15)
        body = response.json()
        overall = body["status"]["overall"]["level"]
        es_plugin = body["status"]["core"]["elasticsearch"]["level"]
    except Exception as exc:  # noqa: BLE001 - any failure here IS the check failing
        return checks.report(1, "Kibana reaches ES", False, f"{type(exc).__name__}: {exc}")
    ok = overall == "available" and es_plugin == "available"
    return checks.report(1, "Kibana reaches ES", ok,
                         f"overall={overall} elasticsearch={es_plugin}")


def check_2a_lookup_is_populated(checks, es_url, api_url):
    """The lookup index holds one row per live entity, and the policy has been executed.

    This is the precondition half of spec check 2: enrichment cannot land if the lookup is
    empty or the policy was never executed after the last sync.
    """
    try:
        counts = {}
        for kind, route in (("workflow", "workflows"), ("step", "steps"),
                            ("processor", "processors")):
            live = requests.get(f"{api_url}/api/v1/{route}", timeout=15).json()
            hit = requests.post(f"{es_url}/skp-entity-names/_count",
                                json={"query": {"term": {"entity_kind": kind}}},
                                timeout=15).json()
            counts[kind] = (len(live), hit.get("count", -1))
        policies = requests.get(f"{es_url}/_enrich/policy/skp-entity-lookup", timeout=15).json()
        enrich_indices = requests.get(
            f"{es_url}/_cat/indices/.enrich-skp-entity-lookup*?format=json", timeout=15).json()
    except Exception as exc:  # noqa: BLE001
        return checks.report("2a", "Lookup populated", False, f"{type(exc).__name__}: {exc}")

    matched = all(live == indexed for live, indexed in counts.values())
    has_policy = bool(policies.get("policies"))
    executed = len(enrich_indices) > 0
    detail = ", ".join(f"{k}: api={v[0]} index={v[1]}" for k, v in counts.items())
    detail += f", policy={has_policy}, .enrich-* indices={len(enrich_indices)}"
    return checks.report("2a", "Lookup populated", matched and has_policy and executed, detail)


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--kibana-url", default=DEFAULT_KIBANA)
    parser.add_argument("--es-url", default=DEFAULT_ES)
    parser.add_argument("--api-url", default=DEFAULT_API)
    args = parser.parse_args()

    checks = Checks()
    check_1_kibana_reaches_es(checks, args.kibana_url)
    check_2a_lookup_is_populated(checks, args.es_url, args.api_url)

    print()
    print(f"{checks.failures} check(s) failed")
    return 1 if checks.failures else 0


if __name__ == "__main__":
    sys.exit(main())
