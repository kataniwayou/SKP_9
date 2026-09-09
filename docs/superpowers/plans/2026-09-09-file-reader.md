# FileReader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `Processor.FileReader`, a downstream processor that turns an absolute file path into one recursive `{metadata, content, entries}` document, expanding zip/tar/rar archives one level.

**Architecture:** A plain `BaseProcessor<FileReaderConfig>` — not an edge. `FileReaderProcessor.ProcessAsync` is *dry*: it validates config, parses the locator, checks extension and size from `FileInfo`, and reads bytes without ever opening the file's contents. It hands those bytes to `FileContentBuilder`, which resolves an `IArchiveExtractor` by extension, expands one level, and builds the document. One `SendToPostAsync` on the dispatch's own `executionId`.

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
- Produces: `Processor.FileReader.FileReaderProcessor : BaseProcessor<FileReaderConfig>`; `Processor.FileReader.FileReaderConfig(string ExpectedExtension, long MinimumSizeBytes, long MaximumSizeBytes) : ProcessorConfig`; `Processor.FileReader.ProcessorHost.Create(string[] args, ProcessorIdentityFound identity, Action<IConfigurationBuilder>? configure = null)` returning `IHost`.

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
/// <see cref="FileReaderOptions"/>, added in a later task.
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

        Assert.Contains("needs a step payload", ex.Message, StringComparison.Ordinal);
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
/// the base64 string during serialization, the document, the broker message body and a full
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
            throw new FailedException(
                "FileReader needs a step payload naming ExpectedExtension, MinimumSizeBytes and "
                + "MaximumSizeBytes");
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

The leaf path end to end: a non-archive file becomes a root node with content and no entries, and one branch is sent on the dispatch's own execution id.

**Files:**
- Create: `src/Processor.FileReader/FileNode.cs`
- Create: `src/Processor.FileReader/FileContentBuilder.cs`
- Modify: `src/Processor.FileReader/FileReaderProcessor.cs`
- Modify: `src/Processor.FileReader/ProcessorHost.cs`
- Test: `src/tests/BaseApi.Tests/FileReader/FileReaderDocumentTests.cs`

**Interfaces:**
- Consumes: the guards (Task 3).
- Produces: `public sealed record FileMetadata(string Name, string Extension, long SizeBytes, DateTime? CreatedUtc, DateTime? ModifiedUtc, int EntryCount)`; `public sealed record FileNode(FileMetadata Metadata, byte[]? Content, IReadOnlyList<FileNode> Entries)`; `internal static class FileDocument { public static readonly JsonSerializerOptions Options; }`; `internal sealed class FileContentBuilder { public FileNode Build(byte[] bytes, FileInfo info, FileReaderConfig config); }`. `FileReaderProcessor(ILogger<FileReaderProcessor>, IOptions<FileReaderOptions>, FileContentBuilder)`.

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
        Assert.Empty(doc.GetProperty("entries").EnumerateArray());
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
        // No extractor is registered in these tests, so a .zip is content rather than entries. The
        // switch is the extractor set, never the file's magic bytes.
        var (processor, sender) = Build();
        var path = WriteText("bundle.zip", "not really a zip");

        var sends = await SendsOf(sender, processor, path,
            """{"ExpectedExtension":".zip","MinimumSizeBytes":0,"MaximumSizeBytes":4096}""", E);

        var doc = JsonDocument.Parse(Assert.Single(sends).Data).RootElement;
        Assert.Equal(JsonValueKind.String, doc.GetProperty("content").ValueKind);
        Assert.Empty(doc.GetProperty("entries").EnumerateArray());
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
/// How many entries the node holds. Derived from <see cref="FileNode.Entries"/> and present for a
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
/// One node of the document, and the shape is identical at every level so the schema is a single
/// self-referencing definition.
/// <para>
/// <b>A leaf carries <see cref="Content"/> and an empty <see cref="Entries"/>; an archive carries
/// null content and its expansion.</b> Carrying the archive's own bytes as well would double the
/// blob for no consumer.
/// </para>
/// <para>
/// <b>Depth is one.</b> A zip inside a zip is a leaf: recorded with its bytes and metadata, not
/// expanded. Recursion is the one dimension here with no natural bound.
/// </para>
/// </summary>
public sealed record FileNode(
    FileMetadata Metadata,
    byte[]? Content,
    IReadOnlyList<FileNode> Entries);

