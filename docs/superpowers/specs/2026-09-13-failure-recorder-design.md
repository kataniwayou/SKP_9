# Processor.FailureRecorder — a durable pointer to a failure the logs already describe

**Date:** 2026-09-13
**Status:** Designed, all decisions resolved. Not implemented.
**Introduces:** `src/Processor.FailureRecorder/`, `k8s/42-processor-failurerecorder.yaml`, a
`failure-recorder` processor row, two steps and two assignments on
`filefetcher-archiveexpander-chain`, and the Kafka topic `skp-failures`.
**Amends:** `BaseProcessor.Core` — one protected read-only accessor (§5). `kafka-exporter`'s
`inputSchemaId` is set to null (§6.2), which is a change to a **shared** processor row.
**Depends on:** `StepAdvancement.SelectNext` matching successors on `EntryCondition == (int)result`,
and `CorrelationId` being minted once per fire by `WorkflowFireJob`.

---

## 1. The decision

> **When a step of `filefetcher-archiveexpander-chain` fails, a `PreviousFailed` edge dispatches
> `FailureRecorder`, which writes a small record naming the lineage and the moment, and hands it to a
> Kafka exporter on `skp-failures`. An operator consumes that topic at their own pace and resolves
> the record against Elasticsearch.**

It is a plain downstream transform — input and output — so neither `BaseImporter` nor `BaseExporter`
applies, and it passes through the `executionId` it was dispatched with rather than minting one.

### 1.1 What it is NOT

**It does not query Elasticsearch.** An earlier shape had it gather the lineage's logs and bundle
them. Measurement killed that: four samples of the live cluster put the newest indexed non-probe
record at **7.7 s, 14.0 s, 11.0 s and 7.2 s old** — the .NET batch log processor's ~5 s scheduled
delay, plus the collector's batch, plus ES refresh. This processor runs *milliseconds* after the
failure, and the line it would most want — `the author reported the step failed: {Reason}`, the last
line the failing pod writes for that step — is the one furthest from being indexed. Racing that
pipeline means polling with a deadline and shipping incomplete bundles exactly when the collector is
behind. Handing over a pointer the operator resolves later inverts the race instead of fighting it.

**It does not forward the cargo.** The orchestrator hands every matched successor the failed step's
input blob. This processor ignores it (§4.2).

**It does not carry the diagnosis.** `StepOutcome` has no text field, and this design does not add
one. The record says *where to look*, never *what went wrong*. See §8.3 for when that becomes
insufficient and what the fix is.

---

## 2. Why this exists

A failed step is currently reported in exactly two places, both of them logs: the processor's
`Warning` line carrying the author's reason, and the orchestrator's
`the terminal step completed with Failed — no successor accepts it, the run ends here`. Nothing else
records it. Nobody is notified. The run simply stops, and the evidence sits in Elasticsearch waiting
for someone who already suspects something is wrong.

This deployment also demonstrably drops log records — the terminal outcome is deliberately reported
from two pods for that reason. A notification that travels the *broker* rather than the log pipeline
is therefore worth more than its content suggests: the record arrives even when the logs do not.

---

## 3. The flow

```
chain step fails
  → StepOutcomeHandler selects the PreviousFailed successor
  → FailureRecorder dispatched (same ExecutionId, same CorrelationId, cargo it ignores)
  → one branch to its own post queue
  → orchestrator hands off
  → kafka-exporter step produces to skp-failures and ends the lineage
```

Every hop goes through the orchestrator; this processor never addresses the exporter directly.

### 3.1 Why the fan-out is safe

Each chain step gains a second successor. `StepAdvancement.SelectNext` matches when
`next.EntryCondition == (int)result` or `== Always`; `StepResult.Failed = 2` equals
`StepEntryCondition.PreviousFailed = 2`, and the existing successors are all `PreviousCompleted = 1`.
So exactly one successor matches per outcome, never both. `StepOutcomeHandler` mints a fresh
`Guid.NewGuid` key per matched successor and reclaims the source last, so the old "two successors
share one key" hazard does not apply.

### 3.2 Coverage

All seven steps fan out, including `kafka-importer` and `kafka-exporter`.

