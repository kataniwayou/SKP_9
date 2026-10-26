#!/usr/bin/env python3
"""
Drives the object chain (objectfetcher-archiveexpander-chain) with simulate-endless-feed.py's five
roles per cycle, the kind node replaced by the skp-minio container.

    role      object                              trips                                  outcome
    ---------------------------------------------------------------------------------------------
    badext    s3://skp-in/sim/sim-NNNNNN-badext.dat   ObjectFetcher allowedExtensions        Failed (fetch)
    corrupt   s3://skp-in/sim/sim-NNNNNN-corrupt.zip  ArchiveExpander signature cross-check  Failed (expand)
    triple    s3://skp-in/sim/sim-NNNNNN-triple.zip   AcmeHandler.ValidateContent            Failed (normalize)
    artist    s3://skp-in/sim/sim-NNNNNN-artist.zip   AcmeHandler.Augment artist gate        CANCELLED
    good      s3://skp-in/sim/sim-NNNNNN-good.zip     nothing                                Completed -> skp-out

EVERYTHING BUT THE STORAGE IS simulate-endless-feed.py's, imported by path as
simulate-approved-feed.py does: the same builders, the same lag-gated wipe, the same rate (5 objects
every 30s, under the chain's 50/min import ceiling), the same lineage header. Read that file's
docstring for why each role is built the way it is; none of it changes here.

THE OBJECTS LAND BEFORE THEIR LOCATIONS ARE SEEDED. One `docker exec skp-minio` per cycle unpacks
the cycle's tar into a scratch folder inside the container and `mc cp`s it into skp-in under
--prefix, through the container's root `local` alias (tools/minio-dev.ps1 sets it). A record whose
object is not there yet fails the fetch as `it does not exist`, which is no role's outcome.

THE WIPE EMPTIES BOTH BUCKETS, not just the prefix: skp-out holds only what this chain persisted.
It waits on the importer's lag on skp-objectchain exactly as the base tool waits on skp-splitchain.

The default topic and group are the copy's own (tools/copy-object-chain.py), never the original
chain's, so running this beside simulate-endless-feed.py feeds each chain only its own records.

RUN THIS FROM POWERSHELL, NOT GIT BASH, for the base tool's reason.

Usage:
    python tools/simulate-object-feed.py --dry-run --cycles 1 --out-dir ./out
    python tools/simulate-object-feed.py --cycles 4 --no-wipe --start-serial 1
    python tools/simulate-object-feed.py
"""

import argparse
import importlib.util
import subprocess
import sys
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

DEFAULT_TOPIC = "skp-object-paths"
DEFAULT_GROUP = "skp-objectchain"
DEFAULT_CONTAINER = "skp-minio"
DEFAULT_PREFIX = "sim/"
IN_BUCKET, OUT_BUCKET = "skp-in", "skp-out"


def minio_exec(container, script, stdin=None):
    """One `sh -c` inside the MinIO container. Returns stdout as text."""
    result = subprocess.run(["docker", "exec", "-i", container, "sh", "-c", script],
                            input=stdin, capture_output=True)
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", "replace").strip()
        raise RuntimeError(f"docker exec {container} sh -c '{script}' failed ({result.returncode}): {detail}")
    return result.stdout.decode("utf-8", "replace")


def push_objects(container, prefix, files):
    """Puts a cycle's objects into skp-in in one call."""
    minio_exec(container,
               "rm -rf /tmp/feed && mkdir /tmp/feed && tar -xf - -C /tmp/feed && "
               f"mc cp --quiet --recursive /tmp/feed/ local/{IN_BUCKET}/{prefix} && rm -rf /tmp/feed",
               stdin=base.tar_stream(files))


def count_objects(container):
    """How many objects skp-in holds; one `mc ls` line per object."""
    out = minio_exec(container, f"mc ls --recursive local/{IN_BUCKET}")
    return sum(1 for line in out.splitlines() if line.strip())


def wipe(container):
    minio_exec(container, f"mc rm --recursive --force local/{IN_BUCKET} local/{OUT_BUCKET}")


def location(prefix, name):
    return f"s3://{IN_BUCKET}/{prefix}{name}"


