# Processor.SKNormalizer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a provider-aware standardizing transform that sits between ArchiveExpander and ArchiveCollapser, dispatching a document to one hardcoded provider handler named on the step payload.

**Architecture:** A fixed eight-stage pipeline the processor owns; `IProviderHandler` supplies one member per stage. The handler *decides* (a conversion profile, a layout) and shared services *execute* (ffmpeg, XML rendering, tree assembly). Phase 1 ships exactly one handler — `SampleHandler`, which returns the input tree unchanged — so the whole seam is proven by the byte-identity round trip the ArchiveCollapser design already established.

**Tech Stack:** C# / .NET 8, xUnit + NSubstitute, `BaseProcessor.Core` (consumed as a NuGet package, never a ProjectReference), System.Text.Json, ffmpeg (external binary).

**Spec:** `docs/superpowers/specs/2026-09-12-sknormalizer-design.md`

## Global Constraints

- **Target framework `net8.0`**, `Nullable=enable`, `ImplicitUsings=enable`, `LangVersion=latest`, **`TreatWarningsAsErrors=true`** — all from `Directory.Build.props`. Never restate them in a csproj.
- **Package versions come from `Directory.Packages.props`.** Never put a `Version=` on a `PackageReference` in this project, except the pinned `VersionOverride="[1.0.0]"` on `BaseProcessor.Core` that every processor carries.
- **`BaseProcessor.Core` is a `PackageReference`, never a `ProjectReference`** — `SourceHash.targets` ships in the package's `build/` folder and NuGet imports it automatically, stamping the hash on the entry assembly. A ProjectReference cannot flow build targets.
- **`BaseProcessor.Core` is not modified by this plan.** No task edits `src/BaseProcessor.Core/`.
- **Log templates carry shape, never content.** Counts, sizes, author constants are safe. File names from upstream, field values, metadata and payload fragments must not reach a log template. Item keys appear only in `FailedException` messages.
- **Nothing logs before throwing `FailedException`.** `ProcessDispatchHandler` writes the message verbatim at Warning; a log line here emits every failure twice.
- **camelCase on the wire.** `FileDocument.Options` uses `JsonNamingPolicy.CamelCase`; JSON Schema property names are case-sensitive, so schema files must be camelCase too.
- **Node names are names, never paths.** No `/` or `\` in any `FileMetadata.Name`.
- **Writable archive extensions are `.zip` and `.tar` only.** `.rar` is readable by ArchiveExpander and **not writable** by ArchiveCollapser — RarLab's `unrar` licence permits decompression only, so SharpCompress has no rar writer.
- **Schema definition source text lives in `src/tests/BaseApi.Tests/Schemas/`**, one file per shape. No processor ships schema files.

---

## File Structure

**New project `src/Processor.SKNormalizer/`:**

| file | responsibility |
|---|---|
| `Program.cs` | signal registration + host start; byte-identical to ArchiveExpander's |
| `ProcessorHost.cs` | boot, OTel, DI registrations |
| `SKNormalizerProcessor.cs` | payload validation, handler resolution, envelope read, send |
| `SKNormalizerConfig.cs` | the step payload record |
| `SKNormalizerOptions.cs` | pod-level operator numbers |
| `FileNode.cs` | the tree contract + `FileNodeConverter` + `FileDocument.Options` |
| `Pipeline/NormalizationPipeline.cs` | the eight stages, in order |
| `Pipeline/NormalizationException.cs` | the one business-failure type |
| `Pipeline/PipelineTypes.cs` | `SourceItem`, `ItemNames`, `AudioProfile`, `NormalizedAudio`, `NormalizedItem` |
| `Pipeline/StandardMetadata.cs` | the ordered element tree stages 3/4/7 build |
| `Pipeline/OutputLayout.cs` | `OutputLayout`, `OutputNode.File`, `OutputNode.Folder` |
| `Handlers/IProviderHandler.cs` | the eight-member contract |
| `Handlers/ProviderHandlerRegistry.cs` | name → handler, case-insensitive, duplicate-hostile |
| `Handlers/ProviderHandlerBase.cs` | defaults, including the mirror `LayoutFor` |
| `Handlers/SampleHandler.cs` | the identity handler |
| `Services/ITreeAssembler.cs` + `TreeAssembler.cs` | the only code that names a node or sets an extension |
| `Services/IMetadataRenderer.cs` + `XmlMetadataRenderer.cs` | `StandardMetadata` → UTF-8 XML |
| `Services/IAudioTranscoder.cs` + `FfmpegAudioTranscoder.cs` | profile + bytes → `NormalizedAudio` |
| `Services/IFieldWhitelist.cs` + `PassThroughFieldWhitelist.cs` | seam for the deferred Redis whitelist |
| `Dockerfile` | build + runtime image, with ffmpeg installed |
| `appsettings.json` | local defaults |

**New test files under `src/tests/BaseApi.Tests/SKNormalizer/`**, one per task, plus `Schemas/sknormalizer-config.json` and an entry in `DependencyInjection/`.

**Modified:** `SK_P.sln`, `src/tests/BaseApi.Tests/BaseApi.Tests.csproj`, `k8s/kustomization.yaml`, `k8s/37-processor-archiveexpander.yaml` (a sizing comment only).

---

### Task 1: Project skeleton and the tree contract

**Files:**
- Create: `src/Processor.SKNormalizer/Processor.SKNormalizer.csproj`
- Create: `src/Processor.SKNormalizer/FileNode.cs`
- Create: `src/Processor.SKNormalizer/appsettings.json`
- Modify: `SK_P.sln`
- Modify: `src/tests/BaseApi.Tests/BaseApi.Tests.csproj:100` (add a ProjectReference after ArchiveCollapser's)
- Test: `src/tests/BaseApi.Tests/SKNormalizer/FileNodeContractTests.cs`

**Interfaces:**
- Consumes: nothing.
- Produces: `Processor.SKNormalizer.FileMetadata(string Name, string Extension, long SizeBytes, DateTime? CreatedUtc, DateTime? ModifiedUtc, int EntryCount)`; `FileContent.Bytes(byte[] Value)`; `FileContent.Entries(IReadOnlyList<FileNode> Value)`; `FileNode(FileMetadata Metadata, FileContent? Content)`; `internal static class FileDocument { public static readonly JsonSerializerOptions Options; }`.

- [ ] **Step 1: Copy the contract verbatim from the collapser**

The expander and collapser each carry their own byte-identical copy; this is the house convention and extracting a shared package is explicitly out of scope.

```bash
cd C:/Users/UserL/source/repos/SK_P9
mkdir -p src/Processor.SKNormalizer/Pipeline src/Processor.SKNormalizer/Handlers src/Processor.SKNormalizer/Services
cp src/Processor.ArchiveCollapser/FileNode.cs src/Processor.SKNormalizer/FileNode.cs
sed -i 's/namespace Processor.ArchiveCollapser;/namespace Processor.SKNormalizer;/' src/Processor.SKNormalizer/FileNode.cs
cp src/Processor.ArchiveCollapser/appsettings.json src/Processor.SKNormalizer/appsettings.json
```

- [ ] **Step 2: Write the csproj**

```xml
<Project Sdk="Microsoft.NET.Sdk">

  <!--
    A concrete processor. It consumes the {metadata, content} tree ArchiveExpander produces, hands it
    to one hardcoded provider handler named on the step payload, and emits a tree of the same
    contract. Like every other processor here it carries no identity, liveness, broker or Redis code
    — AddBaseProcessor folds all of it in.

    Common properties (net8.0, Nullable, ImplicitUsings, TreatWarningsAsErrors) come from
    Directory.Build.props, and package versions from Directory.Packages.props — never declare
    either here.
  -->

  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <RootNamespace>Processor.SKNormalizer</RootNamespace>
    <AssemblyName>Processor.SKNormalizer</AssemblyName>
  </PropertyGroup>

  <ItemGroup>
    <!-- The pipeline, the assembler and the registry are this processor's construction, not its
         surface. The tests DO construct them directly — a pipeline tested only through the
         processor cannot be given a deliberately throwing handler — so the test assembly is named
         here, matching what the sibling processors do for the same reason. -->
    <InternalsVisibleTo Include="BaseApi.Tests" />
  </ItemGroup>

  <ItemGroup>
    <!-- The worker SDK does not copy appsettings.json on its own. -->
    <Content Include="appsettings.json" CopyToOutputDirectory="PreserveNewest" />
  </ItemGroup>

  <ItemGroup>
    <!-- The package, not a ProjectReference: SourceHash.targets ships in the package's build/
         folder and NuGet imports it automatically, stamping the hash on THIS assembly — the entry
         assembly, where the runtime reader looks. A ProjectReference could not flow build targets. -->
    <PackageReference Include="BaseProcessor.Core" VersionOverride="[1.0.0]" />
  </ItemGroup>

</Project>
```

- [ ] **Step 3: Add to the solution and to the test project**

```bash
cd C:/Users/UserL/source/repos/SK_P9
dotnet sln SK_P.sln add src/Processor.SKNormalizer/Processor.SKNormalizer.csproj
```

Then add this line to `src/tests/BaseApi.Tests/BaseApi.Tests.csproj` immediately after the `Processor.ArchiveCollapser` ProjectReference:

```xml
    <ProjectReference Include="..\..\Processor.SKNormalizer\Processor.SKNormalizer.csproj" />
```

- [ ] **Step 4: Write the failing test**

Create `src/tests/BaseApi.Tests/SKNormalizer/FileNodeContractTests.cs`:

```csharp
using System.Text;
using System.Text.Json;
using Xunit;
using SK = Processor.SKNormalizer;
using CL = Processor.ArchiveCollapser;

namespace BaseApi.Tests.SKNormalizer;

/// <summary>
/// The contract is COPIED into this processor, as it is into the expander and the collapser. A copy
/// is only safe while it stays byte-compatible on the wire, so this asserts the bytes rather than
/// trusting that the copy was faithful. If someone edits one copy, this is what fails.
/// </summary>
public sealed class FileNodeContractTests
{
    private static DateTime Stamp => new(2026, 6, 7, 8, 9, 10, DateTimeKind.Utc);

    [Fact]
    public void ADocumentSerializesIdenticallyToTheCollapsersCopy()
    {
        var sk = new SK.FileNode(
            new SK.FileMetadata("orders.zip", ".zip", 40219, Stamp, Stamp, 1),
            new SK.FileContent.Entries(
            [
                new SK.FileNode(
                    new SK.FileMetadata("a.csv", ".csv", 2, null, Stamp, 0),
                    new SK.FileContent.Bytes(Encoding.UTF8.GetBytes("id"))),
            ]));

        var cl = new CL.FileNode(
            new CL.FileMetadata("orders.zip", ".zip", 40219, Stamp, Stamp, 1),
            new CL.FileContent.Entries(
            [
                new CL.FileNode(
                    new CL.FileMetadata("a.csv", ".csv", 2, null, Stamp, 0),
                    new CL.FileContent.Bytes(Encoding.UTF8.GetBytes("id"))),
            ]));

        Assert.Equal(
            JsonSerializer.SerializeToUtf8Bytes(cl, CL.FileDocument.Options),
            JsonSerializer.SerializeToUtf8Bytes(sk, SK.FileDocument.Options));
    }

    [Fact]
    public void AnArchiveThatExpandedToNothingKeepsNullContent()
    {
        // content: null is the third form a node may take and is NOT an empty array. The converter
        // must round-trip it as null, because ArchiveBuilder treats null as "pack an empty archive".
        var node = new SK.FileNode(
            new SK.FileMetadata("empty.zip", ".zip", 22, null, Stamp, 0), null);

        var json = JsonSerializer.SerializeToUtf8Bytes(node, SK.FileDocument.Options);
        var back = JsonSerializer.Deserialize<SK.FileNode>(json, SK.FileDocument.Options);

        Assert.NotNull(back);
        Assert.Null(back!.Content);
    }
}
```

- [ ] **Step 5: Run the tests to verify they fail**

```bash
cd C:/Users/UserL/source/repos/SK_P9/src
dotnet test tests/BaseApi.Tests/BaseApi.Tests.csproj --filter "FullyQualifiedName~FileNodeContractTests"
```

Expected: FAIL to compile until Steps 1–3 are complete; then PASS.

- [ ] **Step 6: Run them to verify they pass**

Same command. Expected: 2 passed.

> **Note on the runner:** `dotnet test` reports counts only and hides the names of failures. When something fails, run the test binary directly to see which: `tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe`.

- [ ] **Step 7: Commit**

```bash
cd C:/Users/UserL/source/repos/SK_P9
git add src/Processor.SKNormalizer SK_P.sln src/tests/BaseApi.Tests/BaseApi.Tests.csproj src/tests/BaseApi.Tests/SKNormalizer
git commit -m "feat(sknormalizer): project skeleton and the tree contract"
```

---

### Task 2: `OutputLayout` and `TreeAssembler`

The assembler is the only code in this processor that names a node or sets an extension on an entries-bearing node. Because `OutputNode.Folder` *requires* an archive extension and the assembler validates it, a handler cannot express an uncollapsible document.

**It computes two fields and carries the rest.** A **leaf's** `SizeBytes` is its content length and every node's `EntryCount` is its child count — both are facts this code holds, and a wrong value upstream must not propagate as if it were one. A **container's** `SizeBytes` and every node's `CreatedUtc`/`ModifiedUtc` are **carried through unchanged**: nothing is packed here, so there is no built size for a container, and `ArchiveExpander` writes the source archive's byte length plus both timestamps on every node it emits (`FileContentBuilder.cs:98,131`). Inventing different values would make Task 9's byte identity — this phase's acceptance test — impossible to pass.

**Files:**
- Create: `src/Processor.SKNormalizer/Pipeline/OutputLayout.cs`
- Create: `src/Processor.SKNormalizer/Services/ITreeAssembler.cs`
- Create: `src/Processor.SKNormalizer/Services/TreeAssembler.cs`
- Create: `src/Processor.SKNormalizer/Pipeline/NormalizationException.cs`
- Test: `src/tests/BaseApi.Tests/SKNormalizer/TreeAssemblerTests.cs`

**Interfaces:**
- Consumes: `FileNode`, `FileMetadata`, `FileContent` from Task 1.
- Produces:
  - `public abstract record OutputNode` with `OutputNode.File(string Name, byte[] Content, DateTime? CreatedUtc, DateTime? ModifiedUtc)` and `OutputNode.Folder(string Name, string ArchiveExtension, long SizeBytes, DateTime? CreatedUtc, DateTime? ModifiedUtc, IReadOnlyList<OutputNode> Children)`.
  - `public sealed record OutputLayout(string RootName, string RootExtension, long SizeBytes, DateTime? CreatedUtc, DateTime? ModifiedUtc, IReadOnlyList<OutputNode>? Children)`.
  - `internal interface ITreeAssembler { FileNode Assemble(OutputLayout layout); }`
  - `internal sealed class TreeAssembler : ITreeAssembler` with `public const int MaxSupportedDepth = 4;` and `public static readonly IReadOnlyList<string> WritableExtensions = [".tar", ".zip"];`
  - `public sealed class NormalizationException(string message) : Exception(message)`

- [ ] **Step 1: Write the failing tests**

Create `src/tests/BaseApi.Tests/SKNormalizer/TreeAssemblerTests.cs`:

```csharp
using System.Text;
using Processor.ArchiveCollapser.Writers;
using Processor.SKNormalizer;
using Xunit;

namespace BaseApi.Tests.SKNormalizer;

public sealed class TreeAssemblerTests
{
    private static DateTime Stamp => new(2026, 6, 7, 8, 9, 10, DateTimeKind.Utc);

    private static DateTime Born => new(2026, 1, 2, 3, 4, 5, DateTimeKind.Utc);

    private static OutputNode.File File(string name, string text)
        => new(name, Encoding.UTF8.GetBytes(text), Born, Stamp);

    private static OutputLayout Root(string name, string extension, params OutputNode[] children)
        => new(name, extension, SizeBytes: 40219, Born, Stamp, children);

    private static FileNode Assemble(OutputLayout layout) => new TreeAssembler().Assemble(layout);

    [Fact]
    public void ANameCarryingAPathSeparatorIsRejected()
    {
        // ArchiveBuilder.Pack rejects rather than strips, because stripping hides a malformed
        // document. This refuses it one hop earlier, where the message can name the offender.
        var layout = Root("out.zip", ".zip", File("audio/track01.wav", "x"));

        var ex = Assert.Throws<NormalizationException>(() => Assemble(layout));
        Assert.Contains("audio/track01.wav", ex.Message);
    }