**A successor after the sink is legitimate here, though it reads oddly.** `kafka-exporter` sets
`EndsLineage`, and `ProcessDispatchHandler`'s comment warns that a successor wired after a sink would
be dispatched with `Guid.Empty` — but that concerns the *Completed* path, where the terminal outcome
deliberately names no key. On the failure path the exporter reports through the ordinary catch chain
with its own `EntryId`, so the recorder is dispatched normally. The exporter has no
`PreviousCompleted` successor, so the odd case never arises.

Hop 1 is a special case throughout this
document because an importer failure is an **entry dispatch**: `ExecutionId` is `Guid.Empty`, no
lineage was ever opened, and `data` is empty — so `FailureRecorder` is dispatched as a **source
step** (`EntryId == Guid.Empty`), reads no key, and skips input validation. `CorrelationId` is what
makes that case resolvable (§5).

---

## 4. The processor

### 4.1 Shape

`FailureRecorderProcessor : BaseProcessor<FailureRecorderConfig>`, `internal sealed`, matching every
other concrete processor in the solution. One `ProcessAsync`, no services, no IO, no Redis client of
its own.

### 4.2 What it does with `data`

Nothing. The orchestrator reads the failed step's input blob and hands it over as this step's input,
so `data` arrives populated for hops 2–7 and empty for hop 1. It is neither parsed nor forwarded.

**This costs something and it cannot be designed away.** A hop *relocates* the payload rather than
passing a reference: `NextStepHandoffHandler` writes a full-size copy under a fresh key, the pre
handler reads that copy out of Redis before the author is called, and the reclaim deletes it
afterwards. For an `archive-expander` or `sk-normalizer` failure that is a write, a read and a delete
of up to ~45 MB, paid to deliver bytes nobody wants. Consequences: size the pod at **768Mi**, and
expect failure-path L2 traffic to resemble success-path traffic.

### 4.3 The payload

**There is none, and one is not accepted-then-ignored — it is genuinely unread.** `ArchiveCollapser`
is the precedent: its `config` is deliberately never read, and
`ProcessorArchiveCollapserTests.EveryPayloadIsAccepted` pins that. `FailureRecorderConfig` exists
only because `BaseProcessor<TConfig>` requires a type; it declares no members, and `config` arrives
null whenever the payload is empty, which is the normal case and must not be rejected.

The step still needs an assignment row structurally. Its payload is `{}`.

`configSchemaId` on the processor row is **null**. `ProcessorStartupOrchestrator` handles a null
config schema explicitly (`identity.ConfigSchemaId is null || _configResolved`), so nothing is
registered and no publish-time payload gate applies.

### 4.4 The record

One JSON document, a few hundred bytes:

| field | source | format | note |
|---|---|---|---|
| `correlationId` | `BaseProcessor.CorrelationId` (§5) | **32 hex, no dashes** | `CorrelationKeys.Render` |
| `executionId` | `ProcessAsync` parameter | dashed `"D"`, omitted when `Guid.Empty` | absent for a hop-1 failure |
| `recordedAtUtc` | `DateTimeOffset.UtcNow` | ISO-8601 | see below |

**`correlationId` MUST be rendered `"N"`.** Elasticsearch holds it as 32 hex characters with no
dashes — `CorrelationKeys.Render` is what puts it there — while every other id is dashed `"D"`. A
`Guid.ToString()` pasted into a `term` query matches nothing, silently. This is the single likeliest
way to make the feature look broken while working.

**`recordedAtUtc` is when the record was written, not when the step failed.** The failure is
milliseconds earlier, on a different pod. It is precise enough to bound a query window and to
separate two failure pairs inside one lineage (§8.2); it is not a clock to order events by.

**`executionId` is omitted rather than zeroed when empty**, matching `ExecutionLogScope.BuildScope`,
which omits empty ids so that "does not apply" stays distinguishable from "is the zero guid". A
consumer must be written for an absent field, not a sentinel.

### 4.5 Failure modes of the recorder itself

It has no business logic, so it has none of its own beyond the framework's. It never throws
`FailedException`.

---

## 5. The one framework change

```csharp
// BaseProcessor
protected Guid CorrelationId => Current.CorrelationId;
```

