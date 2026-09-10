# Processor.ArchiveCollapser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `Processor.ArchiveCollapser`, the inverse of `Processor.ArchiveExpander` — it takes the `{metadata, content}` document the expander produces and packs it back into a real archive, emitting the flat raw-file envelope the expander consumes.

**Architecture:** A plain downstream transform on `BaseProcessor<TConfig>` — not an edge, so neither `BaseImporter` nor `BaseExporter` applies, and the `executionId` it is dispatched with is passed through unchanged. Selection of the archive writer is by the node's **declared extension** (there are no bytes to sniff on the way out), the step payload holds **nothing** (the document is the source of truth for depth), and there is **no byte ceiling** (the size is the document, already resident before `ProcessAsync` is entered).

**Tech Stack:** .NET 8, xunit.v3, NSubstitute, `System.IO.Compression` (zip) and `System.Formats.Tar` (tar) — both in-box. **No `SharpCompress`**: it is in the expander for RAR alone, and RAR cannot be written.

**Spec:** `docs/superpowers/specs/2026-09-10-archive-collapser-design.md`

## Global Constraints

- **Target framework `net8.0`**, `Nullable` and `ImplicitUsings` enabled, `TreatWarningsAsErrors` on — all from `Directory.Build.props`. **Never declare these in a csproj.**
- **Package versions come from `Directory.Packages.props`.** Never put a `Version` on a `PackageReference`; use `VersionOverride="[1.0.0]"` only where the existing processors do.
- **`BaseProcessor.Core` is referenced as a PACKAGE, never a `ProjectReference`** — `SourceHash.targets` ships in the package's `build/` folder and only a package flows build targets. A `ProjectReference` silently produces an assembly with no source hash, and the processor can then never match its database row.
- **Serializer options for any document or envelope:** `PropertyNamingPolicy = JsonNamingPolicy.CamelCase`, `DefaultIgnoreCondition = JsonIgnoreCondition.Never`. Never `ProcessorConfig.SerializerOptions` (that is for step payloads and emits PascalCase).
- **Never log upstream content.** Log the shape of a result — counts, sizes, depths — never bytes, never a JSON fragment, never an exception message from `JsonSerializer`.
- **Failure messages are the contract an operator searches.** Do not add a `logger` call beside a `throw new FailedException(...)`: `ProcessDispatchHandler` writes the message verbatim, so a log line there emits every failure twice.
- **Phase 1 ships with every schema id null in the database.** Nothing validates. See Task 10 for the two existing live tests that must be gated because of this.
- **Test runner:** `dotnet test` reports counts without names. On a failure, run `src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe` directly to find out which test failed. The `--filter "Category!=RealStack"` argument is silently ignored under MTP — every run is the full suite.

---

# PHASE 1 — prove the loop with schemas null

## Task 1: Relocate the schema files out of `src/`

No processor can read a schema file — verified: the only file reads in any processor or in `BaseProcessor.Core` are `appsettings.json` per `ProcessorHost` and `File.ReadAllBytes` in `FileFetcherProcessor.cs:169`. Validation is database-driven via `ProcessorStartupOrchestrator` Loop B. So these files are deploy artifacts sitting in runtime images, and they move to the test project as **one file per shape**.

This task changes no behaviour. The full suite must be green before and after.

**Files:**
- Create: `src/tests/BaseApi.Tests/Schemas/envelope.json`
- Create: `src/tests/BaseApi.Tests/Schemas/tree.json`
- Create: `src/tests/BaseApi.Tests/Schemas/README.md` (moved from `src/Processor.ArchiveExpander/schema/README.md`)
- Delete: `src/Processor.FileFetcher/schema/` (whole folder), `src/Processor.ArchiveExpander/schema/` (whole folder)
- Modify: `src/Processor.FileFetcher/Processor.FileFetcher.csproj` — remove the schema `<Content Include>` entry
- Modify: `src/Processor.ArchiveExpander/Processor.ArchiveExpander.csproj` — remove both schema `<Content Include>` entries
- Modify: `src/tests/BaseApi.Tests/BaseApi.Tests.csproj:71-82` — replace three `<None Include ... Link>` entries with one `<Content Include="Schemas\*.json">`
- Modify: `src/tests/BaseApi.Tests/ArchiveExpander/ArchiveExpanderSchemaTests.cs` — `Definition()` reads the new path
- Modify: `src/tests/BaseApi.Tests/EnvelopeContractTests.cs` — reader helpers, and delete one test

**Interfaces:**
- Produces: two test-readable paths, `Schemas/envelope.json` and `Schemas/tree.json`, resolved as `Path.Combine(AppContext.BaseDirectory, "Schemas", "<name>.json")`. Every later task reads them this way.

- [ ] **Step 1: Move the files**

```bash
cd C:/Users/UserL/source/repos/SK_P9
mkdir -p src/tests/BaseApi.Tests/Schemas
git mv src/Processor.ArchiveExpander/schema/output.json src/tests/BaseApi.Tests/Schemas/tree.json
git mv src/Processor.ArchiveExpander/schema/input.json  src/tests/BaseApi.Tests/Schemas/envelope.json
git mv src/Processor.ArchiveExpander/schema/README.md   src/tests/BaseApi.Tests/Schemas/README.md
git rm -r src/Processor.FileFetcher/schema
```

`envelope.json` comes from the expander's `input.json` rather than the fetcher's `output.json` because the two are already byte-identical (asserted today by `TheFetcherOutputSchemaAndTheExpanderInputSchemaAreByteIdentical`) — either is correct; picking one deterministically avoids a coin flip.

- [ ] **Step 2: Strip the schema entries from both processor csprojs**

In `src/Processor.ArchiveExpander/Processor.ArchiveExpander.csproj`, delete both `<Content Include="schema\...">` lines **and their comments**. Leave the `appsettings.json` line. The `<ItemGroup>` becomes:

```xml
  <ItemGroup>
    <!-- The worker SDK does not copy appsettings.json on its own. -->
    <Content Include="appsettings.json" CopyToOutputDirectory="PreserveNewest" />
  </ItemGroup>
```

Do the same in `src/Processor.FileFetcher/Processor.FileFetcher.csproj`.

- [ ] **Step 3: Point the test project at the new folder**

In `src/tests/BaseApi.Tests/BaseApi.Tests.csproj`, replace the three `<None Include="..\..\Processor...">` entries at lines 71-82 (and their comments) with:

```xml
    <!-- The schema definitions, one file per SHAPE rather than one per processor. No processor
         ships these any more: nothing in src/ can read a schema file, and validation is driven by
         database rows resolved over the broker. They live here because the tests are their only
         reader, and they are the source text POSTed when the rows are registered. -->
    <Content Include="Schemas\*.json" CopyToOutputDirectory="PreserveNewest" />
```

- [ ] **Step 4: Update `ArchiveExpanderSchemaTests.Definition()`**

```csharp
    private static string Definition()
        => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Schemas", "tree.json"));
```

- [ ] **Step 5: Update `EnvelopeContractTests` readers and delete the identity test**

Replace the two reader helpers with:

```csharp
    private static string EnvelopeSchema()
        => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Schemas", "envelope.json"));

    private static string TreeSchema()
        => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Schemas", "tree.json"));
```

In `WhatTheFetcherSendsSatisfiesBothRegisteredSchemas`, both `TryValidate` calls now take `EnvelopeSchema()`. That makes the two assertions identical, so collapse the test to a single assertion and rename it:

```csharp
    [Fact]
    public async Task WhatTheFetcherSendsSatisfiesTheEnvelopeSchema()
    {
        var envelope = await Fetch("orders.csv", Encoding.UTF8.GetBytes("id,name"), AnyFile);

        Assert.True(
            ProcessorJsonSchemaValidator.TryValidate(EnvelopeSchema(), envelope, out var errors),
            string.Join("; ", errors));
    }
```

In `AnArchiveSurvivesBothHopsAndTheDocumentValidates`, replace the inline `File.ReadAllText(... "schema", "output.json")` with `TreeSchema()`.

**Delete `TheFetcherOutputSchemaAndTheExpanderInputSchemaAreByteIdentical` entirely.** It exists because one contract lived in two projects that could not reference each other and nothing but a test could pin them. With one file per shape there is nothing to diverge — the assertion would compare a file with itself. Replace it with nothing; do not weaken it into a smoke test.

- [ ] **Step 6: Build and run the full suite**

```bash
dotnet build SK_P.sln
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: same pass count as before this task, minus exactly one (the deleted identity test). If anything else moved, a path was missed — grep for `"schema"` under `src/tests` and fix.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: schemas leave src/, one file per shape in the test project

No processor can read a schema file -- the only file reads anywhere in src/
are appsettings.json and FileFetcher's own data file. Validation is driven by
database rows resolved over the broker, so these were deploy artifacts baked
into runtime images that had no code able to open them.

Deduplicated five files to two: envelope.json (fetcher output = expander
input) and tree.json (expander output). The byte-identity test goes with
them -- with one file per shape it would compare a file with itself."
```

---

## Task 2: Project skeleton and the DI graph

**Files:**
- Create: `src/Processor.ArchiveCollapser/Processor.ArchiveCollapser.csproj`
- Create: `src/Processor.ArchiveCollapser/Program.cs`
- Create: `src/Processor.ArchiveCollapser/ProcessorHost.cs`
- Create: `src/Processor.ArchiveCollapser/ArchiveCollapserConfig.cs`
- Create: `src/Processor.ArchiveCollapser/appsettings.json`
- Modify: `SK_P.sln`
- Modify: `src/tests/BaseApi.Tests/BaseApi.Tests.csproj` — add `ProjectReference`
- Test: `src/tests/BaseApi.Tests/DependencyInjection/ArchiveCollapserHostTests.cs`

**Interfaces:**
- Produces: `Processor.ArchiveCollapser.ProcessorHost.Create(string[] args, ProcessorIdentityFound identity, Action<IConfigurationBuilder>? configure = null)` returning `IHost`; `Processor.ArchiveCollapser.ArchiveCollapserConfig : ProcessorConfig` with no members.

- [ ] **Step 1: Write the csproj**

```xml
<Project Sdk="Microsoft.NET.Sdk">

  <!--
    A concrete processor, and the inverse of ArchiveExpander: it consumes the {metadata, content}
    document and packs it back into one archive. It performs no file IO of its own.

    Common properties (net8.0, Nullable, ImplicitUsings, TreatWarningsAsErrors) come from
    Directory.Build.props, and package versions from Directory.Packages.props -- never declare
    either here.
  -->

  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <RootNamespace>Processor.ArchiveCollapser</RootNamespace>
    <AssemblyName>Processor.ArchiveCollapser</AssemblyName>
  </PropertyGroup>

  <ItemGroup>
    <!-- ArchiveBuilder, CollapsedFile and FileNode are internal: this processor's construction,
         not its surface. The tests construct them directly -- a builder tested only through the
         processor cannot be given an empty writer set -- so the test assembly is named here. -->
    <InternalsVisibleTo Include="BaseApi.Tests" />
  </ItemGroup>

  <ItemGroup>
    <!-- The worker SDK does not copy appsettings.json on its own. -->
    <Content Include="appsettings.json" CopyToOutputDirectory="PreserveNewest" />
    <!-- NO schema files. Nothing in this assembly can read one; the definitions live in the test
         project and reach the processor as database rows resolved over the broker. -->
  </ItemGroup>

  <ItemGroup>
    <!-- The package, not a ProjectReference: SourceHash.targets ships in the package's build/
         folder and NuGet imports it automatically, stamping the hash on THIS assembly. A
         ProjectReference could not flow build targets, and the processor would never match its row.
         NO SharpCompress -- it was in the expander for RAR alone, and RAR cannot be written. -->
    <PackageReference Include="BaseProcessor.Core" VersionOverride="[1.0.0]" />
  </ItemGroup>

</Project>
```

- [ ] **Step 2: Copy `Program.cs` verbatim from the expander, changing only the namespace**

```csharp
using System.Runtime.InteropServices;
using Microsoft.Extensions.Hosting;
using Processor.ArchiveCollapser;

// The boot resolves identity before building anything, so this is the one place the process can be
// cancelled while it is still deciding who it is.
//
// Both signals are registered, not just Ctrl+C. Until the host exists there is no ConsoleLifetime to
// answer SIGTERM, and Stage 1 is explicitly allowed to run forever -- so a processor waiting on an
// unregistered row is exactly the pod an operator deletes, and without this it would ignore the
// request and be killed outright when the grace period expired.
using var lifetime = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) => { e.Cancel = true; lifetime.Cancel(); };
using var term = PosixSignalRegistration.Create(
    PosixSignal.SIGTERM, ctx => { ctx.Cancel = true; lifetime.Cancel(); });

using var host = await ProcessorHost.StartAsync(args, lifetime.Token);
await host.WaitForShutdownAsync();
```

- [ ] **Step 3: Write `ArchiveCollapserConfig.cs`**

