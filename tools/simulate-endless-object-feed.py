#!/usr/bin/env python3
"""
Drives the object chain (objectfetcher-archiveexpander-chain) endlessly with simulate-endless-feed.py's
five roles per cycle, the kind node replaced by the skp-minio container -- and CONFIRMS every role's
outcome as it goes, instead of leaving the run to be read by hand afterwards.

    role      object                                  trips                                  outcome
    -----------------------------------------------------------------------------------------------
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

WHAT "CONFIRMED" MEANS, ROLE BY ROLE. Each role is confirmed by the one piece of evidence only its
expected outcome can leave, read from the pods' own logs (kubectl), skp-out (mc) and
skp-object-documents (a consumer that never joins a group):

    badext    ObjectFetcher: object s3://…-badext.dat rejected: extension '.dat' is not in the allowed list (.zip)
    corrupt   ArchiveExpander: extracting …-corrupt.zip failed: … treating it as corrupt …
    triple    SKNormalizer: normalizing …-triple.zip failed: item 'track01': an Acme item is exactly …
    artist    ArchiveExpander expanded it, nothing failed naming it, and it is NOT in skp-out once the
              same cycle's good file is -- the cancel line names an artist, never a file, so the
              cancel is confirmed by what did not happen after the cycle is known to have flowed
    good      sim-NNNNNN-good.zip in skp-out AND s3://skp-out/sim-NNNNNN-good.zip on skp-object-documents

and any failure line naming a file in the WRONG stage fails that role at once, with the line. A role
with no evidence after --confirm-timeout seconds fails as "no evidence". skp-object-failures carries
no file name (see the base tool), so it is checked in aggregate: three records per confirmed cycle.
The summary line at the end counts both, and the exit code is 1 if anything failed.

THE WIPE WAITS FOR THE CONFIRMATION, not only for the lag: a good file wiped from skp-out before it
was seen there would fail for this tool's own reason. The wipe empties both buckets, not just the
prefix: skp-out holds only what this chain persisted.

The default topic and group are the copy's own (tools/copy-object-chain.py), never the original
chain's, so running this beside simulate-endless-feed.py feeds each chain only its own records.

RUN THIS FROM POWERSHELL, NOT GIT BASH, for the base tool's reason.

Usage:
    python tools/simulate-endless-object-feed.py --dry-run --cycles 1 --out-dir ./out
    python tools/simulate-endless-object-feed.py --cycles 4 --start-serial 10
    python tools/simulate-endless-object-feed.py
"""

import argparse
import importlib.util
import json
import subprocess
import sys
import time
from pathlib import Path

from confluent_kafka import Consumer, Producer, TopicPartition


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
DEFAULT_DOCUMENTS_TOPIC = "skp-object-documents"
DEFAULT_FAILURES_TOPIC = "skp-object-failures"
DEFAULT_CONTAINER = "skp-minio"
DEFAULT_PREFIX = "sim/"
DEFAULT_NAMESPACE = "skp"
IN_BUCKET, OUT_BUCKET = "skp-in", "skp-out"
FAILURES_PER_CYCLE = 3  # badext, corrupt, triple; a cancel reaches no failure record

FETCHER, EXPANDER, NORMALIZER = "processor-objectfetcher", "processor-archiveexpander", "processor-sknormalizer"


# ── storage ─────────────────────────────────────────────────────────────────────────────────────

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


def list_objects(container, bucket):
    """Every key in the bucket. `--json` so a key with a space in it is one key."""
    out = minio_exec(container, f"mc ls --recursive --json local/{bucket}")
    return {json.loads(line)["key"] for line in out.splitlines() if line.strip()}


def wipe(container):
    minio_exec(container, f"mc rm --recursive --force local/{IN_BUCKET} local/{OUT_BUCKET}")


def location(prefix, name):
    return f"s3://{IN_BUCKET}/{prefix}{name}"


# ── evidence ────────────────────────────────────────────────────────────────────────────────────

def pod_log(namespace, app, since_seconds):
    """Every replica's log for the window. --tail=-1 because a label selector defaults to 10 lines,
    and --max-log-requests past its default because SKNormalizer runs more than one replica."""
    result = subprocess.run(
        ["kubectl", "-n", namespace, "logs", "-l", f"app={app}", "--tail=-1",
         f"--since={int(since_seconds)}s", "--max-log-requests=10"],
        capture_output=True, text=True, encoding="utf-8", errors="replace")
    if result.returncode != 0:
        raise RuntimeError(f"kubectl logs -l app={app} failed: {result.stderr.strip()}")
    return result.stdout


