# Processor.FailureRecorder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When any step of `filefetcher-archiveexpander-chain` fails, a record naming the lineage and
the moment reaches the Kafka topic `skp-failures`, so an operator learns of the failure without
watching logs and can resolve it against Elasticsearch later.

**Architecture:** A new processor, `failure-recorder`, is wired into the workflow on
`entryCondition: PreviousFailed` from all seven existing steps and out to a second step on the
existing `kafka-exporter` row. It queries nothing and parses nothing: it reads `CorrelationId` off
the dispatch (via one new read-only accessor on `BaseProcessor`), `executionId` off its own
parameters, stamps the time, and sends one small JSON branch.

**Tech Stack:** .NET 8, xUnit v3 + NSubstitute, `Microsoft.Extensions.TimeProvider.Testing`,
RabbitMQ, Redis, Confluent.Kafka (via the existing exporter), kind + kubectl, BaseApi REST.

**Spec:** `docs/superpowers/specs/2026-09-13-failure-recorder-design.md`

## Global Constraints

- **Target framework, nullable, implicit usings, `TreatWarningsAsErrors`** come from
  `Directory.Build.props`; package versions from `Directory.Packages.props`. **Never declare either
  in a csproj.**
- **The repo's own libraries are consumed as PACKAGES, not project references.**
  `src/tests/BaseApi.Tests` references `BaseProcessor.Core` as `PackageReference … VersionOverride="[1.0.0]"`.
  **Any edit to `src/BaseProcessor.Core` is invisible to every consumer until `scripts/pack-all.sh`
  runs.** A green suite after an unpacked framework edit is meaningless.
- **Run the test suite with the executable, not `dotnet test`.** `dotnet test` reports counts only;
  `src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe` names the failures.
- **Live tests are `Category=Live`** and are excluded from the hermetic run. The hermetic gate is
  *0 failed / exit 0*, never a remembered total.
- **No log template may render upstream content.** Ids, counts, sizes and author-written constants
  only.
- **`CorrelationId` renders `"N"` (32 hex, no dashes) via `CorrelationKeys.Render`.** Every other id
  renders `"D"` (dashed). Elasticsearch holds them that way; a mismatched format matches nothing and
  fails silently.
- **A processor row is matched by `SourceHash`.** Every rebuild changes it and the row must be
  repointed, or the pod never reaches Ready.

---

### Task 1: The `CorrelationId` accessor on `BaseProcessor`

The only framework change in this plan. `ProcessAsync` receives `data`, `config`, `executionId`,
`ct`; the other ids live in a private `DispatchState` field behind a private `Current` property, so
an author cannot read the correlation id at all. Without this, a hop-1 failure — where `executionId`
is `Guid.Empty` — produces a record with no resolvable key.

**Files:**
- Modify: `src/BaseProcessor.Core/Processing/BaseProcessor.cs` (beside the private `Current` property, ~line 30)
- Test: `src/tests/BaseApi.Tests/Processor/BaseProcessorSeamTests.cs`

**Interfaces:**
- Consumes: nothing.
- Produces: `protected Guid BaseProcessor.CorrelationId` — readable inside a dispatch, throws
  `InvalidOperationException` outside one. Task 2 consumes it.

- [ ] **Step 1: Add the accessor to the test's `Probe`**

`Probe` is the private test double at the top of `BaseProcessorSeamTests`. Add one member to it so a
test can observe what an author would see:

```csharp
        public Task Send(byte[] data, Guid executionId) => SendToPostAsync(data, executionId, CancellationToken.None);
        public Guid NextExecution() => NewExecutionId();

        /// <summary>What an author sees when it reads the dispatch's correlation id.</summary>
        public Guid Correlation => CorrelationId;
```

- [ ] **Step 2: Write the failing tests**

Append to `BaseProcessorSeamTests`:

```csharp
    [Fact]
    public async Task TheAuthorSeesTheDispatchesCorrelationId()
    {
        var seen = Guid.Empty;
        var (processor, _) = Build((_, _, _, p) => { seen = p.Correlation; return Task.CompletedTask; });

        await processor.ExecuteAsync([], "", Guid.Empty, CancellationToken.None);

        Assert.Equal(C, seen);
    }

    [Fact]
    public void ReadingTheCorrelationIdOutsideADispatchThrows()
    {
        // Current already enforces this for the send helpers; the accessor inherits it rather than
        // returning a stale id from a pooled thread's previous dispatch.
        var processor = new Probe((_, _, _, _) => Task.CompletedTask);

        Assert.Throws<InvalidOperationException>(() => processor.Correlation);
    }
```

- [ ] **Step 3: Run them and verify they fail**

Run:
```bash
dotnet build SK_P.sln -v q
```
Expected: FAIL to compile — `CS0103: The name 'CorrelationId' does not exist in the current context`
in `BaseProcessorSeamTests.cs`. That is the failing state for this task; a compile error is the
correct first signal when the member does not exist.

- [ ] **Step 4: Implement the accessor**

In `src/BaseProcessor.Core/Processing/BaseProcessor.cs`, immediately after the private `Current`
property:

```csharp
    /// <summary>
    /// The correlation id of the dispatch currently being handled.
    /// <para>
    /// <b>Read-only, and that is the whole of the concession.</b> The ids are otherwise withheld from
    /// authors so that none of them can be STAMPED on outgoing work — <see cref="SendToPostAsync"/>
    /// takes every id from <see cref="DispatchState"/> and none from the author, and that is
    /// unchanged. Reading is not forging.
    /// </para>
    /// <para>
    /// <b>Only the correlation id is exposed.</b> WorkflowId, StepId and ProcessorId stay private:
    /// they are static and can reach an author through its step payload if they are ever wanted,
    /// while exposing them invites routing decisions nothing in this system needs.
    /// </para>
    /// <para>
    /// It exists for <c>Processor.FailureRecorder</c>, which runs on a failed step's behalf and must
    /// name something an operator can query. An entry step's dispatch carries
    /// <see cref="Guid.Empty"/> as its execution id, so the correlation id — minted once per fire by
    /// the orchestrator — is the only key that is present on every dispatch.
    /// </para>
    /// <para>
    /// Throws outside a dispatch, inheriting <see cref="Current"/>'s guard: a pooled thread must not
    /// hand back the previous dispatch's id.
    /// </para>
    /// </summary>
    protected Guid CorrelationId => Current.CorrelationId;
```

- [ ] **Step 5: Repack the library — the tests cannot see the change otherwise**

Run:
```bash
bash scripts/pack-all.sh
```
Expected: `=== BaseProcessor.Core` among the packed projects, then `=== solution restore`, then a
list of `.nupkg` paths. Without this the test project still compiles against the previous package
contents and Step 3's compile error persists, which reads exactly like the edit not working.

- [ ] **Step 6: Build and run the two tests**

Run:
```bash
dotnet build SK_P.sln -v q
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-method "*TheAuthorSeesTheDispatchesCorrelationId*"
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-method "*ReadingTheCorrelationIdOutsideADispatchThrows*"
```
Expected: both PASS.

- [ ] **Step 7: Run the whole hermetic suite**

Run:
```bash
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe
```
Expected: **0 failed, exit 0.** Live-category tests skip. Read the shape, not a remembered total.

- [ ] **Step 8: Commit**

```bash
git add src/BaseProcessor.Core/Processing/BaseProcessor.cs src/tests/BaseApi.Tests/Processor/BaseProcessorSeamTests.cs src/BaseProcessor.Core/nuget
git commit -m "feat(base): let an author read its dispatch's correlation id

An author receives data, config, executionId and ct, so a processor that runs on
a failed step's behalf could name nothing an operator can query -- an entry
step's dispatch carries Guid.Empty as its execution id, and the correlation id is
the only key present on every dispatch.

Read-only: SendToPostAsync still takes every id from DispatchState, so nothing an
author can do changes the ids on its output. WorkflowId, StepId and ProcessorId
stay private."
```

---

### Task 2: The record and the transform

The processor itself: a project, a marker config, the output record, and `ProcessAsync`. No IO, no
services beyond a clock, no parsing of the input it is handed.

