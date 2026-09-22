#!/usr/bin/env python3
"""
Drives the split chain endlessly with a fixed mix of outcomes, so a long run can be analysed.

Every cycle writes FIVE files onto the kind node and seeds their paths onto `skp-paths`. The five
are not variations on a theme: each one is built to trip exactly one stage of the chain, and the
five together are one of every outcome the chain can produce.

    role      file                        trips                                    outcome
    -----------------------------------------------------------------------------------------
    badext    sim-NNNNNN-badext.dat       FileFetcher allowedExtensions [".zip"]   Failed (fetch)
    corrupt   sim-NNNNNN-corrupt.zip      ArchiveExpander signature cross-check    Failed (expand)
    triple    sim-NNNNNN-triple.zip       AcmeHandler.ValidateContent, nodes != 2  Failed (normalize)
    artist    sim-NNNNNN-artist.zip       AcmeHandler.Augment artist gate          CANCELLED
    good      sim-NNNNNN-good.zip         nothing                                  Completed -> out/

THE ROLE IS IN THE FILENAME, AND THAT BUYS LESS THAN IT LOOKS LIKE. The expected outcome of every
file is readable from its name, so processor logs, Elasticsearch and the `out/` folder bucket
themselves: an `-artist.zip` logged as failed rather than cancelled is a defect, a `-badext.dat`
reporting anything but the whitelist reason failed for the wrong reason, and a `-good.zip` absent
from `out/` is a regression.

**`skp-failures` carries no filename.** A record on it is
`{correlationId, executionId, recordedAtUtc}` and nothing else — verified against a live run: one
cycle's three failures arrive as three records sharing ONE correlationId, so the topic tells you
how many branches failed and not which file or why. Attributing a failure record to a role means
joining its `executionId` to the processor logs. Counting is the thing the topic is good for, and
the count to expect is THREE per cycle, not four: **a cancelled branch does not reach
`skp-failures`**, so role 4 is visible only in the logs and in Elasticsearch.

ROLE 1 CARRIES A PERFECTLY GOOD ARCHIVE UNDER A .dat NAME, deliberately. If its bytes were junk
too, a fetch failure and an expander failure would both be available explanations and the record
would prove nothing. The extension is the only thing wrong with it, so the whitelist is the only
thing that can reject it.

ROLE 2 IS NOT AN INPUT-SCHEMA FAILURE, whatever it looks like from outside. ArchiveExpander's
registered `inputSchemaId` is `file-envelope` -- six keys that FileFetcher itself writes -- so no
file on disk can make that envelope invalid. What a file CAN do is arrive named `.zip` with
leading bytes matching no archive signature, which `FileContentBuilder.Build` refuses up front
("treating it as corrupt rather than recording it as a plain file") rather than recording as a
plain leaf. That is the expander's own rejection of a file, and it is what role 2 builds.

ROLE 5's ARTIST MUST BE ON THE LIVE WHITELIST OR ROLE 5 BECOMES A SECOND ROLE 4. The Acme handler
gates `metadata.artist` against the workflow's `chain-artists` cache and publishes the cache's
value, not the sidecar's. The default here is the key the rebuild runbook seeds
(`{"SKP Live Suite": "SKP Live Suite (Approved)"}`); if the live cache was seeded differently,
pass --approved-artist, or every fifth file cancels and the run has no successful round trip in
it. Note that `tools/make-sample-archives.py` writes "Acme Test Artist", which is role 4's
behaviour and not role 5's -- which is why this tool builds its own archives rather than calling
that one.

THE FILES GO ON THE NODE, NOT ON THE HOST. Both `/mnt/skp-files/in` and `/mnt/skp-files/out` are
hostPath mounts on the kind node, so the chain can only see what is inside the
`desktop-control-plane` container. One `docker exec ... tar -xf -` per cycle puts all five there in
a single call; five `docker cp` invocations would do the same thing five times as slowly.

THE FILE LANDS BEFORE ITS PATH IS SEEDED, never the other way round. A record whose file is not yet
there fails the fetch on a missing file, which is role 1's outcome arriving for the wrong reason on
all five roles.

THE WIPE WAITS FOR THE IMPORTER TO CATCH UP. At --max-files the in and out folders are emptied, but
not until consumer group `skp-splitchain` has zero lag on `skp-paths` and a further --settle
seconds have passed. Delete a file whose record is still queued and it fails the fetch as a missing
path -- so every role degrades into role 1's failure and the run's whole premise is gone. If the lag
never drains the chain is wedged, and this tool WAITS rather than wiping: a warning every
--drain-timeout seconds and no further production. Continuing would fill a topic with records
nothing is reading and fill Elasticsearch with failures that are this tool's fault. --force-wipe
overrides that if you want the run to continue regardless.

READING THE LAG DOES NOT JOIN THE GROUP. The lag probe builds a Consumer carrying
group.id=skp-splitchain but never subscribes or assigns, so it issues an OffsetFetch and nothing
else -- no join, no rebalance of the live importer, no commit. Do not add a subscribe() here.

RATE. The chain's workflow is cron `5,35 * * * * *` with `messageCount: 25`, so it imports at most
50 records a minute. The default here is 5 files every 30 seconds = 10 a minute, comfortably under.
Raising --count or lowering --interval past 50/min grows the Kafka lag without bound and the wipe
never fires.

RUN THIS FROM POWERSHELL, NOT GIT BASH, for the reason kafka-produce-records.py gives at length:
MSYS rewrites anything that looks like a unix absolute path before Python sees it, so --node-in-dir
arrives mangled and every seeded record names a path nothing backs. From bash, prefix with
MSYS_NO_PATHCONV=1. The defaults below are literals in this file and are never mangled.

Usage:
    python tools/simulate-endless-feed.py --dry-run --cycles 1 --out-dir ./out
    python tools/simulate-endless-feed.py --cycles 1 --no-wipe
    python tools/simulate-endless-feed.py
"""