class TopicTail:
    """Reads a topic from the offsets it had when the run started, without ever joining a group --
    assign() and an explicit offset, like the base tool's lag probe, so the exporter's own consumers
    and the importer are never rebalanced by this tool."""

    def __init__(self, brokers, topic):
        self.consumer = Consumer({"bootstrap.servers": brokers, "group.id": "unused-never-joined",
                                  "enable.auto.commit": False})
        metadata = self.consumer.list_topics(topic, timeout=10)
        if topic not in metadata.topics or metadata.topics[topic].error is not None:
            raise RuntimeError(f"topic {topic} is not readable on {brokers}")
        partitions = []
        for p in metadata.topics[topic].partitions:
            _, high = self.consumer.get_watermark_offsets(TopicPartition(topic, p), timeout=10)
            partitions.append(TopicPartition(topic, p, high))
        self.consumer.assign(partitions)
        self.values = []

    def drain(self):
        while True:
            message = self.consumer.poll(1.0)
            if message is None:
                return self.values
            if message.error() is None:
                self.values.append(message.value().decode("utf-8", "replace"))

    def close(self):
        self.consumer.close()


def expectations(prefix, name, role):
    """(the line that confirms the role, the lines that would mean it failed in the wrong place)."""
    loc = location(prefix, name)
    wrong = [f"reading {loc} failed", f"object {loc} rejected", f"extracting {name} failed",
             f"normalizing {name} failed", f"writing s3://{OUT_BUCKET}/{name} failed"]
    expected = {
        "badext": (FETCHER, f"object {loc} rejected: extension '.dat' is not in the allowed list (.zip)"),
        "corrupt": (EXPANDER, f"extracting {name} failed: the file is named '.zip' and its leading bytes are no archive"),
        "triple": (NORMALIZER, f"normalizing {name} failed: item 'track01': an Acme item is exactly the .wav and the .json"),
        "artist": (None, None),
        "good": (None, None),
    }[role]
    if expected[1]:
        wrong = [w for w in wrong if not expected[1].startswith(w)]
    return expected, wrong


class Confirmer:
    """Tracks every seeded cycle until each of its five roles is confirmed or has failed."""

    def __init__(self, args):
        self.args = args
        self.pending = {}  # serial -> {"seeded": t, "files": [(role, name)], "verdict": {role: None|"ok"|reason}}
        self.documents = TopicTail(args.brokers, args.documents_topic)
        self.failures = TopicTail(args.brokers, args.failures_topic)
        self.confirmed_cycles = 0
        self.failed_roles = []

    def add(self, serial, files):
        roles = [role for role, _, _ in base.roles_for(self.args.approved_artist)]
        self.pending[serial] = {"seeded": time.time(), "files": list(zip(roles, [n for n, _ in files])),
                                "verdict": {role: None for role in roles}}

    def check(self):
        """One pass over every pending cycle. Returns True when nothing is pending."""
        if not self.pending:
            return True
        window = time.time() - min(c["seeded"] for c in self.pending.values()) + 120
        logs = {app: pod_log(self.args.namespace, app, window) for app in (FETCHER, EXPANDER, NORMALIZER)}
        everything = "\n".join(logs.values())
        out = list_objects(self.args.container, OUT_BUCKET)
        documents = {json.loads(v).get("location") for v in self.documents.drain() if v.startswith("{")}

        for serial in sorted(self.pending):
            cycle = self.pending[serial]
            verdict = cycle["verdict"]
            good_name = next(n for r, n in cycle["files"] if r == "good")
            for role, name in cycle["files"]:
                if verdict[role] is not None:
                    continue
                (app, line), wrong = expectations(self.args.prefix, name, role)
                misplaced = next((w for w in wrong if w in everything), None)
                if misplaced:
                    verdict[role] = f"failed in the wrong place: '{misplaced}…'"
                elif role == "good":
                    if name in out and f"s3://{OUT_BUCKET}/{name}" in documents:
                        verdict[role] = "ok"
                elif role == "artist":
                    if f"expanded {name} " in logs[EXPANDER] and verdict.get("good") == "ok":
                        verdict[role] = "ok" if name not in out else "persisted, but its artist is not approved"
                elif line in logs[app]:
                    verdict[role] = "ok"

            timed_out = time.time() - cycle["seeded"] > self.args.confirm_timeout
            if timed_out:
                for role in verdict:
                    if verdict[role] is None:
                        verdict[role] = f"no evidence within {self.args.confirm_timeout}s"
            if all(v is not None for v in verdict.values()):
                self.report(serial, cycle)
                del self.pending[serial]
        return not self.pending

    def report(self, serial, cycle):
        bad = {r: v for r, v in cycle["verdict"].items() if v != "ok"}
        self.confirmed_cycles += 1
        if not bad:
            say(f"cycle {serial:06d} CONFIRMED: badext, corrupt, triple, artist, good")
            return
        for role, reason in bad.items():
            self.failed_roles.append((serial, role, reason))
            say(f"cycle {serial:06d} FAIL {role}: {reason}")

    def wait(self):
        """Checks until every pending cycle is resolved; the per-cycle timeout bounds it."""
        while not self.check():
            time.sleep(10)

    def summary(self):
        failures = len(self.failures.drain())
        expected = FAILURES_PER_CYCLE * self.confirmed_cycles
        say(f"confirmed {self.confirmed_cycles} cycle(s), {len(self.failed_roles)} role(s) failed; "
            f"{self.args.failures_topic} +{failures} (expected {expected})")
        if self.pending:
            say(f"{len(self.pending)} cycle(s) still unconfirmed at exit: "
                + ", ".join(f"{s:06d}" for s in sorted(self.pending)))
        self.documents.close()
        self.failures.close()
        return 0 if not self.failed_roles and failures == expected and not self.pending else 1