**Files:**
- Create: `src/Processor.FailureRecorder/Processor.FailureRecorder.csproj`
- Create: `src/Processor.FailureRecorder/FailureRecorderConfig.cs`
- Create: `src/Processor.FailureRecorder/FailureRecord.cs`
- Create: `src/Processor.FailureRecorder/FailureRecorderProcessor.cs`
- Create: `src/Processor.FailureRecorder/appsettings.json`
- Modify: `SK_P.sln`
- Test: `src/tests/BaseApi.Tests/FailureRecorder/ProcessorFailureRecorderTests.cs`
- Modify: `src/tests/BaseApi.Tests/BaseApi.Tests.csproj` (add the ProjectReference)

**Interfaces:**
- Consumes: `BaseProcessor.CorrelationId` (Task 1); `BaseProcessor<TConfig>.SendToPostAsync(byte[], Guid, CancellationToken)`;
  `BaseProcessor.NewExecutionId()`; `CorrelationKeys.Render(Guid)` from `Messaging.Contracts`.
- Produces:
  - `internal sealed record FailureRecord(string CorrelationId, string? ExecutionId, DateTimeOffset RecordedAtUtc)`
  - `internal static class FailureRecordJson { public static readonly JsonSerializerOptions Options; }`
  - `public sealed record FailureRecorderConfig : ProcessorConfig`
  - `internal sealed class FailureRecorderProcessor(ILogger<FailureRecorderProcessor>, TimeProvider) : BaseProcessor<FailureRecorderConfig>`
  - Task 3 resolves `FailureRecorderProcessor` from DI; Task 7 asserts the JSON field names
    `correlationId`, `executionId`, `recordedAtUtc`.

- [ ] **Step 1: Create the project file**

`src/Processor.FailureRecorder/Processor.FailureRecorder.csproj`:

```xml
<Project Sdk="Microsoft.NET.Sdk">

  <!--
    A concrete processor with the smallest job in the solution: it records THAT a step failed and
    where to look, and nothing else. It queries nothing, parses nothing, and ignores the input it is
    handed.

    Common properties (net8.0, Nullable, ImplicitUsings, TreatWarningsAsErrors) come from
    Directory.Build.props, and package versions from Directory.Packages.props — never declare
    either here.
  -->

  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <RootNamespace>Processor.FailureRecorder</RootNamespace>
    <AssemblyName>Processor.FailureRecorder</AssemblyName>
  </PropertyGroup>

  <ItemGroup>
    <!-- FailureRecord and the processor are internal: this processor's construction, not its
         surface. The tests construct them directly. -->
    <InternalsVisibleTo Include="BaseApi.Tests" />
  </ItemGroup>

  <ItemGroup>
    <!-- The worker SDK does not copy appsettings.json on its own. -->
    <Content Include="appsettings.json" CopyToOutputDirectory="PreserveNewest" />
  </ItemGroup>

  <ItemGroup>
    <!-- The package, not a ProjectReference: SourceHash.targets ships in the package's build/
         folder and NuGet imports it automatically, stamping the hash on THIS assembly. A
         ProjectReference could not flow build targets, and the processor would never match its row. -->
    <PackageReference Include="BaseProcessor.Core" VersionOverride="[1.0.0]" />
  </ItemGroup>

</Project>
```

- [ ] **Step 2: Create `appsettings.json`**

`src/Processor.FailureRecorder/appsettings.json` — identical to every other processor's:

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

- [ ] **Step 3: Add the project to the solution and the test project**

```bash
dotnet sln SK_P.sln add src/Processor.FailureRecorder/Processor.FailureRecorder.csproj
```

Then in `src/tests/BaseApi.Tests/BaseApi.Tests.csproj`, beside the other processor references (after the
`Processor.FilePersister` line):

```xml
    <ProjectReference Include="..\..\Processor.FailureRecorder\Processor.FailureRecorder.csproj" />
```

Then regenerate the lock file, or restore fails rather than updating it:

```bash
dotnet restore src/tests/BaseApi.Tests/BaseApi.Tests.csproj --force-evaluate
```

`Directory.Build.props` sets `RestorePackagesWithLockFile=true` and this project already has a
`packages.lock.json`, so a new reference makes the lock stale and restore reports NU1004 instead of
picking the reference up. It is the same guard `scripts/pack-all.sh` documents for a repacked library.

- [ ] **Step 4: Write the failing tests**

Create `src/tests/BaseApi.Tests/FailureRecorder/ProcessorFailureRecorderTests.cs`:

```csharp
using System.Text.Json;
using BaseApi.Tests.Support;
using BaseProcessor.Core.Processing;
using Messaging.Contracts;
using Messaging.Transport;
using Microsoft.Extensions.Time.Testing;
using NSubstitute;
using Processor.FailureRecorder;
using Xunit;

namespace BaseApi.Tests.FailureRecorder;

public sealed class ProcessorFailureRecorderTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");
    private static readonly Guid E = Guid.Parse("55555555-5555-5555-5555-555555555555");

    private static readonly DateTimeOffset Now =
        new(2026, 9, 13, 8, 54, 57, TimeSpan.Zero);

    /// <summary>Runs the real processor and returns the single branch it sent.</summary>
    private static async Task<ProcessedData> Run(
        byte[] data, Guid executionId, string payload = "")
    {
        var sender = Substitute.For<IQueueSender>();
        var sends = new List<ProcessedData>();
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(sends.Add),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());

        var processor = new FailureRecorderProcessor(
            new RecordingLogger<FailureRecorderProcessor>(),
            new FakeTimeProvider(Now));
        processor.BeginDispatch(new DispatchState(sender, C, W, S, P));

        await processor.ExecuteAsync(data, payload, executionId, CancellationToken.None);

        return Assert.Single(sends);
    }

    private static JsonElement Record(ProcessedData sent) => JsonDocument.Parse(sent.Data).RootElement;

    [Fact]
    public async Task RendersTheCorrelationIdWithoutDashes()
    {
        // "N", matching CorrelationKeys.Render and therefore the value Elasticsearch holds. A dashed
        // guid pasted into a term query matches nothing, silently.
        var record = Record(await Run([], E));

        Assert.Equal(C.ToString("N"), record.GetProperty("correlationId").GetString());
    }

    [Fact]
    public async Task CarriesTheExecutionIdDashedWhenTheFailedStepHadALineage()
    {
        var record = Record(await Run([], E));

        Assert.Equal(E.ToString("D"), record.GetProperty("executionId").GetString());
    }

    [Fact]
    public async Task OmitsTheExecutionIdWhenTheFailedStepHadNoLineage()
    {
        // An importer failure. Omitted rather than zeroed, matching ExecutionLogScope: "does not
        // apply" must stay distinguishable from "is the zero guid".
        var record = Record(await Run([], Guid.Empty));

        Assert.False(record.TryGetProperty("executionId", out _));
    }

    [Fact]
    public async Task OpensALineageWhenItWasHandedNone()
    {
        // Without this the exporter step downstream is dispatched as an entry step and trips
        // BaseExporter's edge guard, so an importer failure would never be exported.
        var sent = await Run([], Guid.Empty);

        Assert.NotEqual(Guid.Empty, sent.ExecutionId);
    }

    [Fact]
    public async Task ContinuesTheLineageItWasHanded()
    {
        var sent = await Run([], E);

        Assert.Equal(E, sent.ExecutionId);
    }

    [Fact]
    public async Task StampsTheTimeFromTheClock()
    {
        var record = Record(await Run([], E));

        Assert.Equal(Now, record.GetProperty("recordedAtUtc").GetDateTimeOffset());
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("{}")]
    [InlineData("""{"topic":"left over from another step"}""")]
    public async Task EveryPayloadIsAccepted(string payload)
    {
        // Nothing reads the payload, so nothing may reject one. This is ArchiveCollapser's rule and
        // it is pinned here for the same reason: a null check added later would fail every step.
        var record = Record(await Run([], E, payload));

        Assert.Equal(C.ToString("N"), record.GetProperty("correlationId").GetString());
    }

    [Fact]
    public async Task IgnoresTheInputItWasHanded()
    {
        // The orchestrator hands over the failed step's input blob. It is neither parsed nor
        // forwarded: a megabyte of arbitrary bytes produces the same three-field record as none.
        var cargo = new byte[1024 * 1024];
        Random.Shared.NextBytes(cargo);

        var record = Record(await Run(cargo, E));

        Assert.Equal(3, record.EnumerateObject().Count());
    }
}
```

