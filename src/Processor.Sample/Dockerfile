# Build context is the REPO ROOT, not this directory:
#   docker build -f src/Processor.Sample/Dockerfile -t processor-sample:local .
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
COPY ["src/Messaging.Contracts/Messaging.Contracts.csproj", "src/Messaging.Contracts/"]
COPY ["src/Messaging.Transport/Messaging.Transport.csproj", "src/Messaging.Transport/"]
COPY ["src/BaseConsole.Core/BaseConsole.Core.csproj", "src/BaseConsole.Core/"]
COPY ["src/BaseProcessor.Core/BaseProcessor.Core.csproj", "src/BaseProcessor.Core/"]
COPY ["src/Processor.Sample/Processor.Sample.csproj", "src/Processor.Sample/"]
RUN dotnet restore "src/Processor.Sample/Processor.Sample.csproj"

COPY src/ src/
RUN dotnet publish "src/Processor.Sample/Processor.Sample.csproj" \
      -c Release -o /publish --no-restore /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:8.0-bookworm-slim AS runtime
WORKDIR /app
COPY --from=build /publish .
USER app
# The health listener binds this itself from ConsoleHealth:Port; EXPOSE is documentation for a reader.
EXPOSE 8081
ENTRYPOINT ["dotnet", "Processor.Sample.dll"]