# ── run ─────────────────────────────────────────────────────────────────────────────────────────

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
    parser.add_argument("--documents-topic", default=DEFAULT_DOCUMENTS_TOPIC)
    parser.add_argument("--failures-topic", default=DEFAULT_FAILURES_TOPIC)
    parser.add_argument("--container", default=DEFAULT_CONTAINER, help="the MinIO container")
    parser.add_argument("--namespace", default=DEFAULT_NAMESPACE)
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
    parser.add_argument("--confirm-timeout", type=float, default=300.0,
                        help="seconds a cycle may take before an unconfirmed role fails (default 300)")
    parser.add_argument("--no-confirm", action="store_true", help="seed only; confirm nothing")
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
    confirmer = None if args.no_confirm else Confirmer(args)
    serial = args.start_serial
    produced = wipes = 0
    interrupted = False
    say(f"seeding {args.topic} at {args.brokers}; objects to {args.container}:{IN_BUCKET}/{args.prefix}; "
        f"{per_cycle} objects every {args.interval}s; wipe at {args.max_files}; "
        f"approved artist '{args.approved_artist}'; confirming {'nothing' if args.no_confirm else 'every role'}")

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
            if confirmer:
                confirmer.add(serial, files)
                confirmer.check()

            if not args.no_wipe:
                held = len(list_objects(args.container, IN_BUCKET))
                if held >= args.max_files:
                    say(f"{IN_BUCKET} holds {held} (>= {args.max_files}); waiting for the importer")
                    base.wait_for_drain(args.brokers, args.topic, args.group,
                                        args.settle, args.drain_timeout, args.force_wipe)
                    if confirmer:
                        say("confirming every pending cycle before the wipe")
                        confirmer.wait()
                    wipe(args.container)
                    wipes += 1
                    say(f"wiped {IN_BUCKET} and {OUT_BUCKET} (wipe #{wipes})")

            serial += 1
            if args.cycles == 0 or serial - args.start_serial < args.cycles:
                time.sleep(args.interval)

        if confirmer:
            say("all cycles seeded; confirming what is still pending")
            confirmer.wait()
    except KeyboardInterrupt:
        interrupted = True
        say("interrupted")
    finally:
        producer.flush(timeout=10)
        say(f"produced {produced} record(s) over {serial - args.start_serial} cycle(s), {wipes} wipe(s)")
        say(f"next run: --start-serial {serial}")

    if confirmer and not interrupted:
        return confirmer.summary()
    return 0


if __name__ == "__main__":
    sys.exit(main())
