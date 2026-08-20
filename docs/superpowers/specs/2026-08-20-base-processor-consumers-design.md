# Base Processor Consumers — Design

**Date:** 2026-08-20
**Status:** Proposed
**Builds on:** `2026-08-19-processor-two-stage-boot-design.md` (identity is resolved before the host
exists, which this design depends on for topology declaration).

## 1. Problem

`BaseProcessor.Core` today resolves its identity, publishes liveness, and reports health. It does not
yet execute anything: there is no dispatch queue, no consumer, no author seam, and no result path
back to the orchestrator. `src/BaseProcessor.Core/Configuration/` contains only
`ProcessorLivenessOptions.cs`, and `src/Processor.Sample/` is `Program.cs` and `ProcessorHost.cs`.

The reference implementation (`references/src/BaseProcessor.Core/Processing/`) has all of it, built on
MassTransit and backed by a Keeper service that reconciles failures through `REINJECT` / `INJECT` /
`DELETE` escalation messages. This project uses the RabbitMQ client directly and has no Keeper. The
recovery mechanism here is the gated consumer: NACK-requeue while the projection store is
unreachable, park what cannot be read, and report business failures as results.

The design problem is therefore not "port the reference". It is: what does the execution path look
like when redelivery is the *only* recovery mechanism?

## 2. Decision

Two message kinds, one queue, one gate.

```
orchestrator ──ProcessDispatch──┐
                                ├──> processor-{id:D} ──> GatedQueueConsumer
processor ────ProcessedData─────┘                             │
                                                    routed by type header
                                                    ┌─────────┴─────────┐
                                              PreHandler          PostHandler
                                                    │                   │
                                              ProcessAsync              │
                                                    │                   │
                                              SendToPostAsync ──> validate output schema
                                                    │             write L2[data:messageId]
                                              delete L2[data:entryId]   │
                                                                  StepCompleted ──> orchestrator-result
```

`StepFailed` and `StepCancelled` are emitted by the pre handler directly; the post handler emits
`StepCompleted`, or `StepFailed` when the output fails its schema.

### 2.1 One queue, not two

The reference bound `{id:D}` and `{id:D}-post` as separate MassTransit receive endpoints. Here both
message kinds share `processor-{id:D}` and are routed by the AMQP type header, which is what
`IQueueMessageHandler` already exists to do. There is precedent: `orchestrator-control` deliberately
carries both start and stop on one queue.

This removes an entire class of work. `GatedQueueConsumer` is a singleton reading one
`IOptions<GatedConsumerOptions>.Queue` and resolving handlers from the container-wide
`IQueueMessageHandler` set. Two queues in one host would need per-instance queue configuration *and*
per-queue handler scoping, or `SingleOrDefault` would run the post handler against a pre message.
One queue needs neither.

No deadlock: pre sends to the queue and acks, and the post message is picked up on the next delivery.
Nothing waits on a reply.

The cost is head-of-line: post work queues behind pre work, so under a deep backlog a step's
completion waits on the transforms ahead of it. Tune with replicas, not with a second queue.

### 2.2 Prefetch stays at 1

One dispatch at a time per replica. Scale is replicas competing on the one queue, which is what the
deployment gives us anyway.

This is load-bearing rather than a tuning knob. Prefetch 1 is what allows the per-dispatch state
(`WorkflowId`, `StepId`, `CorrelationId`, `EntryId`, the send sequence counter) to live as plain
fields on the singleton processor. The reference needed an `AsyncLocal` for exactly this and
documented the bug that forced it — one consume clobbering another's ids, so `NewResult` acted on the
wrong lineage. Raising prefetch above 1 reintroduces that bug and nothing will report it.

### 2.3 The gating stack is ported, not shared

`L2Gate`, `L2GateOptions`, `L2GateProbe`, `L2FaultClassifier`, `GatedQueueConsumer` and
`GatedConsumerOptions` live in `BaseApi.Core`, which `BaseProcessor.Core` cannot reference —
`BaseApi.Core` and `BaseConsole.Core` are siblings with no edge between them.