import argparse
import io
import json
import math
import struct
import subprocess
import sys
import tarfile
import time
import wave
import zipfile
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path

try:
    from confluent_kafka import Consumer, Producer, TopicPartition
except ImportError:  # pragma: no cover - a setup error, not a runtime one
    sys.exit("confluent-kafka is not installed. Run: python -m pip install confluent-kafka")


DEFAULT_BROKERS = "localhost:19092"
DEFAULT_TOPIC = "skp-paths"

# The group the chain's KafkaImporter step commits under -- see the importer step payload in
# docs/rebuild-filefetcher-archiveexpander-chain.md. Its lag is what the wipe waits on.
DEFAULT_GROUP = "skp-splitchain"

DEFAULT_NODE = "desktop-control-plane"
DEFAULT_IN_DIR = "/mnt/skp-files/in"
DEFAULT_OUT_DIR = "/mnt/skp-files/out"

# The key the rebuild runbook seeds into the chain-artists cache. The VALUE it maps to is what the
# standardized XML carries; this tool only needs the key, since that is what a sidecar writes.
DEFAULT_APPROVED_ARTIST = "SKP Live Suite"

# Anything the whitelist does not hold. Stated as a constant rather than inlined so the one string
# that must NOT be approved is visible beside the one that must be.
UNAPPROVED_ARTIST = "Unapproved Sim Artist"

SAMPLE_RATE_HZ = 44100
CHANNELS = 2
SAMPLE_WIDTH_BYTES = 2  # 16-bit
TONE_HZ = 440.0
DURATION_SECONDS = 0.25  # shorter than make-sample-archives.py's: this builds 4 wavs every cycle
AMPLITUDE = 0.3  # of full scale, to leave headroom and avoid clipping on int16 rounding

BASENAME = "track01"


def build_wav_bytes():
    """A short sine tone as real RIFF/WAVE bytes, plus the facts read back off what was written.

    Lifted from tools/make-sample-archives.py and kept honest the same way: the sidecar states the
    rate, channels and duration this function measured off the bytes, never the constants above, so
    a sidecar can never describe audio it is not beside. The tone is a quarter second rather than
    that tool's 1.5s because an endless run builds four of these every cycle and none of them is
    ever listened to."""
    frame_count = int(SAMPLE_RATE_HZ * DURATION_SECONDS)
    max_amplitude = (2 ** (8 * SAMPLE_WIDTH_BYTES - 1)) - 1

    frames = bytearray()
    for i in range(frame_count):
        t = i / SAMPLE_RATE_HZ
        sample = int(AMPLITUDE * max_amplitude * math.sin(2 * math.pi * TONE_HZ * t))
        packed = struct.pack("<h", sample)
        for _ in range(CHANNELS):
            frames += packed

    buffer = BytesIO()
    with wave.open(buffer, "wb") as writer:
        writer.setnchannels(CHANNELS)
        writer.setsampwidth(SAMPLE_WIDTH_BYTES)
        writer.setframerate(SAMPLE_RATE_HZ)
        writer.writeframes(bytes(frames))

    wav_bytes = buffer.getvalue()

    with wave.open(BytesIO(wav_bytes)) as reader:
        return (
            wav_bytes,
            reader.getframerate(),
            reader.getnchannels(),
            reader.getnframes() / reader.getframerate(),
        )


