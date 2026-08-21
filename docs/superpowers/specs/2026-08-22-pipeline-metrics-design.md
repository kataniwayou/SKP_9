# Pipeline metrics for the orchestrator and the base processor

Date: 2026-08-22
Status: approved, not yet implemented
Scope: `Messaging.Transport`, `BaseConsole.Core`, `Orchestrator`, `BaseProcessor.Core`

## 1. What this covers, and what it deliberately does not

This design adds **pipeline** metrics: how many messages left a process, how many
arrived, and what was done with each delivery. It is a description of the
transport and of the consumer's own decisions. It is not a description of the
work the messages carried.

Excluded on purpose, and this is a boundary rather than a phase-one cut:

| Excluded | Why |
| --- | --- |
| `StepResult` outcomes — Completed / Failed / Cancelled | A workflow's own result. It belongs on a board about workflows, and mixing it in makes "is the transport healthy" unreadable. |
| Successors advanced per outcome | Graph semantics. |
| Workflows fired, activated, stopped | Business lifecycle. |
| Schema validation pass/fail | A property of a payload, not of a delivery. |
| Blob sizes, payload contents | Never — the codebase keeps validator output and payload fragments in local logs for exactly this reason. |

The one boundary case admitted is the processor's duplicate-delivery
suppression (§6). It looks like business logic and is not: it is a statement
about *delivery semantics* — a message arrived that had already been handled.

## 2. The consistency mechanism

Orchestrator and processor cannot drift apart, because every pipeline event on
both sides already flows through code they share. Instrumentation goes in the
shared classes; neither role gets bespoke counters.

| Event | Class | Assembly | Used by |
| --- | --- | --- | --- |
| send | `QueueSender.SendAsync` | `Messaging.Transport` | orchestrator, processor |
| publish | `QueueFanoutPublisher.PublishAsync` | `Messaging.Transport` | **API only** — see §3.1 |
| receive, ack, nack, park | `GatedQueueConsumer.OnReceivedAsync` | `BaseConsole.Core` | orchestrator, processor |
| channel churn | `GatedQueueConsumer.OnChannelShutdownAsync`, `OnRecoveredAsync` | `BaseConsole.Core` | orchestrator, processor |
| L2 gate open/closed | `L2Gate` | `BaseConsole.Core` | orchestrator, processor |
| meter registration | `AddBaseConsoleObservability` | `BaseConsole.Core` | `OrchestratorHost.cs:90`, `ProcessorHost.cs:82` |

Both hosts already call `AddBaseConsoleObservability`. Adding the meters there
is one edit that both roles inherit, and a new worker cannot ship without them.

### 2.1 What identifies a process

Nothing in this design puts identity on an instrument. The existing resource
attributes already carry it, set once when the meter provider is built:

- `service.name` — `orchestrator` / the processor's own name from its database row
- `service.version`
- `service.instance.id` — the replica identity, shared with the liveness key and reply queue
- `source` — `worker`
- `ProcessorId` — passed by the processor as a resource attribute

Consequence: **`ProcessorId`, `WorkflowId`, `ExecutionId` and `CorrelationId`
must never appear as instrument attributes.** The first is redundant with the
resource; the rest are unbounded and belong on logs, where they already ride the
`BeginScope` blocks in every handler.

## 3. Naming

Prefix `pipeline.`. Counters carry unit `{message}`, histograms are in seconds.

Two verbs from the codebase were rejected as the generic egress name:

- **`dispatch`** is taken. `ProcessDispatch`, `ProcessDispatchHandler`,
  `DispatchState`, `BeginDispatch`/`EndDispatch`, `DispatchEntryStepsAsync` and
  the `Orchestrator.Dispatch` namespace all mean one specific thing: the
  orchestrator handing a step to a processor's work queue. A generic
  `pipeline.messages.dispatched` would count every `step-outcome` the processor
  sends back as a dispatch, contradicting the type names.
- **`publish`** is taken in the opposite direction. `IQueueSender`'s own remarks
  draw the line — "Send, not publish. The distinction is about intent rather
  than API" — a send is addressed to a known queue, a publish is offered to an
  exchange.