- [ ] **Step 5: Run them and verify they fail**

Run:
```bash
dotnet build SK_P.sln -v q
```
Expected: FAIL to compile — `Processor.FailureRecorder` types do not exist yet
(`CS0246: The type or namespace name 'FailureRecorderProcessor' could not be found`).

- [ ] **Step 6: Write the config marker**

`src/Processor.FailureRecorder/FailureRecorderConfig.cs`:

```csharp
using BaseProcessor.Core.Configuration;

namespace Processor.FailureRecorder;

/// <summary>
/// The step payload, and it holds NOTHING. This is a marker, and it exists only because the type
/// system demands one: <c>BaseProcessor.ExecuteAsync</c> is <c>internal abstract</c>, so nothing
/// outside <c>BaseProcessor.Core</c> can derive from the non-generic base, and
/// <c>BaseProcessor{TConfig}</c> is the only door.
/// <para>
/// <b>There is nothing for a workflow author to choose.</b> Everything this processor records — the
/// correlation id, the execution id, the moment — arrives on the dispatch or from the clock. A
/// payload field could only ever restate or contradict one of them.
/// </para>
/// <para>
/// <b>Do not add a null check for this in the processor.</b> <c>ArchiveCollapser</c> is the
/// precedent: null is legal, <c>{}</c> is legal, and a payload left over from another step is legal,
/// because nothing reads it. <c>EveryPayloadIsAccepted</c> is what fails if this is ever "fixed"
/// into symmetry with the processors that do read one.
/// </para>
/// </summary>
public sealed record FailureRecorderConfig : ProcessorConfig;
```

- [ ] **Step 7: Write the output record**

`src/Processor.FailureRecorder/FailureRecord.cs`:

```csharp
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Processor.FailureRecorder;

/// <summary>
/// The output contract: a pointer to a failure, never the failure itself.
/// <para>
/// <b>It carries no reason and no payload, deliberately.</b> <c>StepOutcome</c> has no text field, so
/// the reason exists only in the failing processor's own log line — and this processor is dispatched
/// milliseconds after that line is written, well before it is indexed. Racing the log pipeline was
/// measured and rejected; see the spec. An operator resolves this record against Elasticsearch at
/// their own pace.
/// </para>
/// </summary>
/// <param name="CorrelationId">
/// The fire this failure belongs to, rendered <b>"N"</b> — 32 hex characters, no dashes. That is the
/// form <c>CorrelationKeys.Render</c> puts on every log record, so this value pastes straight into a
/// term query. A dashed guid here matches nothing and reports no error.
/// </param>
/// <param name="ExecutionId">
/// The FAILED step's lineage, rendered "D", or <b>null when it had none</b> — an importer failure is
/// an entry dispatch and no lineage was ever opened. Null is omitted from the JSON rather than
/// written as a zero guid, matching <c>ExecutionLogScope.BuildScope</c>: "does not apply" must stay
/// distinguishable from "is the zero guid", and a consumer must be written for an absent field.
/// <b>It is not the id of the branch this processor sends</b>, which may be freshly minted precisely
/// because this one is absent.
/// </param>
/// <param name="RecordedAtUtc">
/// When this record was written — milliseconds after the failure, on a different pod. Enough to
/// bound a query window and to tell two failures in one lineage apart; not a clock to order events
/// by.
/// </param>
internal sealed record FailureRecord(string CorrelationId, string? ExecutionId, DateTimeOffset RecordedAtUtc);

/// <summary>The one serializer configuration for the failure record.</summary>
internal static class FailureRecordJson
{
    /// <summary>
    /// <b>camelCase, pinned explicitly</b>, for the reason <c>FileLocatorJson</c> gives: the
    /// messaging envelope's own options leave the naming policy null — PascalCase — and inheriting
    /// that here would emit <c>CorrelationId</c>, which is not what a consumer of this topic is told
    /// to expect.
    /// <para>
    /// <b><c>WhenWritingNull</c>, unlike every other record in this solution.</b> An absent
    /// execution id must be ABSENT rather than null, so that a consumer distinguishes "this failure
    /// had no lineage" from "this field was not populated".
    /// </para>
    /// </summary>
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };
}
```

- [ ] **Step 8: Write the processor**

`src/Processor.FailureRecorder/FailureRecorderProcessor.cs`:

```csharp
using System.Text.Json;
using BaseProcessor.Core.Processing;
using Messaging.Contracts;
using Microsoft.Extensions.Logging;

namespace Processor.FailureRecorder;

/// <summary>
/// Records that a step failed, and where to look. Wired on <c>entryCondition: PreviousFailed</c>
/// from every step of a workflow, and out to an exporter, so a failure leaves a durable record on a
/// broker rather than only a log line nobody is watching.
/// <para>
/// <b>It reads nothing and queries nothing.</b> The orchestrator hands it the failed step's input
/// blob, because a hop relocates its payload; this processor ignores those bytes entirely. It does
/// not query Elasticsearch either — it runs milliseconds after the failure, and the line carrying
/// the reason is the last one the failing pod writes and the furthest from being indexed.
/// </para>
/// </summary>
internal sealed class FailureRecorderProcessor(
    ILogger<FailureRecorderProcessor> logger,
    TimeProvider clock)
    : BaseProcessor<FailureRecorderConfig>
{
    protected override async Task ProcessAsync(
        byte[] data, FailureRecorderConfig? config, Guid executionId, CancellationToken ct)
    {
        // `data` and `config` are both deliberately unread. See FailureRecorderConfig for why a null
        // payload must not be rejected, and the type remarks above for the cargo.

        var record = new FailureRecord(
            // "N". The one formatting decision in this assembly that can silently break the feature.
            CorrelationKeys.Render(CorrelationId),
            executionId == Guid.Empty ? null : executionId.ToString("D"),
            clock.GetUtcNow());

        // THE LINEAGE THIS BRANCH TRAVELS ON, which is NOT always the one the record reports.
        //
        // A transform continues the lineage it was handed and never mints one. This is the single
        // exception, and only for a failed ENTRY step: an importer failure carries Guid.Empty, and
        // passing that on would dispatch the exporter downstream as an entry step, where
        // BaseExporter's first guard throws -- "it ends a lineage and cannot open one". The record
        // would never be exported, for exactly the failure class that most needs one.
        //
        // The minted id is plumbing. The record's own ExecutionId stays null above, because that
        // field describes the step that FAILED, and a step that failed before opening a lineage has
        // none. Conflating the two would have the record name a lineage the failure never had.
        var lineage = executionId == Guid.Empty ? NewExecutionId() : executionId;

        // Ids only, never the cargo. RecordedExecutionId rather than ExecutionId: the dispatch scope
        // already carries an ExecutionId attribute, and reusing the name would collide with it on
        // the record -- and for an entry-step failure the scope omits it while this line still has
        // something to say.
        logger.LogInformation(
            "recorded a failed step: correlation {RecordedCorrelationId}, execution {RecordedExecutionId}",
            record.CorrelationId, record.ExecutionId ?? "(none — the step that failed was an entry step)");

        await SendToPostAsync(
            JsonSerializer.SerializeToUtf8Bytes(record, FailureRecordJson.Options),
            lineage,
            ct).ConfigureAwait(false);
    }
}
```

- [ ] **Step 9: Build and run the tests**

Run:
```bash
dotnet build SK_P.sln -v q
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "*ProcessorFailureRecorderTests*"
```
Expected: all nine PASS (six facts, one theory with four cases, counted as the runner reports them).

- [ ] **Step 10: Run the whole hermetic suite**

Run:
```bash
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe
```
Expected: **0 failed, exit 0.**

- [ ] **Step 11: Commit**

```bash
git add src/Processor.FailureRecorder SK_P.sln src/tests/BaseApi.Tests/BaseApi.Tests.csproj src/tests/BaseApi.Tests/FailureRecorder
git commit -m "feat(failurerecorder): record that a step failed and where to look

A failed step is reported only in logs today and nobody is told. This transform
runs on a PreviousFailed edge and emits a three-field pointer -- the fire, the
lineage, the moment -- for an exporter to put on a broker.

It reads neither the cargo the orchestrator hands it nor its own payload, and it
does not query Elasticsearch: it runs milliseconds after the failure, and the
line carrying the reason is the last one the failing pod writes.

It opens a lineage when handed none, or the exporter downstream would be
dispatched as an entry step and refuse the export."
```

