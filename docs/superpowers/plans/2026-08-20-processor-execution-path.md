# Processor Execution Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a processor execute work — consume a dispatch, validate its input, run the author's
transform, persist the output, and report the outcome to the orchestrator — with redelivery as the
only recovery mechanism.

**Architecture:** One queue per processor carries two message kinds routed by the AMQP type header.
The pre handler reads and validates the input and calls the author's `ProcessAsync`, which sends
0..N branches to the post handler; the post handler reclaims the input key, validates the output,
writes it, and emits the result. Pre never mutates the projection store, so any failure before its
ack leaves a redelivery everything it needs. Message ids are derived rather than random, which is
what makes a replayed branch land on the key it landed on the first time.

**Tech Stack:** .NET 8, RabbitMQ.Client 7, StackExchange.Redis, JsonSchema.Net, xunit.v3 under the
Microsoft Testing Platform runner, NSubstitute.

**Spec:** `docs/superpowers/specs/2026-08-20-base-processor-consumers-design.md` — §3 through §9.

**Depends on:** `2026-08-20-consumer-prerequisites.md`. Every task here assumes
`TransientSendException`, `SendTransientAsync`, `DeliveryClassifier` and the ported
`BaseConsole.Core` gating stack already exist. Do not start until that plan's "Done When" holds.

## Global Constraints

- **Target framework:** `net8.0`. No language or BCL feature above C# 12.
- **`--filter` is silently ignored** by this repo's test runner. Run the whole project and read the
  summary; use `--filter-method` if you need one test.
- **Baseline entering this plan:** 176 tests — 170 pass, 6 `Live/` tests skip without `SKP_REALSTACK`,
  exit 0.
- **Never log a payload, a config, or processed data.** Ids and outcomes only. A deserialize
  `JsonException` quotes the offending fragment of the payload in its message, so its text must never
  reach a log template or the wire.
- **Never interpolate an id into a log template.** `$"hop {id}"` renders a string and produces zero
  attributes. Ids are structured `{Placeholder}` arguments or scope values under a fixed key.
- **Rendering is fixed:** `CorrelationId` renders `ToString("N")`; `WorkflowId`, `StepId`,
  `ProcessorId`, `ExecutionId`, `EntryId` render `ToString("D")`. Spec §9.3.
- **Log attribute keys are PascalCase.** If metrics are added later they use camelCase — two
  conventions, kept apart.
- **Prefetch stays at 1.** Per-dispatch state lives in plain fields on a singleton processor, which is
  only safe because one dispatch runs at a time. Do not raise it. Spec §2.2.
- **`Messaging.Contracts` stays BCL-only.** No broker, Redis, or DI package references.

---

## File Structure

**Task 1 — contracts, queue names, log-scope keys**
- Modify `src/Messaging.Contracts/MessageTypes.cs`, `ProcessorQueues.cs`
- Create `src/Messaging.Contracts/Execution.cs` — the five records
- Create `src/Messaging.Contracts/ExecutionLogScope.cs`, `CorrelationKeys.cs`
- Test `src/tests/BaseApi.Tests/Processor/ExecutionContractsTests.cs`

**Task 2 — deterministic ids**
- Create `src/Messaging.Contracts/DeterministicId.cs`
- Test `src/tests/BaseApi.Tests/Processor/DeterministicIdTests.cs`

**Task 3 — schema validator**
- Create `src/BaseProcessor.Core/Validation/ProcessorJsonSchemaValidator.cs`
- Test `src/tests/BaseApi.Tests/Processor/ProcessorJsonSchemaValidatorTests.cs`

**Task 4 — author-facing types**
- Create `src/BaseProcessor.Core/Configuration/ProcessorConfig.cs`
- Create `src/BaseProcessor.Core/Processing/ProcessStatusException.cs`, `PostSendException.cs`

**Task 5 — the seam**
- Create `src/BaseProcessor.Core/Processing/DispatchState.cs`, `BaseProcessor.cs`, `BaseProcessorOfT.cs`
- Test `src/tests/BaseApi.Tests/Processor/BaseProcessorSeamTests.cs`

**Task 6 — pre handler**
- Create `src/BaseProcessor.Core/Processing/ProcessDispatchHandler.cs`
- Test `src/tests/BaseApi.Tests/Processor/ProcessDispatchHandlerTests.cs`

**Task 7 — post handler**
- Create `src/BaseProcessor.Core/Processing/ProcessedDataHandler.cs`
- Test `src/tests/BaseApi.Tests/Processor/ProcessedDataHandlerTests.cs`

**Task 8 — topology, enricher, wiring**
- Create `src/BaseProcessor.Core/Messaging/ProcessorTopology.cs`
- Create `src/BaseProcessor.Core/Observability/ProcessorIdLogEnricher.cs`
- Modify `src/BaseProcessor.Core/DependencyInjection/BaseProcessorServiceCollectionExtensions.cs`
- Test `src/tests/BaseApi.Tests/Processor/ProcessorTopologyTests.cs`

**Task 9 — the sample**
- Create `src/Processor.Sample/SampleConfig.cs`, `SampleProcessor.cs`
- Modify `src/Processor.Sample/ProcessorHost.cs`
- Test `src/tests/BaseApi.Tests/Sample/SampleProcessorTests.cs`

---

### Task 1: Contracts, queue names, and log-scope keys

Five wire records, their type discriminators, the per-processor queue names, and the log-scope key
constants. All pure declarations, so they land together.

**Files:**
- Create: `src/Messaging.Contracts/Execution.cs`
- Create: `src/Messaging.Contracts/ExecutionLogScope.cs`
- Create: `src/Messaging.Contracts/CorrelationKeys.cs`
- Modify: `src/Messaging.Contracts/MessageTypes.cs`
- Modify: `src/Messaging.Contracts/ProcessorQueues.cs`
- Modify: `src/BaseApi.Core/Middleware/CorrelationIdMiddleware.cs:44` (use the shared constant)
- Test: `src/tests/BaseApi.Tests/Processor/ExecutionContractsTests.cs`

**Interfaces:**
- Consumes: `Messaging.Contracts.MessagingJson.Options` — existing.
- Produces:
  - `ProcessDispatch(Guid WorkflowId, Guid StepId, Guid ProcessorId)` with `init` members `Guid CorrelationId`, `Guid ExecutionId`, `Guid EntryId`, `string Payload`.
  - `ProcessedData(Guid WorkflowId, Guid StepId, Guid ProcessorId)` with `init` members `Guid CorrelationId`, `Guid ExecutionId`, `Guid MessageId`, `Guid EntryId`, `byte[] Data`.
  - `StepCompleted` / `StepFailed` / `StepCancelled`, each `(Guid WorkflowId, Guid StepId, Guid ProcessorId)` with `Guid CorrelationId`, `Guid ExecutionId`, `Guid EntryId`; plus `string ErrorMessage` on failed and `string CancellationMessage` on cancelled.
  - `MessageTypes.ProcessDispatch`/`ProcessedData`/`StepCompleted`/`StepFailed`/`StepCancelled`.
  - `ProcessorQueues.Work(Guid)`, `ProcessorQueues.Dead(Guid)`, `ProcessorQueues.DeadLetterExchange`.
  - `ExecutionLogScope.BuildState(Guid workflowId, Guid stepId, Guid processorId, Guid executionId, Guid entryId)` returning `Dictionary<string, object>`; key constants `WorkflowId`, `StepId`, `ProcessorId`, `ExecutionId`, `EntryId`.
  - `CorrelationKeys.LogScope`, `CorrelationKeys.Render(Guid)`.

- [ ] **Step 1: Write the failing test**

Create `src/tests/BaseApi.Tests/Processor/ExecutionContractsTests.cs`:

```csharp
using System.Text.Json;
using Messaging.Contracts;
using Xunit;

namespace BaseApi.Tests.Processor;

public sealed class ExecutionContractsTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");

    [Fact]
    public void ADispatchSurvivesARoundTripThroughTheSharedSerializer()
    {
        var sent = new ProcessDispatch(W, S, P)
        {
            CorrelationId = Guid.Parse("44444444-4444-4444-4444-444444444444"),
            ExecutionId = Guid.Empty,
            EntryId = Guid.Parse("55555555-5555-5555-5555-555555555555"),
            Payload = """{"Number":5}""",
        };

        var bytes = JsonSerializer.SerializeToUtf8Bytes(sent, MessagingJson.Options);
        var back = JsonSerializer.Deserialize<ProcessDispatch>(bytes, MessagingJson.Options);

        Assert.Equal(sent, back);
    }

    [Fact]
    public void ProcessedDataCarriesItsBytesUnchanged()
    {
        // Data is the ground truth the post handler writes to L2. A round trip that alters a byte
        // would corrupt every downstream step with nothing to show for it.
        var payload = new byte[] { 0x7b, 0x22, 0x61, 0x22, 0x3a, 0x31, 0x7d };
        var sent = new ProcessedData(W, S, P) { MessageId = Guid.NewGuid(), Data = payload };

        var bytes = JsonSerializer.SerializeToUtf8Bytes(sent, MessagingJson.Options);
        var back = JsonSerializer.Deserialize<ProcessedData>(bytes, MessagingJson.Options);

        Assert.Equal(payload, back!.Data);
    }

    [Fact]
    public void QueueNamesAreDerivedFromTheProcessorId()
    {
        Assert.Equal("processor-33333333-3333-3333-3333-333333333333", ProcessorQueues.Work(P));
        Assert.Equal("processor-33333333-3333-3333-3333-333333333333.dead", ProcessorQueues.Dead(P));
    }

    [Fact]
    public void EveryWireTypeIsDistinct()
    {
        string[] types =
        [
            MessageTypes.ProcessDispatch, MessageTypes.ProcessedData,
            MessageTypes.StepCompleted, MessageTypes.StepFailed, MessageTypes.StepCancelled,
        ];

        Assert.Equal(types.Length, types.Distinct(StringComparer.Ordinal).Count());
    }

    [Fact]
    public void TheLogScopeCarriesEveryPopulatedId()
    {
        var state = ExecutionLogScope.BuildState(W, S, P, Guid.Parse("66666666-6666-6666-6666-666666666666"),
                                                 Guid.Parse("77777777-7777-7777-7777-777777777777"));

        Assert.Equal(5, state.Count);
        Assert.Equal("11111111-1111-1111-1111-111111111111", state[ExecutionLogScope.WorkflowId]);
    }

    [Fact]
    public void AnEmptyIdIsOmittedRatherThanRenderedAsZeros()
    {
        // An entry dispatch has no ExecutionId and a source step has no EntryId. Emitting all-zeros
        // would make "absent" and "the zero guid" indistinguishable to anything querying these logs.
        var state = ExecutionLogScope.BuildState(W, S, P, Guid.Empty, Guid.Empty);

        Assert.False(state.ContainsKey(ExecutionLogScope.ExecutionId));
        Assert.False(state.ContainsKey(ExecutionLogScope.EntryId));
        Assert.Equal(3, state.Count);
    }

    [Fact]
    public void TheCorrelationIdRendersTheWayTheHttpMiddlewareRendersIt()
    {
        // The middleware mints Guid.NewGuid().ToString("N") and echoes it in X-Correlation-Id. A bus
        // side rendering the default "D" would put two spellings of one id on one Elasticsearch field,
        // and a query joining an HTTP request to its bus work would silently return nothing.
        var id = Guid.Parse("44444444-4444-4444-4444-444444444444");

        Assert.Equal("44444444444444444444444444444444", CorrelationKeys.Render(id));
        Assert.Equal("CorrelationId", CorrelationKeys.LogScope);
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: **build failure** — none of these types exist.

- [ ] **Step 3: Write the five records**

Create `src/Messaging.Contracts/Execution.cs`:

```csharp
namespace Messaging.Contracts;

/// <summary>
/// Orchestrator to processor: run one step. Sent to <see cref="ProcessorQueues.Work"/>.
/// <para>
/// <b>There is no message id, deliberately.</b> The pre hop needs no delivery identity of its own —
/// it writes nothing and reclaims nothing, so there is no key to be stable about. The identity that
/// matters is minted when the author sends to post, where it becomes an L2 key.
/// </para>
/// <para>
/// <see cref="EntryId"/> is the L2 key holding this step's input, or <see cref="Guid.Empty"/> for a
/// source step, which has no upstream input and produces its own. <see cref="Payload"/> is the step's
/// processor config as JSON, already validated against the config schema when the workflow was
/// created.
/// </para>
/// </summary>
public sealed record ProcessDispatch(Guid WorkflowId, Guid StepId, Guid ProcessorId)
{
    public Guid CorrelationId { get; init; }
    public Guid ExecutionId   { get; init; }
    public Guid EntryId       { get; init; }
    public string Payload     { get; init; } = "";
}

/// <summary>
/// Processor to itself: one branch of output, ready to be validated, persisted and reported.
/// <para>
/// <b><see cref="MessageId"/> rides the body, and that is what makes redelivery safe.</b> RabbitMQ
/// never assigns a message id — the AMQP property is producer-set — so a body field is the only
/// carrier that survives a NACK-requeue byte-identical. The post handler writes to the key this id
/// names, which turns a replayed delivery into a rewrite of the same bytes rather than a second blob.
/// </para>
/// <para>
/// <see cref="EntryId"/> is the input key the post handler reclaims. It is carried here rather than
/// deleted by the pre handler because pre must leave the input intact for any redelivery of itself.
/// </para>
/// </summary>
public sealed record ProcessedData(Guid WorkflowId, Guid StepId, Guid ProcessorId)
{
    public Guid CorrelationId { get; init; }
    public Guid ExecutionId   { get; init; }
    public Guid MessageId     { get; init; }
    public Guid EntryId       { get; init; }
    public byte[] Data        { get; init; } = [];
}

/// <summary>
/// A step produced output. <see cref="EntryId"/> is the output key — the
/// <see cref="ProcessedData.MessageId"/> the post handler just wrote — which the orchestrator
/// relocates into one input key per successor.
/// </summary>
public sealed record StepCompleted(Guid WorkflowId, Guid StepId, Guid ProcessorId)
{
    public Guid CorrelationId { get; init; }
    public Guid ExecutionId   { get; init; }
    public Guid EntryId       { get; init; }
}

/// <summary>
/// A step failed. No output key, so <see cref="EntryId"/> stays <see cref="Guid.Empty"/>.
/// <para>
/// <b><see cref="ErrorMessage"/> carries author text only.</b> A message the author wrote is
/// intentional and safe. A framework-caught exception's message is not: a deserialize
/// <c>JsonException</c> quotes the offending fragment of the payload — path, line, token — so putting
/// it here would leak payload content into the orchestrator's projections. Framework failures send a
/// fixed constant and log the detail locally.
/// </para>
/// </summary>
public sealed record StepFailed(Guid WorkflowId, Guid StepId, Guid ProcessorId)
{
    public Guid CorrelationId  { get; init; }
    public Guid ExecutionId    { get; init; }
    public Guid EntryId        { get; init; } = Guid.Empty;
    public string ErrorMessage { get; init; } = "";
}

/// <summary>
/// A step ended its branch and said so. Distinct from ending silently, which is also legitimate: this
/// exists for the case where a successor gated on a cancelled predecessor needs to know.
/// </summary>
public sealed record StepCancelled(Guid WorkflowId, Guid StepId, Guid ProcessorId)
{
    public Guid CorrelationId         { get; init; }
    public Guid ExecutionId           { get; init; }
    public Guid EntryId               { get; init; } = Guid.Empty;
    public string CancellationMessage { get; init; } = "";
}
```

- [ ] **Step 4: Add the wire constants and queue names**

Append inside the class in `src/Messaging.Contracts/MessageTypes.cs`:

```csharp
    /// <summary>Body is a <see cref="Messaging.Contracts.ProcessDispatch"/>.</summary>
    public const string ProcessDispatch = "process-dispatch";

    /// <summary>Body is a <see cref="Messaging.Contracts.ProcessedData"/>.</summary>
    public const string ProcessedData = "processed-data";

    /// <summary>Body is a <see cref="Messaging.Contracts.StepCompleted"/>.</summary>
    public const string StepCompleted = "step-completed";

    /// <summary>Body is a <see cref="Messaging.Contracts.StepFailed"/>.</summary>
    public const string StepFailed = "step-failed";

    /// <summary>Body is a <see cref="Messaging.Contracts.StepCancelled"/>.</summary>
    public const string StepCancelled = "step-cancelled";