`produced` collides with neither (`grep -i produce` returns nothing but prose
across all five projects), pairs naturally with `consumed`, and is neutral over
the send/publish distinction rather than picking a side of it.

OTel messaging semconv (`messaging.client.sent.messages`,
`messaging.client.consumed.messages`) was considered and rejected: it has no
disposition concept, so the whole diagnostic value of §5 would have to be bolted
on as custom attributes to a standard instrument — the worst of both. Those
metrics are also still experimental in .NET.

### 3.1 The orchestrator and the processor never publish

`IQueueFanoutPublisher` is injected in exactly two places, both API-side:
`BaseApi.Service/Features/Orchestration/Messaging/StartOrchestrationHandler.cs:34`
and `StopOrchestrationHandler.cs:26`. The orchestrator is on the receiving end —
`OrchestratorTopology.cs:87` binds a per-replica queue to
`OrchestratorFanout.Exchange`.

So for the two roles in scope, egress is entirely `QueueSender` to the default
exchange, and the `route` attribute below is constant `queue`. It is still
carried, for one attribute's cost, because `QueueFanoutPublisher` lives in the
same shared assembly and is instrumented by the same change. When the API's own
observability wiring is brought in later, the announcements land on the same
instrument and the fan-out ratio becomes visible: one `start-orchestration`
produced by the API, N consumed across orchestrator replicas.

## 4. Egress — meter `Messaging.Transport`

| Instrument | Type | Unit | Attributes |
| --- | --- | --- | --- |
| `pipeline.messages.produced` | `Counter<long>` | `{message}` | `route`, `destination`, `type`, `outcome` |
| `pipeline.produce.duration` | `Histogram<double>` | `s` | `route`, `destination`, `type`, `outcome` |

- `route` — `queue` (default exchange, `QueueSender`) · `fanout` (named exchange, `QueueFanoutPublisher`)
- `destination` — the queue name or the exchange name
- `type` — the message-type header, from `MessageTypes`
- `outcome` — `accepted` · `unroutable` · `transient` · `refused`

Both channels are created with `publisherConfirmationsEnabled` and
`publisherConfirmationTrackingEnabled`, and both publish with `mandatory: true`.
The duration is therefore a real broker round-trip to confirmation, not the time
to write a frame — which is what makes it worth a histogram at all.

### 4.1 Instrument the primitives, not the wrapper

The increment goes inside `QueueSender.SendAsync` and
`QueueFanoutPublisher.PublishAsync`, **not** in
`QueueSenderExtensions.SendTransientAsync`.

This is load-bearing. `WorkflowFireJob.cs:186` — the entry-step dispatch, one of
only two places a `process-dispatch` is ever produced — calls raw `SendAsync`
and then swallows the failure:

```csharp
catch (Exception ex) when (!context.CancellationToken.IsCancellationRequested)
{
    logger.LogWarning(ex, "the entry-step dispatch failed to send; continuing");
}
```

Instrumenting the wrapper would leave that path, and the processor bootstrap and
startup queries which also call `SendAsync` directly, with no metric at all.

### 4.2 Classifying `outcome`

`QueueFanoutPublisher` already does this work and can be read directly: it
remaps `PublishException { IsReturn: true }` to `UnroutablePublishException`,
then asks `SendFaultClassifier.IsTransport(ex)` and wraps a positive as
`TransientSendException`.

`QueueSender` does neither. It discards the channel, logs, and rethrows raw. So
the classification has to be performed at the metric site:

| Condition | `outcome` |
| --- | --- |
| the call returned | `accepted` |
| `PublishException { IsReturn: true }`, or `UnroutablePublishException` | `unroutable` |
| `SendFaultClassifier.IsTransport(ex)` | `transient` |
| anything else | `refused` |

Order matters — `unroutable` is tested first, because a return is a routing
fault and must not be absorbed into the transport bucket.

This produces something that does not exist today: **`QueueSender` currently
gives no distinct signal for "the queue is not declared" versus "the broker is
down".** Both surface as one `LogWarning` on the same line. `outcome` is the
first thing that separates them, and the two have opposite remedies.

