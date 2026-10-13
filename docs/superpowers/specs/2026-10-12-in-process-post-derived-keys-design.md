# In-process post hops and derived entry ids — Design

**Date:** 2026-10-12, revised 2026-10-13
**Status:** Approved 2026-10-13. Implementation plan:
`docs/superpowers/plans/2026-10-13-in-process-post-derived-keys.md`.
**Supersedes:** `2026-08-31-consistent-advance-materialize-topology-design.md` §4 (an advance→materialize
pair travels on two queues). The advance/materialize split of *work* stays; the second *queue* goes.
**Builds on:** `2026-09-01-absent-key-disposition-design.md` (an absent key is a duplicate).

## 1. Problem

The organisation caps RabbitMQ's maximum message size. Two hops carry a step's whole output inside a
message, JSON-serialised so the bytes travel as base64:

| Hop | Message | Field | Copies |
|---|---|---|---|
| processor → `processor-{id}-post` | `ProcessedData` (`Execution.cs:60`) | `byte[] Data` | one per branch |
| orchestrator → `orchestrator-result-post` | `NextStepHandoff` (`NextStepHandoff.cs:31`) | `byte[] Data` | one per matched successor |

Both queues are durable and every message is persistent and publisher-confirmed
(`DeadLetteredPair.cs:69,88`, `OrchestratorTopology.cs:81`, `QueueSender.cs:129`). That durability is
what lets each advance hop reclaim its input and ack right after the send: the post message holds the
only copy of the data from then on.

## 2. Policy

**A duplicate is acceptable; a loss is not.** An orphaned blob (a `data:` key nothing will read or
delete — no TTL, no sweeper) is a leak: avoided where possible, accepted where rare (§9).

## 3. No data in any message

1. The four queues `processor-{id}-post`, `processor-{id}-post.dead`, `orchestrator-result-post`,
   `orchestrator-result-post.dead` are removed after a drain (§11).
2. Each materialize hop becomes an **awaited in-process call** from its advance hop. The advance hop does
   not reclaim its input or ack until the call has returned — the work's completion replaces the
   durable queue. A fire-and-forget in-memory queue is rejected: an ack after enqueue and a crash before
   the write loses the branch with its input already reclaimed.
3. Only ids and the step payload travel: `ProcessDispatch`, `StepOutcome`. `ProcessedData` survives as an
   in-process record; `NextStepHandoff` is removed in release 2.

## 4. Every key is real; empty means "no data"

- Every dispatch inside a run carries a real input key. A key whose value is **empty** means "no data".
- `Guid.Empty` as an `EntryId` survives in exactly one place: the cron fire's dispatch of an entry step
  (`WorkflowFireJob.cs:285`).
- Absent and empty are distinguished with `RedisValue.IsNull`, not `IsNullOrEmpty`
  (`ProcessDispatchHandler.cs:128`, `StepOutcomeHandler.cs:467`). Redis keeps `""` as a value;
  StackExchange.Redis returns `Null` only for a missing key. **Absent = duplicate. Empty = no data.**