```

Append inside the class in `src/Messaging.Contracts/ProcessorQueues.cs`:

```csharp
    /// <summary>
    /// The per-processor work queue, carrying both dispatches and processed-data branches routed by
    /// the type header. Named rather than a bare GUID: every other queue here is a readable
    /// short-name, and a bare GUID is unidentifiable in the broker's management UI.
    /// </summary>
    public static string Work(Guid processorId) => $"processor-{processorId:D}";

    /// <summary>Where <see cref="Work"/> parks a message it cannot read.</summary>
    public static string Dead(Guid processorId) => $"processor-{processorId:D}.dead";

    /// <summary>
    /// The exchange <see cref="Work"/> names in its <c>x-dead-letter-exchange</c> argument. It must
    /// be declared before the queue that names it: the argument is not validated at declare time, so
    /// a queue pointing at a missing exchange is accepted and silently discards everything it parks.
    /// </summary>
    public const string DeadLetterExchange = "processor-dlx";
```

- [ ] **Step 5: Write the log-scope keys**

Create `src/Messaging.Contracts/ExecutionLogScope.cs`:

```csharp
namespace Messaging.Contracts;

/// <summary>
/// The execution ids as log-scope keys. A key here MUST equal the structured-parameter name any
/// template would use for the same id, so both surface at one <c>attributes.&lt;Key&gt;</c> field
/// through the OpenTelemetry <c>IncludeScopes</c> + <c>ParseStateValues</c> bridge.
/// <para>
/// <b>CorrelationId is deliberately absent.</b> It crosses the HTTP boundary, is echoed to clients in
/// <c>X-Correlation-Id</c>, and must render the way the HTTP middleware renders it — so it keeps its
/// own key and its own renderer in <see cref="CorrelationKeys"/>.
/// </para>
/// </summary>
public static class ExecutionLogScope
{
    public const string WorkflowId  = "WorkflowId";
    public const string StepId      = "StepId";
    public const string ProcessorId = "ProcessorId";
    public const string ExecutionId = "ExecutionId";
    public const string EntryId     = "EntryId";

    /// <summary>
    /// Builds the scope dictionary, omitting every id that is <see cref="Guid.Empty"/>.
    /// <para>
    /// <b>Omitted, not zeroed.</b> An entry dispatch has no execution id and a source step has no
    /// entry id; rendering those as all-zeros would make "this id does not apply" indistinguishable
    /// from "this id is the zero guid" to anything reading the logs. Consumers of these records must
    /// therefore be written for an absent field, not a sentinel value.
    /// </para>
    /// <para>
    /// Ids render <c>"D"</c>, matching the L2 key format so a log value can be pasted into a Redis
    /// lookup unchanged.
    /// </para>
    /// </summary>
    public static Dictionary<string, object> BuildState(
        Guid workflowId, Guid stepId, Guid processorId, Guid executionId, Guid entryId)
    {
        var state = new Dictionary<string, object>(5);
        if (workflowId  != Guid.Empty) state[WorkflowId]  = workflowId.ToString("D");
        if (stepId      != Guid.Empty) state[StepId]      = stepId.ToString("D");
        if (processorId != Guid.Empty) state[ProcessorId] = processorId.ToString("D");
        if (executionId != Guid.Empty) state[ExecutionId] = executionId.ToString("D");
        if (entryId     != Guid.Empty) state[EntryId]     = entryId.ToString("D");
        return state;
    }

    /// <summary>Convenience overload for a dispatch.</summary>
    public static Dictionary<string, object> BuildState(ProcessDispatch d)
        => BuildState(d.WorkflowId, d.StepId, d.ProcessorId, d.ExecutionId, d.EntryId);

    /// <summary>Convenience overload for a processed-data branch.</summary>
    public static Dictionary<string, object> BuildState(ProcessedData p)
        => BuildState(p.WorkflowId, p.StepId, p.ProcessorId, p.ExecutionId, p.EntryId);
}
```

Create `src/Messaging.Contracts/CorrelationKeys.cs`:

```csharp
namespace Messaging.Contracts;

/// <summary>
/// The cross-boundary correlation id: one key, one rendering, on both sides of the HTTP/bus line.
/// <para>
/// <b>The rendering is the whole point.</b> <c>CorrelationIdMiddleware</c> mints
/// <c>Guid.NewGuid().ToString("N")</c> and echoes that exact string to the client. A bus-side scope
/// writing a <see cref="Guid"/> would default to the hyphenated <c>"D"</c> form, putting two
/// spellings of one id on a single Elasticsearch field — so a query joining an HTTP request to the
/// bus work it caused returns nothing, with no error anywhere to suggest why. Every producer renders
/// through <see cref="Render"/>.
/// </para>
/// </summary>
public static class CorrelationKeys
{
    /// <summary>The log-scope key. Must equal the literal the HTTP middleware uses.</summary>
    public const string LogScope = "CorrelationId";

    /// <summary>32 lowercase hex characters, no dashes — the form the middleware puts on the wire.</summary>
    public static string Render(Guid correlationId) => correlationId.ToString("N");
}
```

- [ ] **Step 6: Point the middleware at the shared constant**

In `src/BaseApi.Core/Middleware/CorrelationIdMiddleware.cs`, replace the private constant with the
shared one so the two cannot drift:

```csharp
    private const string HeaderName = "X-Correlation-Id";
    private const string ItemKey = CorrelationKeys.LogScope;
```

Add `using Messaging.Contracts;` to the file's usings.

- [ ] **Step 7: Run the tests to verify they pass**

```bash
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: 183 tests — 177 pass, 6 skip, exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/Messaging.Contracts/Execution.cs \
        src/Messaging.Contracts/ExecutionLogScope.cs \
        src/Messaging.Contracts/CorrelationKeys.cs \
        src/Messaging.Contracts/MessageTypes.cs \
        src/Messaging.Contracts/ProcessorQueues.cs \
        src/BaseApi.Core/Middleware/CorrelationIdMiddleware.cs \
        src/tests/BaseApi.Tests/Processor/ExecutionContractsTests.cs
git commit -m "feat: add the processor execution contracts and log-scope keys"
```

---

### Task 2: Deterministic ids

A replayed dispatch must produce the branch ids it produced the first time, or a partial fan-out
failure forks the workflow instead of repeating it. An author sending three branches whose second
send fails throws, NACKs, and replays the whole invocation — re-sending branch one. With derived ids
that re-send rewrites one key; with random ids it is a second branch.

**Files:**
- Create: `src/Messaging.Contracts/DeterministicId.cs`
- Test: `src/tests/BaseApi.Tests/Processor/DeterministicIdTests.cs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `DeterministicId.From(string purpose, Guid correlationId, Guid stepId, Guid entryId, int sequence)` returning `Guid`.
  - `DeterministicId.MessagePurpose` = `"message"`, `DeterministicId.ExecutionPurpose` = `"execution"`.

- [ ] **Step 1: Write the failing test**

Create `src/tests/BaseApi.Tests/Processor/DeterministicIdTests.cs`:

```csharp
using Messaging.Contracts;
using Xunit;

namespace BaseApi.Tests.Processor;

public sealed class DeterministicIdTests
{
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid E = Guid.Parse("55555555-5555-5555-5555-555555555555");

    [Fact]
    public void TheSameSeedAlwaysProducesTheSameId()
    {
        // This is the property the whole redelivery model rests on: a replayed dispatch writes to the
        // key it wrote the first time, so the second write is a rewrite rather than a second branch.
        var first  = DeterministicId.From(DeterministicId.MessagePurpose, C, S, E, 0);
        var second = DeterministicId.From(DeterministicId.MessagePurpose, C, S, E, 0);

        Assert.Equal(first, second);
    }

    [Fact]
    public void EachBranchInAFanOutGetsItsOwnId()
    {
        var branch0 = DeterministicId.From(DeterministicId.MessagePurpose, C, S, E, 0);
        var branch1 = DeterministicId.From(DeterministicId.MessagePurpose, C, S, E, 1);
        var branch2 = DeterministicId.From(DeterministicId.MessagePurpose, C, S, E, 2);

        Assert.Equal(3, new[] { branch0, branch1, branch2 }.Distinct().Count());
    }

    [Fact]
    public void TheMessageIdAndTheExecutionIdDifferForOneBranch()
    {
        // Both derive from the same seed, so without the purpose discriminator a branch's execution id
        // would equal its message id — two different things silently sharing one value.
        var message   = DeterministicId.From(DeterministicId.MessagePurpose, C, S, E, 0);
        var execution = DeterministicId.From(DeterministicId.ExecutionPurpose, C, S, E, 0);

        Assert.NotEqual(message, execution);
    }

    [Fact]
    public void DifferentHopsProduceDifferentIds()
    {
        var hopA = DeterministicId.From(DeterministicId.MessagePurpose, C, S, E, 0);
        var hopB = DeterministicId.From(DeterministicId.MessagePurpose, C, S,
                                        Guid.Parse("66666666-6666-6666-6666-666666666666"), 0);

        Assert.NotEqual(hopA, hopB);
    }

    [Fact]
    public void TwoSourceStepsInOneWorkflowGetDistinctIds()
    {
        // A source step's EntryId is Guid.Empty, so the step id has to carry the uniqueness between
        // two different source steps firing under one correlation.
        var stepA = DeterministicId.From(DeterministicId.MessagePurpose, C, S, Guid.Empty, 0);
        var stepB = DeterministicId.From(DeterministicId.MessagePurpose, C,
                                         Guid.Parse("77777777-7777-7777-7777-777777777777"), Guid.Empty, 0);

        Assert.NotEqual(stepA, stepB);
    }

    [Fact]
    public void OneSourceStepGetsANewIdOnEveryFiring()
    {
        // The property the type's own doc comment rests on, and the one that actually matters in
        // production: a source step's StepId is fixed by the workflow definition and its EntryId is
        // always Guid.Empty, so the per-fire CorrelationId is the ONLY field distinguishing today's
        // firing from tomorrow's. If it ever stopped feeding the hash, every firing of a source step
        // would write the same key — and each run would silently overwrite the last.
        var firstFiring  = DeterministicId.From(DeterministicId.MessagePurpose, C, S, Guid.Empty, 0);
        var secondFiring = DeterministicId.From(
            DeterministicId.MessagePurpose,
            Guid.Parse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"), S, Guid.Empty, 0);

        Assert.NotEqual(firstFiring, secondFiring);
    }

    [Fact]
    public void NeverProducesTheEmptyGuid()
    {
        // Guid.Empty is a sentinel everywhere in this system — a source step, a step with no output
        // key. A derived id colliding with it would be read as "not applicable".
        var id = DeterministicId.From(DeterministicId.MessagePurpose, Guid.Empty, Guid.Empty, Guid.Empty, 0);

        Assert.NotEqual(Guid.Empty, id);
    }

    [Fact]
    public void IsAWellFormedVersion5Uuid()
    {
        var id = DeterministicId.From(DeterministicId.MessagePurpose, C, S, E, 0);
        var bytes = id.ToByteArray();

        // .NET lays the first three fields out little-endian, so the version nibble lives in byte 7
        // and the variant bits in byte 8 of the in-memory array.
        Assert.Equal(0x50, bytes[7] & 0xF0);
        Assert.Equal(0x80, bytes[8] & 0xC0);
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: **build failure** — `DeterministicId` does not exist.

- [ ] **Step 3: Write the derivation**

Create `src/Messaging.Contracts/DeterministicId.cs`:

```csharp
using System.Security.Cryptography;
using System.Text;

namespace Messaging.Contracts;

/// <summary>
/// Ids derived from what a message already carries, rather than minted at random.
/// <para>
/// <b>This is what makes a replay a repeat instead of a fork.</b> A dispatch whose handling fails
/// after some branches have been sent is returned to the queue and run again from the top. Random ids
/// would make each replayed branch a new branch with a new L2 key, and a partial fan-out failure — an
/// ordinary transient — would multiply the workflow. Derived ids make the replay land on the keys it
/// landed on before, so the writes are rewrites and the orchestrator can recognise the duplicates.
/// </para>
/// <para>
/// <b>The seed must be stable and unique per branch.</b> Correlation id and step id identify the hop;
/// entry id distinguishes hops within a step for a downstream dispatch and is
/// <see cref="Guid.Empty"/> for a source step, where the per-fire correlation id carries the
/// uniqueness instead. The sequence number distinguishes branches within one invocation, which is why
/// an author's fan-out must produce the same branches in the same order every time.
/// </para>
/// <para>
/// Version 5 layout, so these are recognisable as name-derived rather than random to anyone reading a
/// database or a log. The technique is already used in this codebase's Keeper partition keys.
/// </para>
/// </summary>
public static class DeterministicId
{
    /// <summary>Purpose for the id that keys the output blob and identifies the delivery.</summary>
    public const string MessagePurpose = "message";

    /// <summary>Purpose for the id that opens a new execution lineage.</summary>
    public const string ExecutionPurpose = "execution";

    /// <summary>
    /// Derives one id. <paramref name="purpose"/> separates ids built from the same seed — without it
    /// a branch's execution id and its message id would be the same value.
    /// </summary>
    public static Guid From(string purpose, Guid correlationId, Guid stepId, Guid entryId, int sequence)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(purpose);
        ArgumentOutOfRangeException.ThrowIfNegative(sequence);

        // A fixed separator that cannot appear in a Guid's "D" form or in a decimal integer, so two
        // different seeds cannot render to one canonical string.
        var canonical =
            $"{purpose}|{correlationId:D}|{stepId:D}|{entryId:D}|{sequence.ToString(System.Globalization.CultureInfo.InvariantCulture)}";

        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(canonical));

        var bytes = new byte[16];
        Array.Copy(hash, bytes, 16);

        // RFC 4122 version 5 and variant 10x. .NET's Guid(byte[]) reads the first three fields
        // little-endian, so the version nibble is byte 7 and the variant bits are byte 8.
        bytes[7] = (byte)((bytes[7] & 0x0F) | 0x50);
        bytes[8] = (byte)((bytes[8] & 0x3F) | 0x80);

        return new Guid(bytes);
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: 190 tests — 184 pass, 6 skip, exit 0.

If `NeverProducesTheEmptyGuid` fails, the version and variant bits are not being set — `Guid.Empty`
has a zero version nibble, so a correctly stamped id can never equal it.

- [ ] **Step 5: Commit**

```bash
git add src/Messaging.Contracts/DeterministicId.cs \
        src/tests/BaseApi.Tests/Processor/DeterministicIdTests.cs
git commit -m "feat: derive branch ids so a replay repeats instead of forking"
```

---

### Task 3: The schema validator

Ported from `references/src/BaseProcessor.Core/Validation/ProcessorJsonSchemaValidator.cs`. It must
return a bool rather than throw — the API-side validator is an HTTP gate, this one drives a business
outcome — and it must never crash the host on a bad schema definition.

**Files:**
- Create: `src/BaseProcessor.Core/Validation/ProcessorJsonSchemaValidator.cs`
- Modify: `src/BaseProcessor.Core/BaseProcessor.Core.csproj` (add the `JsonSchema.Net` package reference)
- Test: `src/tests/BaseApi.Tests/Processor/ProcessorJsonSchemaValidatorTests.cs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `BaseProcessor.Core.Validation.ProcessorJsonSchemaValidator.TryValidate(string? definition, byte[] data, out IReadOnlyList<string> errors)` returning `bool`.

- [ ] **Step 1: Write the failing test**

Create `src/tests/BaseApi.Tests/Processor/ProcessorJsonSchemaValidatorTests.cs`:

```csharp
using System.Text;
using BaseProcessor.Core.Validation;
using Xunit;

namespace BaseApi.Tests.Processor;

public sealed class ProcessorJsonSchemaValidatorTests
{
    private const string NumberSchema = """
        {"type":"object","properties":{"number":{"type":"integer"}},"required":["number"]}
        """;

    private static byte[] Utf8(string s) => Encoding.UTF8.GetBytes(s);

    [Fact]
    public void NoDefinitionMeansNoValidation()
    {
        // A processor with no input or output schema is a normal configuration, not an error. Bytes
        // stay opaque and are never decoded without a schema to decode them for.
        Assert.True(ProcessorJsonSchemaValidator.TryValidate(null, Utf8("not json at all"), out _));
        Assert.True(ProcessorJsonSchemaValidator.TryValidate("   ", Utf8("not json at all"), out _));
    }

    [Fact]
    public void AcceptsDataThatMatches()
    {
        Assert.True(ProcessorJsonSchemaValidator.TryValidate(NumberSchema, Utf8("""{"number":7}"""), out var errors));
        Assert.Empty(errors);
    }

    [Fact]
    public void RejectsDataThatDoesNotMatchAndSaysWhere()
    {
        Assert.False(ProcessorJsonSchemaValidator.TryValidate(NumberSchema, Utf8("""{"number":"seven"}"""), out var errors));
        Assert.NotEmpty(errors);
    }

