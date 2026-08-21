# Orchestrator Control Plane — Design

**Status:** proposed
**Date:** 2026-08-20
**Scope:** the orchestrator service's control plane — startup hydration, the L1 mirror, workflow
scheduling, leader-gated firing of entry steps, and the start/stop fanout that keeps three replicas
in step.

---

## 1. Purpose and scope

`src/` has an API that validates workflows and projects them into L2 (Redis), and processors that
execute a step when a `ProcessDispatch` arrives. Nothing sends that dispatch. This service is what
fires a workflow's entry steps on a schedule.

**In scope:**

- A new `src/Orchestrator` console service, three replicas under a StatefulSet.
- Startup hydration: read every workflow from L2, mirror into an in-memory L1, activate a scheduler
  job per scheduled workflow.
- A fanout from the API to all three replicas announcing that L2 has changed, so a running replica
  re-mirrors one workflow without restarting.
- Quartz scheduling, one self-rescheduling job per workflow.
- Kubernetes leader election, so exactly one replica actually dispatches.
- A watchdog over both long-running loops.

**Explicitly out of scope, and deliberately so.** The *result path* — consuming
`OrchestratorQueues.Result`, handling `StepCompleted` / `StepFailed` / `StepCancelled`, advancing a
workflow to its successors, copying execution blobs per successor under derived ids, and the three
reclaim duties recorded in `2026-08-20-base-processor-consumers-design.md` §7.1 — is a subsystem of
comparable size and gets its own spec. **Nothing in this design completes a workflow.** It fires
entry steps; the steps run; their results are consumed by nobody until that second subsystem exists.

---

## 2. Invariants

These hold everywhere in this service. A change that breaks one is a change to this design, not an
implementation detail.

1. **The orchestrator never writes or deletes L2.** The API owns every L2 mutation. The orchestrator
   reads L2 and mirrors it into L1. This is what makes every "who wins" question in §7 answerable.
2. **L2 is the source of truth.** L1 is a mirror, never persisted, rebuilt from L2 on every start.
   Where a message and L2 disagree, L2 wins.
3. **A fanout message is an announcement, not a payload.** It carries a workflow id and nothing else.
   The replica re-reads L2. A message that carried the definition could be applied after a newer
   write and would silently reinstate a stale graph.
4. **The orchestrator StatefulSet never scales down.** Per-replica queues are durable; a queue whose
   replica is permanently gone would bind to the fanout exchange and accumulate forever with nothing
   draining it. Scaling up is safe; scaling down is an operational error this design does not defend
   against.
5. **No `ProjectReference` to any `BaseApi.*` project**, matching the firewall `Processor.Sample` and
   `BaseProcessor.Core` already respect. `BaseConsole.Core` and `Messaging.Contracts` only.
6. `net8.0`, nothing above C# 12. `Messaging.Contracts` stays BCL-only.
7. **Ids render fixed:** `CorrelationId` as `ToString("N")`; `WorkflowId`, `StepId`, `ProcessorId`,
   `ExecutionId`, `EntryId` as `ToString("D")`. Log attribute keys are PascalCase. Never interpolate
   an id into a log template. Never log a payload or a config.

---

## 3. Flow

```
API                                   Broker                     Orchestrator replica (×3)
───                                   ──────                     ─────────────────────────
OrchestrationService.StartAsync
  validate (5 gates)
  send StartOrchestration ──────────> orchestrator-control
                                          │
                                      (competing consumer: the API itself)
                                          ▼
                                      StartOrchestrationHandler
                                        L2 clean + write        ← the ONLY L2 mutation
                                        publish OrchestrationStarted
                                                │
                                                ▼
                                      orchestrator-fanout (exchange)
                                          ├──> orchestrator-control.orchestrator-0
                                          ├──> orchestrator-control.orchestrator-1
                                          └──> orchestrator-control.orchestrator-2
                                                                    │
                                                                    ▼
                                                              ApplyStartHandler
                                                                read L2 root
                                                                unschedule old job
                                                                L1 set + schedule
```

Startup on each replica, before any of the above is consumed:

