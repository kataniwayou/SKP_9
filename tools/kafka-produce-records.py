#!/usr/bin/env python3
"""
Seeds the dev Kafka topic that Processor.KafkaImporter reads.

WHATEVER THIS WRITES IS WHAT EVERY DOWNSTREAM STEP RECEIVES, byte for byte. The importer does not
interpret the record value: it opens a lineage per record and sends the value on as the branch's
data, with no envelope added and no re-encoding. So the shape chosen here IS the workflow's input
schema -- and if the processor has a registered output schema, a record this script writes that does
not satisfy it fails one hop downstream, in the post handler, not at the importer.

This script writes UTF-8 text, one record per line or per generated path. Text is a convenience of
the seeding tool and not a constraint of the topic: the importer's seam carries bytes precisely so a
value that is not text survives it unchanged.

The broker address differs by where you are standing. From the host the container publishes
localhost:19092; from inside the kind cluster it is skp-kafka:9092, because the container is
attached to the kind docker network and advertises both listeners. This script runs on the host,
so it defaults to the host address -- the in-cluster one belongs in the step payload, not here.

RUN THIS FROM POWERSHELL, NOT GIT BASH -- or the paths you seed are not the paths you typed. MSYS
rewrites any argument that looks like a unix absolute path before Python sees it, so
`--prefix /mnt/incoming` arrives as `C:/Program Files/Git/mnt/incoming` and every record on the
topic carries that instead. It is silent, and the processor imports it happily: the first live run
of this script seeded five records reading
`C:/Program Files/Git/mnt/incoming/smoke/file-001.dat`. From bash, prefix the command with
MSYS_NO_PATHCONV=1. The DEFAULT_PREFIX below is a literal in this file and is never mangled.

Usage:
    python tools/kafka-produce-records.py --count 12
    python tools/kafka-produce-records.py --file records.txt
    python tools/kafka-produce-records.py --count 3 --prefix /mnt/incoming/batch-07
"""

import argparse
import sys

try:
    from confluent_kafka import Producer
except ImportError:  # pragma: no cover - a setup error, not a runtime one
    sys.exit("confluent-kafka is not installed. Run: python -m pip install confluent-kafka")


DEFAULT_BROKERS = "localhost:19092"
DEFAULT_TOPIC = "skp-paths"
DEFAULT_PREFIX = "/mnt/incoming"


def generated_paths(count, prefix):
    """Synthesises count paths under prefix. Numbered from 1 so a log line reading 'path 007'
    matches the seventh record rather than the eighth."""
    return [f"{prefix}/file-{i:03d}.dat" for i in range(1, count + 1)]


def paths_from_file(path):
    """One record per line; blanks and # comments dropped so a seed list can be annotated."""
    with open(path, encoding="utf-8") as handle:
        return [
            line.strip()
            for line in handle
            if line.strip() and not line.lstrip().startswith("#")
        ]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--brokers", default=DEFAULT_BROKERS)
    parser.add_argument("--topic", default=DEFAULT_TOPIC)
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

    for value in paths:
        producer.produce(args.topic, value=value.encode("utf-8"), on_delivery=on_delivery)

    remaining = producer.flush(timeout=30)
    if remaining:
        sys.exit(f"{remaining} record(s) still queued after 30s -- broker unreachable?")

    for failure in failures:
        print(f"FAILED: {failure}", file=sys.stderr)

    if delivered:
        print(
            f"produced {len(delivered)} path(s) to {args.topic} "
            f"at offsets {min(delivered)}..{max(delivered)}"
        )
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