    [Fact]
    public void RejectsBytesThatAreNotJson()
    {
        Assert.False(ProcessorJsonSchemaValidator.TryValidate(NumberSchema, Utf8("not json"), out var errors));
        Assert.NotEmpty(errors);
    }

    [Fact]
    public void RejectsAnUnparseableSchemaWithoutCrashing()
    {
        // A malformed definition is a data problem in the schema table, and it must produce a business
        // failure rather than take the host down — the row can be fixed while the processor keeps
        // running.
        Assert.False(ProcessorJsonSchemaValidator.TryValidate("{not a schema", Utf8("""{"number":7}"""), out var errors));
        Assert.NotEmpty(errors);
    }

    [Fact]
    public void RefusesAnExternalReferenceInsteadOfFetchingIt()
    {
        // The global fetcher is disabled, so an external $ref cannot reach the network. It surfaces as
        // a business failure rather than an outbound request from inside a message handler.
        const string remote = """{"$ref":"https://example.invalid/schema.json"}""";

        Assert.False(ProcessorJsonSchemaValidator.TryValidate(remote, Utf8("""{"number":7}"""), out var errors));
        Assert.NotEmpty(errors);
    }

    [Fact]
    public void NoErrorMessageQuotesTheData()
    {
        // Validator messages reach StepFailed and the orchestrator's projections. They may name an
        // instance location, never a value.
        ProcessorJsonSchemaValidator.TryValidate(NumberSchema, Utf8("""{"number":"topsecret"}"""), out var errors);

        Assert.DoesNotContain(errors, e => e.Contains("topsecret", StringComparison.Ordinal));
    }

    public static TheoryData<string, string> LeakyKeywords() => new()
    {
        // Every one of these keywords embeds the offending instance value in the library's own error
        // message — "-999888 should be at least 18", and so on. The `type` case above happens not to,
        // which is exactly why testing only `type` gave false confidence.
        { """{"type":"object","properties":{"n":{"minimum":18}}}""",    """{"n":-999888}""" },
        { """{"type":"object","properties":{"n":{"maximum":18}}}""",    """{"n":777666}"""  },
        { """{"type":"object","properties":{"n":{"multipleOf":5}}}""",  """{"n":123457}"""  },
    };

    [Theory]
    [MemberData(nameof(LeakyKeywords))]
    public void NoErrorMessageQuotesANumericValueEither(string schema, string json)
    {
        // The digits are distinctive so a substring match cannot pass by accident.
        var value = System.Text.RegularExpressions.Regex.Match(json, @"-?\d+").Value;

        Assert.False(ProcessorJsonSchemaValidator.TryValidate(schema, Utf8(json), out var errors));
        Assert.NotEmpty(errors);
        Assert.DoesNotContain(errors, e => e.Contains(value, StringComparison.Ordinal));
    }

    public static TheoryData<string> MalformedSchemasThatAreValidJson() =>
    [
        // Valid JSON, but not a schema. Both of these throw from inside JsonSchema.FromText with
        // exception types the specific catches do not name — a RegexParseException and an
        // ArgumentException respectively. Either escaping would park a message instead of reporting a
        // failed step.
        """{"type":"object","properties":{"a":{"type":"string","pattern":"("}}}""",
        """"just a string"""",
    ];

