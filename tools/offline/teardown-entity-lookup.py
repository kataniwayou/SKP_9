"""Remove the retired entity-lookup plumbing from an Elasticsearch stack.

MANDATORY before the orchestrator and processors are deployed: while the logs@custom pipeline
exists, its enrich step overwrites the names the processes set with the old name_version format.
Run this ONLY after the new BaseApi has already replaced the old one on this stack -- the old
BaseApi still executes the enrich policy on every start (a teardown run against it refuses every
start) and its provisioning re-creates logs@custom if the old pod restarts. Order matters: a
pipeline that references the enrich policy blocks the policy's deletion. Every step tolerates 404,
so a rerun -- including the no-op check after rollout -- is safe. Run on every stack BaseApi ever
booted against (dev and the offline machine).

Uses only the standard library (urllib): the offline machine has no guaranteed `requests` install.
"""
import argparse
import sys
import urllib.error
import urllib.request

PIPELINE_PATH = "_ingest/pipeline/logs@custom"
POLICY_PATH = "_enrich/policy/skp-entity-lookup"
INDEX_PATH = "skp-entity-lookup"
OWNER_MARKER = "skp-entity-lookup"


def _delete(url):
    """DELETE url. Returns (status_code, body_text). A 404 reads as "already absent", never a failure."""
    req = urllib.request.Request(url, method="DELETE")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return 404, ""
        return e.code, e.read().decode("utf-8", "replace")


def _get(url):
    """GET url. Returns (status_code, body_text). A 404 reads as "not found", never a failure."""
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return 404, ""
        return e.code, e.read().decode("utf-8", "replace")


def _owns_pipeline(body_text):
    """True when the pipeline body references skp-entity-lookup somewhere in its definition."""
    return OWNER_MARKER in body_text


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--es-url", required=True)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    base = args.es_url.rstrip("/")
    failed = 0

    # Pipeline first: it references the enrich policy, so it must go before the policy can be
    # deleted. But logs@custom is a single cluster-wide slot shared with every other team that ships
    # logs through the stock `logs` template -- delete it only if it still references OUR policy.
    pipeline_url = f"{base}/{PIPELINE_PATH}"
    if args.dry_run:
        print(f"would GET {pipeline_url}, then DELETE it only if it references {OWNER_MARKER}")
    else:
        status, body = _get(pipeline_url)
        if status == 404:
            print("pipeline: already absent")
        elif status != 200:
            print(f"pipeline: HTTP {status} {body[:200]}")
            failed += 1
        elif not _owns_pipeline(body):
            print(f"pipeline: logs@custom exists but does not reference {OWNER_MARKER} -- belongs "
                  "to someone else, skipping")
        else:
            status, body = _delete(pipeline_url)
            if status in (200, 404):
                print(f"pipeline: {'deleted' if status == 200 else 'already absent'}")
            else:
                print(f"pipeline: HTTP {status} {body[:200]}")
                failed += 1

    for label, path in (("enrich policy", POLICY_PATH), ("index", INDEX_PATH)):
        url = f"{base}/{path}"
        if args.dry_run:
            print(f"would DELETE {url}")
            continue
        status, body = _delete(url)
        if status in (200, 404):
            print(f"{label}: {'deleted' if status == 200 else 'already absent'}")
        else:
            print(f"{label}: HTTP {status} {body[:200]}")
            failed += 1

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