/// <summary>The one serializer configuration for the document.</summary>
internal static class FileDocument
{
    /// <summary>
    /// <b>camelCase, pinned explicitly.</b> <c>MessagingJson</c> leaves the naming policy null —
    /// PascalCase — and it governs the <c>ProcessedData</c> envelope, not the bytes inside
    /// <c>Data</c>. Inheriting its convention here would silently rename every property the output
    /// schema names.
    /// <para>
    /// <c>Never</c> ignore: <c>content</c> must be emitted as <c>null</c> on an archive rather than
    /// omitted, because the schema requires the key to be present.
    /// </para>
    /// </summary>
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
    };
}
```

- [ ] **Step 4: Write the builder**

`src/Processor.FileReader/FileContentBuilder.cs`:

```csharp
namespace Processor.FileReader;

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
    /// The document. An extension with a registered extractor is expanded one level; anything else
    /// is a leaf.
    /// </summary>
    public FileNode Build(byte[] bytes, FileInfo info, FileReaderConfig config)
    {
        // The EXTENSION decides, not the file's magic bytes. It has already been checked against the
        // payload, so this switch is on a value the workflow author declared — a file whose contents
        // disagree with its name fails in the extractor, which is where that fault belongs.
        var extractor = _extractors.FirstOrDefault(e => e.CanHandle(config.ExpectedExtension));

        if (extractor is null)
        {
            return Leaf(info.Name, bytes, info.CreationTimeUtc, info.LastWriteTimeUtc);
        }

        using var stream = new MemoryStream(bytes, writable: false);
        var entries = extractor.Extract(stream);

        var children = entries
            .Select(e => Leaf(e.Name, e.Content, createdUtc: null, e.ModifiedUtc))
            .ToList();

        return new FileNode(
            new FileMetadata(
                info.Name,
                info.Extension,
                info.Length,
                info.CreationTimeUtc,
                info.LastWriteTimeUtc,
                children.Count),
            // Null, not the archive's bytes: the entries ARE its content, and carrying both doubles
            // the blob.
            Content: null,
            children);
    }

    /// <summary>
    /// A node with content and no entries. Used for a plain file and for every archive entry, which
    /// is what makes depth exactly one — an entry is never itself expanded.
    /// </summary>
    private static FileNode Leaf(string name, byte[] content, DateTime? createdUtc, DateTime? modifiedUtc)
        => new(
            new FileMetadata(
                name,
                Path.GetExtension(name),
                content.LongLength,
                createdUtc,
                modifiedUtc,
                EntryCount: 0),
            content,
            []);
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
/// One archive format. Registered in the container and resolved by extension, so adding a format is
/// one class and one registration.
/// </summary>
public interface IArchiveExtractor
{
    /// <summary>True when this extractor handles the extension, compared case-insensitively.</summary>
    bool CanHandle(string extension);

    /// <summary>
    /// Every entry, one level deep. Directories are skipped rather than represented — an empty
    /// directory carries no content and no metadata worth a node.
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
        var settings = Validate(config);
        var path = ReadPath(data);
        var info = Inspect(path, settings);
        var bytes = Read(info);

        var node = builder.Build(bytes, info, settings);

        // The SHAPE of the result, never its content. A count and a size are safe to log; the bytes
        // are upstream data and stay out of every template in this system.
        logger.LogInformation(
            "read {FilePath} as {SizeBytes} bytes with {EntryCount} entries",
            info.FullName, info.Length, node.Metadata.EntryCount);

        var document = JsonSerializer.SerializeToUtf8Bytes(node, FileDocument.Options);

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

