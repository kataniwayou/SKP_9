# Remove the Edge Base Classes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete `BaseImporter`/`BaseExporter`, move their behaviour into the two Kafka processors as
ordinary author code, and make "did the author send, and with data or not" the only output rule the
framework enforces.

**Architecture:** A send with no data becomes a legal branch that skips L2 and reports Completed with
`EntryId = Guid.Empty`. A dispatch that returns without sending becomes a Failed outcome that names
its input key. The orchestrator stops reading blobs for Failed and Cancelled outcomes and guards
duplicates with a key-existence check, deleting last. The importer turns an empty poll into
Cancelled; the exporter reports success through a no-data send.

**Tech Stack:** .NET 8, xUnit v3, NSubstitute, StackExchange.Redis, Confluent.Kafka, RabbitMQ
transport (`Messaging.Transport`), Python 3 (`tools/verify-kibana-dashboard.py`), Kibana saved objects
(`kibana/kibana-export.ndjson`).

**Spec:** `docs/superpowers/specs/2026-09-29-remove-edge-bases-design.md`, with D1–D8. Read it before
starting. D3 was amended during planning: a missing branch reports Failed naming the input key, and
the handler does not reclaim that key.

## Global Constraints

- **D8, the tie-breaker for every judgement call:** a duplicate is always preferred to a missing or
  misreported outcome. Only L2 store faults and RabbitMQ send faults (`TransientSendException`,
  including `PostSendException`) are redelivered. Author and Kafka faults end as Failed.
- **Log templates that must survive byte for byte**, because Kibana, the Analyst and live tests match on them:
  - `consumed {Consumed}/{Requested} records; stopped because {Reason}`
  - `imported record {Record} as execution {ExecutionId} from {Origin}`
  - `reading from {Source} faulted after {Imported} item(s)`
  - `acknowledging an item from {Source} faulted after {Imported} item(s); it will be read again and its branch has already been sent`
  - `exported {Bytes} bytes of execution {ExecutionId} to {Destination} at {Offset}`
  - failure messages `opening {topic} failed: {code}` and `{topic} was not ready within {idle}`
- **The framework ships as NuGet packages to the test project.** `BaseApi.Tests.csproj` consumes
  `BaseProcessor.Core` as `PackageReference … VersionOverride="[1.0.0]"`. After **any** edit under
  `src/BaseProcessor.Core`, run `bash scripts/pack-all.sh` before building the tests. Otherwise the
  suite compiles against a stale extracted copy and passes on code it never saw. Expect the `.nupkg`
  files and every consumer's `packages.lock.json` in the diff. That churn is the evidence the repack
  took effect.
- **The orchestrator and processors are project references,** so edits there need only a rebuild.
- **Run tests through the executable**, not `dotnet test`, which prints counts and no names:
  `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -v q` then
  `cd src/tests/BaseApi.Tests/bin/Debug/net8.0 && ./BaseApi.Tests.exe --filter-class "<Namespace.Class>"`.
  Never pass `--filter`: the runner prints its help and runs nothing.
- **Hermetic gate:** a full run (no `SKP_REALSTACK`) is healthy when it reports **0 failed, exit 0**,
  with every skip under `Live/`. Read the shape, not a remembered total.
- `TreatWarningsAsErrors` and `Nullable` are on solution-wide, so a nullable warning fails the build.
- **Out of scope:** image rebuilds, `kind load`, SourceHash repointing, Kibana import and live
  verification. This change is rolled out together with the log-entity-names change in one rebuild
  cycle. Do not touch the cluster.
- **Workspace:** work in a fresh worktree on branch `feature/remove-edge-bases` created from commit
  `83d5987` (the tip of `feature/path-importer`, which `main` does not contain yet, and which holds the
  Analyst run-boundary panel Task 6 edits), using superpowers:using-git-worktrees. The main checkout
  has unrelated uncommitted work (the `nuget/`→`nugets/` move, `skp-toolkit/` deletion) that must not
  be mixed in.
- **Commit messages** follow the repo style `type(scope): sentence` and end with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

1. **A tombstone between real records.** It is skipped and committed, the records around it are sent
   in order, and each commit follows its own record. Test in Task 3.
2. **A commit fault on a skipped record when nothing was sent yet.** The result must be Failed, not
   Cancelled: the source broke, so the poll was not empty. Test in Task 3.
3. **The D3 Failed outcome's own send fails.** The exception propagates and the input key is not
   reclaimed, so the redelivery replays the step instead of losing its outcome. Test in Task 4.
4. **A Failed outcome whose successor handoff fails in the orchestrator.** The key survives, so the
   redelivery passes the existence guard and advances again. Test in Task 5.
5. **The exporter's completion send fails after a successful write.** `PostSendException` propagates,
   and the write happened exactly once in that attempt. The replay's second write is the cost D8
   accepts. Test in Task 2.

---

### Task 1: A send with no data is a legal branch

**Files:**
- Modify: `src/BaseProcessor.Core/Processing/BaseProcessor.cs` (`SendToPostAsync`, lines ~176-222)
- Modify: `src/BaseProcessor.Core/Processing/ProcessedDataHandler.cs` (`RunAsync`, before the `TryValidate` call at ~line 137)
- Test: `src/tests/BaseApi.Tests/Processor/ProcessDispatchHandlerTests.cs`
- Test: `src/tests/BaseApi.Tests/Processor/ProcessedDataHandlerTests.cs`

**Interfaces:**
- Produces: `protected Task SendToPostAsync(byte[]? processedData, Guid executionId, CancellationToken ct)`.
  Null or empty data → `ProcessedData.Data = []` and `ProcessedData.EntryId = Guid.Empty`. Otherwise
  `EntryId = Guid.NewGuid()`. Both mark the branch as sent.
- Produces: `ProcessedDataHandler` answers a branch with `Data.Length == 0` with
  `StepOutcome(..., Guid.Empty, StepResult.Completed)`, with no L2 write and no schema check, and logs
  `branch completed in {ElapsedMs}ms` under `OutcomeLogScope(Completed)`.

- [ ] **Step 1: Write the failing dispatch-side tests**

In `ProcessDispatchHandlerTests.cs`, add a nullable send helper to `Probe` beside `Send`:

```csharp
        public Task Send(byte[] d) => SendToPostAsync(d, E, CancellationToken.None);

        public Task SendNullable(byte[]? d) => SendToPostAsync(d, E, CancellationToken.None);
```

Add these facts after `SaysNothingWhenTheAuthorDidSendABranch`:

```csharp
    [Fact]
    public async Task SendsANoDataBranchUnderAnEmptyEntryId()
    {
        // D4: a send with no data names no L2 key. Guid.Empty is the sentinel every hop already reads
        // as "no blob", so nothing downstream reads or writes L2 for this branch.
        var h = new Harness();
        h.Db.StringGetAsync(L2ProjectionKeys.ExecutionData(E)).Returns((RedisValue)"{}");
        ProcessedData? branch = null;
        await h.Sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(p => branch = p),
                                 Arg.Any<CancellationToken>(), Arg.Any<string?>());
        var probe = new Probe((_, p) => p.Send([]));

        await h.Build(probe).HandleAsync(Body(Dispatch(E)), CancellationToken.None);

        Assert.NotNull(branch);
        Assert.Equal(Guid.Empty, branch.EntryId);
        Assert.Empty(branch.Data);
        Assert.Equal(E, branch.ExecutionId);
    }

    [Fact]
    public async Task TreatsANullSendAsNoDataAndPutsAnEmptyArrayOnTheWire()
    {
        var h = new Harness();
        h.Db.StringGetAsync(L2ProjectionKeys.ExecutionData(E)).Returns((RedisValue)"{}");
        ProcessedData? branch = null;
        await h.Sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(p => branch = p),
                                 Arg.Any<CancellationToken>(), Arg.Any<string?>());
        var probe = new Probe((_, p) => p.SendNullable(null));

        await h.Build(probe).HandleAsync(Body(Dispatch(E)), CancellationToken.None);

        Assert.NotNull(branch);
        Assert.NotNull(branch.Data);
        Assert.Empty(branch.Data);
        Assert.Equal(Guid.Empty, branch.EntryId);
    }

    [Fact]
    public async Task CountsANoDataSendAsABranch()
    {
        // A no-data send is how an author with nothing to hand on still reports Completed, so it
        // must never trip the missing-branch rule.
        var h = new Harness();
        h.Db.StringGetAsync(L2ProjectionKeys.ExecutionData(E)).Returns((RedisValue)"{}");
        var probe = new Probe((_, p) => p.Send([]));

        await h.Build(probe).HandleAsync(Body(Dispatch(E)), CancellationToken.None);

        Assert.DoesNotContain(h.Log.Records, r => r.Level == LogLevel.Error);
        await h.Db.Received(1).KeyDeleteAsync(L2ProjectionKeys.ExecutionData(E), Arg.Any<CommandFlags>());
    }
```

- [ ] **Step 2: Write the failing post-handler tests**

In `ProcessedDataHandlerTests.cs`, add:

```csharp
    [Fact]
    public async Task ANoDataBranchWritesNothingAndReportsCompletedWithNoKey()
    {
        var h = new Harness();
        StepOutcome? sent = null;
        await h.Sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<StepOutcome>(o => sent = o),
                                 Arg.Any<CancellationToken>(), Arg.Any<string?>());

        await h.Build().HandleAsync(Body(Branch(Guid.Empty, "")), CancellationToken.None);

        await h.Db.DidNotReceive().StringSetAsync(
            Arg.Any<RedisKey>(), Arg.Any<RedisValue>(), Arg.Any<TimeSpan?>(),
            Arg.Any<When>(), Arg.Any<CommandFlags>());
        Assert.NotNull(sent);
        Assert.Equal(StepResult.Completed, sent.Result);
        Assert.Equal(Guid.Empty, sent.EntryId);
    }

    [Fact]
    public async Task ANoDataBranchSkipsTheOutputSchema()
    {
        // An empty document would fail any object schema. A no-data branch has no document, so
        // validating one would turn every successful export into a Failed outcome.
        var h = new Harness("""{"type":"object","required":["number"]}""");
        StepOutcome? sent = null;
        await h.Sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<StepOutcome>(o => sent = o),
                                 Arg.Any<CancellationToken>(), Arg.Any<string?>());

        await h.Build().HandleAsync(Body(Branch(Guid.Empty, "")), CancellationToken.None);

        Assert.Equal(StepResult.Completed, sent!.Result);
    }

    [Fact]
    public async Task ANoDataBranchLogsItsCompletionUnderTheCompletedScope()
    {
        // This record is the exporter's Result=Completed witness once ProcessDispatchHandler's
        // terminal line is removed, so it must carry the scope the outcome panels count.
        var h = new Harness();

        await h.Build().HandleAsync(Body(Branch(Guid.Empty, "")), CancellationToken.None);

        var index = h.Log.Records.FindIndex(r => r.Message.StartsWith("branch completed in", StringComparison.Ordinal));
        Assert.True(index >= 0);
        Assert.Equal(nameof(StepResult.Completed), h.Log.RecordScopes[index][OutcomeLogScope.Result]);
    }
```