```
hydration loop beats
        ▼
IStartupGate.MarkReady()  →  /health/startup healthy
                             (the loop is running; says nothing about L2 being reachable,
                              and is re-asserted on every retry because it is idempotent)
        ▼
hydration loop opens the connection   (topology declared: queue exists, fanout messages buffer here)
        ▼
hydration loop: SMEMBERS skp: → read each root → L1 → schedule
        ▼
        │  a fault at either of the two steps above: log, back off, beat, retry from the top.
        │  /health/startup stays green throughout; /health/ready stays red.
        ▼
IConsumerAdmission opens  →  fanout consumption begins, draining the backlog
                             (and only while loop 1's L2 gate is open: the two are
                              independent conditions on the same decision, not a sequence)
        ▼
/health/ready healthy     →  this replica has mirrored L2 and is consuming
```

**The startup gate is ahead of both dependencies, and that placement is the design.** A gate marked
after a complete pass reports "hydrated", which is a stronger and more useful claim — but the startup
probe has a finite budget (`failureThreshold × periodSeconds`) and the outage this loop is built to
retry through does not. Past that budget the kubelet kills the pod, and under `podManagementPolicy:
Parallel` it kills all three replicas together, turning the survivable outage of §6.4 into a
whole-service crash loop. So readiness claims what `ProcessorLivenessHeartbeat.cs:95` claims on its
first beat — the loop is running — and the "hydrated" claim moves to `/health/ready`, the one probe
that may fail for the length of an outage and recover without a restart.

---

## 4. Topology and the publish primitive

### 4.1 Why a publish primitive is needed

`src/` has no publish. Both `BasicPublishAsync` call sites — `QueueSender.cs:63` and
`RpcQueueConsumer.cs:163` — pass `exchange: string.Empty`, the default exchange, routing by queue
name. `IQueueSender`'s own doc draws the distinction deliberately: "Send, not publish… addressed to a
queue whose consumer is known, not offered to whoever is interested."

Every existing queue is competing-consumer: exactly one consumer gets each message. Here all three
replicas must get it, because each holds its own L1 and its own schedule. That is the one genuine
divergence from existing practice, and it is forced by the requirement.

### 4.2 `IQueueFanoutPublisher`

New in `Messaging.Transport`, deliberately separate from `IQueueSender` so the send/publish
distinction the codebase argues for survives:

```csharp
Task PublishAsync<T>(string exchange, string type, T body, CancellationToken ct);
```

Same serializer options, same persistent delivery mode, same publisher confirms with tracking as
`QueueSender` — so a publish that returns has been accepted by the broker, and one that throws is a
real failure.

**Transient classification is mandatory at the call site.** `DeliveryClassifier` maps
`TransientSendException` → Requeue, an L2 fault → RequeueAndTrip, and **anything else → Park**. A raw
broker exception escaping the publish would park the API's control message — the opposite of the
intent. The publish is therefore wrapped by the existing `SendFaultClassifier.IsTransport` allow-list
exactly as `SendTransientAsync` is.

### 4.3 `OrchestratorFanout` — one source of truth for the names

New static class in `Messaging.Contracts`, because both the API and the orchestrator resolve these
names and neither may own them:

```csharp
public const string Exchange = "orchestrator-fanout";
public const string DeadLetterExchange = "orchestrator-fanout-dlx";
public static string PerReplica(string instanceId) => $"orchestrator-control.{instanceId}";
public static string Dead(string instanceId) => $"orchestrator-control.{instanceId}.dead";
```

`instanceId` is `POD_NAME`, falling back to `Environment.MachineName` — the identity the reference's
leader election already uses, and a StatefulSet ordinal in production.

**Why one definition, stated as a requirement rather than a preference.** The queues are
non-exclusive. Two replicas resolving to the *same* name does not raise `RESOURCE_LOCKED` and does not
fail loudly anywhere — it silently degrades the broadcast into a competing-consumer load-balance, each
control message reaching one replica instead of three, the other two holding stale L1 and stale
schedules, with nothing in the transport reporting it. The reference hit this in production (its
HA-07: a literal endpoint name bypassing the per-instance formatter) and its own doc calls a
divergence here "the highest-consequence, lowest-visibility mistake available in this phase."

