# Edge processors — BaseImporter and BaseExporter

Written 2026-09-08. **Approved, not yet built.** This is the record of a design agreed in
conversation; nothing in `src/` implements it yet. It exists so the build does not depend on that
conversation surviving.

## The idea in one paragraph

`KafkaImporter` and `KafkaExporter` are the two ends of a workflow: one has no input and produces
branches, the other has an input and produces none. More of each are coming — a file importer that
reads a folder and extracts file paths is the next — and today every rule about how an edge behaves
lives in the concrete processor, where the next one would have to reimplement it. `BaseImporter<T>`
and `BaseExporter<T>` move those rules into the framework and leave each concrete processor with a
config record, an adapter and a cache key.

## The rule that makes them edges

**`ExecutionId` alone decides.** An entry dispatch carries `Guid.Empty`; a downstream dispatch
carries the lineage it belongs to.

- `BaseImporter` fails the step when `ExecutionId` is **not** empty.
- `BaseExporter` fails the step when `ExecutionId` **is** empty.

Both via `FailedException`, and the guard runs **first** — before the payload and data checks — so
the diagnostic names the wiring rather than a symptom of it. Today an entry-dispatched exporter
fails with *"dispatched with no input to export"*, which is true and misleading.

**This is not defensive.** It was observed happening. Until 2026-09-08 the exporter step was wired
`entryCondition: Always`, so a failed importer handed off to it with `ExecutionId` and `EntryId` both
empty, and the exporter ran on an entry-shaped dispatch every time an import failed. The wiring is
fixed (see below), but the guard is what makes the class of error impossible rather than absent.

### Two things this rule is NOT

**It is not the framework's own source test.** `ProcessDispatchHandler` uses
`var isSource = d.EntryId == Guid.Empty;` — a different field, decided before the author is invoked,
and it governs whether L2 is read and the input schema applied. The two fields co-vary on every
dispatch the orchestrator produces, because `WorkflowFireJob` hard-codes both to `Guid.Empty` on an
entry fire. They are independent on the wire. The decision, taken deliberately: **one rule on one
field.** No `EntryId` check is added. The one combination that would diverge — empty `ExecutionId`
with a non-empty `EntryId` — cannot arise from the orchestrator today.

**It is not enforced anywhere today.** The importer mints a lineage per record regardless of what it
was handed, and `MintsPerRecordEvenWhenHandedAnExecutionId` pins exactly that. **That test inverts**
to assert refusal. The exporter never reads `ExecutionId` except to log it; what currently saves it
is the `data.Length == 0` guard catching the right case for a neighbouring reason.

## Failure semantics

**The exporter fails the step on every fault, transient or deterministic.** Building the producer,
producing, the delivery report — the fault code is never consulted. There is no partial success to
preserve and no second terminal to report it with, which is the whole difference from the importer's
two-part split.

**No NACK, and for a sink that is structural rather than a policy.** The only requeue path in
`ProcessDispatchHandler` is `TransientSendException` (and its subclass `PostSendException`), and both
can only arise from `SendToPostAsync` — which a sink never calls. Everything else an exporter throws
lands on either the explicit `FailedException` catch or the general one; both send
`StepResult.Failed` and both acknowledge the dispatch.

**The accepted cost:** a transient broker blip on produce loses that branch permanently. It is
recorded as a failed step, so it is visible rather than silent, and recoverable by re-running.

**What the base catches.** The seam's declared fault type (`ExportSinkException` /
`ImportSourceException`) converts to `FailedException` — Information, clean message, no stack.
Anything else — a `NullReferenceException`, a genuine bug — is left to escape to the framework's
general catch, which still reports `Failed` and still acks but logs at **Warning with the stack
trace**. The outcome is identical under the rule; the difference is that a programming error keeps
its stack instead of being flattened into one line.

**Boundaries no base class can convert**, so "always fail" is not read too widely:

| condition | disposition | reachable by the author? |
| --- | --- | --- |
| identity or schema not yet resolved | message **parks**, no outcome sent | no — before the author |
| L2 read faults | **requeued**, L2 gate closes | no — before the author |
| input fails its schema | `Failed` outcome, acked | no — before the author |
| anything the author throws | `Failed` outcome, acked | yes |

## What is already framework behaviour — do not rebuild it

**Failure logging.** `ProcessDispatchHandler` logs every author exit, and its comment says why it
must: *"StepOutcome has no text field, so this line is the only record of WHY the step failed."*

| author exit | message | severity |
| --- | --- | --- |
| `FailedException` | `the author reported the step failed: {Reason}` | **Information** |
| `CancelledException` | `the author cancelled the branch: {Reason}` | **Information** |
| anything else | `the transform faulted — reporting the step failed` + stack | **Warning** |

So the base classes must **not** log their own failures — throwing is the contract, and a second
line would duplicate every failure in Elasticsearch.

