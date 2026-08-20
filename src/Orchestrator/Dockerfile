# Build context is the REPO ROOT, not this directory:
#   docker build -f src/Orchestrator/Dockerfile -t orchestrator:local .
#
# The runtime base is aspnet, not runtime: BaseConsole.Core carries a FrameworkReference on
# Microsoft.AspNetCore.App for the embedded Kestrel that serves the health probes, and that needs the
# ASP.NET Core shared framework present. A plain runtime image builds fine and fails at first start.
#
# There is no SourceHash step here, unlike the processor's Dockerfile. That hash exists so a
# processor image can be matched to a registered database row; this replica's identity is its
# StatefulSet pod name, handed to it by the downward API, and it has nothing to register.
FROM mcr.microsoft.com/dotnet/sdk:8.0-bookworm-slim AS build
WORKDIR /src

# Restore first, from csproj and lock files only, so a source-only edit does not invalidate the layer.
# The local nugets/ feed plus NuGet.config make this an offline restore.
COPY ["NuGet.config", "Directory.Packages.props", "Directory.Build.props", "global.json", "./"]
COPY nugets/ nugets/
COPY ["src/Messaging.Contracts/Messaging.Contracts.csproj", "src/Messaging.Contracts/"]
COPY ["src/Messaging.Transport/Messaging.Transport.csproj", "src/Messaging.Transport/"]
COPY ["src/BaseConsole.Core/BaseConsole.Core.csproj", "src/BaseConsole.Core/"]
COPY ["src/Orchestrator/Orchestrator.csproj", "src/Orchestrator/"]
RUN dotnet restore "src/Orchestrator/Orchestrator.csproj"

COPY src/ src/
RUN dotnet publish "src/Orchestrator/Orchestrator.csproj" \
      -c Release -o /publish --no-restore /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:8.0-bookworm-slim AS runtime
WORKDIR /app
COPY --from=build /publish .
USER app
# The health listener binds this itself from ConsoleHealth:Port; EXPOSE is documentation for a reader.
EXPOSE 8081
ENTRYPOINT ["dotnet", "Orchestrator.dll"]
