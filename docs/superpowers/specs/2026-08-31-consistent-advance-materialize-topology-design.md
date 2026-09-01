# Consistent advance/materialize topology — Design

**Date:** 2026-08-31
**Status:** Implemented — code, tests and the cluster migration all landed 2026-08-31. See §8.
**Supersedes:** §2.1 of `2026-08-20-base-processor-consumers-design.md` ("One queue, not two"). That
section's central justification no longer holds; see §3.
**Builds on:** `2026-08-20-orchestrator-control-plane-design.md` (the orchestrator's shared execution
queues), `2026-08-22-pipeline-metrics-design.md` (queue-depth and dead-letter series).

## 1. Problem

The processor and the orchestrator run structurally identical consuming logic and carry it on
different queue topologies. The processor puts both of its hops on one queue routed by the AMQP type
header; the orchestrator gives each of its hops a queue of its own. Nothing in the logic accounts for
the difference, and no document argues for it — the two decisions were taken eleven days apart
against different infrastructure, and the difference is what is left over.

This is not a cosmetic complaint. The single-queue arrangement has a failure shape the split one does
not (§5.1), and it is the processor — the host with the only unbounded stage in the system — that
carries it.

## 2. What the two hosts actually run

Four hops form one closed cycle. Each host performs exactly one **advance** and one **materialize**.

```
        ┌────────────── ProcessDispatch ──────────────┐
        │                                             │
        ▼                                             │
  [P advance]  ──ProcessedData──▶  [P materialize]    │
                                        │             │
                                   StepOutcome        │
                                        ▼             │
  [O materialize] ◀──NextStepHandoff── [O advance]    │
        │                                             │
        └─────────────────────────────────────────────┘
```

| | Advance hop — read, act, hand off, reclaim, ack | Materialize hop — write, hand on, ack |
|---|---|---|
| **Processor** | `ProcessDispatchHandler`: read `L2[EntryId]` → author, handing off N branches as it runs → delete `L2[EntryId]` → ack | `ProcessedDataHandler`: validate output → write `L2[EntryId]` → send `StepOutcome` → ack |
| **Orchestrator** | `StepOutcomeHandler`: read L1 + `L2[EntryId]` → select successors → hand off N handoffs → delete `L2[EntryId]` → ack | `NextStepHandoffHandler`: write `L2[EntryId]` → send `ProcessDispatch` → ack |

Both `L2` accesses are conditional on `EntryId != Guid.Empty`; that sentinel carries "no upstream
input" through both hosts. Both advance hops reclaim **last** and say why. Both materialize hops write
**before** they hand on, and say why.

### 2.1 The contracts differ by exactly one field

All four messages implement `IExecutionMessage` — `CorrelationId, ExecutionId, WorkflowId, StepId,
ProcessorId, EntryId` — and differ only in what rides on top:

| Hop input | Extra field |
|---|---|
| `ProcessDispatch` | `string Payload` |
| `ProcessedData` | **`byte[] Data`** |
| `StepOutcome` | `StepResult Result` |
| `NextStepHandoff` | `string Payload`, **`byte[] Data`** |

The `byte[] Data` field is the structural marker of which side of the split a message is on: an
advance hop's input carries no blob and reads L2; a materialize hop's input carries the blob and
writes it.

### 2.2 The materialize hop is idempotent; the advance hop is not

Both writes take key and value straight from the message and use `When.Always`:

```csharp
// ProcessedDataHandler.cs
await db.StringSetAsync(L2ProjectionKeys.ExecutionData(p.EntryId), p.Data, null, When.Always, CommandFlags.None);
// NextStepHandoffHandler.cs
await db.StringSetAsync(L2ProjectionKeys.ExecutionData(h.EntryId), h.Data, null, When.Always, CommandFlags.None);
```

Same key, same bytes, unconditional overwrite, nothing minted and nothing read. Replay it any number
of times and L2 lands in the same state.

The advance hops are the opposite: both mint `Guid.NewGuid()` per unit before handing off, so a replay
produces *different* keys. `StepOutcomeHandler` names the parallel — *"The mint is NewGuid, matching
the processor: a redelivery of this outcome mints new keys and hands the successors off a second time,
so a step whose ack was lost advances twice."* Both rely on the same convergence token: reclaim last,
so a replay finds the source key gone.

**This asymmetry is the whole reason the split exists,** and `OrchestratorQueues.ResultPost` already
says so: *"Splitting at the queue makes each successor its own delivery with its own retry, and leaves
the pre hop with a single idempotent job — copy the blob out, hand off, reclaim."* Everything that
mints or decides sits in the advance hop; everything that persists sits in the materialize hop, where
it is safe to redeliver.

That principle is host-independent. It is the reason both hosts already split into two *deliveries*.
The only open question is whether the second delivery gets its own *queue*.

