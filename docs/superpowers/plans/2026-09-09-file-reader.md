# FileReader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `Processor.FileReader`, a downstream processor that turns an absolute file path into one recursive `{metadata, content}` document, expanding zip/tar/rar archives to a configured depth.

**Architecture:** A plain `BaseProcessor<FileReaderConfig>` — not an edge. `FileReaderProcessor.ProcessAsync` is *dry*: it validates config, parses the locator, checks extension and size from `FileInfo`, and reads bytes without ever opening the file's contents. It hands those bytes to `FileContentBuilder`, which resolves an `IArchiveExtractor` by the file's leading bytes, expands until `MaxDepth` is reached or nothing left is an archive, and builds the document. One `SendToPostAsync` on the dispatch's own `executionId`.

> **THE CODE BLOCKS IN TASKS 4-8 ARE THE CURRENT SOURCE, NOT THE STATE AT THE TIME THOSE TASKS
> RAN.** They were refreshed from `src/` after Task 11, which collapsed the node from
> `{metadata, content, entries}` to `{metadata, content}`, moved extractor selection from
> `ExpectedExtension` onto the file's signature, and made depth configurable. **The step ORDER and
> the narrative still record the original sequence** — Task 5 still introduces zip and Task 8 still
> introduces the schema — so a step's prose may describe a smaller thing than the file it now shows.
> Where the two differ, the file is right, and Task 11 is where the difference is explained.

**Tech Stack:** .NET 8, xunit.v3, NSubstitute, `System.IO.Compression` (zip), `System.Formats.Tar` (tar), SharpCompress 1.0.0 (rar, read-only), JsonSchema.Net (validation, already present).

**Spec:** `docs/superpowers/specs/2026-09-09-file-reader-design.md`

## Global Constraints

- **Target framework `net8.0`.** Set in `Directory.Build.props`. Never redeclare it in a csproj.
- **`TreatWarningsAsErrors` is on**, with `Nullable` and `ImplicitUsings` enabled and `EnforceCodeStyleInBuild`. Code must build clean.
- **Central Package Management.** Versions live in `Directory.Packages.props`. A `PackageReference` carries **no** `Version` attribute — except the repo's own libraries, which use `VersionOverride="[1.0.0]"`.
- **Offline restore.** `NuGet.config` clears nuget.org. Every package must exist in `nugets/` or a project-local `nuget/` feed. `RestorePackagesWithLockFile` is true, so each project has a `packages.lock.json` that must be regenerated when references change.
- **`NuGetAudit` is promoted to a build error.** A package with an advisory fails the build.
- **Reference `BaseProcessor.Core` as a package**, `<PackageReference Include="BaseProcessor.Core" VersionOverride="[1.0.0]" />`, never a `ProjectReference` — `SourceHash.targets` ships in the package's `build/` folder and only a PackageReference flows it.
- **Document JSON is camelCase.** `MessagingJson`'s PascalCase governs the `ProcessedData` envelope only.
- **Never log file content.** Log the path, the shape, the reason. Never `data`, never `content`.
- **All failures are `FailedException`.** No retries, no transient class. `PostSendException` from `SendToPostAsync` propagates untouched.
- **Do NOT log a failure before throwing.** `ProcessDispatchHandler` catches `FailedException` and logs `"the author reported the step failed: {Reason}"` with `ex.Message` **verbatim**, so the templates below already reach the log store in full; a pre-throw line emits every failure twice. `BaseImporter` and `BaseExporter` both rely on that catch and log nothing themselves. (Corrected 2026-09-09 mid-execution — an earlier draft of this plan and its spec mandated the pre-throw log on a wrong premise. The **messages** are unchanged; only the duplicate copy is gone.)
- **The `FailedException` message templates are the contract** an operator's saved queries match, and must be reproduced character for character: `input branch did not name a file path: {Reason}` · `step payload rejected: {Reason}` · `file {FilePath} rejected: {Reason}` · `reading {FilePath} failed: {Reason}` · `extracting {FilePath} failed: {Reason}`.
- **Use `Path.IsPathFullyQualified`, never `Path.IsPathRooted`, to mean "absolute."** `IsPathRooted` is true for a Windows drive-relative path like `\foo\bar.csv`. Production is Linux, where they agree; the tests run on Windows, where they do not.

---

### Task 1: Project shell and the SharpCompress vendor step

Creates the project, vendors the one new package, and proves the offline restore still holds. No behaviour yet — the deliverable is "the solution builds and this host's service graph resolves".

**Files:**
- Create: `nugets/sharpcompress.1.0.0.nupkg` (downloaded binary)
- Modify: `Directory.Packages.props`
- Create: `src/Processor.FileReader/Processor.FileReader.csproj`
- Create: `src/Processor.FileReader/Program.cs`
- Create: `src/Processor.FileReader/ProcessorHost.cs`
- Create: `src/Processor.FileReader/FileReaderProcessor.cs`
- Create: `src/Processor.FileReader/FileReaderConfig.cs`
- Create: `src/Processor.FileReader/appsettings.json`
- Create: `src/Processor.FileReader/Dockerfile`
- Modify: `src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
- Modify: `SK_P.sln`
- Test: `src/tests/BaseApi.Tests/FileReader/ProcessorFileReaderTests.cs`

**Interfaces:**
- Consumes: nothing.
- Produces: `Processor.FileReader.FileReaderProcessor : BaseProcessor<FileReaderConfig>`; `Processor.FileReader.FileReaderConfig(string ExpectedExtension, long MinimumSizeBytes, long MaximumSizeBytes, int MaxDepth = 1) : ProcessorConfig` *(`MaxDepth` arrived in Task 11)*; `Processor.FileReader.ProcessorHost.Create(string[] args, ProcessorIdentityFound identity, Action<IConfigurationBuilder>? configure = null)` returning `IHost`.

- [ ] **Step 1: Vendor the package**

```bash
curl -s -m 120 -o nugets/sharpcompress.1.0.0.nupkg \
  https://api.nuget.org/v3-flatcontainer/sharpcompress/1.0.0/sharpcompress.1.0.0.nupkg
unzip -l nugets/sharpcompress.1.0.0.nupkg | grep 'lib/net8.0'
```

Expected: `lib/net8.0/SharpCompress.dll` listed. The net8.0 dependency group in its nuspec is empty, so no other package needs vendoring.

- [ ] **Step 2: Pin the version**

In `Directory.Packages.props`, immediately after the `Confluent.Kafka` block:

```xml
    <!-- RAR reading for Processor.FileReader, the one archive format with no in-box reader.
         MIT, and its net8.0 dependency group is EMPTY — the .NET Framework and netstandard2.0
         groups pull four compatibility packages, net8.0 pulls none — so vendoring it into the
         offline feed cost exactly one file with no transitive closure to chase.
         It READS rar and cannot write one, which is sufficient here and is why the rar test
         fixture is a committed binary rather than one the test builds. -->
    <PackageVersion Include="SharpCompress" Version="1.0.0" />
```

- [ ] **Step 3: Create the csproj**

`src/Processor.FileReader/Processor.FileReader.csproj`:

```xml
<Project Sdk="Microsoft.NET.Sdk">

  <!--
    A concrete processor, and the first that reads the filesystem. Like every other processor here
    it carries no identity, liveness, broker or Redis code — AddBaseProcessor folds all of it in.

    Common properties (net8.0, Nullable, ImplicitUsings, TreatWarningsAsErrors) come from
    Directory.Build.props, and package versions from Directory.Packages.props — never declare
    either here.
  -->

  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <RootNamespace>Processor.FileReader</RootNamespace>
    <AssemblyName>Processor.FileReader</AssemblyName>
  </PropertyGroup>

  <ItemGroup>
    <!-- FileContentBuilder, FileLocator and FileDocument are internal: they are this processor's
         construction, not its surface, and nothing outside should bind to them. The tests DO
         construct them directly — a builder tested only through the processor cannot be given an
         empty extractor set — so the test assembly is named here, matching what
         BaseProcessor.Core does for the same reason. -->
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
    <!-- RAR only. Zip and tar are in-box. -->
    <PackageReference Include="SharpCompress" />
  </ItemGroup>

</Project>
```

Create a placeholder `src/Processor.FileReader/schema/output.json` containing `{}` so the `Content` include resolves; Task 8 writes the real schema.

- [ ] **Step 4: Create the config record**

`src/Processor.FileReader/FileReaderConfig.cs`:

```csharp
using BaseProcessor.Core.Configuration;

namespace Processor.FileReader;

/// <summary>
/// The step payload. Flat and scalar, bound case-insensitively by
/// <see cref="ProcessorConfig.SerializerOptions"/>, which also ignores unknown properties so a field
/// added later does not break workflows authored before it.
/// <para>
/// <b>There is no ExpectedEntryCount here, and that is a decision.</b> Entry count is the one
/// expectation only knowable AFTER the archive is opened, so checking it in the payload saves
/// nothing; it lives in the output schema instead. Extension and size are knowable from
/// <c>FileInfo</c>, and checking them here is what stops the file being read at all.
/// </para>
/// </summary>
/// <param name="ExpectedExtension">Leading dot, compared case-insensitively — <c>".zip"</c>.</param>
/// <param name="MinimumSizeBytes">Floor, inclusive. Zero disables the check.</param>
/// <param name="MaximumSizeBytes">
/// Ceiling, inclusive, for THIS step. Admitted only if it fits inside the pod's own ceiling — see
/// <see cref="FileReaderOptions"/>.
/// </param>
public sealed record FileReaderConfig(
    string ExpectedExtension,
    long MinimumSizeBytes,
    long MaximumSizeBytes) : ProcessorConfig;
```

- [ ] **Step 5: Create the processor stub**

`src/Processor.FileReader/FileReaderProcessor.cs`:

```csharp
using BaseProcessor.Core.Processing;
using Microsoft.Extensions.Logging;

namespace Processor.FileReader;

/// <summary>
/// Turns a file path into one structured document. A plain downstream transform: it has an input and
/// it produces output, so it is not an edge and neither <c>BaseImporter</c> nor <c>BaseExporter</c>
/// applies.
/// </summary>
public sealed class FileReaderProcessor(ILogger<FileReaderProcessor> logger)
    : BaseProcessor<FileReaderConfig>
{
    protected override Task ProcessAsync(
        byte[] data, FileReaderConfig? config, Guid executionId, CancellationToken ct)
    {
        _ = logger;
        throw new NotImplementedException("Task 2 onwards");
    }
}
```

- [ ] **Step 6: Copy the host, program, appsettings and Dockerfile**

Copy `src/Processor.Sample/ProcessorHost.cs`, `Program.cs`, `appsettings.json` and `Dockerfile` into `src/Processor.FileReader/`, then in each replace the namespace `Processor.Sample` with `Processor.FileReader`, `SampleProcessor` with `FileReaderProcessor`, and every `Processor.Sample` path or assembly name in the Dockerfile with `Processor.FileReader`. Leave every comment in `ProcessorHost.cs` intact — the two-stage boot reasoning is unchanged here.

- [ ] **Step 7: Register the project**

```bash
dotnet sln SK_P.sln add src/Processor.FileReader/Processor.FileReader.csproj
```

In `src/tests/BaseApi.Tests/BaseApi.Tests.csproj`, in the ItemGroup holding the other processor references, after the `Processor.KafkaExporter` line:

```xml
    <ProjectReference Include="..\..\Processor.FileReader\Processor.FileReader.csproj" />
```

- [ ] **Step 8: Write the failing test**

`src/tests/BaseApi.Tests/FileReader/ProcessorFileReaderTests.cs`:

```csharp
using BaseProcessor.Core.Identity;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Processor.FileReader;
using Xunit;

namespace BaseApi.Tests.FileReader;

public sealed class ProcessorFileReaderTests
{
    private static readonly ProcessorIdentityFound Identity = new(
        Guid.Parse("6f2a1d04-7c55-4a0e-9b1f-8d3e2c7a5b90"),
        InputSchemaId: null, OutputSchemaId: null, ConfigSchemaId: null,
        Name: "file-reader", Version: "1.0.0");

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

        Assert.IsType<FileReaderProcessor>(resolved);
    }
}
```

- [ ] **Step 9: Restore, regenerate lock files, run**

```bash
dotnet restore SK_P.sln
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj --filter-class BaseApi.Tests.FileReader.ProcessorFileReaderTests
```

Expected: restore succeeds against the offline feed with no NU1101 (package missing) and no `NuGetAudit` error; `src/Processor.FileReader/packages.lock.json` is created; both tests PASS.

If restore reports an advisory on SharpCompress 1.0.0, stop and report it — the fix is a different version, and that is a decision, not a silent substitution.

- [ ] **Step 10: Commit**

```bash
git add nugets/sharpcompress.1.0.0.nupkg Directory.Packages.props SK_P.sln \
        src/Processor.FileReader src/tests/BaseApi.Tests/FileReader \
        src/tests/BaseApi.Tests/BaseApi.Tests.csproj src/tests/BaseApi.Tests/packages.lock.json
git commit -m "feat(filereader): the shell, and one vendored package for rar"
```

---

### Task 2: The locator

The input branch is the KafkaImporter's record value verbatim — JSON naming an absolute path. `providerName` rides along in the org's records and is deliberately ignored.

**Files:**
- Create: `src/Processor.FileReader/FileLocator.cs`
- Modify: `src/Processor.FileReader/FileReaderProcessor.cs`
- Test: `src/tests/BaseApi.Tests/FileReader/FileReaderLocatorTests.cs`

**Interfaces:**
- Consumes: `FileReaderConfig` (Task 1).
- Produces: `internal sealed record FileLocator(string? FilePath)`.

- [ ] **Step 1: Write the failing test**

`src/tests/BaseApi.Tests/FileReader/FileReaderLocatorTests.cs`:

```csharp
using System.Text;
using BaseApi.Tests.Support;
using BaseProcessor.Core.Processing;
using Messaging.Contracts;
using Messaging.Transport;
using NSubstitute;
using Processor.FileReader;
using Xunit;

namespace BaseApi.Tests.FileReader;