If `RecordingLogger` exposes `Records` as something other than `List<T>`, use
`h.Log.Records.Select((r, i) => (r, i)).First(t => t.r.Message.StartsWith("branch completed in", StringComparison.Ordinal)).i`
instead of `FindIndex`. `RecordScopes` is the per-record flattened scope list that
`ExecutionRoundTripTests.Harness.ScopeOf` already reads.

- [ ] **Step 3: Run the new tests and watch them fail**

```bash
bash scripts/pack-all.sh
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -v q
cd src/tests/BaseApi.Tests/bin/Debug/net8.0
./BaseApi.Tests.exe --filter-class "BaseApi.Tests.Processor.ProcessDispatchHandlerTests"
./BaseApi.Tests.exe --filter-class "BaseApi.Tests.Processor.ProcessedDataHandlerTests"
```

Expected: `SendsANoDataBranchUnderAnEmptyEntryId` fails because `EntryId` is non-empty.
`TreatsANullSendAsNoData…` fails, either because the build fails (`CS8625`, a null passed to a
non-nullable `byte[]`) or with `ArgumentNullException`. The three post-handler facts fail because
`StringSetAsync` was received, or the schema check reports Failed.

- [ ] **Step 4: Implement `SendToPostAsync`**

In `BaseProcessor.cs`, replace the method's signature and first lines (keep the existing body from
`var branch = new ProcessedData(` onward, and keep the whole `try`/`catch`):

```csharp
    protected async Task SendToPostAsync(byte[]? processedData, Guid executionId, CancellationToken ct)
    {
        // NO DATA IS A LEGAL BRANCH (spec D4). Null and empty are the same thing, and null never
        // reaches the wire. A no-data branch names no L2 key: Guid.Empty is the sentinel every hop
        // already reads as "no blob", so the post handler writes nothing and the orchestrator reads
        // nothing. An author that means to pass data on must check it is non-empty BEFORE calling
        // this -- an empty document sent by mistake is a Completed step with no output.
        var data = processedData ?? [];

        var state = Current;
        var entryId = data.Length == 0 ? Guid.Empty : Guid.NewGuid();

        var branch = new ProcessedData(
            state.CorrelationId, executionId, state.WorkflowId, state.StepId, state.ProcessorId,
            entryId, data);
```

Remove the old `ArgumentNullException.ThrowIfNull(processedData);` line and the old `var entryId`
line. Add these two paragraphs to the method's `<summary>`, directly after the opening `<para>`
about stamping ids:

```csharp
    /// <para>
    /// <b>No data is a branch too.</b> <paramref name="processedData"/> null or empty sends a branch
    /// with <see cref="Guid.Empty"/> as its entry id: nothing is written to L2, the output schema is
    /// not applied, and the step reports Completed. It still counts as having sent a branch. An
    /// author that intends to pass data on must check that it is non-empty first.
    /// </para>
    /// <para>
    /// <b>Never catch <see cref="PostSendException"/>.</b> Nothing stops an author catching it, but it
    /// must propagate: the framework redelivers the dispatch and replays the author, which is a
    /// duplicate. Swallowing it, or rethrowing it as <see cref="FailedException"/>, reports a
    /// success as a failure and runs the workflow's PreviousFailed successors. This system always
    /// takes the duplicate.
    /// </para>
```

- [ ] **Step 5: Implement the no-data branch in `ProcessedDataHandler.RunAsync`**

Insert this block immediately before the line
`if (!ProcessorJsonSchemaValidator.TryValidate(identity.OutputDefinition, p.Data, out var errors))`:

```csharp
        // A BRANCH WITH NO DATA (spec D4): the author finished and has nothing to hand on. There is
        // no document to validate and no blob to write, so neither happens. The outcome names
        // Guid.Empty, which the orchestrator reads as "nothing to read or reclaim": a terminal step
        // ends the run there, a non-terminal one hands its successors empty data.
        if (p.Data is not { Length: > 0 })
        {
            await SendAsync(
                new StepOutcome(p.CorrelationId, p.ExecutionId, p.WorkflowId, p.StepId, p.ProcessorId,
                                Guid.Empty, StepResult.Completed), ct).ConfigureAwait(false);

            using (_logger.BeginScope(OutcomeLogScope.BuildScope(StepResult.Completed)))
            {
                _logger.LogInformation(
                    "branch completed in {ElapsedMs}ms", (int)Stopwatch.GetElapsedTime(started).TotalMilliseconds);
            }

            return;
        }
```

- [ ] **Step 6: Repack, rebuild, run both classes**

```bash
bash scripts/pack-all.sh
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -v q
cd src/tests/BaseApi.Tests/bin/Debug/net8.0
./BaseApi.Tests.exe --filter-class "BaseApi.Tests.Processor.ProcessDispatchHandlerTests"
./BaseApi.Tests.exe --filter-class "BaseApi.Tests.Processor.ProcessedDataHandlerTests"
```

Expected: both classes report 0 failed.

- [ ] **Step 7: Commit**

```bash
git add -A src scripts
git commit -m "feat(processor): a send with no data is a branch that names no L2 key

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

(`git add -A src scripts` is safe here because the worktree holds only this plan's changes. It picks
up the repacked `.nupkg` files and every consumer's `packages.lock.json`. Check `git status` shows
nothing unstaged.)

---

### Task 2: kafka-exporter becomes an ordinary author

**Files:**
- Modify: `src/Processor.KafkaExporter/KafkaExporterProcessor.cs` (rewrite)
- Modify: `src/Processor.KafkaExporter/KafkaExporterConfig.cs:26-28` (base type and doc paragraph)
- Delete: `src/Processor.KafkaExporter/Kafka/KafkaExportSink.cs`
- Test: `src/tests/BaseApi.Tests/KafkaExporter/KafkaExporterTests.cs`

**Interfaces:**
- Consumes: `SendToPostAsync(byte[]?, Guid, CancellationToken)` from Task 1.
- Produces: `public sealed class KafkaExporterProcessor(IRecordProducerFactory, ILogger<KafkaExporterProcessor>) : BaseProcessor<KafkaExporterConfig>, IDisposable`.
  The constructor is unchanged, so `ProcessorHost` and the host-wiring tests need no edit.
- Produces: `public sealed record KafkaExporterConfig(string Topic, int DeliveryTimeoutSeconds) : ProcessorConfig`.

- [ ] **Step 1: Rewrite the no-branch fact and add the send-failure fact**

In `KafkaExporterTests.cs`, replace `SendsNoBranchSoTheLineageEndsHere` entirely with:

```csharp
    [Fact]
    public async Task ReportsItsSuccessWithOneBranchCarryingNoData()
    {
        // Spec D4/D5: the exporter no longer ends the lineage itself. It reports Completed through a
        // no-data send, and the workflow graph decides that the run ends here.
        var (processor, sender, _) = Build(new FakeRecordProducerFactory(new FakeRecordProducer()));
        var branches = new List<ProcessedData>();
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(branches.Add),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());

        await processor.ExecuteAsync(Input("payload"), Payload(), E, CancellationToken.None);

        var branch = Assert.Single(branches);
        Assert.Empty(branch.Data);
        Assert.Equal(Guid.Empty, branch.EntryId);
        Assert.Equal(E, branch.ExecutionId);
    }

    [Fact]
    public async Task LetsAFailedCompletionSendPropagateAfterTheWrite()
    {
        // Review focus 5 and spec D8. The write landed and the report of it did not, so the dispatch
        // must be redelivered. The replay writes a second record -- the duplicate this system prefers
        // to a success reported as a failure.
        var producer = new FakeRecordProducer();
        var (processor, sender, _) = Build(new FakeRecordProducerFactory(producer));
        sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<ProcessedData>(),
                         Arg.Any<CancellationToken>(), Arg.Any<string?>())
              .Returns(_ => throw new TransientSendException("broker gone", new InvalidOperationException()));

        await Assert.ThrowsAsync<PostSendException>(() =>
            processor.ExecuteAsync(Input("payload"), Payload(), E, CancellationToken.None));

        Assert.Single(producer.Produced);
    }

    [Fact]
    public async Task SendsNothingWhenTheExportFails()
    {
        var producer = new FakeRecordProducer { ProduceThrowsOnCall = 1 };
        var (processor, sender, _) = Build(new FakeRecordProducerFactory(producer));

        await Assert.ThrowsAsync<FailedException>(() =>
            processor.ExecuteAsync(Input("payload"), Payload(), E, CancellationToken.None));

        await sender.DidNotReceive().SendAsync(
            Arg.Any<string>(), Arg.Any<string>(), Arg.Any<ProcessedData>(),
            Arg.Any<CancellationToken>(), Arg.Any<string?>());
    }
```

Leave every other fact in the file as it is. They pin behaviour that must survive: entry-step
refusal wording containing "entry", empty-data refusal, the timeout floor, fault conversion, the
cache, and dispose.

- [ ] **Step 2: Run the class and watch the new facts fail**

```bash
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -v q
cd src/tests/BaseApi.Tests/bin/Debug/net8.0 && ./BaseApi.Tests.exe --filter-class "BaseApi.Tests.KafkaExporter.KafkaExporterTests"
```

Expected: `ReportsItsSuccessWithOneBranchCarryingNoData` fails because no branch is sent, and
`LetsAFailedCompletionSendPropagateAfterTheWrite` fails because nothing is thrown.

- [ ] **Step 3: Flatten the config**

In `KafkaExporterConfig.cs`, change `using BaseProcessor.Core.Configuration;` if needed so that
`ProcessorConfig` resolves (it lives in `BaseProcessor.Core.Configuration`), and replace the record
declaration with:

```csharp
public sealed record KafkaExporterConfig(
    string Topic,
    int DeliveryTimeoutSeconds) : ProcessorConfig;
```

In its doc comment, replace the sentence beginning "It lives on <c>ExporterConfig</c> now, because the
framework validates it;" through "so the JSON shape is unchanged." with:

```csharp
/// <c>KafkaExporterProcessor</c> validates it against <c>KafkaProducerSettings.MinimumDeliveryTimeout</c>
/// before building a producer. The JSON shape is unchanged.
```

- [ ] **Step 4: Rewrite the processor**

Replace the whole of `KafkaExporterProcessor.cs` with:

```csharp
using System.Globalization;
using BaseProcessor.Core.Processing;
using Confluent.Kafka;
using Microsoft.Extensions.Logging;
using Processor.KafkaExporter.Kafka;

