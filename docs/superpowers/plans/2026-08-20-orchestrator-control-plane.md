# Orchestrator Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the orchestrator service — three replicas that mirror L2 into an in-memory L1, keep a
Quartz schedule per workflow, and have exactly one of them fire a workflow's entry steps on its cron.

**Architecture:** The API stays the only writer of L2 and publishes an announcement to a fanout
exchange after each write; every replica has its own durable queue bound to that exchange and re-reads
L2 on the announcement. Each replica hydrates its L1 from L2 at startup before it consumes anything,
watched by two liveness loops. Firing is gated on a Kubernetes lease so followers reschedule but do
not dispatch.

**Tech Stack:** .NET 8, RabbitMQ.Client 7, StackExchange.Redis, Quartz 3.18.1, Cronos 0.13.0,
KubernetesClient 18.0.13, xunit.v3 under the Microsoft Testing Platform runner, NSubstitute.

**Spec:** `docs/superpowers/specs/2026-08-20-orchestrator-control-plane-design.md` — read §2
(invariants) and §7.4 (failure classification) before any task.

**Depends on:** `2026-08-20-input-reclaim-single-namespace.md`, complete and merged.

---

## Global Constraints

- **Target framework:** `net8.0`. No language or BCL feature above C# 12.
- **`--filter` is silently ignored** by this repo's test runner. Run the whole project
  (`dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`) and read the summary; use
  `--filter-method` for a single test.
- **Baseline entering this plan:** 286 tests — 280 pass, 6 `Live/` tests skip without `SKP_REALSTACK`,
  exit 0, 0 build warnings. The gate is 0 failures, exactly 6 skips, exit 0, and the task's new tests
  present and passing — never an absolute count.
- **The orchestrator never writes or deletes L2.** Spec invariant 1. A `KeyDelete`, `StringSet`,
  `SetAdd` or `SetRemove` anywhere in `src/Orchestrator` is a defect.
- **No `ProjectReference` to any `BaseApi.*` project** from `src/Orchestrator`. `BaseConsole.Core`
  and `Messaging.Contracts` only.
- **`Messaging.Contracts` stays BCL-only.** No broker, Redis, Quartz or DI package references.
- **Never log a payload, a config, or a step's data.** Ids and outcomes only.
- **Never interpolate an id into a log template.** Ids are structured `{Placeholder}` arguments or
  scope values under a fixed key.
- **Rendering is fixed:** `CorrelationId` renders `ToString("N")`; `WorkflowId`, `StepId`,
  `ProcessorId`, `ExecutionId`, `EntryId` render `ToString("D")`.
- **Log attribute keys are PascalCase.**
- **Working-tree hazard:** uncommitted files belonging to the repository owner under
  `src/BaseApi.Service/Features/Orchestration/Projection/` (`IL2InstanceIndexStore.cs`,
  `L2OrphanSweepService.cs`, `L2OrphanSweeper.cs`, `RedisL2InstanceIndexStore.cs`), a modified
  `OrchestrationServiceCollectionExtensions.cs`, and
  `src/tests/BaseApi.Tests/Orchestration/L2OrphanSweeperTests.cs`. Never stage, commit, edit or
  revert them. Always `git add` explicit paths — never `git add -A` or `git add .`.

## Existing API surface these tasks build on

Verified against the repo; use these signatures verbatim.

```csharp
// Messaging.Transport
public interface IQueueSender {
    Task SendAsync<T>(string queue, string type, T body, CancellationToken ct,
                      string? replyTo = null, string? correlationId = null);
}
public interface IRabbitMqTopology { Task DeclareAsync(IChannel channel, CancellationToken ct); }
public interface IQueueMessageHandler {
    string MessageType { get; }
    Task HandleAsync(ReadOnlyMemory<byte> body, CancellationToken ct);
}
public static class SendFaultClassifier { public static bool IsTransport(Exception ex); }
public sealed class TransientSendException : Exception { }   // base, non-sealed by Plan A Task 1

// Messaging.Contracts
public sealed record WorkflowL1(Guid WorkflowId, List<Guid> EntryStepIds, string? Cron, List<StepL1> Steps);
public sealed record StepL1(Guid StepId, int EntryCondition, Guid ProcessorId, string Payload, List<Guid> NextStepIds);
public sealed record ProcessDispatch(Guid WorkflowId, Guid StepId, Guid ProcessorId) {
    public Guid CorrelationId { get; init; }
    public Guid ExecutionId   { get; init; }
    public Guid EntryId       { get; init; }
    public string Payload     { get; init; }
}
public sealed record WorkflowRootProjection(List<Guid> EntryStepIds, List<Guid> StepIds, string? Cron, LivenessProjection Liveness);
public sealed record StepProjection(int EntryCondition, Guid ProcessorId, string Payload, List<Guid> NextStepIds);
public static class L2ProjectionKeys {
    public static string ParentIndex();                       // "skp:"  — a SET of workflow ids ("D")
    public static string Root(Guid workflowId);               // "skp:{id}"
    public static string Step(Guid workflowId, Guid stepId);  // "skp:{id}:{stepId}"
}
public static class ProcessorQueues { public static string Work(Guid processorId); }

// BaseConsole.Core
public sealed record InstanceId(string Value) { public static InstanceId Resolve(); }  // POD_NAME → HOSTNAME → MachineName
public interface ILoopHeartbeat { DateTimeOffset? Last { get; } bool IsRetired { get; } void Beat(); void Retire(); }
public sealed class LoopLivenessHealthCheck(ILoopHeartbeat heartbeat, TimeSpan window, string loop, TimeProvider clock);
public interface IStartupGate { bool IsReady { get; } void MarkReady(); }
public sealed class GatedConsumerOptions { public string Queue; public ushort PrefetchCount; public TimeSpan ConvergeInterval; }
```

---

## File Structure

| File | Task | Responsibility |
|---|---|---|
| `src/Messaging.Contracts/OrchestratorFanout.cs` | 1 | The only definition of the exchange and per-replica queue names |
| `src/Messaging.Contracts/OrchestrationAnnouncements.cs` | 1 | `OrchestrationStarted` / `OrchestrationStopped` |
| `src/Messaging.Transport/IQueueFanoutPublisher.cs` | 2 | Publish-to-exchange seam |
| `src/Messaging.Transport/QueueFanoutPublisher.cs` | 2 | Its implementation, mandatory + confirms |
| `src/BaseConsole.Core/Messaging/IConsumerAdmission.cs` | 3 | One-shot admission to consume, plus always-open default |
| `src/BaseApi.Service/Features/Orchestration/Messaging/FanoutTopology.cs` | 4 | API-side exchange declaration |
| `src/Orchestrator/Orchestrator.csproj` | 5 | The service project |
| `src/Orchestrator/Messaging/OrchestratorTopology.cs` | 5 | Exchanges, per-replica queue, dead queue |
| `src/Orchestrator/OrchestratorHost.cs`, `Program.cs` | 5, 10 | Composition root |
| `src/Orchestrator/L1/WorkflowL1Store.cs` | 6 | The in-memory mirror, workflowId → (definition, jobId) |
| `src/Orchestrator/L1/L2WorkflowReader.cs` | 6 | Reads one workflow out of L2 |
| `src/Orchestrator/Scheduling/CronInterval.cs` | 6 | Cronos next-occurrence |
| `src/Orchestrator/Scheduling/WorkflowScheduler.cs` | 6 | Schedule / reschedule / unschedule |
| `src/Orchestrator/L1/WorkflowActivator.cs` | 6 | The one activation path, shared by hydration and start |
| `src/Orchestrator/Hydration/HydrationService.cs` | 7 | Loop 2, and the admission it opens |
| `src/Orchestrator/Messaging/ApplyStartHandler.cs` | 8 | Fanout start consumer |
| `src/Orchestrator/Messaging/ApplyStopHandler.cs` | 8 | Fanout stop consumer, verify-first |
| `src/Orchestrator/Election/LeaderState.cs`, `LeaderElectionService.cs` | 9 | Lease election |
| `src/Orchestrator/Scheduling/WorkflowFireJob.cs` | 9 | The fire, gated and superseded-aware |

---

### Task 1: Fanout names and announcement contracts

**Files:**
- Create: `src/Messaging.Contracts/OrchestratorFanout.cs`
- Create: `src/Messaging.Contracts/OrchestrationAnnouncements.cs`
- Modify: `src/Messaging.Contracts/MessageTypes.cs`
- Test: `src/tests/BaseApi.Tests/Orchestrator/OrchestratorFanoutTests.cs`

**Interfaces:**
- Consumes: nothing.
- Produces: `OrchestratorFanout.Exchange`, `.DeadLetterExchange`, `.PerReplica(string)`,
  `.Dead(string)`; `OrchestrationStarted(Guid)`, `OrchestrationStopped(Guid)`;
  `MessageTypes.OrchestrationStarted`, `MessageTypes.OrchestrationStopped`.