`ProcessAsync` receives exactly `data`, `config`, `executionId`, `ct`. The other ids live in
`DispatchState`, held in a private field behind a private `Current` property, with no protected
accessor anywhere — so as designed, this processor could document `ExecutionId` and nothing else,
and `ExecutionId` is `Guid.Empty` in precisely the case that most needs a key.

`WorkflowFireJob` mints `var correlationId = Guid.NewGuid()` **once per fire** and it is stamped on
every message of that run, so a hop-1 failure becomes exactly addressable by it. That retires the
alternative — a static `workflowId` on the assignment payload, resolved against a time window — which
was fuzzy here specifically: the chain fires `5,35 * * * * *`, twice a minute, so any sane window
spans several runs.

**This does not weaken the rule the class states.** `BaseProcessor`'s comment says an author cannot
*influence* the ids on its own output; `SendToPostAsync` still takes every id from `DispatchState`
rather than from the author. Reading is not forging.

**`CorrelationId` only.** `WorkflowId`, `StepId` and `ProcessorId` stay private. They are static and
could come from a payload if ever wanted, and exposing them invites an author to make routing
decisions nothing needs. `Current` already throws outside a dispatch, so the accessor is valid
exactly where an author runs.

---

## 6. Registration and wiring

### 6.1 The processor row

| field | value |
|---|---|
| `name` | `failure-recorder` |
| `inputSchemaId` | **null** |
| `outputSchemaId` | **null** |
| `configSchemaId` | **null** |

Both schema edges are null, and the publish gate permits that: `SchemaEdgeValidator` passes when
either side is null. This matters because the **seven** incoming edges come from parents carrying
**three different** output schema ids — `b3877a36` (importer, persister), `f495b02e` (fetcher,
collapser), `e33f8079` (expander, normalizer), plus null on the exporter — and one processor row has
one `inputSchemaId`. The gate compares row ids for equality, so no non-null value could satisfy all
three. Null is not a shortcut here; it is the only legal answer.

### 6.2 The exporter edge — the one shared-row change

`kafka-exporter`'s `inputSchemaId` is `b3877a36` (`file-locator`), and the exporter's **pre handler
validates its runtime input against it**. A failure record is not a file locator, so every export
would fail its input schema. The publish-time gate is not the problem; the runtime check is.

Three ways out were considered. Cloning the exporter into a second processor row is **forbidden** —
`uq_processor_source_hash` is unique on the binary's hash, and the row would carry the same one.
Shaping the record as a `file-locator` means persisting it to disk and exporting a path, which
reintroduces a filesystem dependency for no gain. So: **set `kafka-exporter.inputSchemaId` to null.**

**Blast radius, stated rather than discovered.** That row is shared with chain step 7 and with the
`kafka-import-export` workflow. Nulling it removes *input* validation from both. It is survivable
because this system does its real schema work on the producing side — the producer validates its own
output, so bad data never reaches the next queue (`RESULTS.md` F4) — and consumer-side input
validation has never fired in a live suite. It is still a control removed from two places this
feature does not otherwise touch, and it is the reason this design amends a shared row at all.

### 6.3 Steps

**One shared diagnostic step**, not one per parent. All six chain steps plus the entry step point at
it with `entryCondition: PreviousFailed`; it points at one new step on the **existing**
`kafka-exporter` processor row, whose assignment payload names the topic:

```json
{ "topic": "skp-failures", "deliveryTimeoutSeconds": 30 }
```

The row is shared with chain step 7 (`skp-documents`); only the assignment differs, because the
topic is a step's to choose and the broker is not.

**Keep the timeout at 30, matching chain step 7.** `KafkaExporterProcessor.CacheKey` is the delivery
timeout and nothing else — the topic is deliberately excluded, since a producer is not bound to one —
so two steps sharing a timeout share one cached producer, and two steps differing in it build and
hold two, paying a connection and a metadata fetch for nothing.

**Both exporter steps share one work queue.** Dispatches are addressed to
`processor-{processorId}-work`, so the failures step and the documents step land on the same replicas
at a prefetch of one, and a burst of failures competes with normal exports for that lane. Acceptable
— failures are rare and an export is milliseconds — but it is a coupling that did not exist before.
If it ever matters the answer is more exporter replicas, not a second processor row:
`uq_processor_source_hash` forbids one for the same binary.

