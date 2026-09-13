# FailureRecorder — what was changed on the live system, and how to undo it

**Date:** 2026-09-13
**Plan:** `docs/superpowers/plans/2026-09-13-failure-recorder.md`
**Spec:** `docs/superpowers/specs/2026-09-13-failure-recorder-design.md`

Git records the code. It does not record any of the below, which is why this file exists: every
change here lives in a database row, a Kafka topic or a kind node, and would otherwise be
reconstructible only from a scratch directory that is not part of the repository.

---

## 1. The processor row

| field | value |
|---|---|
| id | `e0b98ffc-e95d-4fee-a407-cc53fb66914a` |
| name | `failure-recorder` |
| sourceHash | `ab61472514e78199ca25ed17276369c738447626df1bd443b63f8cd94b8f212a` (repointed 2026-09-13; was `49d9d1dd98…`) |
| inputSchemaId / outputSchemaId / configSchemaId | all **null** |

All three nulls are load-bearing, not laziness. The seven parents that fan into this processor carry
**three different** output schema ids, one row has one `inputSchemaId`, and `SchemaEdgeValidator`
compares row ids for equality — so no non-null value could satisfy every incoming edge. A null on
either side of an edge passes the gate.

**The hash changes on every rebuild.** Repoint the row or the pod never resolves identity and retries
forever, which presents as a permanently `0/1 READY` pod with zero restarts.

**Undo:** `DELETE /api/v1/processors/e0b98ffc-e95d-4fee-a407-cc53fb66914a` (after removing the steps
below, which reference it).

## 2. The shared row that was changed — the one with reach

`kafka-exporter` (`157a0f40-d668-42f3-a500-4762c587f64a`) had its **`inputSchemaId` set to null**. It
was `b3877a36-ba2f-4893-8b46-f91413b12384` (`file-locator`).

**Why:** the exporter's pre handler validates its runtime input against that schema, and a failure
record is not a file locator, so every export of one would have failed its input schema. Cloning the
exporter into a second row is forbidden — `uq_processor_source_hash` is unique on the binary's hash.

**What it costs, and who else pays:** that row is shared with chain step 7 (`skp-documents`) and with
the `kafka-import-export` workflow. Both lost *input* validation. Survivable because this system
validates on the producing side — a processor validates its own output, so bad data never reaches the
next queue — and consumer-side input validation had never fired in a live suite. It is still a
control removed from two places this feature does not otherwise touch.

**A change to a schema edge is not enforced until the processor restarts.** Processors resolve schema
definitions once at startup and never re-read them. `kubectl -n skp rollout restart
deploy/processor-kafkaexporter` was run for exactly this reason; without it the running pod keeps
enforcing the old schema and refuses the record, one hop from where the symptom appears.

**Undo:** `PUT /api/v1/processors/157a0f40-…` echoing every field with `inputSchemaId` restored to
`b3877a36-ba2f-4893-8b46-f91413b12384`, then roll the exporter deployment again. **`PUT` replaces the
row** — a partial body silently wipes `name`, `version`, `description` and `sourceHash`.

## 3. The workflow wiring

`filefetcher-archiveexpander-chain` (`1a56b3ca-e276-4815-87fa-5c2f48ab6dad`) went from 7 steps to 9.

| what | id | entryCondition | payload |
|---|---|---|---|
| step: record-failure | `73952b09-9d09-4237-b277-995ed2690f1c` | **2** (PreviousFailed) | `{}` |
| step: export-failure | `eb707c5e-24af-4d99-8c97-f127b560e4b4` | **1** (PreviousCompleted) | `{"topic": "skp-failures", "deliveryTimeoutSeconds": 30}` |
| assignment: record-failure | `68a5dd70-e1c9-4bbd-99e9-bc11f9930d2c` | | |
| assignment: export-failure | `9efc2f59-2ddc-4382-b91a-66fac6693329` | | |

All seven original steps gained `73952b09…` in `nextStepIds`, **alongside** the successor they
already had — the terminal exporter step went from none to one.

**The export step is `PreviousCompleted`, not `PreviousFailed`.** Its predecessor is the recorder, and
the recorder *completing* is the normal case. Wiring it to 2 would export only when the recorder
itself broke.

**`deliveryTimeoutSeconds` is 30 to match chain step 7.** `KafkaExporterProcessor.CacheKey` is the
delivery timeout and nothing else, so two steps sharing a timeout share one cached producer; a
different value silently builds and holds a second.