def build_sidecar_bytes(serial, artist, audio_filename, sample_rate, channels, duration):
    """The JSON AcmeHandler.Map deserializes into AcmeSidecar / AcmeSidecarAudio.

    Keys are exactly title, artist, album, recordedUtc and a nested audio object with file,
    sampleRateHz, channels, durationSeconds -- AcmeHandler reads them camelCase and
    case-insensitively into a record with those five members, and a sidecar of another shape
    deserializes to nulls rather than failing where you could see it.

    `artist` is the parameter the roles differ on: it is the only field the whitelist gate reads,
    so passing an approved name here is what separates role 5 from role 4."""
    sidecar = {
        "title": f"Sim Track {serial:06d}",
        "artist": artist,
        "album": "SKP Endless Feed",
        "recordedUtc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "audio": {
            "file": audio_filename,
            "sampleRateHz": sample_rate,
            "channels": channels,
            "durationSeconds": duration,
        },
    }
    return json.dumps(sidecar, indent=2).encode("utf-8")


def build_pair_archive(serial, artist, extra_entry=False):
    """A conforming Acme archive: exactly track01.wav and track01.json, sharing the basename
    AcmeHandler.Locate groups on.

    ZIP_STORED and only the named entries -- no directory entries, no resource forks -- because
    ValidateContent rejects any item whose node count is not exactly 2 and a third entry would fail
    the item even though the pair inside it is fine.

    extra_entry=True adds track01.txt and is role 3's entire mechanism: a third entry under the SAME
    basename, so Locate pairs all three into one item and ValidateContent reports an item that also
    holds track01.txt. A third entry under a DIFFERENT basename would not do this -- it would become
    its own one-node item and fail for a different reason."""
    audio_filename = f"{BASENAME}.wav"
    sidecar_filename = f"{BASENAME}.json"

    wav_bytes, rate, channels, duration = build_wav_bytes()
    sidecar_bytes = build_sidecar_bytes(serial, artist, audio_filename, rate, channels, duration)

    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_STORED) as archive:
        archive.writestr(audio_filename, wav_bytes)
        archive.writestr(sidecar_filename, sidecar_bytes)
        if extra_entry:
            archive.writestr(f"{BASENAME}.txt", b"a third entry sharing the basename\n")

    return buffer.getvalue()


def build_corrupt_bytes(serial):
    """Bytes that are NOT an archive, for a file that will be named .zip.

    Plain ASCII, chosen so the leading bytes match no signature any extractor claims -- `PK` would
    be claimed as a zip and fail somewhere else, and a gzip or tar magic would be extracted happily
    under the wrong name, which FileContentBuilder explicitly permits ("a .zip that is really a tar
    does NOT fail"). Only bytes matching nothing reach the cross-check."""
    return (
        f"this is not an archive. serial {serial:06d}. it is named .zip so ArchiveExpander's\n"
        "declaration cross-check refuses it rather than recording it as a plain file.\n"
    ).encode("utf-8")


def roles_for(approved_artist):
    """The five roles, in the order they are produced, as (role, extension, builder).

    Adding a sixth role means adding a row here and nothing else. The mix is deliberately NOT a
    flag: a partial mix would silently change what a run measures, and the point of the tool is
    that every cycle contributes one of each outcome."""
    return [
        # A GOOD archive under a bad extension. See the module docstring: the extension is the only
        # thing wrong with it, so the whitelist is the only thing that can reject it.
        ("badext", ".dat", lambda n: build_pair_archive(n, approved_artist)),
        ("corrupt", ".zip", build_corrupt_bytes),
        ("triple", ".zip", lambda n: build_pair_archive(n, approved_artist, extra_entry=True)),
        ("artist", ".zip", lambda n: build_pair_archive(n, UNAPPROVED_ARTIST)),
        ("good", ".zip", lambda n: build_pair_archive(n, approved_artist)),
    ]