They are copied into a new `BaseConsole.Core/Gating/`. This is the established convention in this
repository, not a compromise:

| Type | API copy | Console copy |
|---|---|---|
| `RequiredConfig` | `BaseApi.Core/Configuration/` | `BaseConsole.Core/Configuration/` |
| `ILoopHeartbeat` | `BaseApi.Core/Gating/` | `BaseConsole.Core/Loop/` |
| `LoopHeartbeat` | `BaseApi.Core/Gating/` | `BaseConsole.Core/Loop/` |
| `LoopLivenessHealthCheck` | `BaseApi.Core/Gating/` | `BaseConsole.Core/Health/` |
| `IStartupGate` | `BaseApi.Core/Health/` | `BaseConsole.Core/Health/` |
| `StartupHealthCheck` | `BaseApi.Core/Health/` | `BaseConsole.Core/Health/` |

The reference does the same across its own firewall, and says so:

> `ProcessorJsonSchemaValidator`: "the SSRF-locked Json.Schema validator PORTED into
> `BaseProcessor.Core` (firewall — cannot reference `BaseApi.Service`)."

`BaseConsole.Core` already owns Redis wiring via `ConsoleRedisServiceCollectionExtensions`, so the
probe has what it needs and no new dependency enters the graph.

## 3. Contracts

New records in `Messaging.Contracts`, each with a `MessageTypes` wire constant.

```csharp
sealed record ProcessDispatch(Guid WorkflowId, Guid StepId, Guid ProcessorId)
{ Guid CorrelationId; Guid ExecutionId; Guid EntryId; string Payload; }

sealed record ProcessedData(Guid WorkflowId, Guid StepId, Guid ProcessorId)
{ Guid CorrelationId; Guid ExecutionId; Guid MessageId; Guid EntryId; byte[] Data; }

sealed record StepCompleted(Guid WorkflowId, Guid StepId, Guid ProcessorId)
{ Guid CorrelationId; Guid ExecutionId; Guid EntryId; }

sealed record StepFailed(Guid WorkflowId, Guid StepId, Guid ProcessorId)
{ Guid CorrelationId; Guid ExecutionId; Guid EntryId = Guid.Empty; string ErrorMessage; }

sealed record StepCancelled(Guid WorkflowId, Guid StepId, Guid ProcessorId)
{ Guid CorrelationId; Guid ExecutionId; Guid EntryId = Guid.Empty; string CancellationMessage; }
```

Notes on the fields that carry weight:

- **`ProcessDispatch` has no `MessageId`.** The pre hop has no delivery identity it needs; the
  identity that matters is minted at the point of sending to post.
- **`ProcessedData.MessageId` is the L2 write key** and it rides the body, not the AMQP properties.
  RabbitMQ never assigns a message id — `message_id` is producer-set, and `QueueSender` does not set
  it today. A body field is what makes a NACK-requeue redeliver a byte-identical message, so the
  write is idempotent.
- **`ProcessedData.EntryId`** is the input key this branch was produced from. Nothing reclaims it
  on this hop — the pre handler already deleted it once the author's transform returned (§5);
  it rides along here purely for the log scope.
- **`StepCompleted.EntryId` is the `MessageId`** — the `data:` key the next step reads directly.
- `Payload` is the step's processor config as JSON; it was already validated against the config
  schema at workflow-creation time by `PayloadConfigSchemaValidator`, so the processor does not
  re-check it.

## 4. Topology

`processor-{id:D}` and `processor-{id:D}.dead`, plus the processor dead-letter exchange, declared as
an `IRabbitMqTopology` unit at connection setup.

The two-stage boot resolves the processor id before the container exists, so the queue name is known
at declaration time. This is why no runtime endpoint binding is needed — the reference used
`ConnectReceiveEndpoint` after Loop B only because identity was discovered in-process. Declaring at
connection setup also satisfies `IRabbitMqTopology`'s own requirement:

> "A consumer that declares its own queue on start does not declare it while it is paused, and this
> service pauses its consumer whenever the projection store is unreachable. A send arriving in that
> window would address a queue that does not exist."

