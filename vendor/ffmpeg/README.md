# Vendored ffmpeg

`Processor.SKNormalizer` converts audio by starting `ffmpeg` as a child process — see
`Services/FfmpegAudioTranscoder.cs`, "the ONLY place in this processor that starts a process". This
directory is where that binary comes from.

## Why it is committed rather than installed

The image used to run `apt-get install ffmpeg`. That put a network call in the one place this repo
refuses to have one: `NuGet.config` clears nuget.org and restores from the committed `nugets/`
folder feed, so a disconnected machine can build every assembly here — and then the SKNormalizer
image build reached out to `deb.debian.org` anyway. Committing the binary closes that hole the same
way `nugets/` closes the package one.

It is also much smaller. Debian's `ffmpeg` is a 293 KB binary that links **215 shared libraries**;
installing it took `processor-sknormalizer:local` from ~328 MB (what every sibling processor's image
weighs) to **914 MB**. This binary is 141 MB with nothing beside it, and the image now measures
**530 MB**.

## What is here

| | |
|---|---|
| version | `n8.1.3-20260921` (FFmpeg 8.1 release branch) |
| source | [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds), asset `ffmpeg-n8.1-latest-linux64-lgpl-8.1.tar.xz` |
| variant | **lgpl**, non-shared |
| sha256 | `c52d9dd02bb63874f9d2c5ab96c96f043ca450f4ec6ecdf495a0c93659be1066` |
| size | 140,970,184 bytes (141 MB) |

Only `bin/ffmpeg` is taken. The archive also carries `ffprobe` and `ffplay`; nothing here runs
either, and the transcoder deliberately parses duration, bitrate and codec out of ffmpeg's own
stderr rather than paying for a second process.

"Non-shared" is a requirement, not a preference: the Dockerfile copies one file. A `-shared` asset
links against libraries that ship beside it and would fail to start.

Despite the name these builds are not fully static — `file` reports a dynamically linked PIE against
glibc. That is fine and is checked: the binary is verified to run inside
`mcr.microsoft.com/dotnet/aspnet:8.0-bookworm-slim`, which is the runtime stage it lands in.

## Why the lgpl variant when the deployment is internal

**Nothing obliges it today.** Both GPL and LGPL trigger on distribution, this image never leaves the
cluster, and FFmpeg is not AGPL — so running it here is not distribution and neither licence asks
anything.

The variant is pinned anyway, for two reasons. The first is that "internal only" is a fact about
today: finding a GPL binary baked into the image the week someone decides to ship it is a bad week,
and the cost of avoiding that is choosing a different URL once. The second is that nothing is given
up by choosing it — `AcmeHandler.ProfileFor` names `-c:a libmp3lame -b:a 192k`, libmp3lame is LGPL,
and this build has it. What the gpl variants add is x264, x265 and xvid, which no `AudioProfile` in
this solution names.

For the record, the build carries `--enable-version3`, so the applicable terms are LGPL **v3**, and
it is explicitly `--disable-libfdk-aac` — the non-free encoder nobody may redistribute — as well as
`--disable-libx264 --disable-libx265 --disable-libxvid`.

**The Dockerfile re-checks this at build time** rather than trusting this file: it greps the
configure line for `--enable-gpl` and `--enable-nonfree` and fails the build on either. A refresh
that quietly grabs the wrong asset breaks the build instead of the licence position.

## Refreshing it

`tools/fetch-ffmpeg.ps1`, from a machine with a connection. It downloads the asset, extracts
`bin/ffmpeg`, and rewrites `ffmpeg.sha256`. Update the table above afterwards.

**The checksum is the pin, not the URL.** BtbN's `n8.1-latest` tag moves — it is the latest build of
the 8.1 branch, not one immutable artefact — so what makes this copy reproducible is the committed
`ffmpeg.sha256`, and a refresh that changes the binary shows up as a change to that file. That is
the line a reviewer should look at.

## One layer, not two

The Dockerfile uses `COPY --chmod=0755` straight to `/usr/local/bin/ffmpeg`. Staging the file and
then `install`ing it reads more naturally and is wrong here: `COPY` keeps its own copy even when the
next layer deletes it, so the image carried **282 MB** of ffmpeg for a 141 MB binary. `docker history`
shows it — the RUN layer is 8 kB now and was 141 MB before.

## Cost to carry

141 MB in git, and every future refresh adds another blob of that size to history — the repo already
carries `nugets/` at ~150 MB, so this is the established shape rather than a new one, but it is not
free. If history size becomes a problem, this directory is the obvious candidate for git-lfs; the
repo uses none today.