A test asserts that three distinct instanceIds produce three distinct names. The broker will not tell
us; only an assertion will.

### 4.4 Declarations

Both sides declare through `IRabbitMqTopology`, at connection setup — never as a side effect of
consuming, per that interface's contract.

- **API side:** the fanout exchange and its dead-letter exchange only. The API must not invent queues
  for replicas that may not exist.
- **Orchestrator side:** the same two exchanges (redeclaration is idempotent), plus its own durable,
  non-exclusive, non-auto-delete quorum queue bound to the fanout exchange, plus its `.dead` queue
  bound to the dead-letter exchange under its own routing key. The dead-letter exchange is declared
  **before** the queue naming it, since that argument is not validated at declare time and a queue
  pointing at a missing exchange discards every parked message silently.

Declaring is the first thing each hydration pass does, before it reads a byte of L2 — opening the
shared connection is what runs the declarations, and hydration is what opens it. So the queue exists
before the read, and fanout messages published while a replica is still hydrating accumulate in a
durable queue and are drained when consumption is admitted. A pass that cannot reach the broker backs
off and retries exactly as one that cannot reach L2 does.

### 4.5 The unroutable-publish window

Publisher confirms guarantee the broker *accepted* a message, not that it *routed* one. A fanout
exchange with no bound queue discards silently and still confirms — the API would report a start
accepted and it would vanish.

This is reachable only before any orchestrator replica has ever started, or after out-of-band queue
deletion; the queues are durable, so once a replica has run once its queue persists independently of
whether the replica is running. A partially-missing set is not affected: a fanout with two of three
queues present routes to those two, and the third re-converges from L2 when it first starts.

**Decision:** publish with the `mandatory` flag and a return handler, so an unroutable publish raises,
classifies transient, and NACKs the API's control message until a replica exists. Cost is a few lines;
the alternative is an API that reports work accepted and loses it.

### 4.6 New contracts

`OrchestrationStarted(Guid WorkflowId)` and `OrchestrationStopped(Guid WorkflowId)` in
`Messaging.Contracts`, with two new `MessageTypes` constants. Past tense deliberately: they announce
that L2 has already been written or cleaned. They carry no definition — see invariant 3.

---

## 5. API-side changes

Both are two-line changes at the end of an existing handler.

- **`StartOrchestrationHandler`** — after `_cleanup.RemoveAsync` and `_writer.WriteAsync`, publish
  `OrchestrationStarted(workflowId)`.
- **`StopOrchestrationHandler`** — after its L2 clean, publish `OrchestrationStopped(workflowId)`.

**Why here and nowhere else.** `OrchestrationService.StartAsync` validates and then *sends* to
`orchestrator-control`; the L2 write happens later, in the handler consuming that queue. The last line
of the handler is the only point in `src/` where "validated **and** written" is true. Publishing from
the service would announce a write that has not happened, and a replica reading L2 on that announcement
would find stale data or none.

**Failure semantics, which fall out for free.** The publish sits inside the gated control consumer. A
publish failure classifies transient → NACK → redelivery → the clean-and-write runs again (already
documented as unconditional and idempotent) → the publish runs again. That redelivery is what makes
the orchestrator's idempotency requirement load-bearing rather than decorative: the two requirements
hold each other up.

---

## 6. The orchestrator's internals

### 6.1 `WorkflowL1Store`

In-memory `ConcurrentDictionary<Guid, L1Entry>` where `L1Entry` is the `WorkflowL1` definition plus
the `Guid JobId` of its currently-scheduled Quartz job. Try-get, set, remove. Never persisted.

Enumerate is **not** there: nothing in this build reads every entry, and a method with no caller
reads as a live mechanism — the same argument §8.3 makes for not carrying the reference's last-fired
timestamp. The result path can add one when it has a reader.

The jobId coupling is not bookkeeping — it is what makes job supersession detectable. See §8.2.

