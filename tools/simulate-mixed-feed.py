#!/usr/bin/env python3
"""
simulate-approved-feed.py with a MIXED cycle: --listed archives whose artist is on the workflow's
whitelist and --unlisted archives whose artist is not (default 28 + 14 = 42 per cycle, 126 a minute:
above the approved feed's 90, under the importer's ceiling of 150). It exercises both Acme outcome verdicts on every cycle:

    file                         artist (sidecar)          outcome / verdict
    ---------------------------------------------------------------------------------
    ok-NNNNNN-01.zip             SKP Feed Artist 1         Completed / Listed   -> out/
    ...                          (round-robin over 5)      ...
    ok-NNNNNN-28.zip             SKP Feed Artist 5         Completed / Listed   -> out/
    no-NNNNNN-01.zip             Unapproved Sim Artist     Cancelled / Unlisted
    ...                          ...                       ...
    no-NNNNNN-14.zip             Unapproved Sim Artist     Cancelled / Unlisted

The listed artists are appended to the `chain-artists` cache first, exactly as the approved feed
does; the unlisted artist is never added. Everything else -- landing the files, seeding the
records -- is simulate-approved-feed.py's, imported from it. Cleanup is NOT: by default the stream
never pauses and files older than --keep-minutes are pruned each cycle (--keep-minutes 0 brings back
the approved feed's drain-then-wipe at --max-files).

RUN THIS FROM POWERSHELL, NOT GIT BASH: MSYS rewrites unix-looking absolute paths.

Usage:
    python tools/simulate-mixed-feed.py --dry-run --cycles 1 --out-dir ./out
    python tools/simulate-mixed-feed.py --listed 25 --unlisted 5
    python tools/simulate-mixed-feed.py
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
DEFAULT_WORKFLOW_ID = "8cfdbcdb-a7e0-4a7d-9b4d-e4120ccacf02"  # filefetcher-archiveexpander-chain
DEFAULT_CACHE_ROOT = "chain-artists"
DEFAULT_REDIS_POD = "redis-0"
DEFAULT_NAMESPACE = "skp"

ARTIST_COUNT = 5
FILES_PER_CYCLE = 42


def artists(count):
    """The approved artists. Key = what the sidecar carries; value = the spelling the standardized
    XML publishes."""
    return {f"SKP Feed Artist {i}": f"SKP Feed Artist {i} (Approved)" for i in range(1, count + 1)}


# 42 a cycle = 126 a minute (2026-11-28): more than the approved feed's 90 a minute, so a per-message
# leak shows on the heap panels sooner, and under the chain's IMPORT CEILING of 150 a minute (the
# split-importer runs 6 dispatches a minute and reads 25 records each). Above the ceiling the
# continuous stream cannot be continuous: 90 a cycle grew the lag by 120 records a minute, and a
# backlog older than --keep-minutes would be pruned before it is fetched. Raise the ceiling (the
# importer step's batch or schedule) before raising these. --listed 20 --unlisted 10 is the old rate.
LISTED = 28
UNLISTED = 14


def build_cycle(serial, artist_names):
    """One cycle: LISTED approved archives (artists round-robin) then UNLISTED unapproved ones."""
    listed = [
        (f"ok-{serial:06d}-{i:02d}.zip",
         base.build_pair_archive(serial, artist_names[(i - 1) % len(artist_names)]))
        for i in range(1, LISTED + 1)
    ]
    unlisted = [
        (f"no-{serial:06d}-{i:02d}.zip", base.build_pair_archive(serial, base.UNAPPROVED_ARTIST))
        for i in range(1, UNLISTED + 1)
    ]
    return listed + unlisted


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
    """Appends `wanted` to the cache row through the items endpoint and waits for L2 to hold every
    key. The running chain is refreshed in place; nothing is stopped or started.

    Append (POST /caches/{id}/items) adds or overwrites only the sent keys and leaves every other
    item alone; it is idempotent, so sending the same pairs again re-aligns L2 with the row for a
    chain started before the row had them. (GET /caches no longer carries items, so nothing is
    read back first; a replace (PUT .../items) here would drop the cache's other items.)"""
    cache = find_workflow_cache(args.baseapi, args.workflow_id, args.cache_root)

    # Sent on every run: idempotent, and it re-aligns L2 values too (redis_has_all checks keys only).
    _, report = http_json("POST", f"{args.baseapi}/api/v1/caches/{cache['id']}/items",
                          {"items": [{"key": k, "value": v} for k, v in wanted.items()]})
    report = report or {}
    say(f"cache '{cache['name']}': appended {len(wanted)} item(s) "
        f"(added {report.get('added', '?')}, overwritten {report.get('overwritten', '?')})")

    deadline = time.time() + 60
    while not redis_has_all(args.namespace, args.redis_pod, args.workflow_id,
                            args.cache_root, wanted):
        if time.time() > deadline:
            raise SystemExit("L2 does not hold every artist 60s after the append -- is the "
                             "chain running, and was the cache bound to it when it was started?")
        time.sleep(1)

    say(f"L2 holds all {len(wanted)} artists under {args.cache_root}")


def prune(node, in_dir, out_dir, keep_minutes):
    """Deletes files older than `keep_minutes` from both folders and returns how many went.

    THE ROLLING ALTERNATIVE TO THE WIPE (2026-11-28). The wipe pauses the stream: it waits for the
    importer's lag to reach 0, settles, then empties both folders, so the heap and outcome panels see
    a gap every --max-files. Pruning by age keeps every cycle on time. It is safe as long as a file is
    imported and finished within `keep_minutes`; the cycle line prints the importer's lag so a backlog
    that would outrun it is visible. -mmin is whole minutes, by the node's clock."""
    result = base.node_exec(node, ["sh", "-c",
        f"find {in_dir} {out_dir} -maxdepth 1 -type f -mmin +{keep_minutes} -print -delete 2>/dev/null | wc -l"],
        check=False)
    return int(result.stdout.decode().strip() or "0")


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
    global LISTED, UNLISTED, FILES_PER_CYCLE
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
    parser.add_argument("--interval", type=float, default=20.0,
                        help="seconds between cycles (default 20; 42 files a cycle = 126/min)")
    parser.add_argument("--cycles", type=int, default=0, help="0 means endless")
    parser.add_argument("--keep-minutes", type=int, default=15,
                        help="the continuous stream (default): every cycle, delete files older than "
                             "this from both folders, never pausing. 0 = the old drain-then-wipe at "
                             "--max-files instead")
    parser.add_argument("--max-files", type=int, default=540,
                        help="with --keep-minutes 0 only: wipe both folders once the in folder holds this many")
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
    parser.add_argument("--listed", type=int, default=LISTED,
                        help="files per cycle with an approved artist (Completed / Listed)")
    parser.add_argument("--unlisted", type=int, default=UNLISTED,
                        help="files per cycle with an unapproved artist (Cancelled / Unlisted)")
    args = parser.parse_args()

    if args.listed < 0 or args.unlisted < 0 or args.listed + args.unlisted == 0:
        raise SystemExit("--listed and --unlisted must be >= 0 and not both 0")
    LISTED, UNLISTED = args.listed, args.unlisted
    FILES_PER_CYCLE = LISTED + UNLISTED

    if args.interval <= 0:
        raise SystemExit("--interval must be positive")
    if args.keep_minutes < 0:
        raise SystemExit("--keep-minutes must be >= 0")
    if args.keep_minutes == 0 and args.max_files < FILES_PER_CYCLE:
        raise SystemExit(f"--max-files must be at least one cycle's worth of files ({FILES_PER_CYCLE})")

    wanted = artists(ARTIST_COUNT)
    artist_names = list(wanted)

    if args.dry_run:
        return run_dry(args, artist_names)

    if not args.skip_cache_setup:
        ensure_cache(args, wanted)

    producer = Producer({"bootstrap.servers": args.brokers})

    serial = args.start_serial
    produced = 0
    wipes = 0
    pruned = 0
    if args.no_wipe:
        cleanup = "never cleaned"
    elif args.keep_minutes:
        cleanup = f"continuous: files older than {args.keep_minutes} min pruned every cycle"
    else:
        cleanup = f"drain-then-wipe at {args.max_files}"
    say(
        f"seeding {args.topic} at {args.brokers}; files to {args.node}:{args.node_in_dir}; "
        f"{LISTED} listed + {UNLISTED} unlisted files every {args.interval}s; {cleanup}"
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
            if args.keep_minutes and not args.no_wipe:
                gone = prune(args.node, args.node_in_dir, args.node_out_dir, args.keep_minutes)
                pruned += gone
                try:
                    lag = base.consumer_lag(args.brokers, args.topic, args.group)
                except Exception as exc:   # a probe failure must not stop the stream
                    lag = f"? ({type(exc).__name__})"
                say(f"cycle {serial:06d}: {len(files)} files on the node, {seeded} records seeded; "
                    f"importer lag {lag}; pruned {gone}")
            else:
                say(f"cycle {serial:06d}: {len(files)} files on the node, {seeded} records seeded")

            if not args.no_wipe and not args.keep_minutes:
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
        say(f"produced {produced} record(s) over {cycles_run} cycle(s), {wipes} wipe(s), {pruned} file(s) pruned")
        say(f"next run: --start-serial {serial}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
