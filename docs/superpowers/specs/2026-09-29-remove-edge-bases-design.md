# Design: remove the edge base classes; the send decides the entry

Date: 2026-09-29
Status: implemented on feature/remove-edge-bases 2026-09-29; rollout deferred to the combined rebuild with log-entity-names.

## Goal

Remove `BaseImporter` and `BaseExporter` entirely. The framework stops enforcing any rule about
`executionId`; authors own their input checks and lineage minting. The framework keeps exactly one
rule about output, and the presence or absence of data in a send decides whether L2 is involved.

## Current state

| Base | Input `executionId` | Output | No branch sent |
|------|---------------------|--------|----------------|
| `BaseProcessor` | not checked | required | error log only, no outcome (`ProcessDispatchHandler.cs:396`) |
| `BaseImporter` | must be empty, else Failed | optional (`MaySendNoBranch`) | Drained / Faulted log, no outcome |
| `BaseExporter` | required, else Failed | never sends | terminal Completed (`EndsLineage`, `ProcessDispatchHandler.cs:455`) |

Only `KafkaImporterProcessor` and `KafkaExporterProcessor` derive from the edge bases (plus the test
doubles in `EdgeProcessorTests`; the `BaseExporter<Metric>` classes in the Console tests are
OpenTelemetry's type and are unaffected).

## Decisions

| #  | Decision |
|----|----------|
| D1 | **Remove** `BaseImporter`, `BaseExporter`, `EdgeSeams.cs` (`IImportSource`, `IExportSink`, `ImportedItem`, the two exceptions, `StopReason`) and `EdgeConfig.cs` (`ImporterConfig`, `ExporterConfig`). Their logic moves into the two Kafka processors as author code, including the pieces that depend on the removed types: `KafkaImporterConfig` and `KafkaExporterConfig` derive from `ProcessorConfig` directly and declare `MessageCount` / `IdleTimeoutSeconds` / `DeliveryTimeoutSeconds` themselves (same JSON names, so the registered config schemas do not change), and `KafkaImportSource` / `KafkaExportSink` are folded into the processors or kept as processor-local types that no longer implement a framework seam. |
| D2 | **No `executionId` rules in the framework**, on input or output. The author checks the input and mints lineages with `NewExecutionId()`. |
| D3 | **Forgetting to send is the only framework output rule.** An author that returns normally without calling `SendToPostAsync` gets a **Failed** outcome: the framework logs it at **Error** under the Failed outcome scope (so the record carries `Result=Failed`) and sends `StepOutcome(Failed)` **naming the step's input key** (`d.EntryId`), which it does **not** reclaim, exactly like every other Failed path. This replaces today's error log with no outcome. *(Amended in planning, per D8: reclaiming first and reporting `Guid.Empty` would lose the outcome if its send failed, because the redelivery would find the key gone and take the duplicate branch. Leaving the key makes a failed send a replay, and the orchestrator's existence check makes a duplicate outcome harmless.)* |
| D4 | **A send with no data produces an empty `EntryId`, deliberately or not.** "No data" is an empty array or `null`, treated alike. The author is responsible for knowing this, and the `SendToPostAsync` documentation states it. |
| D5 | **The processor never decides that a branch ends; the workflow graph does.** A no-data send is Completed; the orchestrator ends the run only if no successor matches. |
| D6 | **Failed and Cancelled ignore the meaning of `EntryId`.** The orchestrator only cleans up. |
| D7 | **Removed flags:** `EndsLineage` and `MaySendNoBranch` on `BaseProcessor`, and the terminal-Completed path in `ProcessDispatchHandler`. |
| D8 | **A duplicate is always preferred to a missing or misreported outcome.** Only framework faults are redelivered: L2 store faults (`L2FaultClassifier`, requeue and trip) and RabbitMQ send faults (`TransientSendException`, thrown only from `Messaging.Transport`). Author faults, Kafka included, end as Failed and are acknowledged. Every guard and ordering in this design is chosen so a fault can at worst replay work, never lose it. |

## Framework changes

### `BaseProcessor.SendToPostAsync`

- Accepts no data (empty or `null`). Today `null` throws `ArgumentNullException`. `null` is normalised
  to an empty array before the message is built, so `ProcessedData.Data` is never null on the wire.
- With data: mints `entryId = Guid.NewGuid()` as today.
- With no data: the branch carries `EntryId = Guid.Empty`.
- Either way it marks the dispatch as having sent a branch, so D3 never fires on a no-data send.
- Its documentation states D4 plainly: an author that means to pass data must check the data is
  non-empty first.
- Its documentation also states the catch rule (D8). A `PostSendException` reaches the author's own
  code, and nothing stops an author catching it, but an author **must let it propagate**. Swallowing
  it makes D3 report Failed for work that succeeded; rethrowing it as `FailedException` does the
  same. Either way a success is misreported as a failure and `PreviousFailed` successors run.
  Propagating it redelivers the dispatch and replays the author: a duplicate, which D8 prefers.

### `ProcessedDataHandler` (post handler)

- Branch with data: unchanged — output schema check, `L2[entryId] = data`, Completed naming the key.
- Branch with no data: **no L2 write and no output schema check**; sends Completed with
  `Guid.Empty`.

### `ProcessDispatchHandler`

- `ran && !BranchSent` -> skip the reclaim, Error log under `OutcomeLogScope(Failed)`, then
  `StepOutcome(Failed)` naming `d.EntryId` (D3). The reclaim runs only when `ran && BranchSent`.
- The `EndsLineage` terminal-Completed block is removed; the exporter's success now arrives through
  the post handler.

### `StepOutcomeHandler` (orchestrator)

| Outcome | L2 | Successors |
|---------|----|------------|
| Completed, `EntryId` set | read, hand on, delete (unchanged) | receive the data |
| Completed, `EntryId` empty | none | terminal step: the run ends; otherwise dispatched with an empty `EntryId` |
| Failed / Cancelled | **no read**; delete only if `EntryId` is set | receive empty data |

- **The duplicate-delivery guard for Failed and Cancelled.** Today the read doubles as the guard (an
  absent blob means "already handled"), and the delete runs **last**, after every handoff is sent
  (`StepOutcomeHandler.cs:353`). The replacement keeps that order: `KeyExistsAsync` up front
  (absent = duplicate, advance nothing), handoffs, then `DEL` at the end. One round trip up front, as
  today, without transferring the blob.
  - **Rejected: `DEL` as the guard.** It would have to run first, and a handoff send that then fails
    is redelivered to find the key gone: the successors are never dispatched. That trades a possible
    duplicate for a loss, against D8.
  - Outcomes with an empty `EntryId` have no guard today, and that is unchanged.
- **Behaviour change:** successors wired on `PreviousFailed`, `PreviousCancelled` or `Always` stop
  receiving the failed or cancelled step's input.

## Author responsibilities

### `kafka-importer`

- Ignores the input `executionId`; mints one lineage per record with `NewExecutionId()`.
- Checks each consumed record's value before `SendToPostAsync`:
  - non-empty -> `SendToPostAsync(value, NewExecutionId())`;
  - empty value or tombstone (`null`) -> **not sent**: commit the offset, log the skip with the
    offset only (never content), continue the loop. Without the commit the record is re-read forever
    and blocks the partition.
- Nothing sent in a dispatch:
  - topic empty, or every record empty -> throw `CancelledException` (Cancelled outcome);
  - a fault before anything was sent -> throw `FailedException` (Failed outcome).
- Keeps the behaviour it has today for opening, readiness, per-record commit after send, and faults
  after at least one send (Warning, the sent lineages continue).
- Keeps the payload guards it inherited: payload required, `MessageCount >= 1`,
  `IdleTimeoutSeconds >= 1`, each a `FailedException` as today.
- **Keeps every log template verbatim**, because readers match on the text:
  - `consumed {Consumed}/{Requested} records; stopped because {Reason}` is counted by the Analyst's
    run-boundary panel (`PanelRegistry.cs:508-516`, `Consumed = 0` = a drained poll). It is still
    logged **before** the `CancelledException` or `FailedException` is thrown, so a drained poll stays
    countable.
  - `imported record {Record} as execution {ExecutionId} from {Origin}` is matched by
    `OutcomeRecorderLiveTests.cs:333`.
  - The logger category is already `KafkaImporterProcessor`'s, so `scope.name` does not change.
- `KafkaRecord.Value` becomes `byte[]?`. Confluent hands a tombstone's value as `null`, which the
  current non-null declaration hides; today that reaches `SendToPostAsync(null)` and fails the step
  on `ArgumentNullException`.

### `kafka-exporter`

- Requires an input `executionId`: empty -> `FailedException`.
- Requires non-empty input data: empty -> `FailedException`.
- Keeps the payload guards it inherited: payload required, and `DeliveryTimeoutSeconds` at least
  `KafkaProducerSettings.MinimumDeliveryTimeout`.
- Every Kafka fault becomes `FailedException` (today via `ExportSinkException`), and the cached
  producer is evicted as today. A Kafka fault never redelivers.
- After a successful write, calls `SendToPostAsync` **with no data** (D4). Nothing reaches L2.
- **Accepted cost: a rare duplicate on the destination topic.** Today the exporter never sends, so it
  can never be requeued. Now a RabbitMQ fault on that no-data send throws `PostSendException`, which
  propagates (D8); `ran` is false, so the input key is still present and the redelivery writes to Kafka
  a second time. It needs a broker fault in the window between the Kafka write and the post send, and
  D8 prefers it to the alternatives described under `SendToPostAsync`.
- Keeps its `exported {Bytes} bytes of execution {ExecutionId} to {Destination} at {Offset}` template
  verbatim.

### Every author

- Checks the data is non-empty whenever it intends to pass data on.

## Effect on the live workflows

- **Unaffected:** FileFetcher, ArchiveExpander, ArchiveCollapser, SKNormalizer, FilePersister,
  Analyst, Sample and OutcomeRecorder all send on their normal path. Analyst, Sample and
  OutcomeRecorder already mint a lineage when dispatched with an empty one, so `analyst-monitor`,
  the sample workflows and `record-outcome` after a failed importer keep working.
- `record-outcome` (`outcome-recorder`, on `PreviousFailed` after eight steps) reads no data, so D6
  does not affect it.
- `simple-stepB` and `simple-stepC` (`sample-proc-v9`, on `Always`) receive empty data after a failed
  predecessor. Test workflows only.
- An empty Kafka poll becomes a Cancelled outcome. No live importer successor is wired on
  `PreviousCancelled` or `Always`, so it advances nothing.

## Observability

- The processor-side line "the terminal step completed — there is no output to hand on" disappears.
  The exporter's `Result=Completed` record now comes from the post handler, like every other step.
  Check the outcome panels still count it exactly once. `tools/classification-fixture.json:143`
  carries the removed template under `ProcessDispatchHandler` and must be replaced by the post
  handler's record.
- The missing-branch line becomes an outcome record (`Result=Failed`, Error level).
- **Two more outcome records now carry no `EntryId`**, because `ExecutionLogScope` omits an empty
  id: the exporter's Completed (its no-data branch has `EntryId = Guid.Empty`) and every kafka-importer
  outcome (a source step's dispatch has no input key). `verify-kibana-dashboard.py` check 5 ("one
  witness per step") keys on `(StepId, ExecutionId, EntryId)` and currently treats any record without
  an `EntryId` as unexpected. It must accept skips from `kafka-exporter` and `kafka-importer` and
  still fail on a skip from any other processor. Fixture doc 13 becomes the post handler's
  `branch completed in {ElapsedMs}ms` record for kafka-exporter, still counted, with no `EntryId`.

### Every empty poll becomes a Cancelled run

The FileFetcher→ArchiveExpander chain fires `kafka-importer` every 30 seconds. Today an empty poll
logs `consumed 0/N` and nothing else. Under this design it sends `StepOutcome(Cancelled)`, no
successor accepts it, and the orchestrator logs "the terminal step completed with Cancelled — no
successor accepts it, the run ends here" with the terminal run-position scope (and "the entry step
completed with Cancelled"). On an idle topic that is up to ~2,880 Cancelled runs a day per importer
workflow.

Cancelled is still the right outcome. D3 makes a silent return Failed, and a no-data send would be
Completed and dispatch the whole chain on nothing. What has to change is every reader of these records:

| Reader | Today | Change |
|--------|-------|--------|
| Operator run-boundary pie (`kibana/kibana-export.ndjson`) | entry > terminal on quiet polls | entry ≈ terminal; the gap no longer means drained polls |
| Outcome distribution pies | no record for a quiet poll | none: the pie shows every step outcome, and a quiet poll's Cancelled is one. On an idle topic the Cancelled slice grows, which is the truth. **The slice is not only empty polls:** in this chain it also holds SKNormalizer's whitelist cancels (`AcmeHandler.cs:271`, `:278`: no artist, or an artist not on the whitelist). A large Cancelled slice means "most triggers found nothing" OR "most documents were rejected"; the step name tells which. The pie is left as is |
| Analyst run-boundary panel (`PanelRegistry.cs:464-469`, from 83d5987) | tells the model that `drainedPolls` explains missing terminals | rewrite: drained polls now END as Cancelled terminals; missing terminals beyond them mean loss |
| `tools/verify-kibana-dashboard.py` | asserts today's counts | re-baseline against the new shape |

## Housekeeping

- Doc comments that name the removed types and must be reworded: `FileFetcherProcessor`,
  `ArchiveExpanderProcessor`, `ArchiveExtractionException`, `ArchiveCollapserProcessor`,
  `FilePersisterProcessor`, `OutcomeRecorderProcessor`, `ProcessedDataHandler`,
  `ConfigSchemaConformance`, `ProcessorOutcomeRecorderTests`, `OutcomeRecorderLiveTests`, and the
  `BaseProcessor` / `ProcessDispatchHandler` blocks that explain the removed flags.
- `ProcessDispatchHandler`'s duplicate-delivery comment says `StepOutcomeHandler` "THROWS, so the
  delivery parks" on an absent blob. It logs a Warning and returns. Correct the comment.

## Testing

- `SendToPostAsync`: data -> minted `EntryId`; empty and `null` -> `Guid.Empty`; both mark a branch
  sent.
- Post handler: no-data branch writes nothing to L2, skips the output schema, sends Completed with
  `Guid.Empty`.
- Dispatch handler: return without send -> Error log with `Result=Failed` and a Failed outcome with
  `Guid.Empty`; a no-data send does not trigger it.
- Orchestrator: Failed and Cancelled never read the blob; an absent key (`EXISTS` = 0) advances
  nothing; delete runs after the handoffs when `EntryId` is set; a handoff send fault leaves the key
  in place so the redelivery advances again (duplicate, not loss); successors receive empty data;
  Completed with empty `EntryId` ends a terminal step and dispatches a non-terminal one with an empty
  `EntryId`.
- `SendToPostAsync(null)` puts an empty array, not null, on the wire.
- `kafka-importer`: empty and tombstone (`null` value) records are committed, logged by offset and
  not sent; an all-empty or empty poll logs `consumed 0/N` and then throws `CancelledException`; a
  fault before any send throws `FailedException`; a non-empty input `executionId` is ignored; the
  payload guards fail as before.
- `kafka-exporter`: empty `executionId` and empty data fail; a Kafka fault fails and evicts the
  producer; a successful write sends with no data; a `PostSendException` on that send propagates.
- Analyst panel and Kibana verification pass against the Cancelled-per-poll shape.
- Remove `EdgeProcessorTests` and `ProcessDispatchHandlerTests.SaysNothingWhenTheProcessorMaySendNoBranch`
  with the code they cover; the Kafka suites keep the behaviour they pinned.