### 6.2 Loop 1 — the L2 gate

Unchanged from what `BaseConsole.Core` ships. `AddBaseConsoleGating(cfg, queue)` supplies `L2Gate`,
`L2GateProbe`, `GatedQueueConsumer`, and a `LoopLivenessHealthCheck` named `l2-gate`, tagged `live`,
budgeted at `Interval × StaleFactor`.

### 6.3 Loop 2 — hydration

Declares this replica's topology first — see §4.4 — then reads `SMEMBERS skp:` (the parent-index SET
every workflow root is added to by `L2ProjectionWriter.cs:71`), then each `Root(workflowId)` and its
steps, mirrors into L1, and calls the shared activation path (§7.1) per workflow.

Retries forever on a broker or L2 fault with the same backoff-to-cap shape as
`ProcessorStartupOrchestrator`, beating its heartbeat each iteration.

`IStartupGate.MarkReady()` is called **beside that beat, at the top of every attempt** — not on
success. It reports that the loop is running, exactly as `ProcessorLivenessHeartbeat.cs:95` does on
its own first beat; see §3 for why tying it to success made a dependency outage fatal. It is
idempotent, so re-asserting it per attempt costs a no-op rather than a first-attempt flag.

On success — and only then — it opens `IConsumerAdmission` and **retires** its heartbeat, so its
liveness check stops expecting ticks; the console `ILoopHeartbeat` already carries
`IsRetired`/`Retire` for this.

Two health checks over this loop, answering the two different questions about it:

- `hydration`, a `LoopLivenessHealthCheck`, tagged `live`, budgeted `BackoffCap × StaleFactor` — is
  the loop still ticking?
- `orchestrator-hydrated`, a `HydrationReadyHealthCheck` over `HydrationAdmission.IsOpen`, tagged
  `ready` — has it finished? Red for the whole of any outage, which is the correct answer and costs
  nothing: no `Service` routes traffic to these pods, so this gates only the pod's `READY` column,
  where `0/1` now means "still hydrating".

### 6.4 The watchdog, and what it is not for

Neither liveness check knows or cares whether L2 has data or whether the gate is open. Each answers
one question: is this loop still ticking? A wedged loop fails liveness and Kubernetes restarts the
pod. An unreachable L2 keeps both loops ticking and the pod alive — that is a dependency outage, not a
crash, and restarting the pod would not help.

### 6.5 `IConsumerAdmission` — begin consuming only when the host says so

```csharp
public interface IConsumerAdmission { bool IsOpen { get; } }
```

`GatedQueueConsumer` consults it before it begins consuming, waiting on the converge-interval backstop
it already uses for gate changes. `AddBaseConsoleGating` registers an always-open default.

- **Processor today:** gets the default. Behaviour byte-identical to now.
- **Orchestrator:** registers an implementation backed by hydration completion.
- **Processor later:** a one-line registration backed by `IProcessorContext.IsHealthy` closes the gap
  recorded in `2026-08-20-processor-execution-path.md` Known Gaps, where a dispatch arriving before
  the schema definitions resolve currently parks. **Not done in this build** — it changes processor
  behaviour and belongs in its own change.

The three gates stay distinct on purpose: `L2Gate` is dynamic and reopens; `IStartupGate` reports
health; `IConsumerAdmission` is one-shot admission to consume. Reusing `IStartupGate` for admission
would change processor timing immediately, because `ProcessorLivenessHeartbeat.cs:95` already marks it
ready.

That distinction is what lets the orchestrator's startup gate move onto the loop's first beat (§6.3)
without the admission latch following it. The replica reports itself startable within seconds and
still refuses to consume its fanout queue until L1 mirrors L2 — one condition would not have been
able to carry both.

---

## 7. The consumers

### 7.1 The shared activation path

One method, used by hydration and by the start consumer, so there is no second path to drift:

1. Read `Root(workflowId)` and the workflow's steps from L2.
2. If absent, return — nothing to activate.
3. If L1 already holds this workflow, unschedule its stored jobId.
4. Put the definition in L1 with a fresh jobId.
5. If `Cron` is non-null, schedule. A null cron means unscheduled, which is a valid projection —
   `WorkflowL1`'s own doc states the decision belongs to whoever reads the root.