Queue arguments: durable, `x-queue-type: quorum`, dead-letter exchange and routing key set,
**no `x-delivery-limit`**. A delivery limit counts every redelivery, and this consumer redelivers on
purpose for the whole duration of an L2 outage; a limit would dead-letter work that was never
malformed. The dead-letter exchange is declared *before* the queue that names it — the argument is
not validated at declare time, so a queue pointing at a missing exchange silently discards everything
it parks.

Naming: `processor-{id:D}` rather than the reference's bare `{id:D}`. Every other queue here is a
readable short-name, and a bare GUID is unidentifiable in the management UI. The helpers belong in
`Messaging.Contracts` next to the existing constants:

```csharp
public static class ProcessorQueues
{
    public const string IdentityQuery = "processor-identity-query";
    public const string SchemaQuery   = "schema-definition-query";

    public static string Work(Guid processorId) => $"processor-{processorId:D}";
    public static string Dead(Guid processorId) => $"processor-{processorId:D}.dead";
}
```

## 5. The pre-process handler

`MessageType => MessageTypes.ProcessDispatch`.

1. **Read `L2[data:entryId]`.** Skipped when `EntryId == Guid.Empty` (source step). An absent key
   returns with **no result sent** — the entry is gone because an earlier attempt at this dispatch
   already reclaimed it, so this is a duplicate delivery. Emitting a failure would corrupt a finished
   workflow.
2. **Validate against the input schema.** Skipped on the source branch as an *explicit branch
   decision*, not as a consequence of a source processor having no input schema. A null definition
   skips validation, so it works by accident today; a source step that does carry an input schema
   would otherwise have empty bytes parsed, throw, and fail a step that was never wrong.
3. **Deserialize `Payload` into `TConfig`.** Null when the payload is empty or whitespace.
4. **Invoke `ProcessAsync`.** See §6.
5. **Delete `L2[data:entryId]`, but only if step 4 returned normally**, skipped when `EntryId ==
   Guid.Empty` (source step).
6. **Return.** The message acks.

**Pre owns the reclaim, and only on the normal-return path — nowhere else.** A fan-out sends N
branches from inside one `ProcessAsync` call; the call returning is the only point at which all N are
known to have been sent. That property was arrived at by elimination, and the rejected alternatives
are worth recording:

- *Delete before `ProcessAsync`* — the send for branch 2 fails transiently, the dispatch is
  redelivered, pre reads the entry and finds it already gone, and the clean-absent branch returns
  without processing. Branch 1 shipped; branch 2 never will, and nothing says so.
- *Delete per branch, from inside the author's send loop* — the same loss one step later: branch 1's
  delete removes the key branch 2's retry still needs.
- *Delete in post* — this project's earlier design (an earlier version of §7.1 justified it with a
  separate `out:` namespace, reversed since — §7.1). Post no longer touches L2 at all (§7): a store
  fault on the reclaim must propagate rather than be swallowed by `ProcessAsync`'s catch chain, and
  post only ever sees one branch's message at a time, so it has no equivalent of "the whole author
  returned" to key the delete on.
- *Delete unconditionally, including when `ProcessAsync` throws* — `FailedException`,
  `CancelledException` and a framework fault all leave step 4 short of a normal return, so the delete
  is skipped and the input survives for the orchestrator to deal with (§7.1). Reclaiming regardless
  would destroy the only copy of the input while reporting a business outcome that never actually
  completed.

What survives elimination is exactly one delete: after `ProcessAsync` returns normally, outside the
`try`/`catch` so a store fault on it propagates and trips the gate rather than being swallowed and
reported as a `StepFailed` that never happened. See the comment on the reclaim at the end of
`ProcessDispatchHandler.RunAsync`, and the comment above `raw.IsNullOrEmpty` at the top of the same
method, for the full reasoning — including the case a shared entry key does not survive: more than
one successor dispatched against it (§7.1).

## 6. The author seam