The classification is read-only — it inspects the exception and never alters
control flow. The exception continues to propagate exactly as it does now.

## 5. Ingress — meter `BaseConsole.Core.Messaging`

| Instrument | Type | Unit | Attributes |
| --- | --- | --- | --- |
| `pipeline.messages.consumed` | `Counter<long>` | `{message}` | `queue`, `type`, `disposition`, `reason`, `landed` |
| `pipeline.process.duration` | `Histogram<double>` | `s` | `queue`, `type`, `disposition` |
| `pipeline.consumer.inflight` | `UpDownCounter<long>` | `{message}` | `queue` |
| `pipeline.consumer.consuming` | `ObservableGauge<int>` | `1` | `queue` |
| `pipeline.consumer.channel.resets` | `Counter<long>` | `1` | `queue`, `reason` |

### 5.1 The disposition matrix

`pipeline.messages.consumed` is incremented **exactly once per delivery, on
every exit path** of `OnReceivedAsync`. The values map one-to-one onto branches
that already exist — no new control flow, one line per branch:

**`disposition` and `reason` record what the consumer decided. `landed` records
whether the broker was told.** They are separate facts and must not be collapsed
into one attribute — see §5.2.

| Branch in `GatedQueueConsumer` | `disposition` | `reason` |
| --- | --- | --- |
| `!_gate.IsOpen` early check, before the handler | `requeued` | `gate_closed` |
| handler returned, ack issued | `acked` | `handled` |
| `DeliveryDisposition.RequeueAndTrip` | `requeued` | `store_unreachable` |
| `DeliveryDisposition.Requeue` | `requeued` | `send_failed` |
| `DeliveryDisposition.Park` (the `default` arm) | `parked` | `refused` |

Two attributes rather than one compound value, so that "how many deliveries were
not acked" is a filter on `disposition` and "why" is a drill-down on `reason`,
without either query needing to know the other's vocabulary.

Missing type header and no registered handler both throw and land on
`parked` / `refused`, which is correct: both are properties of the message.

### 5.2 `landed` is the new signal, and it is a third fact

`landed` is `false` when the acknowledgement never reached the broker — the
delivery tag belonged to a previous epoch, or the channel went away between
`TagStillValid` and the call. It means **the broker will redeliver a message
whose handler already ran to completion.** Today that is one
`LogDebug("acknowledgement dropped — channel gone")` and nothing else.

**It is an attribute rather than a sixth `disposition` value, and that is a
correction to an earlier draft of this spec.** A `dropped` disposition would
make two independent facts compete for one slot: a delivery that arrived while
the gate was shut *and* whose nack was lost is both `gate_closed` and dropped,
and whichever value won would erase the other. In practice the losing fact would
be the intent — so a routine gate pause that coincided with a broker blip would
report as a channel problem and send an operator after the wrong thing. Keeping
intent in `disposition`/`reason` and landing in `landed` makes both
representable, costs two attribute values, and — because the two are decided by
independent code paths — is what lets §11 test the intent matrix without a
broker.

Mechanically this means `SafeAckAsync` and `SafeNackAsync` return `bool` rather
than `void`, and `OnReceivedAsync` records one measurement per exit path using
that return. Recording inside the two Safe methods instead would put the
increment in two places and make "exactly once per delivery" a rule to remember
rather than a property of the code.

`pipeline.consumer.channel.resets` is the cause of `landed=false`: `reason` is
`shutdown` (`OnChannelShutdownAsync`), `recovered` (`OnRecoveredAsync`,
automatic recovery renumbering deliveries), or `reopened` (`OpenChannelAsync`
incrementing the epoch). The class's own remarks already name this failure
mode — "the service would sit consuming nothing while every other signal stayed
green."

### 5.3 The other three

- `pipeline.process.duration` is recorded **only when a handler actually ran**,
  so `gate_closed` rejects — which never enter a handler — do not flatten the
  histogram toward zero.