```csharp
using BaseProcessor.Core.Configuration;

namespace Processor.ArchiveCollapser;

/// <summary>
/// The step payload, and it holds NOTHING. This is a marker, and it exists only because the type
/// system demands one: <c>BaseProcessor.ExecuteAsync</c> is <c>internal abstract</c>, so nothing
/// outside <c>BaseProcessor.Core</c> can derive from the non-generic base, and
/// <c>BaseProcessor{TConfig}</c> is the only door.
/// <para>
/// <b>There is deliberately no MaxDepth.</b> On ArchiveExpander that field is a genuine choice --
/// how far to go. Here there is nothing to choose: the depth is a property of the document that
/// arrived, and the document is the source of truth. A payload field could only ever contradict it.
/// </para>
/// <para>
/// <b>Do not add a null check for this in the processor.</b> ArchiveExpander rejects a null payload;
/// this one must not. Null is legal, <c>{}</c> is legal, and a payload left over from another step
/// is legal, because nothing reads it. An empty payload never even deserializes --
/// <c>BaseProcessor{TConfig}.ExecuteAsync</c> short-circuits on whitespace and passes null.
/// </para>
/// <para>
/// No config schema is registered for this processor, so
/// <c>PayloadConfigSchemaValidator</c> skips it at publish. That is the house norm, not an
/// exception: no processor in this repo ships a config schema.
/// </para>
/// </summary>
public sealed record ArchiveCollapserConfig : ProcessorConfig;
```

- [ ] **Step 4: Write `appsettings.json`**

Copy `src/Processor.ArchiveExpander/appsettings.json` verbatim and **delete the `ArchiveExpander` section** — there is no options class here:

```json
{
  "Service": { "Name": "processor", "Version": "0.0.0" },
  "ConnectionStrings": { "Redis": "localhost:6379,abortConnect=false" },
  "RabbitMq": {
    "Host": "localhost", "Port": 5672,
    "Username": "guest", "Password": "guest", "VirtualHost": "/"
  },
  "Processor": { "Interval": 10, "StartupInterval": 30, "RequestTimeout": 8, "BackoffCap": 30 },
  "ConsoleHealth": { "Port": 8081 },
  "Logging": {
    "LogLevel": { "Default": "Information", "Microsoft.Hosting.Lifetime": "Information" }
  }
}
```

- [ ] **Step 5: Write `ProcessorHost.cs`**

Copy `src/Processor.ArchiveExpander/ProcessorHost.cs` verbatim, then make exactly these changes:
- namespace and `using` → `Processor.ArchiveCollapser` / `Processor.ArchiveCollapser.Writers`
- **delete** the `builder.Services.Configure<ArchiveExpanderOptions>(...)` call and its comment
- replace the three extractor registrations and `FileContentBuilder` with:

```csharp
        // One registration per format. ArchiveBuilder takes them all and selects by the node's
        // declared extension -- there are no bytes to sniff on the way out, so there is no
        // CanHandle here and no signature dispatch.
        //
        // NO RAR. The format is proprietary and SharpCompress can only read it; a .rar node holding
        // entries is a failed step with its own message. See ArchiveBuilder.NoWriter.
        builder.Services.AddSingleton<IArchiveWriter, ZipWriter>();
        builder.Services.AddSingleton<IArchiveWriter, TarWriter>();

        builder.Services.AddSingleton<ArchiveBuilder>();

        builder.Services.AddSingleton<BaseProcessor.Core.Processing.BaseProcessor, ArchiveCollapserProcessor>();
```

This will not compile until Tasks 4-7 land. That is expected; Step 8 below is the first build.

- [ ] **Step 6: Add to the solution and the test project**

```bash
dotnet sln SK_P.sln add src/Processor.ArchiveCollapser/Processor.ArchiveCollapser.csproj
```

In `BaseApi.Tests.csproj`, beside the other processor references:

```xml
    <ProjectReference Include="..\..\Processor.ArchiveCollapser\Processor.ArchiveCollapser.csproj" />
```

- [ ] **Step 7: Write the failing DI test**

Create `src/tests/BaseApi.Tests/DependencyInjection/ArchiveCollapserHostTests.cs`:

```csharp
using BaseProcessor.Core.Boot;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace BaseApi.Tests.DependencyInjection;

/// <summary>
/// The one thing worth asserting about a shell: that its service graph actually resolves. Asserted
/// without starting a process, which is why ProcessorHost.Create is separate from StartAsync.
/// </summary>
public sealed class ArchiveCollapserHostTests
{
    private static ProcessorIdentityFound Identity() => new(
        Id: Guid.Parse("66666666-6666-6666-6666-666666666666"),
        InputSchemaId: null,
        OutputSchemaId: null,
        ConfigSchemaId: null,
        Name: "archive-collapser",
        Version: "1.0.0");

    [Fact]
    public void TheServiceGraphResolves()
    {
        using var host = Processor.ArchiveCollapser.ProcessorHost.Create([], Identity());

        var processor = host.Services
            .GetRequiredService<BaseProcessor.Core.Processing.BaseProcessor>();

        Assert.IsType<Processor.ArchiveCollapser.ArchiveCollapserProcessor>(processor);
    }

    [Fact]
    public void BothWritersAreRegisteredAndRarIsNot()
    {
        using var host = Processor.ArchiveCollapser.ProcessorHost.Create([], Identity());

        var extensions = host.Services
            .GetServices<Processor.ArchiveCollapser.Writers.IArchiveWriter>()
            .Select(w => w.Extension)
            .Order()
            .ToArray();

        // .rar is absent BY DESIGN and this asserts it stays absent: RAR is proprietary and
        // SharpCompress can only read it, so a writer for it cannot exist.
        Assert.Equal([".tar", ".zip"], extensions);
    }
}
```

Check `ProcessorIdentityFound`'s actual constructor order in `src/BaseProcessor.Core/Identity/ProcessorIdentity.cs` before running — if it differs from the above, match the record, do not reorder the record. Copy the shape used by an existing host test under `src/tests/BaseApi.Tests/DependencyInjection/` if one exists.

- [ ] **Step 8: Build — expect failure**

```bash
dotnet build SK_P.sln
```

Expected: FAIL. `ArchiveCollapserProcessor`, `ArchiveBuilder`, `IArchiveWriter`, `ZipWriter` and `TarWriter` do not exist yet. Tasks 3-7 create them; this test is the gate that proves the wiring at the end of Task 7.

- [ ] **Step 9: Commit the skeleton**

```bash
git add -A
git commit -m "feat(collapser): project skeleton, marker config, DI graph

The step payload holds nothing and that is the design: the depth is a
property of the document that arrived, so a payload field could only ever
contradict it. The record exists because BaseProcessor<TConfig> demands a
TConfig, not because anything reads it.

No SharpCompress and no options class. Does not build until the writers and
the processor land."
```

---

## Task 3: The models — `FileNode` and `CollapsedFile`

**Files:**
- Create: `src/Processor.ArchiveCollapser/FileNode.cs`
- Create: `src/Processor.ArchiveCollapser/CollapsedFile.cs`
- Test: `src/tests/BaseApi.Tests/ArchiveCollapser/FileNodeReadTests.cs`

**Interfaces:**
- Produces: `FileMetadata(string Name, string Extension, long SizeBytes, DateTime? CreatedUtc, DateTime? ModifiedUtc, int EntryCount)`; `abstract record FileContent` with nested `FileContent.Bytes(byte[] Value)` and `FileContent.Entries(IReadOnlyList<FileNode> Value)`; `FileNode(FileMetadata Metadata, FileContent? Content)`; `internal static FileDocument.Options`; `internal sealed record CollapsedFile(string FileName, string Extension, long SizeBytes, DateTime? CreatedUtc, DateTime? ModifiedUtc, byte[] Content)`; `internal static CollapsedFileJson.Options`.

- [ ] **Step 1: Copy `FileNode.cs` from the expander**

```bash
cp src/Processor.ArchiveExpander/FileNode.cs src/Processor.ArchiveCollapser/FileNode.cs
```

Change the namespace to `Processor.ArchiveCollapser`. Then rewrite two doc comments, because the direction reverses:

On `FileNodeConverter`, replace the `Read` method's summary:

```csharp
    /// <summary>
    /// <b>The production path.</b> This processor only ever READS documents -- it is handed one and
    /// packs it back into an archive -- which is the exact reverse of ArchiveExpander, where this
    /// method exists only so a test can round-trip.
    /// </summary>
```

And on `Write`:

```csharp
    /// <summary>
    /// The inverse, and here it is the TEST convenience rather than the production path: a test
    /// builds a FileNode tree and serializes it to produce the document this processor consumes.
    /// ArchiveExpander is the assembly that writes these for real.
    /// </summary>
```

Add to the class-level summary of `FileNode.cs`:

```csharp
/// <para>
/// <b>This file is a deliberate duplicate of <c>Processor.ArchiveExpander/FileNode.cs</c>.</b> The
/// two describe one JSON document across two assemblies that must not reference each other -- the
/// same arrangement, for the same reason, as <c>FetchedFile</c> between FileFetcher and
/// ArchiveExpander. <c>EnvelopeContractTests</c> is what catches a divergence, by running both real
/// processors back to back.
/// </para>
```

- [ ] **Step 2: Write `CollapsedFile.cs`**

```csharp
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Processor.ArchiveCollapser;

/// <summary>
/// The envelope as it LEAVES -- every field non-nullable but the two timestamps, because nothing
/// constructs this without having read a valid document first.
/// <para>
/// <b>This is the writer's copy of <c>Processor.FileFetcher.FetchedFile</c>.</b> One JSON document
/// across assemblies that must not reference each other; <c>EnvelopeContractTests</c> catches a
/// divergence.
/// </para>
/// <para>
/// <b><c>SizeBytes</c> is the length of the archive actually produced</b>, never anything the input
/// document declared. The root's own <c>sizeBytes</c> is decoration and loses to the content, for
/// the same reason <c>entryCount</c> does: a wrong number in the input must not be able to
/// propagate into the output as if it were a fact.
/// </para>
/// <para>
/// <c>byte[]</c> needs no converter: System.Text.Json renders it as a base64 string, which is
/// exactly the wire form the envelope schema declares.
/// </para>
/// </summary>
internal sealed record CollapsedFile(
    string FileName,
    string Extension,
    long SizeBytes,
    DateTime? CreatedUtc,
    DateTime? ModifiedUtc,
    byte[] Content);

/// <summary>The one serializer configuration for the envelope.</summary>
internal static class CollapsedFileJson
{
    /// <summary>
    /// <b>camelCase, pinned explicitly.</b> <c>MessagingJson</c> leaves the naming policy null --
    /// PascalCase -- and it governs the <c>ProcessedData</c> envelope, not the bytes inside
    /// <c>Data</c>. Inheriting it here would silently rename every property the schema names.
    /// <para>
    /// <c>Never</c> ignore, and it is load-bearing: the envelope schema requires every key to be
    /// present, so a null timestamp must be emitted as <c>null</c> rather than omitted.
    /// </para>
    /// </summary>
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
    };
}
```

- [ ] **Step 3: Write the failing read test**

Create `src/tests/BaseApi.Tests/ArchiveCollapser/FileNodeReadTests.cs`:

```csharp
using System.Text;
using System.Text.Json;
using Processor.ArchiveCollapser;
using Xunit;

namespace BaseApi.Tests.ArchiveCollapser;

/// <summary>
/// Reading is this assembly's production path, so it gets the test ArchiveExpander gives writing.
/// </summary>
public sealed class FileNodeReadTests
{
    private static FileNode Read(string json)
        => JsonSerializer.Deserialize<FileNode>(Encoding.UTF8.GetBytes(json), FileDocument.Options)!;

    [Fact]
    public void ABase64ContentReadsAsBytes()
    {
        var node = Read(
            """
            {"metadata":{"name":"a.csv","extension":".csv","sizeBytes":2,
              "createdUtc":null,"modifiedUtc":"2026-01-02T03:04:05Z","entryCount":0},
             "content":"aWQ="}
            """);

        Assert.Equal("a.csv", node.Metadata.Name);
        Assert.Equal(new DateTime(2026, 1, 2, 3, 4, 5, DateTimeKind.Utc), node.Metadata.ModifiedUtc);
        Assert.Null(node.Metadata.CreatedUtc);
        var bytes = Assert.IsType<FileContent.Bytes>(node.Content);
        Assert.Equal("id", Encoding.UTF8.GetString(bytes.Value));
    }

    [Fact]
    public void AnArrayContentReadsAsEntries()
    {
        var node = Read(
            """
            {"metadata":{"name":"o.zip","extension":".zip","sizeBytes":9,
              "createdUtc":null,"modifiedUtc":null,"entryCount":1},
             "content":[
               {"metadata":{"name":"a.csv","extension":".csv","sizeBytes":2,
                 "createdUtc":null,"modifiedUtc":null,"entryCount":0},
                "content":"aWQ="}]}
            """);

        var entries = Assert.IsType<FileContent.Entries>(node.Content);
        Assert.Equal("a.csv", Assert.Single(entries.Value).Metadata.Name);
    }

    [Fact]
    public void ANullContentReadsAsNull()
    {
        var node = Read(
            """
            {"metadata":{"name":"empty.zip","extension":".zip","sizeBytes":22,
              "createdUtc":null,"modifiedUtc":null,"entryCount":0},
             "content":null}
            """);

        Assert.Null(node.Content);
    }

    [Fact]
    public void ADeeplyNestedDocumentIsRefusedByTheDeserializer()
    {
        // THE FIRST DEPTH GUARD, and it is not ArchiveBuilder's. FileNodeConverter.Read recurses
        // while deserializing, so a pathologically deep document would overflow the stack before
        // the builder ever sees a tree. JsonSerializerOptions.MaxDepth defaults to 64 and each node
        // costs two levels of JSON, so the tree is capped around 32 node levels and the failure is
        // a JsonException the processor already catches.
        //
        // This test MEASURES that claim rather than trusting it. If it fails, the guard is not
        // where this comment says and ArchiveBuilder.MaxSupportedDepth is the only bound -- which
        // is a stack overflow risk, not a failed step. Fix by pinning MaxDepth explicitly in
        // FileDocument.Options rather than by deleting this test.
        var json = new StringBuilder();
        const int levels = 200;

        for (var i = 0; i < levels; i++)
        {
            json.Append(
                """{"metadata":{"name":"a.zip","extension":".zip","sizeBytes":1,"createdUtc":null,"modifiedUtc":null,"entryCount":1},"content":[""");
        }

        json.Append(
            """{"metadata":{"name":"leaf.csv","extension":".csv","sizeBytes":1,"createdUtc":null,"modifiedUtc":null,"entryCount":0},"content":"aQ=="}""");

        for (var i = 0; i < levels; i++)
        {
            json.Append("]}");
        }

        Assert.Throws<JsonException>(() => Read(json.ToString()));
    }
}
```