```csharp
public abstract record ProcessorConfig
{
    public static readonly JsonSerializerOptions SerializerOptions = new()
        { PropertyNameCaseInsensitive = true };   // unknown members ignored, deliberately
}

public abstract class BaseProcessor<TConfig> : BaseProcessor where TConfig : ProcessorConfig
{
    protected abstract Task ProcessAsync(
        byte[] data, TConfig? config, Guid executionId, CancellationToken ct);

    protected Task SendToPostAsync(byte[] processedData, Guid executionId, CancellationToken ct);
    protected Guid NewExecutionId();
}
```

`SendToPostAsync` stamps `WorkflowId`, `StepId`, `CorrelationId` and `EntryId` from the ambient
dispatch, stamps `ProcessorId` from `IProcessorContext.Id`, and mints the `MessageId`. The author
writes no envelope plumbing, no retry code, and never touches L2.

`ProcessorId` comes from **our own identity**, not from the inbound dispatch's field. Echoing the
inbound value is the only way the two could ever disagree; stamping from self makes a mismatch
unrepresentable. The reference carried a provenance guard on its `-post` ingress for this; that guard
is deliberately **not** ported, because a check against an unrepresentable condition reads as a live
defence, cannot be tested, and drifts — the same reasoning as `ab03ecf`, which deleted the dead
`ISourceHashProvider` registration.

The `ct` is `CancellationToken.None` on the live path. `GatedQueueConsumer` passes it deliberately:
cancelling mid-handler would abandon partially applied work with the message already claimed. The
parameter exists so tests can drive it.

### 6.1 The three author terminals

| Author does | Orchestrator hears | Input key |
|---|---|---|
| sends 1..N branches via `SendToPostAsync` | success, via post, one result per branch | reclaimed once every branch is sent |
| returns without sending | nothing — the branch ends here | reclaimed the same way |
| throws `FailedException` / `CancelledException` | that outcome directly from pre, no post hop | left in place, unreclaimed by pre/post |

A silent zero-send is **legitimate**: a sink processor writing to an external system, or a filter
deciding the data goes no further, ends its branch with nothing to report. `CancelledException` is
therefore not the mechanism for dropping — it is the mechanism for dropping *visibly*, when
downstream steps gated on a cancelled predecessor need to know. That visibility is not free: with the
TTL gone, choosing `CancelledException` over a silent return also leaves the input key behind for the
orchestrator to reclaim rather than reclaiming it on the spot, in the one case where nothing
downstream is even told to look for it.

Author-thrown messages go on the wire verbatim. Framework-caught exception messages never do (§8).

### 6.2 Deterministic id derivation

`MessageId` and `NewExecutionId()` are both derived — SHA-256 over a canonical string — from
`(CorrelationId, StepId, EntryId, sequence)`, where `sequence` is the call index within this
`ProcessAsync` invocation. Not `Guid.NewGuid()`.

The seed is unique per branch and stable across redeliveries: for a downstream step `EntryId` is a
fresh key minted by the previous post, and for a source step `EntryId` is empty but `CorrelationId`
is minted per fire.

This matters routinely, not marginally. An author sending three branches whose second send fails
transiently throws, NACKs, and replays the *whole* invocation — re-sending branch one. With derived
ids that re-send lands on the same L2 key and the orchestrator can recognise a duplicate by
`MessageId`; with random ids it is a second branch and the workflow forks. Partial fan-out failure is
an ordinary transient, not an edge case.

**This is a deliberate departure from the reference**, which mints randomly at every equivalent site:

| Site | Reference |
|---|---|
| `Processor.Sample/SampleProcessor.cs:70` | `var execId = Guid.NewGuid();` |
| `BaseProcessor.cs:109` | `MessageId = Guid.NewGuid()` |
| `OutputTail.cs:145` | `var outboundId = Guid.NewGuid();` |

The reference's stability claim is narrower than it first appears: minting at the producer fixes the
id in the message body, so a ***post*** redelivery rewrites the same key. It says nothing about
***pre*** redelivery, and the reference simply accepted that a nack-requeue re-fires the whole seed
with fresh ids. That tolerance came from having a Keeper reconciling behind it. We deleted the
Keeper, so redelivery moved from exceptional to routine and the tolerance does not transfer.

