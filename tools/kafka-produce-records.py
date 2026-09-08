#!/usr/bin/env python3
"""
Seeds the dev Kafka topic that Processor.KafkaImporter reads.

Each record is a JSON object naming a file path and the provider it came from:

    {"path": "/mnt/incoming/file-001.dat", "providerName": "acme"}

WHATEVER THIS WRITES IS WHAT EVERY DOWNSTREAM STEP RECEIVES, byte for byte. The importer does not
interpret the record value: it opens a lineage per record and sends the value on as the branch's
data, with no envelope added and no re-encoding. THE PROVIDER NAME IS THEREFORE INVISIBLE TO THE
PROCESSOR -- it is not a field the importer knows, parses or could validate, and adding a second one
tomorrow needs no change there. The contract this object satisfies is between this script and
whatever reads the branch downstream.

Which means the shape here IS the importer's output shape. If an output schema is registered for that
processor it must describe this object, or every record seeded here fails one hop downstream in the
post handler rather than at the importer -- where the failure would at least name the topic it came
from.

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
`--prefix /mnt/incoming` arrives as `C:/Program Files/Git/mnt/incoming` and every record on the
topic carries that instead. It is silent, and the processor imports it happily: the first live run
of this script seeded five records reading
`C:/Program Files/Git/mnt/incoming/smoke/file-001.dat`. From bash, prefix the command with
MSYS_NO_PATHCONV=1. The DEFAULT_PREFIX below is a literal in this file and is never mangled.

Usage:
    python tools/kafka-produce-records.py --provider acme --count 12
    python tools/kafka-produce-records.py --provider acme --file records.txt
    python tools/kafka-produce-records.py --provider northwind --count 3 --prefix /mnt/incoming/batch-07
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
DEFAULT_PREFIX = "/mnt/incoming"


def generated_paths(count, prefix):
    """Synthesises count paths under prefix. Numbered from 1 so a log line reading 'path 007'
    matches the seventh record rather than the eighth."""
    return [f"{prefix}/file-{i:03d}.dat" for i in range(1, count + 1)]


def paths_from_file(path):
    """One path per line; blanks and # comments dropped so a seed list can be annotated.

    Paths only -- the provider comes from --provider and applies to every line. That matches how the
    records are actually produced: a provider drops its files into a folder and one sweep of that
    folder becomes one run of this script. Seeding two providers means running it twice, which is
    both honest about what happened and cheaper than a second column nobody has needed yet."""
    with open(path, encoding="utf-8") as handle:
        return [
            line.strip()
            for line in handle
            if line.strip() and not line.lstrip().startswith("#")
        ]


def record(path, provider):
    """The value of one record. separators= drops the spaces json.dumps adds by default, because
    every byte here is a byte on the topic and on the branch."""
    return json.dumps(
        {"path": path, "providerName": provider}, separators=(",", ":")
    ).encode("utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--brokers", default=DEFAULT_BROKERS)
    parser.add_argument("--topic", default=DEFAULT_TOPIC)
    # REQUIRED, WITH NO DEFAULT, and that is deliberate. A default would put a placeholder provider
    # on every record of every run, and nothing downstream could tell it apart from a real one -- the
    # same class of silent wrong data as the MSYS path mangling described above, which also imported
    # happily and was only found by reading the records back.
    parser.add_argument(
        "--provider", required=True,
        help="provider name stamped on every record of this run (required: see the module docstring)")
    parser.add_argument("--count", type=int, default=10)
    parser.add_argument("--prefix", default=DEFAULT_PREFIX)
    parser.add_argument("--file", help="read paths from this file instead of generating them")
    args = parser.parse_args()

    # Checked rather than assumed: argparse enforces that --provider was PASSED, not that it says
    # anything. `--provider ""` and `--provider "  "` both satisfy required=True and would seed a
    # topic whose provider field is present and empty, which is worse than absent -- a reader
    # checking for the key would find it.
    provider = args.provider.strip()
    if not provider:
        sys.exit("--provider must name a provider; it cannot be blank")

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
        producer.produce(args.topic, value=record(path, provider), on_delivery=on_delivery)

    remaining = producer.flush(timeout=30)
    if remaining:
        sys.exit(f"{remaining} record(s) still queued after 30s -- broker unreachable?")

    for failure in failures:
        print(f"FAILED: {failure}", file=sys.stderr)

    if delivered:
        print(
            f"produced {len(delivered)} record(s) for provider {provider} to {args.topic} "
            f"at offsets {min(delivered)}..{max(delivered)}"
        )
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