- `pipeline.consumer.inflight` increments on entry to the handler call and
  decrements in a `finally`. Against `GatedConsumerOptions.PrefetchCount` it
  gives prefetch saturation.
- `pipeline.consumer.consuming` reads the existing `IsConsuming` property
  (`_consumerTag is not null`). `min()` across replicas answers "is anything
  listening to this queue at all", which no current signal answers.

### 5.4 Instrument ownership

The counters and histograms are `static readonly` on a `static readonly Meter`,
shared by every instance; `queue` is an attribute, not a separate instrument.

The **observable gauges are not**, and this is the one place the design can go
quietly wrong. `AddGatedQueue` uses a plain `AddSingleton` with a factory per
queue, so an orchestrator holds **three** `GatedQueueConsumer` singletons — the
per-replica announcement queue and the two shared execution queues — and a
processor holds one. A single static `ObservableGauge` with one callback cannot
see them all, and creating one per instance on the shared meter is correct only
because these are singletons.

So: each `GatedQueueConsumer` registers its own `pipeline.consumer.consuming`
gauge in its constructor, with its own `queue` attribute baked into the
measurement. `L2GateMetrics` (§6) does the same for the single `L2Gate`.

An observable's callback only runs while something holds the registration alive,
and a DI singleton is never constructed until it is resolved. Every observable
owner is therefore either already an `IHostedService` — which
`GatedQueueConsumer` is — or registered as one with no-op `StartAsync`/
`StopAsync`, purely so the container constructs it. That is the case for
`L2GateMetrics` and for the two role observers in §6.

Neither type may create an observable outside its constructor. An observable
registered per call, or per converge pass, leaks a callback per registration and
the exported value becomes whichever stale instance answers last.

## 6. Gate and role-specific gauges

**Meter `BaseConsole.Core.Gating`** — both roles:

| Instrument | Type | Source |
| --- | --- | --- |
| `pipeline.gate.open` | `ObservableGauge<int>` 0/1 | `L2Gate.IsOpen` |
| `pipeline.gate.trips` | `Counter<long>` | the falling edge of `L2Gate.StateChanged` |

The gate is the best single answer to "why did the pipeline stop", and it is the
same instrument on both roles.

**`L2Gate` itself is not modified**, and this is a constraint rather than a
preference. Its own type remarks state that
`BaseConsole.Core.Gating.L2Gate` is "a deliberate copy of
`BaseApi.Core.Gating.L2Gate`, not a shared type … Behaviour must not diverge:
the two are covered by parallel test classes so a change to one that is not made
to the other fails a build." Instrumenting one copy while §10 holds the API side
out of scope would be exactly that divergence.

So the instruments are owned by a new `L2GateMetrics` in
`BaseConsole.Core.Gating`, which takes the `L2Gate` singleton, registers the
observable over its `IsOpen`, and subscribes to `StateChanged` for the trip
counter. Both copies of `L2Gate` stay byte-identical. This also respects the
gate's other standing rule — handlers run under its mutex and must not perform
I/O — because incrementing a counter is a flag flip, and the gauge does not use
the event at all.

**Meter `Orchestrator`:**

| Instrument | Source | Why |
| --- | --- | --- |
| `pipeline.leader` 0/1 | `LeaderState.IsLeader` (`LeaderState.cs:35`) | Explains why cron fires land on one replica and not the others. Note that only cron fires are fenced — `StepOutcomeHandler` is deliberately not gated on leadership, so a follower with `pipeline.leader = 0` is still expected to be consuming. |
| `pipeline.hydration.admitted` 0/1 | `HydrationAdmission.IsOpen` (`HydrationAdmission.cs:45`) | One-shot readiness. Distinguishes "not consuming because the store is down" from "not consuming because the first hydration pass has not finished". |

**Meter `BaseProcessor.Core`:**

| Instrument | Source | Why |
| --- | --- | --- |
| `pipeline.identity.ready` 0/1 | `IProcessorContext.Identity is not null` | An unregistered processor waits rather than restarting — Running/NotReady with 0 restarts is by design. This is the metric that makes that legible instead of alarming. |
| `pipeline.duplicate.suppressed` `Counter<long>` | the `"entry absent — treating as a duplicate delivery"` return in `ProcessDispatchHandler` | That path acks having done no work, so it is invisible under `disposition=acked`. It is the primary idempotence mechanism, and its rate is how you would ever notice the mechanism firing more than rarely. |