def build_cycle(serial, approved_artist):
    """One cycle's five files as (filename, bytes), all sharing the cycle's serial so the five that
    were produced together are recoverable from a filename later."""
    return [
        (f"sim-{serial:06d}-{role}{extension}", builder(serial))
        for role, extension, builder in roles_for(approved_artist)
    ]


def tar_stream(files):
    """The five files as one uncompressed tar, for `tar -xf -` on the node.

    Mode 0644 and no ownership carried: tar extracts as root inside the node, and FileFetcher runs
    as uid 1654 against a read-only mount, so the files must be world-readable. This is the same
    ownership `docker cp` produces, which is the path k8s/38-processor-filefetcher.yaml documents."""
    buffer = BytesIO()
    now = int(time.time())
    with tarfile.open(fileobj=buffer, mode="w") as archive:
        for name, payload in files:
            info = tarfile.TarInfo(name)
            info.size = len(payload)
            info.mode = 0o644
            info.mtime = now
            archive.addfile(info, io.BytesIO(payload))
    return buffer.getvalue()


def node_exec(node, argv, stdin=None, check=True):
    """One `docker exec` against the kind node. Returns the completed process.

    The node is a docker container even though everything else here is kubectl: /mnt/skp-files is a
    hostPath on the node's filesystem, and there is no kubectl verb that writes to one."""
    result = subprocess.run(
        ["docker", "exec", "-i", node, *argv],
        input=stdin,
        capture_output=True,
    )
    if check and result.returncode != 0:
        detail = result.stderr.decode("utf-8", "replace").strip()
        raise RuntimeError(f"docker exec {' '.join(argv)} failed ({result.returncode}): {detail}")
    return result


def push_files(node, in_dir, files):
    """Puts a cycle's files on the node in one call."""
    node_exec(node, ["tar", "-xf", "-", "-C", in_dir], stdin=tar_stream(files))


def count_files(node, in_dir):
    """How many files the in folder holds. `ls -1 | wc -l` rather than `ls | wc -w`, so a filename
    with a space in it counts once."""
    result = node_exec(node, ["sh", "-c", f"ls -1 {in_dir} | wc -l"])
    return int(result.stdout.decode().strip() or "0")


def wipe(node, in_dir, out_dir):
    """Empties both folders. -f so an already-empty folder is not an error, and the glob is
    expanded by the node's shell rather than by anything here."""
    node_exec(node, ["sh", "-c", f"rm -f {in_dir}/* {out_dir}/* 2>/dev/null; true"])


def consumer_lag(brokers, topic, group):
    """Total lag of `group` on `topic`, across every partition.

    NEVER SUBSCRIBES OR ASSIGNS. Constructing a Consumer does not join a group; committed() is an
    OffsetFetch and get_watermark_offsets() is a metadata read. Add a subscribe() here and this
    probe would trigger a rebalance of the live importer every time the wipe checks.

    A partition the group has never committed to reports OFFSET_INVALID; its lag counts as the whole
    partition, which is right -- nothing has been read from it."""
    consumer = Consumer({
        "bootstrap.servers": brokers,
        "group.id": group,
        "enable.auto.commit": False,
    })
    try:
        metadata = consumer.list_topics(topic, timeout=10)
        if topic not in metadata.topics or metadata.topics[topic].error is not None:
            raise RuntimeError(f"topic {topic} is not readable on {brokers}")

        partitions = [TopicPartition(topic, p) for p in metadata.topics[topic].partitions]
        committed = consumer.committed(partitions, timeout=10)

        total = 0
        for part in committed:
            _, high = consumer.get_watermark_offsets(part, timeout=10, cached=False)
            # OFFSET_INVALID is -1001; any negative position means "nothing committed here".
            position = part.offset if part.offset >= 0 else 0
            total += max(0, high - position)
        return total
    finally:
        consumer.close()


def wait_for_drain(brokers, topic, group, settle, drain_timeout, force):
    """Blocks until the importer has caught up, then a little longer.

    With --force-wipe it gives up after drain_timeout and returns anyway; without it, it keeps
    waiting and warns every drain_timeout seconds, because wiping under lag turns every role into a
    missing-file fetch failure and a wedged chain is better left visible than papered over with
    junk data."""
    waited = 0.0
    next_warning = drain_timeout
    while True:
        lag = consumer_lag(brokers, topic, group)
        if lag == 0:
            if settle:
                say(f"lag is 0; settling {settle}s before the wipe")
                time.sleep(settle)
            return

        if waited >= next_warning:
            if force:
                say(f"WARNING: lag is still {lag} after {int(waited)}s -- wiping anyway (--force-wipe)")
                return
            say(
                f"WARNING: lag is still {lag} after {int(waited)}s. NOT wiping and NOT producing: "
                "wiping under lag would turn every role into a missing-file fetch failure. "
                "Check the chain, or rerun with --force-wipe."
            )
            next_warning += drain_timeout

        time.sleep(2)
        waited += 2