    [Theory]
    [InlineData("\\")]
    [InlineData("/")]
    public void BothSeparatorsAreRejected(string separator)
    {
        var layout = Root("out.zip", ".zip", File($"a{separator}b.xml", "x"));

        Assert.Throws<NormalizationException>(() => Assemble(layout));
    }

    [Fact]
    public void AFolderNamedWithANonWritableExtensionIsRetargetedToZip()
    {
        // The rar rule. ArchiveExpander READS rar; ArchiveCollapser cannot WRITE it, so a faithful
        // topology mirror of a rar-sourced document would walk straight into a collapser refusal.
        var layout = Root(
            "bundle.rar", ".rar",
            new OutputNode.Folder("item01.rar", ".rar", 512, Born, Stamp, [File("meta.xml", "<m/>")]));

        var root = Assemble(layout);

        Assert.Equal(".zip", root.Metadata.Extension);
        Assert.Equal("bundle.zip", root.Metadata.Name);

        var child = Assert.IsType<FileContent.Entries>(root.Content).Value.Single();
        Assert.Equal(".zip", child.Metadata.Extension);
        Assert.Equal("item01.zip", child.Metadata.Name);
    }

    [Fact]
    public void AWritableFolderExtensionIsLeftAlone()
    {
        var layout = Root(
            "bundle.tar", ".tar",
            new OutputNode.Folder("item01.zip", ".zip", 512, Born, Stamp, [File("meta.xml", "<m/>")]));

        var root = Assemble(layout);

        Assert.Equal(".tar", root.Metadata.Extension);
        Assert.Equal("bundle.tar", root.Metadata.Name);
        Assert.Equal(".zip",
            Assert.IsType<FileContent.Entries>(root.Content).Value.Single().Metadata.Extension);
    }

    [Fact]
    public void ALeafKeepsWhateverExtensionItsHandlerGaveIt()
    {
        // Only entries-bearing nodes are retargeted. A leaf named .rar is an already-built archive
        // being carried along, exactly as ArchiveBuilder treats it.
        var root = Assemble(Root("out.zip", ".zip", File("inner.rar", "x")));

        var leaf = Assert.IsType<FileContent.Entries>(root.Content).Value.Single();
        Assert.Equal(".rar", leaf.Metadata.Extension);
        Assert.Equal("inner.rar", leaf.Metadata.Name);
    }

    [Fact]
    public void ALeafsSizeIsItsContentAndEveryEntryCountIsCounted()
    {
        var root = Assemble(Root("out.zip", ".zip", File("a.xml", "<a/>"), File("b.xml", "<bb/>")));

        Assert.Equal(2, root.Metadata.EntryCount);

        var entries = Assert.IsType<FileContent.Entries>(root.Content).Value;
        Assert.Equal(4, entries[0].Metadata.SizeBytes);
        Assert.Equal(5, entries[1].Metadata.SizeBytes);
        Assert.Equal(0, entries[0].Metadata.EntryCount);
    }

    [Fact]
    public void AContainerKeepsTheSizeItWasGivenRatherThanTheSumOfItsChildren()
    {
        // THIS PROCESSOR PACKS NO ARCHIVE, so a container has no "built" size to be honest about.
        // ArchiveExpander writes the SOURCE ARCHIVE's byte length there (FileContentBuilder.cs:131),
        // and summing children instead would make byte identity impossible -- which is this phase's
        // acceptance test. ArchiveCollapser recomputes the number from what it actually packs, so
        // carrying the upstream value forward misleads nobody.
        var root = Assemble(Root("out.zip", ".zip", File("a.xml", "<a/>")));

        Assert.Equal(40219, root.Metadata.SizeBytes);
        Assert.NotEqual(4, root.Metadata.SizeBytes);
    }

    [Fact]
    public void TimestampsSurviveOnEveryNode()
    {
        // DISTINCT values, deliberately: two NotNull checks would pass just as happily if the
        // assembler TRANSPOSED CreatedUtc and ModifiedUtc. ArchiveExpander writes both on every node,
        // so dropping either makes the identity chain test unpassable.
        var root = Assemble(Root(
            "out.zip", ".zip",
            new OutputNode.Folder("inner.zip", ".zip", 99, Born, Stamp, [File("a.xml", "<a/>")])));

        Assert.Equal(Born, root.Metadata.CreatedUtc);
        Assert.Equal(Stamp, root.Metadata.ModifiedUtc);

        var inner = Assert.IsType<FileContent.Entries>(root.Content).Value.Single();
        Assert.Equal(Born, inner.Metadata.CreatedUtc);
        Assert.Equal(Stamp, inner.Metadata.ModifiedUtc);

        var leaf = Assert.IsType<FileContent.Entries>(inner.Content).Value.Single();
        Assert.Equal(Born, leaf.Metadata.CreatedUtc);
        Assert.Equal(Stamp, leaf.Metadata.ModifiedUtc);
    }

    [Fact]
    public void ALayoutDeeperThanTheCapIsRejected()
    {
        OutputNode node = File("leaf.xml", "x");
        for (var i = 0; i < TreeAssembler.MaxSupportedDepth + 1; i++)
        {
            node = new OutputNode.Folder($"level{i}.zip", ".zip", 0, Born, Stamp, [node]);
        }

        var ex = Assert.Throws<NormalizationException>(
            () => Assemble(Root("out.zip", ".zip", node)));
        Assert.Contains("nests deeper", ex.Message);
    }

    [Fact]
    public void ARootWithNoChildrenBecomesNullContentNotAnEmptyArray()
    {
        // ArchiveBuilder treats null as "pack the format's canonical empty archive" and an empty
        // Entries list identically — but the tree schema and the expander both express "expanded to
        // nothing" as null, so this must match.
        var root = Assemble(new OutputLayout("empty.zip", ".zip", 22, Born, Stamp, null));

        Assert.Null(root.Content);
        Assert.Equal(0, root.Metadata.EntryCount);
    }