### 7.2 Start consumer (`ApplyStartHandler`)

Deserialize `OrchestrationStarted`; a body that will not read throws `JsonException`. Then run the
shared activation path.

**A workflow absent from L2 is a no-op, logged and acked — not parked.** It is reachable: a stop
cleaned L2 after this start was published. L2 is the source of truth and L2 says the workflow is gone;
applying the message would resurrect something an operator stopped, and parking it would DLX a
legitimate race outcome rather than a defect.

**Idempotent.** A second delivery tears down the job it created and schedules a fresh one; end state
is one job and one L1 entry with the same definition. The jobId differs between runs and never leaves
the replica, so nothing observes the difference.

Rescheduling does not starve a workflow: Cronos computes the next *absolute* occurrence, so repeated
redeliveries recompute the same wall-clock fire time rather than restarting an interval.

### 7.3 Stop consumer (`ApplyStopHandler`)

**Verify first, then act:**

1. Read `Root(workflowId)` from L2.
2. **If still present, do nothing** — ack, no job touched, no L1 change.
3. If absent, unschedule the stored jobId, then remove from L1.

The orchestrator is not responsible for the L2 removal; it verifies it.

**Why the verify precedes the teardown.** The API can process a stop and then a start: it cleans L2,
publishes the stop, writes L2 again, publishes the start — and both are queued on this replica in that
order. When the stop is handled, L2 already holds the re-written workflow. Unscheduling first would
stop a workflow L2 says is live, until the start behind it in the queue is processed. Verifying first
makes that window not exist.

**Idempotent.** A second delivery finds L1 empty and does nothing.

### 7.4 Failure classification

Falls out of the existing `DeliveryClassifier` with no new machinery.

| Path | Fault | Classification | Effect |
|---|---|---|---|
| API control consumer | unreadable body | not transient | Park → DLX |
| API control consumer | fanout publish failure | `TransientSendException` | NACK, requeue, re-write, re-publish |
| API control consumer | unroutable publish (`mandatory`) | `TransientSendException` | NACK until a replica queue exists |
| Orchestrator fanout consumer | unreadable body | not transient | Park → per-replica DLX |
| Orchestrator fanout consumer | L2 read fault | L2 transient | RequeueAndTrip — requeue *and* close the gate |
| Orchestrator fanout consumer | workflow absent from L2 | not a fault | log, ack, no-op |
| Fire path | send fault on an entry-step dispatch | swallowed per entry step | logged; reschedule still runs (§8.3) |

RequeueAndTrip on an L2 read matters: the replica stops consuming until the store returns, rather than
spinning through a backlog failing each message in turn.

---

## 8. Scheduling

### 8.1 `WorkflowScheduler`

Quartz, one self-rescheduling one-shot job per workflow, `JobKey(jobId.ToString("D"))`, trigger fired
at the next Cronos occurrence, `[DisallowConcurrentExecution]` so one key never double-fires.
`DeleteJob` on unschedule removes job and triggers atomically.

### 8.2 Supersession — the hazard the jobId coupling closes

A start arriving while that workflow's job is mid-fire deletes the job and schedules J2. The running
fire then reaches its self-reschedule and re-creates its own job — the reference does this deliberately,
because a non-durable one-shot with no triggers is auto-purged and its reschedule must be able to
recreate it. The result would be J1 resurrected alongside J2: two live jobs for one workflow, both
firing every tick, double-dispatching every entry step.

**Before rescheduling, the fire job checks that its own jobId is still the one L1 holds for that
workflow.** If it is not, this fire belongs to a superseded job: log and exit without rescheduling, and
let it be purged.

### 8.3 `WorkflowFireJob`

On each fire:

1. Read the `workflowId` from the job's data map and look it up in L1. Absent → log, skip; the
   workflow was stopped and this job is on its way out.