    [Theory]
    [MemberData(nameof(MalformedSchemasThatAreValidJson))]
    public void ReturnsAVerdictForASchemaThatIsValidJsonButNotAValidSchema(string definition)
    {
        // A malformed row in the schema table is a business failure, never a crash. The row can be
        // fixed while the processor keeps running.
        var thrown = Record.Exception(
            () => ProcessorJsonSchemaValidator.TryValidate(definition, Utf8("""{"a":"x"}"""), out _));

        Assert.Null(thrown);
        Assert.False(ProcessorJsonSchemaValidator.TryValidate(definition, Utf8("""{"a":"x"}"""), out var errors));
        Assert.NotEmpty(errors);
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: **build failure** — `ProcessorJsonSchemaValidator` does not exist.

- [ ] **Step 3: Add the package reference**

Confirm the version is already pinned centrally, then reference it:

```bash
grep -n "JsonSchema.Net" Directory.Packages.props
```

Add to the first `ItemGroup` in `src/BaseProcessor.Core/BaseProcessor.Core.csproj`:

```xml
    <PackageReference Include="JsonSchema.Net" />
```

If `Directory.Packages.props` has no `JsonSchema.Net` entry, add one pinned to the same version
`BaseApi.Service` uses — check with `grep -rn "JsonSchema" src/BaseApi.Service/BaseApi.Service.csproj`.

- [ ] **Step 4: Write the validator**

Create `src/BaseProcessor.Core/Validation/ProcessorJsonSchemaValidator.cs`. This is a port of the
reference file; the shape below is the whole implementation.

```csharp
using System.Text.Json;
using Json.Schema;

namespace BaseProcessor.Core.Validation;

/// <summary>
/// Validates a payload against a schema definition, returning a verdict rather than throwing.
/// <para>
/// <b>A bool, not an exception, because the caller is a message handler.</b> The API-side validator
/// throws to become an HTTP 422; here an invalid payload is an ordinary step outcome that gets
/// reported and acknowledged. Turning it into an exception would put it on the path that parks
/// messages.
/// </para>
/// <para>
/// <b>Outbound reference resolution is disabled process-wide.</b> A schema definition arrives from a
/// database row, so an external <c>$ref</c> would let whoever wrote that row make this process issue
/// requests to a host of their choosing from inside a message handler. With the global fetcher
/// returning null the library raises instead, and that surfaces as a business failure.
/// </para>
/// </summary>
public static class ProcessorJsonSchemaValidator
{
    static ProcessorJsonSchemaValidator()
    {
        Dialect.Default = Dialect.Draft202012;          // the library default is V1, not 2020-12
        SchemaRegistry.Global.Fetch = (_, _) => null;   // no outbound $ref fetch
    }

    /// <summary>
    /// Shared evaluation options.
    /// <para>
    /// The lockdown is guaranteed by this type having an <i>explicit</i> static constructor, which
    /// disables <c>beforefieldinit</c> and so runs before any static member access — including
    /// <see cref="TryValidate"/> itself. Touching this property is not what arms it.
    /// </para>
    /// </summary>
    public static EvaluationOptions DefaultOptions { get; } = new() { OutputFormat = OutputFormat.List };

    /// <summary>
    /// True when <paramref name="data"/> satisfies <paramref name="definition"/>. A null or
    /// whitespace definition skips validation and returns true — bytes are never decoded without a
    /// schema asking for it. Every failure path fills <paramref name="errors"/> and returns false;
    /// <b>none of them throw, for any input.</b>
    /// </summary>
    public static bool TryValidate(string? definition, byte[] data, out IReadOnlyList<string> errors)
    {
        errors = [];

        if (string.IsNullOrWhiteSpace(definition))
        {
            return true;
        }

        // The outer net. The specific catches below produce better diagnostics for the cases worth
        // naming, but the JSON Schema keyword surface is large and each keyword may throw its own
        // type from deep inside the library: a bad `pattern` regex raises RegexParseException from
        // FromText, and a definition that is valid JSON but not an object or boolean at the root
        // raises ArgumentException. Enumerating them is a losing game, and losing it means an
        // exception escapes into a message handler that will then PARK the message instead of
        // reporting a failed step — the one outcome this method exists to prevent. A malformed row in
        // the schema table must always be a business failure, never a crash.
        try
        {
            JsonSchema schema;
            try
            {
                schema = JsonSchema.FromText(definition);
            }
            catch (Exception ex) when (ex is JsonException or JsonSchemaException)
            {
                errors = ["Schema definition is not valid JSON Schema."];
                return false;
            }

            JsonDocument doc;
            try
            {
                doc = JsonDocument.Parse(data);
            }
            catch (JsonException)
            {
                errors = ["Data is not valid JSON/UTF-8."];
                return false;
            }

            using (doc)
            {
                EvaluationResults results;
                try
                {
                    results = schema.Evaluate(doc.RootElement, DefaultOptions);
                }
                catch (JsonSchemaException)
                {
                    // An unresolvable $ref — the lockdown holding, not a fault to crash on.
                    errors = ["Schema definition could not be evaluated (unresolved $ref)."];
                    return false;
                }

                if (results.IsValid)
                {
                    return true;
                }

                errors = Flatten(results);
                return false;
            }
        }
        catch
        {
            errors = ["Schema definition could not be evaluated."];
            return false;
        }
    }

    /// <summary>
    /// Turns a failed evaluation into instance locations and keyword names — and nothing else.
    /// <para>
    /// <b>The library's own error text is deliberately discarded.</b> These strings reach
    /// <c>StepFailed</c> and the orchestrator's projections, and several keywords embed the offending
    /// instance value in their message: <c>minimum</c> renders "-999888 should be at least 18",
    /// <c>maximum</c> and <c>multipleOf</c> likewise. A payload's account balance, age or numeric
    /// token would land in a projection an operator can read. Which keywords do this is a property of
    /// the library version, not of anything we control, so an allow-list of "safe" messages would
    /// need re-auditing on every upgrade. Location plus keyword says where and which rule, is
    /// sufficient to diagnose, and cannot leak by construction.
    /// </para>
    /// </summary>
    private static List<string> Flatten(EvaluationResults results)
    {
        var flat = (results.Details ?? [])
            .Where(d => d.Errors is { Count: > 0 })
            .SelectMany(d => d.Errors!.Select(kv => $"{d.InstanceLocation}: {kv.Key}"))
            .ToList();

        if (flat.Count == 0 && results.Errors is { Count: > 0 })
        {
            flat = results.Errors.Select(kv => $"{results.InstanceLocation}: {kv.Key}").ToList();
        }

        return flat;
    }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: 197 tests — 191 pass, 6 skip, exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/BaseProcessor.Core/Validation/ProcessorJsonSchemaValidator.cs \
        src/BaseProcessor.Core/BaseProcessor.Core.csproj \
        Directory.Packages.props \
        src/tests/BaseApi.Tests/Processor/ProcessorJsonSchemaValidatorTests.cs
git commit -m "feat: validate processor payloads against their schemas"
```

---

### Task 4: Author-facing types

The config marker, the three status exceptions an author throws, and the send exception an author
catches. No behaviour, so no test of their own — Task 5 exercises all four.

**Files:**
- Create: `src/BaseProcessor.Core/Configuration/ProcessorConfig.cs`
- Create: `src/BaseProcessor.Core/Processing/ProcessStatusException.cs`
- Create: `src/BaseProcessor.Core/Processing/PostSendException.cs`

**Interfaces:**
- Consumes: `Messaging.Transport.TransientSendException` (prerequisites plan, Task 1).
- Produces:
  - `BaseProcessor.Core.Configuration.ProcessorConfig` — abstract record, `static JsonSerializerOptions SerializerOptions`.
  - `ProcessStatusException(string message)` abstract, with `FailedException` and `CancelledException`.
  - `PostSendException(Guid messageId, Guid executionId, Exception inner) : TransientSendException` with `Guid MessageId`, `Guid ExecutionId`.

- [ ] **Step 1: Write the config marker**

Create `src/BaseProcessor.Core/Configuration/ProcessorConfig.cs`:

```csharp
using System.Text.Json;

namespace BaseProcessor.Core.Configuration;

/// <summary>
/// The base every author config record derives from. It contributes no fields — it exists so the
/// framework has a type to constrain on, and so the config-schema check has something to reflect over.
/// </summary>
public abstract record ProcessorConfig
{
    /// <summary>
    /// The one deserialization contract for step payloads.
    /// <para>
    /// Case-insensitive, and unknown properties are ignored rather than rejected: a step payload is
    /// authored by whoever built the workflow, and a config gaining a field must not break every
    /// workflow that predates it. That tolerance is the opposite of the wire contract's — see
    /// <c>MessagingJson</c>, where a name that does not bind is a fault to catch, not a field to skip.
    /// </para>
    /// </summary>
    public static readonly JsonSerializerOptions SerializerOptions = new()
    {
        PropertyNameCaseInsensitive = true,
    };
}
```

- [ ] **Step 2: Write the status exceptions**

Create `src/BaseProcessor.Core/Processing/ProcessStatusException.cs`:

```csharp
namespace BaseProcessor.Core.Processing;

/// <summary>
/// An author ending their step with an explicit outcome.
/// <para>
/// <b>Thrown rather than returned, deliberately.</b> <c>ProcessAsync</c> returns nothing — the author
/// sends branches through a helper — so there is no return value left to carry an outcome. A
/// <c>ReportFailure(...)</c> method would also let execution continue afterwards, so an author who
/// forgot to return could report a failure and then send a branch, producing both a failure and a
/// success for one step. Throwing makes the abort structural instead of a discipline to remember.
/// </para>
/// <para>
/// The message reaches the orchestrator verbatim. That is safe precisely because an author wrote it;
/// a framework-caught exception's message never does.
/// </para>
/// </summary>
public abstract class ProcessStatusException(string message) : Exception(message);

/// <summary>The step failed for a business reason. Maps to <c>StepFailed.ErrorMessage</c>.</summary>
public sealed class FailedException(string message) : ProcessStatusException(message);

/// <summary>
/// The step ended its branch and wants the orchestrator told. Maps to
/// <c>StepCancelled.CancellationMessage</c>.
/// <para>
/// Distinct from returning without sending, which is also a legitimate way to end a branch — a sink
/// with no successor, or a filter dropping data. Use this one when a successor gated on a cancelled
/// predecessor needs to know it happened.
/// </para>
/// </summary>
public sealed class CancelledException(string message) : ProcessStatusException(message);
```

- [ ] **Step 3: Write the post-send exception**

Create `src/BaseProcessor.Core/Processing/PostSendException.cs`:

```csharp
using Messaging.Transport;

namespace BaseProcessor.Core.Processing;

/// <summary>
/// A branch could not be handed to the post queue.
/// <para>
/// <b>It carries the branch's ids so an author fanning out can tell which one was lost</b> — that is
/// the only reason it exists rather than the plain <see cref="TransientSendException"/> it derives
/// from. Catching it is a detection point, not a handler: the exception must propagate, because the
/// dispatch has to be redelivered and replayed for the branch to be sent again.
/// </para>
/// <para>
/// <b>Re-throw with a bare <c>throw;</c>.</b> Wrapping it, or throwing a new exception, loses the
/// type — and the consumer classifies on the type. A wrapped one falls through to the generic path,
/// which reports the step as failed and acknowledges the message, so the step is recorded as a
/// business failure while the work is silently lost.
/// </para>
/// </summary>
public sealed class PostSendException : TransientSendException
{
    public PostSendException(Guid messageId, Guid executionId, Exception inner)
        : base($"send of branch {messageId:D} to the post queue failed", inner)
    {
        MessageId = messageId;
        ExecutionId = executionId;
    }

    /// <summary>The branch's derived message id — the L2 key it would have written.</summary>
    public Guid MessageId { get; }

    /// <summary>The branch's execution id, naming the lineage that did not start.</summary>
    public Guid ExecutionId { get; }
}
```

- [ ] **Step 4: Verify the build**

```bash
dotnet build src/BaseProcessor.Core/BaseProcessor.Core.csproj
```

Expected: build succeeds, 0 warnings.

- [ ] **Step 5: Commit**

```bash
git add src/BaseProcessor.Core/Configuration/ProcessorConfig.cs \
        src/BaseProcessor.Core/Processing/ProcessStatusException.cs \
        src/BaseProcessor.Core/Processing/PostSendException.cs
git commit -m "feat: add the author-facing processor types"
```

---

### Task 5: The seam

The abstract processor an author derives from: it holds the current dispatch's ids, derives branch
ids, and sends to the post queue. The generic layer deserializes the payload and calls the author's
typed method.

**Files:**
- Create: `src/BaseProcessor.Core/Processing/DispatchState.cs`
- Create: `src/BaseProcessor.Core/Processing/BaseProcessor.cs`
- Create: `src/BaseProcessor.Core/Processing/BaseProcessorOfT.cs`
- Test: `src/tests/BaseApi.Tests/Processor/BaseProcessorSeamTests.cs`

**Interfaces:**
- Consumes: `ProcessorConfig`, `PostSendException` (Task 4); `DeterministicId`, `ProcessedData`, `MessageTypes`, `ProcessorQueues` (Tasks 1–2); `IQueueSender.SendTransientAsync` (prerequisites plan).
- Produces:
  - `BaseProcessor.Core.Processing.DispatchState(IQueueSender sender, Guid workflowId, Guid stepId, Guid processorId, Guid correlationId, Guid entryId)` with `int NextMessageSequence()`, `int NextExecutionSequence()`.
  - `BaseProcessor` (abstract): `internal abstract Task ExecuteAsync(byte[] data, string payload, Guid executionId, CancellationToken ct)`; `internal void BeginDispatch(DispatchState state)`; `internal void EndDispatch()`; `protected Task SendToPostAsync(byte[] processedData, Guid executionId, CancellationToken ct)`; `protected Guid NewExecutionId()`.
  - `BaseProcessor<TConfig> : BaseProcessor` with `protected abstract Task ProcessAsync(byte[] data, TConfig? config, Guid executionId, CancellationToken ct)`.
- Add `<InternalsVisibleTo Include="BaseApi.Tests" />` to `src/BaseProcessor.Core/BaseProcessor.Core.csproj` so the tests can drive `BeginDispatch`.

- [ ] **Step 1: Write the failing test**

Create `src/tests/BaseApi.Tests/Processor/BaseProcessorSeamTests.cs`:

```csharp
using System.Text;
using BaseProcessor.Core.Configuration;
using BaseProcessor.Core.Processing;
using Messaging.Contracts;
using Messaging.Transport;
using NSubstitute;
using NSubstitute.ExceptionExtensions;
using Xunit;

namespace BaseApi.Tests.Processor;

public sealed class BaseProcessorSeamTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");
    private static readonly Guid E = Guid.Parse("55555555-5555-5555-5555-555555555555");

    private sealed record TwoFieldConfig(int Number, string? Label) : ProcessorConfig;

    /// <summary>A processor whose transform is supplied per test.</summary>
    private sealed class Probe(Func<byte[], TwoFieldConfig?, Guid, Probe, Task> body)
        : BaseProcessor<TwoFieldConfig>
    {
        protected override Task ProcessAsync(
            byte[] data, TwoFieldConfig? config, Guid executionId, CancellationToken ct)
            => body(data, config, executionId, this);

        public Task Send(byte[] data, Guid executionId) => SendToPostAsync(data, executionId, CancellationToken.None);
        public Guid NextExecution() => NewExecutionId();
    }

    private static (Probe Processor, IQueueSender Sender) Build(
        Func<byte[], TwoFieldConfig?, Guid, Probe, Task> body)
    {
        var sender = Substitute.For<IQueueSender>();
        var processor = new Probe(body);
        processor.BeginDispatch(new DispatchState(sender, W, S, P, C, E));
        return (processor, sender);
    }

    [Fact]
    public async Task DeserializesThePayloadIntoTheAuthorsConfigType()
    {
        TwoFieldConfig? seen = null;
        var (processor, _) = Build((_, config, _, _) => { seen = config; return Task.CompletedTask; });

        await processor.ExecuteAsync([], """{"number":5,"label":"Step_A"}""", Guid.Empty, CancellationToken.None);

        Assert.Equal(new TwoFieldConfig(5, "Step_A"), seen);
    }

    [Fact]
    public async Task HandsTheAuthorANullConfigWhenThePayloadIsEmpty()
    {
        // A step with no payload is a normal configuration. Deserializing "" would throw, so the guard
        // runs first and the author sees the absence rather than an exception.
        var sawNull = false;
        var (processor, _) = Build((_, config, _, _) => { sawNull = config is null; return Task.CompletedTask; });

        await processor.ExecuteAsync([], "   ", Guid.Empty, CancellationToken.None);

        Assert.True(sawNull);
    }

    [Fact]
    public async Task StampsTheDispatchIdsOntoEveryBranch()
    {
        ProcessedData? sent = null;
        var (processor, sender) = Build((_, _, _, self) => self.Send(Encoding.UTF8.GetBytes("{}"), E));
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(p => sent = p),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());

        await processor.ExecuteAsync([], "", E, CancellationToken.None);

        Assert.Equal(W, sent!.WorkflowId);
        Assert.Equal(S, sent.StepId);
        Assert.Equal(C, sent.CorrelationId);
        Assert.Equal(E, sent.EntryId);
    }

    [Fact]
    public async Task StampsTheProcessorIdTheDispatchWasOpenedWith()
    {
        // Note what this does NOT prove: DispatchState holds one processor id, so from in here the
        // seam cannot tell "our own identity" from "whatever the inbound message claimed". Which of
        // those the id came from is decided by the caller that opens the dispatch — see the handler
        // task, where a test pins that a dispatch carrying a foreign processor id still produces a
        // branch stamped with ours.
        ProcessedData? sent = null;
        var sender = Substitute.For<IQueueSender>();
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(p => sent = p),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());
        var processor = new Probe((_, _, _, self) => self.Send(Encoding.UTF8.GetBytes("{}"), E));
        processor.BeginDispatch(new DispatchState(sender, W, S, P, C, E));

        await processor.ExecuteAsync([], "", E, CancellationToken.None);

        Assert.Equal(P, sent!.ProcessorId);
    }

    [Fact]
    public async Task GivesEachBranchOfAFanOutItsOwnMessageId()
    {
        var ids = new List<Guid>();
        var sender = Substitute.For<IQueueSender>();
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(p => ids.Add(p.MessageId)),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());
        var processor = new Probe(async (_, _, _, self) =>
        {
            await self.Send(Encoding.UTF8.GetBytes("{}"), E);
            await self.Send(Encoding.UTF8.GetBytes("{}"), E);
            await self.Send(Encoding.UTF8.GetBytes("{}"), E);
        });
        processor.BeginDispatch(new DispatchState(sender, W, S, P, C, E));

        await processor.ExecuteAsync([], "", E, CancellationToken.None);

        Assert.Equal(3, ids.Distinct().Count());
    }

    [Fact]
    public async Task ReplayingADispatchProducesTheSameBranchIds()
    {
        // The property the whole redelivery model rests on: a second run of the same dispatch writes
        // the keys the first run wrote.
        async Task<List<Guid>> RunOnce()
        {
            var ids = new List<Guid>();
            var sender = Substitute.For<IQueueSender>();
            await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(),
                                   Arg.Do<ProcessedData>(p => ids.Add(p.MessageId)),
                                   Arg.Any<CancellationToken>(), Arg.Any<string?>());
            var processor = new Probe(async (_, _, _, self) =>
            {
                await self.Send(Encoding.UTF8.GetBytes("{}"), E);
                await self.Send(Encoding.UTF8.GetBytes("{}"), E);
            });
            processor.BeginDispatch(new DispatchState(sender, W, S, P, C, E));
            await processor.ExecuteAsync([], "", E, CancellationToken.None);
            return ids;
        }

        Assert.Equal(await RunOnce(), await RunOnce());
    }

    [Fact]
    public async Task SendsToTheProcessorsOwnQueueUnderTheProcessedDataType()
    {
        var (processor, sender) = Build((_, _, _, self) => self.Send(Encoding.UTF8.GetBytes("{}"), E));

        await processor.ExecuteAsync([], "", E, CancellationToken.None);

        await sender.Received(1).SendAsync(
            ProcessorQueues.Work(P), MessageTypes.ProcessedData, Arg.Any<ProcessedData>(),
            Arg.Any<CancellationToken>(), Arg.Any<string?>());
    }

    [Fact]
    public async Task ReportsWhichBranchWasLostWhenASendFails()
    {
        var sender = Substitute.For<IQueueSender>();
        sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<ProcessedData>(),
                         Arg.Any<CancellationToken>(), Arg.Any<string?>())
              .ThrowsAsync(new IOException("socket closed"));
        var processor = new Probe((_, _, _, self) => self.Send(Encoding.UTF8.GetBytes("{}"), E));
        processor.BeginDispatch(new DispatchState(sender, W, S, P, C, E));

        var thrown = await Assert.ThrowsAsync<PostSendException>(
            () => processor.ExecuteAsync([], "", E, CancellationToken.None));

        Assert.Equal(E, thrown.ExecutionId);
        Assert.NotEqual(Guid.Empty, thrown.MessageId);
        // It must stay classifiable as transient, or the consumer parks the dispatch instead of
        // returning it and the branch is lost for good.
        Assert.IsAssignableFrom<TransientSendException>(thrown);
    }

    [Fact]
    public async Task DerivesAnExecutionIdThatIsStableAcrossAReplay()
    {
        Guid RunOnce()
        {
            var processor = new Probe((_, _, _, _) => Task.CompletedTask);
            processor.BeginDispatch(new DispatchState(Substitute.For<IQueueSender>(), W, S, P, C, Guid.Empty));
            return processor.NextExecution();
        }

        Assert.Equal(RunOnce(), RunOnce());
        await Task.CompletedTask;
    }

    [Fact]
    public async Task RefusesToSendOutsideADispatch()
    {
        // Calling the helper with no dispatch open is a framework wiring bug, never an author one, and
        // it must be loud rather than sending a branch stamped with default ids.
        var processor = new Probe((_, _, _, _) => Task.CompletedTask);

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => processor.Send(Encoding.UTF8.GetBytes("{}"), E));
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: **build failure** — `DispatchState` and `BaseProcessor` do not exist.

- [ ] **Step 3: Write the dispatch state**

Create `src/BaseProcessor.Core/Processing/DispatchState.cs`:

```csharp
using Messaging.Transport;

namespace BaseProcessor.Core.Processing;

/// <summary>
/// Everything the seam helpers need about the dispatch currently being handled, plus the two
/// counters that make derived ids unique within it.
/// <para>
/// <b>Two counters, not one.</b> An author may take an execution id without sending, or send without
/// taking one; a shared counter would make each call's id depend on the other call's history, so two
/// runs that differ only in the order of those two operations would derive different ids. Separate
/// counters keep each sequence a function of its own call order.
/// </para>
/// </summary>
internal sealed class DispatchState(
    IQueueSender sender,
    Guid workflowId,
    Guid stepId,
    Guid processorId,
    Guid correlationId,
    Guid entryId)
{
    private int _messageSequence = -1;
    private int _executionSequence = -1;

    public IQueueSender Sender { get; } = sender;
    public Guid WorkflowId { get; } = workflowId;
    public Guid StepId { get; } = stepId;
    public Guid ProcessorId { get; } = processorId;
    public Guid CorrelationId { get; } = correlationId;
    public Guid EntryId { get; } = entryId;

    public int NextMessageSequence() => ++_messageSequence;

    public int NextExecutionSequence() => ++_executionSequence;
}
```

- [ ] **Step 4: Write the non-generic base**

Create `src/BaseProcessor.Core/Processing/BaseProcessor.cs`:

```csharp
using Messaging.Contracts;
using Messaging.Transport;

namespace BaseProcessor.Core.Processing;

/// <summary>
/// The type the pre handler resolves and calls. An author never derives from this directly — they
/// derive from <see cref="BaseProcessor{TConfig}"/>, which supplies this class's abstract member by
/// deserializing the payload first.
/// <para>
/// <b>The per-dispatch state is a plain field, and that is only safe at a prefetch of one.</b> One
/// dispatch runs at a time per replica, so nothing else can be mid-flight while this field is set.
/// Raising the prefetch would let one dispatch overwrite another's ids, and the branches of the
/// overwritten one would be sent under the wrong lineage — a wrong-key write with nothing to report
/// it. The reference hit exactly this and had to move the state into an <c>AsyncLocal</c>.
/// </para>
/// </summary>
public abstract class BaseProcessor
{
    private DispatchState? _dispatch;

    private DispatchState Current =>
        _dispatch ?? throw new InvalidOperationException(
            "No dispatch is open. BeginDispatch must run before the seam helpers — this is a framework wiring fault.");

    /// <summary>Framework entry point, supplied by <see cref="BaseProcessor{TConfig}"/>.</summary>
    internal abstract Task ExecuteAsync(byte[] data, string payload, Guid executionId, CancellationToken ct);

    /// <summary>Opens a dispatch. Called by the pre handler before it invokes the seam.</summary>
    internal void BeginDispatch(DispatchState state) => _dispatch = state;

    /// <summary>Closes it, in a finally, so stale ids cannot outlive the dispatch on a pooled thread.</summary>
    internal void EndDispatch() => _dispatch = null;

    /// <summary>
    /// Hands one branch of output to the post queue.
    /// <para>
    /// The framework stamps every id: the dispatch's workflow, step, correlation and entry ids, this
    /// processor's own id, and a derived message id. <b>The message id is derived rather than random
    /// on purpose</b> — a redelivered dispatch replays this call and must produce the id it produced
    /// before, so the post handler's write becomes a rewrite instead of a second branch.
    /// </para>
    /// <para>
    /// The author supplies <paramref name="executionId"/>, because how many lineages a fan-out opens
    /// is a decision only they can make. <see cref="NewExecutionId"/> mints one that survives a replay.
    /// </para>
    /// </summary>
    protected async Task SendToPostAsync(byte[] processedData, Guid executionId, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(processedData);

        var state = Current;
        var messageId = DeterministicId.From(
            DeterministicId.MessagePurpose,
            state.CorrelationId, state.StepId, state.EntryId, state.NextMessageSequence());

        var branch = new ProcessedData(state.WorkflowId, state.StepId, state.ProcessorId)
        {
            CorrelationId = state.CorrelationId,
            ExecutionId   = executionId,
            MessageId     = messageId,
            EntryId       = state.EntryId,
            Data          = processedData,
        };

        try
        {
            await state.Sender
                .SendTransientAsync(ProcessorQueues.Work(state.ProcessorId), MessageTypes.ProcessedData, branch, ct)
                .ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            // Named so an author fanning out can see which branch was lost. It stays a
            // TransientSendException, so the consumer still returns the dispatch to the queue.
            throw new PostSendException(messageId, executionId, ex);
        }
    }

    /// <summary>
    /// A fresh execution id for a branch, derived so that a replayed dispatch opens the same lineage
    /// rather than a new one. Use it wherever <c>Guid.NewGuid()</c> would otherwise go.
    /// </summary>
    protected Guid NewExecutionId()
    {
        var state = Current;
        return DeterministicId.From(
            DeterministicId.ExecutionPurpose,
            state.CorrelationId, state.StepId, state.EntryId, state.NextExecutionSequence());
    }
}
```

- [ ] **Step 5: Write the generic layer**

Create `src/BaseProcessor.Core/Processing/BaseProcessorOfT.cs`:

```csharp
using System.Text.Json;
using BaseProcessor.Core.Configuration;

namespace BaseProcessor.Core.Processing;

/// <summary>
/// The class an author derives from. It turns the step's JSON payload into their config type and
/// calls their transform; they override <see cref="ProcessAsync"/> and nothing else.
/// </summary>
public abstract class BaseProcessor<TConfig> : BaseProcessor where TConfig : ProcessorConfig
{
    internal sealed override Task ExecuteAsync(
        byte[] data, string payload, Guid executionId, CancellationToken ct)
    {
        // The emptiness guard runs before the deserialize, not inside a catch: a step with no payload
        // is an ordinary configuration, and letting JsonSerializer throw on "" would turn it into a
        // failed step.
        TConfig? config = string.IsNullOrWhiteSpace(payload)
            ? null
            : JsonSerializer.Deserialize<TConfig>(payload, ProcessorConfig.SerializerOptions);

        return ProcessAsync(data, config, executionId, ct);
    }

    /// <summary>
    /// The author's transform.
    /// <para>
    /// <paramref name="data"/> is the schema-validated input, empty for a source step, which has no
    /// upstream input and produces its own. <paramref name="config"/> is the step's payload, and it is
    /// <b>null when that payload was empty</b> — handle the absence rather than assuming a value.
    /// <paramref name="executionId"/> is <see cref="Guid.Empty"/> for an entry step, where the author
    /// opens a lineage per branch with <c>NewExecutionId()</c>, and non-empty downstream, where it is
    /// reused unchanged so the lineage holds.
    /// </para>
    /// <para>
    /// <b>Three ways to end.</b> Send one or more branches with <c>SendToPostAsync</c>; return without
    /// sending, which ends the branch silently and legitimately; or throw <see cref="FailedException"/>
    /// or <see cref="CancelledException"/> to report an outcome directly.
    /// </para>
    /// <para>
    /// <b>Branches must be produced in the same order every invocation.</b> A redelivered dispatch
    /// replays this method, and each branch's ids are derived from its position in the call sequence —
    /// so a fan-out over a <c>HashSet</c>, or a parallel loop, changes the ids on replay and forks the
    /// workflow. Iterate something ordered.
    /// </para>
    /// <para>
    /// <paramref name="ct"/> is never cancelled in production: abandoning a handler mid-flight would
    /// leave partially applied work with the message already claimed. It is here for tests.
    /// </para>
    /// </summary>
    protected abstract Task ProcessAsync(
        byte[] data, TConfig? config, Guid executionId, CancellationToken ct);
}
```

- [ ] **Step 6: Let the tests reach the internal members**

Add to `src/BaseProcessor.Core/BaseProcessor.Core.csproj`:

```xml
  <ItemGroup>
    <InternalsVisibleTo Include="BaseApi.Tests" />
  </ItemGroup>
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: 207 tests — 201 pass, 6 skip, exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/BaseProcessor.Core/Processing/DispatchState.cs \
        src/BaseProcessor.Core/Processing/BaseProcessor.cs \
        src/BaseProcessor.Core/Processing/BaseProcessorOfT.cs \
        src/BaseProcessor.Core/BaseProcessor.Core.csproj \
        src/tests/BaseApi.Tests/Processor/BaseProcessorSeamTests.cs
git commit -m "feat: add the processor author seam"
```

---

### Task 6: The pre handler

Reads the input, validates it, runs the author's transform. It never mutates the projection store, so
every failure before its acknowledgement leaves a redelivery everything it needs.

**Files:**
- Create: `src/BaseProcessor.Core/Processing/ProcessDispatchHandler.cs`
- Test: `src/tests/BaseApi.Tests/Processor/ProcessDispatchHandlerTests.cs`

**Interfaces:**
- Consumes: `BaseProcessor.BeginDispatch/EndDispatch/ExecuteAsync`, `DispatchState` (Task 5); `ProcessorJsonSchemaValidator.TryValidate` (Task 3); `ProcessDispatch`, `StepFailed`, `StepCancelled`, `ExecutionLogScope`, `CorrelationKeys`, `OrchestratorQueues.Result` (Task 1); `IProcessorContext.Identity` — existing; `L2ProjectionKeys.ExecutionData` — existing.
- Produces: `BaseProcessor.Core.Processing.ProcessDispatchHandler : IQueueMessageHandler` with `MessageType => MessageTypes.ProcessDispatch`.

- [ ] **Step 1: Write the failing test**

Create `src/tests/BaseApi.Tests/Processor/ProcessDispatchHandlerTests.cs`:

```csharp
using System.Text;
using System.Text.Json;
using BaseProcessor.Core.Configuration;
using BaseProcessor.Core.Identity;
using BaseProcessor.Core.Processing;
using BaseApi.Tests.Support;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Messaging.Transport;
using NSubstitute;
using NSubstitute.ExceptionExtensions;
using StackExchange.Redis;
using Xunit;

namespace BaseApi.Tests.Processor;

public sealed class ProcessDispatchHandlerTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");
    private static readonly Guid E = Guid.Parse("55555555-5555-5555-5555-555555555555");

    private sealed record NoConfig : ProcessorConfig;

    private sealed class Probe(Func<byte[], Probe, Task> body) : BaseProcessor<NoConfig>
    {
        public bool Ran { get; private set; }
        public byte[]? SawData { get; private set; }

        protected override Task ProcessAsync(byte[] data, NoConfig? config, Guid executionId, CancellationToken ct)
        {
            Ran = true;
            SawData = data;
            return body(data, this);
        }

        public Task Send(byte[] d) => SendToPostAsync(d, E, CancellationToken.None);
    }

    private sealed class Harness
    {
        public IDatabase Db { get; } = Substitute.For<IDatabase>();
        public IConnectionMultiplexer Redis { get; }
        public IQueueSender Sender { get; } = Substitute.For<IQueueSender>();
        public ProcessorContext Context { get; } = new();
        public RecordingLogger<ProcessDispatchHandler> Log { get; } = new();

        public Harness(string? inputSchema = null)
        {
            Redis = Substitute.For<IConnectionMultiplexer>();
            Redis.GetDatabase().Returns(Db);
            Context.SetIdentity(new ProcessorIdentityFound(P, null, null, null, "sample", "1.0.0"));
            if (inputSchema is not null)
            {
                // Give the identity an input schema id, then resolve it, so TryValidate has a definition.
                Context.SetIdentity(new ProcessorIdentityFound(
                    P, Guid.Parse("88888888-8888-8888-8888-888888888888"), null, null, "sample", "1.0.0"));
                Context.SetDefinition(Guid.Parse("88888888-8888-8888-8888-888888888888"), inputSchema);
            }
        }

        public ProcessDispatchHandler Build(BaseProcessor processor)
            => new(Redis, Sender, Context, processor, Log);
    }

    private static byte[] Body(ProcessDispatch d)
        => JsonSerializer.SerializeToUtf8Bytes(d, MessagingJson.Options);

    private static ProcessDispatch Dispatch(Guid entryId) =>
        new(W, S, P) { CorrelationId = C, ExecutionId = Guid.Empty, EntryId = entryId, Payload = "" };

    [Fact]
    public async Task RunsTheTransformOnTheDataItReadFromTheStore()
    {
        var h = new Harness();
        h.Db.StringGetAsync(L2ProjectionKeys.ExecutionData(E)).Returns((RedisValue)"""{"number":7}""");
        var probe = new Probe((_, _) => Task.CompletedTask);

        await h.Build(probe).HandleAsync(Body(Dispatch(E)), CancellationToken.None);

        Assert.True(probe.Ran);
        Assert.Equal("""{"number":7}""", Encoding.UTF8.GetString(probe.SawData!));
    }

    [Fact]
    public async Task ReturnsWithoutAResultWhenTheEntryIsAlreadyGone()
    {
        // The input was reclaimed by a post handler, so this step already completed and this is a
        // duplicate delivery. Emitting a failure here would corrupt a finished workflow.
        var h = new Harness();
        h.Db.StringGetAsync(L2ProjectionKeys.ExecutionData(E)).Returns(RedisValue.Null);
        var probe = new Probe((_, _) => Task.CompletedTask);

        await h.Build(probe).HandleAsync(Body(Dispatch(E)), CancellationToken.None);

        Assert.False(probe.Ran);
        await h.Sender.DidNotReceive().SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<object>(),
                                                 Arg.Any<CancellationToken>(), Arg.Any<string?>());
    }

