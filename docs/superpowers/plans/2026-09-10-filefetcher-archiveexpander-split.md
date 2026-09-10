# FileFetcher / ArchiveExpander Split — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `Processor.FileReader` into `Processor.FileFetcher` (path → bytes, behind an extension whitelist and a size range) and `Processor.ArchiveExpander` (bytes → the same document it emits today), joined by a JSON envelope that carries the file's identity alongside its content.

**Architecture:** Two processors where there was one, cut at the seam `FileReaderProcessor` already has — everything above the `builder.Build(...)` call becomes `FileFetcher`, everything below becomes `ArchiveExpander`. They are joined by a `{fileName, extension, sizeBytes, createdUtc, modifiedUtc, content}` document, registered as the fetcher's output schema and the expander's input schema. Both are plain downstream transforms passing the dispatch's own `executionId` through, so one dispatch remains one lineage. `ArchiveExpander`'s output document and `schema/output.json` are unchanged — nothing downstream sees the split.

**Tech Stack:** .NET 8, `BaseProcessor.Core` (unchanged), `System.Text.Json`, `SharpCompress` (RAR only), xunit on Microsoft.Testing.Platform, NSubstitute, kind + kubectl.

**Spec:** `docs/superpowers/specs/2026-09-10-filefetcher-archiveexpander-split-design.md`

## Global Constraints

- **`BaseProcessor.Core` is not modified.** Every change lands in author code, a manifest, or a schema row.
- **`net8.0`, `Nullable`, `ImplicitUsings`, `TreatWarningsAsErrors`** come from `Directory.Build.props`; package versions from `Directory.Packages.props`. Never declare either in a `.csproj`.
- **Neither processor logs a failure.** `ProcessDispatchHandler` catches `FailedException` and writes the author's message verbatim at Information. A log line before a throw emits every failure twice.
- **Failure message templates are the operator-facing contract.** Where this plan gives an exact string, it is exact.
- **Log the shape, never the content.** A name, a size, a count and a depth are safe. File bytes stay out of every template.
- **`ArchiveExpander/schema/output.json` and the output document are unchanged.** Any task that alters either has gone wrong.
- **Both processors pass `executionId` through.** No `NewExecutionId()` anywhere in this plan.
- **Whitelist sentinel is the exact string `*.*`.** It is not a glob; no other `*` pattern is recognised.
- **Default expansion ceiling stays `33554432`** so the split preserves today's behaviour exactly.
- **Run the full hermetic suite from the repo root:** `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`. Read the shape of the result — `0 failed`, exit 0, with every `Live/` test skipped. Do not compare against a remembered total; the total only grows. The `--filter` flag is silently ignored under Microsoft.Testing.Platform here, so every run is the whole suite.

---

## File Structure

**New — `src/Processor.FileFetcher/`**

| File | Responsibility |
|---|---|
| `Processor.FileFetcher.csproj` | Project, `InternalsVisibleTo(BaseApi.Tests)`, content copy for `appsettings.json` and `schema/output.json` |
| `Program.cs` | Signal registration and host start |
| `ProcessorHost.cs` | Composition root |
| `appsettings.json` | Local defaults, including the `FileFetcher` section |
| `Dockerfile` | Offline restore + publish, repo root as build context |
| `FileFetcherProcessor.cs` | Validate payload → read path → inspect dry → read bytes → emit envelope |
| `FileFetcherConfig.cs` | The step payload record |
| `FileFetcherOptions.cs` | The pod ceiling, from `FileFetcher__MaxFileSizeBytes` |
| `FileLocator.cs` | The input contract, `{filePath}` |
| `FetchedFile.cs` | The envelope this processor writes, plus its serializer options |
| `ExtensionWhitelist.cs` | Resolve, well-formedness, admission, description |
| `schema/output.json` | The envelope, registered against this processor's identity |
| `schema/README.md` | What the envelope asserts and why |

**Renamed — `src/Processor.FileReader/` → `src/Processor.ArchiveExpander/`**

| File | Change |
|---|---|
| `ArchiveExpanderProcessor.cs` | Was `FileReaderProcessor`. Loses `Inspect`, `Read`, `Rejected`, `Unreadable`; `ReadPath` becomes `ReadEnvelope` |
| `ArchiveExpanderConfig.cs` | Was `FileReaderConfig`. `MaxDepth` only |
| `ArchiveExpanderOptions.cs` | Was `FileReaderOptions`. `MaxExpandedBytes` replaces `MaxFileSizeBytes` |
| `FetchedFile.cs` | New. The wire form (all optional) and `SourceFile` (validated) |
| `FileContentBuilder.cs` | `Build` takes a `SourceFile`; `ExpansionBudget` is built from the pod option |
| `FileNode.cs`, `Extractors/*`, `schema/output.json` | Unchanged |
| `schema/input.json` | New. Byte-identical to the fetcher's `output.json` |
| `FileLocator.cs` | Deleted — it moves to the fetcher |

**Manifests:** `k8s/38-processor-filefetcher.yaml` (new, takes the volume), `k8s/37-processor-filereader.yaml` → `k8s/37-processor-archiveexpander.yaml`.

**Tests — `src/tests/BaseApi.Tests/`:** `FileReader/` splits into `FileFetcher/` and `ArchiveExpander/`; `Live/FileReader/` into `Live/FileFetcher/` and `Live/ArchiveExpander/`.

**Task order builds the fetcher before stripping the expander**, so no extension or size coverage is ever absent from the suite.

---

## Task 1: Rename FileReader to ArchiveExpander

A pure rename. No behaviour changes, no signature changes, no schema changes. The suite is green at the end with the same number of tests it started with.

**Files:**
- Rename dir: `src/Processor.FileReader/` → `src/Processor.ArchiveExpander/`
- Rename: `Processor.FileReader.csproj` → `Processor.ArchiveExpander.csproj`
- Rename: `FileReaderProcessor.cs` → `ArchiveExpanderProcessor.cs`
- Rename: `FileReaderConfig.cs` → `ArchiveExpanderConfig.cs`
- Rename: `FileReaderOptions.cs` → `ArchiveExpanderOptions.cs`
- Modify: `ProcessorHost.cs`, `Program.cs`, `Dockerfile`, `appsettings.json`
- Rename dir: `src/tests/BaseApi.Tests/FileReader/` → `src/tests/BaseApi.Tests/ArchiveExpander/`
- Rename dir: `src/tests/BaseApi.Tests/Live/FileReader/` → `src/tests/BaseApi.Tests/Live/ArchiveExpander/`
- Modify: `SK_P.sln`

**Interfaces:**
- Consumes: nothing.
- Produces: namespace `Processor.ArchiveExpander`; types `ArchiveExpanderProcessor`, `ArchiveExpanderConfig` (still with `ExpectedExtension`, `MinimumSizeBytes`, `MaximumSizeBytes`, `MaxDepth`), `ArchiveExpanderOptions.MaxFileSizeBytes`, `FileContentBuilder`, `FileNode`, `FileDocument.Options`, `IArchiveExtractor`. Test namespace `BaseApi.Tests.ArchiveExpander`.

- [ ] **Step 1: Move the directories with git so history follows**

```bash
git mv src/Processor.FileReader src/Processor.ArchiveExpander
git mv src/Processor.ArchiveExpander/Processor.FileReader.csproj src/Processor.ArchiveExpander/Processor.ArchiveExpander.csproj
git mv src/Processor.ArchiveExpander/FileReaderProcessor.cs src/Processor.ArchiveExpander/ArchiveExpanderProcessor.cs
git mv src/Processor.ArchiveExpander/FileReaderConfig.cs src/Processor.ArchiveExpander/ArchiveExpanderConfig.cs
git mv src/Processor.ArchiveExpander/FileReaderOptions.cs src/Processor.ArchiveExpander/ArchiveExpanderOptions.cs
git mv src/tests/BaseApi.Tests/FileReader src/tests/BaseApi.Tests/ArchiveExpander
git mv src/tests/BaseApi.Tests/Live/FileReader src/tests/BaseApi.Tests/Live/ArchiveExpander
```

- [ ] **Step 2: Rewrite the identifiers**

Apply these substitutions across `src/Processor.ArchiveExpander/`, `src/tests/BaseApi.Tests/ArchiveExpander/`, `src/tests/BaseApi.Tests/Live/ArchiveExpander/`, in this order (longest first, so no substitution eats another):

| From | To |
|---|---|
| `Processor.FileReader` | `Processor.ArchiveExpander` |
| `FileReaderProcessor` | `ArchiveExpanderProcessor` |
| `FileReaderConfig` | `ArchiveExpanderConfig` |
| `FileReaderOptions` | `ArchiveExpanderOptions` |
| `FileReaderDepthTests` | `ArchiveExpanderDepthTests` |
| `FileReaderDocumentTests` | `ArchiveExpanderDocumentTests` |
| `FileReaderGuardTests` | `ArchiveExpanderGuardTests` |
| `FileReaderLocatorTests` | `ArchiveExpanderLocatorTests` |
| `FileReaderSchemaTests` | `ArchiveExpanderSchemaTests` |
| `ProcessorFileReaderTests` | `ProcessorArchiveExpanderTests` |
| `FileReaderLiveTests` | `ArchiveExpanderLiveTests` |
| `BaseApi.Tests.FileReader` | `BaseApi.Tests.ArchiveExpander` |
| `BaseApi.Tests.Live.FileReader` | `BaseApi.Tests.Live.ArchiveExpander` |
| `FileReader__MaxFileSizeBytes` | `ArchiveExpander__MaxFileSizeBytes` |
| `processor-filereader` | `processor-archiveexpander` |
| `file-reader` | `archive-expander` |
| `"FileReader"` | `"ArchiveExpander"` |
| `skp-filereader-` | `skp-archiveexpander-` |

```bash
cd src && for d in Processor.ArchiveExpander tests/BaseApi.Tests/ArchiveExpander tests/BaseApi.Tests/Live/ArchiveExpander; do
  find "$d" -type f \( -name '*.cs' -o -name '*.csproj' -o -name '*.json' -o -name 'Dockerfile' \) -print0 \
  | xargs -0 sed -i \
    -e 's/Processor\.FileReader/Processor.ArchiveExpander/g' \
    -e 's/FileReaderProcessor/ArchiveExpanderProcessor/g' \
    -e 's/FileReaderConfig/ArchiveExpanderConfig/g' \
    -e 's/FileReaderOptions/ArchiveExpanderOptions/g' \
    -e 's/FileReaderDepthTests/ArchiveExpanderDepthTests/g' \
    -e 's/FileReaderDocumentTests/ArchiveExpanderDocumentTests/g' \
    -e 's/FileReaderGuardTests/ArchiveExpanderGuardTests/g' \
    -e 's/FileReaderLocatorTests/ArchiveExpanderLocatorTests/g' \
    -e 's/FileReaderSchemaTests/ArchiveExpanderSchemaTests/g' \
    -e 's/ProcessorFileReaderTests/ProcessorArchiveExpanderTests/g' \
    -e 's/FileReaderLiveTests/ArchiveExpanderLiveTests/g' \
    -e 's/BaseApi\.Tests\.FileReader/BaseApi.Tests.ArchiveExpander/g' \
    -e 's/BaseApi\.Tests\.Live\.FileReader/BaseApi.Tests.Live.ArchiveExpander/g' \
    -e 's/FileReader__MaxFileSizeBytes/ArchiveExpander__MaxFileSizeBytes/g' \
    -e 's/processor-filereader/processor-archiveexpander/g' \
    -e 's/file-reader/archive-expander/g' \
    -e 's/"FileReader"/"ArchiveExpander"/g' \
    -e 's/skp-filereader-/skp-archiveexpander-/g'
done; cd ..
```

- [ ] **Step 3: Rename the test class files to match their classes**

```bash
cd src/tests/BaseApi.Tests/ArchiveExpander
for n in Depth Document Guard Locator Schema; do git mv "FileReader${n}Tests.cs" "ArchiveExpander${n}Tests.cs"; done
git mv ProcessorFileReaderTests.cs ProcessorArchiveExpanderTests.cs
cd ../Live/ArchiveExpander && git mv FileReaderLiveTests.cs ArchiveExpanderLiveTests.cs
cd C:/Users/UserL/source/repos/SK_P9
```

- [ ] **Step 4: Fix the csproj identity and the solution**

In `src/Processor.ArchiveExpander/Processor.ArchiveExpander.csproj`, the `PropertyGroup` must read:

```xml
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <RootNamespace>Processor.ArchiveExpander</RootNamespace>
    <AssemblyName>Processor.ArchiveExpander</AssemblyName>
  </PropertyGroup>
```

```bash
dotnet sln SK_P.sln remove src/Processor.FileReader/Processor.FileReader.csproj 2>/dev/null || true
dotnet sln SK_P.sln add src/Processor.ArchiveExpander/Processor.ArchiveExpander.csproj
```

- [ ] **Step 4b: Fix the test project's three references to the old paths**

**Without this the build fails and Step 6 cannot pass.** `src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
names `Processor.FileReader` in three places and is outside every directory Step 2's sed touched.
Apply all three:

```xml
    <None Include="ArchiveExpander\Fixtures\*.rar" CopyToOutputDirectory="PreserveNewest" />
    <None Include="..\..\Processor.ArchiveExpander\schema\output.json"
          Link="schema\output.json" CopyToOutputDirectory="PreserveNewest" />
```

```xml
    <ProjectReference Include="..\..\Processor.ArchiveExpander\Processor.ArchiveExpander.csproj" />
```

The schema link keeps the name `schema\output.json`, so `ArchiveExpanderSchemaTests.Definition()`
needs no change. Later tasks link their own schemas under distinct names rather than moving this one.

- [ ] **Step 5: Sweep for stragglers outside the renamed directories**

```bash
grep -rn "FileReader\|filereader\|file-reader" --include='*.cs' --include='*.csproj' --include='*.json' --include='*.sln' --include='Dockerfile' src/ k8s/ | grep -v '/obj/' | grep -v '/bin/'
```

Expected: only `k8s/37-processor-filereader.yaml` (Task 6 handles it), `src/Processor.ArchiveExpander/schema/README.md` (its prose says "FileReader output schema" — change that line to "ArchiveExpander output schema"), and doc comments in `ArchiveExpanderConfig.cs` / `FileContentBuilder.cs` that reference `k8s/37-processor-filereader.yaml` by path (leave those; Task 6 repoints them). Nothing else may match.

- [ ] **Step 6: Build and run the full suite**

Run: `dotnet build SK_P.sln && dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: build succeeds with no warnings (warnings are errors here); `0 failed`, exit 0, every `Live/` test skipped.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: rename Processor.FileReader to Processor.ArchiveExpander

A pure rename ahead of the split. No behaviour, signature or schema
changes; the suite is green with the same tests it had."
```

---

## Task 2: The FileFetcher project shell and the extension whitelist

Creates the project and the one piece of pure logic in it. No processor yet — this task's deliverable is a host graph that resolves and a whitelist that is fully specified by tests.

**Files:**
- Create: `src/Processor.FileFetcher/Processor.FileFetcher.csproj`
- Create: `src/Processor.FileFetcher/Program.cs`
- Create: `src/Processor.FileFetcher/ProcessorHost.cs`
- Create: `src/Processor.FileFetcher/appsettings.json`
- Create: `src/Processor.FileFetcher/FileFetcherOptions.cs`
- Create: `src/Processor.FileFetcher/ExtensionWhitelist.cs`
- Test: `src/tests/BaseApi.Tests/FileFetcher/ExtensionWhitelistTests.cs`
- Modify: `SK_P.sln`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: namespace `Processor.FileFetcher`; `ProcessorHost.Create(string[], ProcessorIdentityFound, Action<IConfigurationBuilder>?)` and `ProcessorHost.StartAsync(...)`; `FileFetcherOptions.MaxFileSizeBytes` (long, default `33_554_432`); `ExtensionWhitelist.Wildcard` (const `"*.*"`), `.Resolve(IReadOnlyList<string>?) → IReadOnlyList<string>`, `.FirstMalformed(IReadOnlyList<string>) → string?`, `.Admits(IReadOnlyList<string>, string) → bool`, `.Describe(IReadOnlyList<string>) → string`.

- [ ] **Step 1: Write the failing whitelist tests**

Create `src/tests/BaseApi.Tests/FileFetcher/ExtensionWhitelistTests.cs`:

```csharp
using Processor.FileFetcher;
using Xunit;