2. **Leader gate, before the dispatch only.** A follower skips step 3 and continues.
3. For each entry step in `EntryStepIds`, send one `ProcessDispatch` to
   `ProcessorQueues.Work(step.ProcessorId)`, type `MessageTypes.ProcessDispatch`:
   - `CorrelationId` — **freshly minted per fire**, the id that ties one run together.
   - `EntryId = Guid.Empty` — an entry step is a source step: no upstream input, the author produces
     its own. This is the branch the processor's pre handler already implements.
   - `ExecutionId = Guid.Empty` — an entry dispatch opens no lineage; the author mints one via
     `NewExecutionId`.
   - `Payload` — `StepL1.Payload`, the step's processor config.
4. Supersession check (§8.2), then reschedule off the next Cronos occurrence.

The reference also refreshes an in-memory liveness timestamp on each fire. It is **not** carried here:
nothing in this design reads it, and a field written on every fire and read by nobody reads as a live
mechanism. If the result path later needs a last-fired time, it can add one with a reader attached.

**An infra fault on a send is logged and swallowed, per entry step.** A self-rescheduling one-shot
that throws before rescheduling never fires again, which would stop the workflow permanently on that
replica over a transient broker blip. The swallow is per-entry-step so one blip does not drop sibling
sends, and a host-shutdown cancellation still propagates so shutdown proceeds. This differs from every
other send path in the system, and the difference is deliberate.

---

## 9. Leader election

`LeaderElectionService`, a `BackgroundService` over the `coordination.k8s.io/v1` Lease
`skp/orchestrator-leader` via `KubernetesClient`, identity from `POD_NAME`. It is the sole writer of
`LeaderState`.

| Setting | Value |
|---|---|
| Lease duration | 15s |
| Renew deadline | 10s |
| Retry period | 2s |

**The renew deadline must stay below the lease duration.** That is the self-demotion fence: a leader
that loses its lease closes its own gate within the renew window rather than discovering it later and
dispatching alongside the new leader. Do not invert.

All three replicas keep full L1 and live schedules; followers fire, hit the gate, skip the dispatch,
and reschedule. A leadership change therefore costs nothing — the new leader's schedule is already
running and already correct.

**Registered only when running in-cluster.** Hermetic tests drive `LeaderState` directly rather than
standing up an election, exactly as the reference does.

---

## 10. Observability

Every record from a fanout consumer or a fire carries a log scope with `WorkflowId`, and where
applicable `StepId` and `ProcessorId`, rendered `"D"`. A fire's records carry `CorrelationId` rendered
`"N"` under `CorrelationKeys.LogScope`, matching `ExecutionLogScope`'s split — `CorrelationId` keeps
its own key and renderer because it crosses the HTTP boundary.

Health endpoints come from `BaseConsole.Core`, and the three answer three different questions:

| Probe | Answers | Backed by | Red when |
|---|---|---|---|
| `/health/startup` | is the hydration loop running? | `startup` check over `IStartupGate` | the process cannot get as far as its first beat |
| `/health/ready` | has this replica mirrored L2 and begun consuming? | `orchestrator-hydrated` over `HydrationAdmission.IsOpen` | any broker or L2 outage, for as long as it lasts |
| `/health/live` | are the loops still turning? | `self`, `l2-gate`, `hydration` | a loop has wedged or died |

Startup deliberately no longer means "hydration complete" — that budget was finite and the outage it
was covering is not; see §3. No `live`-tagged check touches a dependency, so an outage restarts
nothing.

---

## 11. Testing

Hermetic, no broker, no Redis, no Kubernetes — matching how the processor is tested.

- **Fanout naming:** three distinct instanceIds → three distinct queue names. This is the silent-
  degradation guard from §4.3 and the broker cannot provide it.
- **Topology:** the dead-letter exchange is declared before the queue naming it, asserted by call
  ordering against a substituted `IChannel`; both binds are asserted too, because a declared-but-
  unbound queue is a broker in perfect health delivering nothing.
- **Hydration:** builds L1 from a substituted `IDatabase`; retries and keeps beating on an L2 fault;
  retires its heartbeat and marks ready on success. Separately: it declares this replica's topology
  *before* it reads L2 (§4.5) — an ordering assertion, not a failure assertion, which is why
  `ITopologyDeclarer` exists as a seam at all.