    [Fact]
    public async Task RunsASourceStepWithEmptyDataWithoutReadingTheStore()
    {
        var h = new Harness();
        var probe = new Probe((_, _) => Task.CompletedTask);

        await h.Build(probe).HandleAsync(Body(Dispatch(Guid.Empty)), CancellationToken.None);

        Assert.True(probe.Ran);
        Assert.Empty(probe.SawData!);
        await h.Db.DidNotReceive().StringGetAsync(Arg.Any<RedisKey>(), Arg.Any<CommandFlags>());
    }

    [Fact]
    public async Task NeverDeletesOrWritesAnything()
    {
        // Pre owns no store mutation at all. Anything here would leave a redelivery without its input.
        var h = new Harness();
        h.Db.StringGetAsync(L2ProjectionKeys.ExecutionData(E)).Returns((RedisValue)"{}");
        var probe = new Probe((_, _) => Task.CompletedTask);

        await h.Build(probe).HandleAsync(Body(Dispatch(E)), CancellationToken.None);

        await h.Db.DidNotReceive().KeyDeleteAsync(Arg.Any<RedisKey>(), Arg.Any<CommandFlags>());
        await h.Db.DidNotReceive().StringSetAsync(Arg.Any<RedisKey>(), Arg.Any<RedisValue>(),
                                                  Arg.Any<TimeSpan?>(), Arg.Any<When>(), Arg.Any<CommandFlags>());
    }

    [Fact]
    public async Task LetsAStoreFaultEscapeSoTheDeliveryIsRequeued()
    {
        // Swallowing this would acknowledge a step that never ran.
        var h = new Harness();
        h.Db.StringGetAsync(L2ProjectionKeys.ExecutionData(E))
            .ThrowsAsync(new RedisConnectionException(ConnectionFailureType.SocketFailure, "down"));
        var probe = new Probe((_, _) => Task.CompletedTask);

        await Assert.ThrowsAsync<RedisConnectionException>(
            () => h.Build(probe).HandleAsync(Body(Dispatch(E)), CancellationToken.None));
    }

    [Fact]
    public async Task ReportsAnInputThatFailsItsSchema()
    {
        var h = new Harness("""{"type":"object","properties":{"number":{"type":"integer"}},"required":["number"]}""");
        h.Db.StringGetAsync(L2ProjectionKeys.ExecutionData(E)).Returns((RedisValue)"""{"number":"seven"}""");
        StepFailed? sent = null;
        await h.Sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<StepFailed>(f => sent = f),
                                 Arg.Any<CancellationToken>(), Arg.Any<string?>());
        var probe = new Probe((_, _) => Task.CompletedTask);

        await h.Build(probe).HandleAsync(Body(Dispatch(E)), CancellationToken.None);