namespace Processor.KafkaExporter;

/// <summary>
/// Writes the branch it is dispatched with to a topic, then reports Completed with a branch that
/// carries no data.
/// <para>
/// <b>Ordinary author code since 2026-09-29.</b> It used to derive from <c>BaseExporter</c>, which
/// the framework no longer has. Every rule that class enforced is here now, as this processor's own
/// decisions: it needs the execution it exports, a payload, a delivery timeout at or above the
/// producer's floor, and non-empty data.
/// </para>
/// <para>
/// <b>Kafka faults fail the step and are never redelivered.</b> A <see cref="KafkaException"/> from
/// building or producing becomes a <see cref="FailedException"/>, and a producer that faulted on a
/// write is discarded so the next dispatch builds a fresh one.
/// </para>
/// <para>
/// <b>The completion can replay the write, and that is accepted.</b> The no-data send after the
/// write is a RabbitMQ send. If it fails, the <c>PostSendException</c> propagates, the input key is
/// still present, and the redelivery writes to Kafka a second time. This system always prefers a
/// duplicate to a success reported as a failure, so the exception is never caught here.
/// </para>
/// </summary>
public sealed class KafkaExporterProcessor(
    IRecordProducerFactory factory,
    ILogger<KafkaExporterProcessor> logger)
    : BaseProcessor<KafkaExporterConfig>, IDisposable
{
    private IRecordProducer? _producer;
    private string? _key;

    protected override async Task ProcessAsync(
        byte[] data, KafkaExporterConfig? config, Guid executionId, CancellationToken ct)
    {
        // First, before the payload and data checks, so a mis-wired step names the wiring rather than
        // a symptom of it.
        if (executionId == Guid.Empty)
        {
            throw new FailedException(
                "KafkaExporter exports the execution it is dispatched with, and it was dispatched as " +
                "an entry step with none. Wire it downstream of the step that produces its input.");
        }

        if (config is null)
        {
            throw new FailedException("KafkaExporter needs a step payload naming topic and deliveryTimeoutSeconds");
        }

        var floor = (int)KafkaProducerSettings.MinimumDeliveryTimeout.TotalSeconds;
        if (config.DeliveryTimeoutSeconds < floor)
        {
            throw new FailedException(
                $"KafkaExporter needs DeliveryTimeoutSeconds of at least {floor}; " +
                $"the step payload named {config.DeliveryTimeoutSeconds}");
        }

        // An empty input is a failure, not an empty export: writing zero bytes would put a record on
        // the topic no reader can use while reporting Completed.
        if (data.Length == 0)
        {
            throw new FailedException($"KafkaExporter was dispatched with no input to export to {config.Topic}");
        }

        IRecordProducer producer;
        try
        {
            producer = Rent(config);
        }
        catch (KafkaException ex)
        {
            throw new FailedException($"building a sink for {config.Topic} failed: {ex.Error.Code}", ex);
        }

        string landed;
        try
        {
            landed = await producer.ProduceAsync(config.Topic, data, ct).ConfigureAwait(false);
        }
        catch (KafkaException ex)
        {
            Evict();
            throw new FailedException($"exporting to {config.Topic} failed: {ex.Error.Code}", ex);
        }

        // The payload is never logged: the execution id already leads back to every step that
        // touched it.
        logger.LogInformation(
            "exported {Bytes} bytes of execution {ExecutionId} to {Destination} at {Offset}",
            data.Length, executionId, config.Topic, landed);

        // Completed, with nothing to hand on. PostSendException must propagate -- see the summary.
        await SendToPostAsync([], executionId, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// A cache of one producer, keyed on the delivery timeout it was built with. The topic is not in
    /// the key: a producer is not bound to the topic it writes to. Safe because the processor is a
    /// singleton and prefetch is one.
    /// </summary>
    private IRecordProducer Rent(KafkaExporterConfig config)
    {
        var key = config.DeliveryTimeoutSeconds.ToString(CultureInfo.InvariantCulture);
        if (_producer is not null && _key == key)
        {
            return _producer;
        }

        Evict();

        var producer = factory.Create(TimeSpan.FromSeconds(config.DeliveryTimeoutSeconds));
        _producer = producer;
        _key = key;
        return producer;
    }

    /// <summary>Discards the cached producer. Blanket catch: nothing Dispose throws changes what happens next.</summary>
    private void Evict()
    {
        if (_producer is null)
        {
            return;
        }

        try
        {
            _producer.Dispose();
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "disposing the export sink failed; discarding it anyway");
        }
        finally
        {
            _producer = null;
            _key = null;
        }
    }

    /// <summary>The container disposes this singleton at shutdown, which flushes and closes the producer.</summary>
    public void Dispose()
    {
        Evict();
        GC.SuppressFinalize(this);
    }
}
```

Delete `src/Processor.KafkaExporter/Kafka/KafkaExportSink.cs`.

- [ ] **Step 5: Run the exporter classes**

```bash
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -v q
cd src/tests/BaseApi.Tests/bin/Debug/net8.0
./BaseApi.Tests.exe --filter-class "BaseApi.Tests.KafkaExporter.KafkaExporterTests"
./BaseApi.Tests.exe --filter-class "BaseApi.Tests.KafkaExporter.KafkaExporterConfigTests"
```

Expected: 0 failed in both. If the host-wiring test for the exporter lives in another class
(`grep -rn "KafkaExporterProcessor" src/tests --include=*.cs`), run that class too.

- [ ] **Step 6: Commit**

```bash
git add -A src/Processor.KafkaExporter src/tests/BaseApi.Tests/KafkaExporter
git commit -m "refactor(kafka-exporter): own its guards and report success through a no-data send

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: kafka-importer becomes an ordinary author

**Files:**
- Modify: `src/Processor.KafkaImporter/KafkaImporterProcessor.cs` (rewrite)
- Modify: `src/Processor.KafkaImporter/KafkaImporterConfig.cs:24-28`
- Modify: `src/Processor.KafkaImporter/Kafka/KafkaRecord.cs:26` (`Value` nullable, plus one doc paragraph)
- Delete: `src/Processor.KafkaImporter/Kafka/KafkaImportSource.cs`
- Test: `src/tests/BaseApi.Tests/KafkaImporter/FakeRecordConsumer.cs`
- Test: `src/tests/BaseApi.Tests/KafkaImporter/KafkaImporterLoopTests.cs`
- Test: `src/tests/BaseApi.Tests/KafkaImporter/KafkaImporterCacheTests.cs`

**Interfaces:**
- Consumes: `SendToPostAsync(byte[]?, Guid, CancellationToken)`, `NewExecutionId()`,
  `FailedException(string, Exception?)` and `CancelledException(string, Exception?)` from
  `BaseProcessor.Core.Processing`.
- Produces: `public sealed class KafkaImporterProcessor(IRecordConsumerFactory, ILogger<KafkaImporterProcessor>) : BaseProcessor<KafkaImporterConfig>, IDisposable`.
  The constructor is unchanged.
- Produces: `public sealed record KafkaRecord(byte[]? Value, string Offset)`.
- Produces: `public sealed record KafkaImporterConfig(string Topic, string ConsumerGroup, int MessageCount, int IdleTimeoutSeconds) : ProcessorConfig`.
- Behaviour the next tasks rely on: the importer never returns normally without sending. It either
  sends at least one branch, or throws `CancelledException` (nothing to import) or `FailedException`
  (the source broke before anything was sent).

- [ ] **Step 1: Teach the fake about tombstones**

In `FakeRecordConsumer.cs`, add after the `WithRecords(params byte[][] values)` method:

```csharp
    /// <summary>A record whose value is null, which is how Confluent hands over a tombstone.</summary>
    public FakeRecordConsumer WithTombstone()
    {
        _records.Enqueue(new KafkaRecord(null, $"records [0] @{_records.Count}"));
        return this;
    }
```

Then replace the last line of `Commit`, `Committed.Add(Encoding.UTF8.GetString(record.Value));`, with:

```csharp
        Committed.Add(record.Value is null ? "<tombstone>" : Encoding.UTF8.GetString(record.Value));
```

Note that `WithRecords` numbers offsets from `i`, and `WithTombstone` numbers from the queue length.
Tests that mix them only assert on `Committed` content, never on offsets.

- [ ] **Step 2: Rewrite the loop facts the spec changes**

In `KafkaImporterLoopTests.cs`:

(a) Delete `FailsTheStepWhenItIsDispatchedInsideALineage` and
`NamesTheWiringRatherThanTheMissingPayloadWhenBothAreWrong`, and add in their place:

```csharp
    /// <summary>
    /// Spec D2: the framework has no executionId rules and this author chose to ignore its input
    /// id. Every record still opens its own lineage.
    /// </summary>
    [Fact]
    public async Task IgnoresAnInboundExecutionIdAndMintsPerRecord()
    {
        var inbound = Guid.Parse("99999999-9999-9999-9999-999999999999");
        var consumer = new FakeRecordConsumer().WithRecords("value-a", "value-b");
        var (processor, sender, _) = Build(new FakeRecordConsumerFactory(consumer));

        var sends = new List<ProcessedData>();
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(sends.Add),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());

        await processor.ExecuteAsync([], Payload(2), inbound, CancellationToken.None);

        Assert.Equal(2, sends.Count);
        Assert.DoesNotContain(inbound, sends.Select(s => s.ExecutionId));
        Assert.Equal(2, sends.Select(s => s.ExecutionId).Distinct().Count());
    }
```

(b) Replace `StopsAtFaultedWhenConsumeThrowsADeterministicFault` with:

```csharp
    /// <summary>
    /// A fault before anything was sent fails the step: the source broke, and "no branches" would
    /// otherwise read exactly like an empty topic. The summary line is still written first, so the
    /// poll stays countable.
    /// </summary>
    [Fact]
    public async Task FailsTheStepWhenConsumeFaultsBeforeAnythingWasSent()
    {
        var consumer = new FakeRecordConsumer
        {
            ConsumeThrowsOnCall = 1,
            Fault = new Confluent.Kafka.Error(Confluent.Kafka.ErrorCode.TopicAuthorizationFailed),
        }.WithRecords("value-a");
        var (processor, sender, log) = Build(new FakeRecordConsumerFactory(consumer));

        var failed = await Assert.ThrowsAsync<FailedException>(() =>
            processor.ExecuteAsync([], Payload(10), Guid.Empty, CancellationToken.None));

        Assert.Contains("records", failed.Message);
        Assert.Contains("consumed 0/10 records; stopped because Faulted", Summary(log));
        Assert.True(consumer.Disposed);
    }
```

(c) Add these facts at the end of the class:

```csharp
    // ---- Nothing to import -----------------------------------------------------------------

    /// <summary>
    /// An empty poll is a Cancelled step (spec: "Every empty poll becomes a Cancelled run"). The
    /// summary line with Consumed=0 comes first, because the Analyst's run-boundary panel counts it.
    /// </summary>
    [Fact]
    public async Task CancelsWhenTheTopicHasNothingToRead()
    {
        var consumer = new FakeRecordConsumer();
        var (processor, sender, log) = Build(new FakeRecordConsumerFactory(consumer));

        await Assert.ThrowsAsync<CancelledException>(() =>
            processor.ExecuteAsync([], Payload(10), Guid.Empty, CancellationToken.None));

        Assert.Contains("consumed 0/10 records; stopped because Drained", Summary(log));
        await sender.DidNotReceive().SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<ProcessedData>(),
                                               Arg.Any<CancellationToken>(), Arg.Any<string?>());
    }

    [Fact]
    public async Task SkipsAndCommitsEmptyAndTombstoneRecordsWithoutSendingThem()
    {
        var consumer = new FakeRecordConsumer().WithRecords("value-a");
        consumer.WithTombstone();
        consumer.WithRecords(Array.Empty<byte>());
        consumer.WithRecords("value-b");
        var (processor, sender, log) = Build(new FakeRecordConsumerFactory(consumer));

        var sends = await Run(processor, sender, messageCount: 10);

        Assert.Equal(["value-a", "value-b"], sends.Select(ValueIn));
        Assert.Equal(["value-a", "<tombstone>", "", "value-b"], consumer.Committed);
        Assert.Equal(2, log.Records.Count(r => r.Message.StartsWith("skipped an empty record at", StringComparison.Ordinal)));
        Assert.Contains("consumed 2/10 records; stopped because Drained", Summary(log));
    }

    [Fact]
    public async Task NeverLogsTheContentOfASkippedRecord()
    {
        var consumer = new FakeRecordConsumer().WithTombstone();
        consumer.WithRecords("value-a");
        var (processor, sender, log) = Build(new FakeRecordConsumerFactory(consumer));

        await Run(processor, sender, messageCount: 10);

        var skip = log.Records.Single(r => r.Message.StartsWith("skipped an empty record at", StringComparison.Ordinal));
        Assert.Contains("records [0] @0", skip.Message);
    }

    [Fact]
    public async Task CancelsWhenEveryRecordReadWasEmpty()
    {
        var consumer = new FakeRecordConsumer().WithTombstone();
        consumer.WithRecords(Array.Empty<byte>());
        var (processor, sender, log) = Build(new FakeRecordConsumerFactory(consumer));

        var cancelled = await Assert.ThrowsAsync<CancelledException>(() =>
            processor.ExecuteAsync([], Payload(10), Guid.Empty, CancellationToken.None));

        Assert.Contains("empty", cancelled.Message);
        Assert.Equal(["<tombstone>", ""], consumer.Committed);
        Assert.Contains("consumed 0/10 records; stopped because Drained", Summary(log));
    }

    /// <summary>
    /// Review focus 2: the source broke on the commit of a skipped record before anything was sent.
    /// That is a Failed step, not an empty poll.
    /// </summary>
    [Fact]
    public async Task FailsWhenCommittingASkippedRecordFaultsBeforeAnythingWasSent()
    {
        var consumer = new FakeRecordConsumer { CommitThrowsOnCall = 1 }.WithTombstone();
        consumer.WithRecords("value-a");
        var (processor, _, _) = Build(new FakeRecordConsumerFactory(consumer));

        await Assert.ThrowsAsync<FailedException>(() =>
            processor.ExecuteAsync([], Payload(10), Guid.Empty, CancellationToken.None));
    }

    /// <summary>
    /// A skipped record takes a slot of MessageCount, so a topic full of tombstones cannot hold one
    /// dispatch for ever.
    /// </summary>
    [Fact]
    public async Task CountsSkippedRecordsAgainstTheRequestedCount()
    {
        var consumer = new FakeRecordConsumer().WithTombstone();
        consumer.WithTombstone();
        consumer.WithRecords("value-a");
        var (processor, _, _) = Build(new FakeRecordConsumerFactory(consumer));

        await Assert.ThrowsAsync<CancelledException>(() =>
            processor.ExecuteAsync([], Payload(2), Guid.Empty, CancellationToken.None));

        Assert.Equal(["<tombstone>", "<tombstone>"], consumer.Committed);
    }
```

`FakeRecordConsumer.WithRecords(params byte[][])` with `Array.Empty<byte>()` enqueues one empty
record. If overload resolution picks the `string[]` form, write `consumer.WithRecords(new byte[][] { [] });`.

- [ ] **Step 3: Fix the cache facts whose second dispatch now finds nothing**

In `KafkaImporterCacheTests.cs`:

`ReusesOneConsumerAcrossDispatchesOnTheSameTopic`: the first dispatch drains both records, so the
second finds nothing. Replace its second `ExecuteAsync` line with:

```csharp
        await Assert.ThrowsAsync<CancelledException>(() =>
            processor.ExecuteAsync([], Payload("records"), Guid.Empty, CancellationToken.None));
```

`DiscardsTheConsumerAfterATransientFaultSoTheNextDispatchIsFresh`: the first dispatch faults before
sending, so it now fails. Replace its first `ExecuteAsync` line with:

```csharp
        await Assert.ThrowsAsync<FailedException>(() =>
            processor.ExecuteAsync([], Payload("records"), Guid.Empty, CancellationToken.None));
```

Add `using BaseProcessor.Core.Processing;` if it is not already present. It is.

- [ ] **Step 4: Run the importer classes and watch them fail**

```bash
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -v q
cd src/tests/BaseApi.Tests/bin/Debug/net8.0
./BaseApi.Tests.exe --filter-class "BaseApi.Tests.KafkaImporter.KafkaImporterLoopTests"
./BaseApi.Tests.exe --filter-class "BaseApi.Tests.KafkaImporter.KafkaImporterCacheTests"
```

Expected: the build fails first, because `new KafkaRecord(null, …)` hits the nullable-as-error rule.
That is the first red. After Step 5 changes `KafkaRecord`, the new facts fail on behaviour: no
`CancelledException`, and a tombstone sent as a branch.

- [ ] **Step 5: Make `KafkaRecord.Value` nullable**

In `KafkaRecord.cs`, change the declaration to:

```csharp
public sealed record KafkaRecord(byte[]? Value, string Offset);
```

Add this paragraph to its summary, before `</summary>`:

```csharp
/// <para>
/// <b><paramref name="Value"/> is null for a tombstone.</b> Confluent hands a tombstone's value over
/// as null. The importer skips it, and skips an empty value too, committing the offset so the record
/// is never read again.
/// </para>
```

- [ ] **Step 6: Flatten the config**

In `KafkaImporterConfig.cs`, replace the record declaration with:

```csharp
public sealed record KafkaImporterConfig(
    string Topic,
    string ConsumerGroup,
    int MessageCount,
    int IdleTimeoutSeconds) : ProcessorConfig;
```

- [ ] **Step 7: Rewrite the processor**

Replace the whole of `KafkaImporterProcessor.cs` with:

```csharp
using System.Text;
using BaseProcessor.Core.Processing;
using Confluent.Kafka;
using Microsoft.Extensions.Logging;
using Processor.KafkaImporter.Kafka;

namespace Processor.KafkaImporter;

/// <summary>
/// Reads a topic and opens one lineage per non-empty record, sending each record's value downstream
/// as is.
/// <para>
/// <b>Ordinary author code since 2026-09-29.</b> It used to derive from <c>BaseImporter</c>, which
/// the framework no longer has. The loop, the one-consumer cache with evict-on-fault, send-then-commit
/// ordering and the log lines moved here unchanged. Log text is matched by Kibana, the Analyst and the
/// live tests, so none of it may be reworded.
/// </para>
/// <para>
/// <b>It never returns without sending.</b> A dispatch either sends at least one branch, or throws
/// <see cref="CancelledException"/> when there was nothing to import (an empty topic, or only empty
/// and tombstone records), or throws <see cref="FailedException"/> when the source broke before
/// anything was sent. Once a branch has gone out, a later fault ends the dispatch where it stands
/// with a Warning, and the lineages already sent carry on.
/// </para>
/// <para>
/// <b>The input execution id is ignored</b>, by this author's choice: every record is the origin of
/// its own lineage.
/// </para>
/// </summary>
public sealed class KafkaImporterProcessor(
    IRecordConsumerFactory factory,
    ILogger<KafkaImporterProcessor> logger)
    : BaseProcessor<KafkaImporterConfig>, IDisposable
{
    /// <summary>The value logged as {Reason}. Its member names are the text operators search for.</summary>
    private enum StopReason
    {
        Completed,
        Drained,
        Faulted,
    }

    private IRecordConsumer? _consumer;
    private string? _key;
    private bool _subscribed;

    protected override async Task ProcessAsync(
        byte[] data, KafkaImporterConfig? config, Guid executionId, CancellationToken ct)
    {
        if (config is null)
        {
            throw new FailedException(
                "KafkaImporter needs a step payload naming topic, consumerGroup, messageCount and idleTimeoutSeconds");
        }

        // Below 1 the loop never runs and the summary would report a false healthy "0/0 Completed".
        if (config.MessageCount < 1)
        {
            throw new FailedException(
                $"KafkaImporter needs MessageCount of at least 1; the step payload named {config.MessageCount}");
        }

        if (config.IdleTimeoutSeconds < 1)
        {
            throw new FailedException(
                $"KafkaImporter needs IdleTimeoutSeconds of at least 1; the step payload named {config.IdleTimeoutSeconds}");
        }

        var idle = TimeSpan.FromSeconds(config.IdleTimeoutSeconds);

        // PART ONE: an open, assigned consumer. Any failure here fails the step, unclassified.
        IRecordConsumer consumer;
        try
        {
            consumer = Rent(config);
        }
        catch (KafkaException ex)
        {
            throw new FailedException($"opening {config.Topic} failed: {ex.Error.Code}", ex);
        }

        bool ready;
        try
        {
            if (!_subscribed)
            {
                consumer.Subscribe(config.Topic);
                _subscribed = true;
            }

            ready = consumer.WaitForAssignment(idle);
        }
        catch (KafkaException ex)
        {
            Evict();
            throw new FailedException($"opening {config.Topic} failed: {ex.Error.Code}", ex);
        }

        // A false return, not a throw, is what a stopped broker produces. Without an assignment an
        // empty poll is indistinguishable from an empty topic.
        if (!ready)
        {
            Evict();
            throw new FailedException($"{config.Topic} was not ready within {idle}");
        }

        // PART TWO: the loop. Once a branch has been sent nothing in it fails the step.
        var read = 0;       // every record consumed, sent or skipped; bounds the dispatch
        var sent = 0;       // branches that reached the post queue
        var imported = 0;   // sent AND committed; the {Consumed} the summary has always reported
        var reason = StopReason.Completed;
        KafkaException? fault = null;

        try
        {
            while (read < config.MessageCount)
            {
                KafkaRecord? record;
                try
                {
                    record = consumer.Consume(idle);
                }
                catch (KafkaException ex)
                {
                    if (sent > 0)
                    {
                        logger.LogWarning(ex, "reading from {Source} faulted after {Imported} item(s)",
                            config.Topic, imported);
                    }

                    fault = ex;
                    reason = StopReason.Faulted;
                    break;
                }

                if (record is null)
                {
                    reason = StopReason.Drained;
                    break;
                }

                read++;

                // EMPTY AND TOMBSTONE RECORDS ARE NOT SENT (spec D4: a no-data send would report the
                // step Completed and run the chain on nothing). They are committed, or the partition
                // re-reads them for ever. Logged by offset only -- never content.
                if (record.Value is not { Length: > 0 } value)
                {
                    try
                    {
                        consumer.Commit(record);
                    }
                    catch (KafkaException ex)
                    {
                        if (sent > 0)
                        {
                            logger.LogWarning(ex,
                                "acknowledging an item from {Source} faulted after {Imported} item(s); it "
                                + "will be read again and its branch has already been sent",
                                config.Topic, imported);
                        }

                        fault = ex;
                        reason = StopReason.Faulted;
                        break;
                    }

                    logger.LogInformation("skipped an empty record at {Origin}; nothing was sent", record.Offset);
                    continue;
                }

                var lineage = NewExecutionId();

                // Logged BEFORE the send, so a send that throws still leaves the lineage it was opening.
                // The value is rendered verbatim: it is the business identifier an operator searches for.
                logger.LogInformation(
                    "imported record {Record} as execution {ExecutionId} from {Origin}",
                    Encoding.UTF8.GetString(value), lineage, record.Offset);

                // PostSendException propagates untouched (spec D8); the uncommitted record is re-read.
                await SendToPostAsync(value, lineage, ct).ConfigureAwait(false);
                sent++;

                // The commit follows the send, so a fault between the two is a duplicate, never a loss.
                try
                {
                    consumer.Commit(record);
                }
                catch (KafkaException ex)
                {
                    logger.LogWarning(ex,
                        "acknowledging an item from {Source} faulted after {Imported} item(s); it "
                        + "will be read again and its branch has already been sent",
                        config.Topic, imported);

                    fault = ex;
                    reason = StopReason.Faulted;
                    break;
                }

                imported++;
            }
        }
        catch
        {
            Evict();
            throw;
        }

        if (reason == StopReason.Faulted)
        {
            Evict();
        }

        // The text is unchanged and is matched by saved queries and the Analyst's run-boundary panel.
        // It is written before either throw below, so an empty poll stays countable by Consumed=0.
        logger.Log(
            reason == StopReason.Faulted ? LogLevel.Warning : LogLevel.Information,
            "consumed {Consumed}/{Requested} records; stopped because {Reason}",
            imported, config.MessageCount, reason);

        if (sent > 0)
        {
            return;
        }

        if (fault is not null)
        {
            throw new FailedException(
                $"reading from {config.Topic} faulted before any record was sent: {fault.Error.Code}", fault);
        }

        throw new CancelledException(read == 0
            ? $"{config.Topic} had no records to import"
            : $"every record read from {config.Topic} was empty");
    }

    /// <summary>
    /// A cache of one consumer, keyed on topic and group: a subscribed consumer is bound to both.
    /// Safe because the processor is a singleton and prefetch is one.
    /// </summary>
    private IRecordConsumer Rent(KafkaImporterConfig config)
    {
        var key = $"{config.Topic}|{config.ConsumerGroup}";
        if (_consumer is not null && _key == key)
        {
            return _consumer;
        }

        Evict();

        var consumer = factory.Create(config.ConsumerGroup);
        _consumer = consumer;
        _key = key;
        _subscribed = false;
        return consumer;
    }

    /// <summary>
    /// Discards the cached consumer. The catches are blanket on purpose: this method's job is to throw
    /// the handle away, and anything propagated from here would replace a fault already in flight.
    /// </summary>
    private void Evict()
    {
        if (_consumer is null)
        {
            return;
        }

        try
        {
            try
            {
                _consumer.Close();
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "closing the import source failed; discarding it anyway");
            }

            try
            {
                _consumer.Dispose();
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "disposing the import source failed; discarding it anyway");
            }
        }
        finally
        {
            _consumer = null;
            _key = null;
            _subscribed = false;
        }
    }

    /// <summary>The container disposes this singleton at shutdown, which leaves the group cleanly.</summary>
    public void Dispose()
    {
        Evict();
        GC.SuppressFinalize(this);
    }
}
```

Delete `src/Processor.KafkaImporter/Kafka/KafkaImportSource.cs`.

Check that `KafkaRecordConsumer.cs:122` (`new KafkaRecord(result.Message.Value, …)`) still compiles.
It does: a `byte[]` converts to `byte[]?`.

- [ ] **Step 8: Run all importer classes**

```bash
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -v q
cd src/tests/BaseApi.Tests/bin/Debug/net8.0
./BaseApi.Tests.exe --filter-class "BaseApi.Tests.KafkaImporter.KafkaImporterLoopTests"
./BaseApi.Tests.exe --filter-class "BaseApi.Tests.KafkaImporter.KafkaImporterCacheTests"
./BaseApi.Tests.exe --filter-class "BaseApi.Tests.KafkaImporter.KafkaImporterConfigTests"
./BaseApi.Tests.exe --filter-class "BaseApi.Tests.KafkaImporter.KafkaImporterHostWiringTests"
```

Expected: 0 failed in each. The surviving original facts must pass unedited: Completed at the
count, Drained with records, Faulted after sends (12/100), commit-after-send, byte-for-byte values,
the "imported record" line, the payload guards, and the rent/assignment failures.

- [ ] **Step 9: Commit**

```bash
git add -A src/Processor.KafkaImporter src/tests/BaseApi.Tests/KafkaImporter
git commit -m "refactor(kafka-importer): own the loop, skip empty records and cancel an empty poll

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Remove the edge bases; a missing branch reports Failed

**Files:**
- Delete: `src/BaseProcessor.Core/Edge/BaseImporter.cs`, `src/BaseProcessor.Core/Edge/BaseExporter.cs`, `src/BaseProcessor.Core/Edge/EdgeSeams.cs`
- Delete: `src/BaseProcessor.Core/Configuration/EdgeConfig.cs`
- Delete: `src/tests/BaseApi.Tests/Processor/EdgeProcessorTests.cs`
- Modify: `src/BaseProcessor.Core/Processing/BaseProcessor.cs:87-135` (remove `EndsLineage` and `MaySendNoBranch` with their docs)
- Modify: `src/BaseProcessor.Core/Processing/ProcessDispatchHandler.cs:357-481` (reclaim condition, missing-branch block, terminal block)
- Modify: `src/BaseProcessor.Core/Processing/ProcessedDataHandler.cs:13-21` (class summary paragraph)
- Test: `src/tests/BaseApi.Tests/Processor/ProcessDispatchHandlerTests.cs`

**Interfaces:**
- Consumes: Tasks 2 and 3, since nothing derives from the edge bases any more.
- Produces: `ProcessDispatchHandler`. When the author returns normally without sending, it logs at
  Error under `OutcomeLogScope(Failed)`, sends `StepOutcome(..., d.EntryId, StepResult.Failed)`, and
  does **not** delete the input key. The reclaim runs only when `ran && state.BranchSent && d.EntryId != Guid.Empty`.

- [ ] **Step 1: Rewrite the missing-branch facts**

In `ProcessDispatchHandlerTests.cs`:

Delete the `SourceProbe` class, and delete `SaysNothingWhenTheProcessorMaySendNoBranch` and
`SendsNothingWhenTheAuthorEndsTheBranchSilently`.

Replace `LogsAnErrorWhenTheAuthorReturnsWithoutSendingABranch` with:

```csharp
    [Fact]
    public async Task ReportsFailedWhenTheAuthorReturnsWithoutSendingABranch()
    {
        // Spec D3 as amended: forgetting to send is the one output rule. The outcome names the INPUT
        // key and the key is left in place, like every other Failed path -- so if this outcome's own
        // send fails, the redelivery replays the step rather than finding the key gone.
        var h = new Harness();
        h.Db.StringGetAsync(L2ProjectionKeys.ExecutionData(E)).Returns((RedisValue)"{}");
        StepOutcome? sent = null;
        await h.Sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<StepOutcome>(o => sent = o),
                                 Arg.Any<CancellationToken>(), Arg.Any<string?>());
        var probe = new Probe((_, _) => Task.CompletedTask);   // runs, never sends

        await h.Build(probe).HandleAsync(Body(Dispatch(E)), CancellationToken.None);

        var error = Assert.Single(h.Log.Records, r => r.Level == LogLevel.Error);
        Assert.Contains("without sending a branch", error.Message, StringComparison.Ordinal);
        Assert.NotNull(sent);
        Assert.Equal(StepResult.Failed, sent.Result);
        Assert.Equal(E, sent.EntryId);
        await h.Db.DidNotReceive().KeyDeleteAsync(Arg.Any<RedisKey>(), Arg.Any<CommandFlags>());
    }

    [Fact]
    public async Task ScopesTheMissingBranchAsFailed()
    {
        var h = new Harness();
        h.Db.StringGetAsync(L2ProjectionKeys.ExecutionData(E)).Returns((RedisValue)"{}");
        var probe = new Probe((_, _) => Task.CompletedTask);

        await h.Build(probe).HandleAsync(Body(Dispatch(E)), CancellationToken.None);

        var resultScope = Assert.Single(h.Log.Scopes, s => s.ContainsKey(OutcomeLogScope.Result));
        Assert.Equal(nameof(StepResult.Failed), resultScope[OutcomeLogScope.Result]);
    }

    [Fact]
    public async Task ReportsASourceStepThatSentNothingAsFailedWithNoKey()
    {
        var h = new Harness();
        StepOutcome? sent = null;
        await h.Sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<StepOutcome>(o => sent = o),
                                 Arg.Any<CancellationToken>(), Arg.Any<string?>());
        var probe = new Probe((_, _) => Task.CompletedTask);

        await h.Build(probe).HandleAsync(Body(Dispatch(Guid.Empty)), CancellationToken.None);

        Assert.Equal(StepResult.Failed, sent!.Result);
        Assert.Equal(Guid.Empty, sent.EntryId);
    }