The technique already exists in the codebase — `Keeper/Recovery/HydrationPartitionKey.cs:52` and
`ReinjectConsumerDefinition.cs:40` both derive GUIDs by SHA-256 over a canonical key string.

**The cost is an author contract:** `ProcessAsync` must produce the same branches in the same order
on every invocation. A fan-out over a `HashSet`, or a parallel loop, shuffles the sequence and breaks
replay-stability silently. This must be stated in the seam's documentation, and an optional explicit
branch key on `SendToPostAsync` gives authors an escape hatch when their fan-out is not naturally
ordered.

## 7. The post-process handler

`MessageType => MessageTypes.ProcessedData`.

1. **Validate `Data` against the output schema.** Failure → `StepFailed("output failed schema
   validation")` and ack. No blob is written: no successor will read a failed step's output.
2. **Write `L2[data:messageId] = Data`** with no expiry.
3. **Send `StepCompleted`** to `OrchestratorQueues.Result`, carrying `EntryId = MessageId`.
4. Ack.

The post handler reclaims nothing. The input key is deleted by the **pre** handler, once the author's
transform has returned normally — the only point at which every branch of a fan-out is known to have
been sent. Reclaiming per branch would delete the input after the first one, so a later branch's
failed send would requeue a dispatch whose input no longer exists.

Every NACK path replays the whole handler under the same `MessageId` — the write rewrites the same
key with the same bytes and the result send repeats. All idempotent.

### 7.1 One namespace: output is the successor's input

An earlier revision of this spec wrote output to `out:{messageId}` and had the orchestrator relocate
it into one `data:{entryId}` key per successor. That was reversed: post writes `data:{messageId}`,
and the successor reads it as `data:{entryId}` with the same id. The hand-off is a no-op rather than
a copy, and `L2ProjectionKeys.ExecutionData` is the only execution-blob key builder.

**The fan-out objection that motivated `out:` is not refuted — it is reassigned.** A step with three
successors still produces three dispatches carrying one `EntryId`, and the first one's pre hop
reclaims the shared key when its author returns, leaving the other two to read absent and return with
no result. Two branches lost silently.

The processor does not defend against this. The orchestrator must, and owns two duties because of it:

- **More than one successor:** copy the blob into one key per successor before dispatching, under
  ids **derived** the way `DeterministicId` derives everything else. A minted id would fork on
  replay. A step with exactly one successor needs no copy — pass `MessageId` through as `EntryId`.
- **A step that failed:** the pre handler reclaims only after a normal return, so a step ending in
  `FailedException`, `CancelledException` or a framework fault leaves its input key in place. The
  orchestrator reclaims it. Note that `StepFailed` carries no input entry id — `EntryId` is fixed at
  `Guid.Empty` and means *output key* — so the orchestrator must reclaim from its own dispatch
  record, or the contract must gain a field. That choice is open.
- **A step with no successor:** the pre handler that reclaims a `data:` key is the *successor's* pre
  hop, so a workflow's last step has none coming behind it. Its output — written with no expiry — is
  deleted by nobody on the success path, on every run. The orchestrator must delete it when the
  workflow completes. Restoring a TTL on `data:` keys, or extending an orphan sweeper to cover them,
  would also close this hole.

**Decided: neither. Both leaks are accepted until the orchestrator service exists.** Execution blobs
carry no TTL and no sweep, so the orchestrator is the *sole* reclaimer of both a failed step's input
key and a terminal step's output key — an obligation with nothing behind it, not a backstopped one.
Until that service is built, `data:` keys accumulate in Redis for every failed step and every
completed workflow, and only manual reclamation removes them. Anyone building the orchestrator owns
both duties on day one; anyone operating this before then should expect unbounded `skp:data:` growth
and size the store for it.

