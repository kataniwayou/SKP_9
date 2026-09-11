#!/usr/bin/env python3
"""
Seeds the dev Kafka topic that Processor.KafkaImporter reads.

Each record is a JSON object naming one file path, and nothing else:

    {"filePath": "/mnt/skp-files/in/file-001.zip"}

WHATEVER THIS WRITES IS WHAT EVERY DOWNSTREAM STEP RECEIVES, byte for byte. The importer does not
interpret the record value: it opens a lineage per record and sends the value on as the branch's
data, with no envelope added and no re-encoding. So the shape here IS the importer's output shape,
and a registered output schema is the thing that decides whether it is acceptable.

ONE KEY, AND IT IS NOT NEGOTIABLE FROM HERE. The registered file-locator schema declares
`required: ["filePath"]` with `additionalProperties: false`, so a second key is refused by
KafkaImporter's OWN output validation and the lineage ends at the first hop, logged as

    warn ProcessedDataHandler: output failed its schema -- reported failed: /providerName:

This script carried `{"path", "providerName"}` until 2026-09-11 and had been unusable against the
registered row since the schema was tightened: `providerName` was refused as an unknown key and
`path` was refused as one too, while the required `filePath` was absent. Both keys had to go. The
docstring here used to argue that a provider name was invisible to the processor and that adding
another field tomorrow would need no change -- true of the reader, which binds case-insensitively
and drops unknowns, and false of the edge, which now refuses the record before the reader sees it.

THE PATHS MUST ALREADY EXIST ON THE NODE. This seeds paths, not files: FileFetcher opens what the
record names, inside the cluster, and a path nothing backs fails the fetch. Put a file there first --

    docker cp ./some.zip desktop-control-plane:/mnt/skp-files/in/file-001.zip

-- and note the fetcher step in the split chain is wired `allowedExtensions: [".zip"]`, so a .dat
or .txt is rejected by the whitelist before a byte is read. That is why the defaults below name
.zip files under the directory the chain's fetcher actually reads.

Keys are camelCase to match ProcessorConfig.SerializerOptions, which is what the rest of the
pipeline's JSON is written and read with. The bytes are compact UTF-8 with no trailing newline: the
value is the record and nothing trims it, so a stray newline would travel the whole way and land in
the branch data.

The broker address differs by where you are standing. From the host the container publishes
localhost:19092; from inside the kind cluster it is skp-kafka:9092, because the container is
attached to the kind docker network and advertises both listeners. This script runs on the host,
so it defaults to the host address -- the in-cluster one belongs in the step payload, not here.

RUN THIS FROM POWERSHELL, NOT GIT BASH -- or the paths you seed are not the paths you typed. MSYS
rewrites any argument that looks like a unix absolute path before Python sees it, so
`--prefix /mnt/skp-files/in` arrives as `C:/Program Files/Git/mnt/skp-files/in` and every record on
the topic carries that instead. It is silent, and the processor imports it happily: the first live
run of this script seeded five records reading
`C:/Program Files/Git/mnt/incoming/smoke/file-001.dat`. From bash, prefix the command with
MSYS_NO_PATHCONV=1. The DEFAULT_PREFIX below is a literal in this file and is never mangled.

Usage:
    python tools/kafka-produce-records.py --count 12
    python tools/kafka-produce-records.py --file records.txt
    python tools/kafka-produce-records.py --count 3 --prefix /mnt/skp-files/in/batch-07
"""

import argparse
import json
import sys

try:
    from confluent_kafka import Producer
except ImportError:  # pragma: no cover - a setup error, not a runtime one
    sys.exit("confluent-kafka is not installed. Run: python -m pip install confluent-kafka")


DEFAULT_BROKERS = "localhost:19092"
DEFAULT_TOPIC = "skp-paths"

# The directory the chain's FileFetcher reads, inside the cluster -- a node path, not a host one.
# It was /mnt/incoming until 2026-09-11, which exists nowhere: every generated record named a file
# no fetcher could open, so the default run could only ever fail.
DEFAULT_PREFIX = "/mnt/skp-files/in"


def generated_paths(count, prefix):
    """Synthesises count paths under prefix. Numbered from 1 so a log line reading 'path 007'
    matches the seventh record rather than the eighth.

    .zip because the split chain's fetcher step is wired `allowedExtensions: [".zip"]` and rejects
    anything else before reading a byte. These are still only paths: the files have to be on the
    node already, or the fetch fails on a file that is not there rather than on its extension."""
    return [f"{prefix}/file-{i:03d}.zip" for i in range(1, count + 1)]


def paths_from_file(path):
    """One path per line; blanks and # comments dropped so a seed list can be annotated.

    Paths and nothing else, because the record is a path and nothing else. This used to say the
    provider came from --provider and applied to every line; the record carries no provider now, so
    a seed list is exactly the set of files one sweep of a folder found."""
    with open(path, encoding="utf-8") as handle:
        return [
            line.strip()
            for line in handle
            if line.strip() and not line.lstrip().startswith("#")
        ]


def record(path):
    """The value of one record. separators= drops the spaces json.dumps adds by default, because
    every byte here is a byte on the topic and on the branch.

    One key. See the module docstring: the registered schema sets additionalProperties: false, so a
    second one is refused at the edge rather than ignored downstream."""
    return json.dumps({"filePath": path}, separators=(",", ":")).encode("utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--brokers", default=DEFAULT_BROKERS)
    parser.add_argument("--topic", default=DEFAULT_TOPIC)
    # --provider is GONE, not defaulted. It stamped a providerName on every record, which the
    # registered file-locator schema now refuses outright; keeping the flag as a no-op would leave a
    # caller believing a field reaches the topic that does not.
    parser.add_argument("--count", type=int, default=10)
    parser.add_argument("--prefix", default=DEFAULT_PREFIX)
    parser.add_argument("--file", help="read paths from this file instead of generating them")
    args = parser.parse_args()

    paths = paths_from_file(args.file) if args.file else generated_paths(args.count, args.prefix)
    if not paths:
        sys.exit("nothing to produce")

    producer = Producer({"bootstrap.servers": args.brokers})

    # Delivery is asynchronous and a failed send is reported HERE, not raised by produce(). Counting
    # the callbacks rather than the produce() calls is the only way to know a record actually landed.
    delivered = []
    failures = []

    def on_delivery(err, msg):
        if err is not None:
            failures.append(str(err))
        else:
            delivered.append(msg.offset())

    for path in paths:
        producer.produce(args.topic, value=record(path), on_delivery=on_delivery)

    remaining = producer.flush(timeout=30)
    if remaining:
        sys.exit(f"{remaining} record(s) still queued after 30s -- broker unreachable?")

    for failure in failures:
        print(f"FAILED: {failure}", file=sys.stderr)

    if delivered:
        print(
            f"produced {len(delivered)} record(s) to {args.topic} "
            f"at offsets {min(delivered)}..{max(delivered)}"
        )
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