- [ ] **Step 4: Run the tests**

```bash
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

The solution will not build until Task 7. Instead, verify by building just the two projects:

```bash
dotnet build src/Processor.ArchiveCollapser/Processor.ArchiveCollapser.csproj
```

Expected: FAIL — `ProcessorHost.cs` references types from Tasks 4-7. **Temporarily comment out the body of `ProcessorHost.Create`'s registrations** to get a clean build of the models, run the four tests above, then uncomment. Do not commit with them commented out.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(collapser): FileNode and CollapsedFile

FileNode is a deliberate duplicate of the expander's -- one document across
two assemblies that must not reference each other, the same arrangement as
FetchedFile. The converter's direction flips: Read is production here, Write
is the test convenience.

CollapsedFile's SizeBytes is the archive actually produced, never what the
input document declared -- a wrong number upstream must not propagate as if
it were a fact.

Pins the deserializer's own depth guard by measurement: MaxDepth 64 caps the
tree near 32 node levels, so the converter refuses a deep document before
ArchiveBuilder's bound is ever reached."
```

---

## Task 4: The writer seam and `ZipWriter`

**Files:**
- Create: `src/Processor.ArchiveCollapser/Writers/ArchiveWritingException.cs`
- Create: `src/Processor.ArchiveCollapser/Writers/IArchiveWriter.cs`
- Create: `src/Processor.ArchiveCollapser/Writers/ZipWriter.cs`
- Test: `src/tests/BaseApi.Tests/ArchiveCollapser/ZipWriterTests.cs`

**Interfaces:**
- Produces: `ArchiveEntry(string Name, byte[] Content, DateTime? ModifiedUtc)`; `IArchiveWriter { string Extension { get; } byte[] Write(IReadOnlyList<ArchiveEntry> entries); }`; `ArchiveWritingException(string message, Exception? inner = null)`; `ZipWriter : IArchiveWriter`.

- [ ] **Step 1: Write the seam and the exception**

`Writers/IArchiveWriter.cs`:

```csharp
namespace Processor.ArchiveCollapser.Writers;

/// <summary>One entry to place in an archive.</summary>
/// <param name="Name">The entry's file name. Never a path -- ArchiveBuilder rejects a separator.</param>
/// <param name="ModifiedUtc">Null where the source document recorded none.</param>
public sealed record ArchiveEntry(string Name, byte[] Content, DateTime? ModifiedUtc);

/// <summary>
/// One archive format. Registered in the container and selected by the node's DECLARED EXTENSION.
/// <para>
/// <b>There is no <c>CanHandle</c>, and that asymmetry with <c>IArchiveExtractor</c> is the whole
/// point.</b> On the way in the bytes exist and are the only honest evidence -- an entry's name is
/// written by whoever built the archive. On the way out there are no bytes yet. The only thing a
/// node carries about what it should BECOME is its declared name, so the name must decide, at every
/// level.
/// </para>
/// <para>
/// <b>There is no RAR implementation and there cannot be one.</b> The format is proprietary and
/// SharpCompress -- the package ArchiveExpander uses to read it -- exposes no writer. A <c>.rar</c>
/// node holding entries is a failed step; see <c>ArchiveBuilder.NoWriter</c>.
/// </para>
/// </summary>
public interface IArchiveWriter
{
    /// <summary>The extension this writer claims, leading dot -- <c>".zip"</c>. The SELECTOR.</summary>
    string Extension { get; }

    /// <summary>
    /// The archive's bytes, or an <see cref="ArchiveWritingException"/> saying why they could not be
    /// produced. An empty list must produce the format's own canonical empty archive rather than
    /// throwing: an archive that expanded to nothing is a legitimate document.
    /// </summary>
    byte[] Write(IReadOnlyList<ArchiveEntry> entries);
}
```

`Writers/ArchiveWritingException.cs`:

```csharp
namespace Processor.ArchiveCollapser.Writers;

/// <summary>
/// A document could not be packed. The writing seam's single declared fault type, and the only one
/// <c>ArchiveCollapserProcessor</c> converts into the <c>collapsing {FileName} failed:</c> failure.
/// <para>
/// <b>It exists because a catch list over library exception types is a seam that rots.</b> This is
/// the same lesson <c>ArchiveExtractionException</c> records: the expander's catch was written
/// against zip's BCL types, and when rar arrived it brought SharpCompress, whose whole hierarchy
/// descends from <c>SharpCompressException : System.Exception</c> and matched none of them. Each
/// writer wraps its own library's faults into this type, and the caller catches exactly this.
/// </para>
/// <para>
/// <b>Bare <see cref="Exception"/> is deliberately NOT caught at the call site.</b> A
/// <see cref="NullReferenceException"/> in the builder is a programming error, and reporting it to
/// an operator as a bad document buries a bug under a plausible business failure. Anything a writer
/// throws that is not this type escapes to the framework's general catch, which reports the same
/// failed step but logs the stack trace instead of flattening it into one line.
/// </para>
/// </summary>
/// <param name="message">
/// The reason, rendered for an operator. It becomes the <c>{Reason}</c> of
/// <c>collapsing {FileName} failed: {Reason}</c> verbatim, so it must read as a sentence about the
/// document and must never carry document content.
/// </param>
/// <param name="inner">The library fault this wraps, where there was one.</param>
public sealed class ArchiveWritingException(string message, Exception? inner = null)
    : Exception(message, inner);
```

- [ ] **Step 2: Write the failing ZipWriter tests**

Create `src/tests/BaseApi.Tests/ArchiveCollapser/ZipWriterTests.cs`:

```csharp
using System.Text;
using Processor.ArchiveCollapser.Writers;
using Processor.ArchiveExpander.Extractors;
using Xunit;

namespace BaseApi.Tests.ArchiveCollapser;

/// <summary>
/// The writer, asserted THROUGH THE REAL EXTRACTOR wherever possible. Asserting on archive bytes
/// directly would pin this runtime's deflate output, which is not a contract; asserting that
/// ArchiveExpander reads back what we wrote is the property that actually matters.
/// </summary>
public sealed class ZipWriterTests
{
    private static ArchiveEntry Entry(string name, string text, DateTime? stamp = null)
        => new(name, Encoding.UTF8.GetBytes(text), stamp);

    private static IReadOnlyList<ExtractedEntry> ReadBack(byte[] archive)
    {
        using var stream = new MemoryStream(archive, writable: false);
        return new ZipExtractor().Extract(stream);
    }

    [Fact]
    public void EntriesSurviveARoundTripThroughTheRealExtractor()
    {
        var bytes = new ZipWriter().Write(
            [Entry("a.csv", "id"), Entry("b.csv", "id,name")]);

        var read = ReadBack(bytes);

        Assert.Equal(["a.csv", "b.csv"], read.Select(e => e.Name).ToArray());
        Assert.Equal("id,name", Encoding.UTF8.GetString(read[1].Content));
    }

    [Fact]
    public void AnEmptyListProducesTheCanonicalEmptyArchive()
    {
        // 22 bytes: a bare End Of Central Directory record. This is the ONE zip that legitimately
        // yields nothing, and ZipExtractor.IsCanonicalEmptyArchive exists to recognise exactly it.
        // Anything else here means a document with content:null collapses to something the expander
        // will call corrupt -- the loop would not close.
        var bytes = new ZipWriter().Write([]);

        Assert.Equal(22, bytes.Length);
        Assert.Empty(ReadBack(bytes));
    }

    [Fact]
    public void AModifiedTimestampSurvivesTheRoundTripExactly()
    {
        // THE FIXED POINT, AT ONE ENTRY. This is the assertion the whole timestamp rule rests on,
        // and it must be written as a ROUND TRIP rather than against a literal -- ZipArchiveEntry
        // stores DOS wall-clock time and its getter and setter do not agree about the offset, so a
        // naive `new DateTimeOffset(utc)` can round-trip correctly on a UTC machine and be wrong by
        // the local offset everywhere else. A literal assertion would hide that; this cannot.
        var stamp = new DateTime(2026, 6, 7, 8, 9, 10, DateTimeKind.Utc);

        var bytes = new ZipWriter().Write([Entry("a.csv", "id", stamp)]);

        // Zip stores 2-second resolution, so an odd second rounds. Chosen even to avoid it.
        Assert.Equal(stamp, Assert.Single(ReadBack(bytes)).ModifiedUtc);
    }

    [Theory]
    [InlineData(null)]                 // the rar case: the document recorded no timestamp
    [InlineData("1970-01-01T00:00:00Z")] // the tar case: legal in tar, below the DOS floor
    [InlineData("1900-01-01T00:00:00Z")]
    public void ATimestampBelowTheDosFloorClampsToTheFloorTheExtractorReportsBack(string? iso)
    {
        // The rule is "write the value the expander would read back", so the assertion is that the
        // extractor reports the floor -- not that some internal method returned it.
        DateTime? stamp = iso is null ? null : DateTime.Parse(iso).ToUniversalTime();

        var bytes = new ZipWriter().Write([Entry("a.csv", "id", stamp)]);

        Assert.Equal(
            new DateTime(1980, 1, 1, 0, 0, 0, DateTimeKind.Utc),
            Assert.Single(ReadBack(bytes)).ModifiedUtc);
    }

    [Fact]
    public void ATimestampAboveTheDosCeilingClampsRatherThanThrowing()
    {
        // The other end of the DOS range. Without a clamp this throws ArgumentOutOfRangeException
        // out of LastWriteTime, which -- being an ArgumentException -- would surface as an
        // ArchiveWritingException and a failed step over a document that is merely optimistic.
        var bytes = new ZipWriter().Write(
            [Entry("a.csv", "id", new DateTime(2200, 1, 1, 0, 0, 0, DateTimeKind.Utc))]);

        Assert.True(Assert.Single(ReadBack(bytes)).ModifiedUtc!.Value.Year <= 2107);
    }

    [Fact]
    public void ClampingIsAFixedPointAcrossASecondPass()
    {
        // Write a clamped value, read it, write it again: the second archive must carry the same
        // timestamp as the first. This is what makes "collapse -> expand is a fixed point" true
        // rather than aspirational.
        var writer = new ZipWriter();

        var first = writer.Write([Entry("a.csv", "id", null)]);
        var afterOne = Assert.Single(ReadBack(first)).ModifiedUtc;

        var second = writer.Write([Entry("a.csv", "id", afterOne)]);
        var afterTwo = Assert.Single(ReadBack(second)).ModifiedUtc;

        Assert.Equal(afterOne, afterTwo);
    }
}
```

- [ ] **Step 3: Run them to verify they fail**

```bash
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: FAIL — `ZipWriter` does not exist.

- [ ] **Step 4: Implement `ZipWriter`**

```csharp
using System.IO.Compression;

namespace Processor.ArchiveCollapser.Writers;

/// <summary>
/// Zip, on the in-box <c>System.IO.Compression</c>. No package. The mirror of <c>ZipExtractor</c>.
/// </summary>
public sealed class ZipWriter : IArchiveWriter
{
    /// <summary>
    /// The DOS date range <c>ZipArchiveEntry.LastWriteTime</c> accepts. Outside it the setter throws
    /// <see cref="ArgumentOutOfRangeException"/>, so both ends are clamped rather than passed
    /// through -- see <see cref="Clamp"/> for why the floor in particular is the RIGHT answer and
    /// not merely a safe one.
    /// </summary>
    private static readonly DateTime DosFloor = new(1980, 1, 1, 0, 0, 0, DateTimeKind.Utc);

    /// <summary>23:59:58, not :59 -- DOS stores seconds in two-second units.</summary>
    private static readonly DateTime DosCeiling = new(2107, 12, 31, 23, 59, 58, DateTimeKind.Utc);

    public string Extension => ".zip";

    public byte[] Write(IReadOnlyList<ArchiveEntry> entries)
    {
        try
        {
            return WriteCore(entries);
        }
        catch (Exception ex) when (ex is InvalidDataException or IOException
                                      or NotSupportedException or ArgumentException)
        {
            // The BCL fault types System.IO.Compression raises, wrapped into the one type the
            // processor catches. ArgumentOutOfRangeException descends from ArgumentException, so a
            // bug in Clamp degrades to a clean failed step rather than escaping as a framework
            // fault. Not bare Exception: a NullReferenceException here is a bug in this class.
            throw new ArchiveWritingException(ex.Message, ex);
        }
    }