- [ ] **Step 1: Write the failing tests**

Create `src/tests/BaseApi.Tests/Orchestrator/OrchestratorFanoutTests.cs`:

```csharp
using Messaging.Contracts;
using Xunit;

namespace BaseApi.Tests.Orchestrator;

public sealed class OrchestratorFanoutTests
{
    [Fact]
    public void ThreeReplicasGetThreeDistinctQueueNames()
    {
        // The silent-degradation guard. These queues are non-exclusive, so two replicas resolving to
        // the SAME name raises nothing — it quietly turns the broadcast into a competing-consumer
        // load-balance, each announcement reaching one replica instead of three, with the other two
        // holding stale L1 and stale schedules and nothing in the transport reporting it. The broker
        // cannot tell us; only this assertion can.
        var names = new[]
        {
            OrchestratorFanout.PerReplica("orchestrator-0"),
            OrchestratorFanout.PerReplica("orchestrator-1"),
            OrchestratorFanout.PerReplica("orchestrator-2"),
        };

        Assert.Equal(3, names.Distinct(StringComparer.Ordinal).Count());
    }

    [Fact]
    public void ThePerReplicaNameIsStableForAGivenReplica()
    {
        // A restarted pod at the same StatefulSet ordinal must reclaim its own queue and drain what
        // buffered while it was away, rather than minting a new one and abandoning the backlog.
        Assert.Equal(
            OrchestratorFanout.PerReplica("orchestrator-1"),
            OrchestratorFanout.PerReplica("orchestrator-1"));
    }

    [Fact]
    public void ADeadQueueIsNamedAfterTheQueueItParksFor()
    {
        Assert.Equal(
            OrchestratorFanout.PerReplica("orchestrator-0") + ".dead",
            OrchestratorFanout.Dead("orchestrator-0"));
    }

    [Fact]
    public void APerReplicaNameNeverCollidesWithAnExistingSharedQueue()
    {
        // A replica id that resolved onto one of the shared competing-consumer endpoints would inject
        // announcements into live pipeline traffic. Nothing about the charset prevents it, so it is
        // asserted against the real constants rather than against literals.
        foreach (var id in new[] { "result", "control", "0" })
        {
            var name = OrchestratorFanout.PerReplica(id);
            Assert.NotEqual(OrchestratorQueues.Result, name);
            Assert.NotEqual(OrchestratorQueues.ResultPost, name);
            Assert.NotEqual(OrchestratorQueues.Control, name);
        }
    }

    [Fact]
    public void AnAnnouncementRoundTripsCarryingOnlyAWorkflowId()
    {
        // It announces that L2 has already been written. Carrying the definition would let a replica
        // apply a stale graph after a newer write; carrying only the id forces the re-read.
        var id = Guid.Parse("11111111-1111-1111-1111-111111111111");
        var json = JsonSerializer.SerializeToUtf8Bytes(new OrchestrationStarted(id), MessagingJson.Options);
        var back = JsonSerializer.Deserialize<OrchestrationStarted>(json, MessagingJson.Options);

        Assert.Equal(id, back!.WorkflowId);
    }
}
```

Add `using System.Text.Json;` and `using System.Linq;` at the top as the compiler requires.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: compile failure — `OrchestratorFanout` and `OrchestrationStarted` do not exist.

- [ ] **Step 3: Create the name source of truth**

Create `src/Messaging.Contracts/OrchestratorFanout.cs`:

```csharp
namespace Messaging.Contracts;

/// <summary>
/// The single definition of the orchestrator fan-out exchange and of each replica's own queue name,
/// shared by the API that publishes and the orchestrator that consumes.
/// <para>
/// <b>One definition, and that is a requirement rather than a preference.</b> These queues are
/// non-exclusive, so two replicas resolving to the SAME name does not raise <c>RESOURCE_LOCKED</c> and
/// does not fail loudly anywhere. It silently degrades the broadcast into a competing-consumer
/// load-balance: each announcement reaches one replica instead of three, the other two keep a stale
/// L1 and a stale schedule, and nothing in the transport reports it. A second definition of this
/// string, in either service, reintroduces that failure.
/// </para>
/// <para>
/// <b>Durable, never auto-delete.</b> A replica that is down must accumulate its announcements and
/// drain them on return; an auto-delete queue would drop them with nothing parked and nothing logged.
/// The cost is that a queue outlives a replica that is removed for good, which is why the orchestrator
/// StatefulSet does not scale down.
/// </para>
/// </summary>
public static class OrchestratorFanout
{
    /// <summary>The fan-out exchange every replica queue binds to.</summary>
    public const string Exchange = "orchestrator-fanout";

    /// <summary>
    /// The dead-letter exchange the per-replica queues name. It must be declared before any queue
    /// naming it: the argument is not validated at declare time, so a queue pointing at a missing
    /// exchange is accepted and discards everything it parks, silently.
    /// </summary>
    public const string DeadLetterExchange = "orchestrator-fanout-dlx";

    /// <summary>
    /// This replica's own durable queue: <c>orchestrator-control.{instanceId}</c>. The instance id is
    /// <see cref="BaseConsole.Core"/>'s resolved replica identity — a StatefulSet ordinal in
    /// production — so a restarted pod reclaims the same queue and drains its backlog.
    /// </summary>
    public static string PerReplica(string instanceId) => $"orchestrator-control.{instanceId}";

    /// <summary>Where <see cref="PerReplica"/> parks a message it cannot read.</summary>
    public static string Dead(string instanceId) => $"{PerReplica(instanceId)}.dead";
}
```

- [ ] **Step 4: Create the announcement contracts**

Create `src/Messaging.Contracts/OrchestrationAnnouncements.cs`:

```csharp
namespace Messaging.Contracts;

/// <summary>
/// L2 now holds this workflow. Published to <see cref="OrchestratorFanout.Exchange"/> by the API, once
/// its projection write has committed.
/// <para>
/// <b>It carries an id, not a definition, and that is load-bearing.</b> The recipient re-reads L2. A
/// message carrying the graph could be applied after a newer write had already landed, silently
/// reinstating a stale definition with nothing to detect it — and it would make the message a second
/// source of truth alongside the store the whole design says is the only one.
/// </para>
/// <para>
/// <b>Past tense, deliberately.</b> This is not a command to project something; the projection has
/// already happened. That is why it is published from the end of the projection handler and nowhere
/// else.
/// </para>
/// </summary>
public sealed record OrchestrationStarted(Guid WorkflowId);

/// <summary>
/// L2 no longer holds this workflow. Published once the API's clean has committed.
/// <para>
/// The recipient verifies the removal against L2 before acting on it — see the stop handler. It is not
/// responsible for the removal itself.
/// </para>
/// </summary>
public sealed record OrchestrationStopped(Guid WorkflowId);
```

- [ ] **Step 5: Add the two message types**

In `src/Messaging.Contracts/MessageTypes.cs`, following the existing one-doc-comment-per-constant
style, add:

```csharp
    /// <summary>Announcement: the API has projected a workflow into L2.</summary>
    public const string OrchestrationStarted = "orchestration-started";

    /// <summary>Announcement: the API has removed a workflow from L2.</summary>
    public const string OrchestrationStopped = "orchestration-stopped";
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: 0 failures, exactly 6 skips, exit 0, 0 build warnings.

- [ ] **Step 7: Commit**

```bash
git add src/Messaging.Contracts/OrchestratorFanout.cs \
        src/Messaging.Contracts/OrchestrationAnnouncements.cs \
        src/Messaging.Contracts/MessageTypes.cs \
        src/tests/BaseApi.Tests/Orchestrator/OrchestratorFanoutTests.cs
git commit -m "feat: name the orchestrator fanout and its announcements"
```

---

### Task 2: The publish primitive

**Files:**
- Create: `src/Messaging.Transport/IQueueFanoutPublisher.cs`
- Create: `src/Messaging.Transport/QueueFanoutPublisher.cs`
- Test: `src/tests/BaseApi.Tests/Transport/QueueFanoutPublisherTests.cs`

**Interfaces:**
- Consumes: `OrchestratorFanout.Exchange` (Task 1) for its callers; nothing structural.
- Produces: `IQueueFanoutPublisher.PublishAsync<T>(string exchange, string type, T body, CancellationToken ct)`,
  which throws `TransientSendException` for a recognised transport fault or an unroutable publish, and
  propagates anything else raw.

**Read first:** `src/Messaging.Transport/QueueSender.cs` in full. This class is its sibling and must
match it on serializer options, delivery mode, confirms, and the `BuildProperties` idiom.
`QueueSender.BuildProperties` is `internal static` and `Messaging.Transport` already has
`InternalsVisibleTo("BaseApi.Tests")`.

- [ ] **Step 1: Write the failing tests**

Create `src/tests/BaseApi.Tests/Transport/QueueFanoutPublisherTests.cs`. Follow the existing
`QueueSenderTests` idiom for constructing properties; `PublishAsync` itself cannot be unit-tested
against a real channel for the same reason `SendAsync` cannot — `RabbitMqConnection` is sealed and
builds a real `ConnectionFactory` — so test the two things that are testable and reachable:

```csharp
using Messaging.Transport;
using Xunit;