- **Readiness:** the hydration readiness check is unhealthy until admission opens and healthy after,
  which is what makes `0/1 READY` mean "still hydrating" rather than "broken".
- **Consumer admission:** the consumer does not consume while admission is closed, and does once open.
- **Start consumer:** applies; is idempotent across a replay; no-ops when the workflow is absent from
  L2; parks an unreadable body; requeues-and-trips on an L2 fault.
- **Stop consumer:** does nothing when L2 still holds the workflow; unschedules then removes when it
  does not; is idempotent.
- **Supersession:** a fire whose jobId no longer matches L1 does not reschedule.
- **Fire:** dispatches one `ProcessDispatch` per entry step with `EntryId`/`ExecutionId` empty and a
  fresh correlationId; a follower dispatches nothing but still reschedules; a send fault is swallowed
  and the reschedule still happens.
- **Leader timings:** renew deadline < lease duration, asserted against the constants.
- **The self-rescheduling chain:** a real started Quartz scheduler, a RAM job store and a real clock
  are driven through two fires a second apart. **This is the only test in the branch that proves a
  workflow fires more than once.** Every other scheduling test proves one half that never meets the
  other — `WorkflowSchedulerTests` reads the job store back through a scheduler it deliberately
  never starts, and `WorkflowFireJobTests` calls `Execute` directly against a recording scheduler —
  so the mechanism in §8.3 step 4, a fire arming its own successor, lives only in the seam between
  them. It is also what checks the Quartz claim `WorkflowScheduler`'s remarks rest on: that a
  completed no-repeat trigger is still in the store while `Execute` is on the stack. If that were
  wrong, every workflow on every replica would fire exactly once and stop, with no exception, no log
  and no probe.
- **Host wiring:** the composition root actually builds, under `Development` so that both
  `ValidateOnBuild` and `ValidateScopes` run. Beyond resolution it pins the substitutable seams to
  their production implementations — the scheduler closed over `WorkflowFireJob`, `ITopologyDeclarer`
  bound to `ConnectionTopologyDeclarer` — because every other test in this list deliberately
  substitutes them, so a wrong binding here is invisible everywhere else.

**One test is deliberately not hermetic, because the property it checks cannot be.** Everything above
substitutes Redis, so the suite proves the hydration loop recovers when the store starts answering —
never that the store *starts answering*. That second half is a property of StackExchange.Redis: a
multiplexer built with `AbortOnConnectFail=false` against a dead endpoint must reconnect in the
background, or the retry loop spins forever and the pod restart the whole design avoids becomes the
only repair. `RedisReconnectLiveTests` stages exactly that against a real Redis — a loopback
forwarder that refuses connections, a real multiplexer built through the production
`ParseForcingNonAborting` path, hydration left retrying, then the forwarder opened — and asserts
admission opens and `IsConnected` goes true on the same multiplexer instance. It is gated on
`SKP_REALSTACK` like the rest of `Live/`, so a hermetic run skips it.

`FakeTimeProvider` requires an external pump in this repo — time advances only on a read, so a loop
test that waits for a delay hangs unless the test advances it. Pump it from the test. The chain test
is the one deliberate exception: Quartz's own timer fires against real time, so cron arithmetic on
any other clock would arm fire times that scheduler never reaches. It stays bounded by waiting on a
signal rather than a sleep, so a broken chain fails in milliseconds with the reason attached.

---

## 12. Known gaps after this design

- **Nothing consumes results.** `orchestrator-result` has no consumer, so a workflow fires its entry
  steps and stops there. The result path is the next subsystem.
- **The three reclaim duties remain unowned** — multi-successor copy under derived ids, a failed
  step's input key, and a terminal step's output key. They belong to the result path.
- **Scale-down is undefended** (invariant 4): a removed replica's durable queue would accumulate
  forever.
- **`IConsumerAdmission` is built but adopted by one service.** The processor's gap stays open until
  it registers one.