    [Fact]
    public void TheWritableExtensionListMatchesTheCollapsersWriters()
    {
        // A KNOWING DUPLICATION ACROSS PROCESS BOUNDARIES, pinned here. The assembler cannot ask the
        // collapser what it can write, so this test is the only thing keeping the two in step. If
        // the collapser ever gains a writer, this fails and the assembler is updated.
        IArchiveWriter[] writers = [new ZipWriter(), new TarWriter()];

        Assert.Equal(
            writers.Select(w => w.Extension).Order().ToArray(),
            TreeAssembler.WritableExtensions.Order().ToArray());
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd C:/Users/UserL/source/repos/SK_P9/src
dotnet test tests/BaseApi.Tests/BaseApi.Tests.csproj --filter "FullyQualifiedName~TreeAssemblerTests"
```

Expected: FAIL — `OutputLayout`, `OutputNode`, `TreeAssembler` and `NormalizationException` do not exist.

- [ ] **Step 3: Write `NormalizationException`**

`src/Processor.SKNormalizer/Pipeline/NormalizationException.cs`:

```csharp
namespace Processor.SKNormalizer;

/// <summary>
/// The ONE business-failure type, thrown by handlers and by the shared services and translated to a
/// <c>FailedException</c> once, in the processor.
/// <para>
/// One type, not a list, for the reason <c>ArchiveExtractionException</c> and
/// <c>ArchiveWritingException</c> record: a caller catching a library's own hierarchy catches
/// whatever that library happens to throw this version, and misses the rest.
/// </para>
/// <para>
/// <b>Bare <see cref="Exception"/> is deliberately never caught.</b> A NullReferenceException in a
/// handler is a programming error, and reporting it to an operator as a bad provider document
/// buries a bug under a plausible business failure.
/// </para>
/// </summary>
public sealed class NormalizationException(string message) : Exception(message);
```

- [ ] **Step 4: Write `OutputLayout`**

`src/Processor.SKNormalizer/Pipeline/OutputLayout.cs`:

```csharp
namespace Processor.SKNormalizer;

/// <summary>
/// A node in the output tree a handler DESCRIBES. A handler never constructs a
/// <see cref="FileNode"/>: naming, extensions, sizes and counts belong to <c>TreeAssembler</c>.
/// </summary>
public abstract record OutputNode
{
    private OutputNode()
    {
    }

    /// <summary>
    /// A leaf. Its bytes are its content, whatever the extension claims.
    /// <para>
    /// <b>Both timestamps, not just one.</b> ArchiveExpander writes <c>createdUtc</c> and
    /// <c>modifiedUtc</c> on every node it emits; dropping either here would make the identity chain
    /// of Task 9 unpassable, and would quietly lose provenance for every real handler too.
    /// </para>
    /// </summary>
    public sealed record File(
        string Name, byte[] Content, DateTime? CreatedUtc, DateTime? ModifiedUtc) : OutputNode;

    /// <summary>
    /// A container.
    /// <para>
    /// <b><paramref name="ArchiveExtension"/> is required rather than optional, and that is the
    /// point.</b> ArchiveCollapser refuses an entries-bearing node whose extension names no writer,
    /// so making the extension unstateable-by-omission is what stops a handler expressing a document
    /// that cannot be collapsed. An extension naming no writer is retargeted by the assembler.
    /// </para>
    /// </summary>
    /// <param name="SizeBytes">
    /// <b>Carried, not computed.</b> This processor packs no archive, so a container has no built
    /// size — ArchiveExpander puts the source archive's byte length here and ArchiveCollapser
    /// recomputes it from what it actually packs. Summing children instead would be an invented
    /// number AND would break byte identity.
    /// </param>
    public sealed record Folder(
        string Name,
        string ArchiveExtension,
        long SizeBytes,
        DateTime? CreatedUtc,
        DateTime? ModifiedUtc,
        IReadOnlyList<OutputNode> Children) : OutputNode;
}

/// <summary>
/// The whole output document. <paramref name="Children"/> null means "expanded to nothing" and
/// becomes <c>content: null</c> — NOT an empty array, matching how the expander expresses it.
/// The root's size and timestamps are carried for the reason <see cref="OutputNode.Folder"/> records.
/// </summary>
public sealed record OutputLayout(
    string RootName,
    string RootExtension,
    long SizeBytes,
    DateTime? CreatedUtc,
    DateTime? ModifiedUtc,
    IReadOnlyList<OutputNode>? Children);
```

- [ ] **Step 5: Write `ITreeAssembler` and `TreeAssembler`**

`src/Processor.SKNormalizer/Services/ITreeAssembler.cs`:

```csharp
namespace Processor.SKNormalizer;

internal interface ITreeAssembler
{
    /// <summary>Builds the output document, refusing anything ArchiveCollapser would refuse.</summary>
    /// <exception cref="NormalizationException">The layout cannot be collapsed.</exception>
    FileNode Assemble(OutputLayout layout);
}
```

`src/Processor.SKNormalizer/Services/TreeAssembler.cs`:

```csharp
namespace Processor.SKNormalizer;

/// <summary>
/// The ONLY code in this processor that sets a node name or sets an extension on an entries-bearing
/// node. Every rule ArchiveCollapser enforces is enforced here first, where the message can name the
/// offending node.
/// <para>
/// <b>It COMPUTES a leaf's SizeBytes and every node's EntryCount, and CARRIES everything else.</b>
/// A leaf's size is its content length and an entry count is the number of children — both are facts
/// this code holds. A container's size is not: nothing is packed here, so the only number available
/// is the one upstream wrote, and inventing a different one would break the byte identity that is
/// this processor's acceptance test. Timestamps are carried for the same reason.
/// </para>
/// </summary>
internal sealed class TreeAssembler : ITreeAssembler
{
    /// <summary>Mirrors <c>ArchiveBuilder.MaxSupportedDepth</c>, which fails one hop later.</summary>
    public const int MaxSupportedDepth = 4;

    /// <summary>
    /// What ArchiveCollapser can WRITE. Rar is absent and will stay absent: RarLab's unrar licence
    /// permits decompression only and forbids building a compressor from that source, so no open
    /// library writes rar. <c>TreeAssemblerTests.TheWritableExtensionListMatchesTheCollapsersWriters</c>
    /// is what keeps this in step with the collapser's registrations.
    /// </summary>
    public static readonly IReadOnlyList<string> WritableExtensions = [".tar", ".zip"];

    /// <summary>Where a container whose format cannot be written is retargeted.</summary>
    public const string DefaultArchiveExtension = ".zip";

    public FileNode Assemble(OutputLayout layout)
    {
        ArgumentNullException.ThrowIfNull(layout);

        var extension = Writable(layout.RootExtension);
        var children = layout.Children is null
            ? null
            : layout.Children.Select(c => Build(c, depth: 1)).ToList();

        return new FileNode(
            new FileMetadata(
                Retarget(layout.RootName, layout.RootExtension, extension),
                extension,
                layout.SizeBytes,
                layout.CreatedUtc,
                layout.ModifiedUtc,
                children?.Count ?? 0),
            children is null ? null : new FileContent.Entries(children));
    }

    private FileNode Build(OutputNode node, int depth)
    {
        if (depth > MaxSupportedDepth)
        {
            throw new NormalizationException(
                $"the layout nests deeper than {MaxSupportedDepth} levels, at '{Name(node)}'");
        }

        return node switch
        {
            OutputNode.File file => Leaf(file),
            OutputNode.Folder folder => Folder(folder, depth),
            _ => throw new NormalizationException($"unknown output node '{Name(node)}'"),
        };
    }

    private static FileNode Leaf(OutputNode.File file)
    {
        var name = Check(file.Name);

        // A LEAF KEEPS ITS EXTENSION, whatever it is. A leaf named .rar is an already-built archive
        // being carried along, which is exactly how ArchiveBuilder reads it. Only entries-bearing
        // nodes are retargeted.
        return new FileNode(
            new FileMetadata(
                name,
                Path.GetExtension(name),
                // COMPUTED: a leaf's size is its content, and a wrong value upstream must not
                // propagate as if it were a fact.
                file.Content.LongLength,
                file.CreatedUtc,
                file.ModifiedUtc,
                0),
            new FileContent.Bytes(file.Content));
    }

    private FileNode Folder(OutputNode.Folder folder, int depth)
    {
        var extension = Writable(folder.ArchiveExtension);
        var name = Retarget(Check(folder.Name), folder.ArchiveExtension, extension);
        var children = folder.Children.Select(c => Build(c, depth + 1)).ToList();

        return new FileNode(
            new FileMetadata(
                name, extension, folder.SizeBytes, folder.CreatedUtc, folder.ModifiedUtc, children.Count),
            new FileContent.Entries(children));
    }

    private static string Check(string name)
    {
        // Rejected rather than stripped, matching ArchiveBuilder.Pack: the expander strips
        // directories on read, so writing real structure here would be flattened straight back —
        // and stripping would hide a malformed document rather than report it.
        if (name.Contains('/') || name.Contains('\\'))
        {
            throw new NormalizationException(
                $"the node name '{name}' carries a path separator; a node name is a name, never a path");
        }

        if (name.Length == 0)
        {
            throw new NormalizationException("a node name is empty");
        }

        return name;
    }

    private static string Writable(string extension)
        => WritableExtensions.Any(e => e.Equals(extension, StringComparison.OrdinalIgnoreCase))
            ? extension
            : DefaultArchiveExtension;

    private static string Retarget(string name, string from, string to)
        => from.Equals(to, StringComparison.OrdinalIgnoreCase)
            ? name
            : Path.ChangeExtension(name, to);

    private static string Name(OutputNode node) => node switch
    {
        OutputNode.File f => f.Name,
        OutputNode.Folder d => d.Name,
        _ => "<unknown>",
    };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd C:/Users/UserL/source/repos/SK_P9/src
dotnet test tests/BaseApi.Tests/BaseApi.Tests.csproj --filter "FullyQualifiedName~TreeAssemblerTests"
```

Expected: 9 passed.

- [ ] **Step 7: Commit**

```bash
cd C:/Users/UserL/source/repos/SK_P9
git add src/Processor.SKNormalizer src/tests/BaseApi.Tests/SKNormalizer
git commit -m "feat(sknormalizer): the assembler owns every rule the collapser enforces"
```

---

### Task 3: The handler contract and the registry

**Files:**
- Create: `src/Processor.SKNormalizer/Pipeline/PipelineTypes.cs`
- Create: `src/Processor.SKNormalizer/Pipeline/StandardMetadata.cs`
- Create: `src/Processor.SKNormalizer/Handlers/IProviderHandler.cs`
- Create: `src/Processor.SKNormalizer/Handlers/ProviderHandlerRegistry.cs`
- Test: `src/tests/BaseApi.Tests/SKNormalizer/ProviderHandlerRegistryTests.cs`

**Interfaces:**
- Consumes: `FileNode`, `OutputLayout` from Tasks 1–2.
- Produces:
  - `public sealed record SourceItem(string Key, IReadOnlyList<FileNode> Nodes)`
  - `public sealed record AudioProfile(string TargetExtension, IReadOnlyList<string> Arguments)`
  - `public sealed record NormalizedAudio(byte[] Content, string Extension, long SizeBytes, TimeSpan? Duration, int? BitrateKbps, string? Codec)`
  - `public sealed record ItemNames(string MetadataFileName, string AudioFileName)`
  - `public sealed record NormalizedItem(SourceItem Source, StandardMetadata Metadata, ItemNames Names, NormalizedAudio? Audio, byte[]? MetadataDocument)`
  - `public sealed class StandardMetadata` with `string RootName { get; set; }`, `void Set(string name, string value)`, `bool TryGet(string name, out string value)`, `IReadOnlyList<KeyValuePair<string,string>> Elements { get; }`, `bool IsEmpty { get; }`
  - `public interface IProviderHandler` — the eight members
  - `internal sealed class ProviderHandlerRegistry` with `ProviderHandlerRegistry(IEnumerable<IProviderHandler>)`, `IProviderHandler? Find(string name)`, `IReadOnlyList<string> Names { get; }`

- [ ] **Step 1: Write the failing tests**

Create `src/tests/BaseApi.Tests/SKNormalizer/ProviderHandlerRegistryTests.cs`:

```csharp
using Processor.SKNormalizer;
using Xunit;

namespace BaseApi.Tests.SKNormalizer;

public sealed class ProviderHandlerRegistryTests
{
    /// <summary>A handler that does nothing, for tests that only care about resolution.</summary>
    private sealed class Stub(string name) : ProviderHandlerBase
    {
        public override string Name { get; } = name;

        public override IReadOnlyList<SourceItem> Locate(FileNode root) => [];
    }

    [Fact]
    public void AHandlerIsFoundByName()
    {
        var handler = new Stub("ProviderA");
        var registry = new ProviderHandlerRegistry([handler]);

        Assert.Same(handler, registry.Find("ProviderA"));
    }

    [Theory]
    [InlineData("providera")]
    [InlineData("PROVIDERA")]
    [InlineData("ProviderA")]
    public void ResolutionIsCaseInsensitive(string asked)
    {
        var registry = new ProviderHandlerRegistry([new Stub("ProviderA")]);

        Assert.NotNull(registry.Find(asked));
    }

    [Fact]
    public void AnUnknownNameReturnsNullRatherThanThrowing()
    {
        // The processor turns this into a rejected payload with a message naming what IS carried.
        // Throwing here would put that decision in the wrong place.
        var registry = new ProviderHandlerRegistry([new Stub("ProviderA")]);

        Assert.Null(registry.Find("ProviderB"));
    }

    [Fact]
    public void TwoHandlersClaimingOneNameThrowAtConstruction()
    {
        // A BUILD-TIME MISTAKE, and it must not be resolved by registration order at dispatch time.
        // The container builds this at startup, so the pod fails to start rather than serving one
        // of two providers at random.
        var ex = Assert.Throws<InvalidOperationException>(
            () => new ProviderHandlerRegistry([new Stub("ProviderA"), new Stub("providera")]));

        Assert.Contains("ProviderA", ex.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void NamesAreOrderedSoTheRejectionMessageIsStable()
    {
        // The unknown-handler message lists these, and an operator comparing two failures should not
        // see the same set in two orders.
        var registry = new ProviderHandlerRegistry([new Stub("Zeta"), new Stub("Alpha")]);

        Assert.Equal(["Alpha", "Zeta"], registry.Names);
    }

    [Fact]
    public void AnEmptyRegistryIsLegalAndFindsNothing()
    {
        var registry = new ProviderHandlerRegistry([]);

        Assert.Empty(registry.Names);
        Assert.Null(registry.Find("anything"));
    }
}
```

> This test file references `ProviderHandlerBase`, which Task 4 creates. Write `ProviderHandlerBase` in Task 4 **and** a minimal version here in Step 4 below so this task's tests compile and pass on their own.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd C:/Users/UserL/source/repos/SK_P9/src
dotnet test tests/BaseApi.Tests/BaseApi.Tests.csproj --filter "FullyQualifiedName~ProviderHandlerRegistryTests"
```

Expected: FAIL — the types do not exist.

- [ ] **Step 3: Write the pipeline types**

`src/Processor.SKNormalizer/Pipeline/PipelineTypes.cs`:

```csharp
namespace Processor.SKNormalizer;

/// <summary>
/// One unit of work a handler found in the incoming tree — typically an audio file and its metadata
/// sidecar, but the grouping is entirely the handler's, because pairing differs per provider.
/// </summary>
/// <param name="Key">
/// The handler's own identifier for this item: a basename, a folder name, an index. It EXISTS FOR
/// FAILURE MESSAGES — a document of forty items whose ninth is malformed is useless to an operator
/// unless the message says which. Derived from upstream content, so it appears in a
/// <c>FailedException</c> message and never in a log template of ours.
/// </param>
public sealed record SourceItem(string Key, IReadOnlyList<FileNode> Nodes);

/// <summary>
/// What a handler asks ffmpeg to do. <paramref name="Arguments"/> excludes the input and output
/// paths — the transcoder owns those, because it owns the temp files.
/// </summary>
public sealed record AudioProfile(string TargetExtension, IReadOnlyList<string> Arguments);

/// <summary>
/// What the conversion actually produced. The nullable members are what a probe could not determine;
/// they are folded into the metadata by stage 7 and must not be invented when absent.
/// </summary>
public sealed record NormalizedAudio(
    byte[] Content,
    string Extension,
    long SizeBytes,
    TimeSpan? Duration,
    int? BitrateKbps,
    string? Codec);

/// <summary>The output file names for one item, decided before conversion. See the design's §5.2.</summary>
public sealed record ItemNames(string MetadataFileName, string AudioFileName);

/// <summary>
/// One item, carried through the pipeline and handed to stage 8.
/// </summary>
/// <param name="MetadataDocument">
/// The rendered metadata, or <b>null when the handler produced none</b>. Rendered by the pipeline
/// after stage 7, so stage 8 receives bytes it can place rather than a model it would have to render
/// itself — a handler never writes angle brackets.
/// <para>
/// <b>Null is the mechanism that makes an identity handler expressible</b>: the mirror carries a leaf
/// through unchanged when its item produced no artifact. It is also how a metadata-only item and a
/// deliberate pass-through are expressed.
/// </para>
/// </param>
public sealed record NormalizedItem(
    SourceItem Source,
    StandardMetadata Metadata,
    ItemNames Names,
    NormalizedAudio? Audio,
    byte[]? MetadataDocument);
```

`src/Processor.SKNormalizer/Pipeline/StandardMetadata.cs`:

```csharp
namespace Processor.SKNormalizer;

/// <summary>
/// The metadata document under construction — an ORDERED list of name/value elements that stages 3,
/// 4 and 7 build up and <c>XmlMetadataRenderer</c> turns into XML.
/// <para>
/// <b>Ordered, and that is deliberate.</b> A standardized file whose element order varies between
/// runs is not comparable, and diffing two outputs is the cheapest way an operator checks a handler.
/// <c>Set</c> overwrites in place rather than appending, so a stage-7 correction of a stage-3 value
/// does not move it.
/// </para>
/// <para>
/// <b>Flat, not a tree, and that is a decision this phase can revisit.</b> No element vocabulary is
/// designed yet (the design's §12), so nesting would be speculative structure. The first real handler
/// is what decides whether this needs to become a tree.
/// </para>
/// </summary>
public sealed class StandardMetadata
{
    private readonly List<KeyValuePair<string, string>> _elements = [];

    /// <summary>The XML root element name. Defaulted so a handler that does not care need not say.</summary>
    public string RootName { get; set; } = "metadata";

    public IReadOnlyList<KeyValuePair<string, string>> Elements => _elements;

    public bool IsEmpty => _elements.Count == 0;

    /// <summary>Sets an element, overwriting in place if it is already present.</summary>
    public void Set(string name, string value)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(name);
        ArgumentNullException.ThrowIfNull(value);

        var index = _elements.FindIndex(e => e.Key.Equals(name, StringComparison.Ordinal));

        if (index >= 0)
        {
            _elements[index] = new KeyValuePair<string, string>(name, value);
            return;
        }

        _elements.Add(new KeyValuePair<string, string>(name, value));
    }

    public bool TryGet(string name, out string value)
    {
        foreach (var element in _elements)
        {
            if (element.Key.Equals(name, StringComparison.Ordinal))
            {
                value = element.Value;
                return true;
            }
        }

        value = string.Empty;
        return false;
    }
}
```

- [ ] **Step 4: Write `IProviderHandler`, a minimal `ProviderHandlerBase`, and the registry**

`src/Processor.SKNormalizer/Handlers/IProviderHandler.cs`:

```csharp
namespace Processor.SKNormalizer;

/// <summary>
/// One provider's business, as a set of tools the pipeline calls in a fixed order.
/// <para>
/// <b>EVERY MEMBER IS ABOUT CONTENT. None validates a schema and none needs to.</b> Schema
/// validation happens at exactly two points, both in the framework and neither reachable from here:
/// <c>ProcessDispatchHandler</c> validates the input before this processor is entered, and
/// <c>ProcessedDataHandler</c> validates the output after the send. A handler is handed data already
/// proven to fit its contract, and its result is proven again on the way out.
/// </para>
/// <para>
/// <b><see cref="LayoutFor"/> is the only member whose RESULT is schema-relevant</b>, since a layout
/// that nested too deep would fail output validation — which is exactly why <c>TreeAssembler</c>
/// owns legality and why the default layout preserves the input topology.
/// </para>
/// <para>
/// <b>Implementations MUST be stateless.</b> They are registered as singletons, and so is the
/// processor itself — per-dispatch state lives in the pipeline's locals. A handler holding per-item
/// fields would break silently.
/// </para>
/// </summary>
public interface IProviderHandler
{
    /// <summary>
    /// The registry key, matched case-insensitively against the <c>handler</c> field on the step
    /// payload. An author constant, never upstream content, so it is safe to log.
    /// </summary>
    string Name { get; }

    /// <summary>Stage 1. Finds the units of work in the incoming tree.</summary>
    IReadOnlyList<SourceItem> Locate(FileNode root);

    /// <summary>
    /// Stage 2. Rejects content this provider got wrong — a missing required field, an audio stream
    /// that is not what the metadata claims. <b>Not schema validation</b>; see the type remarks.
    /// </summary>
    /// <exception cref="NormalizationException">The content is not usable.</exception>
    void ValidateContent(SourceItem item);

    /// <summary>Stage 3. Projects the provider's fields into the standard metadata.</summary>
    StandardMetadata Map(SourceItem item);

    /// <summary>Stage 4. Adds fields knowable BEFORE conversion.</summary>
    void Augment(StandardMetadata metadata, SourceItem item);

    /// <summary>
    /// Stage 5. Decides output names. Runs before conversion because the transcoder needs a target
    /// name and the XML must reference the audio it describes — so a convention may use the
    /// REQUESTED profile and may not use measured output.
    /// </summary>
    ItemNames NameFor(StandardMetadata metadata, SourceItem item);

    /// <summary>
    /// Stage 6, the decision half. <b>Null means this item has no audio</b> — a metadata-only item
    /// is a legitimate shape, not a failure, and the pipeline skips the transcode. An item that
    /// SHOULD have audio and does not is stage 2's business.
    /// </summary>
    AudioProfile? ProfileFor(SourceItem item);

    /// <summary>
    /// Stage 7. Folds what the conversion actually produced back into the metadata. Duration, real
    /// bitrate, the codec ffmpeg chose and the output size are knowable nowhere else.
    /// </summary>
    void Reconcile(StandardMetadata metadata, NormalizedAudio? audio, ItemNames names);

    /// <summary>
    /// Stage 8, the decision half. Describes the output tree; the assembler builds it.
    /// <paramref name="root"/> is the INPUT document, so the default can mirror its topology.
    /// </summary>
    OutputLayout LayoutFor(FileNode root, IReadOnlyList<NormalizedItem> items);
}
```

`src/Processor.SKNormalizer/Handlers/ProviderHandlerBase.cs` — the minimal version; Task 4 replaces `LayoutFor` with the real mirror:

```csharp
namespace Processor.SKNormalizer;

/// <summary>
/// Defaults for the stages most providers will not vary. A convenience only: the INTERFACE is the
/// contract, and nothing may bind to this type.
/// </summary>
public abstract class ProviderHandlerBase : IProviderHandler
{
    public abstract string Name { get; }

    public abstract IReadOnlyList<SourceItem> Locate(FileNode root);

    public virtual void ValidateContent(SourceItem item)
    {
    }

    public virtual StandardMetadata Map(SourceItem item) => new();

    public virtual void Augment(StandardMetadata metadata, SourceItem item)
    {
    }

    public virtual ItemNames NameFor(StandardMetadata metadata, SourceItem item)
        => new($"{item.Key}.xml", $"{item.Key}");

    public virtual AudioProfile? ProfileFor(SourceItem item) => null;

    public virtual void Reconcile(StandardMetadata metadata, NormalizedAudio? audio, ItemNames names)
    {
    }

    // REPLACED IN TASK 4 by the topology-preserving mirror. Left abstract-in-spirit here so this
    // task's tests compile; no handler ships against this version.
    public virtual OutputLayout LayoutFor(FileNode root, IReadOnlyList<NormalizedItem> items)
        => new(root.Metadata.Name, root.Metadata.Extension, null);
}
```

`src/Processor.SKNormalizer/Handlers/ProviderHandlerRegistry.cs`:

```csharp
namespace Processor.SKNormalizer;

/// <summary>
/// Name to handler, built once at startup from every <see cref="IProviderHandler"/> the container
/// carries.
/// <para>
/// <b>Case-insensitive</b>, because the name arrives on a hand-written step payload and a case
/// mismatch is not a distinction worth failing a workflow over.
/// </para>
/// <para>
/// <b>The set of names here must equal the <c>enum</c> in
/// <c>src/tests/BaseApi.Tests/Schemas/sknormalizer-config.json</c></b>, which is what refuses a
/// workflow naming an absent handler at PUBLISH time. Nothing checks that at runtime —
/// <c>ConfigSchemaConformance</c> does not read enum values and the framework exposes no hook — so
/// <c>SKNormalizerConfigSchemaTests</c> is what keeps them in step.
/// </para>
/// </summary>
internal sealed class ProviderHandlerRegistry
{
    private readonly Dictionary<string, IProviderHandler> _handlers;

    public ProviderHandlerRegistry(IEnumerable<IProviderHandler> handlers)
    {
        ArgumentNullException.ThrowIfNull(handlers);

        _handlers = new Dictionary<string, IProviderHandler>(StringComparer.OrdinalIgnoreCase);

        foreach (var handler in handlers)
        {
            // THROWS RATHER THAN LAST-ONE-WINS. Two handlers claiming one name is a build-time
            // mistake, and resolving it by registration order would serve one of two providers at
            // random for as long as nobody noticed. The container builds this at startup, so the pod
            // fails to start instead.
            if (!_handlers.TryAdd(handler.Name, handler))
            {
                throw new InvalidOperationException(
                    $"two provider handlers claim the name '{handler.Name}'");
            }
        }

        Names = _handlers.Values.Select(h => h.Name).Order(StringComparer.Ordinal).ToList();
    }

    /// <summary>Ordered, so the unknown-handler rejection message is stable between failures.</summary>
    public IReadOnlyList<string> Names { get; }

    /// <summary>
    /// Null for an unknown name rather than throwing: turning that into a rejected payload with a
    /// message naming what IS carried belongs to the processor, not here.
    /// </summary>
    public IProviderHandler? Find(string name)
        => _handlers.TryGetValue(name, out var handler) ? handler : null;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd C:/Users/UserL/source/repos/SK_P9/src
dotnet test tests/BaseApi.Tests/BaseApi.Tests.csproj --filter "FullyQualifiedName~ProviderHandlerRegistryTests"
```

Expected: 8 passed.

- [ ] **Step 6: Commit**

```bash
cd C:/Users/UserL/source/repos/SK_P9
git add src/Processor.SKNormalizer src/tests/BaseApi.Tests/SKNormalizer
git commit -m "feat(sknormalizer): the handler contract and a duplicate-hostile registry"
```

---

### Task 4: The pipeline, the renderer, and the mirror default

This is the core. Stages run in a fixed order; the handler decides and shared code executes. Audio is wired through an `IAudioTranscoder` seam here and implemented in Task 5.

**Files:**
- Create: `src/Processor.SKNormalizer/Services/IAudioTranscoder.cs`
- Create: `src/Processor.SKNormalizer/Services/IMetadataRenderer.cs`
- Create: `src/Processor.SKNormalizer/Services/XmlMetadataRenderer.cs`
- Create: `src/Processor.SKNormalizer/Pipeline/NormalizationPipeline.cs`
- Modify: `src/Processor.SKNormalizer/Handlers/ProviderHandlerBase.cs` (replace `LayoutFor`)
- Modify: `src/Processor.SKNormalizer/Pipeline/PipelineTypes.cs` (`NormalizedItem` gains `MetadataDocument`)
- Create: `src/tests/BaseApi.Tests/Support/TranscoderDoubles.cs`
- Test: `src/tests/BaseApi.Tests/SKNormalizer/NormalizationPipelineTests.cs`
- Test: `src/tests/BaseApi.Tests/SKNormalizer/XmlMetadataRendererTests.cs`

**Interfaces:**
- Consumes: everything from Tasks 1–3.
- Produces:
  - `internal interface IAudioTranscoder { NormalizedAudio Transcode(byte[] source, string sourceExtension, AudioProfile profile, CancellationToken ct); }`
  - `internal interface IMetadataRenderer { byte[] Render(StandardMetadata metadata); }`
  - `internal sealed class XmlMetadataRenderer : IMetadataRenderer`
  - `internal sealed record NormalizationResult(FileNode Document, int ItemCount, int ConvertedCount)`
  - `NormalizedItem` gains `byte[]? MetadataDocument` — amend `Pipeline/PipelineTypes.cs` from Task 3
  - `internal sealed class NormalizationPipeline` with `NormalizationResult Run(FileNode root, IProviderHandler handler, CancellationToken ct)`

- [ ] **Step 1: Write the failing renderer test**

Create `src/tests/BaseApi.Tests/SKNormalizer/XmlMetadataRendererTests.cs`:

```csharp
using System.Text;
using Processor.SKNormalizer;
using Xunit;

namespace BaseApi.Tests.SKNormalizer;

public sealed class XmlMetadataRendererTests
{
    private static string Render(StandardMetadata metadata)
        => Encoding.UTF8.GetString(new XmlMetadataRenderer().Render(metadata));

    [Fact]
    public void ElementsAreRenderedInTheOrderTheyWereSet()
    {
        // The whole reason StandardMetadata is ordered: two runs of one handler must diff cleanly.
        var metadata = new StandardMetadata { RootName = "track" };
        metadata.Set("title", "Nocturne");
        metadata.Set("artist", "Unknown");

        var xml = Render(metadata);

        Assert.True(xml.IndexOf("title", StringComparison.Ordinal)
                    < xml.IndexOf("artist", StringComparison.Ordinal));
    }

    [Fact]
    public void SettingAnExistingElementOverwritesItInPlace()
    {
        // Stage 7 corrects stage 3's values. A correction must not move the element.
        var metadata = new StandardMetadata();
        metadata.Set("duration", "0");
        metadata.Set("codec", "mp3");
        metadata.Set("duration", "184");

        var xml = Render(metadata);

        Assert.Contains("<duration>184</duration>", xml, StringComparison.Ordinal);
        Assert.DoesNotContain("<duration>0</duration>", xml, StringComparison.Ordinal);
        Assert.True(xml.IndexOf("duration", StringComparison.Ordinal)
                    < xml.IndexOf("codec", StringComparison.Ordinal));
    }

    [Fact]
    public void ValuesAreEscaped()
    {
        // Upstream content reaching a document unescaped is how a standardized file becomes
        // unparseable for its consumer.
        var metadata = new StandardMetadata();
        metadata.Set("title", "Rock & Roll <live>");

        var xml = Render(metadata);

        Assert.Contains("Rock &amp; Roll &lt;live&gt;", xml, StringComparison.Ordinal);
    }

    [Fact]
    public void TheDocumentIsUtf8AndDeclaresIt()
    {
        var metadata = new StandardMetadata();
        metadata.Set("title", "Café");

        var bytes = new XmlMetadataRenderer().Render(metadata);

        Assert.Contains("utf-8", Encoding.UTF8.GetString(bytes), StringComparison.OrdinalIgnoreCase);
        // No BOM: a consumer reading this as text should not meet three surprise bytes.
        Assert.NotEqual(0xEF, bytes[0]);
    }

    [Fact]
    public void AnEmptyMetadataRendersAnEmptyRootRatherThanThrowing()
    {
        var xml = Render(new StandardMetadata { RootName = "track" });

        Assert.Contains("track", xml, StringComparison.Ordinal);
    }
}
```

- [ ] **Step 2: Write the shared transcoder doubles**

`IAudioTranscoder` is `internal`, so **`Substitute.For<IAudioTranscoder>()` will not work** — NSubstitute proxies through Castle DynamicProxy, which cannot see an internal interface unless the declaring assembly names `DynamicProxyGenAssembly2` in an `InternalsVisibleTo`. Hand-written doubles avoid adding that, and they are clearer about intent anyway.

Create `src/tests/BaseApi.Tests/Support/TranscoderDoubles.cs`:

```csharp
using System.Text;
using Processor.SKNormalizer;

namespace BaseApi.Tests.Support;

/// <summary>
/// Returns a fixed result and records what it was asked for.
/// <para>
/// Hand-written rather than an NSubstitute mock because <c>IAudioTranscoder</c> is internal to
/// Processor.SKNormalizer: Castle DynamicProxy cannot proxy it without that assembly naming
/// DynamicProxyGenAssembly2, and adding an InternalsVisibleTo purely to satisfy a mocking library is
/// a worse trade than twenty lines here.
/// </para>
/// </summary>
internal sealed class FakeTranscoder : IAudioTranscoder
{
    public List<AudioProfile> Calls { get; } = [];

    public NormalizedAudio Transcode(
        byte[] source, string sourceExtension, AudioProfile profile, CancellationToken ct)
    {
        Calls.Add(profile);

        var content = Encoding.UTF8.GetBytes("converted");

        return new NormalizedAudio(
            content, profile.TargetExtension, content.LongLength,
            TimeSpan.FromSeconds(184), 192, "mp3");
    }
}

/// <summary>
/// Throws if it is ever called. Used wherever a test asserts that NO conversion happened — an
/// unexercised substitute would pass silently, and this fails loudly.
/// </summary>
internal sealed class ExplodingTranscoder : IAudioTranscoder
{
    public NormalizedAudio Transcode(
        byte[] source, string sourceExtension, AudioProfile profile, CancellationToken ct)
        => throw new InvalidOperationException("the pipeline should not have transcoded");
}
```

- [ ] **Step 3: Write the failing pipeline test**

Create `src/tests/BaseApi.Tests/SKNormalizer/NormalizationPipelineTests.cs`:

```csharp
using System.Text;
using BaseApi.Tests.Support;
using Processor.SKNormalizer;
using Xunit;

namespace BaseApi.Tests.SKNormalizer;

public sealed class NormalizationPipelineTests
{
    private static DateTime Stamp => new(2026, 6, 7, 8, 9, 10, DateTimeKind.Utc);

    private static FileNode Leaf(string name, string text)
        => new(
            new FileMetadata(name, Path.GetExtension(name), text.Length, null, Stamp, 0),
            new FileContent.Bytes(Encoding.UTF8.GetBytes(text)));

    private static FileNode Archive(string name, params FileNode[] entries)
        => new(
            new FileMetadata(name, Path.GetExtension(name), 0, null, Stamp, entries.Length),
            new FileContent.Entries(entries));

    /// <summary>Records the order stages ran in, and can be told to throw from any one of them.</summary>
    private sealed class RecordingHandler : ProviderHandlerBase
    {
        public override string Name => "Recording";

        public List<string> Stages { get; } = [];

        public string? ThrowFrom { get; init; }

        public AudioProfile? Profile { get; init; }

        private void Enter(string stage)
        {
            Stages.Add(stage);

            if (ThrowFrom == stage)
            {
                throw new NormalizationException($"{stage} refused it");
            }
        }

        public override IReadOnlyList<SourceItem> Locate(FileNode root)
        {
            Enter(nameof(Locate));

            return root.Content is FileContent.Entries entries
                ? entries.Value.Select(e => new SourceItem(e.Metadata.Name, [e])).ToList()
                : [new SourceItem(root.Metadata.Name, [root])];
        }

        public override void ValidateContent(SourceItem item) => Enter(nameof(ValidateContent));

        public override StandardMetadata Map(SourceItem item)
        {
            Enter(nameof(Map));

            var metadata = new StandardMetadata();
            metadata.Set("key", item.Key);
            return metadata;
        }

        public override void Augment(StandardMetadata metadata, SourceItem item)
            => Enter(nameof(Augment));

        public override ItemNames NameFor(StandardMetadata metadata, SourceItem item)
        {
            Enter(nameof(NameFor));
            return new ItemNames($"{item.Key}.xml", $"{item.Key}.mp3");
        }

        public override AudioProfile? ProfileFor(SourceItem item)
        {
            Enter(nameof(ProfileFor));
            return Profile;
        }

        public override void Reconcile(
            StandardMetadata metadata, NormalizedAudio? audio, ItemNames names)
        {
            Enter(nameof(Reconcile));

            if (audio?.Duration is { } duration)
            {
                metadata.Set("duration", duration.TotalSeconds.ToString("F0"));
            }
        }

        public override OutputLayout LayoutFor(FileNode root, IReadOnlyList<NormalizedItem> items)
        {
            Enter(nameof(LayoutFor));
            return base.LayoutFor(root, items);
        }
    }

    private static NormalizationPipeline Pipeline(IAudioTranscoder transcoder)
        => new(new TreeAssembler(), new XmlMetadataRenderer(), transcoder);

    [Fact]
    public void TheStagesRunInTheDocumentedOrder()
    {
        var handler = new RecordingHandler { Profile = new AudioProfile(".mp3", ["-b:a", "192k"]) };

        Pipeline(new FakeTranscoder()).Run(
            Archive("in.zip", Leaf("a.wav", "x")), handler, CancellationToken.None);

        Assert.Equal(
            [
                nameof(handler.Locate),
                nameof(handler.ValidateContent),
                nameof(handler.Map),
                nameof(handler.Augment),
                nameof(handler.NameFor),
                nameof(handler.ProfileFor),
                nameof(handler.Reconcile),
                nameof(handler.LayoutFor),
            ],
            handler.Stages);
    }

    [Fact]
    public void ReconcileSeesWhatTheTranscoderProduced()
    {
        // The whole reason stage 7 exists: duration is knowable nowhere before conversion.
        var handler = new RecordingHandler { Profile = new AudioProfile(".mp3", []) };

        var result = Pipeline(new FakeTranscoder()).Run(
            Archive("in.zip", Leaf("a.wav", "x")), handler, CancellationToken.None);

        Assert.Equal(1, result.ConvertedCount);
    }

    [Fact]
    public void ANullProfileSkipsTheTranscodeEntirely()
    {
        // A metadata-only item is a legitimate shape, not a failure.
        var handler = new RecordingHandler { Profile = null };

        var result = Pipeline(new ExplodingTranscoder()).Run(
            Archive("in.zip", Leaf("a.txt", "x")), handler, CancellationToken.None);

        Assert.Equal(1, result.ItemCount);
        Assert.Equal(0, result.ConvertedCount);
    }

    [Theory]
    [InlineData("ValidateContent")]
    [InlineData("Map")]
    [InlineData("Augment")]
    [InlineData("NameFor")]
    [InlineData("ProfileFor")]
    [InlineData("Reconcile")]
    public void AThrowFromAnyItemStageNamesTheItem(string stage)
    {
        // The item key is the whole diagnostic: a document of forty items whose ninth is malformed
        // is useless to an operator unless the message says which.
        var handler = new RecordingHandler { ThrowFrom = stage };

        var ex = Assert.Throws<NormalizationException>(
            () => Pipeline(new FakeTranscoder()).Run(
                Archive("in.zip", Leaf("ninth.wav", "x")), handler, CancellationToken.None));

        Assert.Contains("ninth.wav", ex.Message, StringComparison.Ordinal);
        Assert.Contains("refused it", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void TheSecondItemIsNeverProcessedAfterTheFirstFails()
    {
        // NO PARTIAL OUTPUT, and no partial WORK either. Nine good items and one bad one is a failed
        // step; continuing past a failure would burn a transcode for a document already doomed.
        var handler = new RecordingHandler { ThrowFrom = "Map" };

        Assert.Throws<NormalizationException>(
            () => Pipeline(new FakeTranscoder()).Run(
                Archive("in.zip", Leaf("a.wav", "x"), Leaf("b.wav", "y")),
                handler,
                CancellationToken.None));

        Assert.Single(handler.Stages.Where(s => s == nameof(handler.Map)));
    }

    [Fact]
    public void AThrowFromLocateIsReportedWithoutAnItemKey()
    {
        // Stage 1 has no item yet, so there is nothing to name. This is the "wrong handler for this
        // feed" failure, and its message must read as such rather than as a bare parse error.
        var handler = new RecordingHandler { ThrowFrom = "Locate" };

        var ex = Assert.Throws<NormalizationException>(
            () => Pipeline(new FakeTranscoder()).Run(
                Archive("in.zip", Leaf("a.wav", "x")), handler, CancellationToken.None));

        Assert.DoesNotContain("item '", ex.Message, StringComparison.Ordinal);
    }
}
```

- [ ] **Step 4: Run both test files to verify they fail**

```bash
cd C:/Users/UserL/source/repos/SK_P9/src
dotnet test tests/BaseApi.Tests/BaseApi.Tests.csproj --filter "FullyQualifiedName~XmlMetadataRendererTests|FullyQualifiedName~NormalizationPipelineTests"
```

Expected: FAIL — `IAudioTranscoder`, `XmlMetadataRenderer`, `NormalizationPipeline` do not exist.

- [ ] **Step 5: Write the two service interfaces and the renderer**

`src/Processor.SKNormalizer/Services/IAudioTranscoder.cs`:

```csharp
namespace Processor.SKNormalizer;

/// <summary>
/// Runs one conversion. <b>No handler shells out</b>: one place composes a command line, one place
/// has a timeout, one place cleans up temp files, and one place is what a test replaces.
/// </summary>
internal interface IAudioTranscoder
{
    /// <exception cref="NormalizationException">The conversion failed or timed out.</exception>
    NormalizedAudio Transcode(
        byte[] source, string sourceExtension, AudioProfile profile, CancellationToken ct);
}
```

`src/Processor.SKNormalizer/Services/IMetadataRenderer.cs`:

```csharp
namespace Processor.SKNormalizer;

/// <summary>
/// Turns the metadata a handler described into bytes. Purely mechanical — encoding, declaration,
/// escaping. <b>A handler describes the document; it never writes angle brackets.</b>
/// </summary>
internal interface IMetadataRenderer
{
    byte[] Render(StandardMetadata metadata);
}
```

`src/Processor.SKNormalizer/Services/XmlMetadataRenderer.cs`:

```csharp
using System.Text;
using System.Xml;

namespace Processor.SKNormalizer;

internal sealed class XmlMetadataRenderer : IMetadataRenderer
{
    private static readonly XmlWriterSettings Settings = new()
    {
        Indent = true,
        // UTF8Encoding(false): NO BOM. A consumer reading the standardized file as text should not
        // meet three surprise bytes before the declaration.
        Encoding = new UTF8Encoding(false),
    };

    public byte[] Render(StandardMetadata metadata)
    {
        ArgumentNullException.ThrowIfNull(metadata);

        using var buffer = new MemoryStream();

        using (var writer = XmlWriter.Create(buffer, Settings))
        {
            writer.WriteStartDocument();
            writer.WriteStartElement(metadata.RootName);

            // IN ORDER, and WriteElementString escapes the value. Upstream content reaching the
            // document unescaped is how a standardized file becomes unparseable for its consumer.
            foreach (var element in metadata.Elements)
            {
                writer.WriteElementString(element.Key, element.Value);
            }

            writer.WriteEndElement();
            writer.WriteEndDocument();
        }

        return buffer.ToArray();
    }
}
```

- [ ] **Step 6: Write the pipeline**

`src/Processor.SKNormalizer/Pipeline/NormalizationPipeline.cs`:

```csharp
namespace Processor.SKNormalizer;

/// <summary>What one dispatch produced. Counts are for the log line; the document is the payload.</summary>
internal sealed record NormalizationResult(FileNode Document, int ItemCount, int ConvertedCount);

/// <summary>
/// The eight stages, in order. <b>The handler decides; this executes.</b> Stages 6 and 8 are the
/// clearest expression of that split — the handler returns a description and shared code carries it
/// out.
/// </summary>
internal sealed class NormalizationPipeline(
    ITreeAssembler assembler, IMetadataRenderer renderer, IAudioTranscoder transcoder)
{
    public NormalizationResult Run(FileNode root, IProviderHandler handler, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(root);
        ArgumentNullException.ThrowIfNull(handler);

        // Stage 1. No item exists yet, so a failure here carries no key — this is the "wrong handler
        // for this feed" failure and the handler's own message is the whole diagnostic.
        var items = handler.Locate(root);

        var normalized = new List<NormalizedItem>(items.Count);
        var converted = 0;

        foreach (var item in items)
        {
            // STOPS AT THE FIRST FAILURE. No partial output and no partial work: continuing would
            // burn a transcode for a document already doomed to be a failed step.
            normalized.Add(Normalize(item, handler, ct, ref converted));
        }

        // Stage 8. The handler describes; the assembler builds and enforces every rule
        // ArchiveCollapser would enforce one hop later.
        var layout = handler.LayoutFor(root, normalized);

        return new NormalizationResult(assembler.Assemble(layout), items.Count, converted);
    }

    private NormalizedItem Normalize(
        SourceItem item, IProviderHandler handler, CancellationToken ct, ref int converted)
    {
        try
        {
            ct.ThrowIfCancellationRequested();

            handler.ValidateContent(item);                      // 2

            var metadata = handler.Map(item);                   // 3
            handler.Augment(metadata, item);                    // 4

            var names = handler.NameFor(metadata, item);        // 5
            var audio = Convert(item, handler, ct);             // 6

            if (audio is not null)
            {
                converted++;
            }

            handler.Reconcile(metadata, audio, names);          // 7

            // Rendered HERE, after stage 7, so stage 8 places bytes rather than rendering them.
            // ARTIFACT EMISSION IS OPTIONAL: empty metadata renders to null, and the mirror carries
            // the leaf through unchanged. A pipeline that always emitted XML could not express
            // identity, a metadata-only item, or a deliberate pass-through.
            var document = metadata.IsEmpty ? null : renderer.Render(metadata);

            return new NormalizedItem(item, metadata, names, audio, document);
        }
        catch (NormalizationException ex)
        {
            // RETHROWN WITH THE KEY PREPENDED, once. The key is upstream-derived, which is why it
            // belongs in this message and in no log template of ours.
            throw new NormalizationException($"item '{item.Key}': {ex.Message}");
        }
    }

    private NormalizedAudio? Convert(SourceItem item, IProviderHandler handler, CancellationToken ct)
    {
        // Null means this item has no audio — a metadata-only item is a legitimate shape. An item
        // that SHOULD have audio and does not is stage 2's business, where it can be reported
        // properly.
        if (handler.ProfileFor(item) is not { } profile)
        {
            return null;
        }

        var source = item.Nodes.FirstOrDefault(n => n.Content is FileContent.Bytes)
            ?? throw new NormalizationException(
                "a conversion profile was named but the item carries no file content");

        var bytes = ((FileContent.Bytes)source.Content!).Value;

        return transcoder.Transcode(bytes, source.Metadata.Extension, profile, ct);
    }
}
```

- [ ] **Step 7: Replace `ProviderHandlerBase.LayoutFor` with the mirror**

In `src/Processor.SKNormalizer/Handlers/ProviderHandlerBase.cs`, replace the placeholder `LayoutFor` with:

```csharp
    /// <summary>
    /// Stage 8, default: <b>preserve the input topology</b>. Same nesting, same entry count; only
    /// contents, names and extensions change. Most handlers never override this.
    /// <para>
    /// <b>It satisfies the output schema by construction.</b> Output depth equals input depth, and
    /// the input arrived through the same registered row — so no handler has to think about the
    /// row's depth.
    /// </para>
    /// <para>
    /// <b>A leaf with no artifact passes through unchanged.</b> That is what makes an identity
    /// handler expressible, and it is also how a metadata-only item and a deliberate pass-through
    /// are expressed.
    /// </para>
    /// </summary>
    public virtual OutputLayout LayoutFor(FileNode root, IReadOnlyList<NormalizedItem> items)
    {
        ArgumentNullException.ThrowIfNull(root);
        ArgumentNullException.ThrowIfNull(items);

        // Keyed on the node the item was located from, so a substitution lands in the position the
        // source occupied rather than being appended somewhere.
        var replacements = new Dictionary<FileNode, NormalizedItem>();

        foreach (var item in items)
        {
            foreach (var node in item.Source.Nodes)
            {
                replacements[node] = item;
            }
        }

        // EVERY FIELD CARRIED, not just the name. Size and both timestamps travel with each node,
        // because preserving topology that loses metadata is not preserving the document.
        return new OutputLayout(
            root.Metadata.Name,
            root.Metadata.Extension,
            root.Metadata.SizeBytes,
            root.Metadata.CreatedUtc,
            root.Metadata.ModifiedUtc,
            root.Content is FileContent.Entries entries
                ? entries.Value.Select(e => Mirror(e, replacements)).ToList()
                : null);
    }

    private static OutputNode Mirror(
        FileNode node, IReadOnlyDictionary<FileNode, NormalizedItem> replacements)
        => node.Content switch
        {
            FileContent.Entries entries => new OutputNode.Folder(
                node.Metadata.Name,
                node.Metadata.Extension,
                node.Metadata.SizeBytes,
                node.Metadata.CreatedUtc,
                node.Metadata.ModifiedUtc,
                entries.Value.Select(e => Mirror(e, replacements)).ToList()),

            FileContent.Bytes bytes => new OutputNode.File(
                node.Metadata.Name, bytes.Value, node.Metadata.CreatedUtc, node.Metadata.ModifiedUtc),

            // An archive that expanded to nothing. Mirrored as an empty container, which the
            // assembler turns back into the format's canonical empty archive.
            _ => new OutputNode.Folder(
                node.Metadata.Name,
                node.Metadata.Extension,
                node.Metadata.SizeBytes,
                node.Metadata.CreatedUtc,
                node.Metadata.ModifiedUtc,
                []),
        };
```

> `replacements` is built but not consumed by the base mirror, because the base handler produces no artifacts — every item's `MetadataDocument` is null and every `Audio` is null, so every leaf passes through. A real handler overrides `LayoutFor`, or calls `base.LayoutFor` for the shape, substituting `item.MetadataDocument` and `item.Audio.Content` at the positions `replacements` identifies. Task 7's `SampleHandler` uses the base directly.

- [ ] **Step 8: Run both test files to verify they pass**

```bash
cd C:/Users/UserL/source/repos/SK_P9/src
dotnet test tests/BaseApi.Tests/BaseApi.Tests.csproj --filter "FullyQualifiedName~XmlMetadataRendererTests|FullyQualifiedName~NormalizationPipelineTests"
```

Expected: 17 passed.

- [ ] **Step 9: Commit**

```bash
cd C:/Users/UserL/source/repos/SK_P9
git add src/Processor.SKNormalizer src/tests/BaseApi.Tests/SKNormalizer
git commit -m "feat(sknormalizer): the eight-stage pipeline, the renderer, and the mirror default"
```

---

### Task 5: `FfmpegAudioTranscoder`

> **This task is NOT optional, despite nothing in phase 1 converting audio.** Task 7's `ProcessorHost` registers `IAudioTranscoder → FfmpegAudioTranscoder` and `Configure<SKNormalizerOptions>`, and Task 7's host test asserts the whole graph resolves under Development-mode container validation — so cutting this task breaks Task 7 outright. It also creates `SKNormalizerOptions`, which Task 10's manifest env vars bind to.

**Files:**
- Create: `src/Processor.SKNormalizer/SKNormalizerOptions.cs`
- Create: `src/Processor.SKNormalizer/Services/FfmpegAudioTranscoder.cs`
- Test: `src/tests/BaseApi.Tests/SKNormalizer/FfmpegAudioTranscoderTests.cs`

**Interfaces:**
- Consumes: `IAudioTranscoder`, `AudioProfile`, `NormalizedAudio`, `NormalizationException`.
- Produces: `public sealed class SKNormalizerOptions { public string FfmpegPath { get; set; } public int ConversionTimeoutSeconds { get; set; } }`; `internal sealed class FfmpegAudioTranscoder(IOptions<SKNormalizerOptions> options) : IAudioTranscoder`.

- [ ] **Step 1: Write the failing test**

Create `src/tests/BaseApi.Tests/SKNormalizer/FfmpegAudioTranscoderTests.cs`:

```csharp
using Microsoft.Extensions.Options;
using Processor.SKNormalizer;
using Xunit;

namespace BaseApi.Tests.SKNormalizer;

public sealed class FfmpegAudioTranscoderTests
{
    private static FfmpegAudioTranscoder Build(string path, int timeoutSeconds = 300)
        => new(Options.Create(new SKNormalizerOptions
        {
            FfmpegPath = path,
            ConversionTimeoutSeconds = timeoutSeconds,
        }));

    [Fact]
    public void AnAbsentBinaryIsABusinessFailureNotACrash()
    {
        // THE FIRST THING TO GO WRONG ON A FIRST DEPLOY. A missing binary must not surface as a
        // Win32Exception escaping the processor — it reads as a content problem when it is an image
        // problem, and the message is what tells them apart.
        var transcoder = Build("definitely-not-a-real-binary-9f3a");

        var ex = Assert.Throws<NormalizationException>(
            () => transcoder.Transcode(
                [1, 2, 3], ".wav", new AudioProfile(".mp3", []), CancellationToken.None));

        Assert.Contains("definitely-not-a-real-binary-9f3a", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ACancelledTokenStopsBeforeAnythingIsSpawned()
    {
        using var cts = new CancellationTokenSource();
        cts.Cancel();

        Assert.Throws<OperationCanceledException>(
            () => Build("ffmpeg").Transcode(
                [1, 2, 3], ".wav", new AudioProfile(".mp3", []), cts.Token));
    }

    [Trait("Category", "RealStack")]
    [Fact]
    public void ARealConversionProducesBytesAndAProbedDuration()
    {
        // NEEDS THE BINARY, so it is RealStack and not part of the hermetic suite. The source is
        // generated by ffmpeg itself rather than checked in, so this test carries no binary asset.
        var source = Build("ffmpeg").Transcode(
            [],
            ".null",
            new AudioProfile(".wav", ["-f", "lavfi", "-i", "sine=frequency=440:duration=1"]),
            CancellationToken.None);

        Assert.NotEmpty(source.Content);
        Assert.Equal(".wav", source.Extension);
        Assert.Equal(source.Content.LongLength, source.SizeBytes);
    }
}
```

- [ ] **Step 2: Run the hermetic tests to verify they fail**

```bash
cd C:/Users/UserL/source/repos/SK_P9/src
dotnet test tests/BaseApi.Tests/BaseApi.Tests.csproj --filter "FullyQualifiedName~FfmpegAudioTranscoderTests"
```

Expected: FAIL — the types do not exist.

> **On filtering:** `--filter "Category!=RealStack"` is silently ignored under this repo's test runner; every run is the full suite. Do not rely on it to exclude the RealStack case — run by name as above.

- [ ] **Step 3: Write the options**

`src/Processor.SKNormalizer/SKNormalizerOptions.cs`:

```csharp
namespace Processor.SKNormalizer;

/// <summary>
/// Bound from <c>SKNormalizer__*</c> in the manifest. These are numbers an operator sizes against a
/// container limit, and a workflow author has no way to know them.
/// <para>
/// <b>THERE IS DELIBERATELY NO SIZE CEILING HERE, and it is not an omission left from a copy.</b>
/// The input document already passed ArchiveExpander, whose <c>MaxExpandedBytes</c> bounds total
/// expanded content, so a second input ceiling would restate an upstream guarantee with a second
/// number to keep consistent. The consequence is accepted knowingly: that number now sizes TWO
/// consumers, conversion can grow data, output size is unbounded, and an out-of-memory pod at
/// prefetch 1 is a redelivery loop rather than one failure. The mitigation is sizing, not code.
/// </para>
/// </summary>
public sealed class SKNormalizerOptions
{
    /// <summary>Resolved from PATH by default; the image installs it.</summary>
    public string FfmpegPath { get; set; } = "ffmpeg";

    /// <summary>
    /// Per conversion, not per dispatch. A wedged ffmpeg holds the one prefetched message forever,
    /// so this is what turns a hang into a failed step.
    /// </summary>
    public int ConversionTimeoutSeconds { get; set; } = 300;
}
```

- [ ] **Step 4: Write the transcoder**

`src/Processor.SKNormalizer/Services/FfmpegAudioTranscoder.cs`:

```csharp
using System.Diagnostics;
using System.Globalization;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Options;

namespace Processor.SKNormalizer;

/// <summary>
/// Runs ffmpeg over temp files. The ONLY place in this processor that starts a process.
/// </summary>
internal sealed partial class FfmpegAudioTranscoder(IOptions<SKNormalizerOptions> options)
    : IAudioTranscoder
{
    private readonly SKNormalizerOptions _options = options.Value;

    public NormalizedAudio Transcode(
        byte[] source, string sourceExtension, AudioProfile profile, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(source);
        ArgumentNullException.ThrowIfNull(profile);
        ct.ThrowIfCancellationRequested();

        var work = Path.Combine(Path.GetTempPath(), $"skn-{Guid.NewGuid():N}");
        Directory.CreateDirectory(work);

        var input = Path.Combine(work, $"in{Extension(sourceExtension)}");
        var output = Path.Combine(work, $"out{Extension(profile.TargetExtension)}");

        try
        {
            File.WriteAllBytes(input, source);

            var stderr = Run(BuildArguments(input, output, profile, source.Length > 0), ct);

            if (!File.Exists(output))
            {
                throw new NormalizationException(
                    $"the conversion produced no output file: {Tail(stderr)}");
            }

            var content = File.ReadAllBytes(output);

            return new NormalizedAudio(
                content,
                profile.TargetExtension,
                content.LongLength,
                Duration(stderr),
                Bitrate(stderr),
                Codec(stderr));
        }
        finally
        {
            // Best effort. A leaked temp directory is a disk problem an operator can see; throwing
            // from a finally would replace a real failure with a cleanup one.
            try
            {
                Directory.Delete(work, recursive: true);
            }
            catch (IOException)
            {
            }
            catch (UnauthorizedAccessException)
            {
            }
        }
    }

    /// <summary>
    /// The handler's arguments, between the input and the output. <c>-y</c> overwrites and
    /// <c>-nostdin</c> stops ffmpeg blocking on a console this process does not have.
    /// </summary>
    private static List<string> BuildArguments(
        string input, string output, AudioProfile profile, bool hasInput)
    {
        var arguments = new List<string> { "-nostdin", "-y" };

        // A profile may name its own input (a lavfi source, for instance), in which case the temp
        // file is not one. Only supply -i when there are actually source bytes.
        if (hasInput)
        {
            arguments.Add("-i");
            arguments.Add(input);
        }

        arguments.AddRange(profile.Arguments);
        arguments.Add(output);

        return arguments;
    }

    private string Run(IReadOnlyList<string> arguments, CancellationToken ct)
    {
        var info = new ProcessStartInfo(_options.FfmpegPath)
        {
            RedirectStandardError = true,
            RedirectStandardOutput = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };

        foreach (var argument in arguments)
        {
            // ArgumentList, never a concatenated string: a file name carrying a space or a quote
            // would otherwise change the command's shape.
            info.ArgumentList.Add(argument);
        }

        using var process = new Process { StartInfo = info };

        try
        {
            process.Start();
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or FileNotFoundException)
        {
            // THE FIRST-DEPLOY FAILURE. An absent binary escaping as a Win32Exception would be
            // reported as an unhandled fault; as a business failure it names the path an operator
            // set, which is the fix.
            throw new NormalizationException(
                $"could not start '{_options.FfmpegPath}': {ex.Message}");
        }

        // Read before waiting: a full stderr pipe deadlocks a process that is still writing to it.
        var stderr = process.StandardError.ReadToEnd();
        _ = process.StandardOutput.ReadToEnd();

        if (!process.WaitForExit(TimeSpan.FromSeconds(_options.ConversionTimeoutSeconds)))
        {
            Kill(process);

            throw new NormalizationException(
                $"the conversion did not finish within {_options.ConversionTimeoutSeconds}s");
        }

        if (process.ExitCode != 0)
        {
            throw new NormalizationException(
                $"the conversion failed with exit code {process.ExitCode}: {Tail(stderr)}");
        }

        return stderr;
    }

    private static void Kill(Process process)
    {
        try
        {
            process.Kill(entireProcessTree: true);
        }
        catch (InvalidOperationException)
        {
            // Already gone between the timeout and the kill.
        }
    }

    /// <summary>
    /// The LAST few lines of ffmpeg's stderr, which is where its error actually is — the first
    /// several hundred are a build banner. Bounded because this reaches a FailedException message.
    /// </summary>
    private static string Tail(string stderr)
    {
        var lines = stderr.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

        return lines.Length == 0 ? "no output" : string.Join(" | ", lines.TakeLast(3));
    }

    private static string Extension(string extension)
        => extension.StartsWith('.') ? extension : $".{extension}";

    private static TimeSpan? Duration(string stderr)
    {
        var match = DurationPattern().Match(stderr);

        return match.Success
               && TimeSpan.TryParse(match.Groups[1].Value, CultureInfo.InvariantCulture, out var parsed)
            ? parsed
            : null;
    }

    private static int? Bitrate(string stderr)
    {
        var match = BitratePattern().Match(stderr);

        return match.Success
               && int.TryParse(match.Groups[1].Value, CultureInfo.InvariantCulture, out var parsed)
            ? parsed
            : null;
    }

    private static string? Codec(string stderr)
    {
        var match = CodecPattern().Match(stderr);

        return match.Success ? match.Groups[1].Value : null;
    }

    // Parsed from stderr rather than by a second ffprobe run: one process per conversion, and the
    // numbers are already there. A null means the probe could not tell — stage 7 must not invent one.
    [GeneratedRegex(@"Duration:\s*(\d+:\d{2}:\d{2}\.\d+)")]
    private static partial Regex DurationPattern();

    [GeneratedRegex(@"bitrate:\s*(\d+)\s*kb/s")]
    private static partial Regex BitratePattern();

    [GeneratedRegex(@"Audio:\s*([a-zA-Z0-9_]+)")]
    private static partial Regex CodecPattern();
}
```

- [ ] **Step 5: Run the hermetic tests to verify they pass**

```bash
cd C:/Users/UserL/source/repos/SK_P9/src
dotnet test tests/BaseApi.Tests/BaseApi.Tests.csproj --filter "FullyQualifiedName~FfmpegAudioTranscoderTests.AnAbsentBinaryIsABusinessFailureNotACrash|FullyQualifiedName~FfmpegAudioTranscoderTests.ACancelledTokenStopsBeforeAnythingIsSpawned"
```

Expected: 2 passed. The RealStack case passes only where ffmpeg is installed.

- [ ] **Step 6: Commit**

```bash
cd C:/Users/UserL/source/repos/SK_P9
git add src/Processor.SKNormalizer src/tests/BaseApi.Tests/SKNormalizer
git commit -m "feat(sknormalizer): run ffmpeg behind one seam with a timeout and a legible failure"
```

---

### Task 6: The processor — payload, envelope, dispatch, send

**Files:**
- Create: `src/Processor.SKNormalizer/SKNormalizerConfig.cs`
- Create: `src/Processor.SKNormalizer/SKNormalizerProcessor.cs`
- Test: `src/tests/BaseApi.Tests/SKNormalizer/ProcessorSKNormalizerTests.cs`

**Interfaces:**
- Consumes: `ProviderHandlerRegistry`, `NormalizationPipeline`, `FileNode`, `FileDocument.Options`, `ExplodingTranscoder` (Task 4).
- Produces: `public sealed record SKNormalizerConfig(string Handler) : ProcessorConfig`; `internal sealed class SKNormalizerProcessor(ILogger<SKNormalizerProcessor>, ProviderHandlerRegistry, NormalizationPipeline) : BaseProcessor<SKNormalizerConfig>`.

- [ ] **Step 1: Write the failing test**

Create `src/tests/BaseApi.Tests/SKNormalizer/ProcessorSKNormalizerTests.cs`:

```csharp
using System.Text;
using System.Text.Json;
using BaseApi.Tests.Support;
using BaseProcessor.Core.Processing;
using Messaging.Contracts;
using Messaging.Transport;
using NSubstitute;
using Processor.SKNormalizer;
using Xunit;

namespace BaseApi.Tests.SKNormalizer;

public sealed class ProcessorSKNormalizerTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");
    private static readonly Guid E = Guid.Parse("55555555-5555-5555-5555-555555555555");

    private static DateTime Stamp => new(2026, 6, 7, 8, 9, 10, DateTimeKind.Utc);

    private static FileNode Leaf(string name, string text)
        => new(
            new FileMetadata(name, Path.GetExtension(name), text.Length, null, Stamp, 0),
            new FileContent.Bytes(Encoding.UTF8.GetBytes(text)));

    private static FileNode Archive(string name, params FileNode[] entries)
        => new(
            new FileMetadata(name, Path.GetExtension(name), 0, null, Stamp, entries.Length),
            new FileContent.Entries(entries));

    private static byte[] Document(FileNode node)
        => JsonSerializer.SerializeToUtf8Bytes(node, FileDocument.Options);

    /// <summary>A handler that locates every entry and produces nothing — the Task 7 shape.</summary>
    private sealed class Identity : ProviderHandlerBase
    {
        public override string Name => "Sample";

        public override IReadOnlyList<SourceItem> Locate(FileNode root)
            => root.Content is FileContent.Entries entries
                ? entries.Value.Select(e => new SourceItem(e.Metadata.Name, [e])).ToList()
                : [new SourceItem(root.Metadata.Name, [root])];
    }

    private static (SKNormalizerProcessor Processor, RecordingLogger<SKNormalizerProcessor> Log)
        Build(params IProviderHandler[] handlers)
    {
        var log = new RecordingLogger<SKNormalizerProcessor>();

        var processor = new SKNormalizerProcessor(
            log,
            new ProviderHandlerRegistry(handlers),
            // Exploding, not a substitute: IAudioTranscoder is internal and cannot be proxied,
            // and nothing in these tests should ever convert — SampleHandler's ProfileFor returns
            // null for every item. If this throws, the handler stopped being identity.
            new NormalizationPipeline(
                new TreeAssembler(), new XmlMetadataRenderer(), new ExplodingTranscoder()));

        return (processor, log);
    }

    private static async Task<ProcessedData> Run(byte[] data, string payload)
    {
        var (processor, _) = Build(new Identity());

        var sender = Substitute.For<IQueueSender>();
        var sends = new List<ProcessedData>();
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(sends.Add),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());

        processor.BeginDispatch(new DispatchState(sender, C, W, S, P));
        await processor.ExecuteAsync(data, payload, E, CancellationToken.None);

        return Assert.Single(sends);
    }

    private static async Task<FailedException> Fails(byte[] data, string payload)
    {
        var (processor, _) = Build(new Identity());

        var sender = Substitute.For<IQueueSender>();
        processor.BeginDispatch(new DispatchState(sender, C, W, S, P));

        return await Assert.ThrowsAsync<FailedException>(
            () => processor.ExecuteAsync(data, payload, E, CancellationToken.None));
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public async Task AnAbsentPayloadIsRejected(string payload)
    {
        // An absent payload IS a malformed payload, and it shares the prefix so one query finds every
        // payload fault including the commonest one.
        var ex = await Fails(Document(Leaf("a.csv", "id")), payload);

        Assert.StartsWith("step payload rejected:", ex.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("""{"handler":""}""")]
    [InlineData("""{"handler":"   "}""")]
    public async Task ABlankHandlerIsRejected(string payload)
    {
        var ex = await Fails(Document(Leaf("a.csv", "id")), payload);

        Assert.StartsWith("step payload rejected:", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnUnknownHandlerIsRejectedAndTheMessageNamesWhatTheBuildCarries()
    {
        // THE DIAGNOSTIC. A step wired for a handler this build predates is the one axis these drift
        // on, and listing the available names turns a guess into a read. Safe to include: handler
        // names are author constants, never upstream content.
        var ex = await Fails(Document(Leaf("a.csv", "id")), """{"handler":"NotHere"}""");

        Assert.Contains("NotHere", ex.Message, StringComparison.Ordinal);
        Assert.Contains("Sample", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task TheHandlerNameIsMatchedCaseInsensitively()
    {
        var sent = await Run(Document(Archive("in.zip", Leaf("a.csv", "id"))), """{"handler":"sample"}""");

        Assert.NotNull(sent.Data);
    }

    [Theory]
    [InlineData("not json at all")]
    [InlineData("null")]
    public async Task ABranchThatIsNotAFileDocumentIsRejected(string body)
    {
        var ex = await Fails(Encoding.UTF8.GetBytes(body), """{"handler":"Sample"}""");

        Assert.StartsWith("input branch did not carry a file document:", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ARootWithNoNameIsRejected()
    {
        // Caught here rather than one hop later, where the post handler reports Failed with EntryId
        // Guid.Empty, no payload and no name — nothing an operator could act on.
        var node = new FileNode(
            new FileMetadata("", "", 0, null, Stamp, 0), new FileContent.Bytes([1]));

        var ex = await Fails(Document(node), """{"handler":"Sample"}""");

        Assert.Contains("no name", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task TheErrorTextOfAMalformedDocumentIsNeverQuoted()
    {
        // The parse error quotes the fragment that failed, and that fragment is upstream content. The
        // CLASS of fault is what is reported; the ids in the open scope are how it is traced back.
        var ex = await Fails(
            Encoding.UTF8.GetBytes("""{"metadata":{"name":"secret-customer-name"""),
            """{"handler":"Sample"}""");

        Assert.DoesNotContain("secret-customer-name", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AFailingHandlerBecomesOneFailedStepNamingTheDocumentAndTheItem()
    {
        var (processor, _) = Build(new Throwing());

        var sender = Substitute.For<IQueueSender>();
        processor.BeginDispatch(new DispatchState(sender, C, W, S, P));

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => processor.ExecuteAsync(
                Document(Archive("in.zip", Leaf("ninth.wav", "x"))),
                """{"handler":"Throwing"}""",
                E,
                CancellationToken.None));

        Assert.Contains("in.zip", ex.Message, StringComparison.Ordinal);
        Assert.Contains("ninth.wav", ex.Message, StringComparison.Ordinal);
    }

    private sealed class Throwing : ProviderHandlerBase
    {
        public override string Name => "Throwing";

        public override IReadOnlyList<SourceItem> Locate(FileNode root)
            => root.Content is FileContent.Entries entries
                ? entries.Value.Select(e => new SourceItem(e.Metadata.Name, [e])).ToList()
                : [];

        public override void ValidateContent(SourceItem item)
            => throw new NormalizationException("the metadata names no title");
    }

    [Fact]
    public async Task NothingIsLoggedForAFailure()
    {
        // ProcessDispatchHandler writes a FailedException's message verbatim, so a line here would
        // emit every failure twice. If this ever fails, a logger call crept into a failure path.
        var (processor, log) = Build(new Identity());

        var sender = Substitute.For<IQueueSender>();
        processor.BeginDispatch(new DispatchState(sender, C, W, S, P));

        await Assert.ThrowsAsync<FailedException>(
            () => processor.ExecuteAsync([], "", E, CancellationToken.None));

        Assert.Empty(log.Entries);
    }

    [Fact]
    public async Task TheSuccessLineCarriesShapeAndNeverContent()
    {
        var (processor, log) = Build(new Identity());

        var sender = Substitute.For<IQueueSender>();
        processor.BeginDispatch(new DispatchState(sender, C, W, S, P));

        await processor.ExecuteAsync(
            Document(Archive("in.zip", Leaf("a.csv", "id"), Leaf("b.csv", "id"))),
            """{"handler":"Sample"}""",
            E,
            CancellationToken.None);

        var entry = Assert.Single(log.Entries);
        Assert.Contains("Sample", entry.Message, StringComparison.Ordinal);
        Assert.Contains("2", entry.Message, StringComparison.Ordinal);
        // The bytes of an entry are upstream content and must not reach a template.
        Assert.DoesNotContain("id", entry.Message, StringComparison.Ordinal);
    }
}
```

> `RecordingLogger<T>` already exists in `BaseApi.Tests.Support`. Check its member names before writing the two assertions on `log.Entries` — if it exposes something other than `Entries`/`Message`, adapt these two tests to what it has rather than changing the logger.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd C:/Users/UserL/source/repos/SK_P9/src
dotnet test tests/BaseApi.Tests/BaseApi.Tests.csproj --filter "FullyQualifiedName~ProcessorSKNormalizerTests"
```

Expected: FAIL — `SKNormalizerProcessor` and `SKNormalizerConfig` do not exist.

- [ ] **Step 3: Write the config record**

`src/Processor.SKNormalizer/SKNormalizerConfig.cs`:

```csharp
using BaseProcessor.Core.Configuration;

namespace Processor.SKNormalizer;

/// <summary>
/// The step payload, and it holds exactly one field.
/// <para>
/// <b>Everything else a provider needs is IN the handler</b> — that is the whole point of compiling
/// them in. A payload naming field maps or ffmpeg arguments would be a second, weaker place to
/// express what the handler already states in code, and the two would drift.
/// </para>
/// <para>
/// <b>The registered config schema declares this field with an <c>enum</c> of the handler names this
/// build carries</b>, so <c>PayloadConfigSchemaValidator</c> refuses a workflow naming an absent
/// handler AT PUBLISH — while the operator is still at the screen. The rejection in
/// <c>SKNormalizerProcessor</c> is the backstop, not the primary defence. The source text is
/// <c>src/tests/BaseApi.Tests/Schemas/sknormalizer-config.json</c>.
/// </para>
/// <para>
/// <b>No default, and that is why the schema must REQUIRE it.</b>
/// <c>ConfigSchemaConformance</c> reads the presence of a default parameter value as the signal for
/// optionality — not nullability — so a positional parameter without one must appear in the schema's
/// <c>required</c> array or startup fails.
/// </para>
/// </summary>
public sealed record SKNormalizerConfig(string Handler) : ProcessorConfig;
```

- [ ] **Step 4: Write the processor**

`src/Processor.SKNormalizer/SKNormalizerProcessor.cs`:

```csharp
using System.Text.Json;
using BaseProcessor.Core.Configuration;
using BaseProcessor.Core.Processing;
using Microsoft.Extensions.Logging;

namespace Processor.SKNormalizer;

internal sealed class SKNormalizerProcessor(
    ILogger<SKNormalizerProcessor> logger,
    ProviderHandlerRegistry registry,
    NormalizationPipeline pipeline)
    : BaseProcessor<SKNormalizerConfig>
{
    protected override async Task ProcessAsync(
        byte[] data, SKNormalizerConfig? config, Guid executionId, CancellationToken ct)
    {
        // Config first: it is the cheapest check and it depends on nothing else.
        var handler = Resolve(config);
        var root = ReadDocument(data);

        NormalizationResult result;

        try
        {
            result = pipeline.Run(root, handler, ct);
        }
        catch (NormalizationException ex)
        {
            // A document this handler cannot standardize. Deterministic — it fails identically on
            // every redelivery — so it is a failed step, not something to park. No log here: the
            // framework writes this message verbatim when it catches the exception.
            //
            // ONE TYPE, NOT A LIST. Handlers and shared services wrap their own faults into
            // NormalizationException, exactly as the extractors and writers wrap theirs.
            //
            // Bare Exception is deliberately NOT caught: a NullReferenceException in a handler is a
            // programming error, and reporting it as a bad provider document buries a bug under a
            // plausible business failure.
            throw new FailedException($"normalizing {root.Metadata.Name} failed: {ex.Message}");
        }

        // The SHAPE of the result, never its content. Counts, a size and the handler name — an
        // author constant — are safe to log; item keys, field values and metadata are upstream data
        // and stay out of every template in this system.
        //
        // THE HANDLER NAME IS HERE BECAUSE THIS IS THE ONLY PLACE IT SURVIVES. The outbound envelope
        // says nothing about which handler ran, and a wrong-but-plausible handler produces a
        // SUCCESSFUL step — so without this line, nothing in the logs records which business was
        // applied to a document.
        var document = JsonSerializer.SerializeToUtf8Bytes(result.Document, FileDocument.Options);

        logger.LogInformation(
            "normalized {FileName} with {Handler} into {ItemCount} items, {ConvertedCount} converted, "
            + "{OutputBytes} bytes",
            root.Metadata.Name, handler.Name, result.ItemCount, result.ConvertedCount,
            document.LongLength);

        // ONE branch, on the execution id this dispatch arrived with. Not NewExecutionId(): this is
        // a transform, not a source, so the lineage it was handed is the lineage it continues.
        await SendToPostAsync(document, executionId, ct).ConfigureAwait(false);
    }

    private IProviderHandler Resolve(SKNormalizerConfig? config)
    {
        if (config is null)
        {
            throw BadPayload("SKNormalizer needs Handler");
        }

        if (string.IsNullOrWhiteSpace(config.Handler))
        {
            throw BadPayload("Handler is empty");
        }

        return registry.Find(config.Handler)
               ?? throw BadPayload(
                   $"no provider handler named '{config.Handler}'; this build carries "
                   + $"{string.Join(", ", registry.Names)}");
    }

    // THE TWO FAILURE CLASSES, AND NEITHER LOGS. ProcessDispatchHandler catches FailedException and
    // writes the author's message verbatim, so a line here would emit every failure twice. The
    // message text IS the contract an operator searches.
    private static FailedException BadPayload(string reason)
        => new($"step payload rejected: {reason}");

    private static FileNode ReadDocument(byte[] data)
    {
        FileNode? node;
        string reason;

        try
        {
            node = JsonSerializer.Deserialize<FileNode>(data, FileDocument.Options);

            // A successful parse can still hand back null: the bytes were valid JSON whose value was
            // literally `null`, or empty. A different fault than malformed JSON, so it gets its own
            // reason. Overwritten below if the node turns out non-null.
            reason = "the branch is empty";
        }
        catch (JsonException)
        {
            // Swallowed on purpose. The exception's text quotes the fragment that failed to parse,
            // and that fragment is upstream content -- it must not reach a log store. The class of
            // fault is what is reported; the ids in the open scope are how it is traced back.
            //
            // This also catches a document deeper than JsonSerializerOptions.MaxDepth, which is the
            // FIRST depth guard -- FileNodeConverter.Read recurses, so a pathologically deep
            // document must be refused before the assembler's own bound is reached.
            node = null;
            reason = "the branch is not JSON";
        }

        if (node is not null)
        {
            if (node.Metadata.Name is not { Length: > 0 })
            {
                // Caught here rather than one hop later, where the post handler reports Failed with
                // EntryId Guid.Empty, no payload and no name -- nothing an operator could act on.
                reason = "the root node carries no name";
            }
            else
            {
                return node;
            }
        }

        throw new FailedException($"input branch did not carry a file document: {reason}");
    }
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd C:/Users/UserL/source/repos/SK_P9/src
dotnet test tests/BaseApi.Tests/BaseApi.Tests.csproj --filter "FullyQualifiedName~ProcessorSKNormalizerTests"
```

Expected: 13 passed.

- [ ] **Step 6: Commit**

```bash
cd C:/Users/UserL/source/repos/SK_P9
git add src/Processor.SKNormalizer src/tests/BaseApi.Tests/SKNormalizer
git commit -m "feat(sknormalizer): the processor, its payload, and two failure classes that never log"
```

---

### Task 7: `SampleHandler`, the whitelist seam, and the host

**Files:**
- Create: `src/Processor.SKNormalizer/Handlers/SampleHandler.cs`
- Create: `src/Processor.SKNormalizer/Services/IFieldWhitelist.cs`
- Create: `src/Processor.SKNormalizer/Services/PassThroughFieldWhitelist.cs`
- Create: `src/Processor.SKNormalizer/Program.cs`
- Create: `src/Processor.SKNormalizer/ProcessorHost.cs`
- Test: `src/tests/BaseApi.Tests/DependencyInjection/SKNormalizerHostTests.cs`

**Interfaces:**
- Consumes: everything above.
- Produces: `public sealed class SampleHandler : ProviderHandlerBase` with `Name => "Sample"`; `public interface IFieldWhitelist { bool Allows(string field); }`; `public static class ProcessorHost` with `StartAsync(string[], CancellationToken, Action<IConfigurationBuilder>?, IIdentityBootstrap?)` and `Create(string[], ProcessorIdentityFound, Action<IConfigurationBuilder>?)`.

- [ ] **Step 1: Write the failing host test**

Create `src/tests/BaseApi.Tests/DependencyInjection/SKNormalizerHostTests.cs`:

```csharp
using Messaging.Contracts;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Processor.SKNormalizer;
using Xunit;

namespace BaseApi.Tests.DependencyInjection;

public sealed class SKNormalizerHostTests
{
    private static readonly ProcessorIdentityFound Identity = new(
        Guid.Parse("77777777-7777-7777-7777-777777777777"),
        InputSchemaId: null, OutputSchemaId: null, ConfigSchemaId: null,
        Name: "sk-normalizer", Version: "1.0.0");

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
    public void TheServiceGraphResolves()
    {
        using var host = Build();

        var processor = host.Services
            .GetRequiredService<BaseProcessor.Core.Processing.BaseProcessor>();

        Assert.IsType<SKNormalizerProcessor>(processor);
    }

    [Fact]
    public void EveryRegisteredHandlerReachesTheRegistry()
    {
        using var host = Build();

        var registry = host.Services.GetRequiredService<ProviderHandlerRegistry>();

        Assert.Equal(["Sample"], registry.Names);
    }

    [Fact]
    public void TheWhitelistIsRegisteredAsAPassThrough()
    {
        // The seam for the deferred Redis whitelist. Registered now so turning it on later is a
        // registration swap rather than a reshaping of stages 3 and 4.
        using var host = Build();

        Assert.True(host.Services.GetRequiredService<IFieldWhitelist>().Allows("anything"));
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd C:/Users/UserL/source/repos/SK_P9/src
dotnet test tests/BaseApi.Tests/BaseApi.Tests.csproj --filter "FullyQualifiedName~SKNormalizerHostTests"
```

Expected: FAIL — `ProcessorHost` does not exist.

- [ ] **Step 3: Write `SampleHandler` and the whitelist seam**

`src/Processor.SKNormalizer/Handlers/SampleHandler.cs`:

```csharp
namespace Processor.SKNormalizer;

/// <summary>
/// Identity. It locates every entry, produces no metadata and no conversion, and takes the mirror
/// layout — so the document that leaves is the document that arrived.
/// <para>
/// <b>Not a placeholder.</b> It exercises everything structural in one dispatch: payload validation,
/// the config schema enum, registry resolution, the envelope read, all eight stages in order, the
/// assembler's legality rules, serialization through FileNodeConverter, and the send on the inbound
/// executionId. The only things it does not touch are XmlMetadataRenderer and FfmpegAudioTranscoder,
/// which are pure provider business.
/// </para>
/// <para>
/// <b>It stays shipped after real handlers arrive.</b> It is the regression test for the pipeline
/// itself: any change to the stages, the assembler or the serialization that breaks byte identity
/// breaks this first, with nothing provider-specific in the way to obscure it.
/// </para>
/// <para>
/// <b>Stateless, as every handler must be.</b> Registered as a singleton beside a singleton
/// processor; per-dispatch state lives in the pipeline's locals.
/// </para>
/// </summary>
public sealed class SampleHandler : ProviderHandlerBase
{
    /// <summary>
    /// Must match an entry in the <c>handler</c> enum of
    /// <c>src/tests/BaseApi.Tests/Schemas/sknormalizer-config.json</c>.
    /// <c>SKNormalizerConfigSchemaTests</c> is what enforces that.
    /// </summary>
    public override string Name => "Sample";

    public override IReadOnlyList<SourceItem> Locate(FileNode root)
    {
        ArgumentNullException.ThrowIfNull(root);

        // One item per top-level entry, or the root itself when it is a plain file. The key is the
        // node name, which is what a failure message would carry.
        return root.Content is FileContent.Entries entries
            ? entries.Value.Select(e => new SourceItem(e.Metadata.Name, [e])).ToList()
            : [new SourceItem(root.Metadata.Name, [root])];
    }

    // Everything else takes the base default: no content objection, empty metadata, no augmentation,
    // no profile, no reconciliation, and the topology-preserving mirror. Empty metadata means
    // RenderMetadata returns null and the mirror carries every leaf through unchanged — which is
    // identity, by construction rather than by special case.
}
```

`src/Processor.SKNormalizer/Services/IFieldWhitelist.cs`:

```csharp
namespace Processor.SKNormalizer;

/// <summary>
/// The seam for the deferred Redis-backed metadata field whitelist. A handler that needs to know
/// whether a field may be carried into the standardized document asks this.
/// <para>
/// <b>Registered now as a pass-through, with no handler consuming it yet</b>, so that backing it
/// with Redis later is a registration swap rather than a reshaping of stages 3 and 4.
/// </para>
/// </summary>
public interface IFieldWhitelist
{
    bool Allows(string field);
}
```

`src/Processor.SKNormalizer/Services/PassThroughFieldWhitelist.cs`:

```csharp
namespace Processor.SKNormalizer;

/// <summary>Admits everything. Replaced when the whitelist's backing store is designed.</summary>
public sealed class PassThroughFieldWhitelist : IFieldWhitelist
{
    public bool Allows(string field) => true;
}
```

- [ ] **Step 4: Write `Program.cs`**

Copy the expander's verbatim — the comments explain why both signals are registered — changing only the `using`:

```csharp
using System.Runtime.InteropServices;
using Microsoft.Extensions.Hosting;
using Processor.SKNormalizer;

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

- [ ] **Step 5: Write `ProcessorHost.cs`**

Start from the expander's file — the boot half is identical and its comments are load-bearing:

```bash
cd C:/Users/UserL/source/repos/SK_P9
cp src/Processor.ArchiveExpander/ProcessorHost.cs src/Processor.SKNormalizer/ProcessorHost.cs
sed -i 's/namespace Processor.ArchiveExpander;/namespace Processor.SKNormalizer;/' src/Processor.SKNormalizer/ProcessorHost.cs
sed -i '/using Processor.ArchiveExpander.Extractors;/d' src/Processor.SKNormalizer/ProcessorHost.cs
```

Then replace the registration block — everything from the `Configure<ArchiveExpanderOptions>` call to the `AddSingleton<...BaseProcessor, ArchiveExpanderProcessor>()` line — with:

```csharp
        // The pod's ffmpeg path and conversion timeout, from SKNormalizer__* in the manifest. Both
        // are numbers an operator sizes against a container limit; a workflow author cannot know
        // them. There is deliberately no size ceiling — see SKNormalizerOptions.
        builder.Services.Configure<SKNormalizerOptions>(
            builder.Configuration.GetSection("SKNormalizer"));

        // ONE REGISTRATION PER PROVIDER, exactly as ArchiveExpander registers one extractor per
        // format. The registry takes them all and throws at startup on a duplicate name.
        //
        // ADDING A LINE HERE IS NOT THE WHOLE JOB: the handler's name must also be added to the
        // `handler` enum in src/tests/BaseApi.Tests/Schemas/sknormalizer-config.json, a new config
        // schema row must be POSTed from that file, and the processor's ConfigSchemaId repointed.
        // SKNormalizerConfigSchemaTests fails the build if the first of those is forgotten.
        builder.Services.AddSingleton<IProviderHandler, SampleHandler>();
        builder.Services.AddSingleton<ProviderHandlerRegistry>();

        // The shared machinery. A handler describes; these execute.
        builder.Services.AddSingleton<ITreeAssembler, TreeAssembler>();
        builder.Services.AddSingleton<IMetadataRenderer, XmlMetadataRenderer>();
        builder.Services.AddSingleton<IAudioTranscoder, FfmpegAudioTranscoder>();
        builder.Services.AddSingleton<IFieldWhitelist, PassThroughFieldWhitelist>();
        builder.Services.AddSingleton<NormalizationPipeline>();

        // The concrete processor the pre/post handlers resolve as BaseProcessor. Singleton, matching
        // the seam's design: per-dispatch state lives in a plain field on this one instance, which is
        // safe only because prefetch is 1 — and which is why every handler must be stateless too.
        builder.Services.AddSingleton<BaseProcessor.Core.Processing.BaseProcessor, SKNormalizerProcessor>();
```

- [ ] **Step 6: Run the host test to verify it passes**

```bash
cd C:/Users/UserL/source/repos/SK_P9/src
dotnet test tests/BaseApi.Tests/BaseApi.Tests.csproj --filter "FullyQualifiedName~SKNormalizerHostTests"
```

Expected: 3 passed. If `TheServiceGraphResolves` fails on constructibility, a registration is missing above — Development mode validates the whole graph without instantiating anything.

- [ ] **Step 7: Commit**

```bash
cd C:/Users/UserL/source/repos/SK_P9
git add src/Processor.SKNormalizer src/tests/BaseApi.Tests/DependencyInjection
git commit -m "feat(sknormalizer): the identity handler, the whitelist seam, and the host"
```

---

### Task 8: The config schema and its agreement with the registry

**Files:**
- Create: `src/tests/BaseApi.Tests/Schemas/sknormalizer-config.json`
- Modify: `src/tests/BaseApi.Tests/Schemas/README.md`
- Test: `src/tests/BaseApi.Tests/SKNormalizer/SKNormalizerConfigSchemaTests.cs`

**Interfaces:**
- Consumes: `SKNormalizerConfig`, `ProviderHandlerRegistry`, `SampleHandler`.
- Produces: nothing consumed by later tasks; this is a gate.

- [ ] **Step 1: Write the failing test**

Create `src/tests/BaseApi.Tests/SKNormalizer/SKNormalizerConfigSchemaTests.cs`:

```csharp
using System.Text;
using System.Text.Json;
using BaseProcessor.Core.Startup;
using BaseProcessor.Core.Validation;
using Processor.SKNormalizer;
using Xunit;

namespace BaseApi.Tests.SKNormalizer;

public sealed class SKNormalizerConfigSchemaTests
{
    private static string Definition()
        => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Schemas", "sknormalizer-config.json"));

    private static IReadOnlyList<string> EnumNames()
        => JsonDocument.Parse(Definition())
            .RootElement
            .GetProperty("properties")
            .GetProperty("handler")
            .GetProperty("enum")
            .EnumerateArray()
            .Select(e => e.GetString()!)
            .ToList();

    /// <summary>Every handler this build registers, resolved the way ProcessorHost registers them.</summary>
    private static IReadOnlyList<string> Registered()
        => new ProviderHandlerRegistry([new SampleHandler()]).Names;

    [Fact]
    public void TheEnumAndTheRegistryAreTheSameSet()
    {
        // THE CHECK THAT CANNOT BE A STARTUP HOOK. ProcessorStartupOrchestrator hands the config
        // definition to ConfigSchemaConformance.Check and never stores it, and ConfigSchemaConformance
        // does not read enum values — so there is no runtime seam without amending
        // BaseProcessor.Core. This test is the whole defence against adding a handler and forgetting
        // the enum, which is the realistic drift.
        Assert.Equal(Registered().Order().ToArray(), EnumNames().Order().ToArray());
    }

    [Fact]
    public void TheSchemaDescribesTheConfigRecord()
    {
        // The same check ProcessorStartupOrchestrator runs at startup, run here so a mismatch fails
        // the build rather than leaving a replica published UNHEALTHY. camelCase is pinned: the
        // binder is case-insensitive but a JSON Schema property name is not, so only one of
        // {"Handler":...} and {"handler":...} would validate.
        var problems = ConfigSchemaConformance.Check(typeof(SKNormalizerConfig), Definition());

        Assert.Empty(problems);
    }

    [Fact]
    public void APayloadNamingAKnownHandlerValidates()
    {
        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(), Encoding.UTF8.GetBytes("""{"handler":"Sample"}"""), out var errors);

        Assert.True(ok, string.Join("; ", errors));
    }

    [Fact]
    public void APayloadNamingAnAbsentHandlerIsRejected()
    {
        // THE PUBLISH-TIME REJECTION, which is the whole point of the enum:
        // PayloadConfigSchemaValidator runs this in BaseApi's OrchestrationService, so an operator
        // naming a handler that does not exist is refused while they are still at the screen.
        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(), Encoding.UTF8.GetBytes("""{"handler":"NotHere"}"""), out _);

        Assert.False(ok);
    }

    [Fact]
    public void APayloadWithNoHandlerIsRejected()
    {
        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(), Encoding.UTF8.GetBytes("{}"), out _);

        Assert.False(ok);
    }

    [Fact]
    public void APascalCasePayloadIsRejected()
    {
        // The drift this pinning exists to catch. ProcessorConfig.SerializerOptions binds
        // case-insensitively, so {"Handler":"Sample"} would reach the record — but a JSON Schema
        // property name is case-sensitive, so it must not validate.
        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(), Encoding.UTF8.GetBytes("""{"Handler":"Sample"}"""), out _);

        Assert.False(ok);
    }
}
```

> `ConfigSchemaConformance` is `internal` to `BaseProcessor.Core` and lives in the `BaseProcessor.Core.Startup` namespace. It is reachable from this test assembly: `BaseProcessor.Core.csproj:14` carries `<InternalsVisibleTo Include="BaseApi.Tests" />` — verified during pre-flight, so call it directly and add no `InternalsVisibleTo` anywhere.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd C:/Users/UserL/source/repos/SK_P9/src
dotnet test tests/BaseApi.Tests/BaseApi.Tests.csproj --filter "FullyQualifiedName~SKNormalizerConfigSchemaTests"
```

Expected: FAIL — the schema file does not exist.

- [ ] **Step 3: Write the schema**

`src/tests/BaseApi.Tests/Schemas/sknormalizer-config.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "SKNormalizer step payload",
  "type": "object",
  "properties": {
    "handler": {
      "type": "string",
      "description": "The provider handler to apply. One of the names this processor version carries.",
      "enum": ["Sample"]
    }
  },
  "required": ["handler"],
  "additionalProperties": false
}
```

- [ ] **Step 4: Document it in the schemas README**

Append to `src/tests/BaseApi.Tests/Schemas/README.md`:

```markdown
## `sknormalizer-config.json` — a CONFIG schema, not a data shape

The other files here describe documents on the wire. This one describes a **step payload**, and it is
the only file in this folder whose content must be kept in step with **code**: the `handler` enum must
name exactly the `IProviderHandler` implementations `Processor.SKNormalizer` registers.

That is what makes `PayloadConfigSchemaValidator` refuse, **at publish**, a workflow naming a handler
that does not exist. Nothing enforces the agreement at runtime — `ConfigSchemaConformance` does not
read enum values and the framework exposes no hook — so
`SKNormalizer/SKNormalizerConfigSchemaTests.TheEnumAndTheRegistryAreTheSameSet` is the whole defence.

**Adding a provider handler therefore means:** register it in `ProcessorHost.Create`, add its name
here, POST a **new** config schema row from this file (a referenced row's definition is frozen),
repoint the processor's `ConfigSchemaId`, and restart.
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd C:/Users/UserL/source/repos/SK_P9/src
dotnet test tests/BaseApi.Tests/BaseApi.Tests.csproj --filter "FullyQualifiedName~SKNormalizerConfigSchemaTests"
```

Expected: 6 passed.

- [ ] **Step 6: Commit**

```bash
cd C:/Users/UserL/source/repos/SK_P9
git add src/tests/BaseApi.Tests/Schemas src/tests/BaseApi.Tests/SKNormalizer
git commit -m "feat(sknormalizer): the config schema enum and the test that keeps it honest"
```

---

### Task 9: The identity chain — the acceptance test

This is what proves the seam. `EnvelopeContractTests` already drives FileFetcher → ArchiveExpander → ArchiveCollapser with a helper per hop; the normalizer slots into the middle of the chain that file already tests. **Add to that file — do not build a second set of helpers.**

**Files:**
- Modify: `src/tests/BaseApi.Tests/EnvelopeContractTests.cs`

**Interfaces:**
- Consumes: `SKNormalizerProcessor`, `SampleHandler`, `ProviderHandlerRegistry`, `NormalizationPipeline`, `TreeAssembler`, `XmlMetadataRenderer`, `ExplodingTranscoder`; and the existing `Fetch`, `Expand`, `Collapse`, `Zip`, `NestedZip`, `ContentOf`, `TreeSchema`, `AnyFile` members of `EnvelopeContractTests`.
- Produces: nothing.

- [ ] **Step 1: Add the aliased usings**

`EnvelopeContractTests.cs` aliases the collapser's types rather than importing that namespace, because `Processor.ArchiveCollapser` declares its own `FileNode`/`FileContent`/`FileDocument`. `Processor.SKNormalizer` declares a third copy, so it needs the same treatment. Add beside the existing `ArchiveBuilder` / `ArchiveCollapserProcessor` aliases:

```csharp
// Aliased for the reason the collapser's types are: Processor.SKNormalizer declares its own
// FileNode/FileContent/FileDocument -- a deliberate duplicate -- and a blanket import would make
// every existing unqualified use of those names in this file ambiguous.
using SKNormalizerProcessor = Processor.SKNormalizer.SKNormalizerProcessor;
using ProviderHandlerRegistry = Processor.SKNormalizer.ProviderHandlerRegistry;
using SampleHandler = Processor.SKNormalizer.SampleHandler;
using NormalizationPipeline = Processor.SKNormalizer.NormalizationPipeline;
using TreeAssembler = Processor.SKNormalizer.TreeAssembler;
using XmlMetadataRenderer = Processor.SKNormalizer.XmlMetadataRenderer;
```

`BaseApi.Tests.Support` is already imported by this file, which is where `ExplodingTranscoder` lives.

- [ ] **Step 2: Add the `Normalize` helper**

Place it immediately after the existing `Expand` method, matching its shape exactly:

```csharp
    /// <summary>
    /// The third hop. Runs the real processor with the identity handler -- the one that returns the
    /// input tree unchanged -- so what this adds to the chain is a pass-through, and any difference
    /// it introduces is a defect rather than a design choice.
    /// </summary>
    private static async Task<byte[]> Normalize(byte[] document)
    {
        var sender = Substitute.For<IQueueSender>();
        var sends = new List<ProcessedData>();
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(sends.Add),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());

        var normalizer = new SKNormalizerProcessor(
            new RecordingLogger<SKNormalizerProcessor>(),
            new ProviderHandlerRegistry([new SampleHandler()]),
            // Exploding, not a substitute: IAudioTranscoder is internal and cannot be proxied by
            // NSubstitute, and it must never be called here -- SampleHandler's ProfileFor returns
            // null for every item, which is what makes it identity. If this throws, it stopped being
            // one.
            new NormalizationPipeline(
                new TreeAssembler(), new XmlMetadataRenderer(), new ExplodingTranscoder()));

        normalizer.BeginDispatch(new BaseProcessor.Core.Processing.DispatchState(sender, C, W, S, P));

        await normalizer.ExecuteAsync(
            document, """{"handler":"Sample"}""", E, CancellationToken.None);

        return Assert.Single(sends).Data;
    }
```

- [ ] **Step 3: Write the failing tests**

Append these to `EnvelopeContractTests`:

```csharp
    [Fact]
    public async Task TheIdentityHandlerLeavesTheDocumentByteIdentical()
    {
        // THE NARROW CLAIM, checked before the wide one. If this fails, the chain test below fails
        // too and it is far harder to say why.
        var envelope = await Fetch("orders.zip", Zip(("a.csv", "id"), ("b.csv", "id,name")), AnyFile);
        var document = await Expand(envelope, """{"MaxDepth":1}""");

        Assert.Equal(document, await Normalize(document));
    }

    [Fact]
    public async Task ANestedDocumentSurvivesTheMirror()
    {
        // Depth 2 exercises the mirror's recursion and the assembler's Folder path, which the flat
        // case never touches. NestedZip is the fixture this file already uses for nesting.
        var envelope = await Fetch("orders.zip", NestedZip(), AnyFile);
        var document = await Expand(envelope, """{"MaxDepth":2}""");

        Assert.Equal(document, await Normalize(document));
    }

    [Fact]
    public async Task TheChainStillRoundTripsWithTheNormalizerInserted()
    {
        // THE ACCEPTANCE TEST FOR THIS PROCESSOR. A schema asserts a document has the right shape;
        // identity asserts it round-tripped losslessly, which is the stronger statement -- and it is
        // what catches a TreeAssembler rule drifting away from ArchiveBuilder.
        //
        // The source is a .zip DELIBERATELY. A rar-sourced document cannot round-trip
        // byte-identically -- ArchiveExpander reads rar and ArchiveCollapser cannot write it, because
        // RarLab's unrar licence permits decompression only -- so using one would fail this test for
        // a reason that is not this processor's doing.
        //
        // COMPARED AGAINST COLLAPSE-WITHOUT, not against the original archive: the collapser rebuilds
        // the zip, so its bytes need not equal the input's. What must hold is that inserting this
        // processor changes nothing, and that is exactly what this compares.
        var envelope = await Fetch("orders.zip", Zip(("a.csv", "id"), ("b.csv", "id,name")), AnyFile);
        var document = await Expand(envelope, """{"MaxDepth":1}""");

        var withNormalizer = await Collapse(await Normalize(document));
        var without = await Collapse(document);

        Assert.Equal(ContentOf(without), ContentOf(withNormalizer));
    }

    [Fact]
    public async Task WhatTheNormalizerSendsSatisfiesTheTreeSchema()
    {
        // Its output schema IS the tree row -- the same one the expander writes and the collapser
        // reads -- so this is the check that the reused row actually admits what this processor
        // emits. See the design's section 1.2.
        var envelope = await Fetch("orders.zip", Zip(("a.csv", "id")), AnyFile);
        var normalized = await Normalize(await Expand(envelope, """{"MaxDepth":1}"""));

        Assert.True(
            ProcessorJsonSchemaValidator.TryValidate(TreeSchema(), normalized, out var errors),
            string.Join("; ", errors));
    }
```

- [ ] **Step 4: Run to verify they fail**

```bash
cd C:/Users/UserL/source/repos/SK_P9/src
dotnet test tests/BaseApi.Tests/BaseApi.Tests.csproj --filter "FullyQualifiedName~EnvelopeContractTests"
```

Expected: a compile failure until Steps 1-2 are in, then the four new tests fail.

- [ ] **Step 5: Run to verify they pass**

Same command. Expected: every test already in the file still passes, plus 4 new.

> **If `TheChainStillRoundTripsWithTheNormalizerInserted` fails while `TheIdentityHandlerLeavesTheDocumentByteIdentical` passes**, something between the normalizer's output and the collapser differs even though the document did not — look at the assembler, not the handler.
>
> **If `WhatTheNormalizerSendsSatisfiesTheTreeSchema` fails**, the reused tree row does not admit what the assembler emitted — the design's section 1.2 constraint, and a real finding rather than a test to relax.

- [ ] **Step 6: Commit**

```bash
cd C:/Users/UserL/source/repos/SK_P9
git add src/tests/BaseApi.Tests/EnvelopeContractTests.cs
git commit -m "test(sknormalizer): the identity chain, which is this phase's acceptance test"
```

---

### Task 10: Dockerfile, manifest, and the expander's sizing note

**Files:**
- Create: `src/Processor.SKNormalizer/Dockerfile`
- Create: `k8s/41-processor-sknormalizer.yaml`
- Modify: `k8s/kustomization.yaml`
- Modify: `k8s/37-processor-archiveexpander.yaml` (a comment beside `MaxExpandedBytes`)

**Interfaces:**
- Consumes: the built project.
- Produces: a deployable image and manifest.

- [ ] **Step 1: Write the Dockerfile**

Start from the collapser's and add ffmpeg to the runtime stage:

```bash
cd C:/Users/UserL/source/repos/SK_P9
cp src/Processor.ArchiveCollapser/Dockerfile src/Processor.SKNormalizer/Dockerfile
sed -i 's/Processor\.ArchiveCollapser/Processor.SKNormalizer/g' src/Processor.SKNormalizer/Dockerfile
sed -i 's/processor-archivecollapser/processor-sknormalizer/g' src/Processor.SKNormalizer/Dockerfile
```

Then, in the runtime stage, insert this **before** the `USER app` line:

```dockerfile
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
```

- [ ] **Step 2: Verify the image builds and ffmpeg is present**

```bash
cd C:/Users/UserL/source/repos/SK_P9
docker build -f src/Processor.SKNormalizer/Dockerfile -t processor-sknormalizer:local .
docker run --rm --entrypoint ffmpeg processor-sknormalizer:local -version
```

Expected: a version banner. If the build fails at `dotnet restore` with NU1301, a feed folder is missing from the `COPY` list — all five are copied whether or not this image consumes them, because NuGet validates every source in `NuGet.config`.

- [ ] **Step 3: Write the manifest**

Start from the collapser's, which already carries the correct probe and env shape:

```bash
cd C:/Users/UserL/source/repos/SK_P9
cp k8s/39-processor-archivecollapser.yaml k8s/41-processor-sknormalizer.yaml
sed -i 's/processor-archivecollapser/processor-sknormalizer/g' k8s/41-processor-sknormalizer.yaml
```

Replace the header comment block (everything above `apiVersion:`) with:

```yaml
# processor-sknormalizer — applies one provider handler, named on the step payload, to the
# {metadata, content} tree ArchiveExpander produces, and emits a tree of the same contract. A
# downstream transform: it has an input and it produces output, so it is neither an importer nor an
# exporter. No Service — its only inbound traffic is the kubelet hitting the pod IP for probes.
#
# EXPECT IT TO SIT NOT-READY UNTIL A PROCESSOR ROW EXISTS, exactly as the other processors do.
# `kubectl rollout status` will time out; that timeout is the expected signal, not a fault.
#
# THE MEMORY LIMIT IS 768Mi TO MATCH THE PAIR EITHER SIDE, AND THE ARGUMENT IS THE CONTRACT. This
# processor's input schema IS ArchiveExpander's output schema, so whatever that pod may legally emit,
# this one is obliged to hold — and it holds MORE than the collapser does, because a conversion's
# source and its output are both resident while ffmpeg runs. Sizing it lower means a document the
# upstream pod may legally emit is one this pod cannot receive, and that failure is an OOM, which is a
# POISON MESSAGE and not a failed step: the author never returns, the input key is never reclaimed,
# RabbitMQ requeues the unacked dispatch, and the replacement pod dies the same way. Raise
# ArchiveExpander's limit and you must raise this one.
#
# THERE IS NO SIZE CEILING ENV VAR HERE, DELIBERATELY. ArchiveExpander__MaxExpandedBytes already
# bounds the document that reaches this pod, and a second ceiling here would restate an upstream
# guarantee with a second number to keep consistent. What that means in practice: MaxExpandedBytes
# sizes TWO consumers now, and conversion can GROW data — transcoding to a less compressed target
# produces more bytes than it consumed. Nothing bounds output size. Size MaxExpandedBytes with
# conversion headroom.
#
# ffmpeg IS IN THIS IMAGE AND IN NO OTHER. If every item fails conversion on a first deploy, check
# that before checking the data.
```

Then, inside `env:`, add after `ConsoleHealth__Port`:

```yaml
            # Resolved from PATH; the image installs it. Set this only to point at a build that is
            # not on PATH.
            - name: SKNormalizer__FfmpegPath
              value: "ffmpeg"
            # Per conversion, not per dispatch. A wedged ffmpeg holds the one prefetched message
            # forever, so this is what turns a hang into a failed step.
            - name: SKNormalizer__ConversionTimeoutSeconds
              value: "300"
```

- [ ] **Step 4: Add it to the kustomization**

In `k8s/kustomization.yaml`, add `41-processor-sknormalizer.yaml` to the resources list, after `40-processor-filepersister.yaml`.

- [ ] **Step 5: Add the sizing note to the expander's manifest**

Find the `ArchiveExpander__MaxExpandedBytes` env entry in `k8s/37-processor-archiveexpander.yaml` and add above it:

```yaml
            # THIS NUMBER NOW SIZES THREE PODS, NOT ONE. It bounds what this pod produces, what
            # ArchiveCollapser must hold, and — since 2026-09-12 — the working set every conversion
            # in SKNormalizer operates on. SKNormalizer deliberately carries no ceiling of its own,
            # so conversion headroom has to be priced in here. Conversion can GROW data.
```

- [ ] **Step 6: Verify the manifests parse**

```bash
cd C:/Users/UserL/source/repos/SK_P9
kubectl kustomize k8s > /dev/null && echo "kustomize ok"
```

Expected: `kustomize ok`. This renders only; it applies nothing.

- [ ] **Step 7: Commit**

```bash
cd C:/Users/UserL/source/repos/SK_P9
git add src/Processor.SKNormalizer/Dockerfile k8s
git commit -m "feat(sknormalizer): image with ffmpeg, manifest, and the expander's new sizing duty"
```

---

## After the plan

**Not covered here, and deliberately:**

- **Registration.** Creating the processor row, pointing `InputSchemaId`/`OutputSchemaId` at the existing tree row and `ConfigSchemaId` at a row POSTed from `sknormalizer-config.json`, then wiring a workflow step. That is an operator act against a running BaseApi, not a code change, and it needs the deployed image's `SourceHash` in hand.
- **Deploying.** `kind load` and the SourceHash repoint, per the repo's usual loop.
- **Any real provider handler.** `SampleHandler` is the only one. The first real one is what will test whether the eight stages fit; the design's §5.2 records the most likely place they will not.

**Run the full suite before calling the plan done:**

```bash
cd C:/Users/UserL/source/repos/SK_P9/src
dotnet test tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Read the **shape** of the result — 0 failed, exit 0, skips confined to `Live/` — not a remembered total. The `--filter "Category!=RealStack"` form is silently ignored by this runner, so the full suite is what runs either way; the one RealStack test added here (`ARealConversionProducesBytesAndAProbedDuration`) passes only where ffmpeg is installed locally.