**Nothing expires.** Execution blobs carry no TTL: an expiry would delete a live workflow's input
during a slow hand-off, and silent loss is the one outcome this design refuses. Every key is
reclaimed explicitly — by the pre handler, by the orchestrator, or by an orphan sweeper as a
backstop. (Today's `L2OrphanSweeper` reclaims stale liveness-index entries left by dead
processor replicas, not execution-data keys — a different remit from §11's stuck-step reaper,
which watches a workflow for a step that never reports a result. Extending sweep-on-a-schedule to
leaked `data:` keys is the backstop this paragraph describes, not a capability either mechanism has
today.) The cost is that a leaked key leaks until something sweeps it, which is the accepted
direction of the trade: tolerate duplication, never tolerate loss.

### 7.2 Two outcomes, no switch

The reference's `OutputTail` switched four ways across
`StepCompleted`/`StepFailed`/`StepCancelled`/`StepProcessing`, because every outcome routed through
it. Here post only ever receives success data — pre reports failures and cancellations directly from
the seam — so post emits `StepCompleted`, or `StepFailed` on an output-schema failure. There is no
`INJECT` escalation because a NACK does that job.

## 8. Failure policy

The rule generalises beyond the processor: **classify at the deserialization boundary.** Above it —
no type header, no registered handler, a body that will not parse — the message is unroutable and no
redelivery can fix it. Below it, with real ids in hand, a handler must not throw for a business
reason.

| Condition | Disposition |
|---|---|
| deterministic failure on a readable message | result (`StepFailed` / `StepCancelled`) + ack |
| transient L2 fault | throw → NACK + trip the gate |
| transient broker send fault | throw → NACK, **gate stays open** |
| unreadable: no type header, no handler, not JSON | park to the DLX |

`StepFailed` never carries a framework-caught exception's message. An author's
`FailedException("order total below minimum")` goes on the wire verbatim; an unexpected exception or
a config `JsonException` becomes a sanitized constant with the detail logged locally. The reason is
specific: a deserialize `JsonException` quotes the offending fragment of the payload — path, line,
token — so `ex.Message` on the wire leaks payload content into the orchestrator's projections. The
flattened schema-validator errors are safe by contrast: they name instance locations, not values.

### 8.1 Parking is kept, and why

A parked dispatch produces no result, so the orchestrator is left waiting either way — parking
recovers nothing that dropping does not. What it buys is the bytes surviving for inspection, and it
buys that because payloads are never logged.

That matters more here than on the query queues, not less. A malformed identity request repeats every
30 seconds and can be caught live; a malformed dispatch happens once and is gone. The query queues
drop-and-log precisely because a retry loop makes the failure recur — `QueryTopology` declares them
with no dead-letter exchange on purpose, and `RpcQueueConsumer` drops a request with no reply
address for the same reason. A durable work queue has no such loop.

### 8.2 The disposition is per queue kind

Applying the boundary rule project-wide does **not** mean parking uniformly:

| Queue kind | Unreadable | Business failure |
|---|---|---|
| durable work, with a result channel (`processor-{id:D}`) | park | result + ack |
| durable work, no result channel (`orchestrator-control`) | park | park — nobody to report to |
| request/reply and reply (`*-query`, `proc-reply-*`) | drop + log | n/a — caller re-asks |

`StartOrchestrationHandler` throwing on an empty workflow id is correct as written: the API already
answered 202, so there is no caller left to inform.

## 9. Log contract

Every record emitted below the deserialization boundary carries the execution ids as Elasticsearch
`attributes.<Key>` fields — framework records, and any log the author writes inside `ProcessAsync`.

### 9.1 How an attribute is formed

Three sources feed one record:

1. **Template placeholders.** MEL keeps the template and its arguments as name/value pairs, the name
   taken from the placeholder text. `ParseStateValues = true` makes OTel read them, so `{MessageId}`
   becomes `attributes.MessageId`.
2. **Active scopes.** `IncludeScopes = true` makes OTel walk every open `BeginScope` dictionary and
   emit each entry as an attribute.
3. **Enrichers.** An OTel `BaseProcessor<LogRecord>.OnEnd` appends pairs unconditionally, reaching
   records that have no message scope at all.

