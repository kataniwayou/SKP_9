"""Remove the retired entity-lookup plumbing from an Elasticsearch stack.

MANDATORY before the new processors log there: while the logs@custom pipeline exists, its enrich step
overwrites the names the processes set with the old name_version format. Order matters: a pipeline
that references the enrich policy blocks the policy's deletion. Every step tolerates 404, so a rerun
is safe. Run on every stack BaseApi ever booted against (dev and the offline machine).
"""
import argparse
import sys

import requests

STEPS = [
    ("pipeline", "_ingest/pipeline/logs@custom"),
    ("enrich policy", "_enrich/policy/skp-entity-lookup"),
    ("index", "skp-entity-lookup"),
]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--es-url", required=True)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    failed = 0
    for label, path in STEPS:
        url = f"{args.es_url.rstrip('/')}/{path}"
        if args.dry_run:
            print(f"would DELETE {url}")
            continue
        r = requests.delete(url, timeout=30)
        if r.status_code in (200, 404):
            print(f"{label}: {'deleted' if r.status_code == 200 else 'already absent'}")
        else:
            print(f"{label}: HTTP {r.status_code} {r.text[:200]}")
            failed += 1
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