**Undo:** remove the two assignment ids from the workflow, remove `73952b09…` from all seven steps'
`nextStepIds`, delete the two assignments, delete the two steps, then republish.

## 4. Other live state

- **Topic `skp-failures`** was created on the dev broker (`skp-kafka`, `apache/kafka:3.9.1`). It did
  not pre-exist.
- **Deployment `processor-failurerecorder`** — `k8s/42-…`, image `processor-failurerecorder:local`
  loaded into the kind cluster `desktop`. The kubectl context may say `docker-desktop`; the cluster
  is kind.
- Nothing else was started or stopped. The five workflows projected before this work
  (`filefetcher-archiveexpander-chain`, `simple-abc`, `v8-fanout-proof`, `v8-fanout-proof-clone`,
  `kafka-import-export`) are all still projected; `sc-chain` was stopped before and remains stopped.

## 4a. The redeploy of 2026-09-13, and the one row that needed repointing

Commit `283cc00` added the `Result` attribute to processor-side log records. That is framework code
shipped as a NuGet package, so it was inert until every processor was rebuilt from the repacked
packages and redeployed. All **eight** were: the seven chain processors plus `failure-recorder`.
`processor-sample` was deliberately left alone.

**Only `failure-recorder` needed its `SourceHash` repointed, and the reason is worth remembering.**
The hash folds a project's OWN sources, not its package dependencies — verified by rebuilding
`Processor.FileFetcher`, whose hash came back byte-identical to its registered row despite consuming
a changed `BaseProcessor.Core`. The recorder was the exception because its own
`FailureRecorderProcessor.cs` had changed in `98a46b3` *after* its image was built and its row
registered. Every other processor needed nothing.

**A rollout that reports "exceeded its progress deadline" here is usually a stale row, not a broken
image.** That is exactly what happened: the pod sat `0/1 READY` logging "still no processor
registered for source hash ab614725…", `kubectl rollout status` gave up at 300s, and the same pod
went ready seconds after the row was repointed.

**Verified live afterwards**, since a green deploy proves nothing on its own: a seeded failure ran
the chain end to end and `attributes.Result` now appears on `ProcessedDataHandler` (`Completed`) and
`ProcessDispatchHandler` (`Failed`) records. Before the redeploy that field existed only on
`Orchestrator.Messaging.StepOutcomeHandler` records.

## 4b. `skp-paths` has two competing consumers — demonstrated, not theorised

One seeded record, `{"filePath": "/mnt/skp-files/in/resultproof.zip"}`, was processed **twice**:

- at 17:00:05 by `kafka-import-export`, consumer group `skp-kafkaimporter`, which exported it
  straight out as 49 bytes;
- at 17:00:20 by `filefetcher-archiveexpander-chain`, consumer group `skp-splitchain`, which fetched,
  expanded, failed at the normalizer, and produced a failure record.

Different consumer groups on one topic each receive their own copy, so **every path published to
`skp-paths` is handled by both workflows**. Nothing breaks, and this predates the work recorded here
— but anyone reasoning about "what happened to that file" needs to know one record yields two
lineages under two correlation ids. `skp-paths-sc` (group `skp-sc`, the stopped `sc-chain`) is a
third subscriber, currently inert.

## 5. Two API facts that cost time and are documented nowhere else

- **`POST /api/v1/orchestration/start` and `/stop` take a RAW JSON GUID STRING**, not
  `{"workflowId": "..."}`, and both answer **202**, not 200.
- **An assignment `PUT` is invisible to a running orchestration until `orchestration/start`
  re-projects the workflow.** A payload edit that appears to have no effect has almost certainly
  landed in the database and not in the projection.

## 6. What is proven, and what is not

`FailureRecorderLiveTests` (RealStack category, needs `SKP_REALSTACK=1`) proves both record shapes end
to end against this cluster: a mid-chain failure carrying a lineage, and an entry-step failure
carrying none. Its mid-chain test asserts the orchestrator logged `advancing 1 successor(s) on a
Failed step` — **not** `no successor accepts it`, which is the terminal-step line and, since this
wiring exists, would assert the edge is absent.

Not proven, and deferred by the spec: that the diagnosis survives. The record travels the broker and
always arrives; the *reason* travels the log pipeline, which this deployment sometimes drops. §8.3 of
the spec names the fix if that ever bites — carry the author's failure text on the wire.