Both switches are already on: `ObservabilityServiceCollectionExtensions.cs:65-66` and
`BaseConsoleObservabilityExtensions.cs:109-110`.

### 9.2 The scope opens in the handler

The reference opened it in a bus-wide MassTransit filter, `InboundExecutionScopeConsumeFilter<T>`,
keyed on `IExecutionCorrelated`. We have no equivalent seam: `GatedQueueConsumer` routes on the type
header and hands raw bytes to the handler, so it never sees a deserialized message and cannot build
the scope.

The scope therefore opens inside each handler, immediately after deserialization, wrapping everything
below it:

```csharp
var msg = JsonSerializer.Deserialize<ProcessDispatch>(body.Span, MessagingJson.Options) ?? throw …;

using (logger.BeginScope(ExecutionLogScope.BuildState(msg)))
{
    // every record below — framework, author, SendToPostAsync — inherits the ids
}
```

Scopes are ambient, so nothing is threaded through `ProcessAsync` and the author writes no logging
plumbing to get correlated records.

### 9.3 Keys and formats

`ExecutionLogScope` is ported into `Messaging.Contracts` with the reference's shape: five key
constants, and a `BuildState` with two overloads sharing one skip-rule implementation so a caller
holding the ids without implementing the interface builds a byte-identical scope.

`ProcessorId` also arrives via an enricher ported into `BaseProcessor.Core/Observability/`, because
the startup loops and the liveness heartbeat emit outside any message scope.

**Rendering is fixed by rule, because the reference gets this wrong.**
`CorrelationIdMiddleware.cs:94` mints `Guid.NewGuid().ToString("N")` — 32 hex chars, no dashes —
while `InboundCorrelationConsumeFilter.cs:35` writes `CorrelationId.ToString()`, which is hyphenated
"D". Both write the same scope key, so one logical id lands as two different strings and a query
joining an HTTP request to its bus work returns nothing, with no error to notice. `src`'s middleware
is byte-identical at line 94, so we inherit the trap the moment a bus-side correlation scope exists.

| Key | Rendering | Why |
|---|---|---|
| `CorrelationId` | `"N"` | crosses the HTTP boundary; echoed to clients in `X-Correlation-Id` |
| `WorkflowId`, `StepId`, `ProcessorId`, `ExecutionId`, `EntryId` | `"D"` | never leave the bus; matches the L2 key format |

`CorrelationId` stays out of `ExecutionLogScope` and keeps its own `CorrelationKeys.LogScope`
constant, whose literal must equal the middleware's `ItemKey`.

### 9.4 Absent is not zero

`BuildState` skips a `Guid.Empty` value, and skips `EntryId` via `SourceStep.IsSource` rather than an
inline comparison. So an entry dispatch has **no** `attributes.ExecutionId` and a source step has
**no** `attributes.EntryId` — the fields are missing, not all-zeros.

The reference hit the consequence downstream: an analyzer detecting entry markers by
`ExecutionId == Guid.Empty` had to be rewritten for attribute-absence. Anything built over these logs
must be written for absence from the start.

### 9.5 Discipline

| Tier | What | How it is carried |
|---|---|---|
| 1 | the five execution ids | ambient scope only — **never restated in a template** |
| 2 | `MessageId` (post only) | explicit `{Placeholder}` arg — the one id the scope lacks |
| 3 | outcome | explicit arg — known only at emit time |

Pre has no `MessageId`, so its tier 2 is empty and the scope is the whole story.

Three rules, all from the reference and all load-bearing:

- **Never interpolate.** `$"hop executed {messageId}"` produces a rendered string and *zero*
  attributes. The template must stay constant — that constant is what groups records of one kind
  across every execution.
- **Never pass a payload as an argument.** Ids and outcomes only.
- **Wrap the call.** A throwing or blocking logger must not fail or delay the hop, so framework log
  calls sit inside a swallow-guard.

Ids are placed as scope *values* under fixed keys, never interpolated into a template, because an
inbound id is untrusted text.

### 9.6 The one path without ids

