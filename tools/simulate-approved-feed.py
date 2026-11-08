#!/usr/bin/env python3
"""
Drives the split chain endlessly with five GOOD archives per cycle, each under a different approved
artist, so every file is a complete round trip into out/.

    file                         artist (sidecar)      outcome
    ---------------------------------------------------------------------
    ok-NNNNNN-1.zip              SKP Feed Artist 1     Completed -> out/
    ok-NNNNNN-2.zip              SKP Feed Artist 2     Completed -> out/
    ...                          ...                   ...
    ok-NNNNNN-5.zip              SKP Feed Artist 5     Completed -> out/

Every archive is simulate-endless-feed.py's role-5 file (a conforming track01.wav + track01.json
pair); only the sidecar's `artist` differs. That is the one field AcmeHandler gates against the
workflow's `chain-artists` cache, so five distinct artists exercise five distinct whitelist items.

THE CACHE ROW IS UPDATED FIRST, IN PLACE. The whitelist the normalizer reads is the L2 copy of the
cache row. `PUT /caches/{id}/items` replaces the row's items and refreshes that copy in every
running workflow that projected the cache, with no start (the full `PUT /caches/{id}` still waits
for the next start). So at startup this tool merges the five artists into the row through that
endpoint (keeping every existing item, including the `SKP Live Suite` key the live tests and
simulate-endless-feed.py rely on), and then waits until Redis holds every artist before it produces
anything. A cache whose row and L2 already hold all five is left alone. --skip-cache-setup skips the
whole step.

EVERYTHING ELSE IS simulate-endless-feed.py's: the files land on the kind node before their paths
are seeded, the folders are wiped only after the importer's lag drains, and the same rate limit
applies (5 files every 30s = 10/min, under the chain's 50/min import ceiling). The builders and
helpers are imported from that file rather than copied, so the two tools cannot drift apart.

RUN THIS FROM POWERSHELL, NOT GIT BASH (see simulate-endless-feed.py): MSYS rewrites unix-looking
absolute paths before Python sees them.

Usage:
    python tools/simulate-approved-feed.py --dry-run --cycles 1 --out-dir ./out
    python tools/simulate-approved-feed.py --cycles 1 --no-wipe
    python tools/simulate-approved-feed.py
"""

import argparse
import importlib.util
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from confluent_kafka import Producer


