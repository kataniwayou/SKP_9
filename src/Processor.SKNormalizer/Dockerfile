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
# NormalizationException naming SKNormalizer__FfmpegPath, which is the fix — but not installing it
# here is how that failure happens at all.
#
# --no-install-recommends keeps this to the codecs and their libraries rather than pulling an X11
# stack into a headless container.
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*
USER app
# The health listener binds this itself from ConsoleHealth:Port; EXPOSE is documentation for a reader.
EXPOSE 8081
ENTRYPOINT ["dotnet", "Processor.SKNormalizer.dll"]