```

Replace `StillLogsTheErrorWhenEverySendFailed` with:

```csharp
    [Fact]
    public async Task ReplaysRatherThanLosesTheStepWhenTheFailedOutcomeCannotBeSent()
    {
        // Review focus 3. The author swallowed its own failed send (which it must not do), so D3
        // fires, and the broker is still down, so D3's outcome cannot be sent either. The fault must
        // escape AND the input must survive: the redelivery then re-runs the step. Reclaiming first
        // would make the redelivery read "already done" and the outcome would be lost for good.
        var h = new Harness();
        h.Db.StringGetAsync(L2ProjectionKeys.ExecutionData(E)).Returns((RedisValue)"{}");
        h.Sender
            .SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<object>(),
                       Arg.Any<CancellationToken>(), Arg.Any<string?>(), Arg.Any<string?>())
            .ThrowsAsync(new TransientSendException("broker gone", new InvalidOperationException()));
        h.Sender
            .SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<StepOutcome>(),
                       Arg.Any<CancellationToken>(), Arg.Any<string?>(), Arg.Any<string?>())
            .ThrowsAsync(new TransientSendException("broker gone", new InvalidOperationException()));

        var probe = new Probe(async (d, p) =>
        {
            try { await p.Send(d); } catch (PostSendException) { /* swallowed on purpose */ }
        });

        await Assert.ThrowsAnyAsync<TransientSendException>(
            () => h.Build(probe).HandleAsync(Body(Dispatch(E)), CancellationToken.None));

        var error = Assert.Single(h.Log.Records, r => r.Level == LogLevel.Error);
        Assert.Contains("without sending a branch", error.Message, StringComparison.Ordinal);
        await h.Db.DidNotReceive().KeyDeleteAsync(Arg.Any<RedisKey>(), Arg.Any<CommandFlags>());
    }