namespace BaseApi.Tests.FileFetcher;

/// <summary>
/// Every row of §6 of the split design, one fact per test. This is the one component in either
/// processor whose whole behaviour is decidable without a file, a broker or a host, so it is
/// specified here rather than through the processor.
/// </summary>
public sealed class ExtensionWhitelistTests
{
    [Fact]
    public void AnAbsentListResolvesToTheWildcard()
    {
        // The stated default AND the stated fallback. The alternative — admit nothing — makes an
        // omitted field fail every file with a message about a list the author never wrote.
        Assert.Equal([ExtensionWhitelist.Wildcard], ExtensionWhitelist.Resolve(null));
    }

    [Fact]
    public void AnEmptyListResolvesToTheWildcard()
    {
        Assert.Equal([ExtensionWhitelist.Wildcard], ExtensionWhitelist.Resolve([]));
    }

    [Fact]
    public void AListIsLeftAloneWhenItHasEntries()
    {
        Assert.Equal([".zip", ".tar"], ExtensionWhitelist.Resolve([".zip", ".tar"]));
    }

    [Fact]
    public void MatchingIsCaseInsensitive()
    {
        Assert.True(ExtensionWhitelist.Admits([".zip"], ".ZIP"));
        Assert.True(ExtensionWhitelist.Admits([".ZIP"], ".zip"));
    }

    [Fact]
    public void AnExtensionOutsideTheListIsRefused()
    {
        Assert.False(ExtensionWhitelist.Admits([".zip", ".tar"], ".pdf"));
    }

    [Fact]
    public void TheWildcardAdmitsEverything()
    {
        Assert.True(ExtensionWhitelist.Admits([ExtensionWhitelist.Wildcard], ".pdf"));
        Assert.True(ExtensionWhitelist.Admits([ExtensionWhitelist.Wildcard], ".zip"));
    }

    [Fact]
    public void TheWildcardMixedWithRealEntriesStillAdmitsEverything()
    {
        // A redundant payload, not a wrong one. Rejecting it would be a rule with no failure
        // behind it.
        Assert.True(ExtensionWhitelist.Admits([".zip", ExtensionWhitelist.Wildcard], ".pdf"));
    }

    [Fact]
    public void AnExtensionlessFileIsAdmittedOnlyUnderTheWildcard()
    {
        // FileInfo.Extension is "" for a file with no dot in its name.
        Assert.True(ExtensionWhitelist.Admits([ExtensionWhitelist.Wildcard], ""));
        Assert.False(ExtensionWhitelist.Admits([".zip"], ""));
    }

    [Theory]
    [InlineData(".zip")]
    [InlineData(".ZIP")]
    [InlineData("*.*")]
    [InlineData(".tar.gz")]
    public void AWellFormedEntryIsAccepted(string entry)
    {
        Assert.Null(ExtensionWhitelist.FirstMalformed([entry]));
    }

    [Theory]
    [InlineData("zip")]
    [InlineData("*.zip")]
    [InlineData("*.z*")]
    [InlineData("*")]
    [InlineData("")]
    [InlineData("  ")]
    public void AMalformedEntryIsNamed(string entry)
    {
        // Named, not normalised. The house rule is to report the wrong value rather than quietly
        // correct it, and "*.*" is a single sentinel rather than a glob — so "*.zip" is not a
        // pattern this understands.
        Assert.Equal(entry, ExtensionWhitelist.FirstMalformed([".zip", entry]));
    }

    [Fact]
    public void TheFirstMalformedEntryIsTheOneNamed()
    {
        Assert.Equal("zip", ExtensionWhitelist.FirstMalformed([".tar", "zip", "rar"]));
    }

    [Fact]
    public void DescribeRendersTheListForAnOperator()
    {
        // The rejection names the list so nobody has to go and read the step payload.
        Assert.Equal(".zip, .tar, .csv", ExtensionWhitelist.Describe([".zip", ".tar", ".csv"]));
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: compile failure — `The type or namespace name 'Processor' could not be found` / `ExtensionWhitelist does not exist`.

- [ ] **Step 3: Create the project file**

Create `src/Processor.FileFetcher/Processor.FileFetcher.csproj`:

```xml
<Project Sdk="Microsoft.NET.Sdk">

  <!--
    A concrete processor: the filesystem half of what FileReader used to be. Like every other
    processor here it carries no identity, liveness, broker or Redis code — AddBaseProcessor folds
    all of it in.

    Common properties (net8.0, Nullable, ImplicitUsings, TreatWarningsAsErrors) come from
    Directory.Build.props, and package versions from Directory.Packages.props — never declare
    either here.

    NO SharpCompress, and no archive knowledge of any kind. This processor never looks inside a
    file; the declared-extension cross-check that needs archive signatures stays in
    ArchiveExpander, where the extension arrives alongside the bytes.
  -->

  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <RootNamespace>Processor.FileFetcher</RootNamespace>
    <AssemblyName>Processor.FileFetcher</AssemblyName>
  </PropertyGroup>

  <ItemGroup>
    <!-- FileLocator, FetchedFile and ExtensionWhitelist are internal: they are this processor's
         construction, not its surface. The tests construct them directly, so the test assembly is
         named here — matching what BaseProcessor.Core and ArchiveExpander do for the same reason. -->
    <InternalsVisibleTo Include="BaseApi.Tests" />
  </ItemGroup>

  <ItemGroup>
    <!-- The worker SDK does not copy appsettings.json on its own. -->
    <Content Include="appsettings.json" CopyToOutputDirectory="PreserveNewest" />
    <!-- The output schema travels with the processor so it can be registered from the image. -->
    <Content Include="schema\output.json" CopyToOutputDirectory="PreserveNewest" />
  </ItemGroup>

  <ItemGroup>
    <!-- The package, not a ProjectReference: SourceHash.targets ships in the package's build/
         folder and NuGet imports it automatically, stamping the hash on THIS assembly — the entry
         assembly, where the runtime reader looks. A ProjectReference could not flow build targets. -->
    <PackageReference Include="BaseProcessor.Core" VersionOverride="[1.0.0]" />
  </ItemGroup>

</Project>
```

- [ ] **Step 4: Write the whitelist**

Create `src/Processor.FileFetcher/ExtensionWhitelist.cs`:

```csharp
namespace Processor.FileFetcher;

/// <summary>
/// The admitted extensions, and the four questions anyone asks of them: what the list is when the
/// payload named none, whether every entry is well formed, whether a given extension is admitted,
/// and how to render the list to an operator.
/// <para>
/// <b>Static and file-scoped because it holds no state and touches nothing.</b> It is the only part
/// of this processor decidable without a file, a broker or a host, which is what lets §6 of the
/// design be specified exhaustively in unit tests rather than through the processor.
/// </para>
/// </summary>
internal static class ExtensionWhitelist
{
    /// <summary>
    /// The one sentinel, and it is NOT a glob.
    /// <para>
    /// No other <c>*</c> pattern is recognised: <c>*.zip</c> and <c>*.z*</c> are malformed payloads,
    /// not narrower wildcards. Admitting one pattern would put this processor in the business of
    /// implementing glob semantics, and every half-implemented glob differs from every other.
    /// </para>
    /// </summary>
    public const string Wildcard = "*.*";

    /// <summary>
    /// The effective list. <b>Absent, null or empty means <see cref="Wildcard"/></b> — the stated
    /// default and the stated fallback both.
    /// <para>
    /// This is the one place in either processor where an absent value WIDENS rather than narrows,
    /// and it is deliberate. The alternative default — admit nothing — makes an omitted field fail
    /// every file with a message about a list the author never wrote.
    /// </para>
    /// </summary>
    public static IReadOnlyList<string> Resolve(IReadOnlyList<string>? configured)
        => configured is { Count: > 0 } ? configured : [Wildcard];

    /// <summary>
    /// The first entry that is neither <see cref="Wildcard"/> nor a leading-dot extension, or null
    /// when every entry is well formed.
    /// <para>
    /// It returns the offending entry rather than a bool so the rejection can quote it. An author
    /// who wrote <c>"zip"</c> needs to see <c>"zip"</c>, not a count.
    /// </para>
    /// </summary>
    public static string? FirstMalformed(IReadOnlyList<string> whitelist)
    {
        foreach (var entry in whitelist)
        {
            if (!IsWellFormed(entry))
            {
                return entry;
            }
        }

        return null;
    }

    /// <summary>
    /// True when this extension is admitted. <paramref name="extension"/> is
    /// <c>FileInfo.Extension</c> — a leading dot, or the empty string for a name with no dot in it.
    /// <para>
    /// <b>The wildcard short-circuits from anywhere in the list.</b> <c>[".zip", "*.*"]</c> is a
    /// redundant payload, not a wrong one, and rejecting it would be a rule with no failure behind
    /// it.
    /// </para>
    /// <para>
    /// <b>An extensionless file is admitted only under the wildcard</b>, and that falls out rather
    /// than being cased: <c>""</c> is not well formed, so it can never be an entry to match against.
    /// </para>
    /// </summary>
    public static bool Admits(IReadOnlyList<string> whitelist, string extension)
    {
        foreach (var entry in whitelist)
        {
            if (entry == Wildcard
                || entry.Equals(extension, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>The list as an operator reads it, for the rejection message.</summary>
    public static string Describe(IReadOnlyList<string> whitelist) => string.Join(", ", whitelist);

    private static bool IsWellFormed(string entry)
        => entry == Wildcard || (entry.Length > 1 && entry.StartsWith('.'));
}
```

- [ ] **Step 5: Write the pod options**

Create `src/Processor.FileFetcher/FileFetcherOptions.cs`:

```csharp
using Microsoft.Extensions.Configuration;

namespace Processor.FileFetcher;

/// <summary>
/// The pod's own limit, bound from the <c>"FileFetcher"</c> config section and set in the manifest as
/// <c>FileFetcher__MaxFileSizeBytes</c>.
/// <para>
/// <b>This is what the pod can survive; <see cref="FileFetcherConfig.MaximumSizeBytes"/> is what a
/// valid file for a feed looks like.</b> They are different questions and both are enforced: a step
/// payload naming more than this is a config error, reported by name rather than clamped.
/// </para>
/// <para>
/// <b>It bounds the FILE, and nothing beyond it.</b> What an archive expands to is a different
/// quantity with a different owner, guarded by <c>ArchiveExpander__MaxExpandedBytes</c> one hop
/// downstream. This processor never opens a file, so it could not enforce that one if it wanted to.
/// </para>
/// </summary>
public sealed class FileFetcherOptions
{
    /// <summary>Ceiling in bytes (default 32 MiB). The default lives here so an unset variable is
    /// never unbounded.</summary>
    [ConfigurationKeyName("MaxFileSizeBytes")]
    public long MaxFileSizeBytes { get; set; } = 33_554_432;
}
```

- [ ] **Step 6: Write Program.cs**

Create `src/Processor.FileFetcher/Program.cs`:

```csharp
using System.Runtime.InteropServices;
using Microsoft.Extensions.Hosting;
using Processor.FileFetcher;

// The boot resolves identity before building anything, so this is the one place the process can be
// cancelled while it is still deciding who it is.
//
// Both signals are registered, not just Ctrl+C. Until the host exists there is no ConsoleLifetime to
// answer SIGTERM, and Stage 1 is explicitly allowed to run forever — so a processor waiting on an
// unregistered row is exactly the pod an operator deletes, and without this it would ignore the
// request and be killed outright when the grace period expired.
using var lifetime = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) => { e.Cancel = true; lifetime.Cancel(); };
using var term = PosixSignalRegistration.Create(
    PosixSignal.SIGTERM, ctx => { ctx.Cancel = true; lifetime.Cancel(); });

using var host = await ProcessorHost.StartAsync(args, lifetime.Token);
await host.WaitForShutdownAsync();
```

- [ ] **Step 7: Write the composition root**

Create `src/Processor.FileFetcher/ProcessorHost.cs`. It is `Processor.ArchiveExpander/ProcessorHost.cs` with the archive registrations removed and the options section repointed:

```csharp
using BaseConsole.Core.DependencyInjection;
using BaseProcessor.Core.Boot;
using BaseProcessor.Core.DependencyInjection;
using BaseProcessor.Core.Observability;
using Messaging.Contracts;
using Messaging.Transport;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using OpenTelemetry.Metrics;

namespace Processor.FileFetcher;

/// <summary>
/// The composition root, as methods rather than inline in <c>Program</c> so that the one thing worth
/// asserting about a shell — that its service graph actually resolves — can be asserted without
/// starting a process.
/// </summary>
public static class ProcessorHost
{
    /// <summary>
    /// The production entry point: probes, then identity, then a host built around the answer.
    /// </summary>
    /// <param name="bootstrap">
    /// Stage 1. Null uses the real broker; a test passes its own so the sequence can be exercised
    /// without one.
    /// </param>
    public static async Task<IHost> StartAsync(
        string[] args,
        CancellationToken ct,
        Action<IConfigurationBuilder>? configure = null,
        IIdentityBootstrap? bootstrap = null)
    {
        // Configuration is read twice — once for the boot, once by the host builder — because the boot
        // has to know where the broker is before a host exists to tell it.
        var bootConfig = new ConfigurationBuilder()
            .AddJsonFile("appsettings.json", optional: true)
            .AddEnvironmentVariables()
            .Build();

        // Console only. This is the whole logging surface for the identity window, which is exactly
        // where an operator is already looking: kubectl logs on a pod that is not ready yet.
        using var bootLogs = LoggerFactory.Create(b => b.AddConsole());

        var owned = bootstrap is null;
        var resolver = bootstrap ?? new BrokerIdentityBootstrap(
            bootConfig, bootLogs, TimeProvider.System);

        try
        {
            return await ProcessorBoot.StartAsync(
                bootConfig.GetValue<int?>("ConsoleHealth:Port") ?? 8081,
                resolver,
                identity => Create(args, identity, configure),
                bootLogs,
                ct).ConfigureAwait(false);
        }
        finally
        {
            if (owned && resolver is IAsyncDisposable disposable)
            {
                await disposable.DisposeAsync().ConfigureAwait(false);
            }
        }
    }

    /// <summary>
    /// Builds the host around an identity that is already known. Separate from
    /// <see cref="StartAsync"/> so a test can assert the graph resolves without a broker.
    /// </summary>
    public static IHost Create(
        string[] args, ProcessorIdentityFound identity, Action<IConfigurationBuilder>? configure = null)
    {
        ArgumentNullException.ThrowIfNull(identity);

        var builder = Host.CreateApplicationBuilder(args);
        configure?.Invoke(builder.Configuration);

        // The identity from the database row, not from configuration. It reaches the OTel resource
        // only because it was resolved before this line ran: a resource is materialised when its
        // provider is built and is immutable afterwards, so there is no later opportunity.
        builder.AddBaseConsoleObservability(
            builder.Configuration,
            source: "worker",
            defaultServiceName: "processor",
            defaultServiceVersion: "1.0.0",
            serviceName: identity.Name,
            serviceVersion: identity.Version,
            resourceAttributes: [new ResourceAttribute("ProcessorId", "processorId", identity.Id.ToString())]);

        // A second WithMetrics on the same OpenTelemetryBuilder adds to the provider the shared
        // call configured rather than replacing it.
        builder.Services.AddOpenTelemetry()
            .WithMetrics(m => m
                .AddMeter(ProcessorPipelineMeter.Name));

        // Everything else: broker, Redis, health probes, the schema loop and the liveness loop.
        builder.Services.AddBaseProcessor(builder.Configuration, identity);

        // The pod's ceiling, from FileFetcher__MaxFileSizeBytes in the manifest. Infrastructure
        // limits come from configuration, business expectations come from the step payload.
        builder.Services.Configure<FileFetcherOptions>(builder.Configuration.GetSection("FileFetcher"));

        // The concrete processor the pre/post handlers resolve as BaseProcessor. Singleton, matching
        // the seam's design: per-dispatch state lives in a plain field on this one instance, which is
        // safe only because prefetch is 1.
        builder.Services.AddSingleton<BaseProcessor.Core.Processing.BaseProcessor, FileFetcherProcessor>();

        return builder.Build();
    }
}
```

**Note:** `FileFetcherProcessor` does not exist until Task 3. Comment out the final `AddSingleton` line for now — Task 3 Step 11 restores it — and this task's build succeeds without it.

- [ ] **Step 8: Write appsettings.json**

Create `src/Processor.FileFetcher/appsettings.json`:

```json
{
  "Service": {
    "Name": "processor",
    "Version": "0.0.0"
  },
  "ConnectionStrings": {
    "Redis": "localhost:6379,abortConnect=false"
  },
  "RabbitMq": {
    "Host": "localhost",
    "Port": 5672,
    "Username": "guest",
    "Password": "guest",
    "VirtualHost": "/"
  },
  "Processor": {
    "Interval": 10,
    "StartupInterval": 30,
    "RequestTimeout": 8,
    "BackoffCap": 30
  },
  "ConsoleHealth": {
    "Port": 8081
  },
  "FileFetcher": {
    "MaxFileSizeBytes": 33554432
  },
  "Logging": {
    "LogLevel": {
      "Default": "Information",
      "Microsoft.Hosting.Lifetime": "Information"
    }
  }
}
```

- [ ] **Step 9: Write the output schema**

This is the final schema, not a stand-in — Task 3 writes the tests that hold it to account, but the file must exist now or the build fails on the `Content Include` that copies it:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "required": ["fileName", "extension", "sizeBytes", "createdUtc", "modifiedUtc", "content"],
  "properties": {
    "fileName":    { "type": "string", "minLength": 1 },
    "extension":   { "type": "string" },
    "sizeBytes":   { "type": "integer", "minimum": 0 },
    "createdUtc":  { "type": ["string", "null"] },
    "modifiedUtc": { "type": ["string", "null"] },
    "content":     { "type": "string" }
  }
}
```

- [ ] **Step 10: Add to the solution, wire the test project, build, run the tests**

`InternalsVisibleTo` alone does not create a reference — without the `ProjectReference` below,
`using Processor.FileFetcher;` in the tests does not compile. In
`src/tests/BaseApi.Tests/BaseApi.Tests.csproj`, add alongside the other four processor references:

```xml
    <ProjectReference Include="..\..\Processor.FileFetcher\Processor.FileFetcher.csproj" />
```

and, in the `None` item group, link this processor's schema under a **distinct** name — the
ArchiveExpander already occupies `schema\output.json` and must keep it:

```xml
    <!-- fetcher-output.json, not output.json: ArchiveExpander's output schema already links to
         that name and ArchiveExpanderSchemaTests reads it there. Two files called output.json
         would collide on one output path and one would silently win. -->
    <None Include="..\..\Processor.FileFetcher\schema\output.json"
          Link="schema\fetcher-output.json" CopyToOutputDirectory="PreserveNewest" />
```

```bash
dotnet sln SK_P.sln add src/Processor.FileFetcher/Processor.FileFetcher.csproj
dotnet build SK_P.sln
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: build succeeds with no warnings; all `ExtensionWhitelistTests` pass; `0 failed`, exit 0.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat(filefetcher): the project shell and the extension whitelist

The whitelist is the only part of this processor decidable without a
file, a broker or a host, so every row of the design's table is a unit
test here rather than a case reached through the processor."
```

---

## Task 3: FileFetcher — config, envelope, and the processor

The working fetcher. Its tests are the extension, size and locator coverage ported off `ArchiveExpander`, which is what lets Task 4 strip that processor without the suite losing anything.

**Files:**
- Create: `src/Processor.FileFetcher/FileFetcherConfig.cs`
- Create: `src/Processor.FileFetcher/FileLocator.cs`
- Create: `src/Processor.FileFetcher/FetchedFile.cs`
- Create: `src/Processor.FileFetcher/FileFetcherProcessor.cs`
- Create: `src/Processor.FileFetcher/schema/README.md`
- Modify: `src/Processor.FileFetcher/ProcessorHost.cs` (uncomment the `AddSingleton`)
- Test: `src/tests/BaseApi.Tests/FileFetcher/FileFetcherGuardTests.cs`
- Test: `src/tests/BaseApi.Tests/FileFetcher/FileFetcherLocatorTests.cs`
- Test: `src/tests/BaseApi.Tests/FileFetcher/FileFetcherEnvelopeTests.cs`
- Test: `src/tests/BaseApi.Tests/FileFetcher/FileFetcherSchemaTests.cs`
- Test: `src/tests/BaseApi.Tests/FileFetcher/ProcessorFileFetcherTests.cs`

**Interfaces:**
- Consumes: `ExtensionWhitelist`, `FileFetcherOptions` from Task 2.
- Produces: `FileFetcherConfig(IReadOnlyList<string>? AllowedExtensions, long MinimumSizeBytes, long MaximumSizeBytes) : ProcessorConfig`; `internal sealed record FileLocator(string? FilePath)`; `internal sealed record FetchedFile(string FileName, string Extension, long SizeBytes, DateTime? CreatedUtc, DateTime? ModifiedUtc, byte[] Content)` and `FetchedFileJson.Options`; `FileFetcherProcessor(ILogger<FileFetcherProcessor>, IOptions<FileFetcherOptions>) : BaseProcessor<FileFetcherConfig>`. The envelope JSON is camelCase with every key always present — Task 4's reader depends on exactly that.

- [ ] **Step 1: Write the failing guard tests**

Create `src/tests/BaseApi.Tests/FileFetcher/FileFetcherGuardTests.cs`:

```csharp
using System.Text;
using System.Text.Json;
using BaseApi.Tests.Support;
using BaseProcessor.Core.Processing;
using Messaging.Transport;
using Microsoft.Extensions.Options;
using NSubstitute;
using Processor.FileFetcher;
using Xunit;

namespace BaseApi.Tests.FileFetcher;

/// <summary>
/// The dry checks: payload, extension, size. Every one of these must fail BEFORE the file is opened,
/// which is the whole reason this processor exists as a separate hop.
/// </summary>
public sealed class FileFetcherGuardTests : IDisposable
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");
    private static readonly Guid E = Guid.Parse("55555555-5555-5555-5555-555555555555");