def produce(producer, topic, paths):
    """Seeds one cycle's paths. Delivery is asynchronous and a failed send is reported to the
    callback, not raised by produce(), so the callbacks are what is counted."""
    failures = []

    def on_delivery(err, _msg):
        if err is not None:
            failures.append(str(err))

    for path in paths:
        value = json.dumps({"filePath": path}, separators=(",", ":")).encode("utf-8")
        producer.produce(topic, value=value, on_delivery=on_delivery)

    remaining = producer.flush(timeout=30)
    if remaining:
        raise RuntimeError(f"{remaining} record(s) still queued after 30s -- broker unreachable?")
    return failures


def say(message):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {message}", flush=True)


def run_dry(args):
    """Writes the cycles' files locally and prints the paths that WOULD be seeded. Touches neither
    the node nor the broker, so this is the check that the five archives are what you think before
    anything reaches the chain."""
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    serial = args.start_serial
    for _ in range(args.cycles or 1):
        for name, payload in build_cycle(serial, args.approved_artist):
            (out / name).write_bytes(payload)
            print(f"{out / name}  ->  {args.node_in_dir}/{name}  ({len(payload)} bytes)")
        serial += 1
    return 0


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--brokers", default=DEFAULT_BROKERS)
    parser.add_argument("--topic", default=DEFAULT_TOPIC)
    parser.add_argument("--group", default=DEFAULT_GROUP,
                        help="the importer's consumer group; its lag is what the wipe waits on")
    parser.add_argument("--node", default=DEFAULT_NODE, help="the kind node container")
    parser.add_argument("--node-in-dir", default=DEFAULT_IN_DIR)
    parser.add_argument("--node-out-dir", default=DEFAULT_OUT_DIR)
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
    parser.add_argument("--approved-artist", default=DEFAULT_APPROVED_ARTIST,
                        help="an artist the live chain-artists cache holds, for role 5")
    parser.add_argument("--start-serial", type=int, default=1,
                        help="first serial, so a restarted run does not reuse filenames")
    parser.add_argument("--dry-run", action="store_true",
                        help="write the files locally and seed nothing")
    parser.add_argument("--out-dir", default="./out", help="where --dry-run writes")
    args = parser.parse_args()

    if args.interval <= 0:
        raise SystemExit("--interval must be positive")

    per_cycle = len(roles_for(args.approved_artist))
    if args.max_files < per_cycle:
        raise SystemExit(f"--max-files must be at least one cycle's worth of files ({per_cycle})")

    if args.dry_run:
        return run_dry(args)

    producer = Producer({"bootstrap.servers": args.brokers})

    serial = args.start_serial
    produced = 0
    wipes = 0
    say(
        f"seeding {args.topic} at {args.brokers}; files to {args.node}:{args.node_in_dir}; "
        f"{per_cycle} files every {args.interval}s; wipe at {args.max_files}; "
        f"approved artist '{args.approved_artist}'"
    )

    try:
        while args.cycles == 0 or serial - args.start_serial < args.cycles:
            files = build_cycle(serial, args.approved_artist)

            # The file lands first. A record whose file is not there yet fails the fetch as a
            # missing path, which is role 1's outcome arriving on all five roles.
            push_files(args.node, args.node_in_dir, files)

            paths = [f"{args.node_in_dir}/{name}" for name, _ in files]
            failures = produce(producer, args.topic, paths)
            for failure in failures:
                print(f"FAILED: {failure}", file=sys.stderr)

            seeded = len(paths) - len(failures)
            produced += seeded
            say(f"cycle {serial:06d}: {len(files)} files on the node, {seeded} records seeded")

            if not args.no_wipe:
                held = count_files(args.node, args.node_in_dir)
                if held >= args.max_files:
                    say(f"in folder holds {held} (>= {args.max_files}); waiting for the importer")
                    wait_for_drain(
                        args.brokers, args.topic, args.group,
                        args.settle, args.drain_timeout, args.force_wipe,
                    )
                    wipe(args.node, args.node_in_dir, args.node_out_dir)
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