The unreadable-message park (§8) happens *above* the deserialization boundary: there is no message,
so there are no ids. That record carries the queue name, the type header and the body length, and
nothing else. It is the single exception to "every path carries the ids", and it is structural rather
than an omission.

## 10. Cross-cutting consumer work

These are prerequisites, not processor features. Each is shared by every consumer in the project.

1. **A third outcome in `GatedQueueConsumer`: requeue without tripping the gate.** Today the transient
   branch unconditionally calls `_gate.TripAsync()`, and everything else parks. A broker send that
   fails during handling therefore parks work the projection store was never involved in. Tripping the
   gate on a broker fault would also pause consumption on a store that is healthy.
2. **The boundary rule written once**, on `IQueueMessageHandler`, which already carries most of it.
3. **`RpcQueueConsumer` drop logs carry no `CorrelationId`** — not on the three drop paths, not on the
   catch. That id is read at the top of the method and echoed onto every successful reply, and it is
   the only thing linking an API-side failure to a processor-side startup loop still spinning. One
   line per site turns "some processor is stuck" into "this one, for this reason".
4. **The RPC handlers accept defaulted required fields.** `MessagingJson.Options` sets
   `PropertyNameCaseInsensitive = false` deliberately, so a version-skewed producer sending
   `{"schemaId": ...}` against a contract expecting `SchemaId` deserializes cleanly to
   `GetSchemaDefinition(Guid.Empty)`. `GetSchemaDefinitionHandler` looks that up, catches
   `NotFoundException`, and replies `SchemaDefinitionNotFound` — a valid answer. The processor reads
   it as "not registered yet", retries forever, and never boots, with no error on either side. On
   these queues the unreadable body is the benign case, because it logs; readable-but-wrong is the
   dangerous one. Both handlers should reject a required field that arrived as its default and reply
   with an explicit malformed-request type.
5. **The correlation id must render one way** (§9.3). `CorrelationIdMiddleware.cs:94` mints `"N"`;
   any bus-side scope writing a `Guid` defaults to `"D"`. Both land on `attributes.CorrelationId`, so
   a cross-boundary query returns nothing with no error to notice. Normalising this touches the API
   side, so it is not a processor change.

## 11. Accepted costs

- **"No result" is ambiguous.** A silent zero-send and a step that failed to produce anything look
  identical from outside. A stuck-step reaper cannot therefore be a blanket "no result in N minutes".
  The discriminator exists when the orchestrator wants it: it holds the graph, so a step with no
  successors reporting nothing is expected, while a step with successors reporting nothing is worth
  surfacing.
- **Duplicate results are possible.** A handler that completes its work and fails to ack replays and
  re-sends. The orchestrator must be idempotent per `MessageId`, which §6.2 makes stable.
- **A fork window remains in pre**, between the post send returning and the ack landing. Irreducible
  under at-least-once.
- **The author ordering contract** (§6.2) is a real burden and fails silently when broken.
- **Head-of-line blocking** between pre and post work on the shared queue (§2.1).
- **Prefetch 1 is structural**, not tunable (§2.2).

## 12. Out of scope

Orchestrator-side work, none of which exists in `src/` yet:

- The result consumer on `OrchestratorQueues.Result`.
- Copying the output blob into one `data:{entryId}` key per successor, and reclaiming a failed step's
  input key (§7.1).
- Dedup by `MessageId`.
- The stuck-step reaper (§11).
- Dispatching `ProcessDispatch` at all.

Also out of scope: raising prefetch above 1, and any `Processing` interim status — the reference's
fourth outcome has no consumer here.

## 13. Open items

- The exact canonical-string format for the SHA-256 derivation in §6.2, and whether the optional
  explicit branch key ships in the first cut or waits for an author who needs it.
- Whether `StepCancelled` is needed in the first cut, or whether announced drops can wait until a
  workflow actually gates on a cancelled predecessor.
- **Unverified:** how OTel resolves a scope key colliding with a record attribute of the same name.
  `ExecutionLogScope` carries `ProcessorId` and the enricher (§9.3) appends it, so consume-path
  records receive it from both. Probe before shipping both; the reference has the same overlap and
  does not document an outcome.