    private readonly string _dir = Directory.CreateTempSubdirectory("skp-filefetcher-").FullName;

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    /// <summary>A real file on disk. The thing under test IS the filesystem interaction.</summary>
    private string WriteFile(string name, int bytes)
    {
        var path = Path.Combine(_dir, name);
        File.WriteAllBytes(path, new byte[bytes]);
        return path;
    }

    private static FileFetcherProcessor Build(long podCeiling = 33_554_432)
    {
        var processor = new FileFetcherProcessor(
            new RecordingLogger<FileFetcherProcessor>(),
            Options.Create(new FileFetcherOptions { MaxFileSizeBytes = podCeiling }));
        processor.BeginDispatch(new DispatchState(Substitute.For<IQueueSender>(), C, W, S, P));
        return processor;
    }

    private static string Payload(string[]? extensions, long min, long max)
        => JsonSerializer.Serialize(new
        {
            AllowedExtensions = extensions,
            MinimumSizeBytes = min,
            MaximumSizeBytes = max,
        });

    private static Task Run(FileFetcherProcessor processor, string path, string payload)
        => processor.ExecuteAsync(
            Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { filePath = path })),
            payload, E, CancellationToken.None);

    [Fact]
    public async Task AnAbsentPayloadFailsTheStep()
    {
        // An absent payload IS a malformed payload, and it shares the prefix so one query finds
        // every payload fault including the commonest one.
        var processor = Build();

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => processor.ExecuteAsync([], "", E, CancellationToken.None));

        Assert.StartsWith("step payload rejected: ", ex.Message, StringComparison.Ordinal);
        Assert.Contains("needs AllowedExtensions", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AMalformedExtensionEntryIsQuotedBack()
    {
        var processor = Build();
        var path = WriteFile("a.zip", 10);

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => Run(processor, path, Payload([".zip", "zip"], 0, 4096)));

        Assert.StartsWith("step payload rejected: ", ex.Message, StringComparison.Ordinal);
        Assert.Contains("'zip'", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task APayloadCeilingAboveThePodCeilingFailsTheStep()
    {
        // Not clamped. Clamping means the author asked for 100MB, got failures at 32, and nothing
        // said why.
        var processor = Build(podCeiling: 1024);
        var path = WriteFile("a.csv", 10);

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => Run(processor, path, Payload([".csv"], 0, 4096)));

        Assert.StartsWith("step payload rejected: ", ex.Message, StringComparison.Ordinal);
        Assert.Contains("above this pod's ceiling", ex.Message, StringComparison.Ordinal);
        Assert.Contains("FileFetcher__MaxFileSizeBytes", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ANegativeFloorFailsTheStep()
    {
        var processor = Build();
        var path = WriteFile("a.csv", 10);

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => Run(processor, path, Payload([".csv"], -1, 4096)));

        Assert.Contains("MinimumSizeBytes must not be negative", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AFloorAboveTheCeilingFailsTheStep()
    {
        var processor = Build();
        var path = WriteFile("a.csv", 10);

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => Run(processor, path, Payload([".csv"], 4096, 100)));

        Assert.Contains("is above MaximumSizeBytes", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AMissingFileFailsTheStepNamingThePath()
    {
        // "reading", not "rejected": an absent file is not a file that broke a rule, and the two
        // classes are searched separately.
        var processor = Build();
        var path = Path.Combine(_dir, "absent.csv");

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => Run(processor, path, Payload([".csv"], 0, 4096)));

        Assert.StartsWith($"reading {path} failed: ", ex.Message, StringComparison.Ordinal);
        Assert.Contains("it does not exist", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnExtensionOutsideTheWhitelistIsRejectedAndTheListIsNamed()
    {
        var processor = Build();
        var path = WriteFile("report.pdf", 10);

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => Run(processor, path, Payload([".zip", ".tar", ".csv"], 0, 4096)));

        Assert.StartsWith($"file {path} rejected: ", ex.Message, StringComparison.Ordinal);
        Assert.Contains("extension '.pdf' is not in the allowed list (.zip, .tar, .csv)",
                        ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnyExtensionIsAdmittedUnderTheWildcard()
    {
        var processor = Build();
        var path = WriteFile("report.pdf", 10);

        // No throw is the assertion.
        await Run(processor, path, Payload(["*.*"], 0, 4096));
    }

    [Fact]
    public async Task AnOmittedExtensionListAdmitsEverything()
    {
        // The fallback and the default are the same value, and this is where that is visible.
        var processor = Build();
        var path = WriteFile("report.pdf", 10);

        await Run(processor, path, Payload(null, 0, 4096));
    }

    [Fact]
    public async Task AFileBelowTheFloorIsRejected()
    {
        var processor = Build();
        var path = WriteFile("a.csv", 10);

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => Run(processor, path, Payload([".csv"], 100, 4096)));

        Assert.StartsWith($"file {path} rejected: ", ex.Message, StringComparison.Ordinal);
        Assert.Contains("is below the 100 byte floor", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AFileAboveTheCeilingIsRejected()
    {
        var processor = Build();
        var path = WriteFile("a.csv", 500);

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => Run(processor, path, Payload([".csv"], 0, 100)));

        Assert.StartsWith($"file {path} rejected: ", ex.Message, StringComparison.Ordinal);
        Assert.Contains("is above the 100 byte ceiling", ex.Message, StringComparison.Ordinal);
    }
}
```

- [ ] **Step 2: Write the failing locator tests**

Create `src/tests/BaseApi.Tests/FileFetcher/FileFetcherLocatorTests.cs`:

```csharp
using System.Text;
using System.Text.Json;
using BaseApi.Tests.Support;
using BaseProcessor.Core.Processing;
using Messaging.Transport;
using Microsoft.Extensions.Options;
using NSubstitute;
using Processor.FileFetcher;
using Xunit;

namespace BaseApi.Tests.FileFetcher;

/// <summary>
/// The input branch. Every failure here is a business failure with a diagnosis, never a framework
/// exception with a sanitized message — and none of them quotes the fragment that failed to parse,
/// because that fragment is upstream content.
/// </summary>
public sealed class FileFetcherLocatorTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");
    private static readonly Guid E = Guid.Parse("55555555-5555-5555-5555-555555555555");

    private const string Payload =
        """{"AllowedExtensions":[".csv"],"MinimumSizeBytes":0,"MaximumSizeBytes":4096}""";

    private static FileFetcherProcessor Build()
    {
        var processor = new FileFetcherProcessor(
            new RecordingLogger<FileFetcherProcessor>(),
            Options.Create(new FileFetcherOptions()));
        processor.BeginDispatch(new DispatchState(Substitute.For<IQueueSender>(), C, W, S, P));
        return processor;
    }

    private static async Task<string> FailureFor(byte[] branch)
    {
        var ex = await Assert.ThrowsAsync<FailedException>(
            () => Build().ExecuteAsync(branch, Payload, E, CancellationToken.None));
        return ex.Message;
    }

    [Fact]
    public async Task ABranchThatIsNotJsonFailsWithoutQuotingIt()
    {
        var message = await FailureFor(Encoding.UTF8.GetBytes("not json at all"));

        Assert.StartsWith("input branch did not name a file path: ", message, StringComparison.Ordinal);
        Assert.Contains("the branch is not JSON", message, StringComparison.Ordinal);
        Assert.DoesNotContain("not json at all", message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ABranchWithNoFilePathFails()
    {
        var message = await FailureFor(
            Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { providerName = "acme" })));

        Assert.Contains("the branch carries no filePath", message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ARelativePathFails()
    {
        // IsPathFullyQualified, not IsPathRooted: on Windows a drive-relative path such as
        // "\orders.csv" is rooted but not absolute — it resolves against whatever drive is current,
        // which is not a location any workflow author chose.
        var message = await FailureFor(
            Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { filePath = "orders.csv" })));

        Assert.Contains("the path is relative", message, StringComparison.Ordinal);
    }
}
```

- [ ] **Step 3: Write the failing envelope tests**

Create `src/tests/BaseApi.Tests/FileFetcher/FileFetcherEnvelopeTests.cs`:

```csharp
using System.Text;
using System.Text.Json;
using BaseApi.Tests.Support;
using Messaging.Contracts;
using Messaging.Transport;
using Microsoft.Extensions.Options;
using NSubstitute;
using Processor.FileFetcher;
using Xunit;

namespace BaseApi.Tests.FileFetcher;

/// <summary>
/// What this processor puts on the wire. The envelope IS the contract across the split, so its
/// keys, its casing and its base64 are asserted here rather than assumed.
/// </summary>
public sealed class FileFetcherEnvelopeTests : IDisposable
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");
    private static readonly Guid E = Guid.Parse("55555555-5555-5555-5555-555555555555");

    private readonly string _dir = Directory.CreateTempSubdirectory("skp-filefetcher-env-").FullName;

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    private const string CsvPayload =
        """{"AllowedExtensions":[".csv"],"MinimumSizeBytes":0,"MaximumSizeBytes":4096}""";

    private async Task<List<ProcessedData>> SendsFor(string name, string text, Guid executionId)
    {
        var path = Path.Combine(_dir, name);
        await File.WriteAllTextAsync(path, text);

        var sender = Substitute.For<IQueueSender>();
        var sends = new List<ProcessedData>();
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(sends.Add),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());

        var processor = new FileFetcherProcessor(
            new RecordingLogger<FileFetcherProcessor>(), Options.Create(new FileFetcherOptions()));
        processor.BeginDispatch(new DispatchState(sender, C, W, S, P));

        await processor.ExecuteAsync(
            Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { filePath = path })),
            CsvPayload, executionId, CancellationToken.None);

        return sends;
    }

    [Fact]
    public async Task OneBranchIsSentOnTheDispatchsOwnExecutionId()
    {
        // A transform, not a source: the lineage it was handed is the lineage it continues.
        var sends = await SendsFor("orders.csv", "id,name", E);

        var branch = Assert.Single(sends);
        Assert.Equal(E, branch.ExecutionId);
    }

    [Fact]
    public async Task TheEnvelopeCarriesCamelCaseKeysAndBase64Content()
    {
        var sends = await SendsFor("orders.csv", "id,name", E);

        using var doc = JsonDocument.Parse(Assert.Single(sends).Data);
        var root = doc.RootElement;

        Assert.Equal("orders.csv", root.GetProperty("fileName").GetString());
        Assert.Equal(".csv", root.GetProperty("extension").GetString());
        Assert.Equal(7, root.GetProperty("sizeBytes").GetInt64());
        Assert.Equal("id,name", Encoding.UTF8.GetString(root.GetProperty("content").GetBytesFromBase64()));
    }

    [Fact]
    public async Task EveryKeyIsPresentEvenWhenItsValueIsNull()
    {
        // The registered schema requires the keys, so DefaultIgnoreCondition.Never is load-bearing
        // rather than stylistic.
        var sends = await SendsFor("orders.csv", "id,name", E);

        using var doc = JsonDocument.Parse(Assert.Single(sends).Data);
        foreach (var key in new[]
                 { "fileName", "extension", "sizeBytes", "createdUtc", "modifiedUtc", "content" })
        {
            Assert.True(doc.RootElement.TryGetProperty(key, out _), key);
        }
    }

    [Fact]
    public async Task TheEnvelopeCarriesNoPath()
    {
        // The path is a location the downstream has no business knowing, and carrying it here would
        // put it one edit from the output document.
        var sends = await SendsFor("orders.csv", "id,name", E);

        var json = Encoding.UTF8.GetString(Assert.Single(sends).Data);
        Assert.DoesNotContain(_dir.Replace('\\', '/'), json.Replace('\\', '/'), StringComparison.Ordinal);
        Assert.False(JsonDocument.Parse(json).RootElement.TryGetProperty("filePath", out _));
    }

    [Fact]
    public async Task AnEmptyFileIsAnEmptyContentString()
    {
        var sends = await SendsFor("empty.csv", "", E);

        using var doc = JsonDocument.Parse(Assert.Single(sends).Data);
        Assert.Equal("", doc.RootElement.GetProperty("content").GetString());
        Assert.Equal(0, doc.RootElement.GetProperty("sizeBytes").GetInt64());
    }
}
```

- [ ] **Step 4: Write the failing schema tests**

Create `src/tests/BaseApi.Tests/FileFetcher/FileFetcherSchemaTests.cs`:

```csharp
using System.Text;
using System.Text.Json;
using BaseProcessor.Core.Validation;
using Processor.FileFetcher;
using Xunit;

namespace BaseApi.Tests.FileFetcher;

/// <summary>
/// The registered output schema, against envelopes this processor actually emits, through the SAME
/// validator the post handler uses.
/// <para>
/// A schema failure in production is destructive: the post handler reports Failed with EntryId
/// Guid.Empty and acks, so nothing is written to L2 and the step's input was already reclaimed. The
/// file has been read and the result is discarded with no key to recover it.
/// </para>
/// </summary>
public sealed class FileFetcherSchemaTests
{
    // fetcher-output.json, not output.json: ArchiveExpander's output schema owns that name in the
    // test output. See the link in BaseApi.Tests.csproj.
    private static string Definition()
        => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "schema", "fetcher-output.json"));

    private static DateTime Stamp => new(2026, 9, 10, 8, 31, 2, DateTimeKind.Utc);

    private static byte[] Serialize(FetchedFile file)
        => JsonSerializer.SerializeToUtf8Bytes(file, FetchedFileJson.Options);

    [Fact]
    public void AnOrdinaryEnvelopeValidates()
    {
        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(),
            Serialize(new FetchedFile("orders.csv", ".csv", 7, Stamp, Stamp,
                                      Encoding.UTF8.GetBytes("id,name"))),
            out var errors);

        Assert.True(ok, string.Join("; ", errors));
    }

    [Fact]
    public void NullTimestampsValidate()
    {
        // Archives record no creation time and some filesystems record neither. Null is a legal
        // value for both, and the keys are still present.
        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(),
            Serialize(new FetchedFile("orders.csv", ".csv", 0, null, null, [])),
            out var errors);

        Assert.True(ok, string.Join("; ", errors));
    }

    [Fact]
    public void AnExtensionlessNameValidates()
    {
        // Admitted under "*.*", so the schema must accept an empty extension string.
        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(),
            Serialize(new FetchedFile("README", "", 2, Stamp, Stamp, [1, 2])),
            out var errors);

        Assert.True(ok, string.Join("; ", errors));
    }

    [Fact]
    public void AnEnvelopeMissingContentIsRejected()
    {
        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(),
            Encoding.UTF8.GetBytes(
                """{"fileName":"a.csv","extension":".csv","sizeBytes":1,"createdUtc":null,"modifiedUtc":null}"""),
            out _);

        Assert.False(ok);
    }

    [Fact]
    public void AnEnvelopeWithAnExtraKeyIsRejected()
    {
        // additionalProperties: false. A key nobody agreed on must not travel silently.
        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(),
            Encoding.UTF8.GetBytes(
                """{"fileName":"a.csv","extension":".csv","sizeBytes":1,"createdUtc":null,"modifiedUtc":null,"content":"AQ==","filePath":"/mnt/a.csv"}"""),
            out _);

        Assert.False(ok);
    }
}
```

- [ ] **Step 5: Write the failing host graph test**

Create `src/tests/BaseApi.Tests/FileFetcher/ProcessorFileFetcherTests.cs`:

```csharp
using BaseProcessor.Core.Identity;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Processor.FileFetcher;
using Xunit;