---

### Task 3: The shell — host, entry point, image

Everything needed to run the processor as a pod. Split from Task 2 because a reviewer can reject a
composition root without rejecting the transform.

**Files:**
- Create: `src/Processor.FailureRecorder/Program.cs`
- Create: `src/Processor.FailureRecorder/ProcessorHost.cs`
- Create: `src/Processor.FailureRecorder/Dockerfile`
- Test: `src/tests/BaseApi.Tests/DependencyInjection/FailureRecorderHostTests.cs`

**Interfaces:**
- Consumes: `FailureRecorderProcessor` (Task 2); `ProcessorHost.Create(string[], ProcessorIdentityFound, Action<IConfigurationBuilder>?)`
  is the shape every other processor exposes.
- Produces: `Processor.FailureRecorder.ProcessorHost.StartAsync/Create`; a container image tagged
  `processor-failurerecorder:local` (Task 5 loads it).

- [ ] **Step 1: Write the failing host test**

Create `src/tests/BaseApi.Tests/DependencyInjection/FailureRecorderHostTests.cs`:

```csharp
using Messaging.Contracts;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Processor.FailureRecorder;
using Xunit;

namespace BaseApi.Tests.DependencyInjection;

/// <summary>
/// The one thing worth asserting about a shell: that its service graph actually resolves. Asserted
/// without starting a process, which is why ProcessorHost.Create is separate from StartAsync.
/// </summary>
public sealed class FailureRecorderHostTests
{
    private static readonly ProcessorIdentityFound Identity = new(
        Guid.Parse("66666666-6666-6666-6666-666666666666"),
        InputSchemaId: null, OutputSchemaId: null, ConfigSchemaId: null,
        Name: "failure-recorder", Version: "1.0.0");

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

        Assert.IsType<FailureRecorderProcessor>(processor);
    }

    [Fact]
    public void TheClockComesFromTheFrameworkRatherThanThisShell()
    {
        // AddBaseProcessor already does TryAddSingleton(TimeProvider.System), so this shell registers
        // no clock of its own. Asserted so that a later edit adding one is a deliberate act.
        using var host = Build();

        Assert.NotNull(host.Services.GetRequiredService<TimeProvider>());
    }
}
```

- [ ] **Step 2: Run it and verify it fails**

Run:
```bash
dotnet build SK_P.sln -v q
```
Expected: FAIL to compile — `CS0234: The type or namespace name 'ProcessorHost' does not exist in
the namespace 'Processor.FailureRecorder'`.

- [ ] **Step 3: Write the composition root**

`src/Processor.FailureRecorder/ProcessorHost.cs`:

```csharp
using BaseConsole.Core.DependencyInjection;
using BaseProcessor.Core.Boot;
using BaseProcessor.Core.DependencyInjection;
using BaseProcessor.Core.Observability;
using Messaging.Contracts;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using OpenTelemetry.Metrics;

namespace Processor.FailureRecorder;

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

        // Everything else: broker, Redis, health probes, the schema loop and the liveness loop. It
        // also registers TimeProvider.System, which is the only dependency this processor has beyond
        // its logger — so there is deliberately no clock registration here.
        builder.Services.AddBaseProcessor(builder.Configuration, identity);

        // The concrete processor the pre/post handlers resolve as BaseProcessor. Singleton, matching
        // the seam's design: per-dispatch state lives in a plain field on this one instance, which is
        // safe only because prefetch is 1.
        builder.Services.AddSingleton<BaseProcessor.Core.Processing.BaseProcessor, FailureRecorderProcessor>();

        return builder.Build();
    }
}
```

- [ ] **Step 4: Write the entry point**

`src/Processor.FailureRecorder/Program.cs`:

```csharp
using System.Runtime.InteropServices;
using Microsoft.Extensions.Hosting;
using Processor.FailureRecorder;

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

- [ ] **Step 5: Write the Dockerfile**

`src/Processor.FailureRecorder/Dockerfile`:

```dockerfile
# Build context is the REPO ROOT, not this directory:
#   docker build -f src/Processor.FailureRecorder/Dockerfile -t processor-failurerecorder:local .
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
# ALL FIVE feeds are copied, not just the ones this image consumes: NuGet validates every source in
# NuGet.config at restore and fails one that is missing (NU1301), whether or not the project resolves
# anything from it. They are a few hundred KB in total.
COPY src/Messaging.Contracts/nuget/ src/Messaging.Contracts/nuget/
COPY src/Messaging.Transport/nuget/ src/Messaging.Transport/nuget/
COPY src/BaseConsole.Core/nuget/ src/BaseConsole.Core/nuget/
COPY src/BaseApi.Core/nuget/ src/BaseApi.Core/nuget/
COPY src/BaseProcessor.Core/nuget/ src/BaseProcessor.Core/nuget/
COPY ["src/Processor.FailureRecorder/Processor.FailureRecorder.csproj", "src/Processor.FailureRecorder/"]
RUN dotnet restore "src/Processor.FailureRecorder/Processor.FailureRecorder.csproj"

COPY src/Processor.FailureRecorder/ src/Processor.FailureRecorder/
RUN dotnet publish "src/Processor.FailureRecorder/Processor.FailureRecorder.csproj" \
      -c Release -o /publish --no-restore /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:8.0-bookworm-slim AS runtime
WORKDIR /app
COPY --from=build /publish .
USER app
# The health listener binds this itself from ConsoleHealth:Port; EXPOSE is documentation for a reader.
EXPOSE 8081
ENTRYPOINT ["dotnet", "Processor.FailureRecorder.dll"]
```

- [ ] **Step 6: Build and run the host tests**

Run:
```bash
dotnet build SK_P.sln -v q
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "*FailureRecorderHostTests*"
```
Expected: both PASS.

- [ ] **Step 7: Build the image**

Run from the repo root:
```bash
docker build -f src/Processor.FailureRecorder/Dockerfile -t processor-failurerecorder:local .
```
Expected: a successful build ending in `naming to docker.io/library/processor-failurerecorder:local`.

- [ ] **Step 8: Run the whole hermetic suite**

Run:
```bash
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe
```
Expected: **0 failed, exit 0.**

- [ ] **Step 9: Commit**

```bash
git add src/Processor.FailureRecorder/Program.cs src/Processor.FailureRecorder/ProcessorHost.cs src/Processor.FailureRecorder/Dockerfile src/tests/BaseApi.Tests/DependencyInjection/FailureRecorderHostTests.cs
git commit -m "feat(failurerecorder): the shell -- host, entry point and image

Composition root as methods rather than inline in Program, so the one thing worth
asserting about a shell can be asserted without starting a process. It registers
no clock: AddBaseProcessor already supplies TimeProvider.System, and a test pins
that so adding one later is deliberate."
```

---

### Task 4: The Kubernetes manifest

**Files:**
- Create: `k8s/42-processor-failurerecorder.yaml`
- Modify: `k8s/kustomization.yaml`

**Interfaces:**
- Consumes: the image `processor-failurerecorder:local` (Task 3).
- Produces: Deployment `processor-failurerecorder` in namespace `skp`. Task 5 loads the image and
  waits on this deployment.

- [ ] **Step 1: Write the manifest**

Create `k8s/42-processor-failurerecorder.yaml`:

```yaml
# processor-failurerecorder — records THAT a step failed and where to look. Wired on
# entryCondition: PreviousFailed from every step of filefetcher-archiveexpander-chain, and out to a
# second kafka-exporter step on skp-failures. A downstream transform: it has an input and it
# produces output, so it is neither an importer nor an exporter.
# No Service — its only inbound traffic is the kubelet hitting the pod IP for probes.
#
# EXPECT IT TO SIT NOT-READY UNTIL A PROCESSOR ROW EXISTS, exactly as the other processors do.
# `kubectl rollout status` will time out; that timeout is the expected signal, not a fault.
#
# THE MEMORY LIMIT IS 768Mi AND IT IS NOT ABOUT WHAT THIS PROCESSOR DOES. It builds a record of a
# few hundred bytes and could run in a fraction of that. What sizes it is what it is HANDED: a hop
# relocates its payload, so the orchestrator copies the failed step's input into a fresh key and
# this pod's pre handler reads the whole thing into memory before the transform is entered — and
# then the transform ignores it. A failed archive-expander or sk-normalizer step means up to ~45 MB
# of document arriving here. Sizing this lower would turn a failed step into an OOM, which is a
# POISON MESSAGE and not a failed step: the author never returns, the input key is never reclaimed,
# RabbitMQ requeues the unacked dispatch, and the replacement pod dies the same way. The processor
# that exists to report failures must not be the one that cannot survive them.
#
# THERE ARE NO ENV VARS BEYOND THE SHARED FIVE, deliberately. This processor has no ceiling, no
# path, no endpoint and no payload of its own — everything it records arrives on the dispatch or
# from the clock.
apiVersion: apps/v1
kind: Deployment
metadata:
  name: processor-failurerecorder
  namespace: skp
  labels:
    app: processor-failurerecorder
    app.kubernetes.io/part-of: skp