def _load_base():
    """simulate-endless-feed.py, loaded by path: its hyphenated name is not importable."""
    path = Path(__file__).with_name("simulate-endless-feed.py")
    spec = importlib.util.spec_from_file_location("simulate_endless_feed", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


base = _load_base()
say = base.say

DEFAULT_BASEAPI = "http://localhost:18080"
DEFAULT_WORKFLOW_ID = "1a56b3ca-e276-4815-87fa-5c2f48ab6dad"  # filefetcher-archiveexpander-chain
DEFAULT_CACHE_ROOT = "chain-artists"
DEFAULT_REDIS_POD = "redis-0"
DEFAULT_NAMESPACE = "skp"

FILES_PER_CYCLE = 5


def artists(count):
    """The approved artists, one per file position. Key = what the sidecar carries; value = the
    spelling the standardized XML publishes."""
    return {f"SKP Feed Artist {i}": f"SKP Feed Artist {i} (Approved)" for i in range(1, count + 1)}


def build_cycle(serial, artist_names):
    """One cycle: a good archive per artist, numbered by position so a file's artist is readable
    from its name."""
    return [
        (f"ok-{serial:06d}-{i}.zip", base.build_pair_archive(serial, artist))
        for i, artist in enumerate(artist_names, start=1)
    ]


# ── cache setup ─────────────────────────────────────────────────────────────────────────────────

def http_json(method, url, body=None):
    data = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(url, data=data, method=method,
                                     headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=20) as response:
        text = response.read().decode("utf-8")
        return response.status, (json.loads(text) if text else None)


def find_workflow_cache(baseapi, workflow_id, root):
    """The cache row with `root` that the workflow is bound to."""
    _, workflow = http_json("GET", f"{baseapi}/api/v1/workflows/{workflow_id}")
    bound = set(workflow.get("cacheIds") or [])
    _, caches = http_json("GET", f"{baseapi}/api/v1/caches")
    for cache in caches:
        if cache["id"] in bound and cache["root"] == root:
            return cache
    raise SystemExit(f"workflow {workflow_id} is not bound to a cache with root '{root}'")


def redis_has_all(namespace, pod, workflow_id, root, keys):
    """True when L2 holds an entry for every key -- i.e. a start has aligned the new items."""
    for key in keys:
        result = subprocess.run(
            ["kubectl", "-n", namespace, "exec", pod, "--", "redis-cli", "EXISTS",
             f"skp:wf:{workflow_id}:cache:{root}:{key}"],
            capture_output=True, text=True,
        )
        if result.returncode != 0 or result.stdout.strip() != "1":
            return False
    return True


def ensure_cache(args, wanted):
    """Merges `wanted` into the cache row through the items endpoint and waits for L2 to hold every
    key. The running chain is refreshed in place; nothing is stopped or started."""
    cache = find_workflow_cache(args.baseapi, args.workflow_id, args.cache_root)
    items = json.loads(cache["items"] or "{}")

    missing = {k: v for k, v in wanted.items() if items.get(k) != v}
    if missing or not redis_has_all(args.namespace, args.redis_pod, args.workflow_id,
                                    args.cache_root, wanted):
        # Sent even when the row already holds every artist: the same items again re-align L2 with
        # the row, for a chain started before the row had them.
        items.update(missing)
        http_json("PUT", f"{args.baseapi}/api/v1/caches/{cache['id']}/items", {"items": items})
        say(f"cache '{cache['name']}': added {len(missing)} item(s); now {len(items)}")

        deadline = time.time() + 60
        while not redis_has_all(args.namespace, args.redis_pod, args.workflow_id,
                                args.cache_root, wanted):
            if time.time() > deadline:
                raise SystemExit("L2 does not hold every artist 60s after the items edit -- is the "
                                 "chain running, and was the cache bound to it when it was started?")
            time.sleep(1)
    else:
        say(f"cache '{cache['name']}' already holds all {len(wanted)} artists")

    say(f"L2 holds all {len(wanted)} artists under {args.cache_root}")


# ── main ────────────────────────────────────────────────────────────────────────────────────────

def run_dry(args, artist_names):
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    serial = args.start_serial
    for _ in range(args.cycles or 1):
        for name, payload in build_cycle(serial, artist_names):
            (out / name).write_bytes(payload)
            print(f"{out / name}  ->  {args.node_in_dir}/{name}  ({len(payload)} bytes)")
        serial += 1
    return 0


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--brokers", default=base.DEFAULT_BROKERS)
    parser.add_argument("--topic", default=base.DEFAULT_TOPIC)
    parser.add_argument("--group", default=base.DEFAULT_GROUP,
                        help="the importer's consumer group; its lag is what the wipe waits on")
    parser.add_argument("--node", default=base.DEFAULT_NODE, help="the kind node container")
    parser.add_argument("--node-in-dir", default=base.DEFAULT_IN_DIR)
    parser.add_argument("--node-out-dir", default=base.DEFAULT_OUT_DIR)
    parser.add_argument("--interval", type=float, default=30.0,
                        help="seconds between cycles (default 30; 5 files a cycle = 10/min)")
    parser.add_argument("--cycles", type=int, default=0, help="0 means endless")
    parser.add_argument("--max-files", type=int, default=50,
                        help="wipe both folders once the in folder holds this many")
    parser.add_argument("--settle", type=float, default=10.0,
                        help="seconds to wait after lag hits 0 before wiping")
    parser.add_argument("--drain-timeout", type=float, default=120.0,
                        help="how often to warn while waiting for the lag to drain")
    parser.add_argument("--force-wipe", action="store_true",
                        help="wipe after --drain-timeout even if the lag has not drained")
    parser.add_argument("--no-wipe", action="store_true", help="never wipe; let the folders grow")
    parser.add_argument("--start-serial", type=int, default=1,
                        help="first serial, so a restarted run does not reuse filenames")
    parser.add_argument("--baseapi", default=DEFAULT_BASEAPI)
    parser.add_argument("--workflow-id", default=DEFAULT_WORKFLOW_ID)
    parser.add_argument("--cache-root", default=DEFAULT_CACHE_ROOT)
    parser.add_argument("--namespace", default=DEFAULT_NAMESPACE)
    parser.add_argument("--redis-pod", default=DEFAULT_REDIS_POD)
    parser.add_argument("--skip-cache-setup", action="store_true",
                        help="do not touch the cache row")
    parser.add_argument("--dry-run", action="store_true",
                        help="write the files locally and seed nothing")
    parser.add_argument("--out-dir", default="./out", help="where --dry-run writes")
    args = parser.parse_args()

    if args.interval <= 0:
        raise SystemExit("--interval must be positive")
    if args.max_files < FILES_PER_CYCLE:
        raise SystemExit(f"--max-files must be at least one cycle's worth of files ({FILES_PER_CYCLE})")

    wanted = artists(FILES_PER_CYCLE)
    artist_names = list(wanted)

    if args.dry_run:
        return run_dry(args, artist_names)

    if not args.skip_cache_setup:
        ensure_cache(args, wanted)

    producer = Producer({"bootstrap.servers": args.brokers})

    serial = args.start_serial
    produced = 0
    wipes = 0
    say(
        f"seeding {args.topic} at {args.brokers}; files to {args.node}:{args.node_in_dir}; "
        f"{FILES_PER_CYCLE} good files every {args.interval}s; wipe at {args.max_files}"
    )

    try:
        while args.cycles == 0 or serial - args.start_serial < args.cycles:
            files = build_cycle(serial, artist_names)

            # The file lands first; a record whose file is not there fails the fetch.
            base.push_files(args.node, args.node_in_dir, files)

            paths = [f"{args.node_in_dir}/{name}" for name, _ in files]
            failures = base.produce(producer, args.topic, paths)
            for failure in failures:
                print(f"FAILED: {failure}", file=sys.stderr)

            seeded = len(paths) - len(failures)
            produced += seeded
            say(f"cycle {serial:06d}: {len(files)} files on the node, {seeded} records seeded")

            if not args.no_wipe:
                held = base.count_files(args.node, args.node_in_dir)
                if held >= args.max_files:
                    say(f"in folder holds {held} (>= {args.max_files}); waiting for the importer")
                    base.wait_for_drain(
                        args.brokers, args.topic, args.group,
                        args.settle, args.drain_timeout, args.force_wipe,
                    )
                    base.wipe(args.node, args.node_in_dir, args.node_out_dir)
                    wipes += 1
                    say(f"wiped {args.node_in_dir} and {args.node_out_dir} (wipe #{wipes})")

            serial += 1
            time.sleep(args.interval)
    except KeyboardInterrupt:
        say("interrupted")
    finally:
        producer.flush(timeout=10)
        cycles_run = serial - args.start_serial
        say(f"produced {produced} record(s) over {cycles_run} cycle(s), {wipes} wipe(s)")
        say(f"next run: --start-serial {serial}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