        Assert.True(extractor.CanHandle(".zip"));
        Assert.True(extractor.CanHandle(".ZIP"));
        Assert.False(extractor.CanHandle(".tar"));
    }

    [Fact]
    public async Task AnArchiveBecomesEntriesAndCarriesNoContentOfItsOwn()
    {
        var path = WriteZip("orders.zip", ("a.csv", "id\n"), ("b.csv", "id,name\n"));

        var doc = await DocumentOf(path);

        Assert.Equal(JsonValueKind.Null, doc.GetProperty("content").ValueKind);
        Assert.Equal(2, doc.GetProperty("metadata").GetProperty("entryCount").GetInt32());
        Assert.Equal(2, doc.GetProperty("entries").GetArrayLength());
    }

    [Fact]
    public async Task EachEntryIsALeafWithItsOwnMetadata()
    {
        var path = WriteZip("orders.zip", ("a.csv", "id\n"));

        var doc = await DocumentOf(path);
        var entry = doc.GetProperty("entries")[0];

        Assert.Equal("a.csv", entry.GetProperty("metadata").GetProperty("name").GetString());
        Assert.Equal(".csv", entry.GetProperty("metadata").GetProperty("extension").GetString());
        Assert.Equal(3, entry.GetProperty("metadata").GetProperty("sizeBytes").GetInt64());
        Assert.Equal("id\n", Encoding.UTF8.GetString(entry.GetProperty("content").GetBytesFromBase64()));
        Assert.Empty(entry.GetProperty("entries").EnumerateArray());
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
        var entry = doc.GetProperty("entries")[0];

        Assert.Equal("inner.zip", entry.GetProperty("metadata").GetProperty("name").GetString());
        Assert.Equal(JsonValueKind.String, entry.GetProperty("content").ValueKind);
        Assert.Empty(entry.GetProperty("entries").EnumerateArray());
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
            doc.GetProperty("entries")[0].GetProperty("metadata").GetProperty("name").GetString());
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
/// </summary>
public sealed class ZipExtractor : IArchiveExtractor
{
    public bool CanHandle(string extension)
        => ".zip".Equals(extension, StringComparison.OrdinalIgnoreCase);