spec:
  replicas: 1
  strategy:
    type: RollingUpdate
    rollingUpdate:
      # maxSurge 0, matching archivecollapser and for the same reason: this pod's limit is 768Mi,
      # double the smaller processors', so a surge briefly running two of them would want ~1.5Gi at
      # once on a single-node kind cluster already running Postgres, Redis, RabbitMQ, Prometheus,
      # Grafana, an OTel collector, BaseApi, the orchestrator and six other processors.
      maxSurge: 0
      maxUnavailable: 1
  selector:
    matchLabels:
      app: processor-failurerecorder
  template:
    metadata:
      labels:
        app: processor-failurerecorder
    spec:
      containers:
        - name: processor-failurerecorder
          image: processor-failurerecorder:local
          imagePullPolicy: IfNotPresent
          env:
            # NO Service__Name / Service__Version here, deliberately, and do not add them back.
            # A processor takes its service.name and service.version from its database row, resolved
            # before the host is built so they can reach the OTel resource, and that row wins over
            # configuration unconditionally.
            #
            # The replica identity that names this pod's liveness key, its reply queue, and the
            # service.instance.id on its telemetry. All three must be the same string, which is why
            # it is resolved once from the downward API rather than three times from three defaults.
            - name: POD_NAME
              valueFrom:
                fieldRef: { fieldPath: metadata.name }
            # The collector already running in this namespace. Without it the SDK still works and
            # export simply fails quietly, so this is an enrichment rather than a dependency.
            - name: OTEL_EXPORTER_OTLP_ENDPOINT
              value: "http://otel-collector:4317"
            # 10s, against a 15s Prometheus scrape. Exporting faster than the scrape makes the
            # effective resolution the scrape interval; exporting at exactly the scrape interval
            # aliases and leaves some scrapes with nothing new.
            - name: OTEL_METRIC_EXPORT_INTERVAL
              value: "10000"
            - name: RabbitMq__Host
              value: rabbitmq
            - name: RabbitMq__Username
              valueFrom:
                secretKeyRef: { name: skp-dev-secrets, key: RABBITMQ_DEFAULT_USER }
            - name: RabbitMq__Password
              valueFrom:
                secretKeyRef: { name: skp-dev-secrets, key: RABBITMQ_DEFAULT_PASS }
            - name: ConnectionStrings__Redis
              value: "redis:6379,abortConnect=false,connectTimeout=5000"
            - name: ConsoleHealth__Port
              value: "8081"
          ports:
            - containerPort: 8081
          # Startup flips on the liveness loop's first beat, within moments of the host starting, so
          # this passes long before discovery does. It is deliberately not gated on identity: a
          # processor waiting on an unregistered row is starting correctly, however long that takes.
          startupProbe:
            httpGet: { path: /health/startup, port: 8081 }
            initialDelaySeconds: 5
            periodSeconds: 5
            timeoutSeconds: 3
            failureThreshold: 30
          # Readiness is identity resolution. It stays red until the processor row exists, and no
          # restart will help — which is exactly why this is readiness and not liveness.
          readinessProbe:
            httpGet: { path: /health/ready, port: 8081 }
            initialDelaySeconds: 10
            periodSeconds: 10
            timeoutSeconds: 3
            failureThreshold: 5
          # Liveness is the loops still turning, and nothing else. A broker that is down must not
          # restart this pod: the startup loop is designed to retry against it forever, and a restart
          # only throws away the backoff progress.
          livenessProbe:
            httpGet: { path: /health/live, port: 8081 }
            initialDelaySeconds: 30
            periodSeconds: 15
            failureThreshold: 6
          resources:
            requests: { memory: "256Mi" }
            limits:   { memory: "768Mi" }
```

- [ ] **Step 2: Add it to the kustomization**

In `k8s/kustomization.yaml`, after the `41-processor-sknormalizer.yaml` line:

```yaml
  - 42-processor-failurerecorder.yaml
```

- [ ] **Step 3: Verify the manifest parses and renders**

Run:
```bash
kubectl kustomize k8s | grep -A2 "name: processor-failurerecorder"
```
Expected: the Deployment appears in the rendered output. A YAML error fails here rather than on
apply.

- [ ] **Step 4: Commit**

```bash
git add k8s/42-processor-failurerecorder.yaml k8s/kustomization.yaml
git commit -m "feat(k8s): deploy processor-failurerecorder

768Mi, and the limit is about what this pod is HANDED rather than what it does: a
hop relocates its payload, so a failed expander or normalizer step arrives here as
up to ~45MB the transform then ignores. Sizing it lower turns a failed step into a
poison message -- the processor that reports failures must survive them."
```

---

### Task 5: Deploy and register the processor row

Operational, against the live `skp` namespace on the kind cluster `desktop`. Nothing here is
hermetic; each step has an explicit observable outcome.

**Files:** none. This task changes the cluster and the database.

**Interfaces:**
- Consumes: the image from Task 3, the manifest from Task 4.
- Produces: a `failure-recorder` processor row whose id Task 6 wires steps to. Capture it as
  `$RECORDER_ID`.

- [ ] **Step 1: Read this build's source hash**

Run:
```bash
dotnet build src/Processor.FailureRecorder/Processor.FailureRecorder.csproj -v n | grep "SourceHash"
```
Expected: one line, `SourceHash (Processor.FailureRecorder): <64 hex chars>`. Keep it as
`$RECORDER_HASH`. **Every rebuild changes this and the row must be repointed** — a mismatched hash
is the commonest reason a processor pod never reaches Ready.

- [ ] **Step 2: Make sure the failures topic exists**

Nothing in this repo creates Kafka topics. The broker is the dev container from
`tools/kafka-dev-broker.ps1`, reachable on `localhost:19092` from the host and as `skp-kafka:9092`
from the pods.

```bash
MSYS_NO_PATHCONV=1 docker exec skp-kafka /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server localhost:9092 --list | grep -x skp-failures \
  || MSYS_NO_PATHCONV=1 docker exec skp-kafka /opt/kafka/bin/kafka-topics.sh \
       --bootstrap-server localhost:9092 --create --topic skp-failures \
       --partitions 1 --replication-factor 1
```

**`MSYS_NO_PATHCONV=1` is required and is not decoration.** Git Bash rewrites the leading-slash
argument before docker sees it. `tools/kafka-dev-broker.ps1` is written in pwsh for exactly this
reason and says so beside its own `docker exec`: the equivalent one-liner in a bash session needs the
prefix. The image is `apache/kafka:3.9.1`, where `/opt/kafka/bin/kafka-topics.sh` is the right path.

Expected: `skp-failures` listed, either because it already existed or because it was just created.
**A missing topic does not fail at subscribe time** — it surfaces on the first read or write, which
would otherwise present as "the recorder never exported anything" much later.

- [ ] **Step 3: Load the image into kind**

Run:
```bash
kind load docker-image processor-failurerecorder:local --name desktop
```

Expected: `Image: "processor-failurerecorder:local" with ID ... not yet present on node "desktop-control-plane", loading...`

Note: the kubectl context may say `docker-desktop`; the cluster is `kind`. Loading into the wrong
one leaves `ErrImageNeverPull` on the pod.

- [ ] **Step 4: Apply the manifest**

Run:
```bash
kubectl apply -f k8s/42-processor-failurerecorder.yaml
kubectl -n skp get pods -l app=processor-failurerecorder
```
Expected: one pod, `Running` but `0/1 READY`, with **0 restarts**. That is correct and expected: no
processor row exists yet, so identity never resolves and readiness stays red. A pod that restarts
here is a different problem — read its logs.

- [ ] **Step 5: Register the processor row**

The API is reachable on the supervised forward at `localhost:18080`. Run:

```bash
curl -s -X POST http://localhost:18080/api/v1/processors \
  -H 'Content-Type: application/json' \
  -d "{
        \"name\": \"failure-recorder\",
        \"version\": \"1.0.0\",
        \"description\": \"records that a step failed and where to look; carries no reason and no payload\",
        \"sourceHash\": \"$RECORDER_HASH\",
        \"inputSchemaId\": null,
        \"outputSchemaId\": null,
        \"configSchemaId\": null
      }" | tee /tmp/recorder-row.json
