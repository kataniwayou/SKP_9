# The Anthropic package in the offline feed

`Processor.Analyst` is the only consumer. The package and its full transitive closure are committed
here because `NuGet.config` clears nuget.org — an un-vendored package fails the Docker build, which
restores from this folder and cannot reach the network.

To refresh: on a connected machine, `dotnet add package Anthropic` in a scratch net8.0 console app,
`dotnet list package --include-transitive`, and copy every resolved `.nupkg` that is not already in
`nugets/` from `~/.nuget/packages/`. Then bump the pin in `Directory.Packages.props` and run
`dotnet restore` from inside the repo to prove the closure is complete.

Resolved version at time of vendoring: 12.50.0

## Verdict

Restored cleanly on `net8.0`. No `NU1202` — the package supports `net8.0` directly (verified via
`dotnet add package Anthropic` against a scratch `net8.0` console app on a connected machine, and
confirmed with `dotnet restore` producing `Package 'Anthropic' is compatible with all the specified
frameworks`).

## Transitive closure vendored alongside `Anthropic 12.50.0`

- `Microsoft.Extensions.AI.Abstractions` 10.5.1
- `System.IO.Pipelines` 10.0.6 (the repo already carries `System.IO.Pipelines` 8.0.0 for another
  consumer; both versions coexist in this flat-file feed since nothing here pins `System.IO.Pipelines`
  centrally)
- `System.Net.ServerSentEvents` 10.0.1
- `System.Text.Encodings.Web` 10.0.6
- `System.Text.Json` 10.0.6

## Verification performed

1. `dotnet restore src/Processor.SKNormalizer/Processor.SKNormalizer.csproj` with a temporary
   `<PackageReference Include="Anthropic" />` added to that project, from inside the repo (so the
   repo's offline `NuGet.config` — six folder sources, nuget.org cleared — applied): **0 warnings,
   0 errors**, no `NU1101`, no `NU1604`.
2. Repeated with `NUGET_PACKAGES` pointed at a brand-new empty directory (bypassing the developer's
   warm `~/.nuget/packages` cache entirely), to prove the six `.nupkg` files in this folder are
   genuinely sufficient on their own, not merely because the cache from the connected-machine probe
   was still warm. Restore still succeeded with 0 warnings/errors, and the fresh cache directory
   afterward contained `anthropic`, `microsoft.extensions.ai.abstractions`, `system.io.pipelines`,
   `system.net.serversentevents`, `system.text.encodings.web`, and `system.text.json` — pulled only
   from the `nugets/` folder source, since that is the only source `NuGet.config` allows for
   non-in-repo package IDs.
3. The temporary `PackageReference` was removed from `Processor.SKNormalizer.csproj` and the project
   restored again to confirm a clean, unmodified working tree (`git diff` on the csproj is empty,
   and its `packages.lock.json` no longer references `Anthropic`).

No `PackageVersion` pins were needed for the five transitive packages: this SDK's central package
management resolves them as ordinary `Transitive` lock-file entries, not `CentralTransitive` ones, so
only the direct `Anthropic` pin in `Directory.Packages.props` was required.