- This reverses the decision recorded at `StepOutcomeHandler.cs:300-302` ("minting an id here would have
  the post hop write a zero-length value"): the empty key now buys a unique key and a redelivery token for
  every no-data step.

## 5. Entry ids

### 5.1 Processor: `E`

`E` is minted by the framework inside `SendToPostAsync`, never by author code.

| Dispatch | `E` |
|---|---|
| Input key set (data or empty) | `UUIDv5(inputEntryId, executionId)` |
| No input key (entry step from the fire) | `UUIDv5(WorkflowId, StepId, executionId)` |

`executionId` is the one the author passes to `SendToPostAsync`. **The author's contract:** every output
carries a distinct, non-empty `executionId`.

- A one-output transform passes the lineage it received — unique because its input key is unique per
  run, which also separates the two runs of a fan-in step, a diamond, and a loop.
- A splitter, or an entry step, mints one per spawn: KafkaImporter uses the record's `execution-id`
  header (§7); Sample, Analyst and OutcomeRecorder use `NewExecutionId()`, which stays random.
- `SendToPostAsync` throws on `Guid.Empty`; otherwise every such output would share one key.

### 5.2 Orchestrator: `S`

| Predecessor's `E` | `S` |
|---|---|
| set | `UUIDv5(E, nextStepId)` |
| `Guid.Empty` (an entry step's Failed/Cancelled outcome) | `UUIDv5(CorrelationId, StepId, nextStepId)` — an entry step is dispatched once per fire, so unique |

### 5.3 Helper

A UUIDv5 helper (SHA-1, RFC 9562 §5.5) in `Messaging.Contracts`, shared by both hosts; .NET 8 has none.
Inputs are joined with a separator so `(a, bc)` and `(ab, c)` cannot meet. Cost ≈ 1 µs per key,
independent of the data's size.

## 6. Processor

### 6.1 Input (`ProcessDispatchHandler`)

| `data:{EntryId}` | Action |
|---|---|
| `EntryId == Guid.Empty` | entry step: no key; the author produces its own input (as today) |
| absent (`IsNull`) | duplicate delivery → return (as today) |
| empty | skip the input schema; run the author on empty data |
| data | validate if the processor has an input schema; run the author |

After the author returns having sent: delete the input key, data or empty (as today).

### 6.2 Send (`SendToPostAsync`, signature unchanged)

1. `executionId == Guid.Empty` → throw (author error).
2. Derive `E` (§5.1).
3. Data non-empty → validate the output schema on the in-memory bytes.
   - **Fails:** `SET data:{E} ""`, send `StepOutcome(Failed, E)`, mark sent, **return normally**. Naming
     the branch's own key gives every failed branch its own successor key; reporting `Guid.Empty`, as
     today, would make every schema-failed branch of one fire share one recorder key, and all but one
     failure record would be lost. A throw would reach the generic catch (`ProcessDispatchHandler.cs:299`)
     and report the dispatch Failed a second time — for the importer, an uncommitted record re-read
     forever.
   - **Output schema not yet resolved:** throw an exception the consumer requeues (today it parks on the
     post DLQ, `ProcessedDataHandler.cs:117`).
4. `SET data:{E}` — the bytes, or `""` for an empty branch. No expiry.
5. Send `StepOutcome(Completed, E)` to `orchestrator-result`, broker-confirmed.
6. Mark the branch sent — after the confirm.

| Fault | Leaves `SendToPostAsync` as | Consumer |
|---|---|---|
| Send fault | `PostSendException` (a `TransientSendException`), as today | requeue |
| Redis fault | **raw** — wrapped, `L2FaultClassifier` would never see it and the L2 gate would not close | requeue + trip |
| Redis server error (OOM, READONLY, LOADING, BUSY) | raw; classifier widened (§8) | requeue + trip |
| Output schema not resolved | dedicated requeue exception | requeue |

`ProcessedDataHandler` becomes an internal singleton service (its dependencies are all singletons). Its
provenance guard is dropped (ids now come from `DispatchState`, never from an addressable queue); its
identity guard is already enforced before the author runs (`ProcessDispatchHandler.cs:88`).

## 7. KafkaImporter and the feeds

- The record's value stays `{"filePath": …}`: the file-locator schema is `required: ["filePath"]`,
  `additionalProperties: false`, and the importer forwards the value unchanged.
- The id rides header `execution-id`. `KafkaRecord(byte[]? Value, string Offset)` gains
  `string? ExecutionId`, filled in `KafkaRecordConsumer.Consume` from
  `result.Message.Headers?.TryGetLastBytes("execution-id", …)`.
- **The header is the producer's contract with the importer.** Header present and a non-empty GUID → the
  importer passes it as the branch's `executionId` (replacing `NewExecutionId()` at
  `KafkaImporterProcessor.cs:165`) and sends the branch Completed. Header missing, not a GUID, or
  `Guid.Empty` → the importer **commits the record, then throws `FailedException`**. Nothing is
  written to L2 and no `executionId` is minted: the framework reports the dispatch Failed naming its
  input key (`ProcessDispatchHandler.cs:240-254`, `Failure(d, …)`), which for an entry step is
  `Guid.Empty` and gets `S = UUIDv5(CorrelationId, StepId, nextStepId)` (§5.2) — idempotent. The
  recorder on the `PreviousFailed` edge records it.
  - **Commit first**, or the record is re-read and fails every fire — a poison record that stops the
    partition. A commit fault before the throw only means the next fire refuses it again.
  - The dispatch stops at the bad record. Records before it in the same dispatch were already sent and
    committed and carry on; the rest are read by the next fire.
- Send-then-commit per record is unchanged. A record re-read after a commit fault, by a replay or a later
  fire, derives the same `E` and is absorbed or runs as a duplicate.
- **Feeds** stamp `execution-id = uuid5(NS_FEED, filePath)`: `kafka-produce-records.py:144`,
  `simulate-endless-feed.py` `produce()` at `:386-397` (the approved and unapproved feeds call it).
  A path re-used while its earlier branch is pending is absorbed; the importer's output is the same bytes
  for both, and FileFetcher reads whatever file is at the path when it runs.

## 8. Orchestrator (`StepOutcomeHandler`)

1. Duplicate check: `EXISTS data:{E}` replaces `ReadAsync`; the blob is never loaded. Absent → return
   (`:248-253`). Skipped when `E == Guid.Empty`.
2. Per matched successor, in order:
   1. `S` (§5.2).
   2. Skip if `handoff:{E}` already holds `nextStepId`. This comes before any write: a successor
      already dispatched owns its key and may have consumed it, so re-materializing would orphan a
      key nobody will read or delete. The only remaining re-materialization is a crash between the
      dispatch and the `SADD` (limit 1).
   3. Completed → `COPY data:{E} data:{S}` **without** `REPLACE` (`KeyCopyAsync`, StackExchange.Redis
      2.13.1); `false` means an earlier attempt made it, and dispatching is still correct.
      Failed or Cancelled → `SET data:{S} "" NX`. The failed step's input is never passed on (spec D6).
   4. In-process hand-off: send `ProcessDispatch(S)` to `processor-{id}`, broker-confirmed; then
      `SADD handoff:{E} nextStepId`.
   5. A deterministic dispatch failure is caught **per successor**: report that successor Failed naming
      `S` (so it is reclaimed) and continue. If `S` itself could not be written (the COPY / SET failed
      deterministically, e.g. NOPERM), `data:{S}` is first written `""` best effort so the report names
      a key that exists; if that write is refused too, the report names `Guid.Empty`. An outcome must
      name a key that exists, or none: one naming a missing key is dropped as a duplicate and the
      successor's failure branch never runs. The report-also-failed park path
      (`NextStepHandoffHandler.cs:148-170`) runs after the loop, so one bad successor no longer stops its
      siblings.
3. `DEL data:{E} handoff:{E}`, last (as today).

`handoff:{E}` exists because an unroutable send is classified transient and requeued immediately
(`SendFaultClassifier`, `GatedQueueConsumer.cs:408`): in-process, the whole outcome retries, and without
the set every sibling dispatched before the failing one would be re-sent on every retry.

`L2FaultClassifier.IsTransient` gains `RedisServerException` with `OOM`, `READONLY`, `LOADING`, `BUSY`,
for both hosts. `NOPERM` stays permanent; the org's Redis ACL must allow `COPY`.

## 9. Fault walk and accepted limits

| Fault | Result |
|---|---|
| P: before the write | replay → duplicate |
| P: after the write, before the outcome | replay rewrites the same `E` → converges (an id minted in-process: orphan, limit 4) |
| P: after the outcome, before the input delete | second outcome for `E`: absorbed, or duplicate subtree |
| P: after the delete, before the ack | redelivery finds the input absent → returns |
| O: after k of N hand-offs | redelivery skips the k in `handoff:{E}` |
| O: between a confirmed dispatch and its `SADD` | that successor dispatched again → duplicate |
| O: duplicate outcomes on two replicas | same `S`, same bytes → absorbed or converging duplicate |

No path loses data. Accepted limits:

1. **Orphaned `S` on rare orchestrator crashes.** A copy can recreate `S` after its successor consumed it,
   and the replica that made it can crash before dispatching; its redelivery finds `E` gone and never
   returns to `S`. Also: an L1 miss on a redelivery after an earlier attempt copied. No TTL is added: a
   TTL trades the leak for a possible loss of a slow-pending input.
2. *(Policy, not a limit; unchanged from today.)* A transient outcome-send failure replays the author,
   not one send — as a post-send failure does today (`TransientSendException` is rethrown,
   `ProcessDispatchHandler.cs:284-290`, and the dispatch is requeued). Duplicate side effects follow
   (KafkaExporter produces again, FilePersister overwrites and converges, Analyst pays for the LLM again);
   that is the system's rule — a duplicate over nothing (§2).
3. *(Withdrawn.)* A successor listed twice in one step's `NextStepIds` would share one `S` — but BaseApi
   refuses duplicate next steps on every write path (`StepDtoValidator.cs:26-28, 60-62`, applied by
   `WorkflowGraphSaver.cs:32-33, 68`), so the case cannot reach L1.
4. **An `executionId` minted in-process is the author's choice, and orphans are its price.** An author
   that mints a fresh id inside `ProcessAsync` (`NewExecutionId()`, `Guid.NewGuid()`) gets a different
   `E` on every replay of the same input. A replay after the write and before the outcome leaves the first
   `data:{E}` with no outcome naming it — an orphan, never deleted (no TTL, no sweeper) — and a replay
   after the outcome runs a duplicate subtree. An author who wants convergence derives the id from what it
   received instead (the input's lineage, a record header, a stable business key). Today Sample, Analyst
   and the recorder after a failed entry step mint in-process and accept this. The author must be told:
   `NewExecutionId()`'s XML comment (`BaseProcessor.cs:216`) and `SendToPostAsync`'s state it.
5. **Kafka `execution-id` is a contract between the producer and the importer.** The importer enforces
   what it can see: a record without a valid id is committed and not imported, and the dispatch reports Failed (§7). What it
   cannot see is uniqueness across records — two different records stamped with one id share a key, and
   one is absorbed. That part stays the producer's to keep.
6. **Redis is the only data-size limit** (pod 192Mi, no `maxmemory`). Set `maxmemory` below the pod limit
   with `noeviction`, so a full store refuses writes — retried under §8 — instead of being OOM-killed.
7. **`COPY` needs one instance or hash slot** — true today; a future cluster needs a shared hash tag.
8. **One `orchestrator-result` delivery does the work two deliveries shared.** N is the number of graph
   successors one outcome matches (usually 1), not the author's spawns — each spawn is its own outcome.
   Broker confirms per outcome are unchanged (N `NextStepHandoff` before, N `ProcessDispatch` after);
   added are two sub-millisecond Redis calls per successor (`COPY`, `SADD`); removed are the blob read,
   its serialisation and the whole second delivery. End to end a successor is dispatched sooner. Only
   the per-delivery duration of `orchestrator-result` grows, which matters for its alert thresholds.

## 10. Monitoring

Post-hop series stop: dead-letter depth, depth, consumers, queue wait, consumer duration. No panel breaks
(all group `by (queue)`). Optional: drop `(-post)?` at `skp-processor.json:1175, 1276, 1368`. Edit
`grafana/README.md:1432,1540`. Per-hop timing stays in Kibana ("branch completed in …ms",
"dispatched in …ms"); hand-off log lines move under the `StepOutcomeHandler` category.

## 11. Migration — two releases

1. **Release 1 — processors.** New processor framework (§4–§7): reads empty keys, derives `E`,
   in-process post, no longer sends `ProcessedData`; keeps a drain-only consumer on
   `processor-{id}-post`. The orchestrator gets one change, deployed **before** the processors: its
   blob read uses `IsNull`, so an empty branch's `""` is read as no data rather than as an absent key
   (with `IsNullOrEmpty` it would be taken for a duplicate and its successors never dispatched). It
   keeps reading the blob and sending `NextStepHandoff` in this release. Until release 2, no-data
   successors still arrive with `Guid.Empty` and take the no-input formula, so two parallel failures of
   one lineage into one recorder can still share a key for the length of release 1.
2. **Release 2 — orchestrator.** Derived `S`, `COPY`/empty keys, in-process hand-off, `handoff:{E}`.
   After both post queues and their `.dead` queues read zero (redrive or inspect `.dead` first): remove
   the drains, topology, constants and `NextStepHandoff`; delete the four queues on each environment.
   **Deploy only after every `processor-*-post` queue and its `.dead` queue reads zero**: an old
   no-data `ProcessedData` drained under release 2 takes the entry-successor formula, and two of one
   step could then share a key. **Rollback constraint:** once release 2 is live, processors must not
   roll back below release 1.

Order matters: an orchestrator writing empty keys to an old processor would have that step read
"empty" as "absent" and never run.

## 12. Change list

- **Contracts** — `ProcessorQueues.cs:45-48`, `OrchestratorQueues.cs` (`ResultPost`, `ResultPostDead`),
  `MessageTypes.cs:61-62`, `NextStepHandoff.cs` (release 2), new `Uuid5.cs`. `ProcessDispatch` unchanged.
- **Processor framework** — `BaseProcessor.cs:152-199`, `ProcessDispatchHandler.cs:112-187, 339`,
  `ProcessedDataHandler.cs`, `PostSendException.cs` (text), `DispatchState.cs` (input key),
  `BaseProcessorServiceCollectionExtensions.cs:256, 269, 319, 360, 364`, `ProcessorTopology.cs`.
- **Orchestrator** — `StepOutcomeHandler.cs:13-23, 231-253, 293-319, 456-475`,
  `NextStepHandoffHandler.cs`, `OrchestratorTopology.cs:88-89`,
  `OrchestratorHost.cs:260-276, 307-313, 415, 428`.
- **Shared** — `L2FaultClassifier`.
- **Authors** — KafkaImporter only: `KafkaRecord.cs:31`, `KafkaRecordConsumer.cs:122`,
  `KafkaImporterProcessor.cs:165, 174`. Sample's `catch (PostSendException) { throw; }` stays valid.
- **Tools** — `kafka-produce-records.py:144`, `simulate-endless-feed.py:386-397`.
- **Tests** — `ProcessedDataHandlerTests` (rewrite), `BaseProcessorSeamTests:109, 129` (inverted: a replay
  now produces the same ids), `:161, 179, 199`, `ProcessorTopologyTests`, `ProcessDispatchHandlerTests`,
  `ExecutionRoundTripTests:123, 276, 422, 456-508`, `OrchestratorTopologyTests:48, 86`,
  `OrchestratorFanoutTests:58`, `OrchestratorHostWiringTests:162`, `KafkaImporterLoopTests` and its fake
  consumer, `KafkaExporterTests`, the Live tests, `Resilience/Fixtures/complete-run.json`.
  `Support/InMemoryL2.cs` needs `KeyCopyAsync`, set commands and empty-value semantics — without them
  NSubstitute returns defaults and tests pass vacuously.
- **Docs and config** — the XML comments on `NewExecutionId()` and `SendToPostAsync` (limit 4: an id
  minted in-process does not converge on replay — orphans and duplicate subtrees); comments in `ProcessorQueues`, `ProcessorTopology`, `ProcessedDataHandler`,
  `StepOutcomeHandler`, `ProcessDispatchHandler`; the base64 sizing comments in `k8s/37`, `38`, `40`;
  `grafana/README.md`; `k8s/11-redis.yaml` (`maxmemory`, limit).