## 3. Why the two hosts differ today

`2026-08-20-base-processor-consumers-design.md` §2.1 chose one queue, and gave an infrastructural
reason:

> "`GatedQueueConsumer` is a singleton reading one `IOptions<GatedConsumerOptions>.Queue` and
> resolving handlers from the container-wide `IQueueMessageHandler` set. Two queues in one host would
> need per-instance queue configuration *and* per-queue handler scoping … One queue needs neither."

**That capability now exists.** `AddGatedQueue` constructs a consumer per queue with its own options
instance:

```csharp
// ConsoleRedisServiceCollectionExtensions.cs:174
services.AddSingleton<IHostedService>(sp => new GatedQueueConsumer(
    …, Options.Create(new GatedConsumerOptions { Queue = queue }), …));
```

The orchestrator runs three queues in one host on it. The per-queue handler-scoping worry does not
apply either: routing is by type header and the types are disjoint, which is the same mechanism the
single queue already depends on.

The chronology explains the divergence. The processor's decision is dated 2026-08-20;
`orchestrator-result-post` first appears in `2026-08-22-pipeline-metrics-design.md`. The capability
was built for the orchestrator *after* the processor had concluded it could not have it.

### 3.1 Two queues per processor is proven, not speculative

The reference shipped it — `references/.../Startup/ProcessorStartupOrchestrator.cs:284`:

```csharp
var postQueueName = $"{context.Id!.Value:D}-post";
var postHandle = endpointConnector.ConnectReceiveEndpoint(postQueueName, …);
await postHandle.Ready;   // -post queue declared + consumer attached BEFORE Healthy
```

### 3.2 The bug usually cited against it was a different bug

The `AsyncLocal` that the reference needed, and that §2.2 cites when it says prefetch must stay at 1,
was **not** caused by the queue split. The reference's own comment names the cause: *"races under
concurrent consumes (**no ConcurrentMessageLimit on the entry/-post endpoints**)"*. The fault was
unbounded concurrency per endpoint, not the endpoint count.

This stack sets `PrefetchCount = 1` per consumer, and only `ProcessDispatchHandler` takes a
`BaseProcessor` dependency — `ProcessedDataHandler` does not. Splitting the queue therefore keeps
exactly one author in flight per replica and never reaches that bug. §2.2 stands as written; it simply
does not forbid this change.

## 4. Decision

### 4.1 The rule

> **An advance→materialize pair travels on two queues.** The advance hop consumes `<endpoint>`; the
> materialize hop consumes `<endpoint>-post`. Each gets its own gated consumer at prefetch 1, its own
> dead-letter queue `<queue>.dead` bound to the host's DLX, and `x-delivery-limit: -1`.

The `-post` suffix is not a new convention: the orchestrator uses it now and the reference used
`{id:D}-post`.

### 4.2 What is a pair, and what is not

The rule is about advance/materialize pairs. It is not "every queue gets a sibling".

| Queue | Pair? | Under the rule |
|---|---|---|
| `orchestrator-result` / `orchestrator-result-post` | yes | already conformant, no change |
| `processor-{guid}` | yes | gains a `-post` sibling |
| `orchestrator-control` | no — a command queue | unchanged. Carrying start and stop on one queue **is** the ordering guarantee; splitting it would let a stop be handled before the start it follows |
| `orchestrator-control.{pod}` | no — replication | unchanged |
| `processor-identity-query`, `schema-definition-query` | no — classic RPC | unchanged |

## 5. The argument, strongest first

### 5.1 Stage starvation

Prefetch is 1 per consumer (`BasicQosAsync(prefetchSize: 0, prefetchCount: 1, global: false)`) and
`AddGatedQueue` gives one consumer per queue, so **queues × replicas = concurrent work units**:

| | today | if split |
|---|---|---|
| Processor (2 replicas) | 1 × 2 = **2** | 2 × 2 = **4** |
| Orchestrator (3 replicas) | 2 × 3 = **6** | — |

With one queue, a replica running an author has its **only** slot occupied. If both processor replicas
are running authors, the deployment has zero free consumers, and `ProcessedData` work — a schema
validation, one Redis write, one send — waits behind transforms that are unbounded by construction.
`ProcessDispatchHandler` logs `"running the step"` at Information for exactly that reason: *"what runs
next is the author's own code, which this framework knows nothing about and cannot bound."*

§2.1 accepted this as head-of-line cost and prescribed *"Tune with replicas, not with a second
queue."* **That prescription does not address the failure shape.** Every added replica adds one slot
an author can occupy; there is no slot only post work can use. Scaling lowers the probability of all
slots being busy and never removes the condition. A second queue removes it structurally.

Note this argument is *weaker* for the orchestrator, whose stages are both bounded and fast. It is the
processor — the host that lacks the split — where it bites.

### 5.2 Retry isolation