Per-parent steps were considered so that each payload could name the guarded `stepId`/`processorId` —
the one identity the hand-off does not convey, since `NextStepHandoff` carries the *successor's* step
and processor ids. It is unnecessary: the lineage itself names which step failed, because the failing
pod's own `Warning` line carries its `StepId` and `ProcessorId` as attributes. Seven steps and seven
assignments to restate what one query already returns is not worth the surface.

Total added: **2 steps, 2 assignments, 1 processor row, 1 topic.**

### 6.4 The workflow after the change

Nine steps, nine assignments. Steps 7 and 9 are **two step rows on the one `kafka-exporter`
processor row**, differing only in their assignment payload — which is why the topic lives in the
payload while the broker lives in configuration: an address is not a workflow author's to choose, a
topic is.

| # | step | processor row | entryCondition | assignment payload |
|---|---|---|---|---|
| 1 | import paths | `kafka-importer` | 4 Always (entry) | `{"topic":"skp-paths","messageCount":25,"consumerGroup":"skp-splitchain","idleTimeoutSeconds":10}` |
| 2 | fetch file | `file-fetcher` | 1 PreviousCompleted | `{"allowedExtensions":[".zip"],"minimumSizeBytes":0,"maximumSizeBytes":33554432}` |
| 3 | expand archive | `archive-expander` | 1 PreviousCompleted | `{"maxDepth":4}` |
| 4 | normalize | `sk-normalizer` | 1 PreviousCompleted | `{"handler":"Acme"}` |
| 5 | collapse archive | `archive-collapser` | 1 PreviousCompleted | `{}` |
| 6 | persist file | `file-persister` | 1 PreviousCompleted | `{"folderPath":"/mnt/skp-files/out"}` |
| 7 | export document | `kafka-exporter` | 1 PreviousCompleted | `{"topic":"skp-documents","deliveryTimeoutSeconds":30}` |
| **8** | **record failure** | **`failure-recorder`** | **2 PreviousFailed** | **`{}`** |
| **9** | **export failure** | **`kafka-exporter`** | **1 PreviousCompleted** | **`{"topic":"skp-failures","deliveryTimeoutSeconds":30}`** |

Steps 1–7 are unchanged; 8 and 9 are new. Every one of steps 1–7 gains step 8 in its `nextStepIds`
alongside the successor it already had, and step 8's `nextStepIds` is `[9]`.

**Step 9 is `PreviousCompleted`, not `PreviousFailed`** — it runs when the *recorder* completed, which
is the normal case. Its predecessor is step 8, not the step that failed.

**Two steps on one processor row is the ordinary arrangement here, not a new capability.**
`v8-fanout-proof` runs 10 steps on the single `sample-proc-v9` row today, and `simple-abc` runs 3.

### 6.5 The topic

`skp-failures`, on the same broker as `skp-paths` and `skp-documents` — `Kafka__BrokerList` is
`skp-kafka:9092`, the dev broker from `tools/kafka-dev-broker.ps1`, a container on the kind network
rather than a service in this namespace. Nothing in this repo creates topics, so before the first
run, confirm the broker auto-creates them or create `skp-failures` with that helper. A topic that
does not exist does not fail at `Subscribe`; it surfaces on the first read or write.

---

## 7. The operator's side

### 7.1 Resolving a record

**Hops 2–7** — `term attributes.ExecutionId` = the record's `executionId`. Then either:

- `sort @timestamp desc, size 5` — the run stops at the failure, so the failure is at the tail. Note
  the newest document is **not** the failure line: `ProcessDispatchHandler` logs
  `the step returned after Nms` unconditionally after the catch, so it lands last. `size 1` misses
  the failure; `size 5` does not.
- or `+ severity_text: WARN` — returns exactly two documents, the processor's reason and the
  orchestrator's stop line. This is the sharper query and the one to prefer.

**Hop 1** — `term attributes.CorrelationId` = the record's `correlationId`, rendered `"N"`. Exclude
`scope.name: BaseConsole.Core.Health.HealthProbeLog`; probes were **183,834 records against 859,738
non-probe in the last 24 h**, and they carry no lineage.

