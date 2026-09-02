# Build context is the REPO ROOT, not this directory:
#   docker build -f src/BaseApi.Service/Dockerfile -t baseapi-service:local .
FROM mcr.microsoft.com/dotnet/sdk:8.0-bookworm-slim AS build
WORKDIR /src

# Restore first, from csproj and lock files only, so a source-only edit does not invalidate the layer.
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
COPY ["src/BaseApi.Service/BaseApi.Service.csproj", "src/BaseApi.Service/"]
RUN dotnet restore "src/BaseApi.Service/BaseApi.Service.csproj"

COPY src/BaseApi.Service/ src/BaseApi.Service/
RUN dotnet publish "src/BaseApi.Service/BaseApi.Service.csproj" \
      -c Release -o /publish --no-restore /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:8.0-bookworm-slim AS runtime
WORKDIR /app
COPY --from=build /publish .
USER app
ENV ASPNETCORE_URLS=http://+:8080
EXPOSE 8080
ENTRYPOINT ["dotnet", "BaseApi.Service.dll"]