`pipeline.duplicate.suppressed` has no orchestrator counterpart, and the
asymmetry is intended. `StepOutcomeHandler` makes the *opposite* choice on the
same shape — an absent blob is refused rather than treated as a duplicate — so
its equivalent already lands on `parked` / `refused`.

## 7. The queries this is for

The three terms the design was asked for are views over the generic
instruments, not instruments of their own. The type filter carries the meaning:

```
dispatched = pipeline.messages.produced{type="process-dispatch"}
consumed   = pipeline.messages.consumed{disposition="acked"}
nacked     = pipeline.messages.consumed{disposition=~"requeued|parked"}
```

Because both roles emit one vocabulary, these compose across the service
boundary — which is the property the whole design exists for:

```promql
# in-flight backlog for one hop: the orchestrator's sends minus the processor's acks
sum(rate(pipeline_messages_produced_total{type="process-dispatch",outcome="accepted"}[5m]))
  - sum(rate(pipeline_messages_consumed_total{type="process-dispatch",disposition="acked"}[5m]))

# retry amplification: how much work is being redone
sum(rate(pipeline_messages_consumed_total{disposition=~"requeued|parked"}[5m])
  or rate(pipeline_messages_consumed_total{landed="false"}[5m]))
  / sum(rate(pipeline_messages_consumed_total[5m]))

# work that completed but will be redelivered anyway -- the silent case
sum(rate(pipeline_messages_consumed_total{disposition="acked",landed="false"}[5m]))

# is anything listening
min(pipeline_consumer_consuming) by (service_name, queue)

# why the pipeline stopped, in one panel
pipeline_gate_open / pipeline_leader / pipeline_hydration_admitted / pipeline_identity_ready
```

## 8. Cardinality

| Attribute | Values | Note |
| --- | --- | --- |
| `queue` | 1 per processor process; 3 on an orchestrator (`orchestrator-result`, `orchestrator-result-post`, the per-replica fanout queue) | Bounded and small. |
| `destination` | includes `processor-{guid}` | **One series per processor in the deployment**, times `type` times `outcome`. Fine at tens, worth revisiting at hundreds. Opt-out is collapsing it to the literal `processor-work`, which loses per-processor send visibility. |
| `type` | the `MessageTypes` constants | Fixed set. |
| `outcome`, `disposition`, `reason`, `route` | fixed enums above | Fixed sets. |
| `landed` | `true` / `false` | Two values. In steady state everything is `true`, so the series count barely moves. |

## 9. Wiring

`AddBaseConsoleObservability` gains the two shared meters in its `WithMetrics`
block, beside `AddRuntimeInstrumentation()`:

```csharp
.AddMeter("Messaging.Transport")
.AddMeter("BaseConsole.Core.Messaging")
.AddMeter("BaseConsole.Core.Gating")
```

The role-specific meters are added by each host after its own call, so a role
does not carry the other's meter name. The resource block is untouched — it
already carries everything §2.1 needs, and the existing per-provider
`SetResourceBuilder` arrangement (which keeps the logs resource from leaking
onto metrics) must not be disturbed.

## 10. Out of scope

- **`BaseApi.Core/Messaging/GatedQueueConsumer.cs`** — a separate copy of the
  consumer, on the API side with its own observability wiring. Instrumenting it
  is not automatic and is not part of this change. Until it is done, the API's
  consumption of `step-outcome` and its query queues is dark, and any
  produced-vs-consumed comparison that crosses into the API will not balance.
- **`QueueFanoutPublisher`'s call sites** — the class is instrumented here
  because it lives in the shared assembly, but its only callers are the two API
  handlers, whose host does not register the `Messaging.Transport` meter. The
  instrument will exist and emit nothing until the API side is wired.