The materialize hop is the freely-replayable half (§2.2). Giving it its own queue gives it its own
consumer, its own in-flight slot and its own dead-letter queue, so a write that keeps failing is
retried and parked independently of the advance hop rather than sharing a lane and a `.dead` queue
with it. A refused dispatch and a refused branch become two incidents instead of one.

### 5.3 Consistency

Four hops, two shapes, one convergence token, one duplicate window, one set of holes. The logic offers
no reason for the hosts to differ, so the topology should not — and the difference that exists is an
artifact of §3's chronology rather than a decision anyone took.

## 6. Topology after the change

Per processor, four queues instead of two:

| Queue | Type | Durable | Bound to | Routing key | DLX / DLRK |
|---|---|---|---|---|---|
| `processor-{guid}` | quorum | ✔ | default | — | `processor-dlx` / `processor-{guid}` |
| `processor-{guid}.dead` | quorum | ✔ | `processor-dlx` | `processor-{guid}` | — |
| `processor-{guid}-post` | quorum | ✔ | default | — | `processor-dlx` / `processor-{guid}-post` |
| `processor-{guid}-post.dead` | quorum | ✔ | `processor-dlx` | `processor-{guid}-post` | — |

All four carry `x-delivery-limit: -1`. No new exchange: `processor-dlx` already exists and the two
dead queues are distinguished by routing key.

## 7. Changes by file

1. **`Messaging.Contracts/ProcessorQueues.cs`** — add, mirroring `Work`/`Dead`:
   ```csharp
   public static string Post(Guid processorId)     => $"processor-{processorId:D}-post";
   public static string PostDead(Guid processorId) => $"processor-{processorId:D}-post.dead";
   ```
2. **`BaseProcessor.Core/Messaging/ProcessorTopology.cs`** — declare the second pair. Extract a
   helper shaped like `OrchestratorTopology.DeclareSharedAsync` so `work` and `post` are declared by
   one method: dead queue and binding first, then the live queue naming it.
3. **`BaseProcessor.Core/Processing/BaseProcessor.cs:88`** — `ProcessorQueues.Post(state.ProcessorId)`
   in place of `Work(...)`. One line; the author-facing API is unchanged.
4. **`BaseProcessorServiceCollectionExtensions.cs`** — mirror the orchestrator's registration block:
   ```csharp
   services.AddBaseConsoleGating(cfg, ProcessorQueues.Work(processorId));  // existing: gate + consumer
   services.AddGatedQueue(ProcessorQueues.Post(processorId));              // new: consumer, shared gate
   ```
   plus `Post(processorId)` in the `QueueDepthProbe` list, and `PostDead(processorId)` in **both** the
   `DeadLetterDepthMetrics.Report` seed and the `DeadLetterDepthProbe` list. The seed is not optional:
   that block's own comment records the trap of a panel reading a confident zero for a series nobody
   emits.
5. **Tests** — `ProcessorTopologyTests` gains the post pair; `ProcessorHostWiringTests` asserts two
   gated consumers.

The orchestrator needs no change.

## 8. Migration

**Executed 2026-08-31 against the `desktop` kind cluster, namespace `skp`.** What follows is the
record of what ran, not a plan.

A queue-argument change is a migration, not an edit: redeclaring with different arguments fails the
channel with a precondition error, so the services will not start against the existing queues. This
rode along with the `x-delivery-limit: -1` teardown already required, at no extra outage.

1. Scale the API, orchestrator and processors to 0 — the API declares `orchestrator-control`.
   Confirmed every consumer detached before touching anything.
2. Verify every quorum queue is at 0 messages, then delete them. All 16 queues read 0 beforehand; the
   14 quorum queues were deleted and the 2 classic query queues left alone — their arguments never
   changed, and `x-delivery-limit` is rejected outright on a classic queue.
3. Rebuild the images. **All three, not just the processor:** `Messaging.Contracts` changed, so the API
   and orchestrator carry it too. `Processor.Sample`'s SourceHash moved to
   `98de7130143b62d9a6a563d9df47633a4bd5d603a84011da9089e0b39d55990f`; `kind load` plus a row repoint,
   or the processor boots and waits unregistered. The processor **id** was left alone, so its queue
   names and every L2 projection naming it stayed valid — 45 `skp:*` keys survived untouched.
4. Deploy and scale up, API first so `orchestrator-control` and the identity-query responder exist
   before anything dials them. Topologies re-declare on connection setup.

> **Annotation, 2026-09-01 — the hash in step 3 is superseded, and the record is left as written.**
> `ac23c1e` edited `BaseProcessor.Core/Processing/ProcessedDataHandler.cs` to restore the WR-02
> provenance guard (§10 said the guard belonged in its own change; this is that change). That file
> is inside the SourceHash fold, so the fleet re-registered again and the live value is now
> `c9ab4a65b0479195b3a2dfbf7f8c55babdb0fb3a153555f4e88a14e31b5c529b` — confirmed against both the
> pod's first log line and the registered row. Anyone repointing a row from step 3's value would
> point it at a binary that no longer exists. The step is not rewritten because it is a dated
> record of what ran; the rule it illustrates is the one that matters, and it fired twice in two
> days: **read the hash from the pod, never from a document.**