```

The two stubs cover both generic instantiations: `SendAsync<ProcessedData>` is reached through
`object` in the original fact, and `SendAsync<StepOutcome>` is what `SendTransientAsync` calls. If
`TransientSendException` is thrown from `SendTransientAsync` wrapping the stub's exception, it still
satisfies `ThrowsAnyAsync<TransientSendException>`.

- [ ] **Step 2: Run the class and watch the new facts fail**

```bash
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -v q
cd src/tests/BaseApi.Tests/bin/Debug/net8.0 && ./BaseApi.Tests.exe --filter-class "BaseApi.Tests.Processor.ProcessDispatchHandlerTests"
```

Expected: `ReportsFailedWhen…` fails (no outcome is sent, and the key is deleted), and
`ScopesTheMissingBranchAsFailed` fails (no Result scope). The build itself may fail first, if another
test still references the flags. Fix that in Step 3.

- [ ] **Step 3: Delete the edge code and the flags**

```bash
git rm src/BaseProcessor.Core/Edge/BaseImporter.cs src/BaseProcessor.Core/Edge/BaseExporter.cs \
       src/BaseProcessor.Core/Edge/EdgeSeams.cs src/BaseProcessor.Core/Configuration/EdgeConfig.cs \
       src/tests/BaseApi.Tests/Processor/EdgeProcessorTests.cs