### 7.2 What one query returns

Measured on a real chain lineage: **24 documents across 7 scopes** for one `ExecutionId`. The
`WARN` filter reduces that to the two that matter. A live example, from a real `sk-normalizer`
failure at 08:54:57 on 2026-09-13:

```
.309 Warning      the author reported the step failed: normalizing orders-805167fb…   (truncated here)
.315 Warning      the terminal step completed with Failed — no successor accepts it, the run ends here
.315 Information  the step returned after 5ms
```

The two `Warning` lines come from **different pods**, so their relative order rests on clock
agreement rather than causality. Read them as a pair.

---

## 8. Accepted costs

### 8.1 The cargo relocation

Up to ~45 MB written, read and reclaimed per failure to deliver bytes the processor discards (§4.2).
Inherent to the orchestrator's relocate-per-successor design; not fixable from this feature.

### 8.2 The recorder has no recorder

If `FailureRecorder` or its exporter step fails, that outcome has no `PreviousFailed` successor, so
the run ends and the failure is log-only — the state this feature exists to escape. Wiring it to
itself is a cycle and the publish gate refuses cycles.

It is not a blind spot, only a silent one: the hand-off passes `ExecutionId` through unchanged, so
the recorder runs **inside the same lineage** and its own failure lines carry the same
`ExecutionId` — one query returns the original failure and the recorder's, in order. Two
consequences. The tail recipe (§7.1) then surfaces the *recorder's* failure rather than the step's,
so use the `WARN` filter, which returns both pairs. And for a hop-1 failure the recorder's own lines
carry no `ExecutionId` either, so the fallback there is `CorrelationId`.

What is missing is not the evidence but the trigger. **Mitigation: a `WARN`-severity alert on the
`failure-recorder` and `kafka-exporter` scopes.** That is monitoring, not workflow, and is out of
scope for this document beyond being named here.

### 8.3 The reason still lives only in Elasticsearch

The record rides the broker and always arrives. The reason rides the log pipeline, which this
deployment sometimes drops. The bad day is: record arrives, lineage resolves, and the one `Warning`
line carrying the diagnosis is absent — you see which step stopped, not why.

**The fix, if that ever bites, is known and deliberately deferred:** carry the author's
`FailedException` text on the wire. `ProcessStatusException` already declares that text safe to
render verbatim — it is author-authored, unlike a framework exception's message, which quotes payload
fragments and must never travel. It would mean adding a field to `StepOutcome`, reopening a decision
that was closed on purpose. A pointer that usually resolves beats a `Warning` line nobody watches, so
not now.

---

## 9. Testing

- **Hermetic, `Processor.FailureRecorder.Tests`:** the record's field set and formats — especially
  `correlationId` rendered `"N"`; `executionId` omitted rather than zeroed when `Guid.Empty`; a null
  `config` accepted, mirroring `EveryPayloadIsAccepted`; `data` ignored, including a large array.
- **`BaseProcessor.Core.Tests`:** the accessor returns the open dispatch's correlation id, and throws
  outside a dispatch.
- **Live, `Category=Live`:** seed a document that fails at `sk-normalizer` (the D5 shape — an item
  holding something other than exactly one `.wav` and one `.json`), assert one record on
  `skp-failures` whose `executionId` resolves to a lineage whose tail is the two `Warning` lines.
  Then a hop-1 failure — the cheapest lever is an assignment naming a topic the consumer never gets
  an assignment for, so `Open` returns false within the idle timeout — and assert a record with no
  `executionId` whose `correlationId` resolves the fire.
- **Regression:** `kafka-import-export` still round-trips after §6.2, confirming the nulled input
  schema broke nothing that the producing side was not already validating.

---

## 10. Deferred, with reasons

| Item | Why not now |
|---|---|
| The reason on the wire | §8.3 — reopens a closed contract decision; the pointer is enough today |
| Per-parent diagnostic steps | §6.3 — the lineage already names the failed step |
| An alert on the recorder's own failure | §8.2 — monitoring, not workflow |
| A schema row for the record | Both edges are null by necessity (§6.1); a schema would be validated against nothing |
| Applying this to the other five workflows | Prove it on one chain first |