### 8.1 Verified after the fact

| Check | Result |
|---|---|
| Queue count | 16 → 18 (the two new processor queues) |
| `processor-{guid}-post` | quorum, durable, 2 consumers — one per replica |
| `processor-{guid}-post.dead` | quorum, durable, bound to `processor-dlx` under `…-post` |
| `delivery_limit`, every quorum queue | `undefined` (unlimited), where it had silently been 20 |
| `processor-dlx` bindings | exactly 2, each keyed by its live queue's name |
| Dead-letter depth, all 8 | 0 |
| Pods | 1 API, 3 orchestrator, 2 processor — all Ready, 0 restarts, 0 error lines |

End to end, the full four-hop cycle turns: `the step returned` → `branch completed` →
`advanced 1 successor(s)` → `dispatched` → `the terminal step completed`. The `branch completed`
line is the post hop consuming the new queue: nothing addresses `ProcessedData` to the work queue any
more, so it can have arrived nowhere else.

## 9. Accepted costs

- **+2 queues per processor.** Processors are the numerous, dynamically registered component; the
  orchestrator is a fixed three.
- **The post queue is invisible to the orchestrator.** `DispatchedQueues` is populated by the
  orchestrator noting queues it dispatches *to*, so it will never learn the `-post` name. If every
  processor pod dies, the orchestrator still reports the work queue's depth — the case
  `QueueDepthProbe` exists for — but not the post queue's. Accepted: the post queue's backlog is
  bounded by the work queue's, and the alternative is teaching the orchestrator a name it has no other
  reason to know.
- **Backpressure becomes explicit rather than free.** Today the shared lane means a processor cannot
  accept new dispatches faster than it drains its own branches. After the split the pre consumer keeps
  accepting while the post queue grows. In practice the author is the slow stage and the post hop is
  milliseconds, so the post lane is not the one that backs up — but the coupling is gone and the depth
  series is now the thing that reports it.

## 10. Decisions deliberately not taken here

- **The provenance guard.** The reference dropped any `-post` message whose `ProcessorId` was not its
  own (`WR-02`). This codebase has no equivalent: `ProcessedDataHandler` derives everything from the
  message and never compares against `IProcessorContext.Identity.Id`. Worth adding — but the split
  does **not** create the exposure. `processor-{guid}` is already externally addressable and already
  accepts `ProcessedData`. The guard is equally justified before and after, so it belongs in its own
  change rather than riding on this one.
- **The absent-key disposition.** The processor acks silently on a reclaimed key (`"entry absent —
  treating as a duplicate delivery"`); the orchestrator throws and parks (*"the outcome names an
  execution blob the store does not hold"*). Same token, opposite disposition, and unlike the `NewGuid`
  trade-off it is argued nowhere. This is the deeper inconsistency and it is independent of topology.
- **Dead-letter routing-key normalisation.** Two sites bind the dead queue under the *live* queue's
  name (`OrchestrationTopology` for control, `ProcessorTopology` for work) while the rest use the dead
  queue's own name. Free during a teardown and never free afterwards, but cosmetic. Fold in only on an
  explicit call.

## 11. Related finding: the delivery limit was never absent

Three files state that no `x-delivery-limit` is set, *deliberately*, so an outage cannot dead-letter a
message that was never malformed. The declared arguments confirm no such argument existed. The broker
disagreed:

```erlang
overflow_strategy => drop_head, delivery_limit => 20, consumer_strategy => competing, …
```

RabbitMQ 4.x applies a default delivery-limit of 20 to any quorum queue declaring none, so "no
argument" meant twenty, silently. It matters most for the requeue paths that loop on a timer —
`gate_closed` and `store_unreachable` requeue continuously while Redis is down, so an outage lasting
past ~20 cycles dead-letters live work.

Setting `x-delivery-limit: -1` restores the documented intent; verified on the broker, where `-1`
resolves to `delivery_limit => undefined`. **It must not be set on the two classic query queues** —
the broker rejects it outright: `invalid arg 'x-delivery-limit' … of queue type rabbit_classic_queue`.
That change is already applied in source and is the reason a teardown is needed at all.

## 12. Out of scope

- `orchestrator-control` and the per-replica fan-out queues (§4.2).
- Prefetch. It stays at 1 everywhere, for the reason `2026-08-20-base-processor-consumers-design.md`
  §2.2 gives, which this design does not disturb.
- The `NewGuid` id derivation and its two documented double-run cases.
