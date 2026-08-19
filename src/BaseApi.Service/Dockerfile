# Build context is the REPO ROOT, not this directory:
#   docker build -f src/BaseApi.Service/Dockerfile -t baseapi-service:local .
FROM mcr.microsoft.com/dotnet/sdk:8.0-bookworm-slim AS build
WORKDIR /src

# Restore first, from csproj and lock files only, so a source-only edit does not invalidate the layer.
COPY ["NuGet.config", "Directory.Packages.props", "Directory.Build.props", "global.json", "./"]
COPY nugets/ nugets/
COPY ["src/Messaging.Contracts/Messaging.Contracts.csproj", "src/Messaging.Contracts/"]
COPY ["src/Messaging.Transport/Messaging.Transport.csproj", "src/Messaging.Transport/"]
COPY ["src/BaseApi.Core/BaseApi.Core.csproj", "src/BaseApi.Core/"]
COPY ["src/BaseApi.Service/BaseApi.Service.csproj", "src/BaseApi.Service/"]
RUN dotnet restore "src/BaseApi.Service/BaseApi.Service.csproj"

COPY src/ src/
RUN dotnet publish "src/BaseApi.Service/BaseApi.Service.csproj" \
      -c Release -o /publish --no-restore /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:8.0-bookworm-slim AS runtime
WORKDIR /app
COPY --from=build /publish .
USER app
ENV ASPNETCORE_URLS=http://+:8080
EXPOSE 8080
ENTRYPOINT ["dotnet", "BaseApi.Service.dll"]