**Consequence for anyone querying:** an author-reported failure is at *Information*. A
severity-based sweep for "did anything fail" will not find one. Query the message, or the outcome.

**A failed step's input still reaches a failure successor.** This was asked for and already exists.
`Failure(d, result)` carries `d.EntryId` — the key the step read, not a sentinel — and the processor
skips its reclaim on every failure path, so the blob survives. `StepOutcomeHandler` then reads it
with no reference to the result (`m.EntryId == Guid.Empty ? [] : await ReadAsync(m.EntryId)`),
`SelectNext(m.Result, …)` matches successors gated `PreviousFailed` or `Always`, and each handoff
carries that data plus `m.ExecutionId`, so **the lineage survives the failure**. The reclaim runs
last, after the handoffs.

Proven 2026-09-08 by wiring a `PreviousFailed` step to a `skp-dead` topic and breaking the exporter:
both branches' original 62-byte payloads landed on the dead-letter topic under the same execution
ids. The test wiring was removed afterwards.

It is automatically scoped to a non-empty `ExecutionId` with no guard needed: a source step reports
`EntryId = Guid.Empty`, so a failed importer's successors get empty data and the source sentinel.

**Therefore a dead-letter or compensation path is workflow authoring** — a step gated on
`PreviousFailed` — not processor code.

## Shape

```csharp
public abstract record ImporterConfig(int MessageCount, int IdleTimeoutSeconds) : ProcessorConfig;
public abstract record ExporterConfig(int DeliveryTimeoutSeconds)               : ProcessorConfig;

public sealed record ImportedItem(byte[] Data, string Origin);   // Origin: "topic [0] @4", or a path

public interface IImportSource : IDisposable
{
    bool Open(TimeSpan timeout);            // false = not ready; the step fails
    ImportedItem? Read(TimeSpan timeout);   // null = nothing there; the loop Drains
    void Acknowledge(ImportedItem item);    // must be the item Read last handed out
    void Close();
}

public interface IExportSink : IDisposable
{
    Task<string> WriteAsync(string destination, byte[] data, CancellationToken ct);  // where it landed
}
```

`BaseImporter<TConfig>` owns: the edge guard, the payload guards, the one-entry cache with
evict-on-fault, the two-part split (acquisition fails the step, the loop never does), the three
terminals, send-then-acknowledge ordering, per-item acknowledgement, and the log lines.
`BaseExporter<TConfig>` owns: the edge guard, the empty-data guard, the cache, one write, no branch.

Subclasses supply `string CacheKey(TConfig)` — what "the same source" means, and it differs on
purpose: a consumer is bound to broker + topic + group, a producer to broker + delivery timeout but
not topic. The exporter also supplies `string Destination(TConfig)`.

**`ImportedItem` is a record class, not a struct**, because `Acknowledge` asks "is this the item I
handed out" and that must be reference identity.

**The seams need their own fault types.** The loop cannot catch `KafkaException` (a file source
throws `IOException`) and must not catch bare `Exception`, because `PostSendException` has to
propagate. This exposes an existing inconsistency worth fixing: `IRecordConsumer` returns a
Confluent-free `KafkaRecord` and then throws Confluent's `KafkaException` straight through — it is
only half a seam today.

## Logging

The base logs `Origin`, not the payload — `imported item from {Origin} as execution {ExecutionId}` —
with `protected virtual string? Describe(ImportedItem)` as the opt-in for more. `KafkaImporter`
overrides it to keep logging the record value exactly as it does now, so nothing currently queryable
changes. A file importer whose items *are* paths needs no override, since `Origin` is already the
identifier.

The prize is not the line count: it is that every importer emits identical log lines and shares one
`StopReason` vocabulary, so one dashboard covers all of them. `StopReason` moves to the framework.

## Placement

`BaseProcessor.Core`. **Verified to cost no re-registration:** the SourceHash fold is
`$(MSBuildProjectDirectory)\**\*.cs` — the concrete project's own files and nothing else. Printing
`@(ImplFiles)` for `Processor.Sample` gives 4 files, all its own. `RESUME.md` claimed the opposite
and has been corrected.

## Scope of the first cut

The two base classes and their seams, then `KafkaImporter` and `KafkaExporter` ported onto them with
the entire existing suite passing unchanged apart from the one inverted test. **No `FileImporter`.**
Porting the two real ones is what proves the abstraction fits; a third invented from a guess would
only prove it fits the guess.

## Open

- The file importer's item shape is TBD beyond "reads a folder, extracts file paths".
- Nothing validates that a workflow's importer and exporter name different topics. An exporter
  pointed at its own importer's topic is a clean, silent, steady-state loop: 1 record in, 1 record
  out, `Completed` every fire, lag 0, and `Drained` never appearing again. The passthrough design
  makes this *more* reachable than the old `{"path": …}` envelope did, because the output is now a
  valid input by construction.