```

Expected: 201 with the created row. **All three schema ids are null and that is load-bearing, not
laziness:** the seven parents carry three different output schema ids, one row has one
`inputSchemaId`, and `SchemaEdgeValidator` compares row ids for equality — so no non-null value could
satisfy every incoming edge. Null on either side of an edge passes.

Capture the id:
```bash
RECORDER_ID=$(jq -r '.id' /tmp/recorder-row.json); echo "$RECORDER_ID"
```

- [ ] **Step 6: Watch the pod go ready**

Run:
```bash
kubectl -n skp get pods -l app=processor-failurerecorder -w
```
Expected: `1/1 READY` within one backoff interval (the startup loop's interval is 30s). If it stays
red, the hash in the row does not match the image — recheck Step 1 against the image that was
actually loaded, not against a later local build.

- [ ] **Step 7: Commit nothing, record the id**

There is nothing to commit; this task's output is cluster state. Write `$RECORDER_ID` down — Task 6
needs it.

---

### Task 6: Wire the workflow

Nine steps where there were seven. This task also makes the one shared-row change in the design.

**Files:** none. This task changes the database.

**Interfaces:**
- Consumes: `$RECORDER_ID` (Task 5).
- Produces: steps 8 and 9 on workflow `1a56b3ca-e276-4815-87fa-5c2f48ab6dad`, and
  `kafka-exporter.inputSchemaId = null`. Task 7 asserts against the running result.

- [ ] **Step 1: Stop the workflow before editing it**

Run:
```bash
curl -s -X POST http://localhost:18080/api/v1/orchestration/stop \
  -H 'Content-Type: application/json' \
  -d '{"workflowId":"1a56b3ca-e276-4815-87fa-5c2f48ab6dad"}'
```
Expected: 200. A running workflow holds a projection; editing its graph underneath it is the
situation the base notices and warns about, and it is avoidable by stopping first.

- [ ] **Step 2: Null the exporter's input schema**

`PUT /api/v1/processors/{id}` **replaces** the row — a partial body wipes `name`, `version`,
`description` and `sourceHash` — so read the row back and echo every field, overriding one:

```bash
EXPORTER_ID=157a0f40-d668-42f3-a500-4762c587f64a

ROW=$(curl -s "http://localhost:18080/api/v1/processors/$EXPORTER_ID")
echo "$ROW" | jq '{name, version, sourceHash, inputSchemaId, outputSchemaId}'   # before

curl -s -X PUT "http://localhost:18080/api/v1/processors/$EXPORTER_ID" \
  -H 'Content-Type: application/json' \
  -d "$(echo "$ROW" | jq '{name, version, description, sourceHash,
inputSchemaId: null, outputSchemaId, configSchemaId}')"
```

Expected: 200, and a re-read shows `inputSchemaId: null` with `name`, `version`, `description` and
`sourceHash` unchanged.

**What this costs, so it is not discovered later:** that row is shared with chain step 7
(`skp-documents`) and with the `kafka-import-export` workflow. Both lose *input* validation. It is
survivable because this system validates on the producing side — a processor validates its own
output, so bad data never reaches the next queue — and consumer-side input validation has never
fired in a live suite. It is still a control removed from two places this feature does not otherwise
touch, and it is the reason a shared row is being edited at all.

- [ ] **Step 3: Create the exporter step (step 9) first**

Step 8 must name step 9 in `nextStepIds`, so 9 is created first.

```bash
STEP9=$(curl -s -X POST http://localhost:18080/api/v1/steps \
  -H 'Content-Type: application/json' \
  -d "{
        \"name\": \"export-failure\",
        \"version\": \"1.0.0\",
        \"description\": \"puts the failure record on skp-failures and ends the lineage\",
        \"processorId\": \"157a0f40-d668-42f3-a500-4762c587f64a\",
        \"nextStepIds\": [],
        \"entryCondition\": 1
      }" | jq -r '.id'); echo "$STEP9"
```

Expected: a new step id. **`entryCondition` is 1 (PreviousCompleted), not 2.** Its predecessor is the
recorder, and the recorder *completing* is the normal case; wiring it to 2 would export only when the
recorder itself broke.

- [ ] **Step 4: Create the recorder step (step 8)**

```bash
STEP8=$(curl -s -X POST http://localhost:18080/api/v1/steps \
  -H 'Content-Type: application/json' \
  -d "{
        \"name\": \"record-failure\",
        \"version\": \"1.0.0\",
        \"description\": \"records that a step failed and where to look\",
        \"processorId\": \"$RECORDER_ID\",
        \"nextStepIds\": [\"$STEP9\"],
        \"entryCondition\": 2
      }" | jq -r '.id'); echo "$STEP8"
```

Expected: a new step id. `entryCondition` 2 is `PreviousFailed`.

- [ ] **Step 5: Create the two assignments**

```bash
ASG8=$(curl -s -X POST http://localhost:18080/api/v1/assignments \
  -H 'Content-Type: application/json' \
  -d "{
        \"name\": \"record-failure\",
        \"version\": \"1.0.0\",
        \"description\": \"no payload: nothing this processor records is a workflow author's choice\",
        \"stepId\": \"$STEP8\",
        \"payload\": \"{}\"
      }" | jq -r '.id')

ASG9=$(curl -s -X POST http://localhost:18080/api/v1/assignments \
  -H 'Content-Type: application/json' \
  -d "{
        \"name\": \"export-failure\",
        \"version\": \"1.0.0\",
        \"description\": \"the failures topic\",
        \"stepId\": \"$STEP9\",
        \"payload\": \"{\\\"topic\\\": \\\"skp-failures\\\", \\\"deliveryTimeoutSeconds\\\": 30}\"
      }" | jq -r '.id')

echo "$ASG8 $ASG9"
```

Expected: two ids. **`deliveryTimeoutSeconds` is 30, matching chain step 7 deliberately:**
`KafkaExporterProcessor.CacheKey` is the delivery timeout and nothing else, so two steps sharing a
timeout share one cached producer; a different value here silently builds and holds a second.

- [ ] **Step 6: Add step 8 to every existing step's successors**

Each of the seven existing steps keeps the successor it has and gains step 8. `PUT /api/v1/steps/{id}`
replaces the row, so read each back and echo it with `nextStepIds` extended:

These are the seven step ids as read from the live API on 2026-09-13, in workflow order:

| step | id | `nextStepIds` before |
|---|---|---|
| kafka-importer | `ab9d8741-c109-4457-a090-d76e1ca64a97` | `[b9c13653…]` |
| file-fetcher | `b9c13653-6558-4445-9d20-ab0a6d3fd48f` | `[06423c6d…]` |
| archive-expander | `06423c6d-553f-4188-b5a8-f6b2ce5722b1` | `[56fca87f…]` |
| sk-normalizer | `56fca87f-cdc0-4370-b790-2eeb754ed4fd` | `[c5845265…]` |
| archive-collapser | `c5845265-3bd7-49df-92ca-9e3a1c905752` | `[798b9dc8…]` |
| file-persister | `798b9dc8-9faa-491b-8011-9b7f80d4f9ee` | `[9cae7b00…]` |
| kafka-exporter | `9cae7b00-5392-4c8f-867f-e3cbb907de58` | `[]` |

**Re-read them rather than trusting the table** if anything has touched this workflow since:

```bash
curl -s http://localhost:18080/api/v1/workflows/1a56b3ca-e276-4815-87fa-5c2f48ab6dad \
  | jq -r '.assignmentIds[]' \
  | while read -r A; do curl -s "http://localhost:18080/api/v1/assignments/$A" | jq -r '.stepId'; done