```

In `BaseProcessor.cs`, delete the `EndsLineage` property and the `MaySendNoBranch` property,
including each one's full `/// <summary>` block (about lines 87-135).

- [ ] **Step 4: Rewrite the tail of `ProcessDispatchHandler.RunAsync`**

Replace everything from the comment block that starts `// The input is reclaimed HERE rather than in
the post handler` to the end of `RunAsync` (the closing brace after the `EndsLineage` block) with:

```csharp
        // Did the author do what every author must: send at least one branch? A no-data send counts
        // (spec D4). Anything else that returned normally forgot, and that is the one output rule
        // the framework enforces (spec D3).
        var forgotToSend = ran && !state.BranchSent;

        // The input is reclaimed HERE rather than in the post handler, and only after the author's
        // transform returned normally having sent. A fan-out sends N branches from inside one
        // ProcessAsync; the return is the only signal that all N went out. Reclaiming per branch
        // instead would delete the input after branch 1, so a failed branch-2 send would requeue a
        // dispatch whose input is already gone.
        //
        // Outside the catch chain on purpose: a store fault on this delete must propagate so the L2
        // classifier trips the gate and requeues.
        //
        // NOT RECLAIMED WHEN THE AUTHOR FORGOT TO SEND. The Failed outcome below names this key, as
        // every Failed path does, and the orchestrator reclaims it. Reclaiming here first would make a
        // failed send of that outcome unrecoverable: the redelivery would read the key absent, take
        // the duplicate branch and return, and the step would end with no outcome at all. Leaving it
        // makes that a replay, which this system always prefers.
        //
        // Skipped for a source step, which produced its own input and has no key.
        if (ran && !forgotToSend && d.EntryId != Guid.Empty)
        {
            _logger.LogDebug("reclaiming the input from L2");

            await _redis.GetDatabase()
                .KeyDeleteAsync(L2ProjectionKeys.ExecutionData(d.EntryId))
                .ConfigureAwait(false);
        }

        _logger.LogInformation(
            "the step returned after {ElapsedMs}ms", (int)Stopwatch.GetElapsedTime(started).TotalMilliseconds);

        // THE ONE OUTPUT RULE (spec D3). An author reports its outcome through the branches it sends:
        // with data to hand it on, with no data to say it finished with nothing to hand on. Returning
        // without either used to end the lineage with an Error line and no outcome, so the
        // orchestrator never advanced. It is now a Failed outcome like any other, scoped so
        // attributes.Result counts it, and at Error because it is a defect in the author, not a
        // business result.
        if (forgotToSend)
        {
            using (_logger.BeginScope(OutcomeLogScope.BuildScope(StepResult.Failed)))
            {
                _logger.LogError(
                    "the step returned without sending a branch — reported failed. A processor must "
                    + "call SendToPostAsync at least once, with no data if it has nothing to hand on; "
                    + "a step that decides not to continue reports that by throwing CancelledException.");
            }

            await SendAsync(Failure(d, StepResult.Failed), ct).ConfigureAwait(false);
        }
    }
```

Keep `Failure(...)` and `SendAsync(...)` below it unchanged. In `Failure`'s summary, replace
"None of these paths sets <c>ran</c>, so the reclaim at the end of <see cref="RunAsync"/> is
skipped" with "None of these paths reclaims the input (the missing-branch path included), so".

- [ ] **Step 5: Fix the stale framework comments**

- `ProcessedDataHandler.cs` summary: delete the paragraph beginning `<b>It is not the only place an
  outcome comes from, and it stopped being so on 2026-09-11.</b>` (it cites `EndsLineage`), and add in
  its place:

```csharp
/// <para>
/// <b>A branch with no data</b> is how an author reports Completed with nothing to hand on. It skips
/// the output schema and the L2 write and reports <see cref="Guid.Empty"/>. See
/// <see cref="BaseProcessor.SendToPostAsync"/>.
/// </para>
```

