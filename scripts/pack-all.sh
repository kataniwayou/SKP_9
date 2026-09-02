#!/usr/bin/env bash
#
# Packs this repo's own libraries, in dependency order, into each project's nuget/<version>/ folder.
#
# Run this after changing any library. `dotnet build SK_P.sln` does NOT pack: packing is a separate,
# deliberate act, so a library edit that has not been packed leaves consumers compiling against the
# previous package contents rather than silently rebuilding from source.
#
# Each project takes three steps and all three are required:
#
#   1. rm the extracted copy      Restore never consults a source for a version it already holds
#                                 extracted. Overwriting the .nupkg alone reaches no consumer --
#                                 proven by deleting a feed entirely and watching restore succeed.
#
#   2. restore --force-evaluate   packages.lock.json pins a contentHash per package. A repacked
#                                 1.0.0 differs from the recorded hash and fails NU1403 until the
#                                 lock is regenerated. This is the guard that makes a stale package
#                                 impossible to use by accident, not a nuisance to work around.
#
#   3. pack -c Release            The images publish Release, so Release is what must ship. Packing
#                                 Debug puts Debug assemblies in the package and therefore in the
#                                 container.
#
# The version is fixed at 1.0.0 and overwritten in place. Bumping it, and updating the
# VersionOverride in each consuming csproj, is a deliberate choice rather than something this script
# infers.
set -euo pipefail

cd "$(dirname "$0")/.."

LIBS=(Messaging.Contracts Messaging.Transport BaseConsole.Core BaseApi.Core BaseProcessor.Core)
VERSION=1.0.0

for p in "${LIBS[@]}"; do
  lower=$(echo "$p" | tr '[:upper:]' '[:lower:]')
  echo "=== $p"
  rm -rf "${NUGET_PACKAGES:-$HOME/.nuget/packages}/$lower/$VERSION"
  dotnet restore "src/$p/$p.csproj" --force-evaluate --nologo -v q
  dotnet pack    "src/$p/$p.csproj" -c Release --no-restore --nologo -v q
done

echo "=== solution restore"
dotnet restore SK_P.sln --force-evaluate --nologo -v q

echo
echo "Packed:"
find src -path '*/nuget/*' -name '*.nupkg' | sort | sed 's/^/  /'