    private static byte[] WriteCore(IReadOnlyList<ArchiveEntry> entries)
    {
        using var buffer = new MemoryStream();

        // THE BRACES ARE LOAD-BEARING, and leaveOpen with them. ZipArchive writes the central
        // directory on Dispose, so ToArray() must run AFTER this block closes -- take the bytes
        // early and the result is a zip with no EOCD, which ZipExtractor correctly rejects as
        // corrupt one hop later, in a branch where the failure carries no file name.
        using (var zip = new ZipArchive(buffer, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (var entry in entries)
            {
                // CreateEntry's default level is Optimal. Stated rather than passed: output size
                // matters because the archive is base64'd into the message body, and there is no
                // option for it -- see the spec's section 4 on why this processor has no knobs.
                var created = zip.CreateEntry(entry.Name);
                created.LastWriteTime = Clamp(entry.ModifiedUtc);

                using var stream = created.Open();
                stream.Write(entry.Content);
            }
        }

        // An EMPTY list falls through the loop and produces the canonical 22-byte EOCD, which is
        // exactly the one archive ZipExtractor.IsCanonicalEmptyArchive still calls healthy. That is
        // why a document with content:null needs no special case anywhere.
        return buffer.ToArray();
    }

    /// <summary>
    /// The timestamp to store, per the rule: <b>write the value the expander would read back</b>.
    /// <para>
    /// A null or out-of-range stamp becomes the DOS bound, because that is precisely what
    /// <c>ZipExtractor</c> reports for such an entry afterwards -- which makes collapse then expand
    /// a fixed point rather than a drift. Null arises from a rar-sourced document (the only
    /// extractor of the three whose timestamp is nullable); a sub-1980 value arises from a
    /// tar-sourced one, where the format can represent what zip cannot.
    /// </para>
    /// <para>
    /// <b>The offset handling is deliberate and was pinned by test, not reasoned about.</b>
    /// <c>LastWriteTime</c> is a <see cref="DateTimeOffset"/> over a DOS wall-clock field, and its
    /// getter and setter do not necessarily agree about which offset that wall clock is in.
    /// <c>ZipWriterTests.AModifiedTimestampSurvivesTheRoundTripExactly</c> asserts the round trip
    /// rather than a literal for exactly that reason: a naive conversion can pass on a UTC machine
    /// and be wrong by the local offset everywhere else. <b>If that test fails, fix the conversion
    /// here -- do not relax the test.</b>
    /// </para>
    /// </summary>
    internal static DateTimeOffset Clamp(DateTime? modifiedUtc)
    {
        var stamp = modifiedUtc is { } value
            ? DateTime.SpecifyKind(value, DateTimeKind.Utc)
            : DosFloor;

        if (stamp < DosFloor)
        {
            stamp = DosFloor;
        }
        else if (stamp > DosCeiling)
        {
            stamp = DosCeiling;
        }

        // A UTC instant carried as a zero-offset DateTimeOffset. If the round-trip test shows the
        // reader applying a local offset, convert with .ToLocalTime() here so that the stored wall
        // clock reads back through ZipExtractor's `.UtcDateTime` as the value passed in.
        return new DateTimeOffset(stamp, TimeSpan.Zero);
    }
}
```

- [ ] **Step 5: Run the tests and iterate on the clamp**

```bash
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: PASS. **If `AModifiedTimestampSurvivesTheRoundTripExactly` fails with an offset-shaped difference** (the delta equals your machine's UTC offset), change the final line of `Clamp` to `new DateTimeOffset(stamp, TimeSpan.Zero).ToLocalTime()` and re-run. Record which one was correct in the doc comment. Do not adjust the test to match the code.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(collapser): the writer seam and ZipWriter

The seam has two members, not three: there is no CanHandle because on the way
out there are no bytes to sniff, so the node's declared extension decides.
There is no RAR writer and there cannot be one.

Every assertion goes through the REAL ZipExtractor rather than against archive
bytes -- pinning this runtime's deflate output is not a contract; ArchiveExpander
reading back what we wrote is the property that matters.

The timestamp clamp is tested as a round trip, not against a literal: DOS
stores wall-clock time and a naive conversion can pass on a UTC machine and be
wrong by the local offset everywhere else."
```

---

## Task 5: `TarWriter`

**Files:**
- Create: `src/Processor.ArchiveCollapser/Writers/TarWriter.cs`
- Test: `src/tests/BaseApi.Tests/ArchiveCollapser/TarWriterTests.cs`

**Interfaces:**
- Consumes: `IArchiveWriter`, `ArchiveEntry`, `ArchiveWritingException` from Task 4.
- Produces: `TarWriter : IArchiveWriter` with `Extension => ".tar"`.

- [ ] **Step 1: Write the failing tests**

```csharp
using System.Text;
using Processor.ArchiveCollapser.Writers;
using Processor.ArchiveExpander.Extractors;
using Xunit;

namespace BaseApi.Tests.ArchiveCollapser;

public sealed class TarWriterTests
{
    private static ArchiveEntry Entry(string name, string text, DateTime? stamp = null)
        => new(name, Encoding.UTF8.GetBytes(text), stamp);

    private static IReadOnlyList<ExtractedEntry> ReadBack(byte[] archive)
    {
        using var stream = new MemoryStream(archive, writable: false);
        return new TarExtractor().Extract(stream);
    }

    [Fact]
    public void EntriesSurviveARoundTripThroughTheRealExtractor()
    {
        var bytes = new TarWriter().Write([Entry("a.csv", "id"), Entry("b.csv", "id,name")]);

        var read = ReadBack(bytes);

        Assert.Equal(["a.csv", "b.csv"], read.Select(e => e.Name).ToArray());
        Assert.Equal("id,name", Encoding.UTF8.GetString(read[1].Content));
    }

    [Fact]
    public void TheArchiveCarriesTheUstarMagicTheExtractorRequires()
    {
        // TarExtractor.CanHandle looks for "ustar" at byte 257 and explicitly refuses pre-POSIX V7.
        // Writing V7 would produce a tar OUR OWN expander cannot recognise -- it would be treated as
        // a leaf and the round trip would silently break. This is why the format is Pax and not a
        // matter of taste.
        var bytes = new TarWriter().Write([Entry("a.csv", "id")]);

        Assert.True(new TarExtractor().CanHandle(bytes));
    }

    [Fact]
    public void AnEmptyListProducesAnArchiveTheExtractorCallsHealthy()
    {
        // TarExtractor treats "no entries" as corrupt UNLESS the archive is all zero bytes. A
        // document with content:null must land on the healthy side of that guard, or the loop does
        // not close. Asserted through the extractor rather than by counting bytes, because whether
        // the BCL writes trailing zero blocks or nothing at all is unmeasured -- and both satisfy
        // the guard, so the test does not need to care which.
        var bytes = new TarWriter().Write([]);

        Assert.Empty(ReadBack(bytes));
    }

    [Fact]
    public void AModifiedTimestampSurvivesTheRoundTripExactly()
    {
        var stamp = new DateTime(2026, 6, 7, 8, 9, 11, DateTimeKind.Utc);

        var bytes = new TarWriter().Write([Entry("a.csv", "id", stamp)]);

        // Odd second on purpose: Pax stores full precision where zip rounds to two seconds, and
        // this is the assertion of that difference.
        Assert.Equal(stamp, Assert.Single(ReadBack(bytes)).ModifiedUtc);
    }

    [Fact]
    public void APreDosTimestampIsNotClampedBecauseTarCanRepresentIt()
    {
        // The rule is "write the value the expander would read back", and tar reads back what zip
        // could not hold. Clamping here would throw away information the format keeps.
        var stamp = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);

        var bytes = new TarWriter().Write([Entry("a.csv", "id", stamp)]);

        Assert.Equal(stamp, Assert.Single(ReadBack(bytes)).ModifiedUtc);
    }

    [Fact]
    public void ANullTimestampBecomesTheUnixEpoch()
    {
        // Tar has no null. The epoch is tar's own conventional zero and is what TarExtractor reads
        // back, which keeps the fixed point.
        var bytes = new TarWriter().Write([Entry("a.csv", "id", null)]);

        Assert.Equal(
            new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc),
            Assert.Single(ReadBack(bytes)).ModifiedUtc);
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: FAIL — `TarWriter` does not exist.

- [ ] **Step 3: Implement `TarWriter`**

```csharp
using System.Formats.Tar;
using BclTarWriter = System.Formats.Tar.TarWriter;

namespace Processor.ArchiveCollapser.Writers;

/// <summary>
/// Tar, on the in-box <c>System.Formats.Tar</c>. Uncompressed only, mirroring <c>TarExtractor</c> --
/// a <c>.tar.gz</c> has a different extension and would need its own writer.
/// <para>
/// <b>The class name shadows <c>System.Formats.Tar.TarWriter</c></b>, which is the type it is built
/// on. The alias above resolves it in this one file; the name is kept for symmetry with
/// <c>ZipWriter</c> and with <c>TarExtractor</c> on the other side.
/// </para>
/// </summary>
public sealed class TarWriter : IArchiveWriter
{
    public string Extension => ".tar";

    public byte[] Write(IReadOnlyList<ArchiveEntry> entries)
    {
        try
        {
            return WriteCore(entries);
        }
        catch (Exception ex) when (ex is InvalidDataException or IOException
                                      or NotSupportedException or ArgumentException
                                      or FormatException or EndOfStreamException)
        {
            // The same list TarExtractor wraps, for the same reason. FormatException is included
            // because System.Formats.Tar reports an unparsable octal field that way and it descends
            // from neither IOException nor ArgumentException.
            throw new ArchiveWritingException(ex.Message, ex);
        }
    }

    private static byte[] WriteCore(IReadOnlyList<ArchiveEntry> entries)
    {
        using var buffer = new MemoryStream();

        // PAX, AND THAT IS FORCED RATHER THAN AESTHETIC. TarExtractor.CanHandle requires the
        // "ustar" magic at byte 257 and explicitly refuses pre-POSIX V7, so a V7 archive would be
        // unrecognisable to our own expander and would come back as a leaf -- a silently broken
        // round trip rather than a failure. Pax also stores mtime at full precision, where Ustar is
        // limited to 11 octal digits of seconds, and writes TarEntryType.RegularFile, one of the two
        // types TarExtractor admits.
        //
        // leaveOpen so ToArray() below reads a live stream, matching ZipWriter.
        using (var tar = new BclTarWriter(buffer, TarEntryFormat.Pax, leaveOpen: true))
        {
            foreach (var entry in entries)
            {
                // A MemoryStream over an existing array holds no unmanaged resource, and TarWriter
                // does not take ownership -- so there is nothing here that must be disposed before
                // the archive is finished with it.
                var tarEntry = new PaxTarEntry(TarEntryType.RegularFile, entry.Name)
                {
                    // Null becomes the epoch: tar has no null, and the epoch is what TarExtractor
                    // reads back, which is what keeps collapse -> expand a fixed point. NOT clamped
                    // to 1980 like zip -- tar can represent what zip cannot, and the rule is to
                    // write the value the expander would read back, not the narrowest value any
                    // format could hold.
                    ModificationTime = entry.ModifiedUtc is { } stamp
                        ? new DateTimeOffset(DateTime.SpecifyKind(stamp, DateTimeKind.Utc))
                        : DateTimeOffset.UnixEpoch,
                    DataStream = new MemoryStream(entry.Content, writable: false),
                };

                tar.WriteEntry(tarEntry);
            }
        }

        return buffer.ToArray();
    }
}
```

- [ ] **Step 4: Run the tests**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: PASS.

If `APreDosTimestampIsNotClampedBecauseTarCanRepresentIt` throws out of the `ModificationTime` setter, the BCL's accepted range is narrower than assumed. Clamp the low end to `DateTimeOffset.UnixEpoch` and change that test to assert the epoch, recording the measured bound in the doc comment — this is the "measure rather than assert" item from spec §8.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(collapser): TarWriter on Pax

Pax is forced, not chosen: TarExtractor requires the ustar magic at byte 257
and refuses pre-POSIX V7, so a V7 archive would be unrecognisable to our own
expander and would come back as a leaf -- a silently broken round trip rather
than a failure.

Tar does NOT clamp to the DOS floor. The rule is to write the value the
expander would read back, and tar reads back what zip cannot hold; only a
null becomes a value, the epoch, because tar has no null."
```

---

## Task 6: `ArchiveBuilder`

**Files:**
- Create: `src/Processor.ArchiveCollapser/ArchiveBuilder.cs`
- Test: `src/tests/BaseApi.Tests/ArchiveCollapser/ArchiveBuilderTests.cs`

**Interfaces:**
- Consumes: `FileNode`, `FileContent`, `FileMetadata` (Task 3); `IArchiveWriter`, `ArchiveEntry`, `ArchiveWritingException` (Task 4).
- Produces: `internal sealed record CollapseResult(byte[] Archive, int DepthReached, int EntryCount)`; `internal sealed class ArchiveBuilder(IEnumerable<IArchiveWriter> writers)` with `public const int MaxSupportedDepth = 64` and `public CollapseResult Build(FileNode root)`.

- [ ] **Step 1: Write the failing tests**

```csharp
using System.Text;
using Processor.ArchiveCollapser;
using Processor.ArchiveCollapser.Writers;
using Processor.ArchiveExpander.Extractors;
using Xunit;

namespace BaseApi.Tests.ArchiveCollapser;

public sealed class ArchiveBuilderTests
{
    private static ArchiveBuilder Builder() => new([new ZipWriter(), new TarWriter()]);

    private static DateTime Stamp => new(2026, 6, 7, 8, 9, 10, DateTimeKind.Utc);

    private static FileNode Leaf(string name, string text)
        => new(
            new FileMetadata(name, Path.GetExtension(name), text.Length, null, Stamp, 0),
            new FileContent.Bytes(Encoding.UTF8.GetBytes(text)));

    private static FileNode Archive(string name, params FileNode[] entries)
        => new(
            new FileMetadata(name, Path.GetExtension(name), 999, null, Stamp, entries.Length),
            entries.Length == 0 ? null : new FileContent.Entries(entries));

    private static IReadOnlyList<ExtractedEntry> Unzip(byte[] archive)
    {
        using var stream = new MemoryStream(archive, writable: false);
        return new ZipExtractor().Extract(stream);
    }

    [Fact]
    public void APlainFileNodePassesItsBytesThroughUnchanged()
    {
        // Case 1, at the root: the document describes a plain file, so the collapser emits its
        // bytes. The inverse of ArchiveExpander leaving a CSV as a leaf.
        var built = Builder().Build(Leaf("orders.csv", "id,name"));

        Assert.Equal("id,name", Encoding.UTF8.GetString(built.Archive));
        Assert.Equal(0, built.DepthReached);
        Assert.Equal(0, built.EntryCount);
    }

    [Fact]
    public void AnArchiveNodePacksItsEntries()
    {
        var built = Builder().Build(Archive("orders.zip", Leaf("a.csv", "id"), Leaf("b.csv", "x")));

        Assert.Equal(["a.csv", "b.csv"], Unzip(built.Archive).Select(e => e.Name).ToArray());
        Assert.Equal(2, built.EntryCount);
        Assert.Equal(1, built.DepthReached);
    }

    [Fact]
    public void ANullContentProducesTheCanonicalEmptyArchive()
    {
        // Case 3. The expander turns an empty archive into null; null must turn back into the one
        // archive the expander's guard still calls healthy.
        var built = Builder().Build(Archive("empty.zip"));

        Assert.Equal(22, built.Archive.Length);
        Assert.Equal(0, built.EntryCount);
    }

    [Fact]
    public void ANestedArchiveIsPackedRecursively()
    {
        // Depth 2 -- root -> inner archive -> leaves. This is the case the identity test runs at,
        // and the reason the recursion is not decorative.
        var built = Builder().Build(
            Archive("outer.zip", Archive("inner.zip", Leaf("a.csv", "id")), Leaf("b.csv", "x")));

        Assert.Equal(2, built.DepthReached);

        var outer = Unzip(built.Archive);
        Assert.Equal(["inner.zip", "b.csv"], outer.Select(e => e.Name).ToArray());
        Assert.Equal("a.csv", Assert.Single(Unzip(outer[0].Content)).Name);
    }

    [Fact]
    public void AMixedFormatTreePacksATarInsideAZip()
    {
        // The extension decides PER NODE, not once for the document.
        var built = Builder().Build(
            Archive("outer.zip", Archive("inner.tar", Leaf("a.csv", "id"))));

        var inner = Assert.Single(Unzip(built.Archive));
        Assert.Equal("inner.tar", inner.Name);
        Assert.True(new TarExtractor().CanHandle(inner.Content));
    }

    [Fact]
    public void ANodeWithEntriesWhoseExtensionNamesNoWriterFails()
    {
        var ex = Assert.Throws<ArchiveWritingException>(
            () => Builder().Build(Archive("orders.csv", Leaf("a.csv", "id"))));

        Assert.Contains("orders.csv", ex.Message, StringComparison.Ordinal);
        Assert.Contains(".csv", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ARarNodeWithEntriesFailsWithItsOwnMessage()
    {
        // Its own message because "RAR cannot be written" is a permanent property of the format,
        // not a typo in the document -- an operator must not spend an afternoon fixing a name.
        var ex = Assert.Throws<ArchiveWritingException>(
            () => Builder().Build(Archive("orders.rar", Leaf("a.csv", "id"))));

        Assert.Contains("RAR cannot be written", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ANodeNamedAsAnArchiveButCarryingBytesIsAPlainEntry()
    {
        // Case 2's counterpart: a node carrying its own bytes is a file, whatever it is named. An
        // already-built archive is carried along rather than re-opened and re-packed.
        var alreadyBuilt = new ZipWriter().Write([new ArchiveEntry("x.csv", "id"u8.ToArray(), Stamp)]);

        var built = Builder().Build(
            Archive("outer.zip",
                new FileNode(
                    new FileMetadata("carried.zip", ".zip", alreadyBuilt.Length, null, Stamp, 0),
                    new FileContent.Bytes(alreadyBuilt))));

        Assert.Equal(alreadyBuilt, Assert.Single(Unzip(built.Archive)).Content);
    }

    [Theory]
    [InlineData("a/b.csv")]
    [InlineData("a\\b.csv")]
    public void ANodeNameCarryingAPathSeparatorFails(string name)
    {
        // The expander strips directories on read, so writing real structure would be flattened
        // straight back and would break the fixed point. Rejected rather than silently stripped,
        // which would hide a malformed document.
        var ex = Assert.Throws<ArchiveWritingException>(
            () => Builder().Build(Archive("outer.zip", Leaf(name, "id"))));

        Assert.Contains("path separator", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void DuplicateSiblingNamesAreAllowed()
    {
        // Zip permits them and the expander reads both back, so the round trip survives.
        var built = Builder().Build(Archive("outer.zip", Leaf("a.csv", "one"), Leaf("a.csv", "two")));

        Assert.Equal(2, Unzip(built.Archive).Count);
    }

    [Fact]
    public void ADocumentDeeperThanMaxSupportedDepthFails()
    {
        var node = Leaf("leaf.csv", "id");

        for (var i = 0; i <= ArchiveBuilder.MaxSupportedDepth; i++)
        {
            node = Archive("a.zip", node);
        }

        var ex = Assert.Throws<ArchiveWritingException>(() => Builder().Build(node));

        Assert.Contains("nests deeper", ex.Message, StringComparison.Ordinal);
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: FAIL — `ArchiveBuilder` does not exist.

- [ ] **Step 3: Implement `ArchiveBuilder`**

```csharp
using Processor.ArchiveCollapser.Writers;

namespace Processor.ArchiveCollapser;

/// <summary>
/// The archive, how deep the document went, and how many entries its root held.
/// <para>
/// <b><c>EntryCount</c> is counted from the CONTENT, never read from <c>metadata.entryCount</c>.</b>
/// The array is the fact and the count is derived -- the same rule ArchiveExpander's schema README
/// states from the other side -- so a wrong count in the input document cannot propagate into the
/// log line as if it were true.
/// </para>
/// <para>
/// <b><c>DepthReached</c> is returned rather than logged here because this is the only place it
/// survives.</b> The outbound envelope schema says nothing about depth, so if the input schema row
/// is not registered nothing downstream records how deep the document actually was.
/// </para>
/// </summary>
internal sealed record CollapseResult(byte[] Archive, int DepthReached, int EntryCount);

/// <summary>
/// Stage two: everything that involves looking inside the document. Stage one -- the processor -- is
/// dry and hands this class a tree it has already read.
/// <para>
/// <b>The writer is selected by the node's DECLARED EXTENSION, at every level.</b> There is no
/// signature dispatch and no <c>CanHandle</c>: on the way out there are no bytes yet, so the only
/// thing a node carries about what it should become is its name. See <see cref="IArchiveWriter"/>.
/// </para>
/// </summary>
internal sealed class ArchiveBuilder(IEnumerable<IArchiveWriter> writers)
{
    /// <summary>
    /// The deepest document this will pack.
    /// <para>
    /// <b>This is the SECOND guard, not the first.</b> <c>FileNodeConverter.Read</c> recurses while
    /// deserializing, so a pathologically deep document is refused by
    /// <c>JsonSerializerOptions.MaxDepth</c> before a tree ever reaches this class -- pinned by
    /// <c>FileNodeReadTests.ADeeplyNestedDocumentIsRefusedByTheDeserializer</c>. This bound exists
    /// so that the recursion below is safe to read and safe to run regardless, and it matches
    /// <c>ArchiveExpanderConfig.MaxSupportedDepth</c> so the two halves of the loop agree.
    /// </para>
    /// <para>
    /// <b>It is checked DURING the walk, unlike the expander's.</b> There, <c>MaxDepth</c> is
    /// validated before a single file is opened, so the stack bound is fixed up front. Here the
    /// depth arrives with the document and can only be discovered.
    /// </para>
    /// </summary>
    public const int MaxSupportedDepth = 64;

    private readonly IReadOnlyList<IArchiveWriter> _writers = writers.ToList();

    /// <summary>The archive this document describes.</summary>
    public CollapseResult Build(FileNode root)
    {
        var depthReached = 0;
        var bytes = BuildNode(root, depth: 0, ref depthReached);

        return new CollapseResult(
            bytes,
            depthReached,
            root.Content is FileContent.Entries entries ? entries.Value.Count : 0);
    }

    /// <summary>One node's bytes, and its subtree's.</summary>
    private byte[] BuildNode(FileNode node, int depth, ref int depthReached)
    {
        if (depth > depthReached)
        {
            depthReached = depth;
        }

        if (depth > MaxSupportedDepth)
        {
            throw new ArchiveWritingException(
                $"the document nests deeper than {MaxSupportedDepth} levels, at '{node.Metadata.Name}'");
        }

        return node.Content switch
        {
            // Case 1: a leaf. Its bytes are its content, whatever the extension claims -- the mirror
            // of "an unexpanded archive is a file". A node named .zip holding base64 is an
            // already-built archive being carried along, and re-opening it to re-pack it would be
            // work the document did not ask for.
            FileContent.Bytes bytes => bytes.Value,

            // Case 2: an archive.
            FileContent.Entries entries => Pack(node, entries.Value, depth, ref depthReached),

            // Case 3: null -- an archive that expanded to nothing. Packing an empty list produces
            // the format's canonical empty archive, which is exactly what the expander's
            // false-HEALTHY guards still admit. That is the loop closing.
            _ => Pack(node, [], depth, ref depthReached),
        };
    }

    private byte[] Pack(FileNode node, IReadOnlyList<FileNode> children, int depth, ref int depthReached)
    {
        // Case 4 lives here: content says "these are my entries" and the name says nothing can pack
        // them. Resolved BEFORE any child is built, so a document that cannot possibly succeed fails
        // without first materialising a subtree.
        var writer = Match(node.Metadata.Extension) ?? throw NoWriter(node);

        var entries = new List<ArchiveEntry>(children.Count);

        foreach (var child in children)
        {
            var name = child.Metadata.Name;

            // A name is a name, never a path. The expander strips directories on read -- entry.Name
            // in zip, Path.GetFileName in tar -- so writing real structure here would be flattened
            // straight back, quietly breaking the fixed point. Rejected rather than stripped:
            // stripping would hide a malformed document.
            if (name.Contains('/') || name.Contains('\\'))
            {
                throw new ArchiveWritingException(
                    $"the node name '{name}' carries a path separator; a node name is a name, never a path");
            }

            entries.Add(new ArchiveEntry(
                name,
                BuildNode(child, depth + 1, ref depthReached),
                child.Metadata.ModifiedUtc));
        }

        return writer.Write(entries);
    }

    /// <summary>The writer claiming this extension, or null when none does.</summary>
    private IArchiveWriter? Match(string extension)
        => _writers.FirstOrDefault(
            w => w.Extension.Equals(extension, StringComparison.OrdinalIgnoreCase));

    /// <summary>
    /// The failure for a node that must be an archive and names no writer. RAR gets its own message
    /// because it is a permanent property of the format rather than a typo, and an operator who
    /// hits it must not spend an afternoon correcting a name that was never the problem.
    /// </summary>
    private static ArchiveWritingException NoWriter(FileNode node)
        => node.Metadata.Extension.Equals(".rar", StringComparison.OrdinalIgnoreCase)
            ? new ArchiveWritingException(
                $"'{node.Metadata.Name}' holds entries and is named .rar, and RAR cannot be written "
                + "— the format is proprietary and is readable but not writable here. Re-target the "
                + "node to .zip or .tar.")
            : new ArchiveWritingException(
                $"'{node.Metadata.Name}' holds entries but its extension "
                + $"'{node.Metadata.Extension}' names no archive writer");
}
```

- [ ] **Step 4: Run the tests**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: PASS, all 11.

C# does not allow a `ref` parameter inside a lambda, so `Match` takes no `ref` and the `switch` expression above passes `ref depthReached` only to ordinary method calls — which is legal. If the compiler objects to `ref` in the switch arms, convert it to a `switch` statement with explicit `return`s; the behaviour is identical.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(collapser): ArchiveBuilder -- the four node cases and the recursion

Bytes pass through, entries pack, null produces the format's canonical empty
archive (which is exactly what the expander's false-HEALTHY guards still
admit -- that is the loop closing), and entries under an extension naming no
writer fail before any child is materialised.

The depth guard is checked DURING the walk, unlike the expander's, because
the depth arrives with the document rather than being chosen. It is the second
guard: the deserializer's own MaxDepth refuses a deep document first."
```

---

## Task 7: `ArchiveCollapserProcessor`

**Files:**
- Create: `src/Processor.ArchiveCollapser/ArchiveCollapserProcessor.cs`
- Test: `src/tests/BaseApi.Tests/ArchiveCollapser/ProcessorArchiveCollapserTests.cs`

**Interfaces:**
- Consumes: `ArchiveBuilder`, `CollapseResult` (Task 6); `FileNode`, `FileDocument.Options`, `CollapsedFile`, `CollapsedFileJson.Options` (Task 3); `ArchiveCollapserConfig` (Task 2).
- Produces: `internal sealed class ArchiveCollapserProcessor : BaseProcessor<ArchiveCollapserConfig>`.

- [ ] **Step 1: Write the failing tests**

```csharp
using System.Text;
using System.Text.Json;
using BaseApi.Tests.Support;
using BaseProcessor.Core.Processing;
using Messaging.Contracts;
using Messaging.Transport;
using NSubstitute;
using Processor.ArchiveCollapser;
using Processor.ArchiveCollapser.Writers;
using Processor.ArchiveExpander.Extractors;
using Xunit;

namespace BaseApi.Tests.ArchiveCollapser;

public sealed class ProcessorArchiveCollapserTests
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

    private static byte[] Document(FileNode node)
        => JsonSerializer.SerializeToUtf8Bytes(node, FileDocument.Options);

    /// <summary>Runs the real processor and returns the single branch it sent, or throws.</summary>
    private static async Task<ProcessedData> Run(byte[] data, string payload = "")
    {
        var sender = Substitute.For<IQueueSender>();
        var sends = new List<ProcessedData>();
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(sends.Add),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());

        var processor = new ArchiveCollapserProcessor(
            new RecordingLogger<ArchiveCollapserProcessor>(),
            new ArchiveBuilder([new ZipWriter(), new TarWriter()]));
        processor.BeginDispatch(new DispatchState(sender, C, W, S, P));

        await processor.ExecuteAsync(data, payload, E, CancellationToken.None);

        return Assert.Single(sends);
    }

    private static JsonElement Envelope(ProcessedData sent)
        => JsonDocument.Parse(sent.Data).RootElement;

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("{}")]
    [InlineData("""{"MaxDepth":3,"SomethingElse":"x"}""")]
    public async Task EveryPayloadIsAccepted(string payload)
    {
        // THE EXPLICIT INVERSE OF ArchiveExpander, WHICH REJECTS A NULL PAYLOAD. Nothing here reads
        // the config, so nothing may reject it. If someone later "fixes" this by adding a null
        // check to match the expander, these four cases are what fails. Do not delete them.
        var sent = await Run(Document(Leaf("orders.csv", "id")), payload);

        Assert.Equal("orders.csv", Envelope(sent).GetProperty("fileName").GetString());
    }

    [Fact]
    public async Task ThePlainFileEnvelopeCarriesEveryFieldFromTheRootNode()
    {
        var created = new DateTime(2026, 1, 2, 3, 4, 5, DateTimeKind.Utc);
        var modified = new DateTime(2026, 6, 7, 8, 9, 10, DateTimeKind.Utc);

        // Distinct values on purpose: two NotNull checks would pass just as happily if a reader
        // TRANSPOSED the two fields. Pinning each to its own value is what catches a swap.
        var node = new FileNode(
            new FileMetadata("orders.csv", ".csv", 7, created, modified, 0),
            new FileContent.Bytes(Encoding.UTF8.GetBytes("id,name")));

        var e = Envelope(await Run(Document(node)));

        Assert.Equal("orders.csv", e.GetProperty("fileName").GetString());
        Assert.Equal(".csv", e.GetProperty("extension").GetString());
        Assert.Equal(7, e.GetProperty("sizeBytes").GetInt64());
        Assert.Equal(created, e.GetProperty("createdUtc").GetDateTime());
        Assert.Equal(modified, e.GetProperty("modifiedUtc").GetDateTime());
        Assert.Equal("id,name", Encoding.UTF8.GetString(e.GetProperty("content").GetBytesFromBase64()));
    }

    [Fact]
    public async Task SizeBytesIsTheArchiveProducedNotWhatTheDocumentDeclared()
    {
        // The declared number is decoration and loses to the content. A wrong value upstream must
        // not propagate into the envelope as if it were a fact.
        var node = new FileNode(
            new FileMetadata("orders.zip", ".zip", 999_999, null, Stamp, 1),
            new FileContent.Entries([Leaf("a.csv", "id")]));

        var e = Envelope(await Run(Document(node)));

        var content = e.GetProperty("content").GetBytesFromBase64();
        Assert.Equal(content.Length, e.GetProperty("sizeBytes").GetInt64());
        Assert.NotEqual(999_999, e.GetProperty("sizeBytes").GetInt64());
    }

    [Fact]
    public async Task ANullTimestampIsEmittedAsNullRatherThanOmitted()
    {
        // The envelope schema requires every key to be PRESENT. DefaultIgnoreCondition.Never is
        // what guarantees it, and this is the assertion of that.
        var e = Envelope(await Run(Document(Leaf("orders.csv", "id"))));

        Assert.Equal(JsonValueKind.Null, e.GetProperty("createdUtc").ValueKind);
    }

    [Fact]
    public async Task TheBranchReusesTheDispatchExecutionId()
    {
        // A transform continues the lineage it was handed. Not NewExecutionId().
        var sent = await Run(Document(Leaf("orders.csv", "id")));

        Assert.Equal(E, sent.ExecutionId);
    }

    [Fact]
    public async Task ADocumentThatIsNotJsonFailsWithoutQuotingIt()
    {
        var ex = await Assert.ThrowsAsync<FailedException>(
            () => Run(Encoding.UTF8.GetBytes("{ this is not json")));

        Assert.Equal(
            "input branch did not carry a file document: the branch is not a file document",
            ex.Message);

        // The parse error quotes the fragment that failed, and that fragment is upstream content.
        Assert.DoesNotContain("this is not json", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ARootNodeWithNoNameFails()
    {
        // The envelope schema declares fileName with minLength 1, so this cannot produce a valid
        // envelope. Caught here rather than one hop later, where the failure carries EntryId.Empty,
        // no payload and no name.
        var node = new FileNode(
            new FileMetadata("", "", 0, null, null, 0),
            new FileContent.Bytes([]));

        var ex = await Assert.ThrowsAsync<FailedException>(() => Run(Document(node)));

        Assert.Equal(
            "input branch did not carry a file document: the root node carries no name",
            ex.Message);
    }

    [Fact]
    public async Task AnUnpackableNodeFailsOnTheCollapsingTemplate()
    {
        var node = new FileNode(
            new FileMetadata("orders.csv", ".csv", 1, null, Stamp, 1),
            new FileContent.Entries([Leaf("a.csv", "id")]));

        var ex = await Assert.ThrowsAsync<FailedException>(() => Run(Document(node)));

        Assert.StartsWith("collapsing orders.csv failed: ", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnArchiveDocumentProducesAnArchiveTheRealExtractorCanOpen()
    {
        var node = new FileNode(
            new FileMetadata("orders.zip", ".zip", 0, null, Stamp, 2),
            new FileContent.Entries([Leaf("a.csv", "id"), Leaf("b.csv", "x")]));

        var content = Envelope(await Run(Document(node))).GetProperty("content").GetBytesFromBase64();

        using var stream = new MemoryStream(content, writable: false);
        Assert.Equal(["a.csv", "b.csv"], new ZipExtractor().Extract(stream).Select(e => e.Name).ToArray());
    }
}
```

Check `DispatchState`'s constructor order and `RecordingLogger`'s namespace against `src/tests/BaseApi.Tests/ArchiveExpander/ProcessorArchiveExpanderTests.cs` before running — copy whatever that file does rather than trusting the shape above.

- [ ] **Step 2: Run to verify failure**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: FAIL — `ArchiveCollapserProcessor` does not exist.

- [ ] **Step 3: Implement the processor**

```csharp
using System.Text.Json;
using BaseProcessor.Core.Processing;
using Microsoft.Extensions.Logging;
using Processor.ArchiveCollapser.Writers;

namespace Processor.ArchiveCollapser;

/// <summary>
/// Turns one structured document back into one raw file. The inverse of
/// <c>ArchiveExpanderProcessor</c>, and like it a plain downstream transform: it has an input and it
/// produces output, so it is not an edge and neither <c>BaseImporter</c> nor <c>BaseExporter</c>
/// applies.
/// <para>
/// <b>It performs no file IO.</b> There is no <c>FileInfo</c> in this assembly and no volume mount
/// on this pod. The document arrives on the branch and the archive leaves on one.
/// </para>
/// </summary>
internal sealed class ArchiveCollapserProcessor(
    ILogger<ArchiveCollapserProcessor> logger,
    ArchiveBuilder builder)
    : BaseProcessor<ArchiveCollapserConfig>
{
    protected override async Task ProcessAsync(
        byte[] data, ArchiveCollapserConfig? config, Guid executionId, CancellationToken ct)
    {
        // config IS DELIBERATELY UNREAD, AND THERE IS NO VALIDATION STEP HERE.
        //
        // ArchiveExpanderProcessor opens with `if (config is null) throw BadPayload(...)`. This one
        // must not: the payload holds nothing, because the depth is a property of the document that
        // arrived rather than a choice a workflow author makes. Null is legal, {} is legal, and a
        // payload left over from another step is legal.
        //
        // ProcessorArchiveCollapserTests.EveryPayloadIsAccepted is what fails if this is ever
        // "fixed" back into symmetry with the expander.
        var root = ReadDocument(data);

        CollapseResult built;
        try
        {
            built = builder.Build(root);
        }
        catch (ArchiveWritingException ex)
        {
            // A document that cannot be packed. Deterministic -- it fails identically on every
            // redelivery -- so it is a failed step, not something to park. No log here: the
            // framework writes this message verbatim when it catches the exception, and a line here
            // would emit every failure twice.
            //
            // ONE TYPE, NOT A LIST OF LIBRARY TYPES. Each writer wraps its own library's faults, for
            // the reason ArchiveWritingException records. Bare Exception is deliberately NOT caught:
            // a NullReferenceException in the builder is a programming error, and reporting it as a
            // bad document buries a bug under a plausible business failure.
            throw new FailedException($"collapsing {root.Metadata.Name} failed: {ex.Message}");
        }

        // The SHAPE of the result, never its content. A count, a size and a depth are safe to log;
        // the bytes are upstream data and stay out of every template in this system.
        //
        // THE DEPTH IS HERE BECAUSE THIS IS THE ONLY PLACE IT SURVIVES. The outbound envelope says
        // nothing about depth, so if the input schema row is not registered -- which is the whole of
        // phase 1 -- nothing else records how deep the document actually was.
        //
        // The entry count is the builder's, counted from content, not the document's declared
        // metadata.entryCount: the array is the fact and the count is derived.
        logger.LogInformation(
            "collapsed {FileName} of {EntryCount} entries into {SizeBytes} bytes, from depth {DepthReached}",
            root.Metadata.Name, built.EntryCount, built.Archive.LongLength, built.DepthReached);

        var envelope = new CollapsedFile(
            root.Metadata.Name,
            root.Metadata.Extension,
            // What was BUILT, not what the document declared. See CollapsedFile.
            built.Archive.LongLength,
            root.Metadata.CreatedUtc,
            root.Metadata.ModifiedUtc,
            built.Archive);

        // ONE branch, on the execution id this dispatch arrived with. Not NewExecutionId(): this is
        // a transform, not a source, so the lineage it was handed is the lineage it continues.
        await SendToPostAsync(
            JsonSerializer.SerializeToUtf8Bytes(envelope, CollapsedFileJson.Options),
            executionId,
            ct).ConfigureAwait(false);
    }

    /// <summary>
    /// The document this dispatch carries, or a failed step saying why there isn't one.
    /// <para>
    /// The parse is wrapped rather than left to throw: a malformed upstream record is a business
    /// failure with a diagnosis, not a framework exception with a sanitized message.
    /// </para>
    /// </summary>
    private static FileNode ReadDocument(byte[] data)
    {
        FileNode? node;
        var reason = "the branch is not a file document";

        try
        {
            node = JsonSerializer.Deserialize<FileNode>(data, FileDocument.Options);
        }
        catch (JsonException)
        {
            // Swallowed on purpose. The exception's text quotes the fragment that failed to parse,
            // and that fragment is upstream content -- it must not reach a log store. The class of
            // fault is what is reported; the ids in the open scope are how it is traced back.
            //
            // This also catches a document deeper than JsonSerializerOptions.MaxDepth, which is the
            // FIRST depth guard -- FileNodeConverter.Read recurses, so a pathologically deep
            // document must be refused before ArchiveBuilder's own bound is reached.
            node = null;
        }

        if (node is not null)
        {
            if (node.Metadata.Name is not { Length: > 0 })
            {
                // The envelope schema declares fileName with minLength 1. Caught here rather than
                // one hop later, where the post handler reports Failed with EntryId Guid.Empty, no
                // payload and no name -- nothing an operator could act on.
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

- [ ] **Step 4: Run the whole suite**

```bash
dotnet build SK_P.sln
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: PASS — including `ArchiveCollapserHostTests` from Task 2, which is the gate proving the DI graph resolves now that every type exists.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(collapser): the processor -- read, build, log the shape, send one branch

No Validate and no BadPayload: the payload holds nothing, so nothing may
reject it. The expander's `config is null` rejection is deliberately absent
and EveryPayloadIsAccepted is what fails if it is added back.

The JsonException message is discarded rather than surfaced -- it quotes the
fragment that failed to parse, and that fragment is upstream content. The root
name is checked here because the envelope schema requires minLength 1 and a
failure one hop later carries EntryId.Empty and no name.

sizeBytes is the archive produced, entryCount is counted from content, and
the branch reuses the dispatch execution id."
```

---

## Task 8: The identity tests

**Files:**
- Modify: `src/tests/BaseApi.Tests/EnvelopeContractTests.cs`

**Interfaces:**
- Consumes: everything from Tasks 3-7, plus the existing `Fetch` and `Expand` helpers.
- Produces: a `Collapse` helper mirroring them.

- [ ] **Step 1: Add the `Collapse` helper**

Beside the existing `Fetch` and `Expand` in `EnvelopeContractTests`:

```csharp
    /// <summary>Runs the real collapser over a document and returns the envelope it sent.</summary>
    private static async Task<byte[]> Collapse(byte[] document)
    {
        var sender = Substitute.For<IQueueSender>();
        var sends = new List<ProcessedData>();
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(sends.Add),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());

        var collapser = new Processor.ArchiveCollapser.ArchiveCollapserProcessor(
            new RecordingLogger<Processor.ArchiveCollapser.ArchiveCollapserProcessor>(),
            new Processor.ArchiveCollapser.ArchiveBuilder(
            [
                new Processor.ArchiveCollapser.Writers.ZipWriter(),
                new Processor.ArchiveCollapser.Writers.TarWriter(),
            ]));
        collapser.BeginDispatch(new BaseProcessor.Core.Processing.DispatchState(sender, C, W, S, P));

        // The payload is empty and that is not an oversight: this processor reads none.
        await collapser.ExecuteAsync(document, string.Empty, E, CancellationToken.None);

        return Assert.Single(sends).Data;
    }

    /// <summary>The bytes inside an envelope's base64 `content`.</summary>
    private static byte[] ContentOf(byte[] envelope)
        => JsonDocument.Parse(envelope).RootElement.GetProperty("content").GetBytesFromBase64();

    /// <summary>A zip holding one zip, built by the collapser so tier 2 starts from our own output.</summary>
    private static byte[] NestedZip()
        => new Processor.ArchiveCollapser.Writers.ZipWriter().Write(
        [
            new Processor.ArchiveCollapser.Writers.ArchiveEntry(
                "inner.zip",
                new Processor.ArchiveCollapser.Writers.ZipWriter().Write(
                [
                    new Processor.ArchiveCollapser.Writers.ArchiveEntry(
                        "a.csv", Encoding.UTF8.GetBytes("id"), new DateTime(2026, 3, 4, 5, 6, 8, DateTimeKind.Utc)),
                ]),
                new DateTime(2026, 3, 4, 5, 6, 10, DateTimeKind.Utc)),
            new Processor.ArchiveCollapser.Writers.ArchiveEntry(
                "b.csv", Encoding.UTF8.GetBytes("id,name"), new DateTime(2026, 3, 4, 5, 6, 12, DateTimeKind.Utc)),
        ]);
```

- [ ] **Step 2: Write tier 1 — the plain file, byte-identical**

```csharp
    [Fact]
    public async Task TIER1_APlainFileRoundTripsToAByteIdenticalEnvelope()
    {
        // THE PRIMARY ASSERTION, at its simplest: ArchiveExpander's INPUT data equals
        // ArchiveCollapser's OUTPUT data, byte for byte, every field.
        //
        // Distinct timestamps on purpose -- see APlainFileSurvivesBothHops for why two NotNull
        // checks cannot see a transposition. Do not collapse these into one constant.
        var created = new DateTime(2026, 1, 2, 3, 4, 5, DateTimeKind.Utc);
        var modified = new DateTime(2026, 6, 7, 8, 9, 10, DateTimeKind.Utc);

        var envelope = await Fetch(
            "orders.csv", Encoding.UTF8.GetBytes("id,name"), AnyFile, created, modified);

        var collapsed = await Collapse(await Expand(envelope, """{"MaxDepth":2}"""));

        Assert.Equal(envelope, collapsed);
    }
```

- [ ] **Step 3: Write tier 2 — a nested archive we built, byte-identical**

```csharp
    [Fact]
    public async Task TIER2_ANestedArchiveWeBuiltRoundTripsToAByteIdenticalEnvelope()
    {
        // THE REAL PROOF, at depth 2. Starting from an archive THIS SYSTEM produced, the loop is
        // byte-exact: same writer, same Optimal level, same entry order (the document's array
        // preserves it and ZipArchive.Entries enumerates in write order), timestamps already
        // clamped so the second pass moves nothing.
        //
        // This is also the case that exercises the recursive descent on both sides -- the expander's
        // walk down, the collapser's walk back up, and FileNodeConverter in both directions.
        var envelope = await Fetch("orders.zip", NestedZip(), AnyFile);

        var collapsed = await Collapse(await Expand(envelope, """{"MaxDepth":2}"""));

        Assert.Equal(envelope, collapsed);
    }

    [Fact]
    public async Task TIER2_TheLoopIsAFixedPointAcrossASecondPass()
    {
        // Collapse, expand, collapse: the second envelope equals the first. This is what makes
        // "consistent with ArchiveExpander" an assertion instead of a claim -- timestamps, ordering
        // and compression all stop moving after the first hop.
        var envelope = await Fetch("orders.zip", NestedZip(), AnyFile);

        var once = await Collapse(await Expand(envelope, """{"MaxDepth":2}"""));
        var twice = await Collapse(await Expand(once, """{"MaxDepth":2}"""));

        Assert.Equal(once, twice);
    }
```

- [ ] **Step 4: Write tier 3 — a foreign archive, document-level identity only**

```csharp
    [Fact]
    public async Task TIER3_AForeignArchiveKeepsWhatTheDocumentRecordsButNotItsBytes()
    {
        // A zip built by the TEST's own helper rather than by ZipWriter -- a stand-in for 7-Zip,
        // zip(1) or Python. Re-encoding cannot reproduce another implementation's deflate stream,
        // its extra fields, its per-entry compression method or its directory entries.
        //
        // THIS IS A PROPERTY OF ROUND-TRIPPING THROUGH A LOSSY INTERMEDIATE, NOT A DEFECT. It is
        // asserted so that nobody reads tier 2 passing and files a bug that tier 3 does not have.
        var envelope = await Fetch("orders.zip", Zip(("a.csv", "id"), ("b.csv", "id,name")), AnyFile);

        var document = await Expand(envelope, """{"MaxDepth":2}""");
        var collapsed = await Collapse(document);

        // Everything the document records survives.
        var e = JsonDocument.Parse(collapsed).RootElement;
        Assert.Equal("orders.zip", e.GetProperty("fileName").GetString());
        Assert.Equal(".zip", e.GetProperty("extension").GetString());

        using var stream = new MemoryStream(ContentOf(collapsed), writable: false);
        var entries = new ZipExtractor().Extract(stream);
        Assert.Equal(["a.csv", "b.csv"], entries.Select(x => x.Name).Order().ToArray());
        Assert.Equal("id,name", Encoding.UTF8.GetString(entries.Single(x => x.Name == "b.csv").Content));

        // And the bytes do not. Asserted rather than merely omitted, so the boundary is documented
        // by a test instead of by a comment somebody can delete.
        Assert.NotEqual(envelope, collapsed);
    }

    [Fact]
    public async Task TIER3_ButTheSECONDPassIsAFixedPoint()
    {
        // Once a foreign archive has been through the loop once, it is OUR archive -- so from the
        // second pass onward tier 2's byte identity applies. This is the bridge between the tiers.
        var envelope = await Fetch("orders.zip", Zip(("a.csv", "id"), ("b.csv", "id,name")), AnyFile);

        var once = await Collapse(await Expand(envelope, """{"MaxDepth":2}"""));
        var twice = await Collapse(await Expand(once, """{"MaxDepth":2}"""));

        Assert.Equal(once, twice);
    }
```

- [ ] **Step 5: Write the known-loss tests**

```csharp
    [Fact]
    public async Task LOSS_DirectoriesAreFlattenedAndThatIsExpected()
    {
        // ArchiveExpander records entry.Name, never FullName, so the document has never carried
        // directory structure. Pinned as an expected fact rather than left to surprise someone.
        var envelope = await Fetch("orders.zip", Zip(("sub/a.csv", "id")), AnyFile);

        var collapsed = await Collapse(await Expand(envelope, """{"MaxDepth":2}"""));

        using var stream = new MemoryStream(ContentOf(collapsed), writable: false);
        Assert.Equal("a.csv", Assert.Single(new ZipExtractor().Extract(stream)).Name);
    }

    [Fact]
    public async Task LOSS_NestedNodesCarryNoCreationTimeSoNoneIsWrittenBack()
    {
        // Archives record no creation time; only a modification time, and not in every format. The
        // ROOT's createdUtc survives because it rides the envelope, not the archive.
        var created = new DateTime(2026, 1, 2, 3, 4, 5, DateTimeKind.Utc);

        var envelope = await Fetch("orders.zip", NestedZip(), AnyFile, created);
        var collapsed = await Collapse(await Expand(envelope, """{"MaxDepth":2}"""));

        Assert.Equal(
            created,
            JsonDocument.Parse(collapsed).RootElement.GetProperty("createdUtc").GetDateTime());
    }
```

- [ ] **Step 6: Run the suite**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: PASS.

**If tier 1 or tier 2 fails on byte equality**, diff the two envelopes as JSON before touching anything — the likely causes in order are: a timestamp offset bug in `ZipWriter.Clamp` (Task 4 Step 5), `sizeBytes` taken from the document rather than the archive, or a property-ordering difference from a serializer options mismatch between `FetchedFileJson.Options` and `CollapsedFileJson.Options`. **Do not weaken these to structural assertions** — byte identity at tiers 1 and 2 is the deliverable of this whole plan.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "test: the identity tests -- expander input equals collapser output

Three tiers at depth 2. A plain file and an archive this system built are
BYTE-identical envelopes, every field. A foreign archive keeps everything the
document records and not its bytes -- re-encoding cannot reproduce another
implementation's deflate stream, extra fields or per-entry compression, which
is a property of a lossy intermediate rather than a defect, and is asserted so
nobody files a bug against it.

Both fixed-point tests pin the bridge: once a foreign archive has been through
the loop once it is our archive, so from the second pass tier 2 applies."
```

---

## Task 9: Deployment

**Files:**
- Create: `src/Processor.ArchiveCollapser/Dockerfile`
- Create: `k8s/39-processor-archivecollapser.yaml`
- Modify: `k8s/kustomization.yaml`
- Create: `src/Processor.ArchiveCollapser/packages.lock.json` (generated)

- [ ] **Step 1: Generate the lock file**

```bash
dotnet restore src/Processor.ArchiveCollapser/Processor.ArchiveCollapser.csproj
```

Confirm `packages.lock.json` appeared. If it did not, `RestorePackagesWithLockFile` is set per-project rather than in `Directory.Build.props` — copy the property from `src/Processor.ArchiveExpander/Processor.ArchiveExpander.csproj`.

- [ ] **Step 2: Write the Dockerfile**

Copy `src/Processor.ArchiveExpander/Dockerfile`, replacing every `ArchiveExpander` with `ArchiveCollapser` and `archiveexpander` with `archivecollapser`. **Keep all five `COPY src/*/nuget/` lines unchanged** — NuGet validates every source in `NuGet.config` at restore and fails a missing one with `NU1301` whether or not the project resolves anything from it.

- [ ] **Step 3: Write the manifest**

Copy `k8s/37-processor-archiveexpander.yaml` to `k8s/39-processor-archivecollapser.yaml`, rename every `archiveexpander` to `archivecollapser`, **delete the `ArchiveExpander__MaxExpandedBytes` env var entirely**, and replace the memory-limit comment block at the top with:

```yaml
# processor-archivecollapser — turns one structured document back into one raw file, packing
# zip/tar archives from the {metadata, content} tree ArchiveExpander produces. A downstream
# transform: it has an input and it produces output, so it is neither an importer nor an exporter.
# No Service — its only inbound traffic is the kubelet hitting the pod IP for probes.
#
# EXPECT IT TO SIT NOT-READY UNTIL A PROCESSOR ROW EXISTS, exactly as the other processors do.
# `kubectl rollout status` will time out; that timeout is the expected signal, not a fault.
#
# THE MEMORY LIMIT IS 768Mi TO MATCH ARCHIVEEXPANDER, AND THE ARGUMENT IS THE CONTRACT, NOT THE
# NEIGHBOUR. This processor's input schema IS ArchiveExpander's output schema, so whatever that pod
# is provisioned to produce, this one is obliged to hold. Sizing it lower would mean a document the
# upstream pod may legally emit is one this pod cannot receive — and that failure is an OOM, which
# is a POISON MESSAGE and not a failed step: the author never returns, the input key is never
# reclaimed, RabbitMQ requeues the unacked dispatch, and the replacement pod dies the same way,
# taking down every workflow on that queue. Raise ArchiveExpander's limit and you must raise this
# one.
#
# THERE IS NO SIZE CEILING ENV VAR HERE, DELIBERATELY, and it is not an omission left from a copy.
# ArchiveExpander__MaxExpandedBytes guards a genuine unknown: nobody knows what a zip expands to
# until it is opened. Here there is no unknown — the size IS the document, and the document is
# already resident before the transform is entered, so a ceiling could only refuse work whose
# memory had already been spent. What sizes this pod is: the inbound document, its decoded tree
# (~0.75x, base64 being 1.33x), the archive under construction, and that archive base64'd into the
# outbound envelope. The sizing input arrives from upstream and the only knob is the limit below.
```

- [ ] **Step 4: Add to kustomization**

In `k8s/kustomization.yaml`, after `38-processor-filefetcher.yaml`:

```yaml
  - 39-processor-archivecollapser.yaml
```

- [ ] **Step 5: Verify both**

```bash
docker build -f src/Processor.ArchiveCollapser/Dockerfile -t processor-archivecollapser:local .
kubectl kustomize k8s/ > /dev/null && echo "kustomize OK"
```

Expected: image builds, kustomize renders without error.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "build(collapser): Dockerfile, manifest and kustomization

768Mi to match ArchiveExpander, and the manifest states the argument: this
pod's input schema IS that pod's output schema, so whatever the expander may
legally emit this one is obliged to hold, and undersizing it produces an OOM
-- a poison message, not a failed step.

No size-ceiling env var, and the comment says why it is absent rather than
leaving it to read as a copy-paste omission."
```

---

## Task 10: The live suite, and gating the two schema-row tests

**Files:**
- Create: `src/tests/BaseApi.Tests/Live/ArchiveCollapser/ArchiveCollapserLiveTests.cs`
- Modify: `src/tests/BaseApi.Tests/Live/ArchiveExpander/ArchiveExpanderLiveTests.cs`
- Modify: `src/tests/BaseApi.Tests/Live/FileFetcher/FileFetcherLiveTests.cs`

- [ ] **Step 1: Gate the two existing schema-row tests**

`ArchiveExpanderLiveTests.TheOutputSchemaRowIsRegistered` and `FileFetcherLiveTests.TheOutputSchemaRowIsRegistered` assert a non-null `OutputSchemaId`. Phase 1 registers every id null, so both go red **by design**. A red live suite is how a real failure becomes invisible, so gate them explicitly:

```csharp
    [Fact(Skip = "Phase 1 registers every schema id null -- see the ArchiveCollapser design, " +
                 "section 1.1. Re-armed by phase 2, which registers the two schema rows.")]
```

Do not delete them and do not weaken the assertion. The skip reason is what carries the intent to whoever runs phase 2.

- [ ] **Step 2: Write the live suite**

Copy `src/tests/BaseApi.Tests/Live/ArchiveExpander/ArchiveExpanderLiveTests.cs` as the template — match its fixture, its collection attribute and its **single five-minute window per suite** (established by commit `f084bfc`; do not reintroduce per-assertion literals). Adapt the assertions to the collapser: a document published to its in queue produces an envelope on the out queue, and the log line `collapsed {FileName} ...` appears within the window.

**Do not** copy a `TheOutputSchemaRowIsRegistered` equivalent yet — it belongs to phase 2, Task 12.

Read the expander's file before writing this one; its fixture wiring is not reproduced here because it must match exactly rather than approximately.

- [ ] **Step 3: Run the hermetic suite**

```bash
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: PASS, with the two gated tests reported as skipped. Live tests skip outside a real cluster.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test(live): collapser suite, and gate the two schema-row tests for phase 1

Phase 1 registers every schema id null, so both TheOutputSchemaRowIsRegistered
tests fail by design -- that is exactly what they exist to catch. Skipped with
a reason naming the design section rather than deleted or weakened, so phase 2
knows to re-arm them."
```

---

# PHASE 2 — register the rows and turn the contracts on

Do not start phase 2 until Task 8's tiers 1 and 2 pass. They are the proof; the schemas add what identity cannot say.

## Task 11: Re-root the tree schema to depth 2

**Files:**
- Modify: `src/tests/BaseApi.Tests/Schemas/tree.json`
- Modify: `src/tests/BaseApi.Tests/Schemas/README.md`

- [ ] **Step 1: Write the failing test**

In `src/tests/BaseApi.Tests/ArchiveExpander/ArchiveExpanderSchemaTests.cs`:

```csharp
    [Fact]
    public void ADepthTwoDocumentValidates()
    {
        // A zip inside a zip, both expanded -- three levels of node. The baseline rooted at depth1
        // admits root -> leaves and no more, so this is the assertion that the re-rooting landed.
        var document = Serialize(
            Archive("outer.zip", Archive("inner.zip", Leaf("a.csv", ".csv", "id"))));

        Assert.True(
            ProcessorJsonSchemaValidator.TryValidate(Definition(), document, out var errors),
            string.Join("; ", errors));
    }

    [Fact]
    public void ADepthOneDocumentStillValidates()
    {
        // The widening must be BACKWARD COMPATIBLE: depth1 admits string content, so a shallow
        // document is still legal. If this fails, the re-rooting replaced a level instead of adding
        // one.
        var document = Serialize(Archive("outer.zip", Leaf("a.csv", ".csv", "id")));

        Assert.True(
            ProcessorJsonSchemaValidator.TryValidate(Definition(), document, out var errors),
            string.Join("; ", errors));
    }
```

- [ ] **Step 2: Run to verify the first fails**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: `ADepthTwoDocumentValidates` FAILS, `ADepthOneDocumentStillValidates` passes.

- [ ] **Step 3: Re-root `tree.json`**

Change `"$ref": "#/$defs/depth1"` to `"$ref": "#/$defs/depth2"` and add this as the first entry of `$defs`, leaving `depth1`, `depth0` and `metadata` exactly as they are:

```json
    "depth2": {
      "type": "object",
      "additionalProperties": false,
      "required": ["metadata", "content"],
      "properties": {
        "metadata": { "$ref": "#/$defs/metadata" },
        "content": {
          "type": ["string", "array", "null"],
          "items": { "$ref": "#/$defs/depth1" }
        }
      }
    },
```

- [ ] **Step 4: Run — both pass**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: PASS.

- [ ] **Step 5: Rewrite the README's depth section**

`Schemas/README.md` currently documents depth 1 as the baseline and uses depth 2 as its worked example of how to extend. State that the baseline is now depth 2, and replace the worked example with the next level up so the file still teaches the rule rather than describing the state before this change:

```json
    "$ref": "#/$defs/depth3",

    "depth3": {
      "type": "object", "additionalProperties": false,
      "required": ["metadata", "content"],
      "properties": {
        "metadata": { "$ref": "#/$defs/metadata" },
        "content": { "type": ["string", "array", "null"],
                     "items": { "$ref": "#/$defs/depth2" } }
      }
    },
```

Each level is the same object with `items` pointing one step shallower, leaving every existing definition untouched. Then add:

```markdown
**The widening from depth 1 to depth 2 was a deliberate LOOSENING, and it has a cost.** A depth-1
document still validates, because `depth1` admits string content — so nothing broke. But a step
running at `MaxDepth: 1` and producing a shallow document is no longer distinguishable by this
schema from one that should have gone deeper. The schema now says less about what a given feed
should look like, which is precisely why per-feed variants exist below.
```

Also retitle the file: it is no longer "ArchiveExpander output schema" but the README for both shapes and all three processors.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(schema): tree.json roots at depth2

A zip inside a zip, both expanded, is three levels of node; the baseline
admitted two. Backward compatible -- depth1 admits string content, so shallow
documents still validate, asserted alongside.

Records that this is a deliberate loosening: a MaxDepth 1 step producing a
shallow document is no longer distinguishable by the schema from one that
should have gone deeper."
```

---

## Task 12: Register the rows and re-arm the live tests

**Files:**
- Modify: `k8s/README.md`
- Modify: `src/tests/BaseApi.Tests/Live/ArchiveExpander/ArchiveExpanderLiveTests.cs`
- Modify: `src/tests/BaseApi.Tests/Live/FileFetcher/FileFetcherLiveTests.cs`
- Create: a `TheSchemaRowsAreRegistered` fact in `ArchiveCollapserLiveTests.cs`

- [ ] **Step 1: Register the two schema rows**

**Two rows, not four.** `SchemaEdgeValidator` compares schema **ids**, not definitions — it refuses to publish a workflow whose parent output id differs from its child input id. So both processors on a shape must point at the *same* row.

```bash
kubectl -n skp port-forward svc/baseapi-service 8080:8080 &

# The envelope shape.
curl -X POST http://localhost:8080/api/v1.0/schemas \
  -H 'Content-Type: application/json' \
  -d "$(jq -Rs '{name:"file-envelope", version:"1.0.0", definition:.}' \
        src/tests/BaseApi.Tests/Schemas/envelope.json)"

# The tree shape.
curl -X POST http://localhost:8080/api/v1.0/schemas \
  -H 'Content-Type: application/json' \
  -d "$(jq -Rs '{name:"file-tree", version:"1.0.0", definition:.}' \
        src/tests/BaseApi.Tests/Schemas/tree.json)"
```

Confirm the exact request body against `src/BaseApi.Service/Features/Schema/` DTOs before running — the field names above are a best guess at the shape and the DTO is the authority.

- [ ] **Step 2: Point the three processors at them**

`PUT` each processor row with the two ids, per this mapping:

| processor | `inputSchemaId` | `outputSchemaId` |
|---|---|---|
| `file-fetcher` | null (it is a source) | **envelope** |
| `archive-expander` | **envelope** | **tree** |
| `archive-collapser` | **tree** | **envelope** |

Note that the same two GUIDs appear five times. That is the point: it is what makes Fetcher → Expander → Collapser a wireable chain and anything else a publish-time rejection.

- [ ] **Step 3: Re-arm the two gated tests**

Remove the `Skip = "Phase 1 ..."` argument from `ArchiveExpanderLiveTests.TheOutputSchemaRowIsRegistered` and `FileFetcherLiveTests.TheOutputSchemaRowIsRegistered`, restoring them to plain `[Fact]`.

- [ ] **Step 4: Add the collapser's equivalent**

In `ArchiveCollapserLiveTests`, mirroring the expander's version — read that one and copy its BaseApi query shape:

```csharp
    [Fact]
    public async Task TheSchemaRowsAreRegistered()
    {
        // Proves this build's half landed. No row means the image was rebuilt without repointing
        // the source hash; a null id means the schema was never registered, and with a null
        // TryValidate returns true without decoding anything -- so a document arriving downstream
        // would prove only that a document was produced.
        var row = await GetProcessorBySourceHashAsync("archive-collapser");

        Assert.NotNull(row);
        Assert.NotNull(row!.InputSchemaId);
        Assert.NotNull(row.OutputSchemaId);
    }

    [Fact]
    public async Task TheCollapserInputIdEqualsTheExpanderOutputId()
    {
        // THE EDGE, and the only assertion that catches the two rows drifting apart. Byte-identical
        // definitions are not enough -- SchemaEdgeValidator compares ids, so two rows holding the
        // same JSON are still an unwireable edge.
        var expander = await GetProcessorBySourceHashAsync("archive-expander");
        var collapser = await GetProcessorBySourceHashAsync("archive-collapser");

        Assert.Equal(expander!.OutputSchemaId, collapser!.InputSchemaId);
    }
```

- [ ] **Step 5: Run the live suite against the cluster**

```bash
$env:SKP_REALSTACK = "1"
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: PASS. Supervise the RabbitMQ port-forward — it dies during a run and produces failures that look like product faults. If `dotnet test` reports failures without names, run `src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe` directly.

- [ ] **Step 6: Document the registration in `k8s/README.md`**

Extend the existing "Register both processor rows and their schema rows" section to three processors and two shared rows, with the table from Step 2 and the reason the ids are shared rather than merely equal.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: register the two schema rows and re-arm the live gates

Two rows, not four. SchemaEdgeValidator compares schema IDs, not definitions,
so both processors on a shape must point at the same row -- byte-identical
JSON in two rows is still an unwireable edge, which is what
TheCollapserInputIdEqualsTheExpanderOutputId now catches.

The same two GUIDs appear five times across three processors. That is what
makes Fetcher -> Expander -> Collapser a wireable chain and anything else a
publish-time rejection."
```

---

## Self-Review

**Spec coverage:** §1 → Tasks 2, 12. §1.1 → phase split, Tasks 10, 12. §2 → Tasks 2-8. §3 → Task 2 Step 3, Task 7 (`EveryPayloadIsAccepted`). §4 → Task 2 Step 4, Task 9 Step 3. §5 → Task 7. §6 → Tasks 3, 7. §7 cases 1-4 → Task 6. §7 depth → Tasks 3 (converter), 6 (builder). §7.1 → Task 1. §7.2 → Task 11. §8 → Tasks 4, 5. §9 → Task 9. §10 tiers → Task 8; unit files → Tasks 3-7; live → Tasks 10, 12. §11 → Task 4 (clamp), Task 5 (no clamp). §12 → nothing to build.

**Known gaps, called out rather than hidden:**
- `ArchiveCollapserSchemaTests` and `ArchiveCollapserEnvelopeTests` from spec §10 are **not separate files** — their assertions live in `ProcessorArchiveCollapserTests` (envelope) and `ArchiveExpanderSchemaTests` (schema, since both shapes are now shared files). Splitting them would duplicate fixtures for no reviewer benefit.
- Task 12's `curl` bodies are a best guess at the schema-creation DTO and each step says so. The DTO in `src/BaseApi.Service/Features/Schema/` is the authority and must be checked before running.
- Task 10 Step 2 does not reproduce the live fixture wiring; it directs the implementer to read the expander's suite and match it exactly, because approximating a fixture produces a suite that skips silently.

**Type consistency:** `ArchiveEntry` / `IArchiveWriter` / `ArchiveWritingException` (Task 4) are used unchanged in Tasks 5-8. `CollapseResult(byte[] Archive, int DepthReached, int EntryCount)` (Task 6) is consumed with those exact names in Task 7. `FileDocument.Options` and `CollapsedFileJson.Options` (Task 3) are used in Tasks 7-8. `ArchiveBuilder.MaxSupportedDepth` (Task 6) is referenced by the Task 6 test only.
