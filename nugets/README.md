# `nugets/`

The offline restore feed for this repo. `NuGet.config` clears `nuget.org`, so every package the build
needs — including every transitive dependency — must have its `.nupkg` vendored here, or the Docker
build fails restoring it.

## Five packages retained with nothing currently referencing them

```
microsoft.extensions.ai.abstractions.10.5.1.nupkg
system.net.serversentevents.10.0.1.nupkg
system.text.json.10.0.6.nupkg
system.text.encodings.web.10.0.6.nupkg
system.io.pipelines.10.0.6.nupkg
```

They arrived as the transitive closure of the Anthropic SDK package that `Processor.Analyst` used before
its backend was swapped to Kimi K3 over a plain `HttpClient` (see
`docs/superpowers/specs/2026-09-25-analyst-kimi-k3-backend-design.md`). The Anthropic package itself was
removed from `Directory.Packages.props` and `Processor.Analyst.csproj` when the adapter was deleted; these
five were its dependencies, not depended on directly, and no tracked `packages.lock.json` in the repo
references any of them.

**They are kept, not removed.** Deleting a vendored package from an offline-restore repository is exactly
the kind of change that fails much later, on a machine with no way to fetch a replacement, and the only
gain from removing them is tidiness. Offline restore is the constraint that makes deletion risky, so it
stays undone until something concrete needs the space.