namespace BaseApi.Tests.Transport;

public sealed class QueueFanoutPublisherTests
{
    [Fact]
    public void ClassifiesAnUnroutablePublishAsTransport()
    {
        // Publisher confirms say the broker ACCEPTED the message, never that it ROUTED one. A fanout
        // exchange with no bound queue discards silently and still confirms, so the API would report a
        // start accepted and lose it. Reachable only before any replica has ever started — the queues
        // are durable thereafter — but that is exactly the first-deploy window.
        Assert.True(SendFaultClassifier.IsTransport(new UnroutablePublishException("orchestrator-fanout")));
    }

    [Fact]
    public void AnUnroutablePublishNamesTheExchangeAndNotTheBody()
    {
        // The exchange is a configuration fact and safe to log. The body is a workflow id today, but
        // this type is general, so it never quotes what it was carrying.
        var ex = new UnroutablePublishException("orchestrator-fanout");

        Assert.Contains("orchestrator-fanout", ex.Message, StringComparison.Ordinal);
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: compile failure — `UnroutablePublishException` does not exist.

- [ ] **Step 3: Write the interface**

Create `src/Messaging.Transport/IQueueFanoutPublisher.cs`:

```csharp
namespace Messaging.Transport;

/// <summary>
/// Publishes one message to a fan-out exchange, so that every queue bound to it receives a copy.
/// <para>
/// <b>Separate from <see cref="IQueueSender"/> on purpose.</b> That interface is send-not-publish by
/// its own contract — "addressed to a queue whose consumer is known, not offered to whoever is
/// interested" — and its implementation is documented as having no exchange in the middle to
/// misconfigure. Both statements stay true only if publishing lives somewhere else.
/// </para>
/// <para>
/// <b>An unroutable publish is a failure here, not a success.</b> Publisher confirms report that the
/// broker accepted a message, not that it routed one, so an exchange with no bound queue would confirm
/// a message it discarded. This interface publishes mandatory and raises
/// <see cref="UnroutablePublishException"/> instead, which classifies as transport so the caller
/// requeues rather than acknowledging work that vanished.
/// </para>
/// </summary>
public interface IQueueFanoutPublisher
{
    /// <param name="exchange">The fan-out exchange to publish to. Must already be declared.</param>
    /// <param name="type">Discriminator written to the type header.</param>
    /// <param name="body">Payload, serialized with the shared messaging serializer options.</param>
    /// <param name="ct">Cancels the publish.</param>
    Task PublishAsync<T>(string exchange, string type, T body, CancellationToken ct);
}

/// <summary>
/// A publish the broker accepted but could not route: the exchange had no bound queue. Recognised as
/// transport by <see cref="SendFaultClassifier"/>, because the condition is resolved by a consumer
/// declaring its queue — which is a matter of time, not of the message being wrong.
/// </summary>
public sealed class UnroutablePublishException(string exchange)
    : Exception($"nothing is bound to exchange '{exchange}', so the message was discarded");
```

- [ ] **Step 4: Recognise it as transport**

In `src/Messaging.Transport/SendFaultClassifier.cs`, add `UnroutablePublishException` to the
allow-list `IsTransportType` checks, alongside `ObjectDisposedException`. Keep the existing
`Unwrap`/aggregate-flattening walk unchanged — the new type must be found nested as well as bare.

- [ ] **Step 5: Write the publisher**

Create `src/Messaging.Transport/QueueFanoutPublisher.cs`. Mirror `QueueSender`: same constructor
dependency on the connection, same `MessagingJson.Options`, same `DeliveryModes.Persistent`, same
confirm settings. The publish differs in exactly three ways — a named exchange instead of
`string.Empty`, an empty routing key, and `mandatory: true` with a `BasicReturnAsync` handler that
completes a `TaskCompletionSource` so an unrouted return surfaces as `UnroutablePublishException`
rather than being ignored.

Wrap the body exactly as `QueueSenderExtensions.SendTransientAsync` does: catch, ask
`SendFaultClassifier.IsTransport`, wrap in `TransientSendException` when true, rethrow raw when false.
A deterministic fault must not be requeued forever.

Register it in the same DI extension that registers `IQueueSender` for both the API and console
stacks, as a singleton over the same connection.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: 0 failures, exactly 6 skips, exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/Messaging.Transport/IQueueFanoutPublisher.cs \
        src/Messaging.Transport/QueueFanoutPublisher.cs \
        src/Messaging.Transport/SendFaultClassifier.cs \
        src/tests/BaseApi.Tests/Transport/QueueFanoutPublisherTests.cs
git commit -m "feat: publish to a fanout exchange and refuse an unroutable publish"
```

Also `git add` whichever DI extension file you edited in Step 5.

---

### Task 3: Consumer admission

**Files:**
- Create: `src/BaseConsole.Core/Messaging/IConsumerAdmission.cs`
- Modify: `src/BaseConsole.Core/Messaging/GatedQueueConsumer.cs`
- Modify: `src/BaseConsole.Core/DependencyInjection/ConsoleRedisServiceCollectionExtensions.cs`
- Test: `src/tests/BaseApi.Tests/Console/ConsumerAdmissionTests.cs`

**Interfaces:**
- Consumes: nothing.
- Produces: `IConsumerAdmission { bool IsOpen { get; } }` and `AlwaysOpenAdmission`, registered by
  `AddBaseConsoleGating` via `TryAddSingleton` so a host can substitute its own.

**This task must not change processor behaviour.** The default is always-open and
`AddBaseConsoleGating` registers it with `TryAddSingleton`, so the processor's timing is byte-identical
after this change. Do not gate on `IStartupGate` — `ProcessorLivenessHeartbeat.cs:95` already marks it
ready, so that would change the processor immediately.

- [ ] **Step 1: Write the failing tests**

```csharp
using BaseConsole.Core.Messaging;
using Xunit;

namespace BaseApi.Tests.Console;

public sealed class ConsumerAdmissionTests
{
    private sealed class Latch : IConsumerAdmission
    {
        public bool IsOpen { get; set; }
    }

    [Fact]
    public void TheDefaultIsOpenSoAnExistingHostIsUnaffected()
    {
        // The processor gets this one. Its consumption timing must not move because a second service
        // wanted a gate.
        Assert.True(new AlwaysOpenAdmission().IsOpen);
    }

    [Fact]
    public async Task AClosedAdmissionKeepsTheConsumerFromOpeningAChannel()
    {
        // Asserted through the consumer's own decision rather than through a mock of it: with
        // admission closed the consumer must not open a channel at all, even though the L2 gate is
        // open and the queue exists.
        var h = new Harness();          // L2 gate open, connection substituted
        var admission = new Latch { IsOpen = false };

        await using var consumer = h.Build(admission);
        await consumer.StartAsync(CancellationToken.None);
        await h.PumpConvergeIntervalAsync();

        await h.Connection.DidNotReceive().CreateChannelAsync(
            Arg.Any<CreateChannelOptions?>(), Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task ConsumingBeginsWithinOneConvergeIntervalOfAdmissionOpening()
    {
        // Admission opening raises no signal of its own — the consumer picks it up on the converge
        // interval it already runs for gate changes. This pins that the backstop is sufficient, so
        // nobody later adds a wake mechanism that is not needed.
        var h = new Harness();
        var admission = new Latch { IsOpen = false };

        await using var consumer = h.Build(admission);
        await consumer.StartAsync(CancellationToken.None);
        admission.IsOpen = true;
        await h.PumpConvergeIntervalAsync();

        await h.Connection.Received().CreateChannelAsync(
            Arg.Any<CreateChannelOptions?>(), Arg.Any<CancellationToken>());
    }
}
```

`Harness` substitutes `IConnection` and constructs a real `L2Gate` in its open state, mirroring the
substitution idiom the console gating tests already use. `PumpConvergeIntervalAsync` advances the
`FakeTimeProvider` past `GatedConsumerOptions.ConvergeInterval` and yields — **this repo's
`FakeTimeProvider` only advances when something reads it, so a test that merely waits will hang.**
Check `CreateChannelAsync`'s real arity against the installed RabbitMQ.Client before running, and
report what it was.

- [ ] **Step 2: Run to verify it fails**

Expected: compile failure — `IConsumerAdmission` does not exist.

- [ ] **Step 3: Write the interface and default**

Create `src/BaseConsole.Core/Messaging/IConsumerAdmission.cs`:

```csharp
namespace BaseConsole.Core.Messaging;

/// <summary>
/// Whether this host is ready for its consumer to begin consuming at all. One-shot in practice: a host
/// opens it once its own startup work is done and never closes it again.
/// <para>
/// <b>Distinct from the two gates already here, deliberately.</b> <c>L2Gate</c> is dynamic — it closes
/// and reopens as the projection store comes and goes. <c>IStartupGate</c> reports health. This is
/// admission to consume, and conflating it with either would change an existing service's behaviour:
/// the processor already marks the startup gate ready from its liveness heartbeat, so gating
/// consumption on that would move its timing the moment this shipped.
/// </para>
/// </summary>
public interface IConsumerAdmission
{
    /// <summary>True once this host is ready to consume.</summary>
    bool IsOpen { get; }
}

/// <summary>
/// The default: a host that has no startup work to finish before consuming. Registered by
/// <c>AddBaseConsoleGating</c> with <c>TryAddSingleton</c>, so a host that does have such work
/// registers its own implementation first and this one never takes effect.
/// </summary>
public sealed class AlwaysOpenAdmission : IConsumerAdmission
{
    /// <inheritdoc/>
    public bool IsOpen => true;
}
```

- [ ] **Step 4: Consult it in the consumer**

In `GatedQueueConsumer`, take `IConsumerAdmission` as a constructor dependency and fold it into the
existing decision at the `shouldConsume` computation (around `GatedQueueConsumer.cs:153`):

```csharp
        var shouldConsume = _admission.IsOpen && _gate.IsOpen;
```

The consumer already re-evaluates on the converge interval and on gate signals, so no new wake
mechanism is needed — admission opening is picked up within one `ConvergeInterval`. Add a sentence to
the class doc naming admission as the second condition and pointing at why it is not the L2 gate.

- [ ] **Step 5: Register the default**

In `AddBaseConsoleGating`, before the `GatedQueueConsumer` registrations:

```csharp
        services.TryAddSingleton<IConsumerAdmission, AlwaysOpenAdmission>();
```

`TryAddSingleton` is what lets the orchestrator register its own first.

- [ ] **Step 6: Run the tests**

Expected: 0 failures, exactly 6 skips, exit 0. **Every existing processor test must still pass
unchanged** — if any moved, admission is not defaulting open somewhere and that is a defect in this
task, not in the test.

- [ ] **Step 7: Commit**

```bash
git add src/BaseConsole.Core/Messaging/IConsumerAdmission.cs \
        src/BaseConsole.Core/Messaging/GatedQueueConsumer.cs \
        src/BaseConsole.Core/DependencyInjection/ConsoleRedisServiceCollectionExtensions.cs \
        src/tests/BaseApi.Tests/Console/ConsumerAdmissionTests.cs
git commit -m "feat: let a host hold its consumer back until its startup work is done"
```

---

### Task 4: The API publishes after it writes

**Files:**
- Create: `src/BaseApi.Service/Features/Orchestration/Messaging/FanoutTopology.cs`
- Modify: `src/BaseApi.Service/Features/Orchestration/Messaging/StartOrchestrationHandler.cs`
- Modify: `src/BaseApi.Service/Features/Orchestration/Messaging/StopOrchestrationHandler.cs`
- Modify: `src/BaseApi.Service/Composition/AppMessaging.cs`
- Test: `src/tests/BaseApi.Tests/Orchestration/FanoutPublishTests.cs`

**Interfaces:**
- Consumes: `OrchestratorFanout` and the announcements (Task 1); `IQueueFanoutPublisher` (Task 2).
- Produces: the API publishes `OrchestrationStarted` / `OrchestrationStopped` after each L2 mutation.

- [ ] **Step 1: Write the failing tests**

Create `src/tests/BaseApi.Tests/Orchestration/FanoutPublishTests.cs`. Use the existing handler-test
harness idiom in `src/tests/BaseApi.Tests/Orchestration/`; substitute `IQueueFanoutPublisher`.

```csharp
    [Fact]
    public async Task AnnouncesOnlyAfterTheProjectionHasBeenWritten()
    {
        // The announcement means "L2 is ready, go read it". Published before the write, a replica
        // reading L2 on it would find the previous definition or none, and would have no way to tell
        // that from a workflow that was never started.
        var h = new Harness();
        var order = new List<string>();
        h.Writer.When(w => w.WriteAsync(Arg.Any<WorkflowL1>(), Arg.Any<CancellationToken>()))
                .Do(_ => order.Add("write"));
        h.Publisher.When(p => p.PublishAsync(
                    Arg.Any<string>(), Arg.Any<string>(), Arg.Any<OrchestrationStarted>(), Arg.Any<CancellationToken>()))
                .Do(_ => order.Add("announce"));

        await h.BuildStart().HandleAsync(Body(Start(W)), CancellationToken.None);

        Assert.Equal(["write", "announce"], order);
    }

    [Fact]
    public async Task AnnouncesToTheFanoutExchangeCarryingOnlyTheWorkflowId()
    {
        var h = new Harness();

        await h.BuildStart().HandleAsync(Body(Start(W)), CancellationToken.None);

        await h.Publisher.Received(1).PublishAsync(
            OrchestratorFanout.Exchange, MessageTypes.OrchestrationStarted,
            Arg.Is<OrchestrationStarted>(a => a.WorkflowId == W), Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task AFailedAnnouncementEscapesSoTheControlMessageIsRequeued()
    {
        // TransientSendException classifies as Requeue, so the redelivery re-runs the idempotent
        // clean-and-write and announces again. Anything else would PARK the control message and the
        // replicas would never learn about a workflow the API has already projected.
        var h = new Harness();
        h.Publisher.PublishAsync(Arg.Any<string>(), Arg.Any<string>(),
                                 Arg.Any<OrchestrationStarted>(), Arg.Any<CancellationToken>())
                   .ThrowsAsync(new TransientSendException("broker down"));

        await Assert.ThrowsAsync<TransientSendException>(
            () => h.BuildStart().HandleAsync(Body(Start(W)), CancellationToken.None));
    }

    [Fact]
    public async Task TheStopPathAnnouncesAfterItsCleanToo()
    {
        // A stop that cleans L2 without telling the replicas leaves three schedulers firing a workflow
        // that no longer exists.
        var h = new Harness();

        await h.BuildStop().HandleAsync(Body(Stop(W)), CancellationToken.None);

        await h.Publisher.Received(1).PublishAsync(
            OrchestratorFanout.Exchange, MessageTypes.OrchestrationStopped,
            Arg.Is<OrchestrationStopped>(a => a.WorkflowId == W), Arg.Any<CancellationToken>());
    }
```

- [ ] **Step 2: Run to verify they fail**

Expected: the ordering and both `Received` assertions fail — nothing publishes yet.

- [ ] **Step 3: Declare the exchange from the API**

Create `FanoutTopology.cs` implementing `IRabbitMqTopology`. Declare **only**
`OrchestratorFanout.Exchange` and `OrchestratorFanout.DeadLetterExchange`, both `ExchangeType.Fanout`
and `ExchangeType.Direct` respectively, durable, not auto-delete. Declare no queues: the API must not
invent queues for replicas that may not exist, and the replica count belongs in deployment rather than
in the API's source. Register it alongside `OrchestrationTopology` in `AppMessaging.cs`.

- [ ] **Step 4: Publish from the end of each handler**

In `StartOrchestrationHandler`, take `IQueueFanoutPublisher` as a dependency and add, as the last
statement of `HandleAsync`:

```csharp
        // The announcement goes out only now, because only now is "validated AND written" true. The
        // service validated before it sent this message; the write happened two lines up. A replica
        // reading L2 on an announcement published any earlier could see the previous definition, or
        // none, and could not distinguish that from a workflow that was never started.
        //
        // A failure here escapes as a transient send fault, so the delivery is requeued and the whole
        // handler runs again — the clean and write are unconditional and idempotent by design, so the
        // repeat is safe, and the replicas learn about the projection on the retry.
        await _publisher.PublishAsync(
            OrchestratorFanout.Exchange, MessageTypes.OrchestrationStarted,
            new OrchestrationStarted(workflow.WorkflowId), ct).ConfigureAwait(false);
```

Do the same in `StopOrchestrationHandler` with `OrchestrationStopped`, after its clean.

- [ ] **Step 5: Run the tests**

Expected: 0 failures, exactly 6 skips, exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/BaseApi.Service/Features/Orchestration/Messaging/FanoutTopology.cs \
        src/BaseApi.Service/Features/Orchestration/Messaging/StartOrchestrationHandler.cs \
        src/BaseApi.Service/Features/Orchestration/Messaging/StopOrchestrationHandler.cs \
        src/BaseApi.Service/Composition/AppMessaging.cs \
        src/tests/BaseApi.Tests/Orchestration/FanoutPublishTests.cs
git commit -m "feat: announce a projection to the orchestrator replicas once it is written"
```

---

### Task 5: The Orchestrator project and its topology

**Files:**
- Create: `src/Orchestrator/Orchestrator.csproj`, `Program.cs`, `OrchestratorHost.cs`
- Create: `src/Orchestrator/Messaging/OrchestratorTopology.cs`
- Modify: the solution file
- Test: `src/tests/BaseApi.Tests/Orchestrator/OrchestratorTopologyTests.cs`

**Interfaces:**
- Consumes: `OrchestratorFanout` (Task 1).
- Produces: a host whose service graph resolves; `OrchestratorTopology` declaring the exchanges, this
  replica's durable queue, its dead queue, and the bindings.

- [ ] **Step 1: Write the failing topology test**

The one property worth asserting is ordering, because it fails silently in production: a queue whose
`x-dead-letter-exchange` names an exchange that does not exist is accepted at declare time and then
discards everything it parks.

```csharp
    [Fact]
    public async Task DeclaresTheDeadLetterExchangeBeforeTheQueueThatNamesIt()
    {
        var channel = Substitute.For<IChannel>();
        var order = new List<string>();
        channel.ExchangeDeclareAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<bool>(), Arg.Any<bool>(),
                                     Arg.Any<IDictionary<string, object?>>(), Arg.Any<bool>(), Arg.Any<bool>(),
                                     Arg.Any<CancellationToken>())
               .Returns(Task.CompletedTask)
               .AndDoes(c => order.Add($"exchange:{c.ArgAt<string>(0)}"));
        channel.QueueDeclareAsync(Arg.Any<string>(), Arg.Any<bool>(), Arg.Any<bool>(), Arg.Any<bool>(),
                                  Arg.Any<IDictionary<string, object?>>(), Arg.Any<bool>(), Arg.Any<bool>(),
                                  Arg.Any<CancellationToken>())
               .Returns(new QueueDeclareOk("q", 0, 0))
               .AndDoes(c => order.Add($"queue:{c.ArgAt<string>(0)}"));

        await new OrchestratorTopology(new InstanceId("orchestrator-0")).DeclareAsync(channel, CancellationToken.None);

        var dlx = order.IndexOf($"exchange:{OrchestratorFanout.DeadLetterExchange}");
        var q = order.IndexOf($"queue:{OrchestratorFanout.PerReplica("orchestrator-0")}");
        Assert.True(dlx >= 0 && q > dlx, "the dead-letter exchange must be declared before the queue naming it");
    }
```

Check the real `IChannel` arities before running — `ProcessorTopology`'s tests already pin them and
`QueueDeclareAsync` returns `Task<QueueDeclareOk>`, which is why `.Returns(...).AndDoes(...)` is used
rather than a bare `.Returns`.

- [ ] **Step 2: Run to verify it fails**

Expected: compile failure — the project and the type do not exist.

- [ ] **Step 3: Create the project**

`src/Orchestrator/Orchestrator.csproj`, copying `Processor.Sample`'s shape: `Microsoft.NET.Sdk`,
`OutputType=Exe`, `GenerateDocumentationFile=true`, `NoWarn=$(NoWarn);CS1591`. `ProjectReference` to
`BaseConsole.Core` and `Messaging.Contracts` **only** — never `BaseApi.*`. `PackageReference` (no
`Version=`; CPM pins them) to `Quartz.Extensions.Hosting`, `Cronos`, `KubernetesClient`. Add it to the
solution.

- [ ] **Step 4: Write the topology**

Create `OrchestratorTopology.cs` implementing `IRabbitMqTopology`, taking `InstanceId`. In order:
the dead-letter exchange (direct, durable); the fanout exchange (fanout, durable); this replica's dead
queue (durable, quorum) bound to the DLX under its own name as routing key; this replica's queue
(durable, non-exclusive, non-auto-delete, quorum, `x-dead-letter-exchange` = the DLX,
`x-dead-letter-routing-key` = its dead queue name) bound to the fanout exchange with an empty routing
key.

Carry a class-doc paragraph explaining the ordering requirement, matching `ProcessorTopology`'s.

- [ ] **Step 5: Write the host skeleton**

`OrchestratorHost.StartAsync(string[] args, CancellationToken ct, Action<IConfigurationBuilder>? configure = null)`
mirroring `ProcessorHost` — composition as methods rather than inline in `Program`, so the service
graph can be asserted without starting a process. Register `InstanceId.Resolve()`, the console
observability/health/messaging extensions, `AddBaseConsoleGating(cfg, OrchestratorFanout.PerReplica(instanceId.Value))`,
and `OrchestratorTopology`. `Program.cs` is a one-liner calling it.

- [ ] **Step 6: Add a graph test**

Assert the host builds and resolves — the one thing worth asserting about a shell. Follow
`ProcessorSampleTests`' idiom.

- [ ] **Step 7: Run the tests, then commit**

```bash
git add src/Orchestrator/ src/tests/BaseApi.Tests/Orchestrator/OrchestratorTopologyTests.cs SK_P9.sln
git commit -m "feat: add the orchestrator shell and declare its fanout queue"
```

Use the real solution filename.

---

### Task 6: L1, the L2 reader, the scheduler, and the one activation path

**Files:**
- Create: `src/Orchestrator/L1/WorkflowL1Store.cs`, `L2WorkflowReader.cs`, `WorkflowActivator.cs`
- Create: `src/Orchestrator/Scheduling/CronInterval.cs`, `WorkflowScheduler.cs`
- Test: `src/tests/BaseApi.Tests/Orchestrator/WorkflowActivatorTests.cs`, `CronIntervalTests.cs`

**Interfaces:**
- Consumes: `L2ProjectionKeys`, `WorkflowRootProjection`, `StepProjection`, `WorkflowL1`, `StepL1`.
- Produces:
  - `WorkflowL1Store`: `bool TryGet(Guid workflowId, out L1Entry entry)`, `void Set(Guid, WorkflowL1, Guid jobId)`,
    `bool Remove(Guid)`, `IReadOnlyCollection<L1Entry> Snapshot()`; `L1Entry(WorkflowL1 Definition, Guid JobId)`.
  - `L2WorkflowReader.ReadAsync(Guid workflowId, CancellationToken ct)` → `WorkflowL1?` (null when the
    root key is absent); `ReadAllIdsAsync(CancellationToken ct)` → `IReadOnlyList<Guid>` from the
    parent-index SET; and `ExistsAsync(Guid workflowId, CancellationToken ct)` → `bool`, a
    `KeyExistsAsync` on `L2ProjectionKeys.Root(id)`. **`ExistsAsync` is used only by Task 8's stop
    handler** — build it here anyway, so the reader is the one place that knows L2's key layout.
  - `WorkflowScheduler.ScheduleAsync(Guid workflowId, Guid jobId, string cron, CancellationToken ct)`,
    `RescheduleAsync(Guid workflowId, Guid jobId, string cron, CancellationToken ct)`,
    `UnscheduleAsync(Guid jobId, CancellationToken ct)`.
  - `WorkflowActivator.ActivateAsync(Guid workflowId, CancellationToken ct)` — the single path used by
    both hydration (Task 7) and the start handler (Task 8).

- [ ] **Step 1: Write the failing activator tests**

```csharp
    [Fact]
    public async Task MirrorsL2IntoL1AndSchedulesAWorkflowWithACron()
    {
        var h = new Harness().WithWorkflow(W, cron: "0 * * * *", entry: S, processor: P);

        await h.Build().ActivateAsync(W, CancellationToken.None);

        Assert.True(h.Store.TryGet(W, out var entry));
        Assert.Equal(W, entry.Definition.WorkflowId);
        Assert.Single(h.Scheduler.Scheduled);
    }

    [Fact]
    public async Task MirrorsButDoesNotScheduleAWorkflowWithNoCron()
    {
        // A null cron means unscheduled, which is a valid projection — WorkflowL1's own doc puts that
        // decision with whoever reads the root, which is this method.
        var h = new Harness().WithWorkflow(W, cron: null, entry: S, processor: P);

        await h.Build().ActivateAsync(W, CancellationToken.None);

        Assert.True(h.Store.TryGet(W, out _));
        Assert.Empty(h.Scheduler.Scheduled);
    }

    [Fact]
    public async Task DoesNothingAtAllWhenL2DoesNotHoldTheWorkflow()
    {
        // Reachable: a stop cleaned L2 after the announcement was published. L2 is the source of
        // truth, so the correct action is none.
        var h = new Harness();   // no workflow written

        await h.Build().ActivateAsync(W, CancellationToken.None);

        Assert.False(h.Store.TryGet(W, out _));
        Assert.Empty(h.Scheduler.Scheduled);
    }

    [Fact]
    public async Task TearsDownAnExistingJobBeforeSchedulingTheReplacement()
    {
        // Teardown-then-apply is what makes a redelivered announcement converge instead of accumulating
        // a second live job for the same workflow.
        var h = new Harness().WithWorkflow(W, cron: "0 * * * *", entry: S, processor: P);
        await h.Build().ActivateAsync(W, CancellationToken.None);
        var first = h.Store.TryGet(W, out var e1) ? e1.JobId : Guid.Empty;

        await h.Build().ActivateAsync(W, CancellationToken.None);

        Assert.Contains(first, h.Scheduler.Unscheduled);
        Assert.True(h.Store.TryGet(W, out var e2));
        Assert.NotEqual(first, e2.JobId);
    }
```

`Harness` substitutes `IDatabase` and writes the same JSON `L2ProjectionWriter` writes — a
`WorkflowRootProjection` at `Root(W)` and a `StepProjection` at `Step(W, S)`, both via
`MessagingJson.Options`. `h.Scheduler` is a recording fake implementing the scheduler's surface, not a
real Quartz scheduler.

- [ ] **Step 2: Run to verify they fail**

Expected: compile failure — none of these types exist.

- [ ] **Step 3: Write `CronInterval`**

A thin Cronos wrapper: `static DateTime? NextOccurrence(string cron, DateTime utcNow)` returning null
when the expression has no future occurrence, and null rather than throwing on an unparseable
expression — a bad cron reached L2 through validation, and a throw here would take down a hydration
loop rather than skipping one workflow. Log the skip at the call site, naming the workflow id, never
the expression.

- [ ] **Step 4: Write `WorkflowL1Store`**

`ConcurrentDictionary<Guid, L1Entry>` behind the four operations above. `L1Entry` is a record. No
persistence, no I/O, no logging.

- [ ] **Step 5: Write `L2WorkflowReader`**

`ReadAllIdsAsync` → `SetMembersAsync(L2ProjectionKeys.ParentIndex())`, parsing each member as a `"D"`
guid and skipping unparseable members with a warning.

`ReadAsync` → `StringGetAsync(L2ProjectionKeys.Root(id))`; null or empty → return null. Deserialize
`WorkflowRootProjection`, then read each `Step(id, stepId)` for `root.StepIds`, deserialize
`StepProjection`, and build:

```csharp
        var steps = new List<StepL1>(root.StepIds.Count);
        // …per step…
        steps.Add(new StepL1(stepId, proj.EntryCondition, proj.ProcessorId, proj.Payload, proj.NextStepIds));

        return new WorkflowL1(workflowId, root.EntryStepIds, root.Cron, steps);
```

A step key missing while its root lists it is a torn projection: skip that step, log a warning naming
the workflow and step ids, and continue — the workflow is still worth running with the steps that are
there, and the next start will repair it. A Redis fault propagates untouched; the caller classifies it.

- [ ] **Step 6: Write `WorkflowScheduler`**

Quartz, per the spec: `JobKey(jobId.ToString("D"))`, one-shot `ISimpleTrigger` at the next
`CronInterval.NextOccurrence`, `UsingJobData("workflowId", workflowId.ToString("D"))` and
`UsingJobData("jobId", jobId.ToString("D"))` — the fire job needs both, the second for the
supersession check in Task 9. `RescheduleAsync` adds a new trigger to the existing job, re-creating
job and trigger when none exists (a non-durable job with no triggers is auto-purged).
`UnscheduleAsync` calls `DeleteJob`, which removes the job and its triggers atomically.

- [ ] **Step 7: Write `WorkflowActivator`**

The five steps from spec §7.1, in order, with a class-doc paragraph saying it is the single path and
why: hydration and the start handler must not be able to drift.

- [ ] **Step 8: Run the tests, then commit**

```bash
git add src/Orchestrator/L1/ src/Orchestrator/Scheduling/ \
        src/tests/BaseApi.Tests/Orchestrator/WorkflowActivatorTests.cs \
        src/tests/BaseApi.Tests/Orchestrator/CronIntervalTests.cs
git commit -m "feat: mirror a workflow from L2 into L1 and schedule it"
```

---

### Task 7: Hydration, its watchdog, and admission

**Files:**
- Create: `src/Orchestrator/Hydration/HydrationService.cs`, `HydrationAdmission.cs`
- Modify: `src/Orchestrator/OrchestratorHost.cs`
- Test: `src/tests/BaseApi.Tests/Orchestrator/HydrationServiceTests.cs`

**Interfaces:**
- Consumes: `L2WorkflowReader`, `WorkflowActivator` (Task 6); `IConsumerAdmission` (Task 3).
- Produces: `HydrationAdmission : IConsumerAdmission` whose `IsOpen` flips once hydration completes;
  `HydrationService`, a `BackgroundService` running Loop 2.

- [ ] **Step 1: Write the failing tests**

```csharp
    [Fact]
    public async Task MirrorsEveryWorkflowInTheParentIndex()
    {
        var h = new Harness().WithWorkflow(W1, "0 * * * *").WithWorkflow(W2, null);

        await h.Build().RunOnceAsync(CancellationToken.None);

        Assert.True(h.Store.TryGet(W1, out _));
        Assert.True(h.Store.TryGet(W2, out _));
    }

    [Fact]
    public async Task KeepsBeatingAndRetryingWhileL2IsUnreachable()
    {
        // The watchdog's whole purpose: an unreachable store is a dependency outage, not a crash, so
        // the loop must keep ticking and the pod must stay alive. A loop that stopped beating here
        // would be restarted by Kubernetes for a fault a restart cannot fix.
        var h = new Harness().WithStoreFault();

        var run = h.Build().RunUntilHydratedAsync(h.Cts.Token);
        h.PumpTime(TimeSpan.FromSeconds(30));

        Assert.NotNull(h.Heartbeat.Last);
        Assert.False(h.Admission.IsOpen);
        h.Cts.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => run);
    }

    [Fact]
    public async Task OpensAdmissionAndRetiresItsHeartbeatOnlyOnceHydrationSucceeds()
    {
        // Retiring matters: a startup loop that stops beating is indistinguishable from one that
        // wedged, and would fail its liveness check one window later and restart a healthy pod.
        var h = new Harness().WithWorkflow(W1, "0 * * * *");

        await h.Build().RunOnceAsync(CancellationToken.None);

        Assert.True(h.Admission.IsOpen);
        Assert.True(h.Heartbeat.IsRetired);
        Assert.True(h.StartupGate.IsReady);
    }
```

**`FakeTimeProvider` needs an external pump in this repo** — time advances only when something reads
it, so a test that waits on a delay hangs unless the test advances the clock itself. `h.PumpTime`
must do that from the test side.

- [ ] **Step 2: Run to verify they fail**

Expected: compile failure.

- [ ] **Step 3: Write `HydrationAdmission`**

A one-shot latch in the shape of `StartupGate`: `Volatile.Read` for the getter, `Interlocked.Exchange`
in `Open()`, idempotent.

- [ ] **Step 4: Write `HydrationService`**

A `BackgroundService`. Each attempt: beat the heartbeat, read all ids, activate each, and on complete
success call `_startupGate.MarkReady()`, `_admission.Open()`, `_heartbeat.Retire()`, then return. On
an L2 fault: log at warning naming the delay, back off doubling from one second to the configured cap,
and retry forever. Cancellation propagates.

Expose the loop body as an internal method so a test can drive one attempt without a host, following
`ProcessorStartupOrchestrator`'s shape.

- [ ] **Step 5: Wire it**

In `OrchestratorHost`: register `HydrationAdmission` as a singleton and as `IConsumerAdmission`
**before** `AddBaseConsoleGating` so its `TryAddSingleton` default does not win; register a keyed
`ILoopHeartbeat` for the hydration loop plus a `LoopLivenessHealthCheck(heartbeat, BackoffCap ×
StaleFactor, "hydration", TimeProvider)` tagged `["live"]`, mirroring
`BaseProcessorServiceCollectionExtensions.cs:143-160`; register `HydrationService` as a hosted service.

- [ ] **Step 6: Run the tests, then commit**

```bash
git add src/Orchestrator/Hydration/ src/Orchestrator/OrchestratorHost.cs \
        src/tests/BaseApi.Tests/Orchestrator/HydrationServiceTests.cs
git commit -m "feat: hydrate L1 from L2 before admitting the consumer"
```

---

### Task 8: The start and stop handlers

**Files:**
- Create: `src/Orchestrator/Messaging/ApplyStartHandler.cs`, `ApplyStopHandler.cs`
- Modify: `src/Orchestrator/OrchestratorHost.cs`
- Test: `src/tests/BaseApi.Tests/Orchestrator/ApplyHandlerTests.cs`

**Interfaces:**
- Consumes: `WorkflowActivator`, `WorkflowL1Store`, `L2WorkflowReader`, `WorkflowScheduler` (Task 6);
  the announcements (Task 1).
- Produces: two `IQueueMessageHandler`s registered on the per-replica queue.

- [ ] **Step 1: Write the failing tests**

```csharp
    [Fact]
    public async Task AStartAppliesTheWorkflowFromL2NotFromTheMessage()
    {
        var h = new Harness().WithWorkflow(W, "0 * * * *");

        await h.BuildStart().HandleAsync(Body(new OrchestrationStarted(W)), CancellationToken.None);

        Assert.True(h.Store.TryGet(W, out _));
    }

    [Fact]
    public async Task AStartIsIdempotentAcrossAReplay()
    {
        var h = new Harness().WithWorkflow(W, "0 * * * *");
        await h.BuildStart().HandleAsync(Body(new OrchestrationStarted(W)), CancellationToken.None);

        await h.BuildStart().HandleAsync(Body(new OrchestrationStarted(W)), CancellationToken.None);

        Assert.True(h.Store.TryGet(W, out _));
        Assert.Equal(1, h.Scheduler.LiveJobCount);
    }

    [Fact]
    public async Task AStartForAWorkflowL2NoLongerHoldsIsANoOpNotAPark()
    {
        // A stop cleaned L2 after this announcement was published. Applying it would resurrect a
        // workflow an operator stopped; parking it would DLX a legitimate race rather than a defect.
        var h = new Harness();

        await h.BuildStart().HandleAsync(Body(new OrchestrationStarted(W)), CancellationToken.None);

        Assert.False(h.Store.TryGet(W, out _));
    }

    [Fact]
    public async Task AnUnreadableBodyThrowsSoTheDeliveryParks()
    {
        var h = new Harness();

        await Assert.ThrowsAsync<JsonException>(
            () => h.BuildStart().HandleAsync(Encoding.UTF8.GetBytes("not json"), CancellationToken.None));
    }

    [Fact]
    public async Task AStopDoesNothingWhileL2StillHoldsTheWorkflow()
    {
        // The API can process a stop then a start: clean, announce stop, write, announce start — both
        // queued here in that order. Acting on the stop first would halt a workflow L2 says is live.
        var h = new Harness().WithWorkflow(W, "0 * * * *");
        await h.BuildStart().HandleAsync(Body(new OrchestrationStarted(W)), CancellationToken.None);

        await h.BuildStop().HandleAsync(Body(new OrchestrationStopped(W)), CancellationToken.None);

        Assert.True(h.Store.TryGet(W, out _));
        Assert.Equal(1, h.Scheduler.LiveJobCount);
    }

    [Fact]
    public async Task AStopUnschedulesThenRemovesOnceL2ConfirmsTheRemoval()
    {
        var h = new Harness().WithWorkflow(W, "0 * * * *");
        await h.BuildStart().HandleAsync(Body(new OrchestrationStarted(W)), CancellationToken.None);
        h.RemoveWorkflowFromL2(W);

        await h.BuildStop().HandleAsync(Body(new OrchestrationStopped(W)), CancellationToken.None);

        Assert.False(h.Store.TryGet(W, out _));
        Assert.Equal(0, h.Scheduler.LiveJobCount);
    }

    [Fact]
    public async Task AStopForAWorkflowThisReplicaNeverSawIsANoOp()
    {
        // What a replica sees after it missed the start while it was down, and after a duplicate stop.
        var h = new Harness();

        await h.BuildStop().HandleAsync(Body(new OrchestrationStopped(W)), CancellationToken.None);

        Assert.Equal(0, h.Scheduler.LiveJobCount);
    }

    [Fact]
    public async Task AnL2FaultPropagatesSoTheDeliveryRequeuesAndTripsTheGate()
    {
        // Requeue-and-trip is right: the replica stops consuming until the store returns, rather than
        // spinning through the backlog failing every message in turn.
        var h = new Harness().WithStoreFault();

        await Assert.ThrowsAsync<RedisConnectionException>(
            () => h.BuildStart().HandleAsync(Body(new OrchestrationStarted(W)), CancellationToken.None));
    }
```

- [ ] **Step 2: Run to verify they fail**

- [ ] **Step 3: Write `ApplyStartHandler`**

`MessageType => MessageTypes.OrchestrationStarted`. Deserialize (null or empty id → `JsonException`),
open a log scope carrying `WorkflowId` rendered `"D"`, call `WorkflowActivator.ActivateAsync`. Nothing
else — the activator owns the absent-workflow case.

- [ ] **Step 4: Write `ApplyStopHandler`**

`MessageType => MessageTypes.OrchestrationStopped`. Deserialize, then **verify first**:

```csharp
        // Verify before acting. The API can process a stop and then a start, so by the time this stop
        // is handled L2 may already hold the re-written workflow — and unscheduling first would halt a
        // workflow L2 says is live until the start behind this message in the queue is processed.
        // L2 is the source of truth; if it still holds the workflow, the correct action is none.
        if (await _reader.ExistsAsync(m.WorkflowId, ct).ConfigureAwait(false))
        {
            _logger.LogInformation("stop announced but the workflow is still projected — ignoring");
            return;
        }

        if (_store.TryGet(m.WorkflowId, out var entry))
        {
            await _scheduler.UnscheduleAsync(entry.JobId, ct).ConfigureAwait(false);
            _store.Remove(m.WorkflowId);
        }
```

`ExistsAsync` was built in Task 6 — do not add a second L2 read path here.

- [ ] **Step 5: Register both** as `IQueueMessageHandler` in `OrchestratorHost`, scoped, exactly as the
processor registers its two handlers.

- [ ] **Step 6: Run the tests, then commit**

```bash
git add src/Orchestrator/Messaging/ApplyStartHandler.cs \
        src/Orchestrator/Messaging/ApplyStopHandler.cs \
        src/Orchestrator/L1/L2WorkflowReader.cs \
        src/Orchestrator/OrchestratorHost.cs \
        src/tests/BaseApi.Tests/Orchestrator/ApplyHandlerTests.cs
git commit -m "feat: apply start and stop announcements against L2"
```

---

### Task 9: Leader election and the fire

**Files:**
- Create: `src/Orchestrator/Election/LeaderState.cs`, `LeaderElectionService.cs`
- Create: `src/Orchestrator/Scheduling/WorkflowFireJob.cs`
- Modify: `src/Orchestrator/OrchestratorHost.cs`
- Test: `src/tests/BaseApi.Tests/Orchestrator/WorkflowFireJobTests.cs`, `LeaderElectionTests.cs`

**Interfaces:**
- Consumes: `WorkflowL1Store`, `WorkflowScheduler` (Task 6); `IQueueSender`.
- Produces: `LeaderState` with `bool IsLeader`, `BecomeLeader()`, `BecomeFollower()`;
  `WorkflowFireJob : IJob`.

- [ ] **Step 1: Write the failing tests**

```csharp
    [Fact]
    public async Task TheLeaderDispatchesOneProcessDispatchPerEntryStep()
    {
        var h = new Harness().AsLeader().WithWorkflow(W, entries: [(S1, P1), (S2, P2)]);

        await h.Build().Execute(h.Context(W, h.JobId));

        await h.Sender.Received(1).SendAsync(ProcessorQueues.Work(P1), MessageTypes.ProcessDispatch,
            Arg.Any<ProcessDispatch>(), Arg.Any<CancellationToken>(), Arg.Any<string?>(), Arg.Any<string?>());
        await h.Sender.Received(1).SendAsync(ProcessorQueues.Work(P2), MessageTypes.ProcessDispatch,
            Arg.Any<ProcessDispatch>(), Arg.Any<CancellationToken>(), Arg.Any<string?>(), Arg.Any<string?>());
    }

    [Fact]
    public async Task AnEntryDispatchCarriesNoEntryIdAndNoExecutionId()
    {
        // An entry step is a source step: no upstream input, so the author produces its own. That is
        // the isSource branch the processor's pre handler already implements. An entry dispatch opens
        // no lineage either — the author mints one via NewExecutionId.
        var h = new Harness().AsLeader().WithWorkflow(W, entries: [(S1, P1)]);
        ProcessDispatch? sent = null;
        await h.Sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessDispatch>(d => sent = d),
                                 Arg.Any<CancellationToken>(), Arg.Any<string?>(), Arg.Any<string?>());

        await h.Build().Execute(h.Context(W, h.JobId));

        Assert.Equal(Guid.Empty, sent!.EntryId);
        Assert.Equal(Guid.Empty, sent.ExecutionId);
        Assert.NotEqual(Guid.Empty, sent.CorrelationId);
    }

    [Fact]
    public async Task TwoFiresOfTheSameWorkflowGetDifferentCorrelationIds()
    {
        // The correlation id is what ties one run together. Reusing it across fires would make two
        // runs indistinguishable in the logs and in every downstream projection.
        var h = new Harness().AsLeader().WithWorkflow(W, entries: [(S1, P1)]);
        var ids = new List<Guid>();
        await h.Sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessDispatch>(d => ids.Add(d.CorrelationId)),
                                 Arg.Any<CancellationToken>(), Arg.Any<string?>(), Arg.Any<string?>());

        await h.Build().Execute(h.Context(W, h.JobId));
        await h.Build().Execute(h.Context(W, h.JobId));

        Assert.Equal(2, ids.Distinct().Count());
    }

    [Fact]
    public async Task AFollowerDispatchesNothingButStillReschedules()
    {
        // The gate sits before the dispatch only. A follower that returned early without rescheduling
        // would never fire again on that replica — so the workflow would stop the moment it was
        // promoted, which is exactly when it must not.
        var h = new Harness().AsFollower().WithWorkflow(W, entries: [(S1, P1)]);

        await h.Build().Execute(h.Context(W, h.JobId));

        Assert.Empty(h.Sender.ReceivedCalls());
        Assert.Equal(1, h.Scheduler.RescheduleCount);
    }

    [Fact]
    public async Task ASupersededFireDoesNotReschedule()
    {
        // A start arriving mid-fire deletes this job and schedules a replacement. This fire's
        // self-reschedule would re-create the deleted job — a non-durable one-shot with no triggers is
        // auto-purged, so its reschedule has to be able to recreate it — leaving two live jobs for one
        // workflow, both firing every tick and double-dispatching every entry step.
        var h = new Harness().AsLeader().WithWorkflow(W, entries: [(S1, P1)]);
        h.SupersedeJob(W);   // L1 now holds a different jobId

        await h.Build().Execute(h.Context(W, h.JobId));

        Assert.Equal(0, h.Scheduler.RescheduleCount);
    }

    [Fact]
    public async Task ASendFaultIsSwallowedSoTheScheduleChainSurvives()
    {
        // A self-rescheduling one-shot that throws before rescheduling never fires again, so a
        // transient broker blip would stop the workflow permanently on this replica. This is the one
        // send path in the system that swallows, and the swallow is per entry step.
        var h = new Harness().AsLeader().WithWorkflow(W, entries: [(S1, P1), (S2, P2)]);
        h.Sender.SendAsync(ProcessorQueues.Work(P1), Arg.Any<string>(), Arg.Any<ProcessDispatch>(),
                           Arg.Any<CancellationToken>(), Arg.Any<string?>(), Arg.Any<string?>())
                .ThrowsAsync(new TransientSendException("blip"));

        await h.Build().Execute(h.Context(W, h.JobId));   // must not throw

        await h.Sender.Received(1).SendAsync(ProcessorQueues.Work(P2), Arg.Any<string>(),
            Arg.Any<ProcessDispatch>(), Arg.Any<CancellationToken>(), Arg.Any<string?>(), Arg.Any<string?>());
        Assert.Equal(1, h.Scheduler.RescheduleCount);
    }

    [Fact]
    public void TheRenewDeadlineIsBelowTheLeaseDuration()
    {
        // The self-demotion fence. A leader that loses its lease must close its own gate within the
        // renew window rather than discovering it later and dispatching alongside the new leader.
        Assert.True(LeaderElectionService.RenewDeadline < LeaderElectionService.LeaseDuration);
    }
```

- [ ] **Step 2: Run to verify they fail**

- [ ] **Step 3: Write `LeaderState`**

`bool IsLeader` over a `Volatile.Read`/`Interlocked.Exchange` pair, `BecomeLeader()`,
`BecomeFollower()`. A class doc naming the election service as its sole writer.

- [ ] **Step 4: Write `LeaderElectionService`**

Per spec §9, ported from `references/src/Orchestrator/Election/LeaderElectionService.cs`. Public
`static readonly TimeSpan LeaseDuration = 15s`, `RenewDeadline = 10s`, `RetryPeriod = 2s`; constants
`LeaseNamespace = "skp"`, `LeaseName = "orchestrator-leader"`. Identity from `InstanceId`. Registered
in the host **only when running in-cluster**, so hermetic tests never stand up an election and drive
`LeaderState` directly.

- [ ] **Step 5: Write `WorkflowFireJob`**

`[DisallowConcurrentExecution]`, implementing `IJob`, following spec §8.3's five steps. Read
`workflowId` and `jobId` from `context.MergedJobDataMap`; an unparseable value is logged and skipped,
never thrown. Wrap the whole body in a log scope carrying `WorkflowId`, and each dispatch in one
carrying `StepId` and `ProcessorId`, plus `CorrelationKeys.LogScope` rendered `"N"`.

The per-entry-step swallow catches `Exception` but **must** rethrow when
`context.CancellationToken.IsCancellationRequested` — a host shutdown still propagates so shutdown
proceeds.

- [ ] **Step 6: Run the tests, then commit**

```bash
git add src/Orchestrator/Election/ src/Orchestrator/Scheduling/WorkflowFireJob.cs \
        src/Orchestrator/OrchestratorHost.cs \
        src/tests/BaseApi.Tests/Orchestrator/WorkflowFireJobTests.cs \
        src/tests/BaseApi.Tests/Orchestrator/LeaderElectionTests.cs
git commit -m "feat: fire a workflow's entry steps from the leader only"
```

---

### Task 10: Final wiring and the deployment manifest

**Files:**
- Modify: `src/Orchestrator/OrchestratorHost.cs`, `Program.cs`
- Create: the orchestrator Kubernetes manifest, alongside the existing processor manifest
- Test: `src/tests/BaseApi.Tests/Orchestrator/OrchestratorHostWiringTests.cs`

- [ ] **Step 1: Write the failing wiring test**

Assert the built host resolves `HydrationService`, both handlers, `WorkflowFireJob`'s dependencies,
`IConsumerAdmission` **as `HydrationAdmission` and not the always-open default**, and both keyed
heartbeats. The admission assertion is the one that matters: registering it after
`AddBaseConsoleGating` would silently leave the default in place and the replica would consume before
hydrating, which no other test would catch.

- [ ] **Step 2: Complete the composition**

Quartz via `AddQuartz` + `AddQuartzHostedService(o => o.WaitForJobsToComplete = true)`, the fire job
registered as a transient `IJob`, `TimeProvider.System`, and the election service registered only
in-cluster.

- [ ] **Step 3: Write the manifest**

A StatefulSet with `replicas: 3`, a `POD_NAME` env var from the downward API
(`metadata.name`), the startup probe on `/health/startup` and the liveness probe on the `live` tag,
and a ServiceAccount with a least-privilege Role granting only `get`/`create`/`update` on
`coordination.k8s.io` `leases` named `orchestrator-leader` in namespace `skp`.

Follow the existing processor manifest for image, probes and resource conventions.

- [ ] **Step 4: Run the full suite, then commit**

```bash
git add src/Orchestrator/ src/tests/BaseApi.Tests/Orchestrator/OrchestratorHostWiringTests.cs
git commit -m "feat: wire the orchestrator host and deploy it as a statefulset"
```

Add the manifest path to the same commit.

---

## Done When

- `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj` reports 0 failures, exactly 6 skips,
  exit 0, 0 build warnings.
- `grep -rnE "KeyDeleteAsync|StringSetAsync|SetAddAsync|SetRemoveAsync" src/Orchestrator/` prints
  nothing — the orchestrator never mutates L2.
- `grep -n "BaseApi" src/Orchestrator/Orchestrator.csproj` prints nothing.
- Three distinct replica ids produce three distinct queue names, asserted by test.
- A replica does not consume before hydration completes, asserted by test.
- A follower dispatches nothing and still reschedules, asserted by test.
- A superseded fire does not reschedule, asserted by test.

## Known Gaps After This Plan

- **Nothing consumes `orchestrator-result`.** A workflow fires its entry steps and stops there. The
  result path — step advancement, per-successor blob copies under derived ids, and the three reclaim
  duties — is the next subsystem and has no code here.
- **Scale-down is undefended.** A removed replica's durable queue binds to the fanout exchange and
  accumulates forever.
- **`IConsumerAdmission` has one adopter.** The processor's documented gap — consuming a dispatch
  before its schema definitions resolve — stays open until it registers one.
- **The leader election is build-only in hermetic tests.** Its live behaviour against a real Lease is
  unproven until it runs in-cluster.