public sealed class FileReaderLocatorTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");
    private static readonly Guid E = Guid.Parse("55555555-5555-5555-5555-555555555555");

    private const string Payload =
        """{"ExpectedExtension":".csv","MinimumSizeBytes":0,"MaximumSizeBytes":1024}""";

    private static (FileReaderProcessor Processor, RecordingLogger<FileReaderProcessor> Log) Build()
    {
        var log = new RecordingLogger<FileReaderProcessor>();
        var processor = new FileReaderProcessor(log);
        processor.BeginDispatch(new DispatchState(Substitute.For<IQueueSender>(), C, W, S, P));
        return (processor, log);
    }

    private static Task Run(FileReaderProcessor processor, string json)
        => processor.ExecuteAsync(Encoding.UTF8.GetBytes(json), Payload, E, CancellationToken.None);

    [Fact]
    public async Task AnInputThatIsNotJsonFailsTheStep()
    {
        var (processor, _) = Build();

        var ex = await Assert.ThrowsAsync<FailedException>(() => Run(processor, "not json"));

        Assert.Contains("did not name a file path", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnInputWithNoFilePathFailsTheStep()
    {
        var (processor, _) = Build();

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => Run(processor, """{"providerName":"acme"}"""));

        Assert.Contains("did not name a file path", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ARelativePathFailsTheStep()
    {
        // The contract is an ABSOLUTE path. A relative one would resolve against the pod's working
        // directory, which is not a location any workflow author chose.
        var (processor, _) = Build();

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => Run(processor, """{"filePath":"orders.csv"}"""));

        Assert.Contains("did not name a file path", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task TheFailureMessageNamesTheClassOfFault()
    {
        // Step failures log at Information here, so the MESSAGE is what an operator searches — and
        // ProcessDispatchHandler writes this exact text verbatim when it catches the exception. The
        // author logs nothing itself; a second copy would double every failure record. So the
        // template is pinned on the exception, which is where it actually lives.
        var (processor, _) = Build();

        var ex = await Assert.ThrowsAsync<FailedException>(() => Run(processor, "not json"));

        Assert.StartsWith("input branch did not name a file path: ", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ADriveRelativePathFailsTheStep()
    {
        // Path.IsPathRooted would accept this on Windows: it is rooted but not fully qualified, and
        // the contract is an absolute path. Production is Linux, where the two agree; the tests run
        // on Windows, where they do not.
        var (processor, _) = Build();

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => Run(processor, """{"filePath":"\orders.csv"}"""));

        Assert.Contains("did not name a file path", ex.Message, StringComparison.Ordinal);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj --filter-class BaseApi.Tests.FileReader.FileReaderLocatorTests`
Expected: FAIL with `NotImplementedException`.

- [ ] **Step 3: Write the locator**

`src/Processor.FileReader/FileLocator.cs`:

```csharp
namespace Processor.FileReader;

/// <summary>
/// The input contract: what the upstream importer's record carries. Bound with
/// <c>ProcessorConfig.SerializerOptions</c>, which is case-insensitive and ignores unknown
/// properties — so the org's <c>providerName</c> arrives, binds to nothing, and is dropped.
/// <para>
/// <b>providerName is deliberately absent from this record.</b> It is redundant: <c>filePath</c> is
/// absolute and complete. Adding it here would put it one edit away from the output document, and
/// the design says it appears nowhere in the output.
/// </para>
/// </summary>
internal sealed record FileLocator(string? FilePath);
```

- [ ] **Step 4: Parse it in the processor**

Replace the body of `ProcessAsync` in `src/Processor.FileReader/FileReaderProcessor.cs`:

```csharp
using System.Text.Json;
using BaseProcessor.Core.Configuration;
using BaseProcessor.Core.Processing;
using Microsoft.Extensions.Logging;

namespace Processor.FileReader;

public sealed class FileReaderProcessor(ILogger<FileReaderProcessor> logger)
    : BaseProcessor<FileReaderConfig>
{
    protected override Task ProcessAsync(
        byte[] data, FileReaderConfig? config, Guid executionId, CancellationToken ct)
    {
        var path = ReadPath(data);

        _ = config;
        _ = executionId;
        _ = ct;
        throw new NotImplementedException($"Task 3 onwards: {path}");
    }

    /// <summary>
    /// The absolute path this dispatch names, or a failed step saying why there isn't one.
    /// <para>
    /// The parse is wrapped rather than left to throw: a malformed upstream record is a business
    /// failure with a diagnosis, not a framework exception with a sanitized message.
    /// </para>
    /// </summary>
    private string ReadPath(byte[] data)
    {
        FileLocator? locator = null;
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
            // IsPathFullyQualified, not IsPathRooted: the latter accepts a Windows drive-relative
            // path like ooar.csv, which names no single location.
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

        // Logged BEFORE the throw. The thrown message reaches the framework; this line is what an
        // operator's saved query matches on, and step failures log at Information in this system so
        // the level distinguishes nothing.
        logger.LogInformation("input branch did not name a file path: {Reason}", reason);
        throw new FailedException($"input branch did not name a file path: {reason}");
    }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj --filter-class BaseApi.Tests.FileReader.FileReaderLocatorTests`
Expected: all four PASS. `ProcessorFileReaderTests` still passes.

- [ ] **Step 6: Commit**

```bash
git add src/Processor.FileReader/FileLocator.cs src/Processor.FileReader/FileReaderProcessor.cs \
        src/tests/BaseApi.Tests/FileReader/FileReaderLocatorTests.cs
git commit -m "feat(filereader): read the locator, and say so when there isn't one"
```

---

### Task 3: The dry guards

Config sanity, then `FileInfo` — extension and size — then the read. Nothing here opens the file's contents.

**Files:**
- Create: `src/Processor.FileReader/FileReaderOptions.cs`
- Modify: `src/Processor.FileReader/FileReaderProcessor.cs`
- Modify: `src/Processor.FileReader/ProcessorHost.cs`
- Modify: `src/Processor.FileReader/appsettings.json`
- Test: `src/tests/BaseApi.Tests/FileReader/FileReaderGuardTests.cs`

**Interfaces:**
- Consumes: `FileLocator` (Task 2), `FileReaderConfig` (Task 1).
- Produces: `public sealed class FileReaderOptions { public long MaxFileSizeBytes { get; set; } }`; `FileReaderProcessor(ILogger<FileReaderProcessor> logger, IOptions<FileReaderOptions> options)` — the constructor signature every later task and test uses.

- [ ] **Step 1: Write the failing test**

`src/tests/BaseApi.Tests/FileReader/FileReaderGuardTests.cs`:

```csharp
using System.Text;
using System.Text.Json;
using BaseApi.Tests.Support;
using BaseProcessor.Core.Processing;
using Messaging.Transport;
using Microsoft.Extensions.Options;
using NSubstitute;
using Processor.FileReader;
using Xunit;

namespace BaseApi.Tests.FileReader;

public sealed class FileReaderGuardTests : IDisposable
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");
    private static readonly Guid E = Guid.Parse("55555555-5555-5555-5555-555555555555");

    private readonly string _dir = Directory.CreateTempSubdirectory("skp-filereader-").FullName;

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    /// <summary>A real file on disk. The thing under test IS the filesystem interaction.</summary>
    private string WriteFile(string name, int bytes)
    {
        var path = Path.Combine(_dir, name);
        File.WriteAllBytes(path, new byte[bytes]);
        return path;
    }

    private static (FileReaderProcessor Processor, RecordingLogger<FileReaderProcessor> Log) Build(
        long podCeiling = 33_554_432)
    {
        var log = new RecordingLogger<FileReaderProcessor>();
        var processor = new FileReaderProcessor(
            log, Options.Create(new FileReaderOptions { MaxFileSizeBytes = podCeiling }));
        processor.BeginDispatch(new DispatchState(Substitute.For<IQueueSender>(), C, W, S, P));
        return (processor, log);
    }

    private static string Payload(string extension, long min, long max)
        => JsonSerializer.Serialize(new
        {
            ExpectedExtension = extension,
            MinimumSizeBytes = min,
            MaximumSizeBytes = max,
        });

    private static Task Run(FileReaderProcessor processor, string path, string payload)
        => processor.ExecuteAsync(
            Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { filePath = path })),
            payload, E, CancellationToken.None);

    [Fact]
    public async Task AnEmptyPayloadFailsTheStep()
    {
        // No meaningful default extension exists. Inventing one would have this processor accept
        // files nobody asked for, so an absent payload is a workflow authoring error.
        var (processor, _) = Build();

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => processor.ExecuteAsync([], "", E, CancellationToken.None));

        Assert.StartsWith("step payload rejected: ", ex.Message, StringComparison.Ordinal);
        Assert.Contains("needs ExpectedExtension", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task APayloadCeilingAboveThePodCeilingFailsTheStep()
    {
        // Not clamped. Clamping means the author asked for 100MB, got failures at 32, and nothing
        // said why.
        var (processor, _) = Build(podCeiling: 1024);
        var path = WriteFile("a.csv", 10);

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => Run(processor, path, Payload(".csv", 0, 4096)));

        Assert.StartsWith("step payload rejected: ", ex.Message, StringComparison.Ordinal);
        Assert.Contains("above this pod's ceiling", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AMissingFileFailsTheStepNamingThePath()
    {
        var (processor, _) = Build();
        var path = Path.Combine(_dir, "absent.csv");

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => Run(processor, path, Payload(".csv", 0, 4096)));

        // The message IS the operator-facing contract — ProcessDispatchHandler logs it verbatim —
        // so it is asserted here rather than on a RecordingLogger record the author no longer writes.
        Assert.Equal($"reading {path} failed: it does not exist", ex.Message);
    }

    [Fact]
    public async Task TheWrongExtensionFailsTheStep()
    {
        var (processor, _) = Build();
        var path = WriteFile("orders.txt", 10);

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => Run(processor, path, Payload(".csv", 0, 4096)));

        Assert.StartsWith($"file {path} rejected: ", ex.Message, StringComparison.Ordinal);
        Assert.Contains("expected .csv", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task TheExtensionComparisonIsCaseInsensitive()
    {
        // Windows fixtures and Linux pods disagree about case, and the extension is a business
        // expectation rather than a filesystem fact.
        var (processor, _) = Build();
        var path = WriteFile("orders.CSV", 10);

        // Reaching the not-yet-implemented read means the extension guard passed.
        await Assert.ThrowsAsync<NotImplementedException>(
            () => Run(processor, path, Payload(".csv", 0, 4096)));
    }

    [Fact]
    public async Task AFileBelowTheFloorFailsTheStep()
    {
        var (processor, _) = Build();
        var path = WriteFile("orders.csv", 5);

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => Run(processor, path, Payload(".csv", 10, 4096)));

        Assert.Contains("below the 10 byte floor", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AFileAboveTheCeilingFailsTheStep()
    {
        var (processor, _) = Build();
        var path = WriteFile("orders.csv", 5000);

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => Run(processor, path, Payload(".csv", 0, 4096)));

        Assert.Contains("above the 4096 byte ceiling", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task TheSizeGuardsRunBeforeTheFileIsOpened()
    {
        // The whole point of stage 1 being dry. An oversize file held open exclusively by another
        // process must still be REJECTED rather than reported unreadable — FileInfo.Length does not
        // need the handle that File.ReadAllBytes does.
        var (processor, _) = Build();
        var path = WriteFile("orders.csv", 5000);

        using var exclusive = new FileStream(
            path, FileMode.Open, FileAccess.Read, FileShare.None);

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => Run(processor, path, Payload(".csv", 0, 4096)));

        Assert.Contains("above the 4096 byte ceiling", ex.Message, StringComparison.Ordinal);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj --filter-class BaseApi.Tests.FileReader.FileReaderGuardTests`
Expected: FAIL to compile — `FileReaderOptions` does not exist and `FileReaderProcessor` takes one argument.

- [ ] **Step 3: Write the options**

`src/Processor.FileReader/FileReaderOptions.cs`:

```csharp
using Microsoft.Extensions.Configuration;

namespace Processor.FileReader;

/// <summary>
/// The pod's own limit, bound from the <c>"FileReader"</c> config section and set in the manifest as
/// <c>FileReader__MaxFileSizeBytes</c>.
/// <para>
/// <b>This is what the pod can survive; <see cref="FileReaderConfig.MaximumSizeBytes"/> is what a
/// valid file for a feed looks like.</b> They are different questions and both are enforced: a step
/// payload naming more than this is a config error, reported by name rather than clamped.
/// </para>
/// <para>
/// <b>It is a manifest value because a file does not cost its own size in flight.</b> The raw bytes,
/// the serialized UTF-8 document at ~1.33x, the broker message body at ~1.78x, and a full
/// JsonDocument DOM at validation can coexist — and the work and post consumers are the SAME
/// process, so a dispatch and a branch overlap. Tuning that against a container's memory limit is an
/// operator's job per environment, not a constant's.
/// </para>
/// </summary>
public sealed class FileReaderOptions
{
    /// <summary>Ceiling in bytes (default 32 MiB). The default lives here so an unset variable is
    /// never unbounded.</summary>
    [ConfigurationKeyName("MaxFileSizeBytes")]
    public long MaxFileSizeBytes { get; set; } = 33_554_432;
}
```

- [ ] **Step 4: Write the guards**

Replace `src/Processor.FileReader/FileReaderProcessor.cs` — keep `ReadPath` from Task 2 exactly as written and add the rest:

```csharp
using System.Text.Json;
using BaseProcessor.Core.Configuration;
using BaseProcessor.Core.Processing;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Processor.FileReader;

public sealed class FileReaderProcessor(
    ILogger<FileReaderProcessor> logger,
    IOptions<FileReaderOptions> options)
    : BaseProcessor<FileReaderConfig>
{
    private readonly long _podCeiling = options.Value.MaxFileSizeBytes;

    protected override Task ProcessAsync(
        byte[] data, FileReaderConfig? config, Guid executionId, CancellationToken ct)
    {
        // Config first: it is the cheapest check and it depends on nothing else. A step wired with a
        // ceiling this pod cannot honour is wrong before any file is named.
        var settings = Validate(config);

        var path = ReadPath(data);
        var info = Inspect(path, settings);

        var bytes = Read(info);

        _ = bytes;
        _ = executionId;
        _ = ct;
        throw new NotImplementedException("Task 4 onwards");
    }

    /// <summary>The payload, checked. Throws <see cref="FailedException"/> with the reason.</summary>
    private FileReaderConfig Validate(FileReaderConfig? config)
    {
        if (config is null)
        {
            // The SAME prefix as every malformed-payload case, deliberately. An absent payload and a
            // nonsensical one are the same class of workflow authoring error, and an operator
            // searching for payload faults must find both with one query rather than learning that
            // the commonest one is spelled differently.
            throw BadPayload(
                "FileReader needs ExpectedExtension, MinimumSizeBytes and MaximumSizeBytes");
        }

        if (string.IsNullOrWhiteSpace(config.ExpectedExtension)
            || !config.ExpectedExtension.StartsWith('.'))
        {
            throw BadPayload($"ExpectedExtension must start with a dot; the payload named "
                                          + $"'{config.ExpectedExtension}'");
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
                + $"{_podCeiling}; raise FileReader__MaxFileSizeBytes or lower the step");
        }

        return config;
    }

    /// <summary>
    /// The dry inspection: existence, extension, size. Every one of these reads metadata only —
    /// <c>FileInfo</c> never opens the file — so a file that fails here is never opened at all.
    /// </summary>
    private FileInfo Inspect(string path, FileReaderConfig config)
    {
        var info = new FileInfo(path);

        if (!info.Exists)
        {
            // "reading", not "rejected": an absent file is not a file that broke a rule, and the two
            // classes are searched separately.
            throw Unreadable(path, "it does not exist");
        }

        var extension = info.Extension;
        if (!extension.Equals(config.ExpectedExtension, StringComparison.OrdinalIgnoreCase))
        {
            throw Rejected(path,
                $"expected {config.ExpectedExtension} and the file is '{extension}'");
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
    private byte[] Read(FileInfo info)
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
    // failure twice — which is why BaseImporter and BaseExporter log nothing either. The message
    // text IS the contract an operator searches; only the duplicate copy is gone.

    /// <summary>A malformed payload, diagnosed before any path has been read.</summary>
    private static FailedException BadPayload(string reason)
        => new($"step payload rejected: {reason}");

    /// <summary>A file that broke a rule. Separate from BadPayload because this one has a path.</summary>
    private static FailedException Rejected(string path, string reason)
        => new($"file {path} rejected: {reason}");

    /// <summary>A file that could not be read, whatever the cause.</summary>
    private static FailedException Unreadable(string path, string reason)
        => new($"reading {path} failed: {reason}");

    // ... ReadPath from Task 2, unchanged ...
}
```

- [ ] **Step 5: Bind the options in the host**

In `src/Processor.FileReader/ProcessorHost.cs`, immediately before the `AddSingleton<...BaseProcessor, FileReaderProcessor>()` line:

```csharp
        // The pod's ceiling, from FileReader__MaxFileSizeBytes in the manifest. Same shape as the
        // Kafka processors' broker address: infrastructure limits come from configuration, business
        // expectations come from the step payload.
        builder.Services.Configure<FileReaderOptions>(builder.Configuration.GetSection("FileReader"));
```

And in `src/Processor.FileReader/appsettings.json`, add a top-level section so a local run has the same default the code carries:

```json
  "FileReader": {
    "MaxFileSizeBytes": 33554432
  },
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj --filter-class BaseApi.Tests.FileReader.FileReaderGuardTests`
Expected: all eight PASS. `FileReaderLocatorTests` needs its `Build` helper updated to the two-argument constructor — do that in this task and re-run both classes.

- [ ] **Step 7: Commit**

```bash
git add src/Processor.FileReader src/tests/BaseApi.Tests/FileReader
git commit -m "feat(filereader): the dry guards, all of them before the file is opened"
```

---

### Task 4: The document, for a plain file

The leaf path end to end: a non-archive file becomes a root node whose `content` is its bytes, and one branch is sent on the dispatch's own execution id.

**Files:**
- Create: `src/Processor.FileReader/FileNode.cs`
- Create: `src/Processor.FileReader/FileContentBuilder.cs`
- Modify: `src/Processor.FileReader/FileReaderProcessor.cs`
- Modify: `src/Processor.FileReader/ProcessorHost.cs`
- Test: `src/tests/BaseApi.Tests/FileReader/FileReaderDocumentTests.cs`

**Interfaces:**
- Consumes: the guards (Task 3).
- Produces: `public sealed record FileMetadata(string Name, string Extension, long SizeBytes, DateTime? CreatedUtc, DateTime? ModifiedUtc, int EntryCount)`; `public sealed record FileNode(FileMetadata Metadata, FileContent? Content)` with `public abstract record FileContent` and its `Bytes`/`Entries` cases, plus `public sealed class FileNodeConverter : JsonConverter<FileNode>` *(the node was `(Metadata, byte[]? Content, IReadOnlyList<FileNode> Entries)` until Task 11)*; `internal static class FileDocument { public static readonly JsonSerializerOptions Options; }`; `internal sealed class FileContentBuilder { public FileBuildResult Build(byte[] bytes, FileInfo info, FileReaderConfig config); }` *(the return type was `FileNode` until Task 11)*. `FileReaderProcessor(ILogger<FileReaderProcessor>, IOptions<FileReaderOptions>, FileContentBuilder)`.

- [ ] **Step 1: Write the failing test**

`src/tests/BaseApi.Tests/FileReader/FileReaderDocumentTests.cs`:

```csharp
using System.Text;
using System.Text.Json;
using BaseApi.Tests.Support;
using BaseProcessor.Core.Processing;
using Messaging.Contracts;
using Messaging.Transport;
using Microsoft.Extensions.Options;
using NSubstitute;
using Processor.FileReader;
using Xunit;

namespace BaseApi.Tests.FileReader;

public sealed class FileReaderDocumentTests : IDisposable
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");
    private static readonly Guid E = Guid.Parse("55555555-5555-5555-5555-555555555555");

    private readonly string _dir = Directory.CreateTempSubdirectory("skp-filereader-doc-").FullName;

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    private string WriteText(string name, string text)
    {
        var path = Path.Combine(_dir, name);
        File.WriteAllText(path, text);
        return path;
    }

    private static (FileReaderProcessor Processor, IQueueSender Sender) Build()
    {
        var sender = Substitute.For<IQueueSender>();
        var processor = new FileReaderProcessor(
            new RecordingLogger<FileReaderProcessor>(),
            Options.Create(new FileReaderOptions()),
            new FileContentBuilder([]));
        processor.BeginDispatch(new DispatchState(sender, C, W, S, P));
        return (processor, sender);
    }

    private static async Task<List<ProcessedData>> SendsOf(
        IQueueSender sender, FileReaderProcessor processor, string path, string payload, Guid executionId)
    {
        var sends = new List<ProcessedData>();
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(sends.Add),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());

        await processor.ExecuteAsync(
            Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { filePath = path })),
            payload, executionId, CancellationToken.None);

        return sends;
    }

    private const string CsvPayload =
        """{"ExpectedExtension":".csv","MinimumSizeBytes":0,"MaximumSizeBytes":4096}""";

    [Fact]
    public async Task APlainFileBecomesOneRootLeaf()
    {
        var (processor, sender) = Build();
        var path = WriteText("orders.csv", "id,name\n");

        var sends = await SendsOf(sender, processor, path, CsvPayload, E);

        var doc = JsonDocument.Parse(Assert.Single(sends).Data).RootElement;
        Assert.Equal("orders.csv", doc.GetProperty("metadata").GetProperty("name").GetString());
        Assert.Equal(".csv", doc.GetProperty("metadata").GetProperty("extension").GetString());
        Assert.Equal(8, doc.GetProperty("metadata").GetProperty("sizeBytes").GetInt64());
        Assert.Equal(0, doc.GetProperty("metadata").GetProperty("entryCount").GetInt32());
        Assert.Equal("id,name\n", Encoding.UTF8.GetString(doc.GetProperty("content").GetBytesFromBase64()));
    }

    [Fact]
    public async Task TheBranchReusesTheDispatchsExecutionId()
    {
        // This processor is a transform, not a source. Minting a new id would orphan the lineage it
        // was handed, and reusing one across several branches would make the lineage joins count
        // more than one where they expect one. Exactly one branch, on the id that arrived.
        var (processor, sender) = Build();
        var path = WriteText("orders.csv", "id\n");

        var sends = await SendsOf(sender, processor, path, CsvPayload, E);

        Assert.Equal(E, Assert.Single(sends).ExecutionId);
    }

    [Fact]
    public async Task ThePropertyNamesAreCamelCase()
    {
        // MessagingJson is PascalCase and governs the ProcessedData envelope, not these bytes. The
        // schema in Task 8 pins camelCase, and a drift here fails it one hop later where the branch
        // is DISCARDED rather than reported — so it is pinned in a unit test too.
        var (processor, sender) = Build();
        var path = WriteText("orders.csv", "id\n");

        var sends = await SendsOf(sender, processor, path, CsvPayload, E);

        var json = Encoding.UTF8.GetString(Assert.Single(sends).Data);
        Assert.Contains("\"metadata\"", json, StringComparison.Ordinal);
        Assert.Contains("\"sizeBytes\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain("\"Metadata\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain("\"SizeBytes\"", json, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnArchiveWithNoRegisteredExtractorIsALeaf()
    {
        // A leaf for TWO independent reasons, and either alone would do it: no extractor is
        // registered in these tests, and these bytes are not a zip whatever the name says.
        // The second is the one that holds in production - the extractor is chosen by
        // signature, and ExpectedExtension only admitted the file to the step.
        var (processor, sender) = Build();
        var path = WriteText("bundle.zip", "not really a zip");

        var sends = await SendsOf(sender, processor, path,
            """{"ExpectedExtension":".zip","MinimumSizeBytes":0,"MaximumSizeBytes":4096}""", E);

        var doc = JsonDocument.Parse(Assert.Single(sends).Data).RootElement;
        Assert.Equal(JsonValueKind.String, doc.GetProperty("content").ValueKind);
        Assert.Equal(0, doc.GetProperty("metadata").GetProperty("entryCount").GetInt32());
    }

    [Fact]
    public async Task TheDocumentNeverMentionsProviderName()
    {
        // It rides in on the upstream record and is redundant. The design says it appears nowhere in
        // the output, and this is the test that keeps it true.
        var (processor, sender) = Build();
        var path = WriteText("orders.csv", "id\n");

        var sends = new List<ProcessedData>();
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(sends.Add),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());
        await processor.ExecuteAsync(
            Encoding.UTF8.GetBytes(
                JsonSerializer.Serialize(new { filePath = path, providerName = "acme-feed" })),
            CsvPayload, E, CancellationToken.None);

        var json = Encoding.UTF8.GetString(Assert.Single(sends).Data);
        Assert.DoesNotContain("acme", json, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("provider", json, StringComparison.OrdinalIgnoreCase);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj --filter-class BaseApi.Tests.FileReader.FileReaderDocumentTests`
Expected: FAIL to compile — `FileContentBuilder` does not exist.

- [ ] **Step 3: Write the document records**

`src/Processor.FileReader/FileNode.cs`:

```csharp
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Processor.FileReader;

/// <summary>
/// File info, and nothing derived from the file's contents. <c>DateTime</c> rather than
/// <c>DateTimeOffset</c> so <c>System.Text.Json</c> renders a UTC instant as <c>...Z</c> rather than
/// <c>+00:00</c> — the shape the output schema documents.
/// </summary>
/// <param name="EntryCount">
/// How many entries the node holds. Derived from <see cref="FileNode.Content"/> and present for a
/// reader's convenience — the SCHEMA constrains the array, never this, because a counting bug here
/// must not be able to satisfy a rule the content fails.
/// </param>
public sealed record FileMetadata(
    string Name,
    string Extension,
    long SizeBytes,
    DateTime? CreatedUtc,
    DateTime? ModifiedUtc,
    int EntryCount);

/// <summary>
/// What a node holds: either the bytes of a file, or the nodes an archive expanded to. Never both.
/// <para>
/// <b>This is a union, and it replaces a pair of fields that could contradict each other.</b> The
/// node was <c>(Metadata, byte[]? Content, IReadOnlyList&lt;FileNode&gt; Entries)</c>, which encoded
/// the leaf/archive distinction TWICE — null content and empty entries — and nothing stopped a bug
/// from setting both or neither. A closed hierarchy makes the illegal states unrepresentable, and it
/// is why <c>content</c> is one key in the document rather than two.
/// </para>
/// <para>
/// C# has no union type, so this is the nearest thing the language offers: an abstract record with a
/// private constructor, which nothing outside this file can extend.
/// <see cref="FileNodeConverter"/> is what turns it into one JSON value.
/// </para>
/// </summary>
public abstract record FileContent
{
    // Private, so the two nested records below are the only cases that will ever exist. A third case
    // added later is a deliberate edit here, not an accident somewhere else.
    private FileContent()
    {
    }

    /// <summary>A file's own bytes. Rendered as a base64 string.</summary>
    public sealed record Bytes(byte[] Value) : FileContent;

    /// <summary>
    /// What an archive expanded to. Rendered as an array of nodes.
    /// <para>
    /// <b>An archive that expanded to nothing is null, not this holding an empty list</b> — see
    /// <see cref="FileNode.Content"/>.
    /// </para>
    /// </summary>
    public sealed record Entries(IReadOnlyList<FileNode> Value) : FileContent;
}

/// <summary>
/// One node of the document, and the shape is identical at every level so the schema is a single
/// self-referencing definition.
/// </summary>
/// <param name="Content">
/// The bytes, the expansion, or null.
/// <para>
/// <b>Null means no entries.</b> An archive this processor opened and found empty carries null
/// rather than an empty array. An archive it did NOT open — because the depth limit stopped it, or
/// because nothing recognised the format — carries <see cref="FileContent.Bytes"/> like any other
/// file, because an unexpanded archive is a file.
/// </para>
/// <para>
/// <b>An expanded archive never carries its own bytes as well.</b> The entries ARE its content, and
/// holding both would double the blob for no consumer.
/// </para>
/// </param>
public sealed record FileNode(FileMetadata Metadata, FileContent? Content);

/// <summary>
/// Writes <see cref="FileNode"/> as <c>{metadata, content}</c>, with <c>content</c> as a base64
/// string, an array of nodes, or null.
/// <para>
/// <b>A hand-written converter rather than <c>[JsonDerivedType]</c>.</b> System.Text.Json's
/// polymorphic support emits a <c>$type</c> discriminator property, which would appear in the
/// document and have to be admitted by the output schema — a serializer's implementation detail
/// leaking into a contract other systems read. Here the JSON value's own type IS the discriminator,
/// which is what makes the schema expressible as one <c>type: ["string", "array", "null"]</c>.
/// </para>
/// </summary>
public sealed class FileNodeConverter : JsonConverter<FileNode>
{
    private const string MetadataName = "metadata";
    private const string ContentName = "content";

    public override void Write(Utf8JsonWriter writer, FileNode value, JsonSerializerOptions options)
    {
        writer.WriteStartObject();

        writer.WritePropertyName(MetadataName);
        JsonSerializer.Serialize(writer, value.Metadata, options);

        writer.WritePropertyName(ContentName);

        switch (value.Content)
        {
            case FileContent.Bytes bytes:
                // Encodes straight into the output buffer. There is no intermediate base64 string on
                // the heap, which is why the memory budget in the design does not carry one.
                writer.WriteBase64StringValue(bytes.Value);
                break;

            case FileContent.Entries entries:
                writer.WriteStartArray();
                foreach (var entry in entries.Value)
                {
                    Write(writer, entry, options);
                }

                writer.WriteEndArray();
                break;

            default:
                // Explicitly written, never omitted: the schema requires the key to be present.
                writer.WriteNullValue();
                break;
        }

        writer.WriteEndObject();
    }

    /// <summary>
    /// The inverse. The processor only ever writes; this exists so a test can round-trip a document
    /// and assert on its shape rather than on a string.
    /// </summary>
    public override FileNode Read(
        ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType != JsonTokenType.StartObject)
        {
            throw new JsonException("a file node must be an object");
        }

        FileMetadata? metadata = null;
        FileContent? content = null;

        while (reader.Read() && reader.TokenType != JsonTokenType.EndObject)
        {
            if (reader.TokenType != JsonTokenType.PropertyName)
            {
                throw new JsonException("expected a property name");
            }

            var name = reader.GetString();
            reader.Read();

            switch (name)
            {
                case MetadataName:
                    metadata = JsonSerializer.Deserialize<FileMetadata>(ref reader, options);
                    break;

                case ContentName:
                    content = ReadContent(ref reader, options);
                    break;

                default:
                    reader.Skip();
                    break;
            }
        }

        if (metadata is null)
        {
            throw new JsonException("a file node must carry metadata");
        }

        return new FileNode(metadata, content);
    }

    private FileContent? ReadContent(ref Utf8JsonReader reader, JsonSerializerOptions options)
    {
        switch (reader.TokenType)
        {
            case JsonTokenType.Null:
                return null;

            case JsonTokenType.String:
                return new FileContent.Bytes(reader.GetBytesFromBase64());

            case JsonTokenType.StartArray:
                var entries = new List<FileNode>();
                while (reader.Read() && reader.TokenType != JsonTokenType.EndArray)
                {
                    entries.Add(Read(ref reader, typeof(FileNode), options));
                }

                return new FileContent.Entries(entries);

            default:
                throw new JsonException(
                    $"content must be a string, an array or null, and was {reader.TokenType}");
        }
    }
}

/// <summary>The one serializer configuration for the document.</summary>
internal static class FileDocument
{
    /// <summary>
    /// <b>camelCase, pinned explicitly.</b> <c>MessagingJson</c> leaves the naming policy null —
    /// PascalCase — and it governs the <c>ProcessedData</c> envelope, not the bytes inside
    /// <c>Data</c>. Inheriting its convention here would silently rename every property the output
    /// schema names.
    /// <para>
    /// <c>Never</c> ignore: <c>content</c> must be emitted as <c>null</c> on an empty archive rather
    /// than omitted, because the schema requires the key to be present. The converter writes that
    /// key unconditionally, so this setting governs <see cref="FileMetadata"/>'s nullable timestamps.
    /// </para>
    /// </summary>
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
        Converters = { new FileNodeConverter() },
    };
}
```

- [ ] **Step 4: Write the builder**

`src/Processor.FileReader/FileContentBuilder.cs`:

```csharp
using Processor.FileReader.Extractors;

namespace Processor.FileReader;

/// <summary>
/// The document, and how deep the expansion actually went.
/// <para>
/// <b>The depth is returned rather than logged here because it is the only place it survives.</b> A
/// document that fails its output schema is reported by the framework with
/// <c>EntryId: Guid.Empty</c>, no payload and no file path — so if a step's <c>MaxDepth</c> and the
/// registered schema disagree, nothing in the failure says which depth was produced. The processor
/// logs this alongside the entry count, where an operator can find it.
/// </para>
/// </summary>
internal sealed record FileBuildResult(FileNode Node, int DepthReached);

/// <summary>
/// Stage two: everything that involves looking inside the file. Stage one — the processor — is dry
/// and hands this class the bytes it already validated.
/// <para>
/// <b>The structure is hard-coded here. The output schema does not drive it and is not read.</b> The
/// schema judges the result one hop later, in the post handler; it never shapes it.
/// </para>
/// </summary>
internal sealed class FileContentBuilder(IEnumerable<IArchiveExtractor> extractors)
{
    private readonly IReadOnlyList<IArchiveExtractor> _extractors = extractors.ToList();

    /// <summary>
    /// The document. An archive is expanded until <see cref="FileReaderConfig.MaxDepth"/> is
    /// reached or nothing left is an archive, whichever comes first.
    /// </summary>
    public FileBuildResult Build(byte[] bytes, FileInfo info, FileReaderConfig config)
    {
        // THE DECLARATION CROSS-CHECK, and it applies to the top-level file ONLY.
        //
        // Choosing the extractor by signature means a file whose bytes are not an archive is simply
        // a leaf — which is right for a CSV and WRONG for a damaged zip, because the step would
        // report Completed over a file nobody can open. That is the false-HEALTHY failure each
        // extractor's internal guard exists to prevent, reached from outside those guards: a
        // corrupt header matches no signature, so no extractor is ever asked.
        //
        // Here, and only here, there is something to check the bytes against. ExpectedExtension had
        // to match this file's extension for it to be admitted at all, so a name declaring an
        // archive is a claim a workflow author made. Below this level nothing is declared — an
        // entry's name is written by whoever built the archive — so nested entries get no such
        // check and an unrecognised one is an ordinary leaf.
        //
        // A .zip that is really a tar does NOT fail: an extractor claims it by signature, and
        // reading the content is the more useful answer than refusing the name.
        if (NamedAsArchive(info.Extension) && Match(bytes) is null)
        {
            throw new ArchiveExtractionException(
                $"the file is named '{info.Extension}' and its leading bytes are no archive this "
                + "processor knows — treating it as corrupt rather than recording it as a plain file");
        }

        // ONE budget for the WHOLE tree, not one per level. Threading a running total through the
        // recursion is what keeps MaxDepth safe to raise: a per-level ceiling would let a depth-5
        // archive hold five times the limit, and the pod's memory does not care which level a byte
        // came from.
        var budget = new ExpansionBudget(config.MaximumSizeBytes);
        var depthReached = 0;

        var node = BuildNode(
            info.Name,
            info.Extension,
            bytes,
            // FileInfo.Length rather than the array's length: for the root they agree, and the
            // former is what the dry inspection already reported to an operator.
            info.Length,
            info.CreationTimeUtc,
            info.LastWriteTimeUtc,
            depth: 0,
            config.MaxDepth,
            budget,
            ref depthReached);

        return new FileBuildResult(node, depthReached);
    }

    /// <summary>
    /// One node, and its subtree.
    /// <para>
    /// <b>Plain recursion, and the bound is the reason it is safe.</b> <c>MaxDepth</c> is validated
    /// into <c>1..FileReaderConfig.MaxSupportedDepth</c> before any file is opened, so the stack
    /// here is at most that many frames deep. There is no unlimited setting for this to run away on.
    /// </para>
    /// </summary>
    private FileNode BuildNode(
        string name,
        string extension,
        byte[] bytes,
        long sizeBytes,
        DateTime? createdUtc,
        DateTime? modifiedUtc,
        int depth,
        int maxDepth,
        ExpansionBudget budget,
        ref int depthReached)
    {
        if (depth > depthReached)
        {
            depthReached = depth;
        }

        // THE BYTES DECIDE, not the name. See IArchiveExtractor.CanHandle for why this reversed:
        // below the first level there is no declared extension to trust, because an entry's name is
        // written by whoever built the archive. FileReaderConfig.ExpectedExtension still admits the
        // file to the step; it no longer chooses what opens it.
        //
        // No match is the ordinary termination: a CSV matches nothing and is a leaf.
        var extractor = depth < maxDepth ? Match(bytes) : null;

        if (extractor is null)
        {
            // A leaf, and that includes an archive the depth limit stopped us opening — an
            // unexpanded archive is a file, so it carries its own bytes exactly like any other.
            return new FileNode(
                new FileMetadata(name, extension, sizeBytes, createdUtc, modifiedUtc, EntryCount: 0),
                new FileContent.Bytes(bytes));
        }

        using var stream = new MemoryStream(bytes, writable: false);
        var entries = extractor.Extract(stream);

        var children = new List<FileNode>(entries.Count);

        foreach (var entry in entries)
        {
            // Charged BEFORE the child is built, so the budget stops the walk at the entry that
            // crosses it rather than after its whole subtree is materialised. A nested archive is
            // charged twice on purpose — once as its parent's entry, once for what it expands to —
            // because at that moment both genuinely exist in memory.
            budget.Charge(entry.Content.LongLength);

            children.Add(BuildNode(
                entry.Name,
                Path.GetExtension(entry.Name),
                entry.Content,
                entry.Content.LongLength,
                // Archives record no creation time; only a modification time, and not in every
                // format.
                createdUtc: null,
                entry.ModifiedUtc,
                depth + 1,
                maxDepth,
                budget,
                ref depthReached));
        }

        return new FileNode(
            new FileMetadata(name, extension, sizeBytes, createdUtc, modifiedUtc, children.Count),
            // Null, not an empty list: an archive that expanded to nothing has no entries, and the
            // document says so with one value rather than an empty array a reader has to interpret.
            children.Count == 0 ? null : new FileContent.Entries(children));
    }

    /// <summary>
    /// True when some registered extractor is normally named with this extension — i.e. the name
    /// claims to be an archive this processor can open.
    /// </summary>
    private bool NamedAsArchive(string extension)
        => _extractors.Any(e => e.Extension.Equals(extension, StringComparison.OrdinalIgnoreCase));

    /// <summary>The first extractor that recognises these bytes, or null when none does.</summary>
    private IArchiveExtractor? Match(ReadOnlySpan<byte> bytes)
    {
        // A plain loop rather than LINQ: a ReadOnlySpan cannot be captured by a lambda, and copying
        // the array to satisfy FirstOrDefault would allocate a second copy of every file.
        foreach (var extractor in _extractors)
        {
            if (extractor.CanHandle(bytes))
            {
                return extractor;
            }
        }

        return null;
    }

    /// <summary>
    /// THE EXPANSION CEILING, carried across the whole tree.
    /// <para>
    /// Without it the only bound anywhere is on the FILE, and an archive is exactly where that stops
    /// being the transient cost: the design and <c>k8s/37-processor-filereader.yaml</c> both price
    /// the pod at ~1.78x the file, which is right for a leaf and wrong for an archive, where the
    /// document is ~1.33x the EXPANDED content. An ordinary 10:1 CSV zip at a 32 MiB ceiling is
    /// ~320 MB expanded plus document and envelope, against a 768Mi limit.
    /// </para>
    /// <para>
    /// <b>An OOM here is not one lost message, it is a POISON MESSAGE.</b> The author never returns,
    /// so <c>ProcessDispatchHandler</c> never reclaims the input key; RabbitMQ requeues the unacked
    /// dispatch; the replacement pod reads the same key and dies the same way. One archive takes the
    /// processor down for every workflow on that queue. A <c>FailedException</c> is acked and
    /// terminal, which is the entire difference.
    /// </para>
    /// <para>
    /// <b>The honest limit of this, unchanged by depth:</b> an extractor has already materialised
    /// every entry's bytes by the time the loop above runs — the seam returns a list, and it cannot
    /// stream, because wrapping a library fault requires a try/catch and C# forbids
    /// <c>yield return</c> inside one. So this bounds the DOCUMENT and gives a deterministic, acked
    /// failure; it does not bound any single extractor's own peak. That residual is recorded rather
    /// than papered over.
    /// </para>
    /// </summary>
    private sealed class ExpansionBudget(long ceiling)
    {
        private long _spent;

        public void Charge(long bytes)
        {
            _spent += bytes;

            if (_spent <= ceiling)
            {
                return;
            }

            // ArchiveExtractionException so it lands on the contract's `extracting {FilePath}
            // failed:` template — the processor's one catch. Both numbers are named, because an
            // operator needs to see which limit was hit and by how much; "at least" is literal,
            // since the walk stops before totalling what is left.
            throw new ArchiveExtractionException(
                $"the archive expands to at least {_spent} bytes, above the {ceiling} byte ceiling "
                + "that bounds the expansion as well as the file");
        }
    }
}
```

- [ ] **Step 5: Add the extractor contract**

`src/Processor.FileReader/Extractors/IArchiveExtractor.cs`:

```csharp
namespace Processor.FileReader.Extractors;

/// <summary>One entry pulled out of an archive.</summary>
/// <param name="Name">The entry's own file name, without any directory the archive recorded.</param>
/// <param name="ModifiedUtc">Null where the format records none.</param>
public sealed record ExtractedEntry(string Name, byte[] Content, DateTime? ModifiedUtc);

/// <summary>
/// One archive format. Registered in the container and resolved by the file's own leading bytes, so
/// adding a format is one class and one registration.
/// </summary>
public interface IArchiveExtractor
{
    /// <summary>
    /// The extension a file of this format is normally named with, leading dot — <c>".zip"</c>.
    /// <para>
    /// <b>This is NOT how the extractor is chosen.</b> <see cref="CanHandle"/> does that, from the
    /// bytes. This exists for one narrower job, at the top level only: telling a file whose name
    /// declares an archive, and whose bytes are not one, from an ordinary file.
    /// </para>
    /// <para>
    /// <b>Without it, corruption reads as success.</b> A <c>.zip</c> whose header is damaged matches
    /// no signature, so signature-only dispatch would make it a leaf carrying its raw bytes and the
    /// step would report Completed over a file nobody could open — precisely the false-HEALTHY
    /// failure the guards inside each extractor exist to prevent, arrived at from outside them. The
    /// top-level file is the one place a DECLARATION exists to cross-check against, because
    /// <c>FileReaderConfig.ExpectedExtension</c> already had to match it for the file to be admitted
    /// at all. Nested entries have no declaration and get no such check.
    /// </para>
    /// </summary>
    string Extension { get; }

    /// <summary>
    /// True when these bytes are this extractor's format, judged by the format's signature.
    /// <para>
    /// <b>The BYTES decide, not the name — and that is a deliberate reversal.</b> This was
    /// <c>CanHandle(string extension)</c>, resolved against <c>FileReaderConfig.ExpectedExtension</c>.
    /// That worked only because the top-level file has a declared extension the processor had
    /// already validated. Nested entries have no declaration: an entry's name is a string written by
    /// whoever built the archive, and below the first level there is nothing to check it against. So
    /// the two jobs are split — <c>ExpectedExtension</c> ADMITS a file to the step, and the
    /// signature CHOOSES the extractor — and the second one works at every depth for the same
    /// reason.
    /// </para>
    /// <para>
    /// <b>What this costs: a mismatch is no longer a fault.</b> A file named <c>.zip</c> that is
    /// really a tar used to reach <c>ZipExtractor</c> and throw. It now extracts as a tar. The
    /// admission check still refuses a file whose extension is not what the step named, so the
    /// disagreement that remains is between a name the step approved and the content behind it —
    /// and reading the content is the more useful answer of the two.
    /// </para>
    /// <para>
    /// <b>No match is the ordinary case, not a fault.</b> A CSV matches nothing, and that is exactly
    /// how the expansion terminates: a node whose bytes match no extractor is a leaf.
    /// </para>
    /// </summary>
    /// <param name="header">
    /// The candidate's bytes, or as many as exist. Implementations must tolerate a buffer shorter
    /// than the signature they look for and answer false rather than throw — a two-byte file is a
    /// legitimate leaf, not a malformed archive.
    /// </param>
    bool CanHandle(ReadOnlySpan<byte> header);

    /// <summary>
    /// Every entry, one level deep. Directories are skipped rather than represented — an empty
    /// directory carries no content and no metadata worth a node. Depth beyond one is the caller's
    /// job: this seam expands exactly the archive it is handed.
    /// </summary>
    IReadOnlyList<ExtractedEntry> Extract(Stream archive);
}
```

Add `using Processor.FileReader.Extractors;` to `FileContentBuilder.cs`.

- [ ] **Step 6: Send the branch**

In `src/Processor.FileReader/FileReaderProcessor.cs`, add `FileContentBuilder builder` as a third constructor parameter and replace the tail of `ProcessAsync`:

```csharp
    protected override async Task ProcessAsync(
        byte[] data, FileReaderConfig? config, Guid executionId, CancellationToken ct)
    {
        // Config first: it is the cheapest check and it depends on nothing else. A step wired with a
        // ceiling this pod cannot honour is wrong before any file is named.
        var settings = Validate(config);

        var path = ReadPath(data);
        var info = Inspect(path, settings);

        var bytes = Read(info);

        FileBuildResult built;
        try
        {
            built = builder.Build(bytes, info, settings);
        }
        catch (ArchiveExtractionException ex)
        {
            // A corrupt or truncated archive, or one that expands past the ceiling. Deterministic —
            // it fails identically on every redelivery — so it is a failed step, not something to
            // park. No log here: the framework writes this message verbatim when it catches the
            // exception.
            //
            // ONE TYPE, NOT A LIST OF LIBRARY TYPES, and that is the fix for a measured seam
            // failure. This catch was originally `InvalidDataException or IOException or
            // NotSupportedException or ArgumentException` — the BCL types zip raises. When rar
            // arrived it brought SharpCompress, whose entire hierarchy descends from
            // SharpCompressException : Exception and matched none of them, so an ordinary corrupt
            // rar fell through to the framework's general catch: "the transform faulted", at Warning,
            // with a stack trace and THE FILE PATH NOWHERE. The path is the whole reason §9 puts
            // these checks here. Each extractor now wraps its own library's faults, exactly as
            // BaseExporter's sinks wrap theirs into ExportSinkException.
            //
            // Bare Exception is deliberately NOT caught: a NullReferenceException in the builder is
            // a programming error, and reporting it to an operator as a corrupt file buries a bug
            // under a plausible business failure. Anything that is not this type reaches the
            // framework's general catch with its stack trace intact.
            throw new FailedException($"extracting {info.FullName} failed: {ex.Message}");
        }

        // The SHAPE of the result, never its content. A count, a size and a depth are safe to log;
        // the bytes are upstream data and stay out of every template in this system.
        //
        // THE DEPTH IS HERE BECAUSE THIS IS THE ONLY PLACE IT SURVIVES. The registered output schema
        // states its depth structurally, and a document deeper than the schema admits fails
        // validation one hop later — reported with EntryId Guid.Empty, no payload and no file path,
        // at Information. Nothing in that failure says how deep this document actually went, so a
        // MaxDepth that disagrees with the schema would otherwise be undiagnosable from the logs.
        // Both numbers are logged: what was asked for, and what the file actually needed.
        logger.LogInformation(
            "read {FilePath} as {SizeBytes} bytes with {EntryCount} entries, expanded to depth "
            + "{DepthReached} of {MaxDepth}",
            info.FullName, info.Length, built.Node.Metadata.EntryCount, built.DepthReached,
            settings.MaxDepth);

        var document = JsonSerializer.SerializeToUtf8Bytes(built.Node, FileDocument.Options);

        // ONE branch, on the execution id this dispatch arrived with. Not NewExecutionId(): this is
        // a transform, not a source, so the lineage it was handed is the lineage it continues.
        await SendToPostAsync(document, executionId, ct).ConfigureAwait(false);
    }
```

- [ ] **Step 7: Register the builder**

In `src/Processor.FileReader/ProcessorHost.cs`, before the processor registration:

```csharp
        builder.Services.AddSingleton<FileContentBuilder>();
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj --filter-namespace BaseApi.Tests.FileReader`
Expected: all PASS. Update `FileReaderGuardTests.Build` and `FileReaderLocatorTests.Build` to pass `new FileContentBuilder([])` as the third argument, and change `FileReaderGuardTests.TheExtensionComparisonIsCaseInsensitive` to assert a successful run rather than `NotImplementedException` — the read now completes:

```csharp
    [Fact]
    public async Task TheExtensionComparisonIsCaseInsensitive()
    {
        var (processor, _) = Build();
        var path = WriteFile("orders.CSV", 10);

        // No throw: the extension guard passed and the document was built and sent.
        await Run(processor, path, Payload(".csv", 0, 4096));
    }
```

- [ ] **Step 9: Commit**

```bash
git add src/Processor.FileReader src/tests/BaseApi.Tests/FileReader
git commit -m "feat(filereader): the document, one branch, the lineage it was handed"
```

---

### Task 5: Zip

**Files:**
- Create: `src/Processor.FileReader/Extractors/ZipExtractor.cs`
- Modify: `src/Processor.FileReader/FileReaderProcessor.cs`
- Modify: `src/Processor.FileReader/ProcessorHost.cs`
- Test: `src/tests/BaseApi.Tests/FileReader/ZipExtractorTests.cs`

**Interfaces:**
- Consumes: `IArchiveExtractor`, `ExtractedEntry`, `FileContentBuilder` (Task 4).
- Produces: `public sealed class ZipExtractor : IArchiveExtractor`.

- [ ] **Step 1: Write the failing test**

`src/tests/BaseApi.Tests/FileReader/ZipExtractorTests.cs`:

```csharp
using System.IO.Compression;
using System.Text;
using System.Text.Json;
using BaseApi.Tests.Support;
using BaseProcessor.Core.Processing;
using Messaging.Contracts;
using Messaging.Transport;
using Microsoft.Extensions.Options;
using NSubstitute;
using Processor.FileReader;
using Processor.FileReader.Extractors;
using Xunit;

namespace BaseApi.Tests.FileReader;

public sealed class ZipExtractorTests : IDisposable
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");
    private static readonly Guid E = Guid.Parse("55555555-5555-5555-5555-555555555555");

    private readonly string _dir = Directory.CreateTempSubdirectory("skp-filereader-zip-").FullName;

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    /// <summary>A real zip on disk, built from bytes. No fixture file, no abstraction.</summary>
    private string WriteZip(string name, params (string Entry, string Text)[] entries)
    {
        var path = Path.Combine(_dir, name);
        using var file = File.Create(path);
        using var archive = new ZipArchive(file, ZipArchiveMode.Create);
        foreach (var (entry, text) in entries)
        {
            using var writer = new StreamWriter(archive.CreateEntry(entry).Open());
            writer.Write(text);
        }

        return path;
    }

    private const string ZipPayload =
        """{"ExpectedExtension":".zip","MinimumSizeBytes":0,"MaximumSizeBytes":65536}""";

    private static (FileReaderProcessor Processor, IQueueSender Sender) Build()
    {
        var sender = Substitute.For<IQueueSender>();
        var processor = new FileReaderProcessor(
            new RecordingLogger<FileReaderProcessor>(),
            Options.Create(new FileReaderOptions()),
            new FileContentBuilder([new ZipExtractor()]));
        processor.BeginDispatch(new DispatchState(sender, C, W, S, P));
        return (processor, sender);
    }

    private static async Task<JsonElement> DocumentOf(string path)
    {
        var (processor, sender) = Build();
        var sends = new List<ProcessedData>();
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(sends.Add),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());

        await processor.ExecuteAsync(
            Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { filePath = path })),
            ZipPayload, E, CancellationToken.None);

        return JsonDocument.Parse(Assert.Single(sends).Data).RootElement;
    }

    [Fact]
    public void ItHandlesZipAndNothingElse()
    {
        var extractor = new ZipExtractor();

        // A local file header, and the canonical empty archive's EOCD. The empty one must be
        // claimed too, or it would be mistaken for a leaf instead of reaching the exemption in
        // Extract that tells a genuinely empty zip from a corrupt one.
        Assert.True(extractor.CanHandle(new byte[] { 0x50, 0x4B, 0x03, 0x04 }));
        Assert.True(extractor.CanHandle(new byte[] { 0x50, 0x4B, 0x05, 0x06 }));

        // A rar, a truncated signature, and nothing at all. A buffer shorter than the signature is
        // answered rather than thrown on: a two-byte file is a legitimate leaf.
        Assert.False(extractor.CanHandle(new byte[] { 0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x00 }));
        Assert.False(extractor.CanHandle(new byte[] { 0x50, 0x4B }));
        Assert.False(extractor.CanHandle(ReadOnlySpan<byte>.Empty));
    }

    [Fact]
    public async Task AnArchiveBecomesEntriesAndCarriesNoContentOfItsOwn()
    {
        var path = WriteZip("orders.zip", ("a.csv", "id\n"), ("b.csv", "id,name\n"));

        var doc = await DocumentOf(path);

        Assert.Equal(JsonValueKind.Array, doc.GetProperty("content").ValueKind);
        Assert.Equal(2, doc.GetProperty("metadata").GetProperty("entryCount").GetInt32());
        Assert.Equal(2, doc.GetProperty("content").GetArrayLength());
    }

    [Fact]
    public async Task EachEntryIsALeafWithItsOwnMetadata()
    {
        var path = WriteZip("orders.zip", ("a.csv", "id\n"));

        var doc = await DocumentOf(path);
        var entry = doc.GetProperty("content")[0];

        Assert.Equal("a.csv", entry.GetProperty("metadata").GetProperty("name").GetString());
        Assert.Equal(".csv", entry.GetProperty("metadata").GetProperty("extension").GetString());
        Assert.Equal(3, entry.GetProperty("metadata").GetProperty("sizeBytes").GetInt64());
        Assert.Equal("id\n", Encoding.UTF8.GetString(entry.GetProperty("content").GetBytesFromBase64()));
        Assert.Equal(0, entry.GetProperty("metadata").GetProperty("entryCount").GetInt32());
    }

    [Fact]
    public async Task ANestedArchiveIsALeafRatherThanASecondLevel()
    {
        // Depth is one, by design. The inner zip's bytes are recorded; it is not expanded.
        var inner = WriteZip("inner.zip", ("deep.csv", "id\n"));
        var path = Path.Combine(_dir, "outer.zip");
        using (var file = File.Create(path))
        using (var archive = new ZipArchive(file, ZipArchiveMode.Create))
        {
            using var target = archive.CreateEntry("inner.zip").Open();
            using var source = File.OpenRead(inner);
            source.CopyTo(target);
        }

        var doc = await DocumentOf(path);
        var entry = doc.GetProperty("content")[0];

        Assert.Equal("inner.zip", entry.GetProperty("metadata").GetProperty("name").GetString());
        Assert.Equal(JsonValueKind.String, entry.GetProperty("content").ValueKind);
        Assert.Equal(0, entry.GetProperty("metadata").GetProperty("entryCount").GetInt32());
    }

    [Fact]
    public async Task ADirectoryEntryIsNotANode()
    {
        // A zip records directories as zero-length entries ending in a slash. They carry no content
        // and no metadata worth a node, and counting them would make entryCount disagree with what a
        // reader sees.
        var path = Path.Combine(_dir, "orders.zip");
        using (var file = File.Create(path))
        using (var archive = new ZipArchive(file, ZipArchiveMode.Create))
        {
            archive.CreateEntry("nested/");
            using var writer = new StreamWriter(archive.CreateEntry("nested/a.csv").Open());
            writer.Write("id\n");
        }

        var doc = await DocumentOf(path);

        Assert.Equal(1, doc.GetProperty("metadata").GetProperty("entryCount").GetInt32());
        Assert.Equal("a.csv",
            doc.GetProperty("content")[0].GetProperty("metadata").GetProperty("name").GetString());
    }

    [Fact]
    public async Task ACorruptArchiveFailsTheStepNamingThePath()
    {
        var path = Path.Combine(_dir, "broken.zip");
        File.WriteAllText(path, "this is not a zip");

        var (processor, _) = Build();

        var ex = await Assert.ThrowsAsync<FailedException>(() => processor.ExecuteAsync(
            Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { filePath = path })),
            ZipPayload, E, CancellationToken.None));

        Assert.Contains($"extracting {path} failed", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnArchiveExpandingPastTheCeilingFailsTheStepNamingBothNumbers()
    {
        // THE POISON-MESSAGE CASE. Before this bound, the only ceiling anywhere was on the FILE, and
        // an archive is exactly where that stops being the transient cost: this zip is a few hundred
        // bytes on disk and 200,000 bytes expanded, so it sails through every check in stage one. At
        // the real 32 MiB ceiling an ordinary 10:1 CSV zip is ~320 MB expanded plus document and
        // envelope, against a 768Mi limit.
        //
        // An OOM-kill there is not one lost message: the author never returns, so the input key is
        // never reclaimed, RabbitMQ requeues the unacked dispatch, and the replacement pod reads the
        // same key and dies the same way — taking the processor down for every workflow on that
        // queue. A FailedException is acked and terminal, which is the whole difference.
        //
        // Both numbers are asserted because an operator has to see which limit was hit and by how
        // much; a message saying only "too large" cannot be acted on.
        var path = Path.Combine(_dir, "compressible.zip");
        using (var file = File.Create(path))
        using (var archive = new ZipArchive(file, ZipArchiveMode.Create))
        {
            // Zeros, so the archive is tiny and the expansion is not. Two entries, so the bound is
            // also shown to be CUMULATIVE rather than per-entry — neither entry alone exceeds the
            // 65536 ceiling the payload names.
            foreach (var name in new[] { "a.csv", "b.csv" })
            {
                using var entry = archive.CreateEntry(name).Open();
                entry.Write(new byte[100_000]);
            }
        }

        Assert.True(new FileInfo(path).Length < 65536, "the archive itself must pass the file check");

        var (processor, _) = Build();

        var ex = await Assert.ThrowsAsync<FailedException>(() => processor.ExecuteAsync(
            Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { filePath = path })),
            ZipPayload, E, CancellationToken.None));

        // The `extracting` template, not `rejected`: the file broke no rule, and the fault only
        // exists once the archive was opened.
        Assert.Contains($"extracting {path} failed", ex.Message, StringComparison.Ordinal);
        Assert.Contains("100000", ex.Message, StringComparison.Ordinal);
        Assert.Contains("65536", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnArchiveInsideTheCeilingStillSucceeds()
    {
        // The other side of the bound. The ceiling is inclusive and cumulative, so an archive whose
        // entries total exactly the ceiling must still pass — an off-by-one here would reject valid
        // work with a message about memory, which is the worst possible false positive for a limit
        // whose whole purpose is to be invisible until it matters.
        var path = Path.Combine(_dir, "exact.zip");
        using (var file = File.Create(path))
        using (var archive = new ZipArchive(file, ZipArchiveMode.Create))
        {
            using var entry = archive.CreateEntry("a.csv").Open();
            entry.Write(new byte[65536]);
        }

        var doc = await DocumentOf(path);

        Assert.Equal(65536, doc.GetProperty("content")[0]
                                .GetProperty("metadata").GetProperty("sizeBytes").GetInt64());
    }

    /// <summary>A real two-entry zip, in memory. The corrupt fixtures below are damaged copies of it.</summary>
    private static byte[] RealZipBytes()
    {
        using var buffer = new MemoryStream();
        using (var archive = new ZipArchive(buffer, ZipArchiveMode.Create, leaveOpen: true))
        {
            using (var w = new StreamWriter(archive.CreateEntry("a.csv").Open()))
            {
                w.Write("id\n");
            }

            using (var w = new StreamWriter(archive.CreateEntry("b.csv").Open()))
            {
                w.Write("id,name\n");
            }
        }

        return buffer.ToArray();
    }

    /// <summary>The offset of the End Of Central Directory record — <c>PK\x05\x06</c>, scanned from the tail.</summary>
    private static int EndOfCentralDirectoryOffset(byte[] zip)
    {
        for (var i = zip.Length - 22; i >= 0; i--)
        {
            if (zip[i] == 0x50 && zip[i + 1] == 0x4B && zip[i + 2] == 0x05 && zip[i + 3] == 0x06)
            {
                return i;
            }
        }

        throw new InvalidOperationException("the fixture has no EOCD record");
    }

    [Fact]
    public void AGenuinelyEmptyZipSucceedsWithNoEntries()
    {
        // The "valid, so must not throw" side of the guard's line, and the shape was VERIFIED here
        // rather than taken on description: a ZipArchive opened for Create and closed without a
        // single entry writes exactly 22 bytes — a bare EOCD record beginning PK\x05\x06 — on .NET
        // 8.0.31. Those two facts are what ZipExtractor's exemption tests for, so this test asserts
        // them directly; if a future runtime writes a different empty archive, this fails HERE with
        // the reason, rather than the exemption silently ceasing to match.
        byte[] empty;
        using (var buffer = new MemoryStream())
        {
            using (var archive = new ZipArchive(buffer, ZipArchiveMode.Create, leaveOpen: true))
            {
            }

            empty = buffer.ToArray();
        }

        Assert.Equal(22, empty.Length);
        Assert.Equal<byte[]>([0x50, 0x4B, 0x05, 0x06], empty[..4]);

        using var stream = new MemoryStream(empty, writable: false);

        Assert.Empty(new ZipExtractor().Extract(stream));
    }

    [Fact]
    public void AZipWhoseEndOfCentralDirectoryClaimsNothingThrows()
    {
        // THE MEASURED FALSE-HEALTHY HOLE, built from a real zip rather than a hand-typed blob.
        //
        // .NET 8.0.31's ZipArchive DOES cross-check the EOCD's declared entry count against what the
        // central directory yields — ~2200 mutations of this fixture (truncation at every length,
        // zeroed and 0xFF windows of eight sizes at every offset, the whole central directory
        // zeroed, everything before the EOCD zeroed, prefix and suffix padding) all threw. What it
        // does NOT cross-check is the central directory's declared size and offset. Zero the EOCD's
        // entry counts AND its central-directory size/offset — twelve bytes at the tail, the shape a
        // partially-flushed write or a padded transfer produces — and the file still holds both
        // entries, still opens cleanly, and enumerates NOTHING with no exception.
        //
        // Without the guard that is {content: null, entries: [], entryCount: 0}: schema-valid,
        // written to L2, reported Completed. This is the test that would have caught it.
        var zip = RealZipBytes();
        var eocd = EndOfCentralDirectoryOffset(zip);

        // EOCD layout from its signature: +8 entries-on-this-disk, +10 total entries, +12 central
        // directory size, +16 central directory offset. Twelve bytes, all zeroed.
        Array.Clear(zip, eocd + 8, 12);

        using var stream = new MemoryStream(zip, writable: false);

        var ex = Assert.Throws<ArchiveExtractionException>(() => new ZipExtractor().Extract(stream));
        Assert.Contains("no entries", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void AZipWhoseCentralDirectoryIsZeroedThrows()
    {
        // The review's other named case: the central directory zeroed with the EOCD left intact.
        // On .NET 8.0.31 this one is caught by the runtime itself — the EOCD still declares two
        // entries and the directory now yields none, which ZipArchive rejects by name — so the
        // throw arrives through ZipExtractor's WRAPPING rather than through its guard. Both paths
        // must reach the processor as the same type, which is exactly what this pins: whichever
        // layer notices, the caller sees ArchiveExtractionException and the step names the file.
        var zip = RealZipBytes();
        var eocd = EndOfCentralDirectoryOffset(zip);
        var cdSize = BitConverter.ToInt32(zip, eocd + 12);
        var cdOffset = BitConverter.ToInt32(zip, eocd + 16);

        Array.Clear(zip, cdOffset, cdSize);

        using var stream = new MemoryStream(zip, writable: false);

        Assert.Throws<ArchiveExtractionException>(() => new ZipExtractor().Extract(stream));
    }

    [Fact]
    public void ADirectoryOnlyZipSucceedsWithNoEntries()
    {
        // The regression the raw-count split exists to prevent, and the reason the guard counts what
        // ZipArchive yielded rather than what survived the directory filter. A zip holding nothing
        // but a directory entry is healthy: it opens, it yields one entry, and the filter drops it.
        // Gating on the filtered count would report this valid archive as corrupt — the exact fault
        // fix round 2 found in tar.
        var path = Path.Combine(_dir, "dirs-only.zip");
        using (var file = File.Create(path))
        using (var archive = new ZipArchive(file, ZipArchiveMode.Create))
        {
            archive.CreateEntry("nested/");
        }

        using var stream = File.OpenRead(path);

        Assert.Empty(new ZipExtractor().Extract(stream));
    }

    [Fact]
    public void ExtractedEntryModifiedUtcCarriesUtcKind()
    {
        // Task 4 review requirement: ZipArchiveEntry.LastWriteTime is a DateTimeOffset, and
        // .UtcDateTime is the conversion that yields DateTimeKind.Utc. .DateTime or .LocalDateTime
        // would silently produce Kind.Local/Unspecified, which System.Text.Json renders without a
        // trailing Z (or with an offset) — a schema failure one hop downstream, in a branch that is
        // discarded rather than reported.
        var path = WriteZip("orders.zip", ("a.csv", "id\n"));

        using var stream = File.OpenRead(path);
        var entries = new ZipExtractor().Extract(stream);

        Assert.Equal(DateTimeKind.Utc, Assert.Single(entries).ModifiedUtc!.Value.Kind);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj --filter-class BaseApi.Tests.FileReader.ZipExtractorTests`
Expected: FAIL to compile — `ZipExtractor` does not exist.

- [ ] **Step 3: Write the extractor**

`src/Processor.FileReader/Extractors/ZipExtractor.cs`:

```csharp
using System.IO.Compression;

namespace Processor.FileReader.Extractors;

/// <summary>
/// Zip, on the in-box <c>System.IO.Compression</c>. No package.
/// <para>
/// <b>The false-HEALTHY guard is here too, and it was added last.</b> This class predates the lesson
/// tar and rar each learned — a library will open a damaged archive, report success, and enumerate
/// nothing, so a corrupt file reads as a healthy <i>empty</i> archive and the step reports Completed
/// over <c>{content: null, entries: [], entryCount: 0}</c>. Zip was written before that and was not
/// revisited; see the guard below for what was measured on this runtime and what was not.
/// </para>
/// </summary>
public sealed class ZipExtractor : IArchiveExtractor
{
    /// <summary>The canonical empty archive: an EOCD record and nothing else.</summary>
    private const int EmptyArchiveLength = 22;

    public string Extension => ".zip";

    /// <summary>
    /// <c>PK\x05\x06</c> — the End Of Central Directory signature, which in a 22-byte file is the
    /// whole file.
    /// </summary>
    private static ReadOnlySpan<byte> EndOfCentralDirectorySignature => [0x50, 0x4B, 0x05, 0x06];

    /// <summary>
    /// <c>PK\x03\x04</c> (a local file header) or <c>PK\x05\x06</c> (an End Of Central Directory
    /// with nothing before it — the canonical empty archive, which must still be claimed here so it
    /// reaches <see cref="Extract"/> and its exemption rather than being mistaken for a leaf).
    /// </summary>
    public bool CanHandle(ReadOnlySpan<byte> header)
        => header.Length >= 4
           && header[0] == 0x50 && header[1] == 0x4B
           && ((header[2] == 0x03 && header[3] == 0x04)
               || (header[2] == 0x05 && header[3] == 0x06));

    /// <summary>
    /// Every file entry, one level deep, or an <see cref="ArchiveExtractionException"/> saying why
    /// the archive could not be read.
    /// </summary>
    public IReadOnlyList<ExtractedEntry> Extract(Stream archive)
    {
        try
        {
            return ExtractCore(archive);
        }
        catch (Exception ex) when (ex is InvalidDataException or IOException
                                      or NotSupportedException or ArgumentException)
        {
            // The BCL fault types System.IO.Compression raises, wrapped into the one type the
            // processor catches. Not bare Exception: a NullReferenceException here is a bug in this
            // class, and it must reach the framework's general catch with its stack trace rather
            // than be reported to an operator as a corrupt file.
            throw new ArchiveExtractionException(ex.Message, ex);
        }
    }

    private static List<ExtractedEntry> ExtractCore(Stream archive)
    {
        var entries = new List<ExtractedEntry>();

        // Counts every entry ZipArchive actually yielded, BEFORE the directory filter below drops
        // any of them — the same split TarExtractor and RarExtractor make, and for the same reason.
        // Gating the guard on entries.Count instead would report a valid directory-only zip as
        // corrupt, which is the regression fix round 2 caught in tar.
        var rawEntryCount = 0;

        // leaveOpen: true, unlike the plain constructor this class used before. The empty-archive
        // exemption below re-reads this same stream after the archive is done with it, which
        // requires the stream to still be open at that point.
        using (var zip = new ZipArchive(archive, ZipArchiveMode.Read, leaveOpen: true))
        {
            foreach (var entry in zip.Entries)
            {
                rawEntryCount++;

                // A directory is a zero-length entry whose name ends in a slash. Skipped rather than
                // represented: it carries no content, and counting it would make entryCount disagree
                // with the nodes a reader actually sees.
                if (entry.FullName.EndsWith('/') || entry.Name.Length == 0)
                {
                    continue;
                }

                using var stream = entry.Open();
                using var buffer = new MemoryStream();
                stream.CopyTo(buffer);

                // entry.Name, not FullName: the directory a zip recorded is not part of the entry's
                // identity here, and a path separator in a node name would read as structure the
                // document does not have.
                //
                // .UtcDateTime, not .DateTime or .LocalDateTime: LastWriteTime is a DateTimeOffset,
                // and only the UtcDateTime conversion yields DateTimeKind.Utc. System.Text.Json
                // renders a Local or Unspecified DateTime without the trailing Z (or with an offset
                // instead), which fails the output schema one hop after this method returns — a
                // branch where the failure is discarded rather than reported.
                entries.Add(new ExtractedEntry(
                    entry.Name, buffer.ToArray(), entry.LastWriteTime.UtcDateTime));
            }
        }

        // THE FALSE-HEALTHY GUARD, matching tar's shape rather than rar's — a genuinely empty zip is
        // a real, valid file and must still succeed, so this needs an exemption where rar does not.
        //
        // WHAT WAS MEASURED, on .NET 8.0.31, against a real 221-byte two-entry zip built in a scratch
        // program (not a hand-typed blob), before this guard was written:
        //
        //  - Truncation at every length 1..220 throws. So does every 1/2/4/8/16/32/64/97-byte window
        //    zeroed or 0xFF-filled at every offset before the EOCD, every zeroing of the whole
        //    central directory, every zeroing of everything before the EOCD, and 1..64 bytes of
        //    padding prepended or appended. ~2200 mutations, ZERO of which opened with zero entries:
        //    this runtime DOES cross-check the EOCD's declared entry count against what the central
        //    directory actually yielded, and says so by name.
        //  - It cross-checks the count, and NOT the central directory's declared size and offset.
        //    Zero the EOCD's entry-count AND its central-directory size/offset fields — twelve bytes,
        //    the shape a partially-flushed write or a padded transfer produces at the tail — and the
        //    221-byte file with both of its entries still in it opens cleanly and enumerates NOTHING,
        //    with no exception. That is the hole, reproduced, and it is what the test pins.
        //
        // The guard covers the CLASS, not that one byte pattern: any damage that opens successfully
        // and yields nothing is caught however it arose, on this runtime version or a later one whose
        // internal cross-checks differ again. What remains unguarded is a nonzero but wrong count —
        // three entries silently becoming two — because nothing in a zip states how many there should
        // have been.
        if (rawEntryCount == 0 && !IsCanonicalEmptyArchive(archive))
        {
            throw new ArchiveExtractionException(
                "The zip produced no entries and is not the canonical 22-byte empty archive — " +
                "treating it as corrupt rather than returning it as a healthy empty archive.");
        }

        return entries;
    }

    /// <summary>
    /// True for the one zip that legitimately yields nothing: a bare End Of Central Directory record
    /// with no entries and no comment, which is exactly 22 bytes beginning <c>PK\x05\x06</c>.
    /// <para>
    /// <b>The shape was verified rather than assumed</b> — a <c>ZipArchive</c> opened in
    /// <c>Create</c> mode and closed without a single entry writes precisely those 22 bytes on .NET
    /// 8.0.31, checked in the same scratch program that found the hole above.
    /// </para>
    /// <para>
    /// This is deliberately narrower than "no entries and a plausible EOCD". A zip longer than 22
    /// bytes has something in it — local file records, a central directory, or padding — and a file
    /// with content that enumerates to nothing is the corrupt case, not the empty one. A valid empty
    /// zip carrying an archive comment would be rejected by this, and that is accepted: nothing in
    /// this system writes one, and admitting a variable-length tail would reopen the door the guard
    /// closes.
    /// </para>
    /// </summary>
    private static bool IsCanonicalEmptyArchive(Stream stream)
    {
        // A stream that cannot seek cannot be re-read, so the exemption cannot be established and
        // the archive is treated as corrupt. Every caller here hands over a seekable MemoryStream or
        // FileStream; this is the safe answer for one that does not, because falsely claiming
        // "empty" is the failure mode this whole guard exists to prevent.
        if (!stream.CanSeek || stream.Length != EmptyArchiveLength)
        {
            return false;
        }

        stream.Position = 0;
        Span<byte> head = stackalloc byte[4];
        stream.ReadExactly(head);

        return head.SequenceEqual(EndOfCentralDirectorySignature);
    }
}
```

- [ ] **Step 4: Turn an extraction fault into a failed step**

In `src/Processor.FileReader/FileReaderProcessor.cs`, wrap the builder call:

```csharp
        FileBuildResult built;
        try
        {
            built = builder.Build(bytes, info, settings);
        }
        catch (ArchiveExtractionException ex)
        {
            // A corrupt or truncated archive, or one that expands past the ceiling. Deterministic —
            // it fails identically on every redelivery — so it is a failed step, not something to
            // park. No log here: the framework writes this message verbatim when it catches the
            // exception.
            //
            // ONE TYPE, NOT A LIST OF LIBRARY TYPES, and that is the fix for a measured seam
            // failure. This catch was originally `InvalidDataException or IOException or
            // NotSupportedException or ArgumentException` — the BCL types zip raises. When rar
            // arrived it brought SharpCompress, whose entire hierarchy descends from
            // SharpCompressException : Exception and matched none of them, so an ordinary corrupt
            // rar fell through to the framework's general catch: "the transform faulted", at Warning,
            // with a stack trace and THE FILE PATH NOWHERE. The path is the whole reason §9 puts
            // these checks here. Each extractor now wraps its own library's faults, exactly as
            // BaseExporter's sinks wrap theirs into ExportSinkException.
            //
            // Bare Exception is deliberately NOT caught: a NullReferenceException in the builder is
            // a programming error, and reporting it to an operator as a corrupt file buries a bug
            // under a plausible business failure. Anything that is not this type reaches the
            // framework's general catch with its stack trace intact.
            throw new FailedException($"extracting {info.FullName} failed: {ex.Message}");
        }
```

- [ ] **Step 5: Register it**

In `src/Processor.FileReader/ProcessorHost.cs`, before `AddSingleton<FileContentBuilder>()`:

```csharp
        // One registration per format. FileContentBuilder takes them all and asks each whether it
        // handles the step's extension.
        builder.Services.AddSingleton<IArchiveExtractor, ZipExtractor>();
```

with `using Processor.FileReader.Extractors;` at the top.

- [ ] **Step 6: Run tests to verify they pass**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj --filter-namespace BaseApi.Tests.FileReader`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/Processor.FileReader src/tests/BaseApi.Tests/FileReader
git commit -m "feat(filereader): zip, one level deep"
```

---

### Task 6: Tar

**Files:**
- Create: `src/Processor.FileReader/Extractors/TarExtractor.cs`
- Modify: `src/Processor.FileReader/ProcessorHost.cs`
- Test: `src/tests/BaseApi.Tests/FileReader/TarExtractorTests.cs`

**Interfaces:**
- Consumes: `IArchiveExtractor`, `ExtractedEntry` (Task 4).
- Produces: `public sealed class TarExtractor : IArchiveExtractor`.

- [ ] **Step 1: Write the failing test**

`src/tests/BaseApi.Tests/FileReader/TarExtractorTests.cs`:

```csharp
using System.Formats.Tar;
using System.Text;
using System.Text.Json;
using BaseApi.Tests.Support;
using BaseProcessor.Core.Processing;
using Messaging.Transport;
using Microsoft.Extensions.Options;
using NSubstitute;
using Processor.FileReader;
using Processor.FileReader.Extractors;
using Xunit;

namespace BaseApi.Tests.FileReader;

public sealed class TarExtractorTests : IDisposable
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");
    private static readonly Guid E = Guid.Parse("55555555-5555-5555-5555-555555555555");

    private readonly string _dir = Directory.CreateTempSubdirectory("skp-filereader-tar-").FullName;

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    /// <summary>A real tar, built in memory from bytes.</summary>
    private static byte[] Tar(params (string Name, string Text)[] entries)
    {
        using var buffer = new MemoryStream();
        using (var writer = new TarWriter(buffer, leaveOpen: true))
        {
            foreach (var (name, text) in entries)
            {
                var entry = new PaxTarEntry(TarEntryType.RegularFile, name)
                {
                    DataStream = new MemoryStream(Encoding.UTF8.GetBytes(text)),
                    ModificationTime = new DateTimeOffset(2026, 9, 8, 10, 58, 0, TimeSpan.Zero),
                };
                writer.WriteEntry(entry);
            }
        }

        return buffer.ToArray();
    }

    [Fact]
    public void ItHandlesTarAndNothingElse()
    {
        var extractor = new TarExtractor();

        // TAR IS THE ONE FORMAT WITH NO SIGNATURE AT OFFSET ZERO: its magic is "ustar" at byte
        // 257, so this needs 262 bytes where zip needs four.
        var header = new byte[262];
        "ustar"u8.CopyTo(header.AsSpan(257));
        Assert.True(extractor.CanHandle(header));

        // One byte short of the marker, and a zip. A file too small to hold the marker cannot be a
        // tar at all - the header block alone is 512 bytes.
        Assert.False(extractor.CanHandle(header.AsSpan(0, 261)));
        Assert.False(extractor.CanHandle(new byte[] { 0x50, 0x4B, 0x03, 0x04 }));
        Assert.False(extractor.CanHandle(ReadOnlySpan<byte>.Empty));
    }

    [Fact]
    public void EveryRegularFileBecomesAnEntry()
    {
        using var stream = new MemoryStream(Tar(("a.csv", "id\n"), ("b.csv", "id,name\n")));

        var entries = new TarExtractor().Extract(stream);

        Assert.Equal(["a.csv", "b.csv"], entries.Select(e => e.Name).ToArray());
        Assert.Equal("id\n", Encoding.UTF8.GetString(entries[0].Content));
        Assert.Equal(new DateTime(2026, 9, 8, 10, 58, 0, DateTimeKind.Utc), entries[0].ModifiedUtc);
    }

    [Fact]
    public void ADirectoryEntryIsSkipped()
    {
        using var buffer = new MemoryStream();
        using (var writer = new TarWriter(buffer, leaveOpen: true))
        {
            writer.WriteEntry(new PaxTarEntry(TarEntryType.Directory, "nested/"));
            writer.WriteEntry(new PaxTarEntry(TarEntryType.RegularFile, "nested/a.csv")
            {
                DataStream = new MemoryStream(Encoding.UTF8.GetBytes("id\n")),
            });
        }

        buffer.Position = 0;
        var entries = new TarExtractor().Extract(buffer);

        Assert.Equal("a.csv", Assert.Single(entries).Name);
    }

    [Fact]
    public void ATruncatedArchiveThrowsForTheProcessorToCatch()
    {
        // The processor turns this into a failed step naming the path; the extractor's job is only
        // to fail rather than to return a half-read archive as if it were whole.
        //
        // ArchiveExtractionException, not ThrowsAny<Exception>. A test named "for the processor to
        // catch" that accepts ANY exception cannot tell the two cases apart — the one the processor
        // catches and turns into "extracting {path} failed", and the one that escapes to the
        // framework's general catch and loses the path entirely. Asserting the seam's type is the
        // only assertion that means what the name says.
        using var stream = new MemoryStream(Encoding.UTF8.GetBytes("this is not a tar"));

        Assert.Throws<ArchiveExtractionException>(() => new TarExtractor().Extract(stream));
    }

    [Fact]
    public void AGenuinelyEmptyTarSucceedsWithNoEntries()
    {
        // A valid empty tar is nothing but zero bytes — a lone 512-byte zero block satisfies it,
        // same as the POSIX-standard two-block terminator, same as 0 bytes. TarReader.GetNextEntry
        // returns null with no exception for all of these, same as it does for a corrupt archive
        // (see ATruncatedHeaderWithGarbageAfterItThrows below) — the guard in TarExtractor.Extract
        // tells them apart by checking whether the stream is all zero. This pins the "valid, so must
        // not throw" side of that line.
        using var stream = new MemoryStream(new byte[1024]);

        var entries = new TarExtractor().Extract(stream);

        Assert.Empty(entries);
    }

    [Fact]
    public void ATruncatedHeaderWithGarbageAfterItThrows()
    {
        // The false-HEALTHY case the guard exists for: TarReader reads the first block, sees it is
        // all zero, and treats that as the archive's terminator — GetNextEntry returns null with NO
        // exception, exactly as it would for a real empty tar. Without the guard, a file that was
        // truncated right after a zeroed header (or any file whose first 512 bytes happen to be
        // zero, with real bytes after them) would read as a healthy empty archive instead of a
        // corrupt one. Measured directly against TarReader before writing this test — see
        // task-6-report.md, fix round 1.
        var bytes = new byte[522];
        Encoding.UTF8.GetBytes("garbagexyz").CopyTo(bytes, 512);

        using var stream = new MemoryStream(bytes);

        var ex = Assert.Throws<ArchiveExtractionException>(() => new TarExtractor().Extract(stream));
        Assert.Contains("not all zero", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ADirectoryOnlyArchiveSucceedsWithNoEntries()
    {
        // Fix round 2 regression: the guard above must gate on what TarReader actually yielded, not
        // on what survived the regular-file filter. A directory-only archive (same as one that held
        // only symlinks, hardlinks, or the excluded ContiguousFile/SparseFile types) parses cleanly —
        // TarReader reads a real, non-zero header and yields one entry — but the filter drops it, so
        // entries.Count is 0. Gating the guard on entries.Count made this valid, non-corrupt archive
        // throw InvalidDataException; gating on the raw TarReader yield count (which is 1, not 0)
        // fixes it. This test is the third side of the "empty vs. corrupt" line, alongside
        // AGenuinelyEmptyTarSucceedsWithNoEntries and ATruncatedHeaderWithGarbageAfterItThrows.
        using var buffer = new MemoryStream();
        using (var writer = new TarWriter(buffer, leaveOpen: true))
        {
            writer.WriteEntry(new PaxTarEntry(TarEntryType.Directory, "emptydir/"));
        }

        buffer.Position = 0;
        var entries = new TarExtractor().Extract(buffer);

        Assert.Empty(entries);
    }

    [Fact]
    public async Task ACorruptArchiveFailsTheStepNamingThePath()
    {
        // THE PROCESSOR-LEVEL TEST TAR NEVER HAD. Only zip had one, which is why nobody noticed that
        // the processor's catch list was written against zip's exception types and matched nothing
        // any other library raises. An extractor-level assertion proves the extractor throws; it
        // proves nothing about whether the throw reaches the caller's catch or escapes to the
        // framework's general one, where the file path — the entire reason §9 puts these checks in
        // ProcessAsync — is absent from every line.
        var path = Path.Combine(_dir, "broken.tar");
        File.WriteAllText(path, "this is not a tar");

        var processor = new FileReaderProcessor(
            new RecordingLogger<FileReaderProcessor>(),
            Options.Create(new FileReaderOptions()),
            new FileContentBuilder([new TarExtractor()]));
        processor.BeginDispatch(
            new DispatchState(Substitute.For<IQueueSender>(), C, W, S, P));

        var ex = await Assert.ThrowsAsync<FailedException>(() => processor.ExecuteAsync(
            Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { filePath = path })),
            """{"ExpectedExtension":".tar","MinimumSizeBytes":0,"MaximumSizeBytes":65536}""",
            E, CancellationToken.None));

        Assert.Contains($"extracting {path} failed", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ExtractedEntryModifiedUtcCarriesUtcKind()
    {
        // Task 4/6 review requirement: TarEntry.ModificationTime is a DateTimeOffset, and
        // .UtcDateTime is the conversion that yields DateTimeKind.Utc. .DateTime or .LocalDateTime
        // would silently produce Kind.Local/Unspecified, which System.Text.Json renders without a
        // trailing Z (or with an offset) — a schema failure one hop downstream, in a branch that is
        // discarded rather than reported.
        using var stream = new MemoryStream(Tar(("a.csv", "id\n")));

        var entries = new TarExtractor().Extract(stream);

        Assert.Equal(DateTimeKind.Utc, Assert.Single(entries).ModifiedUtc!.Value.Kind);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj --filter-class BaseApi.Tests.FileReader.TarExtractorTests`
Expected: FAIL to compile — `TarExtractor` does not exist.

- [ ] **Step 3: Write the extractor**

`src/Processor.FileReader/Extractors/TarExtractor.cs`:

```csharp
using System.Formats.Tar;

namespace Processor.FileReader.Extractors;

/// <summary>
/// Tar, on the in-box <c>System.Formats.Tar</c>. Uncompressed only — a <c>.tar.gz</c> has a
/// different extension and would need its own extractor and its own decision about whether the
/// double extension is one format or two.
/// </summary>
public sealed class TarExtractor : IArchiveExtractor
{
    public string Extension => ".tar";

    /// <summary>
    /// <b>Tar is the one format here with no signature at offset zero.</b> Its magic is the string
    /// <c>ustar</c> at byte 257, inside the first entry's header block — POSIX writes
    /// <c>ustar\x00</c><c>00</c> and GNU writes <c>ustar  \x00</c>, and the five shared characters are
    /// what both agree on. So this needs 262 bytes where zip needs four, and anything shorter is
    /// answered false: a tar's header block alone is 512 bytes, so a file too small to hold the
    /// marker cannot be one.
    /// <para>
    /// A pre-POSIX v7 tar carries no <c>ustar</c> marker at all and is therefore not claimed here.
    /// Nothing in this system writes one, and the alternative — inferring tar from a plausible octal
    /// checksum — would claim files that merely look numeric at the right offsets.
    /// </para>
    /// </summary>
    public bool CanHandle(ReadOnlySpan<byte> header)
        => header.Length >= 262
           && header[257] == (byte)'u' && header[258] == (byte)'s' && header[259] == (byte)'t'
           && header[260] == (byte)'a' && header[261] == (byte)'r';

    /// <summary>
    /// Every regular file entry, one level deep, or an <see cref="ArchiveExtractionException"/>
    /// saying why the archive could not be read.
    /// </summary>
    public IReadOnlyList<ExtractedEntry> Extract(Stream archive)
    {
        try
        {
            return ExtractCore(archive);
        }
        catch (Exception ex) when (ex is InvalidDataException or IOException
                                      or NotSupportedException or ArgumentException
                                      or FormatException or EndOfStreamException)
        {
            // The BCL fault types System.Formats.Tar raises, wrapped into the one type the processor
            // catches. FormatException is listed because TarReader reports an unparsable octal field
            // that way, and it descends from neither IOException nor ArgumentException — the same
            // kind of gap that let SharpCompress's whole hierarchy through unhandled.
            //
            // Not bare Exception: a NullReferenceException here is a bug in this class, and it must
            // reach the framework's general catch with its stack trace rather than be reported to an
            // operator as a corrupt file.
            throw new ArchiveExtractionException(ex.Message, ex);
        }
    }

    private static List<ExtractedEntry> ExtractCore(Stream archive)
    {
        var entries = new List<ExtractedEntry>();

        // Counts every node TarReader actually yielded, before the type filter below drops any of
        // them. Deliberately separate from entries.Count — see the guard below for why the two
        // counts answer different questions and only one of them means "unreadable archive".
        var rawEntryCount = 0;

        // leaveOpen: true, unlike ZipExtractor's default false. The all-zero check below re-reads
        // this same stream after the reader is done with it (to tell a genuinely empty tar from a
        // corrupt one), which requires the stream to still be open at that point — ZipExtractor has
        // no equivalent second pass, so it can let ZipArchive close the stream on disposal.
        using (var reader = new TarReader(archive, leaveOpen: true))
        {
            while (reader.GetNextEntry() is { } entry)
            {
                rawEntryCount++;

                // Regular files only. TarEntryType also has ContiguousFile and SparseFile, both of
                // which can carry real content — GNU tar --sparse emits SparseFile — and both are
                // excluded here deliberately, not overlooked: this extractor's fixtures only ever
                // needed RegularFile/V7RegularFile, and widening the filter to the other two is a
                // considered follow-up, not a gap found by accident.
                if (entry.EntryType is not (TarEntryType.RegularFile or TarEntryType.V7RegularFile)
                    || entry.DataStream is null)
                {
                    continue;
                }

                using var buffer = new MemoryStream();
                entry.DataStream.CopyTo(buffer);

                entries.Add(new ExtractedEntry(
                    // The archive records a path; the node carries a name. A separator in a node
                    // name would read as structure the document does not have.
                    Path.GetFileName(entry.Name),
                    buffer.ToArray(),
                    // .UtcDateTime, not .DateTime or .LocalDateTime: ModificationTime is a
                    // DateTimeOffset, and only the UtcDateTime conversion yields DateTimeKind.Utc. A
                    // Local or Unspecified DateTime renders through System.Text.Json without the
                    // trailing Z (or with an offset instead), which fails the output schema one hop
                    // after this method returns — a branch where the failure is discarded rather
                    // than reported.
                    entry.ModificationTime.UtcDateTime));
            }
        }

        // Measured directly against this in-box reader (see task-6-report.md, fix round 1):
        // TarReader.GetNextEntry returns null — no exception at all — not only for a genuinely
        // empty tar (all-zero terminator blocks) but also for 0 bytes, a single 512-byte zero block,
        // and a 512-byte zero block followed by ~10 bytes of garbage. Only input that reaches far
        // enough to fail a field (a bad checksum, an unparsable number, a truncated read past the
        // first block) throws. So "zero entries" alone does not distinguish a healthy empty archive
        // from a corrupt one — a truncated or partially-zeroed file whose first block happens to be
        // zero would otherwise read as a healthy empty archive, which is exactly the false-HEALTHY
        // result this system's design rejects throughout.
        //
        // The check is "not all zero bytes", not "has any bytes" or a stricter POSIX two-block rule:
        // a genuinely empty archive IS all zero bytes (0 bytes and a lone zero block both satisfy
        // this, the former vacuously), and must still succeed.
        //
        // Gated on rawEntryCount, not entries.Count — fix round 2, after review caught the
        // regression this introduced. Those two counts answer different questions: rawEntryCount is
        // "did TarReader manage to read anything at all", which is the only question that means the
        // archive itself is unreadable; entries.Count is "did anything survive the regular-file
        // filter above", which a perfectly healthy directory-only, symlink-only, hardlink-only, or
        // sparse/contiguous-only archive can legitimately answer "no" to. Gating on entries.Count
        // made every one of those valid archives throw InvalidDataException — reporting a healthy
        // file as corrupt, which is worse than the empty-list result it replaced. Do not collapse
        // this back to entries.Count: that is exactly the "simplification" this comment exists to
        // head off.
        if (rawEntryCount == 0 && !IsAllZeroBytes(archive))
        {
            // ArchiveExtractionException, not InvalidDataException as this originally threw. The
            // type is now the seam's, not the BCL's: FileReaderProcessor catches exactly one type,
            // so a guard that threw a BCL type would only be caught by coincidence of that type
            // happening to still be on a list somewhere else.
            throw new ArchiveExtractionException(
                "The tar produced no entries and is not all zero bytes — treating it as corrupt " +
                "rather than returning it as a healthy empty archive.");
        }

        return entries;
    }

    /// <summary>
    /// Re-reads the whole stream from the start. Only reached when TarReader yielded no nodes at
    /// all, so the extra pass costs nothing on the common path of an archive that actually has
    /// content — including an archive whose content is entirely nodes this extractor filters out.
    /// </summary>
    private static bool IsAllZeroBytes(Stream stream)
    {
        stream.Position = 0;
        var buffer = new byte[8192];
        int read;
        while ((read = stream.Read(buffer, 0, buffer.Length)) > 0)
        {
            for (var i = 0; i < read; i++)
            {
                if (buffer[i] != 0)
                {
                    return false;
                }
            }
        }

        return true;
    }
}
```

- [ ] **Step 4: Register it**

In `src/Processor.FileReader/ProcessorHost.cs`, beside the zip registration:

```csharp
        builder.Services.AddSingleton<IArchiveExtractor, TarExtractor>();
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj --filter-namespace BaseApi.Tests.FileReader`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/Processor.FileReader src/tests/BaseApi.Tests/FileReader
git commit -m "feat(filereader): tar, regular files only"
```

---

### Task 7: Rar

The one format whose fixture cannot be built from source, because SharpCompress reads rar and cannot write one.

**Files:**
- Create: `src/Processor.FileReader/Extractors/RarExtractor.cs`
- Modify: `src/Processor.FileReader/ProcessorHost.cs`
- Create: `src/tests/BaseApi.Tests/FileReader/Fixtures/three-entries.rar` (committed binary)
- Create: `src/tests/BaseApi.Tests/FileReader/Fixtures/README.md`
- Modify: `src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
- Test: `src/tests/BaseApi.Tests/FileReader/RarExtractorTests.cs`

**Interfaces:**
- Consumes: `IArchiveExtractor`, `ExtractedEntry` (Task 4).
- Produces: `public sealed class RarExtractor : IArchiveExtractor`.

- [ ] **Step 1: Generate the fixture**

```bash
mkdir -p /tmp/skp-rar && cd /tmp/skp-rar
printf 'id\n' > a.csv
printf 'id,name\n' > b.csv
printf 'RIFFWAVEfake' > c.wav
"/c/Program Files/WinRAR/Rar.exe" a -ep three-entries.rar a.csv b.csv c.wav
cp three-entries.rar "$OLDPWD/src/tests/BaseApi.Tests/FileReader/Fixtures/three-entries.rar"
```

`-ep` stores bare names with no paths, which is what the extractor's `Path.GetFileName` expects to be a no-op on.

- [ ] **Step 2: Write the fixture README**

`src/tests/BaseApi.Tests/FileReader/Fixtures/README.md`:

```markdown
# FileReader test fixtures

`three-entries.rar` — a.csv (3 bytes), b.csv (8 bytes), c.wav (12 bytes).

**This is the only test input in this repo that is not built from source, and the reason is
structural rather than convenience.** SharpCompress READS rar and cannot write one, and there is no
in-box or offline-feed writer either — so a test cannot construct a rar the way `ZipExtractorTests`
constructs a zip and `TarExtractorTests` constructs a tar.

Regenerate it with the WinRAR CLI:

    printf 'id\n' > a.csv
    printf 'id,name\n' > b.csv
    printf 'RIFFWAVEfake' > c.wav
    "C:\Program Files\WinRAR\Rar.exe" a -ep three-entries.rar a.csv b.csv c.wav

`-ep` stores bare names with no directory paths. If you regenerate with different content, update
the byte lengths asserted in `RarExtractorTests`.
```

- [ ] **Step 3: Copy the fixture to output**

In `src/tests/BaseApi.Tests/BaseApi.Tests.csproj`, in the ItemGroup holding `Resilience\Fixtures\*.json`:

```xml
    <None Include="FileReader\Fixtures\*.rar" CopyToOutputDirectory="PreserveNewest" />
```

- [ ] **Step 4: Write the failing test**

`src/tests/BaseApi.Tests/FileReader/RarExtractorTests.cs`:

```csharp
using System.Text;
using System.Text.Json;
using BaseApi.Tests.Support;
using BaseProcessor.Core.Processing;
using Messaging.Transport;
using Microsoft.Extensions.Options;
using NSubstitute;
using Processor.FileReader;
using Processor.FileReader.Extractors;
using SharpCompress.Archives.Rar;
using Xunit;

namespace BaseApi.Tests.FileReader;

/// <summary>
/// Rar, against a committed fixture. Every other extractor's test builds its archive from bytes;
/// this one cannot, because SharpCompress reads rar and cannot write one. See Fixtures/README.md for
/// how the file is regenerated.
/// </summary>
public sealed class RarExtractorTests : IDisposable
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");
    private static readonly Guid E = Guid.Parse("55555555-5555-5555-5555-555555555555");

    private readonly string _dir = Directory.CreateTempSubdirectory("skp-filereader-rar-").FullName;

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    private static Stream Fixture()
        => File.OpenRead(Path.Combine(
            AppContext.BaseDirectory, "FileReader", "Fixtures", "three-entries.rar"));

    /// <summary>The fixture's first <paramref name="length"/> bytes — the real archive, cut short.</summary>
    private static byte[] Truncated(int length)
    {
        using var full = Fixture();
        var buffer = new byte[length];
        var read = full.Read(buffer, 0, length);
        return read == length ? buffer : buffer[..read];
    }

    [Fact]
    public void ItHandlesRarAndNothingElse()
    {
        var extractor = new RarExtractor();

        // RAR4 and RAR5 differ only in the seventh byte, and SharpCompress reads both.
        Assert.True(extractor.CanHandle(new byte[] { 0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x00 }));
        Assert.True(extractor.CanHandle(new byte[] { 0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x01 }));

        Assert.False(extractor.CanHandle(new byte[] { 0x50, 0x4B, 0x03, 0x04 }));
        Assert.False(extractor.CanHandle(new byte[] { 0x52, 0x61, 0x72 }));
        Assert.False(extractor.CanHandle(ReadOnlySpan<byte>.Empty));
    }

    [Fact]
    public void EveryFileInTheArchiveBecomesAnEntry()
    {
        using var stream = Fixture();

        var entries = new RarExtractor().Extract(stream);

        Assert.Equal(3, entries.Count);
        Assert.Contains(entries, e => e.Name == "a.csv");
        Assert.Contains(entries, e => e.Name == "b.csv");
        Assert.Contains(entries, e => e.Name == "c.wav");
    }

    [Fact]
    public void TheEntryContentIsWhatWasArchived()
    {
        using var stream = Fixture();

        var entries = new RarExtractor().Extract(stream);
        var a = entries.Single(e => e.Name == "a.csv");

        Assert.Equal("id\n", Encoding.UTF8.GetString(a.Content));
    }

    [Fact]
    public void ACorruptArchiveThrowsForTheProcessorToCatch()
    {
        // THIS TEST USED TO ASSERT ThrowsAny<Exception>, AND THAT IS WHY THE SEAM FAILURE SURVIVED
        // REVIEW. Its name claims the throw is one the processor catches; ThrowsAny asserts only
        // that something was thrown, and what was actually thrown here was a SharpCompress
        // exception, which descends from SharpCompressException : Exception and matched NONE of the
        // BCL types the processor's catch list held. So an ordinary corrupt rar failed the step via
        // the framework's general catch — "the transform faulted", at Warning, with a stack trace
        // and no file path anywhere — and this test passed over it, every time.
        //
        // A test that accepts any exception cannot distinguish the outcome it is named for from the
        // outcome it exists to prevent. The seam's type is the assertion.
        using var stream = new MemoryStream(Encoding.UTF8.GetBytes("this is not a rar"));

        Assert.Throws<ArchiveExtractionException>(() => new RarExtractor().Extract(stream));
    }

    [Fact]
    public async Task ACorruptArchiveFailsTheStepNamingThePath()
    {
        // THE PROCESSOR-LEVEL TEST RAR NEVER HAD, and the one that fails outright against the old
        // catch list. Only zip had this test; the extractor-level assertions above prove the
        // extractor throws, and prove nothing about whether the throw reaches the processor's catch
        // or escapes past it. §9 puts these checks in ProcessAsync precisely so the path is in the
        // message, so the message is what gets asserted.
        //
        // Not a truncation: an ORDINARY corrupt rar, which is the case that was broken. The two
        // truncation windows below were the only inputs that ever reached this template, because
        // they trip RarExtractor's own guard rather than SharpCompress's parser.
        var path = Path.Combine(_dir, "broken.rar");
        File.WriteAllText(path, "this is not a rar");

        var processor = new FileReaderProcessor(
            new RecordingLogger<FileReaderProcessor>(),
            Options.Create(new FileReaderOptions()),
            new FileContentBuilder([new RarExtractor()]));
        processor.BeginDispatch(
            new DispatchState(Substitute.For<IQueueSender>(), C, W, S, P));

        var ex = await Assert.ThrowsAsync<FailedException>(() => processor.ExecuteAsync(
            Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { filePath = path })),
            """{"ExpectedExtension":".rar","MinimumSizeBytes":0,"MaximumSizeBytes":65536}""",
            E, CancellationToken.None));

        Assert.Contains($"extracting {path} failed", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ATruncatedArchiveJustPastTheSignatureThrowsForTheProcessorToCatch()
    {
        // The false-HEALTHY window fix round 1 found: RarArchive.Open succeeds and Entries
        // enumerates to zero with NO exception for the real fixture truncated to 8-11 bytes — just
        // past the RAR5 signature, before the main archive header is complete. Measured directly
        // against this exact fixture (see task-7-fix-round-1-report.md) before adding the guard in
        // RarExtractor. Without the raw-entry-count guard, this reads as a healthy empty archive
        // rather than the truncated one it is — the same class of result Task 6 found in TarReader.
        using var stream = new MemoryStream(Truncated(10));

        Assert.Throws<ArchiveExtractionException>(() => new RarExtractor().Extract(stream));
    }

    [Fact]
    public void ATruncatedArchiveJustPastTheMainHeaderThrowsForTheProcessorToCatch()
    {
        // The second false-HEALTHY window fix round 1 found: the fixture truncated to 23-26 bytes —
        // just past the main archive header, before the first file header — opens and enumerates to
        // zero entries with no exception, same as the signature-window case above. Measured
        // directly against this exact fixture (see task-7-fix-round-1-report.md).
        using var stream = new MemoryStream(Truncated(24));

        Assert.Throws<ArchiveExtractionException>(() => new RarExtractor().Extract(stream));
    }

    [Fact]
    public void SharpCompressReportsLastModifiedTimeAsLocalKind()
    {
        // A canary on a library assumption, not a guard on RarExtractor's own output.
        // DateTime.ToUniversalTime() returns Kind.Utc unconditionally by .NET contract, regardless
        // of what Kind the input carried — so asserting the *output* Kind (the test below this one)
        // is true for every possible thing SharpCompress could hand back, and cannot detect the
        // change that actually matters. This test pins the input side instead: SharpCompress must
        // keep reporting LastModifiedTime as Kind.Local for RarExtractor's bare .ToUniversalTime()
        // call to remain correct. If a future SharpCompress version started returning an
        // already-correct UTC value labelled Local or Unspecified — plausible for RAR5's
        // UTC-flagged extended-time field, which this WinRAR-produced fixture does not exercise —
        // .ToUniversalTime() would silently double-shift it while still landing on Kind.Utc, and
        // the test below would keep passing over a wrong value. A failure HERE means
        // RarExtractor's conversion must be re-derived against whatever Kind SharpCompress now
        // reports — it does not mean this assertion should be relaxed to match.
        using var stream = Fixture();
        using var rar = RarArchive.Open(stream);

        Assert.All(rar.Entries, e => Assert.Equal(DateTimeKind.Local, e.LastModifiedTime!.Value.Kind));
    }

    [Fact]
    public void ExtractedEntryModifiedUtcCarriesUtcKind()
    {
        // Task 4/6/7 review requirement: SharpCompress exposes LastModifiedTime as a DateTime?, not
        // a DateTimeOffset. Measured directly against this fixture (see task-7-report.md): the value
        // comes back with Kind.Local (WinRAR records wall-clock time with no timezone, and
        // SharpCompress marks the DateTime it hands back as Local rather than Unspecified), so
        // .ToUniversalTime() correctly converts using this machine's offset and yields Kind.Utc.
        //
        // This assertion alone cannot regress-test the SharpCompress-side assumption —
        // .ToUniversalTime() always returns Kind.Utc no matter what Kind it was given, so this test
        // is documentation of the intended output shape, not a guard. The guard on the input
        // assumption is SharpCompressReportsLastModifiedTimeAsLocalKind, above.
        using var stream = Fixture();

        var entries = new RarExtractor().Extract(stream);

        Assert.All(entries, e => Assert.Equal(DateTimeKind.Utc, e.ModifiedUtc!.Value.Kind));
    }
}
```

- [ ] **Step 5: Run test to verify it fails**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj --filter-class BaseApi.Tests.FileReader.RarExtractorTests`
Expected: FAIL to compile — `RarExtractor` does not exist.

- [ ] **Step 6: Write the extractor**

`src/Processor.FileReader/Extractors/RarExtractor.cs`:

```csharp
using SharpCompress.Archives;
using SharpCompress.Archives.Rar;
using SharpCompress.Common;

namespace Processor.FileReader.Extractors;

/// <summary>
/// Rar, on SharpCompress — the only extractor here that needs a package, because .NET ships no rar
/// reader and there is no writing one either.
/// <para>
/// <b>Read-only, and that is the format's limit rather than this class's.</b> SharpCompress does not
/// write rar. Nothing here needs to; it is why the test fixture is a committed binary.
/// </para>
/// <para>
/// <b>Solid archives are only partly supported by the library.</b> A solid rar stores entries as one
/// compressed stream, so random access to a single entry is not always possible. This class reads
/// every entry in order, which is the access pattern that works — but an archive the library cannot
/// read throws, and the processor reports it as an unextractable file rather than a partial success.
/// </para>
/// <para>
/// <b>The false-HEALTHY hole IS present here, same class as Tar's.</b> Fix round 1 measured this
/// directly by truncating the committed fixture byte by byte (see task-7-fix-round-1-report.md):
/// most short truncations throw out of <c>RarArchive.Open</c> or out of the <c>Entries</c>
/// enumeration, but two windows do not — truncated to 8-11 bytes (just past the RAR5 signature) or
/// to 23-26 bytes (just past the main archive header, before the first file header) both open
/// successfully and enumerate zero entries with no exception anywhere. An earlier round of this
/// class tried only an empty stream, garbage bytes, an all-zero block, and a 100-byte truncation —
/// all well outside this narrow window — and wrongly concluded no guard was needed. That was a gap
/// in what was tried, not a property of the library: do not trust "every shape I tried throws" as
/// a proof that no shape exists that doesn't.
/// </para>
/// </summary>
public sealed class RarExtractor : IArchiveExtractor
{
    public string Extension => ".rar";

    /// <summary>
    /// <c>Rar!\x1A\x07</c>, then <c>\x00</c> for RAR4 or <c>\x01</c> for RAR5. Both are claimed —
    /// SharpCompress reads either, so distinguishing them here would only be able to refuse a file
    /// the extractor can actually open.
    /// </summary>
    public bool CanHandle(ReadOnlySpan<byte> header)
        => header.Length >= 7
           && header[0] == (byte)'R' && header[1] == (byte)'a' && header[2] == (byte)'r'
           && header[3] == (byte)'!' && header[4] == 0x1A && header[5] == 0x07
           && (header[6] == 0x00 || header[6] == 0x01);

    /// <summary>
    /// Every file entry, one level deep, or an <see cref="ArchiveExtractionException"/> saying why
    /// the archive could not be read.
    /// <para>
    /// <b>The wrapping is not decoration; it is the fix for a measured seam failure.</b> Every
    /// SharpCompress fault descends from <c>SharpCompress.Common.SharpCompressException :
    /// System.Exception</c> — <c>InvalidFormatException</c>, <c>ArchiveException</c>,
    /// <c>IncompleteArchiveException</c> and the rest — and none of them is an
    /// <see cref="InvalidDataException"/>, an <see cref="IOException"/>, a
    /// <see cref="NotSupportedException"/> or an <see cref="ArgumentException"/>, which is what the
    /// processor's catch list held when this class was added. So an ordinary corrupt rar failed the
    /// step through the framework's general catch instead, with the file path in no line of it. Only
    /// the two narrow truncation windows that trip this class's OWN guard ever produced the
    /// contract's <c>extracting {FilePath} failed:</c> message.
    /// </para>
    /// </summary>
    public IReadOnlyList<ExtractedEntry> Extract(Stream archive)
    {
        try
        {
            return ExtractCore(archive);
        }
        catch (SharpCompressException ex)
        {
            // The library's own root type, so every present and future SharpCompress fault is
            // covered by one clause rather than by a list that must be revisited whenever the
            // package is upgraded. This is the only place in this project that names a SharpCompress
            // type; the processor stays free of the package entirely, which is the point.
            throw new ArchiveExtractionException(ex.Message, ex);
        }
        catch (Exception ex) when (ex is InvalidDataException or IOException
                                      or NotSupportedException or ArgumentException
                                      or EndOfStreamException)
        {
            // SharpCompress does not wrap everything it touches: a stream read that fails, or an
            // argument it rejects before its own validation runs, still surfaces as a BCL type.
            //
            // Not bare Exception: a NullReferenceException here is a bug in this class, and it must
            // reach the framework's general catch with its stack trace rather than be reported to an
            // operator as a corrupt file.
            throw new ArchiveExtractionException(ex.Message, ex);
        }
    }

    private static List<ExtractedEntry> ExtractCore(Stream archive)
    {
        using var rar = RarArchive.Open(archive);

        var entries = new List<ExtractedEntry>();

        // Counts every entry rar.Entries actually yielded, before the directory/null-key filter
        // below drops any of them — the same split TarExtractor makes, and for the same reason.
        // Gating the guard below on entries.Count instead would throw on a valid directory-only
        // (or, here, entirely-directories) rar, which is a healthy archive with legitimately zero
        // file nodes. See TarExtractor.Extract's guard comment for the fuller account of that
        // regression; it applies unchanged to this class.
        var rawEntryCount = 0;

        foreach (var entry in rar.Entries)
        {
            rawEntryCount++;

            // Directories carry no content and no node, matching zip and tar.
            if (entry.IsDirectory || entry.Key is null)
            {
                continue;
            }

            using var stream = entry.OpenEntryStream();
            using var buffer = new MemoryStream();
            stream.CopyTo(buffer);

            entries.Add(new ExtractedEntry(
                // Key is a path within the archive. The node carries a name, as with tar.
                Path.GetFileName(entry.Key),
                // MemoryStream.ToArray() never returns null, so Content is never null here — the
                // record's constructor takes a non-nullable byte[], and FileContentBuilder.Leaf
                // dereferences it unguarded.
                buffer.ToArray(),
                // LastModifiedTime is a DateTime?, not a DateTimeOffset like Zip's LastWriteTime or
                // Tar's ModificationTime — SharpCompress has no offset to give for rar. Measured
                // directly against this fixture (see task-7-report.md): the Kind SharpCompress hands
                // back is Local, not Unspecified — WinRAR records wall-clock time with no timezone,
                // and SharpCompress marks the DateTime it constructs as this machine's local time.
                // .ToUniversalTime() on a Local value converts using that offset and returns
                // DateTimeKind.Utc, which is what this class must produce: System.Text.Json renders
                // a Local or Unspecified DateTime without the trailing Z (or with an offset instead),
                // failing the output schema one hop after this method returns — a branch where the
                // failure is discarded rather than reported. Had the measured Kind instead come back
                // Unspecified, this same call would still be correct: .NET's ToUniversalTime treats
                // Unspecified identically to Local.
                //
                // KNOWN LIMITATION, not fixable from here: a plain rar timestamp carries no timezone
                // at all, so a rar built on a machine in a different timezone than this one produces
                // a ModifiedUtc that is wrong by that offset — there is no information left in the
                // format to recover the true instant. RAR5 defines an optional UTC-flagged extended-
                // time field that would sidestep this, but this fixture (built by a plain WinRAR
                // `a` command) does not carry it, and SharpCompress's LastModifiedTime does not
                // expose whether it was present. This is a format/library ceiling, not a bug here.
                entry.LastModifiedTime?.ToUniversalTime()));
        }

        // Fix round 1: measured directly against this library by truncating the real committed
        // fixture byte by byte (see task-7-fix-round-1-report.md). Two windows open successfully via
        // RarArchive.Open and then enumerate zero entries with no exception anywhere in the loop
        // above: truncated to 8-11 bytes (just past the RAR5 signature, before the main archive
        // header is complete) and truncated to 23-26 bytes (just past the main archive header,
        // before the first file header). Both are ordinary corruption — a transfer or write cut off
        // in the first ~30 bytes — and both would otherwise read as a healthy empty archive, exactly
        // the class of false-HEALTHY result Task 6 found in TarReader.
        //
        // Unlike TarExtractor, there is no "all zero bytes is a legitimately empty archive" case to
        // exempt: an all-zero stream and an empty stream both already fail at RarArchive.Open above
        // (measured in task-7-report.md), and a rar with a valid, fully-read signature and header
        // always carries at least an end-of-archive record — SharpCompress has no path that yields a
        // genuinely empty rar with rawEntryCount == 0. So this guard is unconditional: any zero raw
        // yield is corruption, full stop. If a genuinely empty-but-valid rar is ever found that this
        // rejects, that is new information this comment does not currently have — stop and report it
        // rather than loosening this check to guess at what such an archive would look like.
        if (rawEntryCount == 0)
        {
            // ArchiveExtractionException, not InvalidDataException as this originally threw. The
            // type is now the seam's, not the BCL's — see TarExtractor's matching guard.
            throw new ArchiveExtractionException(
                "The rar produced no entries even though it opened successfully — treating it as " +
                "corrupt rather than returning it as a healthy empty archive.");
        }

        return entries;
    }
}
```

- [ ] **Step 7: Register it**

In `src/Processor.FileReader/ProcessorHost.cs`, beside the other two:

```csharp
        builder.Services.AddSingleton<IArchiveExtractor, RarExtractor>();
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj --filter-namespace BaseApi.Tests.FileReader`
Expected: all PASS.

If `RarArchive.Open` on the corrupt stream returns without throwing and the throw comes only at enumeration, keep the test as written — `Extract` enumerates, so the exception still surfaces from this method. If SharpCompress reports `LastModifiedTime` as `DateTime?` in local kind, the `ToUniversalTime()` above already normalizes it; assert nothing about the value, since WinRAR records local time and the fixture's timestamp is not a property of this code.

- [ ] **Step 9: Commit**

```bash
git add src/Processor.FileReader src/tests/BaseApi.Tests/FileReader src/tests/BaseApi.Tests/BaseApi.Tests.csproj
git commit -m "feat(filereader): rar, from a fixture this repo cannot build"
```

---

### Task 8: The output schema

**Files:**
- Modify: `src/Processor.FileReader/schema/output.json` (replacing the Task 1 placeholder)
- Create: `src/Processor.FileReader/schema/README.md`
- Test: `src/tests/BaseApi.Tests/FileReader/FileReaderSchemaTests.cs`

**Interfaces:**
- Consumes: `FileNode`, `FileDocument.Options` (Task 4), `ProcessorJsonSchemaValidator` from `BaseProcessor.Core.Validation`.
- Produces: the registered schema definition, as a file. *(Shown in its Task 11 form: the two-key node, unrolled to depth 1.)*

- [ ] **Step 1: Write the failing test**

`src/tests/BaseApi.Tests/FileReader/FileReaderSchemaTests.cs`:

```csharp
using System.Text;
using System.Text.Json;
using BaseProcessor.Core.Validation;
using Processor.FileReader;
using Xunit;

namespace BaseApi.Tests.FileReader;

/// <summary>
/// The schema, against the documents this processor actually emits — and through the SAME validator
/// the post handler uses, not a different JSON Schema library configured differently.
/// <para>
/// It matters more than a schema test usually would. A schema failure in production is DESTRUCTIVE:
/// the post handler reports Failed with EntryId Guid.Empty and acks, so nothing is written to L2 and
/// the step's input was already reclaimed. The file has been read, decoded and expanded, and the
/// result is discarded with no key to recover it.
/// </para>
/// </summary>
public sealed class FileReaderSchemaTests
{
    private static string Definition()
        => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "schema", "output.json"));

    private static byte[] Serialize(FileNode node)
        => JsonSerializer.SerializeToUtf8Bytes(node, FileDocument.Options);

    private static DateTime Stamp => new(2026, 9, 8, 11, 2, 14, DateTimeKind.Utc);

    private static FileNode Leaf(string name, string extension, string text)
        => new(
            new FileMetadata(name, extension, text.Length, Stamp, Stamp, 0),
            new FileContent.Bytes(Encoding.UTF8.GetBytes(text)));

    private static FileNode Archive(string name, params FileNode[] entries)
        => new(
            new FileMetadata(name, ".zip", 40219, Stamp, Stamp, entries.Length),
            entries.Length == 0 ? null : new FileContent.Entries(entries));

    [Fact]
    public void APlainFileDocumentValidates()
    {
        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(), Serialize(Leaf("orders.csv", ".csv", "id")), out var errors);

        Assert.True(ok, string.Join("; ", errors));
    }

    [Fact]
    public void AnArchiveDocumentValidates()
    {
        var archive = Archive(
            "orders.zip", Leaf("a.csv", ".csv", "id"), Leaf("b.csv", ".csv", "id,name"));

        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(), Serialize(archive), out var errors);

        Assert.True(ok, string.Join("; ", errors));
    }

    [Fact]
    public void AnArchiveThatExpandedToNothingValidates()
    {
        // content: null is the third form the root may take, and it is the one an empty archive
        // produces. It is NOT an empty array — see FileNode.Content.
        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(), Serialize(Archive("empty.zip")), out var errors);

        Assert.True(ok, string.Join("; ", errors));
    }

    [Fact]
    public void APascalCaseDocumentIsRejected()
    {
        // The drift this schema exists to catch. MessagingJson is PascalCase and governs the
        // envelope; a document serialized with those options instead of FileDocument.Options would
        // rename every property here.
        //
        // It ALSO drops FileNodeConverter, so content would be written as whatever the default
        // serializer makes of the FileContent hierarchy rather than as one value. Either failure
        // alone is enough; the schema catches both as the same rejection.
        //
        // global:: because this namespace (BaseApi.Tests.FileReader) has a sibling
        // BaseApi.Tests.Messaging namespace that shadows the unqualified "Messaging" lookup.
        var pascal = JsonSerializer.SerializeToUtf8Bytes(
            Leaf("orders.csv", ".csv", "id"), global::Messaging.Contracts.MessagingJson.Options);

        var ok = ProcessorJsonSchemaValidator.TryValidate(Definition(), pascal, out _);

        Assert.False(ok);
    }

    [Fact]
    public void AnUnknownPropertyIsRejected()
    {
        // additionalProperties:false is what makes this a structural contract rather than a set of
        // suggestions — and it is how providerName leaking into the document would be caught.
        var json = """
            {"metadata":{"name":"a.csv","extension":".csv","sizeBytes":3,"createdUtc":null,
             "modifiedUtc":null,"entryCount":0},"content":"aWQK",
             "providerName":"acme"}
            """;

        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(), Encoding.UTF8.GetBytes(json), out _);

        Assert.False(ok);
    }

    [Fact]
    public void ASeparateEntriesKeyIsRejected()
    {
        // The shape this document had before content became one key. A producer still writing the
        // old pair must not pass: `entries` is now an unknown property, and additionalProperties
        // false is what says so.
        var json = """
            {"metadata":{"name":"o.zip","extension":".zip","sizeBytes":9,"createdUtc":null,
             "modifiedUtc":null,"entryCount":0},"content":null,"entries":[]}
            """;

        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(), Encoding.UTF8.GetBytes(json), out _);

        Assert.False(ok);
    }

    [Fact]
    public void ADocumentNestedDeeperThanTheSchemaAdmitsIsRejected()
    {
        // THE DEPTH RULE, and it is structural rather than declared: the baseline unrolls to one
        // level, so `depth0` admits only a string and an entry carrying its own entries has nowhere
        // to validate against.
        //
        // This is the failure a step whose MaxDepth exceeds the registered schema produces. It is
        // the contract working — nothing keeps MaxDepth and the schema in sync on purpose — and it
        // is why FileReaderProcessor logs the depth it actually reached: this rejection carries no
        // file path and no payload by the time an operator sees it.
        var json = """
            {"metadata":{"name":"o.zip","extension":".zip","sizeBytes":9,"createdUtc":null,
             "modifiedUtc":null,"entryCount":1},
             "content":[{"metadata":{"name":"i.zip","extension":".zip","sizeBytes":3,
               "createdUtc":null,"modifiedUtc":null,"entryCount":1},
               "content":[{"metadata":{"name":"d.csv","extension":".csv","sizeBytes":3,
                 "createdUtc":null,"modifiedUtc":null,"entryCount":0},"content":"aWQK"}]}]}
            """;

        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(), Encoding.UTF8.GetBytes(json), out _);

        Assert.False(ok);
    }

    [Fact]
    public void ADocumentRoundTripsThroughTheConverter()
    {
        // The converter's Read exists for this: asserting on the SHAPE that comes back rather than
        // on a string, so a change to whitespace or property order does not read as a regression.
        var archive = Archive("orders.zip", Leaf("a.csv", ".csv", "id"));

        var back = JsonSerializer.Deserialize<FileNode>(Serialize(archive), FileDocument.Options);

        var entries = Assert.IsType<FileContent.Entries>(back!.Content);
        var bytes = Assert.IsType<FileContent.Bytes>(Assert.Single(entries.Value).Content);
        Assert.Equal("id", Encoding.UTF8.GetString(bytes.Value));
    }
}
```

Add the schema to the test output — in `src/tests/BaseApi.Tests/BaseApi.Tests.csproj`, beside the rar fixture line:

```xml
    <None Include="..\..\Processor.FileReader\schema\output.json"
          Link="schema\output.json" CopyToOutputDirectory="PreserveNewest" />
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj --filter-class BaseApi.Tests.FileReader.FileReaderSchemaTests`
Expected: FAIL — the placeholder `{}` accepts everything, so the three rejection tests fail.

- [ ] **Step 3: Write the schema**

`src/Processor.FileReader/schema/output.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "#/$defs/depth1",
  "$defs": {
    "depth1": {
      "type": "object",
      "additionalProperties": false,
      "required": ["metadata", "content"],
      "properties": {
        "metadata": { "$ref": "#/$defs/metadata" },
        "content": {
          "type": ["string", "array", "null"],
          "items": { "$ref": "#/$defs/depth0" }
        }
      }
    },
    "depth0": {
      "type": "object",
      "additionalProperties": false,
      "required": ["metadata", "content"],
      "properties": {
        "metadata": { "$ref": "#/$defs/metadata" },
        "content": { "type": "string" }
      }
    },
    "metadata": {
      "type": "object",
      "additionalProperties": false,
      "required": ["name", "extension", "sizeBytes", "createdUtc", "modifiedUtc", "entryCount"],
      "properties": {
        "name": { "type": "string", "minLength": 1 },
        "extension": { "type": "string" },
        "sizeBytes": { "type": "integer", "minimum": 0 },
        "createdUtc": { "type": ["string", "null"] },
        "modifiedUtc": { "type": ["string", "null"] },
        "entryCount": { "type": "integer", "minimum": 0 }
      }
    }
  }
}
```

- [ ] **Step 4: Write the schema README**

`src/Processor.FileReader/schema/README.md`:

```markdown
# FileReader output schema

`output.json` is the BASELINE: the shape every FileReader document has, and nothing about a
particular feed. It is registered against the processor identity as the output schema.

## What it asserts

- The `{metadata, content}` node, `additionalProperties: false` at every level.
- `content` is one key holding one of three things: a base64 string (a file's bytes), an array of
  nodes (what an archive expanded to), or null (an archive that expanded to nothing). It is never
  two keys that can disagree — see `FileContent` for why that pair was collapsed.
- **Depth one, structurally.** `depth1` may hold an array of `depth0`; `depth0`'s `content` is a
  string and nothing else, so it cannot hold entries. That is the whole depth rule.

## How depth is expressed, and why it is not a keyword

JSON Schema has no depth keyword, and there is no way to say "at most two levels" without writing
the levels out. So the bound is a property of the STRUCTURE: N node definitions, each referencing
the next, and the last one admitting only a string. You read the limit by counting the definitions.

To admit a zip whose entries are themselves zips — `MaxDepth: 2` on the step — add a level and
repoint the root:

    "$ref": "#/$defs/depth2",

    "depth2": {
      "type": "object", "additionalProperties": false,
      "required": ["metadata", "content"],
      "properties": {
        "metadata": { "$ref": "#/$defs/metadata" },
        "content": { "type": ["string", "array", "null"],
                     "items": { "$ref": "#/$defs/depth1" } }
      }
    },

leaving `depth1` and `depth0` as they are. Each level is the same object with `items` pointing one
step shallower.

**The alternative — a self-referencing `$ref` admitting any depth — is rejected.** It would validate
every document this processor can produce, which sounds like a feature and is the opposite: a schema
that admits any depth can never tell you the depth was wrong. The unrolled form is what makes a
`MaxDepth` the schema does not expect show up as a validation failure instead of a surprise
downstream.

**Nothing keeps `MaxDepth` and this file in sync, and that is deliberate.** The step payload states
what to expand; this states what a document may look like. When they disagree the document fails
validation, exactly as a wrong entry count does. Note what that costs before raising either: the post
handler reports `Failed` with `EntryId: Guid.Empty` and no file path, so the processor logs the depth
it actually reached in `ProcessAsync` — that log line is where the diagnosis lives.

**The depth here caps every workflow using this processor.** `OutputSchemaId` is a column on the
processor row, not the step, so there is one output schema per processor identity. A step's
`MaxDepth` can sit at or below what this file admits, never above it. A feed needing more than the
baseline allows needs its own processor identity, not just its own payload.

## What it cannot assert

**Anything about file content.** `content` is base64, so the bytes are unconstrained by
construction. `format` and `contentEncoding` are ANNOTATIONS in 2020-12, not assertions, and
`ProcessorJsonSchemaValidator.DefaultOptions` does not enable format assertion — adding
`"format": "date-time"` to the timestamps would document them and enforce nothing. Use `pattern` if
that is ever needed.

**Which of the three `content` forms a given node should have.** `type: ["string", "array", "null"]`
admits all three at `depth1`, because the root may legitimately be any of them: a plain file, an
expanded archive, or an empty one. A feed that always ships an archive can narrow it — see below.

## Per-feed variants

Entry count is enforced HERE rather than in the step payload, so a feed with a fixed layout gets its
own schema derived from this one. Constrain `content`, never `metadata.entryCount` — the array is
the fact, the count is derived, and pinning the derived field would let a counting bug satisfy a
rule the content fails.

Always an archive, exactly three entries:

    "content": { "type": "array", "minItems": 3, "maxItems": 3,
                 "items": { "$ref": "#/$defs/depth0" } }

Dropping `"string"` and `"null"` from the type is what makes it "always an archive": a plain file or
an empty archive now fails.

One `.wav` and two `.csv`, order-independent — note that `minContains`/`maxContains` must sit beside
their OWN `contains`, so two cardinality rules need two subschemas under `allOf`:

    "content": {
      "type": "array", "minItems": 3, "maxItems": 3,
      "items": { "$ref": "#/$defs/depth0" },
      "allOf": [
        { "contains": { "$ref": "#/$defs/wav" }, "minContains": 1, "maxContains": 1 },
        { "contains": { "$ref": "#/$defs/csv" }, "minContains": 2, "maxContains": 2 }
      ]
    }

with narrowing definitions that REFINE `depth0` rather than replace it — legal because `$ref` takes
sibling keywords in 2020-12, and note the omitted `additionalProperties`, which only ever sees
`properties` declared in the same schema object:

    "wav": { "$ref": "#/$defs/depth0",
             "properties": { "metadata": { "properties": { "extension": { "const": ".wav" } } } } }

## Registration

**This schema is not registered by the build.** It is a database row against the processor identity,
applied as a deploy step. Until it is, `OutputSchemaId` is null, `TryValidate` returns true without
decoding anything, and **nothing enforces entry count or depth anywhere** — this file is its only
home.

Note what a failure costs, because it decides where checks belong: the post handler reports
`Failed` with `EntryId: Guid.Empty` and acks. Nothing is written to L2 and the step's input was
already reclaimed, so the branch is gone with no key to recover it and no file path in the log. Every
check that CAN live in `ProcessAsync` does.
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj --filter-class BaseApi.Tests.FileReader.FileReaderSchemaTests`
Expected: all five PASS.

- [ ] **Step 6: Commit**

```bash
git add src/Processor.FileReader/schema src/tests/BaseApi.Tests/FileReader \
        src/tests/BaseApi.Tests/BaseApi.Tests.csproj
git commit -m "feat(filereader): the output schema, and what it cannot say"
```

---

### Task 9: Deployment

**Files:**
- Create: `k8s/37-processor-filereader.yaml`
- Modify: `k8s/kustomization.yaml`
- Modify: `k8s/README.md`

**Interfaces:**
- Consumes: `FileReaderOptions` binding (Task 3).
- Produces: the `processor-filereader` Deployment and the `/mnt/skp-files/in` mount contract the live test seeds.

- [ ] **Step 1: Write the manifest**

Copy `k8s/34-processor-kafkaimporter.yaml` to `k8s/37-processor-filereader.yaml`, then replace the header comment and adjust. Every `processor-kafkaimporter` becomes `processor-filereader`; the `Kafka__BrokerList` env entry is removed; keep the three probes verbatim. Replace the header with:

```yaml
# processor-filereader — turns an absolute file path into one structured document of metadata and
# content, expanding zip/tar/rar archives one level. A downstream transform: it has an input and it
# produces output, so it is neither an importer nor an exporter. No Service — its only inbound
# traffic is the kubelet hitting the pod IP for probes.
#
# EXPECT IT TO SIT NOT-READY UNTIL A PROCESSOR ROW EXISTS, exactly as the other processors do.
# `kubectl rollout status` will time out; that timeout is the expected signal, not a fault.
#
# THE MOUNT IS THE KIND NODE'S FILESYSTEM, NOT WINDOWS. This cluster's node container was created
# with no extraMounts, and Docker cannot add a bind mount to a running container — so hostPath here
# resolves inside desktop-control-plane. Reaching C:\ would mean recreating the cluster with
# `extraMounts: hostPath: /run/desktop/mnt/host/c/...`, which loses every processor identity row,
# schema definition, workflow and step in Postgres along with Redis L2. Fixtures are seeded onto the
# node instead:
#
#   docker cp <file> desktop-control-plane:/mnt/skp-files/in/
#
# See §13 of docs/superpowers/specs/2026-09-09-file-reader-design.md.
#
# THE MEMORY LIMIT IS HIGHER THAN THE OTHER PROCESSORS' 384Mi, AND THAT IS NOT PADDING. A file does
# not cost its own size in flight: the raw bytes, the serialized UTF-8 document, the
# document, the broker message body and a full JsonDocument DOM at validation can coexist — and the
# work and post consumers are the SAME process, so a dispatch and a branch overlap. At the 32MiB
# ceiling below that is comfortably over 200MB transient. Lower FileReader__MaxFileSizeBytes or
# raise this limit; do not move one without the other.
```

In the container spec, add to `env`:

```yaml
            # The pod's ceiling. A step payload naming more than this fails by name rather than
            # being clamped — see FileReaderOptions.
            - name: FileReader__MaxFileSizeBytes
              value: "33554432"
```

and after `resources`:

```yaml
          resources:
            requests: { memory: "256Mi" }
            limits:   { memory: "768Mi" }
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

- [ ] **Step 2: Register it with kustomize**

In `k8s/kustomization.yaml`, after the `36-orchestrator.yaml` line:

```yaml
  - 37-processor-filereader.yaml
```

- [ ] **Step 3: Validate the manifest renders**

```bash
kubectl kustomize k8s/ | grep -A4 'name: skp-files'
```

Expected: the volume and the mount both appear, with `readOnly: true` on the mount.

- [ ] **Step 4: Document the seeding step**

Append to `k8s/README.md`:

```markdown
## Seeding files for processor-filereader

`processor-filereader` reads absolute paths under `/mnt/skp-files/in`, mounted read-only from the
kind node. **That path is on the node container, not on Windows** — the node was created without
`extraMounts` and Docker cannot add one to a running container.

Put a file where the pod can read it:

    docker cp ./orders.zip desktop-control-plane:/mnt/skp-files/in/

Then the Kafka record the importer consumes names it:

    {"filePath": "/mnt/skp-files/in/orders.zip"}

It survives pod restarts and the `kind load` + SourceHash-repoint deploy loop. Only recreating the
cluster loses it.
```

- [ ] **Step 5: Commit**

```bash
git add k8s/37-processor-filereader.yaml k8s/kustomization.yaml k8s/README.md
git commit -m "feat(filereader): the manifest, and why its mount is the node"
```

---

### Task 10: The live chain

`KafkaImporter → FileReader → KafkaExporter`, against the real cluster.

**Files:**
- Create: `src/tests/BaseApi.Tests/Live/FileReader/FileReaderLiveTests.cs`
- Create: `src/tests/BaseApi.Tests/Live/FileReader/Fixtures/orders.zip` — built by the test, not committed
- Modify: `k8s/README.md`

**Interfaces:**
- Consumes: `RealStack` (existing), the manifest (Task 9), the document shape (Task 4).
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Write the test**

`src/tests/BaseApi.Tests/Live/FileReader/FileReaderLiveTests.cs`:

```csharp
using System.Diagnostics;
using System.IO.Compression;
using System.Text;
using System.Text.Json;
using Confluent.Kafka;
using Xunit;

namespace BaseApi.Tests.Live.FileReader;

/// <summary>
/// The whole chain, against the real cluster: a path on the node becomes a document on the
/// exporter's topic. Everything in the hermetic FileReader suite runs against temp files and an
/// in-process processor, which is what keeps that run cluster-free — but it also means the mount,
/// the manifest's ceiling, the workflow wiring and the two entry conditions have no test above them.
/// This file is that test.
/// <para>
/// Needs <c>SKP_REALSTACK=1</c>, <c>k8s/port-forward-realstack.ps1</c> and
/// <c>tools/kafka-dev-broker.ps1 -Up</c>. It seeds a file onto the kind node with <c>docker cp</c>,
/// so the node must be running.
/// </para>
/// </summary>
[Trait("Category", RealStack.Category)]
public sealed class FileReaderLiveTests
{
    private const string NodeDir = "/mnt/skp-files/in";
    private static string Node => RealStack.Get("SKP_KIND_NODE", "desktop-control-plane");
    private static string OutTopic => RealStack.Get("SKP_KAFKA_OUT_TOPIC", "skp-documents");

    /// <summary>Builds a zip locally and copies it onto the node the pod mounts.</summary>
    private static string SeedZip(string name, params (string Entry, string Text)[] entries)
    {
        var local = Path.Combine(Path.GetTempPath(), name);
        using (var file = File.Create(local))
        using (var archive = new ZipArchive(file, ZipArchiveMode.Create))
        {
            foreach (var (entry, text) in entries)
            {
                using var writer = new StreamWriter(archive.CreateEntry(entry).Open());
                writer.Write(text);
            }
        }

        Run("docker", $"cp \"{local}\" {Node}:{NodeDir}/{name}");
        return $"{NodeDir}/{name}";
    }

    private static void Run(string file, string arguments)
    {
        using var process = Process.Start(new ProcessStartInfo(file, arguments)
        {
            RedirectStandardError = true,
            RedirectStandardOutput = true,
        })!;
        process.WaitForExit(60_000);

        Assert.True(process.ExitCode == 0,
            $"{file} {arguments} exited {process.ExitCode}: {process.StandardError.ReadToEnd()}");
    }

    private static void Produce(string path)
    {
        using var producer = new ProducerBuilder<Null, string>(
            new ProducerConfig { BootstrapServers = RealStack.KafkaBrokers }).Build();

        producer.Produce(RealStack.KafkaTopic, new Message<Null, string>
        {
            // providerName rides along exactly as the org's records carry it, and the reader must
            // ignore it. Its absence from the document below is the assertion.
            Value = JsonSerializer.Serialize(new { filePath = path, providerName = "acme-feed" }),
        });
        producer.Flush(TimeSpan.FromSeconds(15));
    }

    /// <summary>The first document on the out topic whose root name matches, or null on timeout.</summary>
    private static JsonElement? Await(string name, TimeSpan timeout)
    {
        using var consumer = new ConsumerBuilder<Ignore, string>(new ConsumerConfig
        {
            BootstrapServers = RealStack.KafkaBrokers,
            GroupId = $"live-filereader-{Guid.NewGuid():N}",
            AutoOffsetReset = AutoOffsetReset.Earliest,
        }).Build();

        consumer.Subscribe(OutTopic);

        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            var result = consumer.Consume(TimeSpan.FromSeconds(5));
            if (result?.Message?.Value is null)
            {
                continue;
            }

            var root = JsonDocument.Parse(result.Message.Value).RootElement;
            if (root.TryGetProperty("metadata", out var metadata)
                && metadata.GetProperty("name").GetString() == name)
            {
                return root.Clone();
            }
        }

        return null;
    }

    [Fact]
    public void AZipOnTheNodeBecomesADocumentOnTheOutTopic()
    {
        RealStack.SkipUnlessEnabled();

        var name = $"orders-{Guid.NewGuid():N}.zip";
        var path = SeedZip(name, ("a.csv", "id\n"), ("b.csv", "id,name\n"));

        Produce(path);

        var doc = Await(name, TimeSpan.FromMinutes(2));
        Assert.True(doc.HasValue, $"no document naming {name} reached {OutTopic} within two minutes");

        var root = doc!.Value;
        Assert.Equal(JsonValueKind.Null, root.GetProperty("content").ValueKind);
        Assert.Equal(2, root.GetProperty("metadata").GetProperty("entryCount").GetInt32());
        Assert.Equal(2, root.GetProperty("entries").GetArrayLength());

        // The one field the reader is required to drop.
        Assert.DoesNotContain("acme", root.GetRawText(), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void AFileWithTheWrongExtensionProducesNoDocument()
    {
        RealStack.SkipUnlessEnabled();

        // The step is wired ExpectedExtension ".zip". A .txt fails the dry guard, the step reports
        // Failed, and the exporter — wired PreviousCompleted, not Always — never runs. The absence
        // IS the assertion: an Always-wired exporter would publish here, which is the bug that
        // wiring caused before.
        var name = $"orders-{Guid.NewGuid():N}.txt";
        var local = Path.Combine(Path.GetTempPath(), name);
        File.WriteAllText(local, "not a zip");
        Run("docker", $"cp \"{local}\" {Node}:{NodeDir}/{name}");

        Produce($"{NodeDir}/{name}");

        Assert.Null(Await(name, TimeSpan.FromSeconds(90)));
    }
}
```

- [ ] **Step 2: Run it hermetically to prove it skips**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj --filter-namespace BaseApi.Tests.Live.FileReader`
Expected: both tests **skipped**, with the message naming `SKP_REALSTACK=1`. A live test that runs in a hermetic pass is the failure this gate exists to prevent.

- [ ] **Step 3: Document the workflow wiring**

Append to `k8s/README.md`:

```markdown
### The FileReader workflow

`KafkaImporter → FileReader → KafkaExporter`. **Both edges are `entryCondition: 1`
(`PreviousCompleted`), not `4` (`Always`).**

`Always` is what the sample steps use, and copying it here is a live bug rather than a style
choice: a failed importer hands off with `ExecutionId` empty, and an `Always`-wired exporter then
runs on an entry-shaped dispatch every time an import fails. That is the class of error
`BaseImporter`'s edge guard exists to make impossible. `0` (`PreviousProcessing`) is rejected by the
step validator and is also what an omitted field binds to, which is why the value is always stated.

The FileReader step's payload:

    {"expectedExtension": ".zip", "minimumSizeBytes": 1, "maximumSizeBytes": 33554432}

`maximumSizeBytes` must not exceed the pod's `FileReader__MaxFileSizeBytes`, or every dispatch fails
with a config error naming both numbers.
```

- [ ] **Step 4: Run the full hermetic suite**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: 0 failed, exit code 0, with every test under `Live/` skipped. Read the shape, not a remembered total — the count only grows.

- [ ] **Step 5: Commit**

```bash
git add src/tests/BaseApi.Tests/Live/FileReader k8s/README.md
git commit -m "feat(filereader): the live chain, and the absence that proves the entry condition"
```

---

### Task 11: Nested expansion

**Executed 2026-09-09 in commit `bc3d8ed`, after Tasks 1-10 had shipped.** Boxes are ticked here
because this task ran with its outcome known; Tasks 1-10 were executed without ever ticking theirs.

Makes depth a step decision instead of a constant, and moves extractor selection off the declared
extension onto the file's own signature — because below the first level there is no declaration to
resolve against. Collapses the node's two content fields into one.

**Files:**
- Modify: `src/Processor.FileReader/Extractors/IArchiveExtractor.cs`
- Modify: `src/Processor.FileReader/Extractors/ZipExtractor.cs`
- Modify: `src/Processor.FileReader/Extractors/TarExtractor.cs`
- Modify: `src/Processor.FileReader/Extractors/RarExtractor.cs`
- Modify: `src/Processor.FileReader/FileNode.cs`
- Modify: `src/Processor.FileReader/FileContentBuilder.cs`
- Modify: `src/Processor.FileReader/FileReaderConfig.cs`
- Modify: `src/Processor.FileReader/FileReaderProcessor.cs`
- Modify: `src/Processor.FileReader/schema/output.json`
- Modify: `src/Processor.FileReader/schema/README.md`
- Test: `src/tests/BaseApi.Tests/FileReader/FileReaderDepthTests.cs` (new)
- Test: `src/tests/BaseApi.Tests/FileReader/FileReaderDocumentTests.cs`, `FileReaderSchemaTests.cs`, `ZipExtractorTests.cs`, `TarExtractorTests.cs`, `RarExtractorTests.cs`
- Test: `src/tests/BaseApi.Tests/Live/FileReader/FileReaderLiveTests.cs`
- Modify: `docs/superpowers/specs/2026-09-09-file-reader-design.md`, `k8s/README.md`

**Interfaces:**
- Consumes: everything Tasks 4-8 produced.
- Produces: `public abstract record FileContent` with nested `Bytes(byte[] Value)` and
  `Entries(IReadOnlyList<FileNode> Value)`; `public sealed record FileNode(FileMetadata Metadata, FileContent? Content)`;
  `public sealed class FileNodeConverter : JsonConverter<FileNode>`;
  `internal sealed record FileBuildResult(FileNode Node, int DepthReached)`;
  `FileReaderConfig(string ExpectedExtension, long MinimumSizeBytes, long MaximumSizeBytes, int MaxDepth = DefaultMaxDepth)`
  with `DefaultMaxDepth = 1` and `MaxSupportedDepth = 64`;
  `IArchiveExtractor { string Extension { get; } bool CanHandle(ReadOnlySpan<byte> header); ... }`.

- [x] **Step 1: Turn the extractor seam onto the bytes**

  `CanHandle(string extension)` becomes `CanHandle(ReadOnlySpan<byte> header)`. Zip claims the local
  file header signature and the End Of Central Directory one — the empty archive must be claimed
  too, or it never reaches the exemption that tells an empty zip from a corrupt one. Rar claims the
  RAR4 and RAR5 signatures, which differ only in their seventh byte.

  **Tar is the awkward one: no signature at offset zero.** Its `ustar` marker sits at byte 257, so it
  needs 262 bytes where zip needs four. A buffer shorter than a signature answers `false` rather than
  throwing — a two-byte file is a legitimate leaf. A pre-POSIX v7 tar carries no marker and is not
  claimed; inferring it from a plausible octal checksum would claim files that merely look numeric.

  A `ReadOnlySpan` cannot be captured by a lambda, so the resolution loop is a plain `foreach` rather
  than `FirstOrDefault` — copying the array to satisfy LINQ would allocate a second copy of every
  file.

- [x] **Step 2: Keep the declaration for the one job it can still do**

  `IArchiveExtractor` also gains `string Extension { get; }`. **It is not how an extractor is
  chosen.** It serves one check, at the top level only: a file whose name declares an archive and
  whose bytes are no archive at all fails the step.

  **Without it, corruption reads as success.** This was caught by three existing tests going green
  that should have been red — `ACorruptArchiveFailsTheStepNamingThePath` in each extractor's suite.
  A damaged zip matches no signature, so signature-only dispatch makes it a leaf carrying its raw
  bytes and the step reports Completed over a file nobody can open. That is exactly the
  false-HEALTHY failure Tasks 5-7 built guards for, reached from *outside* those guards, because a
  corrupt header is never shown to an extractor at all.

  The check asks whether the bytes are *an* archive, not whether they are the named one: a tar
  called `.zip` is read as a tar. Nested entries get no such check — an entry called `.zip` that is
  not one is a leaf, because otherwise whoever built the archive decides whether this processor
  succeeds.

- [x] **Step 3: Collapse the node's two content fields into one**

  `FileNode(Metadata, byte[]? Content, IReadOnlyList<FileNode> Entries)` becomes
  `FileNode(Metadata, FileContent? Content)`, where `FileContent` is an abstract record with a
  private constructor and two nested cases. The old pair encoded the leaf/archive distinction twice
  — null content *and* empty entries — and nothing stopped them disagreeing.

  `content` is therefore one JSON key holding a base64 string, an array of nodes, or `null`. **Null
  means no entries**, which an empty archive produces; an archive that was not *opened* carries its
  own bytes like any other file.

  `FileNodeConverter` is hand-written rather than `[JsonDerivedType]`, whose `$type` discriminator
  would appear in the document and have to be admitted by the output schema — a serializer detail
  leaking into a contract other systems read. Its `Read` exists so a test can round-trip and assert
  on shape rather than on a string.

- [x] **Step 4: Make depth a payload field, bounded**

  `int MaxDepth = DefaultMaxDepth` on `FileReaderConfig`. **The fallback is the parameter's own
  default, and it was measured rather than assumed:** `System.Text.Json` *does* apply a C# default
  parameter value when a positional record's property is missing, so an omitted field arrives as `1`
  and not as `default(int)`. A nullable was drafted first on the opposite belief and dropped once a
  probe showed missing → `1`, explicit `0` → `0`. So `0`, negatives and anything above
  `MaxSupportedDepth = 64` are rejected payloads, diagnosed before the file is opened.

  **No pod-level twin.** `MaxFileSizeBytes` exists because bytes cost memory; depth costs nothing on
  its own, and the bytes it reaches are already bounded. The 64 cap is a stack bound, not a memory
  one — it is what makes plain recursion in the builder safe, and it stops a self-reproducing archive
  (which expands to a copy of itself at roughly constant size) from grinding against the byte ceiling
  for thousands of levels first.

- [x] **Step 5: Thread one expansion budget through the whole tree**

  `MaximumSizeBytes` becomes a single running total across every level rather than per level. **This
  is what makes depth safe to raise:** a per-level ceiling would let a depth-5 archive hold five
  times the limit, and the pod's memory does not care which level a byte came from. Charged before
  each child is built, so the walk stops at the entry that crosses it rather than after its whole
  subtree is materialised. A nested archive is charged twice on purpose — once as its parent's entry,
  once for what it expands to — because at that moment both exist in memory.

  The residual from Task 5 is unchanged and still recorded: an extractor materialises every entry's
  bytes before the loop runs, so this bounds the document, not any single extractor's own peak.

- [x] **Step 6: Return the depth reached, and log it**

  `Build` returns `FileBuildResult(FileNode Node, int DepthReached)`, and `ProcessAsync` logs
  `expanded to depth {DepthReached} of {MaxDepth}` alongside the entry count.

  **It is logged because it survives nowhere else.** A document deeper than the registered schema
  admits fails validation one hop later, reported with `EntryId: Guid.Empty`, no payload and no file
  path, at Information. Nothing in that failure says how deep the document went, so a `MaxDepth`
  disagreeing with the schema would otherwise be undiagnosable.

- [x] **Step 7: Rewrite the schema for the two-key node, still at depth 1**

  `depth1` holds an array of `depth0`; `depth0`'s `content` is a string and nothing else. **Depth is
  structural, not declared** — JSON Schema has no depth keyword, so the bound is N definitions each
  referencing the next, and you read the limit by counting them. `type: ["string", "array", "null"]`
  with `items` covers all three forms without a `oneOf`, because `items` is ignored for the
  non-array cases.

  **A self-referencing `$ref` admitting any depth was rejected** for the reason it sounds appealing:
  a schema that admits any depth can never tell you the depth was wrong.

  **Nothing keeps `MaxDepth` and the schema in sync, deliberately.** They disagree by failing
  validation, exactly as a wrong entry count does. And because `OutputSchemaId` is a column on the
  processor row rather than the step, the schema's depth caps *every* workflow using this processor:
  a step's `MaxDepth` may sit at or below it, never above.

- [x] **Step 8: Tests**

  New `FileReaderDepthTests` pins both stop conditions independently — the depth limit, and running
  out of archives — plus: the default leaving a nested archive as a file; `MaxDepth: 2` expanding a
  zip of zips; null content on an empty archive; the budget as one running total across levels; the
  payload range rejection; a nested entry chosen by bytes not name, and its mirror; the top-level
  cross-check firing on corruption and *not* firing on a mislabelled-but-valid archive; the depth
  log line.

  Existing suites moved from `entries` onto `content`, and the three `CanHandle` tests became
  signature tests. `FileReaderSchemaTests` gained the empty-archive case, a rejection of the old
  separate `entries` key, a depth-2 rejection, and a converter round-trip.

- [x] **Step 9: Commit**

  942 tests, 0 failed, 25 skipped (all `Live/`). Spec sections 3, 5, 6, 7, 8 and 14 rewritten, along
  with `k8s/README.md`'s payload section and `schema/README.md`.

---

## After the plan

The processor is built, tested and deployable, but **not yet running**. Three operational steps remain, and they are deliberately outside the plan because each needs a decision or a credential the plan cannot carry:

1. **Build and load the image**, then repoint the processor row's `SourceHash` — every processor rebuild needs it.
2. **Register the processor row** (name `file-reader`, version `1.0.0`), and the **output schema row** from `src/Processor.FileReader/schema/output.json`. Until the schema row exists, `OutputSchemaId` is null and nothing enforces entry count.
3. **Wire the workflow** with both edges at `entryCondition: 1` and the step payload from `k8s/README.md`.

**And one decision Task 11 leaves open:** the baseline schema stays at depth 1, so any step wanting
`MaxDepth` above 1 needs the schema row deepened first — and because that row is per processor
identity, deepening it raises the cap for every workflow using `file-reader 1.0.0`. A feed needing
more than the baseline allows needs its own processor identity, not just its own payload. Nothing
enforces the relationship; a disagreement surfaces as a validation failure with no file path, which
is why the depth reached is logged.