    public IReadOnlyList<ExtractedEntry> Extract(Stream archive)
    {
        using var zip = new ZipArchive(archive, ZipArchiveMode.Read);

        var entries = new List<ExtractedEntry>(zip.Entries.Count);

        foreach (var entry in zip.Entries)
        {
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
            entries.Add(new ExtractedEntry(
                entry.Name, buffer.ToArray(), entry.LastWriteTime.UtcDateTime));
        }

        return entries;
    }
}
```

- [ ] **Step 4: Turn an extraction fault into a failed step**

In `src/Processor.FileReader/FileReaderProcessor.cs`, wrap the builder call:

```csharp
        FileNode node;
        try
        {
            node = builder.Build(bytes, info, settings);
        }
        catch (Exception ex) when (ex is InvalidDataException or IOException
                                      or NotSupportedException or ArgumentException)
        {
            // A corrupt or truncated archive. Deterministic — it fails identically on every
            // redelivery — so it is a failed step, not something to park. No log here: the framework
            // writes this message verbatim when it catches the exception.
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
using Processor.FileReader.Extractors;
using Xunit;

namespace BaseApi.Tests.FileReader;

public sealed class TarExtractorTests
{
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

        Assert.True(extractor.CanHandle(".tar"));
        Assert.True(extractor.CanHandle(".TAR"));
        Assert.False(extractor.CanHandle(".zip"));
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
        using var stream = new MemoryStream(Encoding.UTF8.GetBytes("this is not a tar"));

        Assert.ThrowsAny<Exception>(() => new TarExtractor().Extract(stream));
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
    public bool CanHandle(string extension)
        => ".tar".Equals(extension, StringComparison.OrdinalIgnoreCase);

    public IReadOnlyList<ExtractedEntry> Extract(Stream archive)
    {
        using var reader = new TarReader(archive, leaveOpen: true);

        var entries = new List<ExtractedEntry>();

        while (reader.GetNextEntry() is { } entry)
        {
            // Regular files only. Directories, links and device nodes carry no content this document
            // has a place for, and representing them would make entryCount disagree with the nodes a
            // reader sees.
            if (entry.EntryType is not (TarEntryType.RegularFile or TarEntryType.V7RegularFile)
                || entry.DataStream is null)
            {
                continue;
            }

            using var buffer = new MemoryStream();
            entry.DataStream.CopyTo(buffer);

            entries.Add(new ExtractedEntry(
                // The archive records a path; the node carries a name. A separator in a node name
                // would read as structure the document does not have.
                Path.GetFileName(entry.Name),
                buffer.ToArray(),
                entry.ModificationTime.UtcDateTime));
        }

        return entries;
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
using Processor.FileReader.Extractors;
using Xunit;

namespace BaseApi.Tests.FileReader;

/// <summary>
/// Rar, against a committed fixture. Every other extractor's test builds its archive from bytes;
/// this one cannot, because SharpCompress reads rar and cannot write one. See Fixtures/README.md for
/// how the file is regenerated.
/// </summary>
public sealed class RarExtractorTests
{
    private static Stream Fixture()
        => File.OpenRead(Path.Combine(
            AppContext.BaseDirectory, "FileReader", "Fixtures", "three-entries.rar"));

    [Fact]
    public void ItHandlesRarAndNothingElse()
    {
        var extractor = new RarExtractor();

        Assert.True(extractor.CanHandle(".rar"));
        Assert.True(extractor.CanHandle(".RAR"));
        Assert.False(extractor.CanHandle(".zip"));
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
        using var stream = new MemoryStream(Encoding.UTF8.GetBytes("this is not a rar"));

        Assert.ThrowsAny<Exception>(() => new RarExtractor().Extract(stream));
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
/// </summary>
public sealed class RarExtractor : IArchiveExtractor
{
    public bool CanHandle(string extension)
        => ".rar".Equals(extension, StringComparison.OrdinalIgnoreCase);

    public IReadOnlyList<ExtractedEntry> Extract(Stream archive)
    {
        using var rar = RarArchive.Open(archive);

        var entries = new List<ExtractedEntry>();

        foreach (var entry in rar.Entries)
        {
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
                buffer.ToArray(),
                entry.LastModifiedTime?.ToUniversalTime()));
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
- Produces: the registered schema definition, as a file.

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

    private static FileNode Leaf(string name, string extension, string text)
        => new(
            new FileMetadata(name, extension, text.Length,
                new DateTime(2026, 9, 8, 11, 2, 14, DateTimeKind.Utc),
                new DateTime(2026, 9, 8, 11, 2, 14, DateTimeKind.Utc), 0),
            Encoding.UTF8.GetBytes(text),
            []);

    [Fact]
    public void APlainFileDocumentValidates()
    {
        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(), Serialize(Leaf("orders.csv", ".csv", "id\n")), out var errors);

        Assert.True(ok, string.Join("; ", errors));
    }

    [Fact]
    public void AnArchiveDocumentValidates()
    {
        var archive = new FileNode(
            new FileMetadata("orders.zip", ".zip", 40219,
                new DateTime(2026, 9, 8, 11, 2, 14, DateTimeKind.Utc),
                new DateTime(2026, 9, 8, 11, 2, 14, DateTimeKind.Utc), 2),
            Content: null,
            [Leaf("a.csv", ".csv", "id\n"), Leaf("b.csv", ".csv", "id,name\n")]);

        var ok = ProcessorJsonSchemaValidator.TryValidate(Definition(), Serialize(archive), out var errors);

        Assert.True(ok, string.Join("; ", errors));
    }

    [Fact]
    public void APascalCaseDocumentIsRejected()
    {
        // The drift this schema exists to catch. MessagingJson is PascalCase and governs the
        // envelope; a document serialized with those options instead of FileDocument.Options would
        // rename every property here.
        var pascal = JsonSerializer.SerializeToUtf8Bytes(
            Leaf("orders.csv", ".csv", "id\n"), Messaging.Contracts.MessagingJson.Options);

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
             "modifiedUtc":null,"entryCount":0},"content":"aWQK","entries":[],
             "providerName":"acme"}
            """;

        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(), Encoding.UTF8.GetBytes(json), out _);

        Assert.False(ok);
    }

    [Fact]
    public void AnEntryThatCarriesItsOwnEntriesIsRejected()
    {
        // Depth is one. A document claiming two levels did not come from this processor.
        var json = """
            {"metadata":{"name":"o.zip","extension":".zip","sizeBytes":9,"createdUtc":null,
             "modifiedUtc":null,"entryCount":1},"content":null,
             "entries":[{"metadata":{"name":"i.zip","extension":".zip","sizeBytes":3,
               "createdUtc":null,"modifiedUtc":null,"entryCount":1},"content":"aWQK",
               "entries":[{"metadata":{"name":"d.csv","extension":".csv","sizeBytes":3,
                 "createdUtc":null,"modifiedUtc":null,"entryCount":0},"content":"aWQK",
                 "entries":[]}]}]}
            """;

        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(), Encoding.UTF8.GetBytes(json), out _);

        Assert.False(ok);
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
  "type": "object",
  "additionalProperties": false,
  "required": ["metadata", "content", "entries"],
  "properties": {
    "metadata": { "$ref": "#/$defs/metadata" },
    "content": { "type": ["string", "null"] },
    "entries": {
      "type": "array",
      "items": { "$ref": "#/$defs/leaf" }
    }
  },
  "$defs": {
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
    },
    "leaf": {
      "type": "object",
      "additionalProperties": false,
      "required": ["metadata", "content", "entries"],
      "properties": {
        "metadata": { "$ref": "#/$defs/metadata" },
        "content": { "type": "string" },
        "entries": { "type": "array", "maxItems": 0 }
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

- The recursive `{metadata, content, entries}` node, `additionalProperties: false` at both levels.
- Depth one: an entry's `entries` is `maxItems: 0`.
- The root's `content` may be a base64 string (a plain file) or null (an archive); an entry's is
  always a string.

## What it cannot assert

**Anything about file content.** `content` is base64, so the bytes are unconstrained by
construction. `format` and `contentEncoding` are ANNOTATIONS in 2020-12, not assertions, and
`ProcessorJsonSchemaValidator.DefaultOptions` does not enable format assertion — adding
`"format": "date-time"` to the timestamps would document them and enforce nothing. Use `pattern` if
that is ever needed.

## Per-feed variants

Entry count is enforced HERE rather than in the step payload, so a feed with a fixed layout gets its
own schema derived from this one. Constrain `entries`, never `metadata.entryCount` — the array is
the fact, the count is derived, and pinning the derived field would let a counting bug satisfy a
rule the content fails.

Exactly three entries:

    "entries": { "type": "array", "minItems": 3, "maxItems": 3,
                 "items": { "$ref": "#/$defs/leaf" } }

One `.wav` and two `.csv`, order-independent — note that `minContains`/`maxContains` must sit beside
their OWN `contains`, so two cardinality rules need two subschemas under `allOf`:

    "entries": {
      "type": "array", "minItems": 3, "maxItems": 3,
      "items": { "$ref": "#/$defs/leaf" },
      "allOf": [
        { "contains": { "$ref": "#/$defs/wav" }, "minContains": 1, "maxContains": 1 },
        { "contains": { "$ref": "#/$defs/csv" }, "minContains": 2, "maxContains": 2 }
      ]
    }

with narrowing definitions that REFINE `leaf` rather than replace it — legal because `$ref` takes
sibling keywords in 2020-12, and note the omitted `additionalProperties`, which only ever sees
`properties` declared in the same schema object:

    "wav": { "$ref": "#/$defs/leaf",
             "properties": { "metadata": { "properties": { "extension": { "const": ".wav" } } } } }

## Registration

**This schema is not registered by the build.** It is a database row against the processor identity,
applied as a deploy step. Until it is, `OutputSchemaId` is null, `TryValidate` returns true without
decoding anything, and **nothing enforces entry count anywhere** — this file is its only home.

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
# not cost its own size in flight: the raw bytes, the base64 string during serialization, the
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

## After the plan

The processor is built, tested and deployable, but **not yet running**. Three operational steps remain, and they are deliberately outside the plan because each needs a decision or a credential the plan cannot carry:

1. **Build and load the image**, then repoint the processor row's `SourceHash` — every processor rebuild needs it.
2. **Register the processor row** (name `file-reader`, version `1.0.0`), and the **output schema row** from `src/Processor.FileReader/schema/output.json`. Until the schema row exists, `OutputSchemaId` is null and nothing enforces entry count.
3. **Wire the workflow** with both edges at `entryCondition: 1` and the step payload from `k8s/README.md`.