```

Then extend each one's successors. `PUT /api/v1/steps/{id}` replaces the row, so every field is
echoed back and only `nextStepIds` changes:

```bash
for STEP in ab9d8741-c109-4457-a090-d76e1ca64a97 \
            b9c13653-6558-4445-9d20-ab0a6d3fd48f \
            06423c6d-553f-4188-b5a8-f6b2ce5722b1 \
            56fca87f-cdc0-4370-b790-2eeb754ed4fd \
            c5845265-3bd7-49df-92ca-9e3a1c905752 \
            798b9dc8-9faa-491b-8011-9b7f80d4f9ee \
            9cae7b00-5392-4c8f-867f-e3cbb907de58; do
  ROW=$(curl -s "http://localhost:18080/api/v1/steps/$STEP")
  curl -s -X PUT "http://localhost:18080/api/v1/steps/$STEP" \
    -H 'Content-Type: application/json' \
    -d "$(echo "$ROW" | jq --arg s8 "$STEP8" \
          '{name, version, description, processorId,
nextStepIds: ((.nextStepIds // []) + [$s8]), entryCondition}')" > /dev/null
  curl -s "http://localhost:18080/api/v1/steps/$STEP" | jq -c '{name, nextStepIds}'
done
```

Expected: each of the first six shows two entries in `nextStepIds` — its original successor and
`$STEP8` — and `9cae7b00…`, the exporter, shows one where it had none.

**`entryCondition` is echoed unchanged and must be.** These are the chain's own steps; their entry
conditions are not what this change touches. Only step 8's is `PreviousFailed`.

- [ ] **Step 7: Add both assignments to the workflow**

`PUT /api/v1/workflows/{id}` replaces the row; echo every field with the two ids appended:

```bash
WF=$(curl -s http://localhost:18080/api/v1/workflows/1a56b3ca-e276-4815-87fa-5c2f48ab6dad)

curl -s -X PUT http://localhost:18080/api/v1/workflows/1a56b3ca-e276-4815-87fa-5c2f48ab6dad \
  -H 'Content-Type: application/json' \
  -d "$(echo "$WF" | jq --arg a8 "$ASG8" --arg a9 "$ASG9" \
        '{name, version, description, entryStepIds,
assignmentIds: (.assignmentIds + [$a8, $a9]), cronExpression}')" | jq '.assignmentIds | length'
```

Expected: `9`.

- [ ] **Step 8: Publish the workflow**

```bash
curl -s -i -X POST http://localhost:18080/api/v1/orchestration/start \
  -H 'Content-Type: application/json' \
  -d '{"workflowId":"1a56b3ca-e276-4815-87fa-5c2f48ab6dad"}' | head -1
```

Expected: **200**. A 422 naming a schema edge means an edge whose parent output and child input are
both non-null and unequal — recheck Step 2 landed and that the recorder row's schema ids are null. A
422 naming a cycle means step 8 or 9 points back into the chain.

- [ ] **Step 9: Prove the other workflow still runs**

The regression that Step 2 could have caused:

```bash
curl -s -X POST http://localhost:18080/api/v1/orchestration/start \
  -H 'Content-Type: application/json' \
  -d '{"workflowId":"a5498df6-1522-4098-ad65-f4aff4998988"}' | head -1
```

Expected: 200, and a subsequent run of `kafka-import-export` completes as before. The nulled input
schema removed a check, not a capability.

- [ ] **Step 10: Record the ids**

Nothing to commit. Keep `$STEP8`, `$STEP9`, `$ASG8`, `$ASG9` — Task 7 references them when reading
the lineage.

---

### Task 7: The live test

Proves the whole path in the two shapes that differ: a mid-chain failure that carries a lineage, and
an entry-step failure that has none.

**Files:**
- Create: `src/tests/BaseApi.Tests/Live/FailureRecorder/FailureRecorderLiveTests.cs`

**Interfaces:**
- Consumes: the deployed processor (Task 5), the wired workflow (Task 6), and the JSON field names
  from Task 2 — `correlationId`, `executionId`, `recordedAtUtc`.
- Produces: nothing downstream.

**Conventions this file must follow**, taken from `ArchiveCollapserLiveTests`:
`[Trait("Category", RealStack.Category)]` — the category is **`RealStack`**, not `Live`, and it gates
on `SKP_REALSTACK=1` through `RealStack.SkipUnlessEnabled()`. Anything touching the shared dev Kafka
container joins `[Collection("kafka-broker")]`, because `xunit.runner.json` runs six threads and a
sibling suite stops and starts that container. Addresses come from `RealStack` (`KafkaBrokers`
defaults to `localhost:19092`, `BaseApiUrl` to `http://localhost:18080`); Elasticsearch is
`RealStack.Get("SKP_ES_URL", "http://localhost:19200")` and the data stream is
`logs-generic.otel-default`.

- [ ] **Step 1: Write the failing live test**

Create `src/tests/BaseApi.Tests/Live/FailureRecorder/FailureRecorderLiveTests.cs`:

```csharp
using System.Net.Http;
using System.Text;
using System.Text.Json;
using Confluent.Kafka;
using Xunit;

namespace BaseApi.Tests.Live.FailureRecorder;

/// <summary>
/// The half of FailureRecorder only the cluster can answer: a step really fails, the PreviousFailed
/// edge really fires, and a record really lands on skp-failures — with an id that really resolves a
/// lineage in a real log store. The hermetic suite runs the transform in process and can say nothing
/// about any of that.
/// <para>
/// Needs <c>SKP_REALSTACK=1</c>, <c>k8s/port-forward-realstack.ps1</c> and
/// <c>tools/kafka-dev-broker.ps1 -Up</c>, plus the wiring from Task 6.
/// </para>
/// </summary>
[Trait("Category", RealStack.Category)]
[Collection("kafka-broker")]
public sealed class FailureRecorderLiveTests
{
    private const string FailuresTopic = "skp-failures";
    private const string LogIndex = "logs-generic.otel-default";

    private static string ElasticUrl => RealStack.Get("SKP_ES_URL", "http://localhost:19200");

    /// <summary>
    /// Reads whatever lands on the failures topic between now and the deadline.
    /// <para>
    /// A fresh group id per call, with <c>AutoOffsetReset.Latest</c>: this test must see what ITS
    /// failure produced, not the backlog of every failure since the topic was created.
    /// </para>
    /// </summary>
    private static List<JsonElement> Drain(TimeSpan window)
    {
        using var consumer = new ConsumerBuilder<Ignore, string>(new ConsumerConfig
        {
            BootstrapServers = RealStack.KafkaBrokers,
            GroupId = $"failure-recorder-test-{Guid.NewGuid():N}",
            AutoOffsetReset = AutoOffsetReset.Latest,
            EnableAutoCommit = false,
        }).Build();

        consumer.Subscribe(FailuresTopic);

        var records = new List<JsonElement>();
        var deadline = DateTime.UtcNow + window;

        while (DateTime.UtcNow < deadline)
        {
            var result = consumer.Consume(TimeSpan.FromSeconds(2));
            if (result?.Message?.Value is { Length: > 0 } value)
            {
                records.Add(JsonDocument.Parse(value).RootElement.Clone());
            }
        }

        consumer.Close();
        return records;
    }

    /// <summary>
    /// The WARN lines of one lineage, polled to a deadline.
    /// <para>
    /// <b>The poll is not politeness, it is the measured ingest lag.</b> The newest indexed record
    /// on this cluster runs 7-14s behind now, and the line this test wants is the LAST one the
    /// failing pod writes — so a single immediate query reliably returns nothing, and reads as a
    /// missing log rather than a late one.
    /// </para>
    /// </summary>
    private static async Task<List<string>> WarningsAsync(string field, string value)
    {
        using var http = new HttpClient { BaseAddress = new Uri(ElasticUrl) };
        var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(60);

        var query = $$"""
        {
          "size": 20,
          "sort": [{"@timestamp": "asc"}],
          "query": {"bool": {
            "filter": [
              {"term": {"attributes.{{field}}": "{{value}}"}},
              {"term": {"severity_text": "Warning"}}
            ],
            "must_not": [{"term": {"scope.name": "BaseConsole.Core.Health.HealthProbeLog"}}]
          }}
        }
        """;

        while (DateTime.UtcNow < deadline)
        {
            var response = await http.PostAsync(
                $"/{LogIndex}/_search",
                new StringContent(query, Encoding.UTF8, "application/json"));

            var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
            var hits = body.RootElement.GetProperty("hits").GetProperty("hits");

            if (hits.GetArrayLength() > 0)
            {
                return hits.EnumerateArray()
                    .Select(h => h.GetProperty("_source").GetProperty("body").GetProperty("text").GetString() ?? "")
                    .ToList();
            }

            await Task.Delay(TimeSpan.FromSeconds(3));
        }

        return [];
    }

    [Fact]
    public async Task AMidChainFailureProducesARecordNamingItsLineage()
    {
        RealStack.SkipUnlessEnabled();

        // The D5 shape: an archive whose entries are not exactly one .wav + one .json pair, which
        // AcmeHandler.ValidateContent refuses. Seeded (see Step 3) where FileFetcher picks it up.
        // The chain fires on 5,35 * * * * *, so one fire is at most 30s away; 90s covers that plus
        // the chain's own hops plus slack.
        var records = Drain(TimeSpan.FromSeconds(90));

        var record = Assert.Single(records);

        // "N" — 32 hex, no dashes — which is the form Elasticsearch holds, and the reason the query
        // below matches at all.
        var correlation = record.GetProperty("correlationId").GetString()!;
        Assert.Equal(32, correlation.Length);
        Assert.DoesNotContain('-', correlation);

        // "D", dashed, and present because the step that failed had a lineage.
        Assert.True(record.TryGetProperty("executionId", out var executionId));
        var execution = executionId.GetString()!;
        Assert.True(Guid.TryParse(execution, out _));

        Assert.True(record.TryGetProperty("recordedAtUtc", out _));

        // The pointer resolves: the lineage it names ends in the two WARN lines — one from the
        // processor carrying the reason, one from the orchestrator stopping the run.
        var warnings = await WarningsAsync("ExecutionId", execution);

        Assert.Contains(warnings, w => w.Contains("the author reported the step failed"));
        Assert.Contains(warnings, w => w.Contains("no successor accepts it"));
    }

    [Fact]
    public async Task AnEntryStepFailureProducesARecordWithNoLineage()
    {
        RealStack.SkipUnlessEnabled();

        // Step 3 points the importer's assignment at a topic it will never be assigned, so Open
        // returns false within the idle timeout and the step fails before opening any lineage.
        var records = Drain(TimeSpan.FromSeconds(90));

        var record = Assert.Single(records);

        // OMITTED, not zeroed: "the failed step had no lineage" must stay distinguishable from
        // "this field was not populated". This assertion is what fails if FailureRecordJson ever
        // loses WhenWritingNull.
        Assert.False(record.TryGetProperty("executionId", out _));

        var correlation = record.GetProperty("correlationId").GetString()!;
        Assert.Equal(32, correlation.Length);

        // It still resolves — by correlation rather than execution, which is the entire reason the
        // accessor in Task 1 exists.
        var warnings = await WarningsAsync("CorrelationId", correlation);

        Assert.Contains(warnings, w => w.Contains("was not ready within"));
    }
}
```

- [ ] **Step 2: Run them and verify they fail**

Before seeding anything:

Run:
```bash
dotnet build SK_P.sln -v q
SKP_REALSTACK=1 src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "*FailureRecorderLiveTests*"
```
Expected: FAIL on `Assert.Single(records)` — nothing on the topic — which is the correct failing
state. **Without `SKP_REALSTACK=1` they SKIP**, which is not a failing state and proves nothing.

- [ ] **Step 3: Seed the mid-chain failure and run the first test**

```bash
python tools/make-sample-archives.py
```

Then place a D5-shaped archive — entries sharing a basename that are **not** exactly one `.wav` plus
one `.json` — in the folder FileFetcher reads (`/mnt/skp-files/in` on the node), and run:

```bash
SKP_REALSTACK=1 src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe \
  --filter-method "*AMidChainFailureProducesARecordNamingItsLineage*"
```
Expected: PASS. If no record arrives, check in this order: `kubectl -n skp get pods -l
app=processor-failurerecorder` shows `1/1 READY`; `skp-failures` exists on the broker; step 9's
assignment payload names that topic; the recorder's own logs contain `recorded a failed step`.

- [ ] **Step 4: Remove the seed**

Delete the D5 archive from the node path.

Expected: the next fire completes clean. **The chain fires twice a minute**, so a seed left in place
produces a failure record every 30 seconds.

- [ ] **Step 5: Break the importer assignment, run the second test, restore it**

Read the importer's assignment back, PUT it with a topic nothing publishes to, run the test, then PUT
the original payload back. The assignment id is the one whose `stepId` is
`ab9d8741-c109-4457-a090-d76e1ca64a97`; the original payload is
`{"topic": "skp-paths", "messageCount": 25, "consumerGroup": "skp-splitchain", "idleTimeoutSeconds": 10}`.

```bash
ASG=$(curl -s http://localhost:18080/api/v1/assignments \
      | jq -r '.[] | select(.stepId=="ab9d8741-c109-4457-a090-d76e1ca64a97") | .id')
ROW=$(curl -s "http://localhost:18080/api/v1/assignments/$ASG")

curl -s -X PUT "http://localhost:18080/api/v1/assignments/$ASG" \
  -H 'Content-Type: application/json' \
  -d "$(echo "$ROW" | jq '{name, version, description, stepId,
payload: "{\\"topic\\": \\"skp-nothing-publishes-here\\", \\"messageCount\\": 25, \\"consumerGroup\\": \\"skp-splitchain\\", \\"idleTimeoutSeconds\\": 10}"}')"

SKP_REALSTACK=1 src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe \
  --filter-method "*AnEntryStepFailureProducesARecordWithNoLineage*"

# RESTORE IMMEDIATELY, whatever the test did. A broken importer assignment fails every fire,
# twice a minute, until it is put back.
curl -s -X PUT "http://localhost:18080/api/v1/assignments/$ASG" \
  -H 'Content-Type: application/json' \
  -d "$(echo "$ROW" | jq '{name, version, description, stepId, payload}')"
```
Expected: the test PASSES, and the restore returns 200. Confirm the next fire completes:
`kubectl -n skp logs -l app=processor-kafkaimporter --tail=20 --timestamps`.

- [ ] **Step 6: Run the whole hermetic suite once more**

Run:
```bash
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe
```
Expected: **0 failed, exit 0**, with the two new tests skipped — `SKP_REALSTACK` is unset, so
`SkipUnlessEnabled` takes them out.

- [ ] **Step 7: Commit**

```bash
git add src/tests/BaseApi.Tests/Live/FailureRecorder
git commit -m "test(failurerecorder): prove both record shapes end to end

A mid-chain failure carries a lineage and resolves to the two Warning lines that
name the reason; an entry-step failure omits the execution id entirely and
resolves by correlation instead -- which is the whole reason the correlation
accessor exists.

The Elasticsearch read polls to a 60s deadline because ingest lag on this cluster
measures 7-14s and the line it wants is the last one the failing pod writes: a
single immediate query reliably returns nothing and reads as a missing log rather
than a late one."
```

---

## Notes for whoever executes this

**Order matters in two places.** Task 1 must be packed (`scripts/pack-all.sh`) before Task 2
compiles — the test project consumes `BaseProcessor.Core` as a package, so an unpacked framework edit
is invisible and the failure looks like the edit not working. And Task 6 Step 3 creates step 9 before
step 8, because step 8 must name it.

**Tasks 5 and 6 leave no commit.** Their output is cluster and database state. If they are re-run
after a rebuild, the processor row's `SourceHash` must be repointed to the new build's hash — every
rebuild changes it.

**If the live chain is left failing**, remember the workflow fires twice a minute, so a seed that
fails produces a record every 30 seconds. Remove the seed, or stop the workflow, before walking away.