namespace BaseApi.Tests.FileFetcher;

public sealed class ProcessorFileFetcherTests
{
    private static readonly ProcessorIdentityFound Identity = new(
        Guid.Parse("9c41b7e2-3a86-4d51-8f07-1b6e5d2c4a83"),
        InputSchemaId: null, OutputSchemaId: null, ConfigSchemaId: null,
        Name: "file-fetcher", Version: "1.0.0");

    private static IHost Build() => ProcessorHost.Create(
        // Development turns on the container's build-time validation, which is the whole point:
        // every registration is checked for constructibility without anything being instantiated,
        // so no broker or store is contacted.
        ["--environment", "Development"],
        Identity,
        cfg => cfg.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Service:Name"]            = "processor",
            ["Service:Version"]         = "0.0.0",
            ["ConnectionStrings:Redis"] = "localhost:6379,abortConnect=false",
            ["RabbitMq:Host"]           = "localhost",
            ["RabbitMq:Username"]       = "guest",
            ["RabbitMq:Password"]       = "guest",
        }));

    [Fact]
    public void TheHostGraphResolves()
    {
        // A shell's one failure mode is a registration nobody remembered. It surfaces at startup in
        // production and nowhere at all at compile time.
        using var host = Build();

        Assert.NotNull(host);
    }

    [Fact]
    public void TheAuthorIsRegisteredAsTheFrameworksProcessor()
    {
        using var host = Build();

        var resolved = host.Services.GetRequiredService<BaseProcessor.Core.Processing.BaseProcessor>();

        Assert.IsType<FileFetcherProcessor>(resolved);
    }
}
```

- [ ] **Step 6: Run the tests to verify they fail**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: compile failure — `FileFetcherProcessor`, `FileFetcherConfig`, `FetchedFile` and `FetchedFileJson` do not exist.

- [ ] **Step 7: Write the step payload record**

Create `src/Processor.FileFetcher/FileFetcherConfig.cs`:

```csharp
using BaseProcessor.Core.Configuration;

namespace Processor.FileFetcher;

/// <summary>
/// The step payload. Bound case-insensitively by <see cref="ProcessorConfig.SerializerOptions"/>,
/// which also ignores unknown properties so a field added later does not break workflows authored
/// before it.
/// <para>
/// <b>Everything here is knowable from <c>FileInfo</c>, and that is the rule for what belongs.</b>
/// An expectation that can only be checked after the file is opened saves nothing by living in the
/// payload — it belongs to the processor that opens it.
/// </para>
/// </summary>
/// <param name="AllowedExtensions">
/// The whitelist. Each entry carries a leading dot and is compared case-insensitively, or is the
/// sentinel <c>"*.*"</c>.
/// <para>
/// <b>Absent, null or empty means <c>["*.*"]</c></b> — see <see cref="ExtensionWhitelist.Resolve"/>
/// for why the default widens here and nowhere else.
/// </para>
/// <para>
/// <b>It ADMITS a file to the pipeline; it does not choose an extractor.</b> Nothing here knows what
/// an archive is. One hop downstream the declared extension is cross-checked against the file's
/// leading bytes, and this whitelist is the claim that check is made against.
/// </para>
/// </param>
/// <param name="MinimumSizeBytes">Floor, inclusive. Zero disables the check.</param>
/// <param name="MaximumSizeBytes">
/// Ceiling, inclusive, for <b>the file on disk</b> — and for nothing else. Admitted only if it fits
/// inside the pod's own ceiling; see <see cref="FileFetcherOptions"/>.
/// <para>
/// <b>It used to mean two things and now means one.</b> In FileReader this bounded both the file and
/// the cumulative size of everything an archive expanded to. The second meaning left with the
/// expansion, to <c>ArchiveExpander__MaxExpandedBytes</c> — a pod option, because the size of an
/// expansion is a number an operator sizes against a container limit and a workflow author has no
/// way to know.
/// </para>
/// </param>
public sealed record FileFetcherConfig(
    IReadOnlyList<string>? AllowedExtensions,
    long MinimumSizeBytes,
    long MaximumSizeBytes) : ProcessorConfig;
```

- [ ] **Step 8: Write the input contract**

Create `src/Processor.FileFetcher/FileLocator.cs`:

```csharp
namespace Processor.FileFetcher;

/// <summary>
/// The input contract: what the upstream importer's record carries. Bound with
/// <c>ProcessorConfig.SerializerOptions</c>, which is case-insensitive and ignores unknown
/// properties — so the org's <c>providerName</c> arrives, binds to nothing, and is dropped.
/// <para>
/// <b>providerName is deliberately absent from this record.</b> It is redundant: <c>filePath</c> is
/// absolute and complete. Adding it here would put it one edit away from the envelope, and the
/// design says it appears nowhere downstream.
/// </para>
/// </summary>
internal sealed record FileLocator(string? FilePath);
```

- [ ] **Step 9: Write the envelope**

Create `src/Processor.FileFetcher/FetchedFile.cs`:

```csharp
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Processor.FileFetcher;

/// <summary>
/// What crosses the hop: the file's identity and its content, in one document.
/// <para>
/// <b>The identity travels because the file is the only place it exists.</b> Name, extension and
/// timestamps are <c>FileInfo</c> facts, and this is the last processor that holds a
/// <c>FileInfo</c>. ArchiveExpander's output schema requires all of them on its root metadata node,
/// and a downstream step wants the filename for its own metadata — so this processor writes down
/// what it saw before letting go.
/// </para>
/// <para>
/// <b>No path, and that is a rule rather than an omission.</b> The path is a location whoever
/// authored the workflow chose; it appears nowhere in the output document, and carrying it here
/// would put it one edit away from doing so.
/// </para>
/// <para>
/// <b>Every field is non-nullable because this is the WRITER's view.</b> ArchiveExpander declares
/// its own reader's copy with every field optional, because a malformed upstream record must be
/// diagnosed rather than thrown at. The two records describe one JSON document and must stay in
/// sync; the two registered schema files are what pin them, and the cross-hop test is what enforces
/// it.
/// </para>
/// </summary>
/// <param name="SizeBytes">
/// <c>FileInfo.Length</c>, not <c>Content.Length</c>. For a whole file they agree, and the former is
/// the number the dry inspection already reported to an operator.
/// </param>
internal sealed record FetchedFile(
    string FileName,
    string Extension,
    long SizeBytes,
    DateTime? CreatedUtc,
    DateTime? ModifiedUtc,
    byte[] Content);

/// <summary>The one serializer configuration for the envelope.</summary>
internal static class FetchedFileJson
{
    /// <summary>
    /// <b>camelCase, pinned explicitly.</b> <c>MessagingJson</c> leaves the naming policy null —
    /// PascalCase — and it governs the <c>ProcessedData</c> envelope, not the bytes inside
    /// <c>Data</c>. Inheriting its convention here would silently rename every property the output
    /// schema names.
    /// <para>
    /// <c>Never</c> ignore, and it is load-bearing: the schema requires every key to be present, so
    /// a null timestamp must be emitted as <c>null</c> rather than omitted.
    /// </para>
    /// <para>
    /// <c>byte[]</c> needs no converter — System.Text.Json renders it as a base64 string and reads
    /// one back, which is exactly the wire form the schema declares.
    /// </para>
    /// </summary>
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
    };
}
```

- [ ] **Step 10: Write the processor**

Create `src/Processor.FileFetcher/FileFetcherProcessor.cs`:

```csharp
using System.Text.Json;
using BaseProcessor.Core.Configuration;
using BaseProcessor.Core.Processing;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Processor.FileFetcher;

