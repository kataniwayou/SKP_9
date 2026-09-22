# Build context is the REPO ROOT, not this directory:
#   docker build -f src/Processor.SKNormalizer/Dockerfile -t processor-sknormalizer:local .
#
# The runtime base is aspnet, not runtime: BaseConsole.Core carries a FrameworkReference on
# Microsoft.AspNetCore.App for the embedded Kestrel that serves the health probes, and that needs the
# ASP.NET Core shared framework present. A plain runtime image builds fine and fails at first start.
#
# The SourceHash target runs inside the publish below, so the identity this processor claims is
# computed on Linux here and on the developer's machine there. The target normalises line endings and
# path separators precisely so those two agree — if they ever diverge, a locally registered processor
# row will not match the deployed container and discovery will retry forever.
FROM mcr.microsoft.com/dotnet/sdk:8.0-bookworm-slim AS build
WORKDIR /src

# Restore first, from csproj and lock files only, so a source-only edit does not invalidate the layer.
# The local nugets/ feed plus NuGet.config make this an offline restore.
COPY ["NuGet.config", "Directory.Packages.props", "Directory.Build.props", "global.json", "./"]
COPY nugets/ nugets/
# The repo's own libraries arrive as packages now, from each packable project's own nuget/ folder,
# so their csproj files are not copied and their sources are not built here.
#
# ALL FIVE feeds are copied, not just the ones this image consumes: NuGet validates every source in
# NuGet.config at restore and fails one that is missing (NU1301), whether or not the project resolves
# anything from it. They are a few hundred KB in total.
#
# Copied BEFORE restore, because a PackageReference is resolved at restore time. Restore stays
# offline -- every source is a folder in this build context and nuget.org is cleared, so this build
# cannot reach the network.
COPY src/Messaging.Contracts/nuget/ src/Messaging.Contracts/nuget/
COPY src/Messaging.Transport/nuget/ src/Messaging.Transport/nuget/
COPY src/BaseConsole.Core/nuget/ src/BaseConsole.Core/nuget/
COPY src/BaseApi.Core/nuget/ src/BaseApi.Core/nuget/
COPY src/BaseProcessor.Core/nuget/ src/BaseProcessor.Core/nuget/
COPY ["src/Processor.SKNormalizer/Processor.SKNormalizer.csproj", "src/Processor.SKNormalizer/"]
RUN dotnet restore "src/Processor.SKNormalizer/Processor.SKNormalizer.csproj"

COPY src/Processor.SKNormalizer/ src/Processor.SKNormalizer/
RUN dotnet publish "src/Processor.SKNormalizer/Processor.SKNormalizer.csproj" \
      -c Release -o /publish --no-restore /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:8.0-bookworm-slim AS runtime
WORKDIR /app
COPY --from=build /publish .

# ffmpeg, and this is the one thing in this image that is not in any sibling processor's.
#
# A MISSING BINARY IS THE FIRST FAILURE ON A FIRST DEPLOY, and it reads like a content problem: every
# item fails conversion with a message about starting a process. FfmpegAudioTranscoder turns it into a
# NormalizationException naming SKNormalizer__FfmpegPath, which is the fix -- but not putting it here
# is how that failure happens at all.
#
# COPIED FROM vendor/, NOT apt-get, AND THE REASON IS OFFLINE BUILDS. `apt-get update` was the only
# step in any image here that reached the network, which made this the one assembly a disconnected
# machine could not produce -- while NuGet.config clears nuget.org and restores every package from
# the committed `nugets/` feed. The binary is committed for the same reason the packages are. See
# vendor/ffmpeg/README.md for the version, the licence variant and how to refresh it.
#
# It is also far smaller. Debian's ffmpeg is 293KB and links 215 shared libraries; installing it took
# this image from ~328MB, which is what every sibling processor weighs, to 914MB.
# --chmod STRAIGHT TO THE DESTINATION, and the reason is that this file is 141MB. Copying it to a
# staging directory and then `install`ing it puts it in TWO layers -- the COPY keeps its copy even
# though the next layer deletes it -- and the image carried 282MB of ffmpeg for a 141MB binary.
# Measured with `docker history` before this was collapsed into one layer.
#
# 0755 because the runtime stage runs as USER app (uid 1654): a binary without the exec bit gives
# "could not start '/usr/local/bin/ffmpeg': Permission denied", which FfmpegAudioTranscoder
# reports identically to an absent one, from a different cause.
COPY --chown=root:root --chmod=0755 vendor/ffmpeg/linux-x64/ffmpeg /usr/local/bin/ffmpeg
COPY vendor/ffmpeg/linux-x64/ffmpeg.sha256 /tmp/ffmpeg.sha256
# The integrity check replaces the package signing apt was doing: a truncated or swapped file fails
# the build here rather than every conversion at runtime. It runs from /usr/local/bin because the
# checksum file names a bare `ffmpeg`.
#
# -version PROVES IT STARTS AT BUILD TIME. A wrong-architecture download, or one linked against a
# glibc this base image does not have, passes the checksum and then fails on every item in
# production.
#
# The grep is the licence gate. Nothing obliges the lgpl variant while this deployment stays
# internal -- both licences trigger on distribution and FFmpeg is not AGPL -- but a refresh that
# grabs the wrong asset should break the build rather than the licence position on the day someone
# decides to ship. The gpl variants add x264, x265 and xvid that no AudioProfile here names;
# nonfree adds libfdk-aac, which nobody may redistribute at all.
RUN cd /usr/local/bin \
 && sha256sum -c /tmp/ffmpeg.sha256 \
 && rm -f /tmp/ffmpeg.sha256 \
 && ./ffmpeg -version | head -1 \
 && if ./ffmpeg -version | grep -qE -- '--enable-(gpl|nonfree)'; then \
        echo 'REFUSED: vendored ffmpeg is a gpl/nonfree build; see vendor/ffmpeg/README.md' >&2; \
        exit 1; \
    fi
USER app
# The health listener binds this itself from ConsoleHealth:Port; EXPOSE is documentation for a reader.
EXPOSE 8081
ENTRYPOINT ["dotnet", "Processor.SKNormalizer.dll"]
