#!/usr/bin/env python3
"""
Builds the wav-plus-sidecar zip archives Processor.SKNormalizer's AcmeHandler expects as input.

Nothing in this repo builds those archives today: the input zips are hand-placed into the kind
node with docker cp, and tools/kafka-produce-records.py seeds Kafka with paths to them, not the
files themselves. This is the tool that produces the files those paths need to resolve to.

EACH ARCHIVE IS EXACTLY TWO ENTRIES SHARING A BASENAME, AND NOTHING ELSE. AcmeHandler.Locate groups
an archive's root entries by basename (case-insensitively) into one SourceItem per basename, so the
audio and its sidecar must be named e.g. track01.wav and track01.json -- not audio.wav and
meta.json, which would become two unrelated one-node items instead of one paired item.
AcmeHandler.ValidateContent then rejects any item whose node count is not exactly 2, so a third
entry (a directory entry, a __MACOSX resource fork, a stray readme) fails the whole item even though
the pair inside it is fine. This tool writes only the two entries and nothing more.

THE JSON MUST MATCH WHAT AcmeHandler ACTUALLY DESERIALIZES INTO, KEY FOR KEY. It reads the sidecar
with PropertyNamingPolicy = JsonNamingPolicy.CamelCase and PropertyNameCaseInsensitive = true, into

    private sealed record AcmeSidecar(
        string? Title, string? Artist, string? Album,
        DateTimeOffset? RecordedUtc, AcmeSidecarAudio? Audio);

    private sealed record AcmeSidecarAudio(
        [property: JsonPropertyName("file")] string? File,
        int? SampleRateHz, int? Channels, double? DurationSeconds);

so the keys written here are exactly title, artist, album, recordedUtc, and a nested audio object
with file, sampleRateHz, channels, durationSeconds. A sidecar with the wrong shape does not fail
loudly at build time -- it deserializes to nulls or throws deep in the pipeline at dispatch, which is
the worst place to find out. If AcmeHandler.cs ever changes this record, this docstring and the
sidecar this tool writes both drift out of date with it.

THE SIDECAR'S AUDIO FACTS MUST AGREE WITH THE WAV ACTUALLY WRITTEN. sampleRateHz, channels and
durationSeconds are read back off the wave.Wave_write instance this tool just wrote, not restated as
literals, so the numbers a downstream reader trusts are never able to drift from the bytes that back
them. A sidecar that lies about its own audio is exactly the bug this tool exists to keep out of
every fixture built with it.

The .wav is a real, playable RIFF/WAVE file -- a short sine tone at 44100 Hz, 2 channels, 16-bit --
written with the stdlib wave module, not a stub. The point is that a real ffmpeg could convert it
later, once a handler exists that sets a ProfileFor; a zero-byte or fake-header file would not
survive that test even though it would satisfy AcmeHandler today, which never opens the audio bytes.

THE ARCHIVES THIS WRITES MUST STILL BE PUT ON THE NODE BY HAND -- this tool only writes to a local
directory. FileFetcher opens a path inside the cluster, so a generated archive sitting on the host
fails the fetch until it is copied in, e.g.

    docker cp ./out/file-001.zip desktop-control-plane:/mnt/skp-files/in/file-001.zip

matching the path tools/kafka-produce-records.py seeds onto Kafka. Note the fetcher step in the
split chain is wired allowedExtensions: [".zip"], so the archive must keep the .zip extension all
the way from --out through the docker cp destination or it is refused by the whitelist before a byte
is read.

Usage:
    python tools/make-sample-archives.py --count 2 --out ./out
    python tools/make-sample-archives.py --count 5 --out ./out --prefix batch07
"""

import argparse
import json
import math
import struct
import wave
import zipfile
from io import BytesIO
from pathlib import Path

SAMPLE_RATE_HZ = 44100
CHANNELS = 2
SAMPLE_WIDTH_BYTES = 2  # 16-bit
TONE_HZ = 440.0
DURATION_SECONDS = 1.5
AMPLITUDE = 0.3  # of full scale, to leave headroom and avoid clipping on int16 rounding


def build_wav_bytes():
    """Renders a short sine tone as real RIFF/WAVE bytes via the wave module, and returns them
    alongside the sample rate, channel count and duration actually written -- so the sidecar this
    tool emits states facts read off these bytes rather than restated literals that could drift."""
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

    # Read the facts back off what was actually written, not off the constants above -- this is
    # the value that keeps the sidecar honest about the audio it describes.
    with wave.open(BytesIO(wav_bytes)) as reader:
        actual_rate = reader.getframerate()
        actual_channels = reader.getnchannels()
        actual_duration = reader.getnframes() / actual_rate

    return wav_bytes, actual_rate, actual_channels, actual_duration


def build_sidecar_bytes(index, audio_filename, sample_rate, channels, duration):
    """The JSON AcmeHandler.Map deserializes into AcmeSidecar / AcmeSidecarAudio. Keys are exactly
    title, artist, album, recordedUtc and a nested audio object with file, sampleRateHz, channels,
    durationSeconds -- see the module docstring for why those five names are not negotiable.

    title varies per archive so a multi-archive run is distinguishable downstream."""
    sidecar = {
        "title": f"Sample Track {index:03d}",
        "artist": "Acme Test Artist",
        "album": "SKP Seed Archives",
        "recordedUtc": "2026-09-12T00:00:00Z",
        "audio": {
            "file": audio_filename,
            "sampleRateHz": sample_rate,
            "channels": channels,
            "durationSeconds": duration,
        },
    }
    return json.dumps(sidecar, indent=2).encode("utf-8")


def build_archive(index):
    """One archive's bytes: exactly two entries, track01.wav and track01.json, sharing the
    basename Locate pairs on -- and nothing else, since ValidateContent rejects any item whose
    node count is not exactly 2."""
    audio_filename = "track01.wav"
    sidecar_filename = "track01.json"

    wav_bytes, rate, channels, duration = build_wav_bytes()
    sidecar_bytes = build_sidecar_bytes(index, audio_filename, rate, channels, duration)

    buffer = BytesIO()
    # ZIP_STORED, and only the two named entries -- no directory entries, no extra metadata nodes,
    # so the archive's root has exactly the two children ValidateContent requires.
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_STORED) as archive:
        archive.writestr(audio_filename, wav_bytes)
        archive.writestr(sidecar_filename, sidecar_bytes)

    return buffer.getvalue()


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--count", type=int, default=1, help="how many archives to write")
    parser.add_argument("--out", default="./out", help="directory to write archives into")
    parser.add_argument("--prefix", default="file", help="archive filename prefix")
    args = parser.parse_args()

    if args.count < 1:
        raise SystemExit("--count must be at least 1")

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    written = []
    for i in range(1, args.count + 1):
        archive_bytes = build_archive(i)
        path = out_dir / f"{args.prefix}-{i:03d}.zip"
        path.write_bytes(archive_bytes)
        written.append(path)

    for path in written:
        print(path)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