/// <summary>
/// Turns a file path into the file's bytes and its identity. A plain downstream transform: it has an
/// input and it produces output, so it is not an edge and neither <c>BaseImporter</c> nor
/// <c>BaseExporter</c> applies.
/// <para>
/// <b>It never opens a file it has not already admitted.</b> Every check below reads
/// <c>FileInfo</c>, which reads metadata only, so a file that fails one is never opened at all.
/// That is the whole reason this is a hop of its own.
/// </para>
/// </summary>
internal sealed class FileFetcherProcessor(
    ILogger<FileFetcherProcessor> logger,
    IOptions<FileFetcherOptions> options)
    : BaseProcessor<FileFetcherConfig>
{
    private readonly long _podCeiling = options.Value.MaxFileSizeBytes;

    protected override async Task ProcessAsync(
        byte[] data, FileFetcherConfig? config, Guid executionId, CancellationToken ct)
    {
        // Config first: it is the cheapest check and it depends on nothing else. A step wired with a
        // ceiling this pod cannot honour is wrong before any file is named.
        var (settings, whitelist) = Validate(config);

        var path = ReadPath(data);
        var info = Inspect(path, settings, whitelist);

        var bytes = Read(info);

        var envelope = new FetchedFile(
            info.Name,
            info.Extension,
            // FileInfo.Length rather than the array's length: they agree, and the former is what the
            // dry inspection already reported to an operator.
            info.Length,
            info.CreationTimeUtc,
            info.LastWriteTimeUtc,
            bytes);

        // The SHAPE, never the content. A name, a size and a timestamp are safe to log; the bytes are
        // upstream data and stay out of every template in this system.
        //
        // THIS IS THE ONLY PLACE THE FILE'S IDENTITY IS LOGGED FROM NOW ON. ArchiveExpander sees an
        // envelope and no path, so an operator tracing a file back to a location on disk has this
        // record and nothing else. It shares the dispatch's ExecutionId and CorrelationId, so one
        // query spans both hops.
        logger.LogInformation(
            "fetched {FileName} ({Extension}), {SizeBytes} bytes, modified {ModifiedUtc}",
            envelope.FileName, envelope.Extension, envelope.SizeBytes, envelope.ModifiedUtc);

        var document = JsonSerializer.SerializeToUtf8Bytes(envelope, FetchedFileJson.Options);

        // ONE branch, on the execution id this dispatch arrived with. Not NewExecutionId(): this is
        // a transform, not a source, so the lineage it was handed is the lineage it continues.
        await SendToPostAsync(document, executionId, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// The payload, checked, and the whitelist it resolves to. Throws <see cref="FailedException"/>
    /// with the reason.
    /// </summary>
    private (FileFetcherConfig Settings, IReadOnlyList<string> Whitelist) Validate(
        FileFetcherConfig? config)
    {
        if (config is null)
        {
            // Same "step payload rejected" prefix as every other malformed-payload case below: an
            // absent payload IS a malformed payload, and an operator searching for payload faults
            // must find all of them — the commonest one included — with one query.
            throw BadPayload(
                "FileFetcher needs AllowedExtensions, MinimumSizeBytes and MaximumSizeBytes");
        }

        var whitelist = ExtensionWhitelist.Resolve(config.AllowedExtensions);

        if (ExtensionWhitelist.FirstMalformed(whitelist) is { } malformed)
        {
            // Quoted back, not normalised. An author who wrote "zip" has to see "zip".
            throw BadPayload(
                $"an allowed extension must start with a dot or be "
                + $"'{ExtensionWhitelist.Wildcard}'; the payload named '{malformed}'");
        }

        if (config.MinimumSizeBytes < 0)
        {
            throw BadPayload("MinimumSizeBytes must not be negative");
        }

        if (config.MaximumSizeBytes < 1)
        {
            throw BadPayload("MaximumSizeBytes must be at least 1");
        }

        if (config.MinimumSizeBytes > config.MaximumSizeBytes)
        {
            throw BadPayload(
                $"MinimumSizeBytes {config.MinimumSizeBytes} is above MaximumSizeBytes "
                + $"{config.MaximumSizeBytes}");
        }

        if (config.MaximumSizeBytes > _podCeiling)
        {
            // NOT clamped. Silently lowering it would have the author's 100MB expectation fail at 32
            // with nothing saying which number won.
            throw BadPayload(
                $"MaximumSizeBytes {config.MaximumSizeBytes} is above this pod's ceiling of "
                + $"{_podCeiling}; raise FileFetcher__MaxFileSizeBytes or lower the step");
        }

        return (config, whitelist);
    }

    /// <summary>
    /// The dry inspection: existence, extension, size. Every one of these reads metadata only —
    /// <c>FileInfo</c> never opens the file — so a file that fails here is never opened at all.
    /// </summary>
    private static FileInfo Inspect(
        string path, FileFetcherConfig config, IReadOnlyList<string> whitelist)
    {
        var info = new FileInfo(path);

        if (!info.Exists)
        {
            // "reading", not "rejected": an absent file is not a file that broke a rule, and the two
            // classes are searched separately.
            throw Unreadable(path, "it does not exist");
        }

        if (!ExtensionWhitelist.Admits(whitelist, info.Extension))
        {
            // The list is named so an operator does not have to go and read the step payload.
            throw Rejected(path,
                $"extension '{info.Extension}' is not in the allowed list "
                + $"({ExtensionWhitelist.Describe(whitelist)})");
        }

        if (info.Length < config.MinimumSizeBytes)
        {
            throw Rejected(path,
                $"{info.Length} bytes is below the {config.MinimumSizeBytes} byte floor");
        }

        if (info.Length > config.MaximumSizeBytes)
        {
            throw Rejected(path,
                $"{info.Length} bytes is above the {config.MaximumSizeBytes} byte ceiling");
        }

        return info;
    }

    /// <summary>
    /// The read. Every IO fault is a failed step regardless of cause: there is no requeue path here
    /// — the framework requeues only <c>TransientSendException</c>, which can arise solely from
    /// <c>SendToPostAsync</c> — so classifying the fault would change nothing about the disposition.
    /// </summary>
    private static byte[] Read(FileInfo info)
    {
        try
        {
            return File.ReadAllBytes(info.FullName);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException
                                      or NotSupportedException)
        {
            throw Unreadable(info.FullName, ex.Message);
        }
    }

    // THE THREE FAILURE CLASSES, AND NONE OF THEM LOGS. ProcessDispatchHandler catches
    // FailedException and writes the author's message verbatim, so a line here would emit every
    // failure twice. The message text IS the contract an operator searches.

    /// <summary>A malformed payload, diagnosed before any path has been read.</summary>
    private static FailedException BadPayload(string reason)
        => new($"step payload rejected: {reason}");

    /// <summary>A file that broke a rule. Separate from BadPayload because this one has a path.</summary>
    private static FailedException Rejected(string path, string reason)
        => new($"file {path} rejected: {reason}");

    /// <summary>A file that could not be read, whatever the cause.</summary>
    private static FailedException Unreadable(string path, string reason)
        => new($"reading {path} failed: {reason}");

    /// <summary>
    /// The absolute path this dispatch names, or a failed step saying why there isn't one.
    /// <para>
    /// The parse is wrapped rather than left to throw: a malformed upstream record is a business
    /// failure with a diagnosis, not a framework exception with a sanitized message.
    /// </para>
    /// </summary>
    private static string ReadPath(byte[] data)
    {
        FileLocator? locator;
        var reason = "the branch is not JSON";

        try
        {
            locator = JsonSerializer.Deserialize<FileLocator>(data, ProcessorConfig.SerializerOptions);
        }
        catch (JsonException)
        {
            // Swallowed on purpose. The exception's text quotes the fragment that failed to parse,
            // and that fragment is upstream content — it must not reach a log store. The class of
            // fault is what is reported; the ids in the open scope are how it is traced back.
            locator = null;
        }

        if (locator?.FilePath is { Length: > 0 } filePath)
        {
            // IsPathFullyQualified, not IsPathRooted: on Windows a drive-relative path such as
            // "\orders.csv" is rooted but not absolute — it still resolves against whatever drive is
            // current, which is not a location any workflow author chose. Production runs on Linux,
            // where the two agree, but the tests here run on Windows, where they do not.
            if (Path.IsPathFullyQualified(filePath))
            {
                return filePath;
            }

            reason = "the path is relative, and only an absolute path names one location";
        }
        else if (locator is not null)
        {
            reason = "the branch carries no filePath";
        }

        throw new FailedException($"input branch did not name a file path: {reason}");
    }
}
```

- [ ] **Step 11: Restore the processor registration**

In `src/Processor.FileFetcher/ProcessorHost.cs`, uncomment:

```csharp
        builder.Services.AddSingleton<BaseProcessor.Core.Processing.BaseProcessor, FileFetcherProcessor>();
```

- [ ] **Step 12: Write the schema README**

Create `src/Processor.FileFetcher/schema/README.md`:

```markdown
# FileFetcher output schema

`output.json` is the envelope this processor puts on the wire, and it is registered against the
processor identity as the output schema. `Processor.ArchiveExpander/schema/input.json` is a
byte-identical copy registered as the next step's input schema.

## What it asserts

- Six keys, `additionalProperties: false`. A key nobody agreed on must not travel silently — in
  particular `filePath`, which is deliberately absent from the envelope.
- Every key is REQUIRED and present, including the two timestamps that are frequently null. The
  serializer is configured `DefaultIgnoreCondition.Never` for exactly this reason.
- `content` is a base64 string. An empty file is `""`, which is why there is no `minLength` on it.
- `extension` has no `minLength` either: a file with no dot in its name has `FileInfo.Extension` of
  `""`, and such a file is legal under the `*.*` whitelist.
- `fileName` DOES carry `minLength: 1`. There is no such thing as a file without a name, and
  ArchiveExpander's root metadata node requires one.

## Why two copies rather than one shared file

The two processors are separate assemblies with no project reference between them, and each image
must carry its own schema so it can be registered from the image. They are duplicated for the same
reason `ProcessorJsonSchemaValidator` duplicates `JsonSchemaConfig`: the assemblies must not
reference each other. **The two must stay in sync.** `EnvelopeContractTests` is what catches a
divergence — it validates one processor's output against the other's registered input schema.
```

- [ ] **Step 13: Run the tests**

Run: `dotnet build SK_P.sln && dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: build succeeds with no warnings; every new `FileFetcher` test passes; `0 failed`, exit 0.

- [ ] **Step 14: Commit**

```bash
git add -A
git commit -m "feat(filefetcher): the working fetcher and its envelope

Path in, {fileName, extension, sizeBytes, createdUtc, modifiedUtc,
content} out, behind the whitelist and the size range. The extension,
size and locator coverage is ported off ArchiveExpander here so the next
task can strip that processor without the suite losing anything."
```

---

## Task 4: ArchiveExpander drops the filesystem

Removes the path, the dry inspection and the file read; moves the expansion ceiling to a pod option; retargets the builder onto the envelope. The output document does not change.

**Files:**
- Create: `src/Processor.ArchiveExpander/FetchedFile.cs`
- Create: `src/Processor.ArchiveExpander/schema/input.json`
- Modify: `src/Processor.ArchiveExpander/ArchiveExpanderConfig.cs`
- Modify: `src/Processor.ArchiveExpander/ArchiveExpanderOptions.cs`
- Modify: `src/Processor.ArchiveExpander/ArchiveExpanderProcessor.cs`
- Modify: `src/Processor.ArchiveExpander/FileContentBuilder.cs:33-80` and `:200-230`
- Modify: `src/Processor.ArchiveExpander/ProcessorHost.cs`
- Modify: `src/Processor.ArchiveExpander/Processor.ArchiveExpander.csproj`
- Modify: `src/Processor.ArchiveExpander/appsettings.json`
- Delete: `src/Processor.ArchiveExpander/FileLocator.cs`
- Modify: `src/tests/BaseApi.Tests/ArchiveExpander/*.cs`
- Delete: `src/tests/BaseApi.Tests/ArchiveExpander/ArchiveExpanderLocatorTests.cs`

**Interfaces:**
- Consumes: the envelope shape produced in Task 3 — camelCase, all keys present, `content` base64.
- Produces: `internal sealed record FetchedFile(string? FileName, string? Extension, long SizeBytes, DateTime? CreatedUtc, DateTime? ModifiedUtc, byte[]? Content)` (the wire form) and `internal sealed record SourceFile(string Name, string Extension, byte[] Content, long SizeBytes, DateTime? CreatedUtc, DateTime? ModifiedUtc)` (validated); `ArchiveExpanderConfig(int MaxDepth = 1)` with `DefaultMaxDepth` and `MaxSupportedDepth = 64`; `ArchiveExpanderOptions.MaxExpandedBytes` (long, default `33_554_432`); `FileContentBuilder(IEnumerable<IArchiveExtractor>, IOptions<ArchiveExpanderOptions>)` with `Build(SourceFile, ArchiveExpanderConfig) → FileBuildResult`.

- [ ] **Step 1: Write the failing envelope-reading tests**

Create `src/tests/BaseApi.Tests/ArchiveExpander/ArchiveExpanderEnvelopeTests.cs`:

```csharp
using System.Text;
using System.Text.Json;
using BaseApi.Tests.Support;
using BaseProcessor.Core.Processing;
using Messaging.Transport;
using Microsoft.Extensions.Options;
using NSubstitute;
using Processor.ArchiveExpander;
using Xunit;

namespace BaseApi.Tests.ArchiveExpander;

/// <summary>
/// The input branch, which is now an envelope rather than a path. Every failure is a business
/// failure with a diagnosis, and none quotes the fragment that failed to parse.
/// </summary>
public sealed class ArchiveExpanderEnvelopeTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");
    private static readonly Guid E = Guid.Parse("55555555-5555-5555-5555-555555555555");

    private const string Payload = """{"MaxDepth":1}""";

    private static ArchiveExpanderProcessor Build()
    {
        var processor = new ArchiveExpanderProcessor(
            new RecordingLogger<ArchiveExpanderProcessor>(),
            new FileContentBuilder([], Options.Create(new ArchiveExpanderOptions())));
        processor.BeginDispatch(new DispatchState(Substitute.For<IQueueSender>(), C, W, S, P));
        return processor;
    }

    private static async Task<string> FailureFor(byte[] branch)
    {
        var ex = await Assert.ThrowsAsync<FailedException>(
            () => Build().ExecuteAsync(branch, Payload, E, CancellationToken.None));
        return ex.Message;
    }

    [Fact]
    public async Task ABranchThatIsNotJsonFailsWithoutQuotingIt()
    {
        var message = await FailureFor(Encoding.UTF8.GetBytes("not json at all"));

        Assert.StartsWith("input branch did not carry a fetched file: ", message,
                          StringComparison.Ordinal);
        Assert.Contains("the branch is not JSON", message, StringComparison.Ordinal);
        Assert.DoesNotContain("not json at all", message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnEnvelopeWithNoFileNameFails()
    {
        var message = await FailureFor(Encoding.UTF8.GetBytes(
            """{"extension":".csv","sizeBytes":2,"createdUtc":null,"modifiedUtc":null,"content":"aWQ="}"""));

        Assert.Contains("the branch carries no fileName", message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnEnvelopeWithNoContentFails()
    {
        var message = await FailureFor(Encoding.UTF8.GetBytes(
            """{"fileName":"a.csv","extension":".csv","sizeBytes":2,"createdUtc":null,"modifiedUtc":null}"""));

        Assert.Contains("the branch carries no content", message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnAbsentPayloadFailsTheStep()
    {
        var processor = Build();

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => processor.ExecuteAsync([], "", E, CancellationToken.None));

        Assert.StartsWith("step payload rejected: ", ex.Message, StringComparison.Ordinal);
        Assert.Contains("needs MaxDepth", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnExplicitZeroDepthIsRejected()
    {
        // Absent means 1, via the record's own default parameter value. An explicit 0 means the
        // payload SAID zero, and that is far more likely to be a payload written against the wrong
        // field than a request for no expansion.
        var processor = Build();

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => processor.ExecuteAsync(
                Encoding.UTF8.GetBytes(
                    """{"fileName":"a.csv","extension":".csv","sizeBytes":2,"createdUtc":null,"modifiedUtc":null,"content":"aWQ="}"""),
                """{"MaxDepth":0}""", E, CancellationToken.None));

        Assert.Contains("MaxDepth must be between 1 and 64", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnOmittedDepthIsOne()
    {
        // No throw is the assertion: an omitted MaxDepth must not arrive as default(int) and be
        // rejected as zero.
        var processor = Build();

        await processor.ExecuteAsync(
            Encoding.UTF8.GetBytes(
                """{"fileName":"a.csv","extension":".csv","sizeBytes":2,"createdUtc":null,"modifiedUtc":null,"content":"aWQ="}"""),
            "{}", E, CancellationToken.None);
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: compile failure — `FileContentBuilder` has no two-argument constructor; `ArchiveExpanderOptions` has no `MaxExpandedBytes`.

- [ ] **Step 3: Write the reader's envelope records**

Create `src/Processor.ArchiveExpander/FetchedFile.cs`:

```csharp
namespace Processor.ArchiveExpander;

/// <summary>
/// The envelope as it ARRIVES: every field optional, because a malformed upstream record must be
/// diagnosed rather than thrown at. Bound with <c>ProcessorConfig.SerializerOptions</c>, which is
/// case-insensitive and ignores unknown properties.
/// <para>
/// <b>This is the reader's copy of <c>Processor.FileFetcher.FetchedFile</c>, whose fields are all
/// non-nullable.</b> The two describe one JSON document across two assemblies that must not
/// reference each other — the same arrangement, for the same reason, as
/// <c>ProcessorJsonSchemaValidator</c> duplicating <c>JsonSchemaConfig</c>. The two registered
/// schema files pin the shape and <c>EnvelopeContractTests</c> is what catches a divergence.
/// </para>
/// <para>
/// <c>byte[]</c> needs no converter: System.Text.Json reads a base64 string straight into one.
/// </para>
/// </summary>
internal sealed record FetchedFile(
    string? FileName,
    string? Extension,
    long SizeBytes,
    DateTime? CreatedUtc,
    DateTime? ModifiedUtc,
    byte[]? Content);

/// <summary>
/// The envelope, checked. Nothing constructs this without having validated the wire form first,
/// which is why every field is non-nullable and <see cref="FileContentBuilder"/> takes this rather
/// than <see cref="FetchedFile"/>.
/// <para>
/// <b>Extension may be the empty string and that is legal</b> — a file with no dot in its name is
/// admitted upstream under the <c>*.*</c> whitelist, and <c>FileInfo.Extension</c> reports
/// <c>""</c> for it. Only the name and the content are required to be there at all.
/// </para>
/// </summary>
internal sealed record SourceFile(
    string Name,
    string Extension,
    byte[] Content,
    long SizeBytes,
    DateTime? CreatedUtc,
    DateTime? ModifiedUtc);
```

- [ ] **Step 4: Rewrite the config record**

Replace the whole of `src/Processor.ArchiveExpander/ArchiveExpanderConfig.cs`:

```csharp
using BaseProcessor.Core.Configuration;

namespace Processor.ArchiveExpander;

/// <summary>
/// The step payload, and it holds exactly one field.
/// <para>
/// <b>Every file rule left with the filesystem.</b> Extension and size are knowable from
/// <c>FileInfo</c> and are checked by <c>FileFetcher</c> before the file is opened; this processor
/// never sees a path and could not re-check them if it wanted to. What is left is the one decision
/// that is genuinely about expansion.
/// </para>
/// <para>
/// <b>There is no expansion ceiling here either, and that is a decision.</b> How much an archive
/// expands to is a number an operator sizes against a container limit — a workflow author has no way
/// to know it — so it lives in the manifest as <c>ArchiveExpander__MaxExpandedBytes</c>. See
/// <see cref="ArchiveExpanderOptions"/>.
/// </para>
/// </summary>
/// <param name="MaxDepth">
/// How many levels of archive to expand. <b>Absent means 1</b> — the top-level archive is expanded
/// and its entries are left as files.
/// <para>
/// <b>The fallback is the parameter's own default, and that was verified rather than assumed.</b>
/// System.Text.Json applies a C# default parameter value when a positional record's property is
/// missing from the payload, so an omitted field arrives as 1 rather than as <c>default(int)</c>.
/// That keeps "absent" and "zero" distinguishable without a nullable: absent is 1, and an explicit 0
/// stays 0 and is a rejected payload.
/// </para>
/// <para>
/// <b>It has no memory cost of its own, which is why it has no pod-level twin.</b> Depth costs
/// nothing; bytes do, and <see cref="ArchiveExpanderOptions.MaxExpandedBytes"/> already bounds those
/// across the whole tree.
/// </para>
/// <para>
/// <b>The registered output schema is the other bound on this, and nothing keeps the two in
/// sync.</b> The schema is a row against the processor identity and it states its depth
/// structurally. A step whose <c>MaxDepth</c> produces a document deeper than the schema admits
/// fails validation in the post handler. That is the contract working, not a fault to design around,
/// but it is why raising this is a decision taken against the schema rather than alone.
/// </para>
/// </param>
public sealed record ArchiveExpanderConfig(
    int MaxDepth = ArchiveExpanderConfig.DefaultMaxDepth) : ProcessorConfig
{
    /// <summary>
    /// The default: expand the top-level archive, leave its entries as files.
    /// <para>
    /// It is the value this processor behaved as before <see cref="MaxDepth"/> existed, so every
    /// workflow authored without the field keeps its documents byte-identical in shape.
    /// </para>
    /// </summary>
    public const int DefaultMaxDepth = 1;

    /// <summary>
    /// The most any step may ask for.
    /// <para>
    /// <b>A cap exists so the expansion cannot outrun the stack.</b> The builder recurses, and a
    /// bounded depth is what makes that safe to read and safe to run. The number is arbitrary and
    /// deliberately generous: nothing legitimate nests archives sixty-four deep, and a
    /// self-reproducing archive — which expands to a copy of itself at roughly constant size — is
    /// stopped here rather than being left to grind against the expansion ceiling for thousands of
    /// levels first.
    /// </para>
    /// </summary>
    public const int MaxSupportedDepth = 64;
}
```

- [ ] **Step 5: Rewrite the options**

Replace the whole of `src/Processor.ArchiveExpander/ArchiveExpanderOptions.cs`:

```csharp
using Microsoft.Extensions.Configuration;

namespace Processor.ArchiveExpander;

/// <summary>
/// The pod's expansion ceiling, bound from the <c>"ArchiveExpander"</c> config section and set in the
/// manifest as <c>ArchiveExpander__MaxExpandedBytes</c>.
/// <para>
/// <b>It bounds the cumulative size of everything an archive expands to, across every level</b> —
/// not the file, which <c>FileFetcher__MaxFileSizeBytes</c> already bounded one hop upstream. The
/// two are different quantities: an ordinary 10:1 CSV zip admitted at a 32 MiB file ceiling is
/// ~320 MB expanded before the document and the envelope are counted.
/// </para>
/// <para>
/// <b>It is an option rather than a step field because it is a memory guard, not a workflow
/// rule.</b> An operator sizes it against this container's limit; a workflow author has no way to
/// know what a given archive expands to, and asking them for the number was always asking them to
/// guess. In FileReader this lived on the step payload as the second meaning of
/// <c>MaximumSizeBytes</c>, and that field always had two owners.
/// </para>
/// <para>
/// <b>The default is FileReader's own, so the split changes no behaviour.</b> A workflow that
/// previously named 33554432 gets the same ceiling without naming anything.
/// </para>
/// </summary>
public sealed class ArchiveExpanderOptions
{
    /// <summary>Ceiling in bytes (default 32 MiB). The default lives here so an unset variable is
    /// never unbounded.</summary>
    [ConfigurationKeyName("MaxExpandedBytes")]
    public long MaxExpandedBytes { get; set; } = 33_554_432;
}
```

- [ ] **Step 6: Retarget the builder**

In `src/Processor.ArchiveExpander/FileContentBuilder.cs`, change the class declaration and the `Build` method. The rest of the file — `BuildNode`, `NamedAsArchive`, `Match`, `ExpansionBudget` — is untouched except for the budget's construction.

Replace the class header:

```csharp
internal sealed class FileContentBuilder(
    IEnumerable<IArchiveExtractor> extractors,
    IOptions<ArchiveExpanderOptions> options)
{
    private readonly IReadOnlyList<IArchiveExtractor> _extractors = extractors.ToList();

    // The pod's ceiling, read once. It is not a step field: see ArchiveExpanderOptions for why the
    // size of an expansion has an operator for an owner and not a workflow author.
    private readonly long _maxExpandedBytes = options.Value.MaxExpandedBytes;
```

Add `using Microsoft.Extensions.Options;` to the file's usings.

Replace `Build`'s signature and body down to the `return`:

```csharp
    /// <summary>
    /// The document. An archive is expanded until <see cref="ArchiveExpanderConfig.MaxDepth"/> is
    /// reached or nothing left is an archive, whichever comes first.
    /// </summary>
    public FileBuildResult Build(SourceFile file, ArchiveExpanderConfig config)
    {
        // THE DECLARATION CROSS-CHECK, and it applies to the top-level file ONLY.
        //
        // Choosing the extractor by signature means a file whose bytes are not an archive is simply
        // a leaf — which is right for a CSV and WRONG for a damaged zip, because the step would
        // report Completed over a file nobody can open. That is the false-HEALTHY failure each
        // extractor's internal guard exists to prevent, reached from outside those guards: a
        // corrupt header matches no signature, so no extractor is ever asked.
        //
        // THE CLAIM IT CHECKS AGAINST NOW LIVES ONE HOP UPSTREAM. It used to be that
        // ExpectedExtension had to match this file's extension for it to be admitted at all; it is
        // now FileFetcher's whitelist that admitted it. Same guarantee, asserted by a different
        // processor, and the extension reaches here in the envelope either way. Below this level
        // nothing is declared — an entry's name is written by whoever built the archive — so nested
        // entries get no such check and an unrecognised one is an ordinary leaf.
        //
        // A .zip that is really a tar does NOT fail: an extractor claims it by signature, and
        // reading the content is the more useful answer than refusing the name.
        if (NamedAsArchive(file.Extension) && Match(file.Content) is null)
        {
            throw new ArchiveExtractionException(
                $"the file is named '{file.Extension}' and its leading bytes are no archive this "
                + "processor knows — treating it as corrupt rather than recording it as a plain file");
        }

        // ONE budget for the WHOLE tree, not one per level. Threading a running total through the
        // recursion is what keeps MaxDepth safe to raise: a per-level ceiling would let a depth-5
        // archive hold five times the limit, and the pod's memory does not care which level a byte
        // came from.
        var budget = new ExpansionBudget(_maxExpandedBytes);
        var depthReached = 0;

        var node = BuildNode(
            file.Name,
            file.Extension,
            file.Content,
            // The size the fetcher measured with FileInfo.Length, not the array's length: for the
            // root they agree, and the former is what the dry inspection reported to an operator.
            file.SizeBytes,
            file.CreatedUtc,
            file.ModifiedUtc,
            depth: 0,
            config.MaxDepth,
            budget,
            ref depthReached);

        return new FileBuildResult(node, depthReached);
    }
```

In `ExpansionBudget`'s doc comment, replace the sentence naming `k8s/37-processor-filereader.yaml` with `k8s/37-processor-archiveexpander.yaml`, and the phrase "the only bound anywhere is on the FILE" with "the only bound anywhere is the file ceiling one hop upstream".

- [ ] **Step 7: Rewrite the processor**

In `src/Processor.ArchiveExpander/ArchiveExpanderProcessor.cs`: delete `Inspect`, `Read`, `Rejected` and `Unreadable` entirely; replace the constructor, `ProcessAsync`, `Validate` and `ReadPath`.

```csharp
using System.Text.Json;
using BaseProcessor.Core.Configuration;
using BaseProcessor.Core.Processing;
using Microsoft.Extensions.Logging;
using Processor.ArchiveExpander.Extractors;

namespace Processor.ArchiveExpander;

/// <summary>
/// Turns a fetched file into one structured document. A plain downstream transform: it has an input
/// and it produces output, so it is not an edge and neither <c>BaseImporter</c> nor
/// <c>BaseExporter</c> applies.
/// <para>
/// <b>It performs no file IO.</b> The path, the dry inspection and the read all live in
/// <c>FileFetcher</c>, which hands this processor an envelope. There is no <c>FileInfo</c> in this
/// assembly and no volume mount on this pod.
/// </para>
/// </summary>
internal sealed class ArchiveExpanderProcessor(
    ILogger<ArchiveExpanderProcessor> logger,
    FileContentBuilder builder)
    : BaseProcessor<ArchiveExpanderConfig>
{
    protected override async Task ProcessAsync(
        byte[] data, ArchiveExpanderConfig? config, Guid executionId, CancellationToken ct)
    {
        // Config first: it is the cheapest check and it depends on nothing else.
        var settings = Validate(config);

        var file = ReadEnvelope(data);

        FileBuildResult built;
        try
        {
            built = builder.Build(file, settings);
        }
        catch (ArchiveExtractionException ex)
        {
            // A corrupt or truncated archive, or one that expands past the ceiling. Deterministic —
            // it fails identically on every redelivery — so it is a failed step, not something to
            // park. No log here: the framework writes this message verbatim when it catches the
            // exception.
            //
            // ONE TYPE, NOT A LIST OF LIBRARY TYPES. Each extractor wraps its own library's faults,
            // exactly as BaseExporter's sinks wrap theirs into ExportSinkException, because
            // SharpCompress's entire hierarchy descends from SharpCompressException and matched none
            // of the BCL types this used to catch.
            //
            // Bare Exception is deliberately NOT caught: a NullReferenceException in the builder is
            // a programming error, and reporting it to an operator as a corrupt file buries a bug
            // under a plausible business failure.
            //
            // IT NAMES THE FILE, NOT A PATH. There is no path in this assembly any more. The name
            // came from the envelope, and FileFetcher's own log line is what ties it back to a
            // location on disk — under the same ExecutionId and CorrelationId.
            throw new FailedException($"extracting {file.Name} failed: {ex.Message}");
        }

        // The SHAPE of the result, never its content. A count, a size and a depth are safe to log;
        // the bytes are upstream data and stay out of every template in this system.
        //
        // THE DEPTH IS HERE BECAUSE THIS IS THE ONLY PLACE IT SURVIVES. The registered output schema
        // states its depth structurally, and a document deeper than the schema admits fails
        // validation one hop later — reported with EntryId Guid.Empty, no payload and no file name.
        // Nothing in that failure says how deep this document actually went, so a MaxDepth that
        // disagrees with the schema would otherwise be undiagnosable from the logs. Both numbers are
        // logged: what was asked for, and what the file actually needed.
        logger.LogInformation(
            "expanded {FileName} of {SizeBytes} bytes into {EntryCount} entries, reaching depth "
            + "{DepthReached} of {MaxDepth}",
            file.Name, file.SizeBytes, built.Node.Metadata.EntryCount, built.DepthReached,
            settings.MaxDepth);

        var document = JsonSerializer.SerializeToUtf8Bytes(built.Node, FileDocument.Options);

        // ONE branch, on the execution id this dispatch arrived with. Not NewExecutionId(): this is
        // a transform, not a source, so the lineage it was handed is the lineage it continues.
        await SendToPostAsync(document, executionId, ct).ConfigureAwait(false);
    }

    /// <summary>The payload, checked. Throws <see cref="FailedException"/> with the reason.</summary>
    private static ArchiveExpanderConfig Validate(ArchiveExpanderConfig? config)
    {
        if (config is null)
        {
            // An absent payload IS a malformed payload, and it shares the prefix so one query finds
            // every payload fault including the commonest one.
            //
            // It is rejected even though every field on this record now has a default. "{}" is a
            // payload that named nothing and gets MaxDepth 1; a null payload is a step that was
            // wired without one at all, and the two are worth distinguishing.
            throw BadPayload("ArchiveExpander needs MaxDepth");
        }

        // An omitted MaxDepth never reaches here as 0: System.Text.Json applies the record's own
        // default parameter value to a missing property, so absent arrives as DefaultMaxDepth. A 0
        // therefore means the payload SAID zero, and that is rejected rather than read as "do not
        // expand" — a step wanting no expansion is asking for a plain file, and naming a depth of
        // nothing is far more likely to be a payload written against the wrong field.
        //
        // The upper bound is what makes the builder's recursion safe: it is the stack depth this
        // pod will ever reach, fixed before any archive is opened.
        if (config.MaxDepth < 1 || config.MaxDepth > ArchiveExpanderConfig.MaxSupportedDepth)
        {
            throw BadPayload(
                $"MaxDepth must be between 1 and {ArchiveExpanderConfig.MaxSupportedDepth}; the "
                + $"payload named {config.MaxDepth}");
        }

        return config;
    }

    // THE TWO FAILURE CLASSES, AND NEITHER LOGS. ProcessDispatchHandler catches FailedException and
    // writes the author's message verbatim, so a line here would emit every failure twice. The
    // message text IS the contract an operator searches.
    //
    // The `rejected` and `reading ... failed` classes left with the filesystem, to FileFetcher, with
    // their templates unchanged — so an operator's existing queries still match, they simply match a
    // different pod.

    /// <summary>A malformed payload, diagnosed before any envelope has been read.</summary>
    private static FailedException BadPayload(string reason)
        => new($"step payload rejected: {reason}");

    /// <summary>
    /// The file this dispatch carries, or a failed step saying why there isn't one.
    /// <para>
    /// The parse is wrapped rather than left to throw: a malformed upstream record is a business
    /// failure with a diagnosis, not a framework exception with a sanitized message.
    /// </para>
    /// </summary>
    private static SourceFile ReadEnvelope(byte[] data)
    {
        FetchedFile? envelope;
        var reason = "the branch is not JSON";

        try
        {
            envelope = JsonSerializer.Deserialize<FetchedFile>(
                data, ProcessorConfig.SerializerOptions);
        }
        catch (JsonException)
        {
            // Swallowed on purpose. The exception's text quotes the fragment that failed to parse,
            // and that fragment is upstream content — it must not reach a log store. The class of
            // fault is what is reported; the ids in the open scope are how it is traced back.
            envelope = null;
        }

        if (envelope is not null)
        {
            if (envelope.FileName is not { Length: > 0 } name)
            {
                reason = "the branch carries no fileName";
            }
            else if (envelope.Content is not { } content)
            {
                reason = "the branch carries no content";
            }
            else
            {
                // Extension may legitimately be absent or empty: a file with no dot in its name is
                // admitted upstream under the "*.*" whitelist. It becomes "", which is what
                // FileInfo.Extension would have said, and what the output document records.
                return new SourceFile(
                    name, envelope.Extension ?? string.Empty, content,
                    envelope.SizeBytes, envelope.CreatedUtc, envelope.ModifiedUtc);
            }
        }

        throw new FailedException($"input branch did not carry a fetched file: {reason}");
    }
}
```

- [ ] **Step 8: Delete the locator and its tests**

```bash
git rm src/Processor.ArchiveExpander/FileLocator.cs
git rm src/tests/BaseApi.Tests/ArchiveExpander/ArchiveExpanderLocatorTests.cs
```

Task 3 reproduced this coverage as `FileFetcherLocatorTests`; nothing is lost.

- [ ] **Step 9: Write the input schema**

Create `src/Processor.ArchiveExpander/schema/input.json`, byte-identical to `src/Processor.FileFetcher/schema/output.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "required": ["fileName", "extension", "sizeBytes", "createdUtc", "modifiedUtc", "content"],
  "properties": {
    "fileName":    { "type": "string", "minLength": 1 },
    "extension":   { "type": "string" },
    "sizeBytes":   { "type": "integer", "minimum": 0 },
    "createdUtc":  { "type": ["string", "null"] },
    "modifiedUtc": { "type": ["string", "null"] },
    "content":     { "type": "string" }
  }
}
```

- [ ] **Step 10: Ship the schema with the image and repoint the options section**

In `src/Processor.ArchiveExpander/Processor.ArchiveExpander.csproj`, add to the content `ItemGroup`:

```xml
    <!-- The input schema travels too: this processor's input contract is the fetcher's output
         contract, and both images must be able to register their own. -->
    <Content Include="schema\input.json" CopyToOutputDirectory="PreserveNewest" />
```

In `src/Processor.ArchiveExpander/ProcessorHost.cs`, replace the options registration and its comment:

```csharp
        // The pod's expansion ceiling, from ArchiveExpander__MaxExpandedBytes in the manifest. What
        // an archive expands to is an operator's number sized against a container limit, which is
        // why it is here and not on the step payload.
        builder.Services.Configure<ArchiveExpanderOptions>(
            builder.Configuration.GetSection("ArchiveExpander"));
```

In `src/Processor.ArchiveExpander/appsettings.json`, replace the `"ArchiveExpander"` section:

```json
  "ArchiveExpander": {
    "MaxExpandedBytes": 33554432
  },
```

- [ ] **Step 11: Update the remaining ArchiveExpander tests**

Across `src/tests/BaseApi.Tests/ArchiveExpander/*.cs`, apply these three mechanical changes:

1. `new FileContentBuilder([])` → `new FileContentBuilder([], Options.Create(new ArchiveExpanderOptions()))`, and add `using Microsoft.Extensions.Options;` where missing.
2. `new ArchiveExpanderProcessor(log, Options.Create(new ArchiveExpanderOptions { ... }), builder)` → `new ArchiveExpanderProcessor(log, builder)` — the processor no longer takes options.
3. Every test that drives the processor: replace the `{filePath = path}` branch and the `{"ExpectedExtension":...}` payload with an envelope and `{"MaxDepth":N}`. Use this helper, added to each test class that needs it:

```csharp
    /// <summary>The envelope FileFetcher would have sent for these bytes.</summary>
    private static byte[] Envelope(string name, byte[] content, DateTime? stamp = null)
        => JsonSerializer.SerializeToUtf8Bytes(
            new
            {
                fileName    = name,
                extension   = Path.GetExtension(name),
                sizeBytes   = (long)content.Length,
                createdUtc  = stamp,
                modifiedUtc = stamp,
                content,
            },
            new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });
```

Tests that wrote a temp file only to feed the processor no longer need one — delete the `IDisposable`, the temp directory and the `WriteFile`/`WriteText` helpers from `ArchiveExpanderDepthTests`, `ArchiveExpanderDocumentTests` and `ArchiveExpanderGuardTests`, and build the bytes in memory instead. `ArchiveExpanderSchemaTests` needs no change at all: it validates `FileNode` documents and never touches a file.

Delete from `ArchiveExpanderGuardTests` every test whose subject moved: the extension mismatch, the floor, the ceiling, the missing file, and the pod-ceiling-vs-payload case. Task 3 reproduced all five against `FileFetcher`. What remains in that class is `MaxDepth` validation, which `ArchiveExpanderEnvelopeTests` now covers — so if the class ends up empty, delete the file.

- [ ] **Step 12: Build and run the suite**

Run: `dotnet build SK_P.sln && dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: build succeeds with no warnings; `0 failed`, exit 0; `Live/` all skipped.

- [ ] **Step 13: Verify the output document really did not change**

Run: `git diff HEAD -- src/Processor.ArchiveExpander/schema/output.json src/Processor.ArchiveExpander/FileNode.cs`
Expected: **empty**. Any diff here means the task went wrong — the output contract is unchanged by the split.

- [ ] **Step 14: Commit**

```bash
git add -A
git commit -m "feat(archiveexpander): take an envelope, not a path

Inspect and Read are gone with the config fields that drove them; the
expansion ceiling becomes ArchiveExpander__MaxExpandedBytes at its old
default, so behaviour is unchanged. The declared-extension cross-check
stays put — the extension still arrives, now in the envelope.

The output document and its schema are byte-identical."
```

---

## Task 5: The cross-hop contract test

One test class that neither pod can host alone: it drives the real `FileFetcherProcessor`, takes the bytes it actually sent, and feeds them to the real `ArchiveExpanderProcessor`. It is what catches the two `FetchedFile` records or the two schema files drifting apart.

**Files:**
- Test: `src/tests/BaseApi.Tests/EnvelopeContractTests.cs`

**Interfaces:**
- Consumes: `FileFetcherProcessor`, `FileFetcherOptions` (Task 3); `ArchiveExpanderProcessor`, `FileContentBuilder`, `ArchiveExpanderOptions`, `FileNode`, `FileDocument.Options` (Task 4).
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

Create `src/tests/BaseApi.Tests/EnvelopeContractTests.cs`:

```csharp
using System.IO.Compression;
using System.Text;
using System.Text.Json;
using BaseApi.Tests.Support;
using BaseProcessor.Core.Validation;
using Messaging.Contracts;
using Messaging.Transport;
using Microsoft.Extensions.Options;
using NSubstitute;
using Processor.ArchiveExpander;
using Processor.ArchiveExpander.Extractors;
using Xunit;

namespace BaseApi.Tests;

/// <summary>
/// THE CONTRACT ACROSS THE SPLIT, and the one thing neither pod can verify alone.
/// <para>
/// The envelope is described in four places that nothing keeps in sync: FileFetcher's
/// <c>FetchedFile</c> (all fields required), ArchiveExpander's <c>FetchedFile</c> (all fields
/// optional), and the two schema files. Each half's own tests pass happily while the halves disagree.
/// This class runs both real processors back to back and validates the bytes in between against both
/// registered schemas, so a divergence fails here rather than in the cluster.
/// </para>
/// </summary>
public sealed class EnvelopeContractTests : IDisposable
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");
    private static readonly Guid E = Guid.Parse("55555555-5555-5555-5555-555555555555");

    private readonly string _dir = Directory.CreateTempSubdirectory("skp-envelope-").FullName;

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    private static string FetcherOutputSchema()
        => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "schema", "fetcher-output.json"));

    private static string ExpanderInputSchema()
        => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "schema", "input.json"));

    /// <summary>Runs the real fetcher and returns the single branch it sent.</summary>
    private async Task<byte[]> Fetch(string name, byte[] content, string payload)
    {
        var path = Path.Combine(_dir, name);
        await File.WriteAllBytesAsync(path, content);

        var sender = Substitute.For<IQueueSender>();
        var sends = new List<ProcessedData>();
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(sends.Add),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());

        var fetcher = new Processor.FileFetcher.FileFetcherProcessor(
            new RecordingLogger<Processor.FileFetcher.FileFetcherProcessor>(),
            Options.Create(new Processor.FileFetcher.FileFetcherOptions()));
        fetcher.BeginDispatch(new BaseProcessor.Core.Processing.DispatchState(sender, C, W, S, P));

        await fetcher.ExecuteAsync(
            Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { filePath = path })),
            payload, E, CancellationToken.None);

        return Assert.Single(sends).Data;
    }

    /// <summary>Runs the real expander over an envelope and returns the document it sent.</summary>
    private static async Task<byte[]> Expand(byte[] envelope, string payload)
    {
        var sender = Substitute.For<IQueueSender>();
        var sends = new List<ProcessedData>();
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(sends.Add),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());

        var expander = new ArchiveExpanderProcessor(
            new RecordingLogger<ArchiveExpanderProcessor>(),
            new FileContentBuilder(
                [new ZipExtractor()], Options.Create(new ArchiveExpanderOptions())));
        expander.BeginDispatch(new BaseProcessor.Core.Processing.DispatchState(sender, C, W, S, P));

        await expander.ExecuteAsync(envelope, payload, E, CancellationToken.None);

        return Assert.Single(sends).Data;
    }

    private const string AnyFile =
        """{"AllowedExtensions":["*.*"],"MinimumSizeBytes":0,"MaximumSizeBytes":1048576}""";

    private static byte[] Zip(params (string Name, string Text)[] entries)
    {
        using var buffer = new MemoryStream();
        using (var archive = new ZipArchive(buffer, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (var (name, text) in entries)
            {
                using var writer = new StreamWriter(archive.CreateEntry(name).Open());
                writer.Write(text);
            }
        }

        return buffer.ToArray();
    }

    [Fact]
    public async Task WhatTheFetcherSendsSatisfiesBothRegisteredSchemas()
    {
        // The two schema files are duplicates across assemblies that must not reference each other.
        // This is what catches them drifting.
        var envelope = await Fetch("orders.csv", Encoding.UTF8.GetBytes("id,name"), AnyFile);

        Assert.True(ProcessorJsonSchemaValidator.TryValidate(FetcherOutputSchema(), envelope, out var a),
                    string.Join("; ", a));
        Assert.True(ProcessorJsonSchemaValidator.TryValidate(ExpanderInputSchema(), envelope, out var b),
                    string.Join("; ", b));
    }

    [Fact]
    public async Task APlainFileSurvivesBothHops()
    {
        var envelope = await Fetch("orders.csv", Encoding.UTF8.GetBytes("id,name"), AnyFile);

        var document = await Expand(envelope, """{"MaxDepth":1}""");
        var node = JsonSerializer.Deserialize<FileNode>(document, FileDocument.Options)!;

        // THE ROOT NODE KEEPS ITS IDENTITY, and that is the whole reason the envelope exists rather
        // than raw bytes. A downstream step reading the filename off this metadata is why.
        Assert.Equal("orders.csv", node.Metadata.Name);
        Assert.Equal(".csv", node.Metadata.Extension);
        Assert.Equal(7, node.Metadata.SizeBytes);
        Assert.NotNull(node.Metadata.ModifiedUtc);

        var bytes = Assert.IsType<FileContent.Bytes>(node.Content);
        Assert.Equal("id,name", Encoding.UTF8.GetString(bytes.Value));
    }

    [Fact]
    public async Task AnArchiveSurvivesBothHopsAndTheDocumentValidates()
    {
        var envelope = await Fetch("orders.zip", Zip(("a.csv", "id"), ("b.csv", "id,name")), AnyFile);

        var document = await Expand(envelope, """{"MaxDepth":1}""");

        var outputSchema = File.ReadAllText(
            Path.Combine(AppContext.BaseDirectory, "schema", "output.json"));
        var node = JsonSerializer.Deserialize<FileNode>(document, FileDocument.Options)!;

        Assert.Equal("orders.zip", node.Metadata.Name);
        Assert.Equal(2, node.Metadata.EntryCount);
        var entries = Assert.IsType<FileContent.Entries>(node.Content);
        Assert.Equal(["a.csv", "b.csv"], entries.Value.Select(e => e.Metadata.Name).Order());

        // The output contract is unchanged by the split, and this is the assertion of that.
        Assert.True(ProcessorJsonSchemaValidator.TryValidate(outputSchema, document, out var errors),
                    string.Join("; ", errors));
    }

    [Fact]
    public async Task AnExtensionlessFileSurvivesBothHops()
    {
        // Admitted only under "*.*", carries "" as its extension, and must not trip the expander's
        // declared-extension cross-check.
        var envelope = await Fetch("README", Encoding.UTF8.GetBytes("hello"), AnyFile);

        var document = await Expand(envelope, """{"MaxDepth":1}""");
        var node = JsonSerializer.Deserialize<FileNode>(document, FileDocument.Options)!;

        Assert.Equal("README", node.Metadata.Name);
        Assert.Equal("", node.Metadata.Extension);
    }

    [Fact]
    public async Task AFileNamedZipThatIsNotOneStillFailsAsCorrupt()
    {
        // The cross-check survived the split. Its claim used to be ExpectedExtension matching; it is
        // now the fetcher's whitelist admitting the file, and the extension reaches the expander in
        // the envelope either way.
        var envelope = await Fetch("broken.zip", Encoding.UTF8.GetBytes("not a zip at all"), AnyFile);

        var ex = await Assert.ThrowsAsync<BaseProcessor.Core.Processing.FailedException>(
            () => Expand(envelope, """{"MaxDepth":1}"""));

        Assert.StartsWith("extracting broken.zip failed: ", ex.Message, StringComparison.Ordinal);
        Assert.Contains("treating it as corrupt", ex.Message, StringComparison.Ordinal);
    }
}
```

**Note on the three schema files.** Each project copies its own `schema/` into its own output; the test assembly gets nothing automatically. Three files must reach the test output, and **two of them are called `output.json`**, so the links disambiguate rather than collide. Task 1 Step 4b and Task 2 Step 10 added the first two; add the third to `src/tests/BaseApi.Tests/BaseApi.Tests.csproj`:

```xml
    <!-- The expander's INPUT schema — the other half of the envelope contract. Linked under its own
         name so EnvelopeContractTests validates against the REGISTERED file rather than a copy that
         can drift from it. -->
    <None Include="..\..\Processor.ArchiveExpander\schema\input.json"
          Link="schema\input.json" CopyToOutputDirectory="PreserveNewest" />
```

The three names in the test output are then:

| Link name | Source | Read by |
|---|---|---|
| `schema/output.json` | `Processor.ArchiveExpander/schema/output.json` | `ArchiveExpanderSchemaTests`, `EnvelopeContractTests` |
| `schema/fetcher-output.json` | `Processor.FileFetcher/schema/output.json` | `FileFetcherSchemaTests`, `EnvelopeContractTests` |
| `schema/input.json` | `Processor.ArchiveExpander/schema/input.json` | `EnvelopeContractTests` |

**`schema/output.json` stays pointed at the expander**, so `ArchiveExpanderSchemaTests` is untouched by this whole plan — which is what the Global Constraint about the unchanged output contract is asking for. In `EnvelopeContractTests` above, `FetcherOutputSchema()` reads `fetcher-output.json`, and the `outputSchema` local inside `AnArchiveSurvivesBothHopsAndTheDocumentValidates` reads `output.json` as written.

- [ ] **Step 2: Run to verify it fails, then passes**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected first: a schema file not found, or a collision between the two `output.json` copies. Resolve with the link renaming above.
Expected after: `0 failed`, exit 0.

- [ ] **Step 3: Prove the test actually bites**

Temporarily add `"filePath"` to the envelope written by `FileFetcherProcessor` (add a property to `FetchedFile` and pass `info.FullName`). Run the suite.
Expected: `WhatTheFetcherSendsSatisfiesBothRegisteredSchemas` FAILS on `additionalProperties`. Revert the change and confirm green again.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test: the envelope contract across both processors

The envelope is described in four places nothing keeps in sync — two
FetchedFile records and two schema files — and each half's own tests
pass happily while the halves disagree. This runs both real processors
back to back and validates the bytes in between against both schemas."
```

---

## Task 6: Manifests, image and the deployment path

**Files:**
- Create: `k8s/38-processor-filefetcher.yaml`
- Create: `src/Processor.FileFetcher/Dockerfile`
- Rename: `k8s/37-processor-filereader.yaml` → `k8s/37-processor-archiveexpander.yaml`
- Modify: `src/Processor.ArchiveExpander/Dockerfile`
- Modify: `src/Processor.ArchiveExpander/ArchiveExpanderConfig.cs`, `FileContentBuilder.cs` (manifest path references in doc comments)

**Interfaces:**
- Consumes: `FileFetcher__MaxFileSizeBytes` and `ArchiveExpander__MaxExpandedBytes` from Tasks 2 and 4.
- Produces: images `processor-filefetcher:local` and `processor-archiveexpander:local`.

- [ ] **Step 1: Write the FileFetcher Dockerfile**

Create `src/Processor.FileFetcher/Dockerfile` — `src/Processor.ArchiveExpander/Dockerfile` with every path substituted:

```dockerfile
# Build context is the REPO ROOT, not this directory:
#   docker build -f src/Processor.FileFetcher/Dockerfile -t processor-filefetcher:local .
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
# The repo's own libraries arrive as packages, from each packable project's own nuget/ folder.
#
# ALL FIVE feeds are copied, not just the ones this image consumes: NuGet validates every source in
# NuGet.config at restore time.
COPY src/Messaging.Contracts/nuget/ src/Messaging.Contracts/nuget/
COPY src/Messaging.Transport/nuget/ src/Messaging.Transport/nuget/
COPY src/BaseConsole.Core/nuget/ src/BaseConsole.Core/nuget/
COPY src/BaseApi.Core/nuget/ src/BaseApi.Core/nuget/
COPY src/BaseProcessor.Core/nuget/ src/BaseProcessor.Core/nuget/
COPY ["src/Processor.FileFetcher/Processor.FileFetcher.csproj", "src/Processor.FileFetcher/"]
RUN dotnet restore "src/Processor.FileFetcher/Processor.FileFetcher.csproj"

COPY src/Processor.FileFetcher/ src/Processor.FileFetcher/
RUN dotnet publish "src/Processor.FileFetcher/Processor.FileFetcher.csproj" \
      -c Release -o /publish --no-restore /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:8.0-bookworm-slim AS runtime
WORKDIR /app
COPY --from=build /publish .
USER app
# The health listener binds this itself from ConsoleHealth:Port; EXPOSE is documentation for a reader.
EXPOSE 8081
ENTRYPOINT ["dotnet", "Processor.FileFetcher.dll"]
```

- [ ] **Step 2: Verify the ArchiveExpander Dockerfile was fully renamed in Task 1**

```bash
grep -n "FileReader\|filereader" src/Processor.ArchiveExpander/Dockerfile
```

Expected: no output. If any line matches, fix it to `Processor.ArchiveExpander` / `processor-archiveexpander`.

- [ ] **Step 3: Move the volume out of the expander manifest**

```bash
git mv k8s/37-processor-filereader.yaml k8s/37-processor-archiveexpander.yaml
```

In `k8s/37-processor-archiveexpander.yaml`:

- Delete the entire `volumeMounts:` block and the entire `volumes:` block.
- Delete the header comment paragraph beginning `# THE MOUNT IS THE KIND NODE'S FILESYSTEM` through the `#   docker cp ...` line and the `# See §13 of ...` line — the mount is not this pod's concern any more.
- Replace the `FileReader__MaxFileSizeBytes` env entry with:

```yaml
            # The pod's expansion ceiling — the cumulative size of everything an archive expands to,
            # across every level. NOT the file: FileFetcher bounded that one hop upstream. It moved
            # here from the step payload because the size of an expansion is a number an operator
            # sizes against the limit below, and a workflow author has no way to know it.
            #
            # This value and the memory limit move together. Do not change one without the other.
            - name: ArchiveExpander__MaxExpandedBytes
              value: "33554432"
```

- Replace the memory-limit header paragraph with:

```yaml
# THE MEMORY LIMIT IS HIGHER THAN THE OTHER PROCESSORS' 384Mi, AND THAT IS NOT PADDING. An archive
# does not cost its own size in flight: the inbound envelope, its base64-decoded content, everything
# the archive expands to (bounded by ArchiveExpander__MaxExpandedBytes below), the serialized UTF-8
# document (~1.33x the expanded content), the broker message body (that document base64'd again
# inside the ProcessedData envelope, ~1.78x), and a full JsonDocument DOM at validation can all
# coexist — and the work and post consumers are the SAME process, so a dispatch and a branch overlap.
# Lower ArchiveExpander__MaxExpandedBytes or raise this limit; do not move one without the other.
#
# No intermediate base64 STRING sits alongside those: JsonSerializer.SerializeToUtf8Bytes writes
# base64 straight into its UTF-8 output buffer at both serialization points, so there is no UTF-16
# doubling to add on top of the figures above.
```

- Update the top-line description to: `# processor-archiveexpander — turns a fetched file into one structured document of metadata and content, expanding zip/tar/rar archives to the step's MaxDepth. A downstream transform: it has an input and it produces output, so it is neither an importer nor an exporter. No Service — its only inbound traffic is the kubelet hitting the pod IP for probes.`
- Update the `§13 of docs/...file-reader-design.md` reference to `docs/superpowers/specs/2026-09-10-filefetcher-archiveexpander-split-design.md`.

- [ ] **Step 4: Write the FileFetcher manifest**

Create `k8s/38-processor-filefetcher.yaml` as a copy of `k8s/37-processor-archiveexpander.yaml` with these changes: every `processor-archiveexpander` → `processor-filefetcher`; the `ArchiveExpander__MaxExpandedBytes` env replaced with `FileFetcher__MaxFileSizeBytes` at `"33554432"`; `resources` set to `requests: { memory: "256Mi" }`, `limits: { memory: "512Mi" }`; `maxSurge: 0` kept; and the `volumeMounts`/`volumes` blocks from the old FileReader manifest restored verbatim:

```yaml
          volumeMounts:
            - name: skp-files
              mountPath: /mnt/skp-files/in
              readOnly: true
      volumes:
        - name: skp-files
          # DirectoryOrCreate so a fresh node does not need the path seeded before the pod can
          # start. An empty directory is a correct state: every dispatch names its own file.
          hostPath:
            path: /mnt/skp-files/in
            type: DirectoryOrCreate
```

Its header comment must carry, verbatim from the old FileReader manifest, the paragraph beginning `# THE MOUNT IS THE KIND NODE'S FILESYSTEM, NOT WINDOWS.` including the `docker cp <file> desktop-control-plane:/mnt/skp-files/in/` line — the seeding instruction belongs to whichever pod holds the mount, and that is now this one. Plus:

```yaml
# THE MEMORY LIMIT IS 512Mi, HALFWAY BETWEEN THE OTHER PROCESSORS' 384Mi AND ArchiveExpander's 768Mi,
# AND IT IS A STARTING NUMBER RATHER THAN A DERIVED ONE. A file does not cost its own size in flight:
# the raw file bytes, the serialized envelope (~1.33x the file — base64 is 4 bytes per 3), the broker
# message body (that envelope base64'd again inside the ProcessedData envelope, ~1.78x), and a
# JsonDocument DOM at output validation can coexist — and the work and post consumers are the SAME
# process, so a dispatch and a branch overlap. At the 32MiB ceiling below that is roughly 200MB
# transient. MEASURE IT before trusting it. Lower FileFetcher__MaxFileSizeBytes or raise this limit;
# do not move one without the other.
```

- [ ] **Step 5: Repoint the manifest paths named in doc comments**

```bash
grep -rn "37-processor-filereader" src/ docs/superpowers/specs/2026-09-10-*.md
```

Replace every hit with `k8s/37-processor-archiveexpander.yaml`. Expected hits: `ArchiveExpanderConfig.cs` (if the sentence survived the config rewrite in Task 4 — it should not have) and `FileContentBuilder.cs`'s `ExpansionBudget` doc comment.

- [ ] **Step 6: Build both images and load them**

```bash
docker build -f src/Processor.FileFetcher/Dockerfile -t processor-filefetcher:local .
docker build -f src/Processor.ArchiveExpander/Dockerfile -t processor-archiveexpander:local .
kind load docker-image processor-filefetcher:local --name desktop
kind load docker-image processor-archiveexpander:local --name desktop
```

The kubectl context reads `docker-desktop` but the cluster is kind, named `desktop`. Both images need loading; a rebuilt image that was never loaded runs as the old one.

- [ ] **Step 7: Read both SourceHashes and record them**

```bash
docker run --rm --entrypoint sh processor-filefetcher:local -c 'ls /app/*.dll'
```

Every processor rebuild in this cluster needs its `SourceHash` repointed on the identity row — and there are two rebuilds here. Capture both hashes now; Step 9 of Task 7 uses them.

- [ ] **Step 8: Replace the old Deployment, do not roll it**

```bash
kubectl delete deployment processor-filereader -n skp --ignore-not-found
kubectl apply -f k8s/37-processor-archiveexpander.yaml
kubectl apply -f k8s/38-processor-filefetcher.yaml
```

`kubectl apply` over a changed `metadata.name` creates a second Deployment and leaves the first running. The delete is what prevents an orphaned `processor-filereader` consuming from a queue nobody is watching.

- [ ] **Step 9: Expect NotReady, and do not treat it as a fault**

```bash
kubectl get pods -n skp -l app=processor-filefetcher
kubectl get pods -n skp -l app=processor-archiveexpander
```

Expected: both `Running`, `0/1` ready, **0 restarts**, until their processor rows exist (Task 7). A processor waiting on an unregistered row waits by design; it does not crash. `kubectl rollout status` timing out is the expected signal, not a fault.

- [ ] **Step 10: Sync the offline baseline**

```bash
pwsh tools/ship-delta.ps1
```

`ship/` is the offline baseline and is never aligned to a commit — diff it and ship only the changed files. This task changed two project trees and two manifests.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "build: two images, two manifests, and the mount moves

The volume follows the filesystem to FileFetcher; ArchiveExpander's
manifest loses the mount and trades FileReader__MaxFileSizeBytes for
ArchiveExpander__MaxExpandedBytes at the same default.

The Deployment is renamed, so it is deleted and applied rather than
rolled — apply over a changed metadata.name leaves the old one running."
```

---

## Task 7: Registration, workflow rewiring, and the live tests

**Files:**
- Modify: `src/tests/BaseApi.Tests/Live/ArchiveExpander/ArchiveExpanderLiveTests.cs`
- Create: `src/tests/BaseApi.Tests/Live/FileFetcher/FileFetcherLiveTests.cs`

**Interfaces:**
- Consumes: both images and manifests from Task 6; both processors' schemas from Tasks 3 and 4.
- Produces: two registered processor identities and a two-step workflow.

- [ ] **Step 1: Register both processors and their schemas**

Through the BaseApi surface the other processors use, create:

- A schema row holding `src/Processor.FileFetcher/schema/output.json`, and a config schema row for `FileFetcherConfig`.
- A processor row for FileFetcher: name `file-fetcher`, version `1.0.0`, `SourceHash` from Task 6 Step 7, `OutputSchemaId` pointing at the envelope schema, `InputSchemaId` null.
- A schema row holding `src/Processor.ArchiveExpander/schema/input.json` — the same document — and reuse the existing FileReader output schema row for `ArchiveExpander`'s output.
- The ArchiveExpander processor row: renamed to `archive-expander`, `SourceHash` repointed to the new image, `InputSchemaId` pointing at the envelope schema.

Both pods flip to Ready within one discovery interval once their rows land.

- [ ] **Step 2: Verify both pods reach Ready**

```bash
kubectl get pods -n skp -l app=processor-filefetcher
kubectl get pods -n skp -l app=processor-archiveexpander
```

Expected: `1/1 Running` for both. If one stays `0/1` with 0 restarts, its `SourceHash` does not match its image — repoint the row, do not rebuild.

- [ ] **Step 3: Re-author the workflow as two steps**

Every workflow that had a FileReader step becomes: importer → `file-fetcher` step (payload `{"allowedExtensions":[".zip",".csv"],"minimumSizeBytes":0,"maximumSizeBytes":33554432}`) → `archive-expander` step (payload `{"maxDepth":1}`) → whatever followed. The old payload's fields exist on neither processor, so this is a rewrite rather than an edit.

Check `entryCondition` on the new expander step. `4` is `Always`, and the sample steps all use it — copying it makes a failed fetcher step dispatch its successor anyway, which here means expanding a file that was never read.

- [ ] **Step 4: Split the live test**

`src/tests/BaseApi.Tests/Live/ArchiveExpander/ArchiveExpanderLiveTests.cs` currently seeds a file onto the node, runs the whole chain, and asserts on the exporter's topic. Split it:

- **`Live/FileFetcher/FileFetcherLiveTests.cs`** keeps the `docker cp` seeding, the mount, and the manifest's file ceiling. Its assertion is that a seeded file becomes an envelope on the expander's input key — the half only the cluster can answer, because the mount is a node-container detail no hermetic test reaches.
- **`Live/ArchiveExpander/ArchiveExpanderLiveTests.cs`** keeps the end-to-end assertion on the exporter's topic and needs no mount.

Both keep the `kafka-broker` collection attribute and the `SKP_REALSTACK=1` gate. Without the collection, xunit's default parallelism could run one while the shared dev Kafka container is down, producing a flaky failure that looks like a processor bug instead of the borrowed-infrastructure race it is.

- [ ] **Step 5: Run the hermetic suite one more time**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: `0 failed`, exit 0, every `Live/` test skipped.

- [ ] **Step 6: Run the live suite**

First confirm the live tests point at Deployments that exist. `ArchiveExpanderLiveTests` defaults `SKP_ARCHIVEEXPANDER_DEPLOYMENT` to `processor-archiveexpander`, which only became true when Task 6 Step 8 applied the renamed manifest:

```bash
kubectl get deployment -n skp | grep -E 'processor-(archiveexpander|filefetcher|filereader)'
```

Expected: `processor-archiveexpander` and `processor-filefetcher` present, `processor-filereader` **absent**. A surviving `processor-filereader` means Task 6 Step 8's delete did not run, and it is still consuming from a queue nobody is watching.

Then set `SKP_REALSTACK=1`, start the offset-port forwards and `tools/kafka-dev-broker.ps1 -Up`, and run the suite. **Supervise the RabbitMQ forward** — it dies during a RealStack run and reads back as roughly five fake failures. Check the forwards before believing any regression.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "test(live): split the live suite along the new seam

The fetcher's live test owns the mount and the docker cp seeding — the
half only the cluster can answer. The expander's keeps the end-to-end
assertion and needs no volume."
```

---

## Self-Review

**Spec coverage.** §1 decision → Tasks 3, 4. §2 why split → no code. §3 both processors' logic → Tasks 3, 4. §4 envelope → Tasks 3 (writer), 4 (reader), 5 (contract). §5 fetcher config → Task 3 Step 7; pod option → Task 2 Step 5. §6 whitelist, every table row → Task 2 Step 1. §7 expander changes, all six → Task 4 Steps 4–7. §8 expander config and the ceiling's move → Task 4 Steps 4, 5, 6. §9 tracing → Task 3 Step 10 and Task 4 Step 7 log lines. §10 failure table, all six templates → asserted in Tasks 3 and 4 tests. §11 the reversal → prose only. §12 memory → Task 6 Steps 3, 4. §13 files, manifests, database, tests → Tasks 1, 2, 3, 4, 6, 7. §14 naming → Task 1.

**Two gaps found and closed while reviewing:**

- §13 says `ArchiveExpander` needs `schema/input.json` shipped in the image. Task 4 Step 9 wrote the file but nothing copied it — added the `Content Include` to Task 4 Step 10.
- Both projects have a `schema/output.json`, and the test assembly linking both would collide on one output path. Called out in Task 5 Step 1 with the rename, and `ArchiveExpanderSchemaTests.Definition()` flagged for the same change.

**Type consistency.** `FetchedFile` is deliberately two different records in two assemblies — non-nullable in `Processor.FileFetcher`, all-nullable in `Processor.ArchiveExpander` — and Task 5 exists to catch them diverging. `SourceFile` is the validated form and only `ArchiveExpander` has one. `FileContentBuilder(IEnumerable<IArchiveExtractor>, IOptions<ArchiveExpanderOptions>)` and `Build(SourceFile, ArchiveExpanderConfig)` are used identically in Tasks 4 and 5. `ExtensionWhitelist.Resolve/FirstMalformed/Admits/Describe/Wildcard` are declared in Task 2 and used with the same names in Task 3.

**One risk the plan cannot retire.** Task 6 Step 4's `512Mi` for FileFetcher is reasoned from the ~4x transient profile and not measured. The manifest comment says so in capitals. Measure it under a 32 MiB file before trusting it.