- `ProcessDispatchHandler.cs`, in the duplicate-delivery comment inside the `raw.IsNullOrEmpty`
  branch: replace the sentence `StepOutcomeHandler.ReadAsync meets the same condition — the key its
  message names is gone — and THROWS, so the delivery parks. This one acks.` with
  `StepOutcomeHandler meets the same condition — the key its message names is gone — and also acks,
  logging it at Warning.`. Then delete the rest of that "DIVERGES FROM THE ORCHESTRATOR ON PURPOSE"
  paragraph and the two paragraphs after it ("The case for acking here…", "Neither is obviously
  right…"), because the divergence they describe no longer exists.
- `ConfigSchemaConformance.cs:74-75`: replace `(see KafkaImporterConfig, whose MessageCount and
  IdleTimeoutSeconds are declared on ImporterConfig)` with `(a config record deriving from another)`.

- [ ] **Step 6: Repack, rebuild, run**

```bash
bash scripts/pack-all.sh
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -v q
cd src/tests/BaseApi.Tests/bin/Debug/net8.0
./BaseApi.Tests.exe --filter-class "BaseApi.Tests.Processor.ProcessDispatchHandlerTests"
./BaseApi.Tests.exe --filter-class "BaseApi.Tests.Processor.ProcessedDataHandlerTests"
./BaseApi.Tests.exe --filter-class "BaseApi.Tests.Processor.StepFailureCarriesItsCauseTests"
./BaseApi.Tests.exe --filter-class "BaseApi.Tests.KafkaImporter.KafkaImporterLoopTests"
./BaseApi.Tests.exe --filter-class "BaseApi.Tests.KafkaExporter.KafkaExporterTests"
```

Expected: 0 failed in each. Then confirm nothing still names the removed types:

```bash
grep -rn "BaseImporter\|BaseExporter<\|EndsLineage\|MaySendNoBranch\|IImportSource\|IExportSink\|\bImporterConfig\b\|\bExporterConfig\b\|ImportSourceException\|ExportSinkException" --include=*.cs src | grep -v "/obj/\|/bin/\|BaseExporter<Metric>"
```

Expected: only comment hits in the files Task 7 rewords, and none in code.

- [ ] **Step 7: Commit**

```bash
git add -A src scripts
git commit -m "refactor(processor): drop the edge bases; a step that sends nothing reports Failed

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: The orchestrator stops reading blobs for Failed and Cancelled

**Files:**
- Modify: `src/Orchestrator/Messaging/StepOutcomeHandler.cs:208-228` (the read) and the `ReadAsync` region (~line 421)
- Test: `src/tests/BaseApi.Tests/Orchestrator/ExecutionRoundTripTests.cs`

**Interfaces:**
- Consumes: Failed and Cancelled outcomes that name the step's input key (Task 4, and every existing
  Failure path).
- Produces: for Failed/Cancelled with `EntryId` set, `KeyExistsAsync` up front. Absent means a
  duplicate: log the existing Warning and return. Present means successors are handed **empty** data
  (so `NextStepHandoff.EntryId = Guid.Empty`) and the key is deleted last. Completed is unchanged.

- [ ] **Step 1: Rewrite and add the facts**

Replace `AFailedStepsInputIsHandedToTheFailureBranchAndReclaimed` with:

```csharp
    [Fact]
    public async Task AFailedStepsSuccessorReceivesNoDataAndTheInputIsReclaimed()
    {
        // Spec D6: a Failed outcome's EntryId is only something to clean up. The failure branch runs
        // as a source step on empty data, and the failed step's input is still reclaimed.
        var h = new Harness(Step(A, PA, 1, "{}", B), Step(B, PB, 2, "{}"));
        Seed(h, Entry, Output);

        await h.Deliver(MessageTypes.StepOutcome, Outcome(StepResult.Failed, Entry));
        await h.Drain();

        var dispatch = h.Bus.OfType<ProcessDispatch>(MessageTypes.ProcessDispatch).Single();
        Assert.Equal(B, dispatch.StepId);
        Assert.Equal(Guid.Empty, dispatch.EntryId);
        Assert.False(h.L2.Has(L2ProjectionKeys.ExecutionData(Entry)));
        Assert.Empty(h.L2.Keys());
    }

    [Fact]
    public async Task AFailedOrCancelledOutcomeNeverReadsTheBlob()
    {
        var h = new Harness(Step(A, PA, 1, "{}", B), Step(B, PB, Always, "{}"));
        Seed(h, Entry, Output);

        await h.Deliver(MessageTypes.StepOutcome, Outcome(StepResult.Cancelled, Entry));

        await h.L2.Db.DidNotReceive().StringGetAsync(
            (RedisKey)L2ProjectionKeys.ExecutionData(Entry), Arg.Any<CommandFlags>());
        await h.L2.Db.Received(1).KeyExistsAsync(
            (RedisKey)L2ProjectionKeys.ExecutionData(Entry), Arg.Any<CommandFlags>());
    }

    [Fact]
    public async Task ADuplicateFailedOutcomeAdvancesNothing()
    {
        // The existence check is the guard. The first delivery reclaimed the key, so this one finds
        // it absent and does nothing, exactly as the read-based guard did.
        var h = new Harness(Step(A, PA, 1, "{}", B), Step(B, PB, 2, "{}"));

        await h.Deliver(MessageTypes.StepOutcome, Outcome(StepResult.Failed, Entry));
        await h.Drain();

        Assert.Empty(h.Bus.Sent);
        Assert.Contains(h.PreLog.Records,
            e => e.Level == LogLevel.Warning && e.Message.Contains("duplicate delivery", StringComparison.Ordinal));
    }

    [Fact]
    public async Task AFailedOutcomeWhoseHandOffFailsKeepsItsKeyForTheReplay()
    {
        // Review focus 4, and the reason DEL is last rather than the guard: if DEL ran first, this
        // redelivery would find the key gone and the failure branch would never be dispatched.
        var h = new Harness(Step(A, PA, 1, "{}", B), Step(B, PB, 2, "{}"));
        Seed(h, Entry, Output);
        h.Bus.FaultOn = t => t == MessageTypes.NextStepHandoff
            ? new TransientSendException("broker blip", new IOException("reset"))
            : null;

        await Assert.ThrowsAsync<TransientSendException>(
            () => h.Deliver(MessageTypes.StepOutcome, Outcome(StepResult.Failed, Entry)));
        Assert.True(h.L2.Has(L2ProjectionKeys.ExecutionData(Entry)));

        h.Bus.FaultOn = null;
        await h.Deliver(MessageTypes.StepOutcome, Outcome(StepResult.Failed, Entry));
        await h.Drain();

        Assert.Single(h.Bus.OfType<ProcessDispatch>(MessageTypes.ProcessDispatch));
        Assert.False(h.L2.Has(L2ProjectionKeys.ExecutionData(Entry)));
    }

    [Fact]
    public async Task ACompletedOutcomeWithNoKeyEndsATerminalStep()
    {
        // The exporter's no-data branch: Completed naming Guid.Empty on a step with no successor.
        var h = new Harness(Step(A, PA, 1, "{}"));

        await h.Deliver(MessageTypes.StepOutcome, Outcome(StepResult.Completed, Guid.Empty));

        Assert.Empty(h.Bus.Sent);
        Assert.NotNull(h.ScopeOf(TerminalTemplate));
    }
```

Add `using StackExchange.Redis;` at the top if it is not already there, and `using NSubstitute;` if
`DidNotReceive` does not resolve. `InMemoryL2.Db` is an NSubstitute substitute, so `Received` works
on it. Leave `AFailedStepThatAdvancesAnywaySaysSo` as it is: its assertions are about log lines and
still hold.

- [ ] **Step 2: Run the class and watch the new facts fail**

```bash
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -v q
cd src/tests/BaseApi.Tests/bin/Debug/net8.0 && ./BaseApi.Tests.exe --filter-class "BaseApi.Tests.Orchestrator.ExecutionRoundTripTests"
```

Expected: `AFailedStepsSuccessorReceivesNoData…` fails (the dispatch carries a minted key holding
`Output`), and `…NeverReadsTheBlob` fails (`StringGetAsync` was received). The other three may
already pass, because they pin behaviour that must not regress.

- [ ] **Step 3: Implement the guard**

In `StepOutcomeHandler.cs`, replace:

```csharp
        var data = m.EntryId == Guid.Empty
            ? []
            : await ReadAsync(m.EntryId).ConfigureAwait(false);
```

with:

```csharp
        // ONLY A COMPLETED OUTCOME'S BLOB IS DATA (spec D6). A Failed or Cancelled outcome names the
        // step's input purely so it can be reclaimed; its successors run on empty data. The existence
        // check replaces the read as the duplicate guard, and the delete stays LAST, after every
        // hand-off: a hand-off that fails is redelivered and must still find the key, or the
        // successors would never be dispatched.
        byte[]? data;
        if (m.EntryId == Guid.Empty)
        {
            data = [];
        }
        else if (m.Result == StepResult.Completed)
        {
            data = await ReadAsync(m.EntryId).ConfigureAwait(false);
        }
        else
        {
            data = await ExistsAsync(m.EntryId).ConfigureAwait(false) ? [] : null;
        }
```

Add beside `ReadAsync`:

```csharp
    /// <summary>
    /// Whether a Failed or Cancelled outcome's input key is still present. Absent means an earlier
    /// delivery of this outcome already advanced and reclaimed it.
    /// </summary>
    private async Task<bool> ExistsAsync(Guid entryId)
    {
        _logger.LogDebug("checking the finished step's input is still in L2");

        return await _redis.GetDatabase()
            .KeyExistsAsync(L2ProjectionKeys.ExecutionData(entryId))
            .ConfigureAwait(false);
    }
```

In the comment directly above the replaced lines, which begins `// Guid.Empty is not a key. It
arrives on three shapes the processor produces`, replace the list of shapes with: "a source step's
Failed or Cancelled outcome, an output that failed its schema, and a branch sent with no data."

- [ ] **Step 4: Run the orchestrator classes**

```bash
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -v q
cd src/tests/BaseApi.Tests/bin/Debug/net8.0
./BaseApi.Tests.exe --filter-class "BaseApi.Tests.Orchestrator.ExecutionRoundTripTests"
./BaseApi.Tests.exe --filter-class "BaseApi.Tests.Orchestrator.StepOutcomeL1MissTests"
./BaseApi.Tests.exe --filter-class "BaseApi.Tests.Orchestrator.StepAdvancementTests"
```

Expected: 0 failed.

- [ ] **Step 5: Commit**

```bash
git add src/Orchestrator src/tests/BaseApi.Tests/Orchestrator
git commit -m "fix(orchestrator): a failed or cancelled step hands on nothing and is guarded by existence

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: The readers of these records learn the new shape

**Files:**
- Modify: `tools/classification-fixture.json` (doc `13-processor-terminal-completed`)
- Modify: `tools/verify-kibana-dashboard.py` (`check_5_one_witness_per_step`, ~lines 323-374; module docstring lines ~22-23)
- Modify: `kibana/kibana-export.ndjson` (object `skp-runposition-pie`, `attributes.description`)
- Modify: `src/Processor.Analyst/Panels/PanelRegistry.cs:464-469` (run-boundaries description)
- Test: `src/tests/BaseApi.Tests/Analyst/PanelTrustTests.cs` (run the class; no edit expected)

**Interfaces:**
- Consumes: the record shapes from Tasks 1-5. The exporter's Completed is
  `ProcessedDataHandler` / `branch completed in {ElapsedMs}ms` with no `EntryId`. kafka-importer
  outcomes carry no `EntryId`. An empty poll produces an orchestrator terminal with `Result=Cancelled`.

- [ ] **Step 1: Replace fixture doc 13**

In `tools/classification-fixture.json`, replace the whole `13-processor-terminal-completed` object
with:

```json
    { "id": "13-exporter-no-data-completed", "counted": true,
      "why": "The sink's own success after 2026-09-29: kafka-exporter reports Completed through a branch with no data, so the record comes from the post handler like every other step. Its EntryId is Guid.Empty, which ExecutionLogScope omits, so check 5 accepts it as a skip for this processor",
      "_source": {
        "scope": { "name": "BaseProcessor.Core.Processing.ProcessedDataHandler" },
        "resource": { "attributes": { "service.name": "kafka-exporter" } },
        "attributes": { "Result": "Completed",
          "{OriginalFormat}": "branch completed in {ElapsedMs}ms",
          "WorkflowId": "1a56b3ca-e276-4815-87fa-5c2f48ab6dad",
          "StepId": "eb707c5e-24af-4d99-8c97-f127b560e4b4",
          "ProcessorId": "157a0f40-0000-4000-8000-000000000001" } } },
```

Check the fixture's header text (if it says "twelve-and-one" or counts documents) and whether
check 10's docstring counts documents. The number of docs is unchanged, so the counts stay.

- [ ] **Step 2: Let check 5 accept the two expected skips**

In `check_5_one_witness_per_step`, change the `no_entry` aggregation to split by service instead
of step:

```python
            "no_entry": {"filter": {"bool": {"must_not": [{"exists": {"field": "attributes.EntryId"}}]}},
                         "aggs": {"services": {"terms": {"field": "resource.attributes.service.name",
                                                         "size": 20}}}},
```

Add a module-level constant next to the other constants near the top of the file:

```python
# Processors whose counted records legitimately carry no EntryId since 2026-09-29: a source step's
# dispatch has no input key, and the exporter reports Completed through a branch with no data.
EXPECTED_ENTRYLESS = {"kafka-importer", "kafka-exporter"}
```

Replace the lines from `skipped = result["aggregations"]["no_entry"]["doc_count"]` through the
function's final `return` with:

```python
        skipped = result["aggregations"]["no_entry"]["doc_count"]
        skip_services = {b["key"]: b["doc_count"]
                         for b in result["aggregations"]["no_entry"]["services"]["buckets"]}
    except Exception as exc:  # noqa: BLE001
        return checks.report(5, "One witness per step", False, f"{type(exc).__name__}: {exc}")

    unexpected = {s: n for s, n in skip_services.items() if s not in EXPECTED_ENTRYLESS}
    detail = (f"{checked} records checked, {skipped} skipped for want of an EntryId "
              f"({skip_services or 'none'})")
    if offenders:
        sample = [(b["key"], b["doc_count"]) for b in offenders[:3]]
        return checks.report(5, "One witness per step", False,
                             f"{len(offenders)} duplicated triple(s), e.g. {sample} - {detail}")
    # Skips are expected from the importer (source step) and the exporter (no-data branch) only. A
    # skip from anything else means a new entry-less outcome shape was introduced, and the operator
    # notes need to say so.
    return checks.report(5, "One witness per step", not unexpected,
                         f"no duplicated triple - {detail}"
                         + (f"; UNEXPECTED entry-less records from {unexpected}" if unexpected else ""))
```

Rewrite the docstring paragraph "IT NOW COVERS ALL TEN STEPS. …" to: "TWO PROCESSORS ARE SKIPPED BY
DESIGN since 2026-09-29. kafka-importer's outcomes belong to a source step, which has no input key,
and kafka-exporter reports Completed through a branch with no data. ExecutionLogScope omits an empty
EntryId, so neither can join the triple. Any other processor appearing among the skips fails the
check." In the module docstring, replace the bullet "Check 5 reaches 10 of 10 steps rather than 8,
because a terminal step now reports its own outcome and carries an EntryId." with "Check 5 skips
kafka-importer and kafka-exporter by design (no input key and a no-data branch) and fails on any
other entry-less record."

Syntax check:

```bash
python -m py_compile tools/verify-kibana-dashboard.py && python -c "import json;json.load(open('tools/classification-fixture.json',encoding='utf-8'))" && echo ok
```

Expected: `ok`.

- [ ] **Step 3: Rewrite the pie's drained-poll sentence**

`kibana/kibana-export.ndjson` holds one JSON object per line, so edit it with a script, not by hand.
Save this as `tools/_tmp_pie.py`, run it, then delete it:

```python
import json
p = "kibana/kibana-export.ndjson"
old = ("A drained poll is a real fire that legitimately produces no terminal: the importer found "
       "nothing to read, opened no lineage, and correctly did nothing. Those push the entry share up "
       "without anything being wrong.")
new = ("A drained poll is a fire that ends at once: the importer found nothing to read and reported "
       "Cancelled, and that outcome is the fire's terminal. An idle feed therefore pulls the split "
       "toward 1:1, not toward entry-only, and its terminals show as Cancelled in the outcome pie "
       "beside it. An entry share with no matching terminal is never an empty feed.")
lines = open(p, encoding="utf-8").read().split("\n")
hit = 0
for i, line in enumerate(lines):
    if not line.strip():
        continue
    o = json.loads(line)
    if o.get("id") == "skp-runposition-pie":
        d = o["attributes"]["description"]
        assert d.count(old) == 1, "pie description text moved; re-read it before editing"
        o["attributes"]["description"] = d.replace(old, new)
        lines[i] = json.dumps(o, ensure_ascii=False)
        hit += 1
assert hit == 1
open(p, "w", encoding="utf-8", newline="\n").write("\n".join(lines))
print("ok")
```

```bash
python tools/_tmp_pie.py && rm tools/_tmp_pie.py && git diff --stat kibana/kibana-export.ndjson
```

Expected: `ok`, and exactly one line changed. If `git diff` shows the line changed in more than the
description (key order, escapes), `json.dumps` re-serialized it differently from the original. In
that case, discard the change (`git checkout kibana/kibana-export.ndjson`) and do a plain string
replace of `old` → `new` on the raw line text instead of round-tripping it through `json`. Both
strings contain no characters that JSON escapes, so they appear verbatim in the raw line.

- [ ] **Step 4: Rewrite the Analyst panel's drained-poll guidance**

In `PanelRegistry.cs`, in the `run-boundaries` `Description`, replace these string fragments:

```csharp
                "BEFORE REPORTING THAT, CHECK drainedPolls. An importer that read no records opens " +
                "no lineage and correctly produces no terminal, so a fire it drove could not have " +
                "ended and its absence is not loss. drainedPolls out of importerPolls is how many " +
                "fires were no-ops. If drainedPolls accounts for the missing terminals, the " +
                "workflow is idle for want of input, which is not a defect and not a finding; if " +
                "terminals are missing BEYOND what drainedPolls explains, work is being lost. " +
```

with:

```csharp
                "drainedPolls out of importerPolls is how many fires found nothing to read. Such a " +
                "fire is NOT missing a terminal: the importer reports Cancelled, which the " +
                "orchestrator records as that fire's terminal, so an idle workflow sits near 1:1 " +
                "rather than at terminal zero. Never explain missing terminals with drainedPolls; " +
                "a fire with no terminal is work that started and did not finish. " +
```

The query and the reported fields do not change, so `ElasticPanelSource` and `RehearsalPanels` need
no edit. The rehearsal's quiet reading `{"entry":30,"terminal":30,"drainedPolls":0}` is consistent
with the new text.

- [ ] **Step 5: Run the Analyst classes**

```bash
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -v q
cd src/tests/BaseApi.Tests/bin/Debug/net8.0
./BaseApi.Tests.exe --filter-class "BaseApi.Tests.Analyst.PanelTrustTests"
./BaseApi.Tests.exe --filter-namespace "BaseApi.Tests.Analyst"
```

Expected: 0 failed. If a test pins the description text (search with
`grep -rn "drainedPolls accounts" src/tests`), update its expected string to the new wording.

- [ ] **Step 6: Commit**

```bash
git add tools/classification-fixture.json tools/verify-kibana-dashboard.py kibana/kibana-export.ndjson src/Processor.Analyst/Panels/PanelRegistry.cs src/tests/BaseApi.Tests/Analyst
git commit -m "fix(kibana): an empty poll now ends as a Cancelled terminal, and two processors are entry-less by design

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Housekeeping and the hermetic gate

**Files:**
- Modify: `src/Processor.FileFetcher/FileFetcherProcessor.cs:10-12`
- Modify: `src/Processor.ArchiveExpander/ArchiveExpanderProcessor.cs:10-12` and `:45`
- Modify: `src/Processor.ArchiveExpander/Extractors/ArchiveExtractionException.cs:20-21`
- Modify: `src/Processor.ArchiveCollapser/ArchiveCollapserProcessor.cs:11-12`
- Modify: `src/Processor.FilePersister/FilePersisterProcessor.cs:12` (the file contains non-UTF-8
  bytes, so use the Edit tool on the exact line, never sed)
- Modify: `src/Processor.OutcomeRecorder/OutcomeRecorderProcessor.cs:49-50`
- Modify: `src/tests/BaseApi.Tests/OutcomeRecorder/ProcessorOutcomeRecorderTests.cs:97-98`
- Modify: `src/tests/BaseApi.Tests/Live/OutcomeRecorder/OutcomeRecorderLiveTests.cs:185-186, 333-334, 512-518`
- Modify: `docs/superpowers/specs/2026-09-29-remove-edge-bases-design.md` (status line)

- [ ] **Step 1: Reword the comments**

Apply these replacements, which change comments only:

- FileFetcher, ArchiveExpander, ArchiveCollapser, FilePersister: replace
  `so it is not an edge and neither <c>BaseImporter</c> nor <c>BaseExporter</c> applies.` (it may
  wrap across two `///` lines) with `and it sends one branch per input.`
- ArchiveExpander `:45`: replace `exactly as BaseExporter's sinks wrap theirs into ExportSinkException,
  because` with `so the caller catches one type, because`.
- ArchiveExtractionException `:20-21`: replace `That is the same shape <c>BaseExporter</c> already
  uses for <c>ExportSinkException</c>: the adapter knows its library, the caller knows only the
  seam.` with `The adapter knows its library; the caller knows only this type.`
- OutcomeRecorder `:49-50`: replace `where BaseExporter's first guard throws -- "it ends a lineage and
  cannot open one".` with `where kafka-exporter refuses a dispatch with no execution id.`
- ProcessorOutcomeRecorderTests `:97-98`: replace `trips BaseExporter's edge guard, so an importer's
  outcome would never be exported.` with `is refused by kafka-exporter for having no execution id,
  so an importer's outcome would never be exported.`
- OutcomeRecorderLiveTests: replace `<c>BaseImporter.ProcessAsync</c>'s ordinary` with
  `<c>KafkaImporterProcessor.ProcessAsync</c>'s ordinary`, replace `by BaseImporter.ProcessAsync)`
  with `by KafkaImporterProcessor.ProcessAsync)`, and in the 512-518 block replace every
  `BaseImporter` with `KafkaImporterProcessor` and `src/BaseProcessor.Core/Edge/BaseImporter.cs` with
  `src/Processor.KafkaImporter/KafkaImporterProcessor.cs`. The quoted messages
  (`was not ready within`, `opening … failed`) are still accurate, because Task 3 kept them.

Then confirm:

```bash
grep -rn "BaseImporter\|BaseExporter\|EndsLineage\|MaySendNoBranch\|ExportSinkException\|ImportSourceException" --include=*.cs src | grep -v "/obj/\|/bin/\|BaseExporter<Metric>"
```

Expected: no output. The excluded `BaseExporter<Metric>` hits (ConsoleObservabilityTests,
BoundaryCapturingExporter, ExportedSeriesExporter) are OpenTelemetry's type and stay.

- [ ] **Step 2: Full hermetic run**

```bash
bash scripts/pack-all.sh
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -v q
cd src/tests/BaseApi.Tests/bin/Debug/net8.0 && ./BaseApi.Tests.exe
```

Expected: **0 failed, exit 0**, with every skip under `Live/`. If a failure names a test this plan
did not touch, read it before changing anything. Any test asserting that an importer returns
silently on an empty poll, or that a Failed outcome's successor receives the failed step's data, is
a stale expectation of the old behaviour. Update it to the spec. Anything else is a real
regression, so stop and diagnose (superpowers:systematic-debugging).

- [ ] **Step 3: Mark the spec implemented**

In the spec, change the status line to
`Status: implemented on feature/remove-edge-bases 2026-09-29; rollout deferred to the combined rebuild with log-entity-names.`

- [ ] **Step 4: Commit**

```bash
git add -A src docs/superpowers/specs/2026-09-29-remove-edge-bases-design.md
git commit -m "docs: retire the edge-base references and mark the spec implemented

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Rollout (not part of this plan)

This happens with the log-entity-names change, in one cycle:
1. Rebuild every processor and the orchestrator, `kind load`, and repoint each SourceHash.
2. Import `kibana/kibana-export.ndjson` by API.
3. Run `tools/verify-kibana-dashboard.py` against the live forwards. Check 5 must pass with skips
   from only the two Kafka processors.
4. Watch one idle `kafka-importer` fire end as a Cancelled terminal.