- Traces. There is no traces pipeline in either worker — the collector receives
  none and the SDK emits none — and this design does not add one.

## 11. Testing

- **Unit, egress:** the `outcome` classification table in §4.2 is a pure
  function of an exception and is tested as one, including the ordering of
  `unroutable` before `transient`.
Observation is by `System.Diagnostics.Metrics.MeterListener`, which subscribes
by meter name and needs no OpenTelemetry pipeline.

- **Unit, ingress — the whole §5.1 matrix, hermetically.** Splitting `landed`
  out of `disposition` is what makes this possible. `ConsumerAdmissionTests`
  already proves a real `GatedQueueConsumer` can be constructed with no broker —
  `RabbitMqConnection` opens no socket in its constructor — and the
  `(disposition, reason)` decision is taken before any channel is touched. With
  `OnReceivedAsync` made `internal` (the precedent is the existing
  `internal bool ShouldConsume`), all five rows are reachable: `gate_closed`
  from a closed `L2Gate`, and the other four from a fake `IQueueMessageHandler`
  registered in the scope factory that returns or throws the relevant exception.
  Every one of these records `landed=false`, because there is no channel — which
  is correct, and is asserted.
- **`landed=true` is not covered hermetically**, and the plan must not claim it
  is. It requires a real channel and a valid delivery tag, so it is exercised
  only by a RealStack run.
- **Unit, egress:** the `outcome` classification table in §4.2 is a pure
  function of an exception and is tested as one, including the ordering of
  `unroutable` before `transient`.
- **Invariant:** exactly one `pipeline.messages.consumed` increment per
  delivery, on every path — asserted with a `MeterListener` over a run that
  exercises all five rows. This is the property that makes the §7 conservation
  queries meaningful, so it is tested directly rather than inferred from the
  per-branch tests. Returning `bool` from the two Safe methods (§5.2) is what
  reduces it to "one `Record` call per exit path of one method".
- **Wiring:** extend `ConsoleObservabilityTests` to assert the three shared
  meters are registered, so a future worker cannot ship without them. Extend
  `OrchestratorHostWiringTests` — which already asserts three consumers exist —
  to assert three distinct `queue` values are observed on
  `pipeline.consumer.consuming`, which is what catches an observable gauge
  registered in the wrong place per §5.4.
- The hermetic baseline before this work is **451 tests: 444 passed, 7 skipped,
  0 failed**, in about 15s. Every task must leave it at 0 failed with the skip
  count unchanged.

## 12. Changes made while writing the implementation plan

The plan is `docs/superpowers/plans/2026-08-22-pipeline-metrics.md`. Three
defects in the approved draft were found by planning against the real code and
are corrected above rather than left to contradict the plan.

1. **`dropped` was a disposition; it is now the `landed` attribute** (§5.1,
   §5.2). As a disposition it made two independent facts compete for one slot,
   and the fact that lost was the consumer's intent. As a side effect the whole
   intent matrix became testable without a broker.
2. **`L2Gate` is no longer modified** (§6). Its type remarks bind it to stay
   identical to `BaseApi.Core.Gating.L2Gate`, which §10 holds out of scope, so
   the instruments moved to a separate `L2GateMetrics` owner.
3. **Observable ownership is now explicit** (§5.4). A DI singleton is not
   constructed until resolved, so an observable's owner must be an
   `IHostedService` or nothing ever registers the callback.

Two facts were verified against the repository rather than assumed, because the
plan depends on both:

- `System.Diagnostics.Metrics.Meter` compiles in `Messaging.Transport` with **no
  new package reference** — RabbitMQ.Client 7.1.2 brings
  `System.Diagnostics.DiagnosticSource` transitively. Confirmed by building a
  throwaway probe file against that project.
- All five projects already grant `InternalsVisibleTo("BaseApi.Tests")`, so the
  `internal OnReceivedAsync` seam needs no project-file change. Note that
  `DynamicProxyGenAssembly2` is deliberately *not* granted, so internal types
  cannot be substituted with NSubstitute — the ingress tests use hand-written
  fakes, which is what the existing `ConsumerAdmissionTests` already does.