        Assert.False(probe.Ran);
        Assert.NotNull(sent);
        Assert.Equal(Guid.Empty, sent!.EntryId);
    }

    [Fact]
    public async Task PutsAnAuthorsFailureMessageOnTheWireVerbatim()
    {
        var h = new Harness();
        h.Db.StringGetAsync(L2ProjectionKeys.ExecutionData(E)).Returns((RedisValue)"{}");
        StepFailed? sent = null;
        await h.Sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<StepFailed>(f => sent = f),
                                 Arg.Any<CancellationToken>(), Arg.Any<string?>());
        var probe = new Probe((_, _) => throw new FailedException("order total below minimum"));

        await h.Build(probe).HandleAsync(Body(Dispatch(E)), CancellationToken.None);

        Assert.Equal("order total below minimum", sent!.ErrorMessage);
    }

    [Fact]
    public async Task NeverPutsAFrameworkCaughtExceptionMessageOnTheWire()
    {
        // A deserialize failure quotes the offending payload fragment in its message. Sending that
        // would leak payload content into the orchestrator's projections.
        var h = new Harness();
        h.Db.StringGetAsync(L2ProjectionKeys.ExecutionData(E)).Returns((RedisValue)"{}");
        StepFailed? sent = null;
        await h.Sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<StepFailed>(f => sent = f),
                                 Arg.Any<CancellationToken>(), Arg.Any<string?>());
        var probe = new Probe((_, _) => throw new InvalidOperationException("secret-token-abc123"));

        await h.Build(probe).HandleAsync(Body(Dispatch(E)), CancellationToken.None);

        Assert.DoesNotContain("secret-token-abc123", sent!.ErrorMessage, StringComparison.Ordinal);
        Assert.NotEmpty(sent.ErrorMessage);
    }

    [Fact]
    public async Task ReportsAnAuthorsCancellation()
    {
        var h = new Harness();
        h.Db.StringGetAsync(L2ProjectionKeys.ExecutionData(E)).Returns((RedisValue)"{}");
        StepCancelled? sent = null;
        await h.Sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<StepCancelled>(c => sent = c),
                                 Arg.Any<CancellationToken>(), Arg.Any<string?>());
        var probe = new Probe((_, _) => throw new CancelledException("below threshold"));

        await h.Build(probe).HandleAsync(Body(Dispatch(E)), CancellationToken.None);

        Assert.Equal("below threshold", sent!.CancellationMessage);
    }

    [Fact]
    public async Task SendsNothingWhenTheAuthorEndsTheBranchSilently()
    {
        // A sink or a filter legitimately ends here with nothing to report.
        var h = new Harness();
        h.Db.StringGetAsync(L2ProjectionKeys.ExecutionData(E)).Returns((RedisValue)"{}");
        var probe = new Probe((_, _) => Task.CompletedTask);

        await h.Build(probe).HandleAsync(Body(Dispatch(E)), CancellationToken.None);

        await h.Sender.DidNotReceive().SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<object>(),
                                                 Arg.Any<CancellationToken>(), Arg.Any<string?>());
    }

    [Fact]
    public async Task LetsAFailedBranchSendEscapeRatherThanReportingTheStepFailed()
    {
        // Reporting failure here would acknowledge the dispatch, and the branch would never be sent.
        var h = new Harness();
        h.Db.StringGetAsync(L2ProjectionKeys.ExecutionData(E)).Returns((RedisValue)"{}");
        h.Sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<ProcessedData>(),
                           Arg.Any<CancellationToken>(), Arg.Any<string?>())
                .ThrowsAsync(new IOException("socket closed"));
        var probe = new Probe((_, self) => self.Send(Encoding.UTF8.GetBytes("{}")));

        await Assert.ThrowsAsync<PostSendException>(
            () => h.Build(probe).HandleAsync(Body(Dispatch(E)), CancellationToken.None));
    }

    [Fact]
    public async Task StampsOurOwnProcessorIdOnResultsEvenWhenTheDispatchClaimsAnother()
    {
        // The branch path is covered below; this covers the OTHER four outbound sites. A result that
        // echoed the inbound id would misattribute a failure to whichever processor a corrupt or
        // misrouted dispatch happened to name — and unlike the branch path, nothing downstream would
        // notice, because a StepFailed carries no key anyone later reads.
        var h = new Harness();
        h.Db.StringGetAsync(L2ProjectionKeys.ExecutionData(E)).Returns((RedisValue)"{}");
        StepFailed? sent = null;
        await h.Sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<StepFailed>(f => sent = f),
                                 Arg.Any<CancellationToken>(), Arg.Any<string?>());
        var probe = new Probe((_, _) => throw new FailedException("nope"));

        var foreign = Dispatch(E) with { ProcessorId = Guid.Parse("dddddddd-dddd-dddd-dddd-dddddddddddd") };
        await h.Build(probe).HandleAsync(Body(foreign), CancellationToken.None);

        Assert.Equal(P, sent!.ProcessorId);
    }

    [Fact]
    public async Task StampsOurOwnProcessorIdOnBranchesEvenWhenTheDispatchClaimsAnother()
    {
        // The dispatch was addressed to OUR queue, so we are the processor it names. Echoing its
        // ProcessorId field back would be the only way the two could ever disagree — and a branch
        // stamped with someone else's id writes into their lineage. This is what makes a provenance
        // guard unnecessary: the mismatch is unrepresentable rather than checked for.
        var h = new Harness();
        h.Db.StringGetAsync(L2ProjectionKeys.ExecutionData(E)).Returns((RedisValue)"{}");
        ProcessedData? sent = null;
        await h.Sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(p => sent = p),
                                 Arg.Any<CancellationToken>(), Arg.Any<string?>());
        var probe = new Probe((_, self) => self.Send(Encoding.UTF8.GetBytes("{}")));

        var foreign = Dispatch(E) with { ProcessorId = Guid.Parse("dddddddd-dddd-dddd-dddd-dddddddddddd") };
        await h.Build(probe).HandleAsync(Body(foreign), CancellationToken.None);

        Assert.Equal(P, sent!.ProcessorId);
    }

    [Fact]
    public async Task ThrowsOnABodyItCannotRead()
    {
        // Above the deserialization boundary there are no ids to report with, so throwing is correct:
        // the consumer parks it and the bytes survive for inspection.
        var h = new Harness();
        var probe = new Probe((_, _) => Task.CompletedTask);

        await Assert.ThrowsAnyAsync<Exception>(
            () => h.Build(probe).HandleAsync(Encoding.UTF8.GetBytes("not json"), CancellationToken.None));
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: **build failure** — `ProcessDispatchHandler` does not exist.

- [ ] **Step 3: Write the handler**

Create `src/BaseProcessor.Core/Processing/ProcessDispatchHandler.cs`:

```csharp
using System.Text.Json;
using BaseProcessor.Core.Identity;
using BaseProcessor.Core.Validation;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Messaging.Transport;
using Microsoft.Extensions.Logging;
using StackExchange.Redis;

namespace BaseProcessor.Core.Processing;

/// <summary>
/// Runs one step: read the input, validate it, hand it to the author.
/// <para>
/// <b>This handler never mutates the projection store.</b> No write, no delete. That is what makes
/// every failure below safe to retry: whatever goes wrong, the input key is exactly as it was found,
/// so the redelivery replays from the same starting state. Reclaiming the input belongs to the post
/// handler, which owns it along with everything else keyed by the branch's message id.
/// </para>
/// <para>
/// Two rejected alternatives are worth recording. Deleting the input <i>before</i> the transform
/// leaves a redelivery reading an absent key, which returns without processing — a silently lost
/// step. Deleting it <i>after</i> a successful branch send means a failed delete requeues the
/// dispatch, the transform runs again, and the workflow forks; a store blip is precisely the fault
/// this design expects, so that would make forking routine.
/// </para>
/// </summary>
internal sealed class ProcessDispatchHandler : IQueueMessageHandler
{
    private readonly IConnectionMultiplexer _redis;
    private readonly IQueueSender _sender;
    private readonly IProcessorContext _context;
    private readonly BaseProcessor _processor;
    private readonly ILogger<ProcessDispatchHandler> _logger;

    public ProcessDispatchHandler(
        IConnectionMultiplexer redis,
        IQueueSender sender,
        IProcessorContext context,
        BaseProcessor processor,
        ILogger<ProcessDispatchHandler> logger)
    {
        _redis     = redis ?? throw new ArgumentNullException(nameof(redis));
        _sender    = sender ?? throw new ArgumentNullException(nameof(sender));
        _context   = context ?? throw new ArgumentNullException(nameof(context));
        _processor = processor ?? throw new ArgumentNullException(nameof(processor));
        _logger    = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public string MessageType => MessageTypes.ProcessDispatch;

    public async Task HandleAsync(ReadOnlyMemory<byte> body, CancellationToken ct)
    {
        // Above the deserialization boundary. A body that will not parse carries no ids to report a
        // failure with, so throwing is the only honest option — the consumer parks it and the bytes
        // survive where someone can look at them.
        var d = JsonSerializer.Deserialize<ProcessDispatch>(body.Span, MessagingJson.Options)
                ?? throw new JsonException("dispatch deserialized to null");

        using (_logger.BeginScope(ExecutionLogScope.BuildState(d)))
        using (_logger.BeginScope(new Dictionary<string, object>
               {
                   [CorrelationKeys.LogScope] = CorrelationKeys.Render(d.CorrelationId),
               }))
        {
            await RunAsync(d, ct).ConfigureAwait(false);
        }
    }

    private async Task RunAsync(ProcessDispatch d, CancellationToken ct)
    {
        // ProcessorId on EVERY outbound message comes from OUR OWN identity, never from the inbound
        // one. The dispatch was addressed to this processor's queue, so we ARE the processor it
        // names — echoing its field back is the only way the two could ever disagree, and a result
        // attributed to another processor's id lands in their lineage. Stamping from self makes that
        // unrepresentable, which is why this design carries no provenance guard anywhere: a check
        // against a condition that cannot arise reads as a live defence, cannot be tested, and drifts.
        //
        // Resolved ONCE, above every early return, so the schema-failure path is covered too. A null
        // identity here is a framework wiring fault, never a producer or author one: the work queue is
        // bound only after the processor reaches Healthy, so nothing can be consumed before identity
        // resolves. Loud is right — it parks the message, preserving it for inspection.
        var identity = _context.Identity
            ?? throw new InvalidOperationException(
                "A dispatch was consumed before identity resolved — the queue must not be bound until then.");
        var self = identity.Id;

        var isSource = d.EntryId == Guid.Empty;

        byte[] data;
        if (isSource)
        {
            // No upstream input. The author produces its own, and there is no key to read or reclaim.
            data = [];
        }
        else
        {
            // A store fault propagates: the consumer classifies it, closes the gate and returns the
            // delivery. Catching it here would acknowledge a step that never ran.
            var raw = await _redis.GetDatabase()
                .StringGetAsync(L2ProjectionKeys.ExecutionData(d.EntryId))
                .ConfigureAwait(false);

            if (raw.IsNullOrEmpty)
            {
                // The post handler already reclaimed this key, so the step completed and this is a
                // duplicate delivery. Reporting a failure would overwrite a finished workflow's outcome.
                _logger.LogInformation("entry absent — treating as a duplicate delivery");
                return;
            }

            data = (byte[])raw!;
        }

        // Skipped for a source step as a branch decision, not as a side effect of a source processor
        // having no input schema. A null definition skips validation anyway, so this works by accident
        // today — but a source step that did carry one would have empty bytes parsed, throw, and fail a
        // step that was never wrong.
        if (!isSource
            && !ProcessorJsonSchemaValidator.TryValidate(identity.InputDefinition, data, out var errors))
        {
            await SendAsync(new StepFailed(d.WorkflowId, d.StepId, self)
            {
                CorrelationId = d.CorrelationId,
                ExecutionId   = d.ExecutionId,
                ErrorMessage  = string.Join("; ", errors),
            }, MessageTypes.StepFailed, ct).ConfigureAwait(false);

            _logger.LogInformation("input failed its schema — reported failed");
            return;
        }

        _processor.BeginDispatch(new DispatchState(
            _sender, d.WorkflowId, d.StepId, self, d.CorrelationId, d.EntryId));
        try
        {
            await _processor.ExecuteAsync(data, d.Payload, d.ExecutionId, ct).ConfigureAwait(false);
        }
        catch (FailedException ex)
        {
            await SendAsync(new StepFailed(d.WorkflowId, d.StepId, self)
            {
                CorrelationId = d.CorrelationId,
                ExecutionId   = d.ExecutionId,
                ErrorMessage  = ex.Message,   // author-authored, so verbatim is safe
            }, MessageTypes.StepFailed, ct).ConfigureAwait(false);
        }
        catch (CancelledException ex)
        {
            await SendAsync(new StepCancelled(d.WorkflowId, d.StepId, self)
            {
                CorrelationId       = d.CorrelationId,
                ExecutionId         = d.ExecutionId,
                CancellationMessage = ex.Message,
            }, MessageTypes.StepCancelled, ct).ConfigureAwait(false);
        }
        catch (TransientSendException)
        {
            // MUST sit above the general catch. A branch that could not be sent is recoverable by
            // redelivery; reporting it as a failed step would acknowledge the dispatch and lose the
            // branch permanently while recording a business outcome that never happened.
            throw;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // The message is deliberately a constant. A deserialize JsonException quotes the offending
            // fragment of the payload, and this text reaches the orchestrator's projections.
            _logger.LogWarning(ex, "the transform faulted — reporting the step failed");

            await SendAsync(new StepFailed(d.WorkflowId, d.StepId, self)
            {
                CorrelationId = d.CorrelationId,
                ExecutionId   = d.ExecutionId,
                ErrorMessage  = "the processor faulted",
            }, MessageTypes.StepFailed, ct).ConfigureAwait(false);
        }
        finally
        {
            _processor.EndDispatch();
        }
    }

    /// <summary>
    /// Sends a result, classifying a broker failure as transient so the delivery is returned to the
    /// queue rather than parked — the step's outcome is known and must not be lost to a blip.
    /// </summary>
    private Task SendAsync<T>(T result, string type, CancellationToken ct)
        => _sender.SendTransientAsync(OrchestratorQueues.Result, type, result, ct);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: 220 tests — 214 pass, 6 skip, exit 0.

- [ ] **Step 5: Teach the test logger to observe scopes**

`RecordingLogger.BeginScope` returns `null`, so nothing can currently assert that the ids reach a
record. Replace that line in `src/tests/BaseApi.Tests/Support/RecordingLogger.cs` and add a list to
hold what was opened:

```csharp
    /// <summary>
    /// Every scope dictionary opened on this logger, in the order they were opened. Scopes are how
    /// the execution ids reach a record — the ids are never in the message template — so a test that
    /// cannot see them cannot verify the log contract at all.
    /// </summary>
    public List<IReadOnlyDictionary<string, object>> Scopes { get; } = [];

    public IDisposable? BeginScope<TState>(TState state) where TState : notnull
    {
        if (state is IEnumerable<KeyValuePair<string, object>> pairs)
        {
            Scopes.Add(pairs.ToDictionary(p => p.Key, p => p.Value));
        }

        return new Scope();
    }

    private sealed class Scope : IDisposable
    {
        public void Dispose() { }
    }
```

Add `using System.Linq;` if the file does not already have it implicitly.

- [ ] **Step 6: Write the failing log-contract tests**

Append to `src/tests/BaseApi.Tests/Processor/ProcessDispatchHandlerTests.cs`:

```csharp
    [Fact]
    public async Task PutsEveryPopulatedIdOnEveryRecordItEmits()
    {
        // The ids are never in a message template — they arrive as scope values, which the OTel bridge
        // turns into attributes. One scope at the top of the handler is what makes that true for
        // framework records and for anything the author logs inside the transform.
        var h = new Harness();
        h.Db.StringGetAsync(L2ProjectionKeys.ExecutionData(E)).Returns(RedisValue.Null);

        await h.Build(new Probe((_, _) => Task.CompletedTask))
               .HandleAsync(Body(Dispatch(E)), CancellationToken.None);

        var ids = h.Log.Scopes.SelectMany(s => s).ToDictionary(p => p.Key, p => p.Value);
        Assert.Equal(W.ToString("D"), ids[ExecutionLogScope.WorkflowId]);
        Assert.Equal(S.ToString("D"), ids[ExecutionLogScope.StepId]);
        Assert.Equal(P.ToString("D"), ids[ExecutionLogScope.ProcessorId]);
        Assert.Equal(E.ToString("D"), ids[ExecutionLogScope.EntryId]);
    }

    [Fact]
    public async Task RendersTheCorrelationIdTheWayTheHttpMiddlewareDoes()
    {
        // Two spellings of one id land on one Elasticsearch field, and the query joining an HTTP
        // request to its bus work silently returns nothing.
        var h = new Harness();
        h.Db.StringGetAsync(L2ProjectionKeys.ExecutionData(E)).Returns(RedisValue.Null);

        await h.Build(new Probe((_, _) => Task.CompletedTask))
               .HandleAsync(Body(Dispatch(E)), CancellationToken.None);

        var ids = h.Log.Scopes.SelectMany(s => s).ToDictionary(p => p.Key, p => p.Value);
        Assert.Equal(C.ToString("N"), ids[CorrelationKeys.LogScope]);
    }

    [Fact]
    public async Task OmitsAnIdThatDoesNotApplyRatherThanZeroingIt()
    {
        // A source step has no entry id and an entry dispatch has no execution id. All-zeros would be
        // indistinguishable from a real id that happens to be empty.
        var h = new Harness();

        await h.Build(new Probe((_, _) => Task.CompletedTask))
               .HandleAsync(Body(Dispatch(Guid.Empty)), CancellationToken.None);

        var ids = h.Log.Scopes.SelectMany(s => s).ToDictionary(p => p.Key, p => p.Value);
        Assert.False(ids.ContainsKey(ExecutionLogScope.EntryId));
        Assert.False(ids.ContainsKey(ExecutionLogScope.ExecutionId));
    }

    [Fact]
    public async Task NeverPutsDataOrConfigInALogMessage()
    {
        var h = new Harness();
        h.Db.StringGetAsync(L2ProjectionKeys.ExecutionData(E)).Returns((RedisValue)"""{"secret":"topsecret"}""");
        var dispatch = Dispatch(E) with { Payload = """{"Token":"payload-secret"}""" };

        await h.Build(new Probe((_, _) => throw new InvalidOperationException("boom")))
               .HandleAsync(Body(dispatch), CancellationToken.None);

        Assert.DoesNotContain(h.Log.Records, r => r.Message.Contains("topsecret", StringComparison.Ordinal));
        Assert.DoesNotContain(h.Log.Records, r => r.Message.Contains("payload-secret", StringComparison.Ordinal));
    }
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: 224 tests — 218 pass, 6 skip, exit 0.

If `PutsEveryPopulatedIdOnEveryRecordItEmits` fails with a missing key, the handler is opening its
scope after the early return rather than around the whole body.

- [ ] **Step 8: Commit**

```bash
git add src/BaseProcessor.Core/Processing/ProcessDispatchHandler.cs \
        src/tests/BaseApi.Tests/Support/RecordingLogger.cs \
        src/tests/BaseApi.Tests/Processor/ProcessDispatchHandlerTests.cs
git commit -m "feat: run a dispatched step without mutating the projection store"
```

---

### Task 7: The post handler

Reclaims the input key, validates the output, writes it, reports the outcome. Everything it does is
keyed by a message id that rides the body, so a redelivery repeats it exactly.

**Files:**
- Create: `src/BaseProcessor.Core/Processing/ProcessedDataHandler.cs`
- Test: `src/tests/BaseApi.Tests/Processor/ProcessedDataHandlerTests.cs`

**Interfaces:**
- Consumes: `ProcessorJsonSchemaValidator.TryValidate` (Task 3); `ProcessedData`, `StepCompleted`, `StepFailed`, `ExecutionLogScope`, `CorrelationKeys` (Task 1); `L2ProjectionKeys.ExecutionData`, `L2ProjectionKeys.OutputData`, `L2ProjectionKeys.OutputDataTtl`, `ProcessorLivenessOptions.ExecutionDataTtlSeconds` — existing.
- Produces: `BaseProcessor.Core.Processing.ProcessedDataHandler : IQueueMessageHandler` with `MessageType => MessageTypes.ProcessedData`.

> **Check before you start:** `ProcessorLivenessOptions` may not yet have an
> `ExecutionDataTtlSeconds` member — run
> `grep -n "ExecutionDataTtl" src/BaseProcessor.Core/Configuration/ProcessorLivenessOptions.cs`.
> If it is absent, add it with `[ConfigurationKeyName("ExecutionDataTtl")] public int ExecutionDataTtlSeconds { get; set; } = 3600;` and a doc line saying it is the floor of the jittered output-blob TTL.

- [ ] **Step 1: Write the failing test**

Create `src/tests/BaseApi.Tests/Processor/ProcessedDataHandlerTests.cs`:

```csharp
using System.Text;
using System.Text.Json;
using BaseProcessor.Core.Configuration;
using BaseProcessor.Core.Identity;
using BaseProcessor.Core.Processing;
using BaseApi.Tests.Support;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Messaging.Transport;
using Microsoft.Extensions.Options;
using NSubstitute;
using NSubstitute.ExceptionExtensions;
using StackExchange.Redis;
using Xunit;

namespace BaseApi.Tests.Processor;

public sealed class ProcessedDataHandlerTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");
    private static readonly Guid E = Guid.Parse("55555555-5555-5555-5555-555555555555");
    private static readonly Guid M = Guid.Parse("99999999-9999-9999-9999-999999999999");

    private sealed class Harness
    {
        public IDatabase Db { get; } = Substitute.For<IDatabase>();
        public IConnectionMultiplexer Redis { get; }
        public IQueueSender Sender { get; } = Substitute.For<IQueueSender>();
        public ProcessorContext Context { get; } = new();
        public RecordingLogger<ProcessedDataHandler> Log { get; } = new();

        public Harness(string? outputSchema = null)
        {
            Redis = Substitute.For<IConnectionMultiplexer>();
            Redis.GetDatabase().Returns(Db);
            Db.StringSetAsync(Arg.Any<RedisKey>(), Arg.Any<RedisValue>(), Arg.Any<TimeSpan?>(),
                              Arg.Any<When>(), Arg.Any<CommandFlags>()).Returns(true);
            Db.KeyDeleteAsync(Arg.Any<RedisKey>(), Arg.Any<CommandFlags>()).Returns(true);

            var outId = Guid.Parse("88888888-8888-8888-8888-888888888888");
            Context.SetIdentity(new ProcessorIdentityFound(
                P, null, outputSchema is null ? null : outId, null, "sample", "1.0.0"));
            if (outputSchema is not null)
            {
                Context.SetDefinition(outId, outputSchema);
            }
        }

        public ProcessedDataHandler Build() => new(
            Redis, Sender, Context,
            Options.Create(new ProcessorLivenessOptions()), Log);
    }

    private static byte[] Body(ProcessedData p)
        => JsonSerializer.SerializeToUtf8Bytes(p, MessagingJson.Options);

    private static ProcessedData Branch(Guid entryId, string json = "{}") =>
        new(W, S, P)
        {
            CorrelationId = C, ExecutionId = E, MessageId = M, EntryId = entryId,
            Data = Encoding.UTF8.GetBytes(json),
        };

    [Fact]
    public async Task ReclaimsTheInputKeyFirst()
    {
        var h = new Harness();

        await h.Build().HandleAsync(Body(Branch(E)), CancellationToken.None);

        await h.Db.Received(1).KeyDeleteAsync(L2ProjectionKeys.ExecutionData(E), Arg.Any<CommandFlags>());
    }

    [Fact]
    public async Task LeavesNothingToReclaimForASourceStep()
    {
        var h = new Harness();

        await h.Build().HandleAsync(Body(Branch(Guid.Empty)), CancellationToken.None);

        await h.Db.DidNotReceive().KeyDeleteAsync(Arg.Any<RedisKey>(), Arg.Any<CommandFlags>());
    }

    [Fact]
    public async Task WritesTheOutputUnderTheMessageIdSoAReplayRewritesIt()
    {
        var h = new Harness();

        await h.Build().HandleAsync(Body(Branch(E, """{"number":7}""")), CancellationToken.None);

        await h.Db.Received(1).StringSetAsync(
            L2ProjectionKeys.OutputData(M), Arg.Any<RedisValue>(), Arg.Any<TimeSpan?>(),
            Arg.Any<When>(), Arg.Any<CommandFlags>());
    }

    [Fact]
    public async Task WritesWithATtlSoAnOrphanedOutputExpires()
    {
        var h = new Harness();
        TimeSpan? ttl = null;

        await h.Db.StringSetAsync(Arg.Any<RedisKey>(), Arg.Any<RedisValue>(), Arg.Do<TimeSpan?>(t => ttl = t),
                                  Arg.Any<When>(), Arg.Any<CommandFlags>());
        await h.Build().HandleAsync(Body(Branch(E)), CancellationToken.None);

        Assert.NotNull(ttl);
        Assert.True(ttl!.Value > TimeSpan.Zero);
    }

    [Fact]
    public async Task ReportsCompletionCarryingTheOutputKey()
    {
        // The orchestrator relocates this key into one input key per successor, so it has to be the
        // key just written rather than the input that was reclaimed.
        var h = new Harness();
        StepCompleted? sent = null;
        await h.Sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<StepCompleted>(s => sent = s),
                                 Arg.Any<CancellationToken>(), Arg.Any<string?>());

        await h.Build().HandleAsync(Body(Branch(E)), CancellationToken.None);

        Assert.Equal(M, sent!.EntryId);
        Assert.Equal(E, sent.ExecutionId);
    }

    [Fact]
    public async Task ReportsFailureAndWritesNothingWhenTheOutputFailsItsSchema()
    {
        // No successor will read a failed step's output, so persisting it would be garbage with a TTL.
        var h = new Harness("""{"type":"object","properties":{"number":{"type":"integer"}},"required":["number"]}""");
        StepFailed? sent = null;
        await h.Sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<StepFailed>(f => sent = f),
                                 Arg.Any<CancellationToken>(), Arg.Any<string?>());

        await h.Build().HandleAsync(Body(Branch(E, """{"number":"seven"}""")), CancellationToken.None);

        Assert.NotNull(sent);
        await h.Db.DidNotReceive().StringSetAsync(Arg.Any<RedisKey>(), Arg.Any<RedisValue>(),
                                                  Arg.Any<TimeSpan?>(), Arg.Any<When>(), Arg.Any<CommandFlags>());
    }

    [Fact]
    public async Task LetsAStoreFaultEscapeSoTheBranchIsRequeued()
    {
        var h = new Harness();
        h.Db.KeyDeleteAsync(Arg.Any<RedisKey>(), Arg.Any<CommandFlags>())
            .ThrowsAsync(new RedisConnectionException(ConnectionFailureType.SocketFailure, "down"));

        await Assert.ThrowsAsync<RedisConnectionException>(
            () => h.Build().HandleAsync(Body(Branch(E)), CancellationToken.None));
    }

    [Fact]
    public async Task IsIdempotentAcrossAReplay()
    {
        // The delete no-ops on an already-absent key and the write rewrites the same key with the same
        // bytes, so running the handler twice leaves the state one run leaves.
        var h = new Harness();

        await h.Build().HandleAsync(Body(Branch(E)), CancellationToken.None);
        await h.Build().HandleAsync(Body(Branch(E)), CancellationToken.None);

        await h.Db.Received(2).StringSetAsync(L2ProjectionKeys.OutputData(M), Arg.Any<RedisValue>(),
                                              Arg.Any<TimeSpan?>(), Arg.Any<When>(), Arg.Any<CommandFlags>());
    }

    [Fact]
    public async Task LetsAFailedResultSendEscapeRatherThanAcknowledging()
    {
        var h = new Harness();
        h.Sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<StepCompleted>(),
                           Arg.Any<CancellationToken>(), Arg.Any<string?>())
                .ThrowsAsync(new IOException("socket closed"));

        await Assert.ThrowsAsync<TransientSendException>(
            () => h.Build().HandleAsync(Body(Branch(E)), CancellationToken.None));
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: **build failure** — `ProcessedDataHandler` does not exist.

- [ ] **Step 3: Write the handler**

Create `src/BaseProcessor.Core/Processing/ProcessedDataHandler.cs`:

```csharp
using System.Text.Json;
using BaseProcessor.Core.Configuration;
using BaseProcessor.Core.Identity;
using BaseProcessor.Core.Validation;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Messaging.Transport;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using StackExchange.Redis;

namespace BaseProcessor.Core.Processing;

/// <summary>
/// Finishes one branch: reclaim the input, validate the output, persist it, report the outcome.
/// <para>
/// <b>Every step is keyed by a message id that rides the message body</b>, so a redelivery repeats
/// the sequence exactly — the delete no-ops on an absent key, the write rewrites the same key with
/// the same bytes, the result send repeats. That idempotence is what lets this handler use a plain
/// NACK as its whole recovery mechanism.
/// </para>
/// <para>
/// <b>The delete goes first, and not merely because the input is finished with.</b> It is the most
/// failure-prone operation here, so it belongs before the ones whose repetition costs something:
/// delete last and a failed delete replays a write and a result send, so the orchestrator sees a
/// duplicate result; delete first and a failed delete replays only itself.
/// </para>
/// <para>
/// <b>The output goes to the <c>out:</c> namespace, never straight to <c>data:</c>.</b> A step with
/// three successors would otherwise produce three dispatches reading one key — the first successor's
/// post handler would reclaim it and the other two would find it absent, return without processing,
/// and vanish. The orchestrator relocates this blob into one input key per successor, so each
/// successor owns a key nobody else deletes.
/// </para>
/// </summary>
internal sealed class ProcessedDataHandler : IQueueMessageHandler
{
    private readonly IConnectionMultiplexer _redis;
    private readonly IQueueSender _sender;
    private readonly IProcessorContext _context;
    private readonly ProcessorLivenessOptions _options;
    private readonly ILogger<ProcessedDataHandler> _logger;

    public ProcessedDataHandler(
        IConnectionMultiplexer redis,
        IQueueSender sender,
        IProcessorContext context,
        IOptions<ProcessorLivenessOptions> options,
        ILogger<ProcessedDataHandler> logger)
    {
        _redis   = redis ?? throw new ArgumentNullException(nameof(redis));
        _sender  = sender ?? throw new ArgumentNullException(nameof(sender));
        _context = context ?? throw new ArgumentNullException(nameof(context));
        _options = options?.Value ?? throw new ArgumentNullException(nameof(options));
        _logger  = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public string MessageType => MessageTypes.ProcessedData;

    public async Task HandleAsync(ReadOnlyMemory<byte> body, CancellationToken ct)
    {
        var p = JsonSerializer.Deserialize<ProcessedData>(body.Span, MessagingJson.Options)
                ?? throw new JsonException("processed-data deserialized to null");

        using (_logger.BeginScope(ExecutionLogScope.BuildState(p)))
        using (_logger.BeginScope(new Dictionary<string, object>
               {
                   [CorrelationKeys.LogScope] = CorrelationKeys.Render(p.CorrelationId),
               }))
        {
            await RunAsync(p, ct).ConfigureAwait(false);
        }
    }

    private async Task RunAsync(ProcessedData p, CancellationToken ct)
    {
        // Same invariant as the pre handler: ProcessorId on every outbound message comes from OUR OWN
        // identity, never from the inbound one. Here the inbound ProcessedData was produced by this
        // processor, so its field is already ours by construction — which is exactly why echoing it
        // buys nothing and is the only way the two could ever disagree. Stamping from self keeps the
        // mismatch unrepresentable on both handlers, which is what lets this design carry no
        // provenance guard anywhere.
        var identity = _context.Identity
            ?? throw new InvalidOperationException(
                "A branch was consumed before identity resolved — the queue must not be bound until then.");
        var self = identity.Id;

        var db = _redis.GetDatabase();

        // A source step had no input key to begin with.
        if (p.EntryId != Guid.Empty)
        {
            await db.KeyDeleteAsync(L2ProjectionKeys.ExecutionData(p.EntryId)).ConfigureAwait(false);
        }

        if (!ProcessorJsonSchemaValidator.TryValidate(identity.OutputDefinition, p.Data, out var errors))
        {
            await SendAsync(new StepFailed(p.WorkflowId, p.StepId, self)
            {
                CorrelationId = p.CorrelationId,
                ExecutionId   = p.ExecutionId,
                ErrorMessage  = string.Join("; ", errors),
            }, MessageTypes.StepFailed, ct).ConfigureAwait(false);

            _logger.LogInformation("output failed its schema — reported failed {MessageId}", p.MessageId);
            return;
        }

        await db.StringSetAsync(
                L2ProjectionKeys.OutputData(p.MessageId),
                p.Data,
                L2ProjectionKeys.OutputDataTtl(_options.ExecutionDataTtlSeconds))
            .ConfigureAwait(false);

        await SendAsync(new StepCompleted(p.WorkflowId, p.StepId, self)
        {
            CorrelationId = p.CorrelationId,
            ExecutionId   = p.ExecutionId,
            EntryId       = p.MessageId,   // the output key the orchestrator relocates
        }, MessageTypes.StepCompleted, ct).ConfigureAwait(false);

        // The message id is the one id the scope does not carry, so it goes in as a structured
        // argument. Never the data — this line is about the delivery, not its content.
        _logger.LogInformation("branch completed {MessageId}", p.MessageId);
    }

    private Task SendAsync<T>(T result, string type, CancellationToken ct)
        => _sender.SendTransientAsync(OrchestratorQueues.Result, type, result, ct);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: 233 tests — 227 pass, 6 skip, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/BaseProcessor.Core/Processing/ProcessedDataHandler.cs \
        src/BaseProcessor.Core/Configuration/ProcessorLivenessOptions.cs \
        src/tests/BaseApi.Tests/Processor/ProcessedDataHandlerTests.cs
git commit -m "feat: persist a branch's output and report its outcome"
```

---

### Task 8: Topology, enricher, and wiring

The queue and its dead-letter path, the log enricher that reaches records outside any message scope,
and the registrations that connect all of it.

**Files:**
- Create: `src/BaseProcessor.Core/Messaging/ProcessorTopology.cs`
- Create: `src/BaseProcessor.Core/Observability/ProcessorIdLogEnricher.cs`
- Modify: `src/BaseProcessor.Core/DependencyInjection/BaseProcessorServiceCollectionExtensions.cs`
- Modify: `src/BaseProcessor.Core/BaseProcessor.Core.csproj` (add `OpenTelemetry` package reference if absent)
- Test: `src/tests/BaseApi.Tests/Processor/ProcessorTopologyTests.cs`

**Interfaces:**
- Consumes: `ProcessorQueues.Work/Dead/DeadLetterExchange` (Task 1); `ProcessDispatchHandler` (Task 6); `ProcessedDataHandler` (Task 7); `AddBaseConsoleGating(IServiceCollection, IConfiguration, string)` (prerequisites plan, Task 5); `IRabbitMqTopology` — existing.
- Produces:
  - `BaseProcessor.Core.Messaging.ProcessorTopology : IRabbitMqTopology`.
  - `BaseProcessor.Core.Observability.ProcessorIdLogEnricher`.
  - `AddProcessorExecution(this IServiceCollection, IConfiguration, Guid processorId)`.

- [ ] **Step 1: Write the failing test**

Create `src/tests/BaseApi.Tests/Processor/ProcessorTopologyTests.cs`:

```csharp
using BaseProcessor.Core.Messaging;
using Messaging.Contracts;
using Messaging.Transport;
using NSubstitute;
using RabbitMQ.Client;
using Xunit;

namespace BaseApi.Tests.Processor;

public sealed class ProcessorTopologyTests
{
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");

    [Fact]
    public async Task DeclaresTheExchangeBeforeTheQueueThatNamesIt()
    {
        // The dead-letter argument is not validated at declare time, so a queue pointing at a missing
        // exchange is accepted and silently discards everything it parks — the failure has no error
        // anywhere and simply makes "a parked message is recoverable" untrue.
        var channel = Substitute.For<IChannel>();
        var order = new List<string>();

        await channel.ExchangeDeclareAsync(Arg.Do<string>(e => order.Add($"exchange:{e}")),
            Arg.Any<string>(), Arg.Any<bool>(), Arg.Any<bool>(),
            Arg.Any<IDictionary<string, object?>>(), Arg.Any<bool>(), Arg.Any<bool>(),
            Arg.Any<CancellationToken>());
        await channel.QueueDeclareAsync(Arg.Do<string>(q => order.Add($"queue:{q}")),
            Arg.Any<bool>(), Arg.Any<bool>(), Arg.Any<bool>(),
            Arg.Any<IDictionary<string, object?>>(), Arg.Any<bool>(), Arg.Any<bool>(),
            Arg.Any<CancellationToken>());

        await new ProcessorTopology(P).DeclareAsync(channel, CancellationToken.None);

        Assert.Equal($"exchange:{ProcessorQueues.DeadLetterExchange}", order[0]);
        Assert.Contains($"queue:{ProcessorQueues.Work(P)}", order);
        Assert.True(order.IndexOf($"exchange:{ProcessorQueues.DeadLetterExchange}")
                    < order.IndexOf($"queue:{ProcessorQueues.Work(P)}"));
    }

    [Fact]
    public async Task TheWorkQueueCarriesNoDeliveryLimit()
    {
        // This consumer requeues on purpose for the whole duration of a store outage. A delivery limit
        // counts every redelivery, so a long outage would dead-letter work that was never malformed.
        var channel = Substitute.For<IChannel>();
        IDictionary<string, object?>? args = null;

        await channel.QueueDeclareAsync(ProcessorQueues.Work(P), Arg.Any<bool>(), Arg.Any<bool>(),
            Arg.Any<bool>(), Arg.Do<IDictionary<string, object?>>(a => args = a),
            Arg.Any<bool>(), Arg.Any<bool>(), Arg.Any<CancellationToken>());

        await new ProcessorTopology(P).DeclareAsync(channel, CancellationToken.None);

        Assert.NotNull(args);
        Assert.False(args!.ContainsKey("x-delivery-limit"));
        Assert.Equal(ProcessorQueues.DeadLetterExchange, args["x-dead-letter-exchange"]);
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: **build failure** — `ProcessorTopology` does not exist.

- [ ] **Step 3: Write the topology**

Create `src/BaseProcessor.Core/Messaging/ProcessorTopology.cs`:

```csharp
using Messaging.Contracts;
using Messaging.Transport;
using RabbitMQ.Client;

namespace BaseProcessor.Core.Messaging;

/// <summary>
/// Declares this processor's work queue, its dead-letter exchange, and where refused messages land.
/// <para>
/// <b>Declared at connection setup rather than when consuming starts.</b> This consumer pauses
/// whenever the projection store is unreachable, and a paused consumer declares nothing — so a
/// dispatch arriving in that window would address a queue that does not exist, which the broker
/// discards while still confirming the send. The orchestrator would be told the work was accepted.
/// </para>
/// <para>
/// The processor id is known before the host exists, thanks to the two-stage boot, which is what
/// makes declaring here possible at all.
/// </para>
/// </summary>
internal sealed class ProcessorTopology(Guid processorId) : IRabbitMqTopology
{
    public async Task DeclareAsync(IChannel channel, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(channel);

        // First, and not negotiably: the dead-letter argument below is not validated when the queue is
        // declared, so naming an exchange that does not exist is accepted and every parked message is
        // discarded silently.
        await channel.ExchangeDeclareAsync(
            exchange: ProcessorQueues.DeadLetterExchange,
            type: ExchangeType.Direct,
            durable: true,
            autoDelete: false,
            arguments: null,
            cancellationToken: ct).ConfigureAwait(false);

        var work = ProcessorQueues.Work(processorId);
        var dead = ProcessorQueues.Dead(processorId);

        await channel.QueueDeclareAsync(
            queue: dead,
            durable: true,
            exclusive: false,
            autoDelete: false,
            arguments: new Dictionary<string, object?> { ["x-queue-type"] = "quorum" },
            cancellationToken: ct).ConfigureAwait(false);

        await channel.QueueBindAsync(
            queue: dead,
            exchange: ProcessorQueues.DeadLetterExchange,
            routingKey: work,
            arguments: null,
            cancellationToken: ct).ConfigureAwait(false);

        // No x-delivery-limit, deliberately: a limit counts every redelivery, and this consumer
        // redelivers on purpose for as long as the projection store is unreachable. What a limit
        // normally guards against is already handled — an unreadable message is parked on its first
        // delivery rather than retried at all.
        await channel.QueueDeclareAsync(
            queue: work,
            durable: true,
            exclusive: false,
            autoDelete: false,
            arguments: new Dictionary<string, object?>
            {
                ["x-queue-type"] = "quorum",
                ["x-dead-letter-exchange"] = ProcessorQueues.DeadLetterExchange,
                ["x-dead-letter-routing-key"] = work,
            },
            cancellationToken: ct).ConfigureAwait(false);
    }
}
```

- [ ] **Step 4: Write the log enricher**

Create `src/BaseProcessor.Core/Observability/ProcessorIdLogEnricher.cs`:

```csharp
using BaseProcessor.Core.Identity;
using Messaging.Contracts;
using OpenTelemetry;
using OpenTelemetry.Logs;

namespace BaseProcessor.Core.Observability;

/// <summary>
/// Puts <c>ProcessorId</c> on every record this process emits, including the ones with no message
/// scope around them — the startup loops and the liveness heartbeat, which are exactly the records an
/// operator reads when a processor will not become ready.
/// <para>
/// Null-safe by design: before identity resolves it adds nothing rather than adding
/// <see cref="Guid.Empty"/>, because a zero id would read as a real processor that does not exist.
/// </para>
/// </summary>
public sealed class ProcessorIdLogEnricher(IProcessorContext context) : BaseProcessor<LogRecord>
{
    /// <summary>The resolved identity as one <c>{Name}_{Version}</c> string.</summary>
    public const string IdentityName = "IdentityName";

    public override void OnEnd(LogRecord record)
    {
        if (context.Identity is not { } identity)
        {
            return;
        }

        var attrs = (record.Attributes ?? [])
            .Append(new KeyValuePair<string, object?>(ExecutionLogScope.ProcessorId, identity.Id.ToString("D")))
            .Append(new KeyValuePair<string, object?>(IdentityName, $"{identity.Name}_{identity.Version}"));

        record.Attributes = attrs.ToList();
    }
}
```

> The identity snapshot is published as one immutable unit, so `Name` and `Version` are visible
> whenever `Id` is — unlike the reference, which had to guard them independently against a torn read
> across unsynchronized auto-properties.

> **This type ends up registered nowhere, and that is accepted.** Step 5 below wires the topology,
> the handlers and the consumer, but there is no place to add a `LogRecord` processor:
> `AddBaseConsoleObservability` owns the `builder.Logging.AddOpenTelemetry` callback and exposes no
> hook into it, and it cannot take the enricher directly because `BaseConsole.Core` must not reference
> `BaseProcessor.Core`. Give the class doc a banner saying so — a dead registration that reads as a
> live dependency is exactly what commit `ab03ecf` had to delete once already — and carry it as a
> known gap rather than wiring it somewhere convenient.

- [ ] **Step 5: Wire everything**

Append to `BaseProcessorServiceCollectionExtensions`:

```csharp
    /// <summary>
    /// Registers the execution path: the queue topology, the two handlers, and the gated consumer
    /// that feeds them.
    /// <para>
    /// The consumer's prefetch stays at its default of one. That is structural, not a tuning knob —
    /// the per-dispatch state on the singleton processor is a plain field, and a second concurrent
    /// dispatch would overwrite it.
    /// </para>
    /// <para>
    /// The author registers their own <c>BaseProcessor</c> implementation; this method does not, so a
    /// host that forgets fails to resolve the handler at startup rather than consuming and failing
    /// every message.
    /// </para>
    /// </summary>
    public static IServiceCollection AddProcessorExecution(
        this IServiceCollection services, IConfiguration cfg, Guid processorId)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(cfg);

        services.AddSingleton<IRabbitMqTopology>(_ => new ProcessorTopology(processorId));

        services.AddScoped<IQueueMessageHandler, ProcessDispatchHandler>();
        services.AddScoped<IQueueMessageHandler, ProcessedDataHandler>();

        services.AddBaseConsoleGating(cfg, ProcessorQueues.Work(processorId));

        return services;
    }
```

Then, in the `AddBaseProcessor(services, cfg, identity)` overload, call it with the identity already
in hand — this is the only place the processor id is known before the container is built:

```csharp
        services.AddProcessorExecution(cfg, identity.Id);
```

Add the `using` directives the file needs: `BaseProcessor.Core.Messaging`,
`BaseProcessor.Core.Processing`, `Messaging.Transport`.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: 235 tests — 229 pass, 6 skip, exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/BaseProcessor.Core/Messaging/ProcessorTopology.cs \
        src/BaseProcessor.Core/Observability/ProcessorIdLogEnricher.cs \
        src/BaseProcessor.Core/DependencyInjection/BaseProcessorServiceCollectionExtensions.cs \
        src/BaseProcessor.Core/BaseProcessor.Core.csproj \
        src/tests/BaseApi.Tests/Processor/ProcessorTopologyTests.cs
git commit -m "feat: declare the processor queue and wire the execution path"
```

---

### Task 9: The sample processor

The worked example an author copies. Minimal on purpose: read the config, read the data, send one
branch, and show the three deliberate terminals in comments.

**Files:**
- Create: `src/Processor.Sample/SampleConfig.cs`
- Create: `src/Processor.Sample/SampleProcessor.cs`
- Modify: `src/Processor.Sample/ProcessorHost.cs`
- Test: `src/tests/BaseApi.Tests/Sample/SampleProcessorTests.cs`

**Interfaces:**
- Consumes: `BaseProcessor<TConfig>`, `SendToPostAsync`, `NewExecutionId`, `PostSendException`, `FailedException`, `CancelledException` (Tasks 4–5).
- Produces: `Processor.Sample.SampleConfig(int Number, string? Label)`, `Processor.Sample.SampleProcessor`.

- [ ] **Step 1: Write the failing test**

Create `src/tests/BaseApi.Tests/Sample/SampleProcessorTests.cs`:

```csharp
using System.Text;
using System.Text.Json;
using BaseProcessor.Core.Processing;
using Messaging.Contracts;
using Messaging.Transport;
using NSubstitute;
using Processor.Sample;
using Xunit;

namespace BaseApi.Tests.Sample;

public sealed class SampleProcessorTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");
    private static readonly Guid E = Guid.Parse("55555555-5555-5555-5555-555555555555");

    private static (SampleProcessor Processor, IQueueSender Sender) Build(Guid entryId)
    {
        var sender = Substitute.For<IQueueSender>();
        var processor = new SampleProcessor();
        processor.BeginDispatch(new DispatchState(sender, W, S, P, C, entryId));
        return (processor, sender);
    }

    private static int NumberIn(ProcessedData p)
        => JsonDocument.Parse(p.Data).RootElement.GetProperty("number").GetInt32();

    [Fact]
    public async Task AddsItsConfiguredNumberToTheIncomingOne()
    {
        var (processor, sender) = Build(E);
        ProcessedData? sent = null;
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(p => sent = p),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());

        await processor.ExecuteAsync(Encoding.UTF8.GetBytes("""{"number":40}"""),
                                     """{"Number":2,"Label":"Step_A"}""", E, CancellationToken.None);

        Assert.Equal(42, NumberIn(sent!));
    }

    [Fact]
    public async Task SeedsItsOwnValueWhenThereIsNoInput()
    {
        // A source step: no upstream data, so the author produces the whole value.
        var (processor, sender) = Build(Guid.Empty);
        ProcessedData? sent = null;
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(p => sent = p),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());

        await processor.ExecuteAsync([], """{"Number":7}""", Guid.Empty, CancellationToken.None);

        Assert.Equal(7, NumberIn(sent!));
    }

    [Fact]
    public async Task ToleratesAnAbsentConfig()
    {
        var (processor, sender) = Build(E);
        ProcessedData? sent = null;
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(p => sent = p),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());

        await processor.ExecuteAsync(Encoding.UTF8.GetBytes("""{"number":5}"""), "", E, CancellationToken.None);

        Assert.Equal(5, NumberIn(sent!));
    }

    [Fact]
    public async Task OpensANewLineageOnAnEntryStepAndReusesItDownstream()
    {
        var (entry, entrySender) = Build(Guid.Empty);
        ProcessedData? fromEntry = null;
        await entrySender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(p => fromEntry = p),
                                    Arg.Any<CancellationToken>(), Arg.Any<string?>());
        await entry.ExecuteAsync([], "", Guid.Empty, CancellationToken.None);

        var (down, downSender) = Build(E);
        ProcessedData? fromDown = null;
        await downSender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(p => fromDown = p),
                                   Arg.Any<CancellationToken>(), Arg.Any<string?>());
        await down.ExecuteAsync(Encoding.UTF8.GetBytes("""{"number":1}"""), "", E, CancellationToken.None);

        Assert.NotEqual(Guid.Empty, fromEntry!.ExecutionId);
        Assert.Equal(E, fromDown!.ExecutionId);
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: **build failure** — `SampleConfig` and `SampleProcessor` do not exist.

- [ ] **Step 3: Write the config**

Create `src/Processor.Sample/SampleConfig.cs`:

```csharp
using BaseProcessor.Core.Configuration;

namespace Processor.Sample;

/// <summary>
/// The author's config: whatever this processor needs from the step that invoked it. The framework
/// deserializes the step's payload into this before calling the transform, case-insensitively, so
/// <c>{"number":5,"label":"Step_A"}</c> binds.
/// </summary>
public sealed record SampleConfig(int Number, string? Label) : ProcessorConfig;
```

- [ ] **Step 4: Write the sample**

Create `src/Processor.Sample/SampleProcessor.cs`:

```csharp
using System.Text.Json;
using BaseProcessor.Core.Configuration;
using BaseProcessor.Core.Processing;

namespace Processor.Sample;

/// <summary>
/// The worked example: read the config, read the data, send one branch. Everything else — envelope
/// ids, retries, the projection store, the result to the orchestrator — belongs to the framework.
/// </summary>
public sealed class SampleProcessor : BaseProcessor<SampleConfig>
{
    protected override async Task ProcessAsync(
        byte[] data, SampleConfig? config, Guid executionId, CancellationToken ct)
    {
        // Null when the step's payload was empty or whitespace — the author picks the default.
        var baseNumber = config?.Number ?? 0;
        var label      = config?.Label;

        // A source step arrives with no input, because its EntryId was the Guid.Empty sentinel and the
        // framework skipped the read. Anything missing or malformed here throws into the framework's
        // general catch and becomes a failed step with a sanitized message.
        var incoming = 0;
        if (data.Length > 0)
        {
            using var doc = JsonDocument.Parse(data);
            incoming = doc.RootElement.GetProperty("number").GetInt32();
        }

        // ---- The three deliberate terminals, none of which reach the post queue ----
        //
        // Fail, reported: StepFailed carrying this exact text, then ack. Author-authored messages go
        // on the wire verbatim; a framework-caught exception's message never does.
        //     if (incoming < 0) throw new FailedException("input number must not be negative");
        //
        // Drop, announced: ends the branch and tells the orchestrator why, so a successor gated on a
        // cancelled predecessor can react.
        //     if (incoming == 0) throw new CancelledException("nothing to process");
        //
        // Drop, silent: just return. The branch ends and the orchestrator hears nothing at all, which
        // is what a sink or a filter wants.
        //     if (incoming == 0) return;

        var processed = JsonSerializer.SerializeToUtf8Bytes(
            new { number = incoming + baseNumber, label }, ProcessorConfig.SerializerOptions);

        // An entry step opens a lineage; a downstream step reuses the inbound one so the lineage
        // holds. NewExecutionId is derived rather than random, so a redelivered dispatch reopens the
        // same lineage instead of a second one.
        var branchExecutionId = executionId == Guid.Empty ? NewExecutionId() : executionId;

        try
        {
            await SendToPostAsync(processed, branchExecutionId, ct);
        }
        catch (PostSendException)
        {
            // A detection point, not a handler: with a fan-out, this is where an author learns which
            // branch was lost. Then it MUST propagate.
            //
            // Bare `throw;` is load-bearing. It preserves the type, so the framework returns the whole
            // dispatch to the queue and replays every branch under the same derived ids. Wrapping it,
            // or throwing something new, falls through to the general catch — which reports the step
            // failed and acknowledges the message, recording a business outcome that never happened
            // while the work is silently lost.
            throw;
        }
    }
}
```

- [ ] **Step 5: Register the sample in the host**

In `src/Processor.Sample/ProcessorHost.cs`, after the `AddBaseProcessor(...)` call, register the
concrete processor as the abstract type the handler resolves:

```csharp
        builder.Services.AddSingleton<BaseProcessor.Core.Processing.BaseProcessor, SampleProcessor>();
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: 239 tests — 233 pass, 6 skip, exit 0.

- [ ] **Step 7: Verify the host graph still resolves**

The existing `ProcessorHostWiringTests` asserts that the service graph builds. It must still pass —
if it now fails to resolve `BaseProcessor`, the registration in Step 5 is missing or the lifetime is
wrong.

```bash
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: no failures mentioning `ProcessorHostWiring`.

- [ ] **Step 8: Commit**

```bash
git add src/Processor.Sample/SampleConfig.cs \
        src/Processor.Sample/SampleProcessor.cs \
        src/Processor.Sample/ProcessorHost.cs \
        src/tests/BaseApi.Tests/Sample/SampleProcessorTests.cs
git commit -m "feat: add the worked processor example"
```

---

## Done When

- `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj` reports 239 tests — 233 pass, 6 skip,
  exit 0.
- A dispatch with an absent entry key returns without sending anything.
- Running the same dispatch twice produces the same branch message ids.
- The pre handler issues no `KeyDelete` and no `StringSet`.
- The post handler's delete precedes its write, and both are keyed by the body's `MessageId`.
- `grep -rn "Guid.NewGuid" src/BaseProcessor.Core/Processing/` prints nothing.

## Known Gaps After This Plan

These are spec §12 items, deliberately not implemented here because the orchestrator does not exist
in `src/` yet. Nothing in this plan produces an end-to-end workflow on its own.

- Nobody sends `ProcessDispatch`, and nobody consumes `OrchestratorQueues.Result`.
- No dedup by `MessageId`, so the duplicate results this design permits are not yet absorbed.
- A step with more than one successor is unsafe until the orchestrator copies its output blob into one
  key per successor under derived ids. All successors currently share one key and the first to run
  reclaims it, so the others read absent and return with no result — two branches lost silently for a
  three-successor step. A single-successor step is safe and needs no copy. Spec §7.1.
- Nothing reclaims the input key of a step that failed. The pre handler deletes it only after a normal
  return, so `FailedException`, `CancelledException` and framework faults all leave it behind, and
  execution blobs carry no TTL to catch it. The orchestrator owns this cleanup; the orphan sweeper is
  the backstop.
- `StepFailed` carries no input entry id — its `EntryId` is fixed at `Guid.Empty` and means *output
  key* — so an orchestrator reclaiming after a failure must do it from its own dispatch record. Adding
  an input-id field to the contract is the alternative. Deliberately left open until the orchestrator
  exists.
- No stuck-step reaper. Until there is one, `ProcessDispatchHandler`'s "entry absent means this step
  already completed" reading has no backstop: under multiple replicas a fan-out whose second branch
  send fails can be requeued, have `data:{entryId}` deleted by another replica's post handler for the
  first branch, and then read the absent key as completion — leaving branch 2 unsent and the step
  stalled forever with no error anywhere. The reaper is what closes it; the handler deliberately does
  not guess, because guessing the other way forks finished workflows.
- The startup loops still treat a `MalformedRequest` reply as no answer and retry silently.
- **`ProcessorIdLogEnricher` is built but registered nowhere**, so records emitted outside a message
  scope — the startup loops, the liveness heartbeat — carry no `ProcessorId`. Wiring it needs a
  caller-supplied `LogRecord`-processor seam on `AddBaseConsoleObservability`, which that method does
  not expose and cannot take directly: it lives in `BaseConsole.Core`, which must not reference
  `BaseProcessor.Core`. Accepted as-is for now; see the banner on the type.
- **Nothing gates work-queue consumption on `IProcessorContext.IsHealthy`.** `GatedQueueConsumer`
  starts as soon as the L2 gate opens, so a dispatch can arrive while Loop B is still resolving the
  schema definitions. Both handlers now PARK such a message rather than run it unvalidated, which is
  recoverable from the DLQ but is not the right answer — gating consumption on health is, and it
  would make the window unreachable instead of survivable.
- Spec §13's open item stands: whether an OpenTelemetry scope key colliding with a record attribute of
  the same name duplicates, overwrites, or drops. Today only `ExecutionLogScope` supplies
  `ProcessorId`, because the enricher that would be the second source is not registered (above) — so
  the collision is not currently reachable. Probe it against a real collector before wiring the
  enricher, not after.