def run_dry(args):
    """Writes the cycles' files locally and prints the locations that WOULD be seeded."""
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    serial = args.start_serial
    for _ in range(args.cycles or 1):
        for name, payload in base.build_cycle(serial, args.approved_artist):
            (out / name).write_bytes(payload)
            print(f"{out / name}  ->  {location(args.prefix, name)}  ({len(payload)} bytes)")
        serial += 1
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--brokers", default=base.DEFAULT_BROKERS)
    parser.add_argument("--topic", default=DEFAULT_TOPIC)
    parser.add_argument("--group", default=DEFAULT_GROUP,
                        help="the importer's consumer group; its lag is what the wipe waits on")
    parser.add_argument("--container", default=DEFAULT_CONTAINER, help="the MinIO container")
    parser.add_argument("--prefix", default=DEFAULT_PREFIX, help="key prefix inside skp-in")
    parser.add_argument("--interval", type=float, default=30.0,
                        help="seconds between cycles (default 30; 5 objects a cycle = 10/min)")
    parser.add_argument("--cycles", type=int, default=0, help="0 means endless")
    parser.add_argument("--max-files", type=int, default=50,
                        help="wipe both buckets once skp-in holds this many objects")
    parser.add_argument("--settle", type=float, default=10.0,
                        help="seconds to wait after lag hits 0 before wiping")
    parser.add_argument("--drain-timeout", type=float, default=120.0,
                        help="how often to warn while waiting for the lag to drain")
    parser.add_argument("--force-wipe", action="store_true",
                        help="wipe after --drain-timeout even if the lag has not drained")
    parser.add_argument("--no-wipe", action="store_true", help="never wipe; let the buckets grow")
    parser.add_argument("--approved-artist", default=base.DEFAULT_APPROVED_ARTIST,
                        help="an artist the live chain-artists cache holds, for role 5")
    parser.add_argument("--start-serial", type=int, default=1,
                        help="first serial, so a restarted run does not reuse object names")
    parser.add_argument("--dry-run", action="store_true", help="write the files locally and seed nothing")
    parser.add_argument("--out-dir", default="./out", help="where --dry-run writes")
    args = parser.parse_args()

    if args.interval <= 0:
        raise SystemExit("--interval must be positive")
    if args.prefix and not args.prefix.endswith("/"):
        args.prefix += "/"

    per_cycle = len(base.roles_for(args.approved_artist))
    if args.max_files < per_cycle:
        raise SystemExit(f"--max-files must be at least one cycle's worth of files ({per_cycle})")

    if args.dry_run:
        return run_dry(args)

    producer = Producer({"bootstrap.servers": args.brokers})
    serial = args.start_serial
    produced = wipes = 0
    say(f"seeding {args.topic} at {args.brokers}; objects to {args.container}:{IN_BUCKET}/{args.prefix}; "
        f"{per_cycle} objects every {args.interval}s; wipe at {args.max_files}; "
        f"approved artist '{args.approved_artist}'")

    try:
        while args.cycles == 0 or serial - args.start_serial < args.cycles:
            files = base.build_cycle(serial, args.approved_artist)
            push_objects(args.container, args.prefix, files)

            failures = base.produce(producer, args.topic, [location(args.prefix, name) for name, _ in files])
            for failure in failures:
                print(f"FAILED: {failure}", file=sys.stderr)
            seeded = len(files) - len(failures)
            produced += seeded
            say(f"cycle {serial:06d}: {len(files)} objects in {IN_BUCKET}, {seeded} records seeded")

            if not args.no_wipe:
                held = count_objects(args.container)
                if held >= args.max_files:
                    say(f"{IN_BUCKET} holds {held} (>= {args.max_files}); waiting for the importer")
                    base.wait_for_drain(args.brokers, args.topic, args.group,
                                        args.settle, args.drain_timeout, args.force_wipe)
                    wipe(args.container)
                    wipes += 1
                    say(f"wiped {IN_BUCKET} and {OUT_BUCKET} (wipe #{wipes})")

            serial += 1
            if args.cycles == 0 or serial - args.start_serial < args.cycles:
                base.time.sleep(args.interval)
    except KeyboardInterrupt:
        say("interrupted")
    finally:
        producer.flush(timeout=10)
        say(f"produced {produced} record(s) over {serial - args.start_serial} cycle(s), {wipes} wipe(s)")
        say(f"next run: --start-serial {serial}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
