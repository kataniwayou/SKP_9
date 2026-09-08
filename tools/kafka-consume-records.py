#!/usr/bin/env python3
"""
Reads a dev Kafka topic back, so an export can be checked without opening a Java shell.

The counterpart to kafka-produce-records.py: that one seeds what Processor.KafkaImporter reads, this
one shows what Processor.KafkaExporter wrote. It is a diagnostic and nothing depends on it.

READ-ONLY BY CONSTRUCTION, and that is worth stating because the obvious implementation is not.
Offsets are never committed and the group is a fresh random one on every run, so this cannot move a
position the exporter's own workflow depends on and cannot make a record invisible to the next
reader. Reusing a fixed group id would do both, silently, the second time you ran it.

Values are printed as UTF-8 with undecodable bytes replaced, and their true byte length is printed
alongside. The replacement is a property of THIS SCRIPT'S DISPLAY and not of the pipeline: the
importer's seam and the exporter's both carry bytes, so a value that does not decode here still
travelled unchanged. If the two numbers on a line disagree with what you expected, trust the length.

The broker address differs by where you are standing. From the host the container publishes
localhost:19092; from inside the kind cluster it is skp-kafka:9092. This script runs on the host.

Usage:
    python tools/kafka-consume-records.py --topic skp-exports
    python tools/kafka-consume-records.py --topic skp-paths --count 5
    python tools/kafka-consume-records.py --topic skp-exports --from latest --timeout 60
"""

import argparse
import sys
import uuid

try:
    from confluent_kafka import Consumer, KafkaError
except ImportError:  # pragma: no cover - a setup error, not a runtime one
    sys.exit("confluent-kafka is not installed. Run: python -m pip install confluent-kafka")


DEFAULT_BROKERS = "localhost:19092"
DEFAULT_TOPIC = "skp-exports"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--brokers", default=DEFAULT_BROKERS)
    parser.add_argument("--topic", default=DEFAULT_TOPIC)
    parser.add_argument("--count", type=int, default=10, help="stop after this many records")
    parser.add_argument(
        "--from", dest="offset_reset", choices=("earliest", "latest"), default="earliest")
    parser.add_argument(
        "--timeout", type=float, default=15.0,
        help="give up after this many seconds without a record")
    args = parser.parse_args()

    consumer = Consumer({
        "bootstrap.servers": args.brokers,
        # A fresh group every run, so this never inherits or leaves a committed position.
        "group.id": f"peek-{uuid.uuid4().hex}",
        "auto.offset.reset": args.offset_reset,
        "enable.auto.commit": False,
    })
    consumer.subscribe([args.topic])

    seen = 0
    try:
        while seen < args.count:
            # One poll of the whole timeout rather than a loop of short ones: a subscribe is followed
            # by a group join, and the first poll after it legitimately returns nothing for as long as
            # the broker's initial rebalance delay -- three seconds by default. Short polls would read
            # that as an empty topic and give up before the assignment landed.
            message = consumer.poll(args.timeout)
            if message is None:
                break

            if message.error():
                if message.error().code() == KafkaError._PARTITION_EOF:
                    continue
                sys.exit(f"consume failed: {message.error()}")

            value = message.value() or b""
            text = value.decode("utf-8", errors="replace")
            print(f"{message.topic()} [{message.partition()}] @{message.offset()}  "
                  f"{len(value)} bytes  {text}")
            seen += 1
    finally:
        consumer.close()

    if seen == 0:
        print(f"nothing on {args.topic} within {args.timeout}s", file=sys.stderr)
        return 1

    print(f"read {seen} record(s) from {args.topic}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
