# Handover — SK Normalizer dedup + Releaser processor (design), 2026-11-23

## Status
- **Design agreed with the user in brainstorming (2026-11-22/23). Nothing implemented.** No code, schema or manifest was touched.
- Branch at handover time: `feature/acto` in `C:\Users\katan\source\repos\SK_P11` (main checkout, no worktree). The user's own uncommitted edits (k8s/31,32,43, `Processor.Analyst/Bit/RehearsalGraph.cs`, `WorkflowStudio/.../Chip.tsx`, untracked docs) must stay unstaged. Ask the user which branch the implementation goes on before starting (likely a new `feature/dedup-releaser` off `main`).
- Next step on the other machine: turn this into a plan with **superpowers:writing-plans**, get the user's approval, then implement. The user works in **brainstorming mode — no implementation without explicit approval.**

## Goal
Deduplicate SK Normalizer output documents in a time window, keeping one **winner** per dedup key (e.g. "the longest audio"), and release each winner downstream once its window has closed. Losers are dropped **before ffmpeg**, saving the transcode. Every execution id is reported to the orchestrator; nothing is swallowed.

Two processors share one rule set:
1. **SK Normalizer** (existing): reads the window, decides win/lose, hands winners on.
2. **Releaser** (new, `Processor.Releaser`): stores winners in the window; a cron-fired sweep releases closed windows.

## Decisions (the user's, unless marked "my call")

### Handler
- **One handler class holds all behaviour.** The existing `IProviderHandler` (`src/Processor.SKNormalizer/Handlers/IProviderHandler.cs`) gains the dedup members:
  - how to build the dedup key from the standardized XML fields,
  - the window **TTL** (seconds) — owned by the handler, not by step config,
  - how to decide the winner between two documents (e.g. longer `audio/durationSeconds`).
- A handler with no dedup rule behaves exactly as today (no L2 read, no cancel). This is the backward-compatibility guarantee; there is no flag.
- **No shared library.** The Releaser is decoupled: it carries its **own duplicate copy** of the handler class(es) and its own registry keyed by the **same handler name**. Releaser step config = the handler name.
- My call: guard against drift between the two copies with one shared test fixture (same input documents → same key, same winner) run by both test suites.

### Dedup scope and time
- **Per document**, not per item. (A normalizer input can hold several items; the handler decides which fields of the document form the key and the comparison.)
- Time source: **`source/ingestedUtc`** (stamped by the normalizer in `Augment`).
- **The window is opened by the first document** for a key and closes at `ingestedUtc(first) + TTL`. The time is therefore NOT in the key.
- A document arriving after close but **before** the sweep finds the key and joins that window.
- **A new winner after the sweep starts a new window** (the key is gone, so it is "new").
- Comparison happens **before ffmpeg**, so duration-based rules use the provider's **claimed** duration (from `Map`), not the measured one from `Reconcile`. Accepted.

### L2 layout (my proposal, user asked for "best for search by expiry")
```
skp:wf:{workflowId}:dedup:{handler}                 ZSET  member = {handlerKey}, score = closeAt (unix seconds)
skp:wf:{workflowId}:dedup:{handler}:{handlerKey}    HASH  data, execId, ingestedUtc, closeAt, keyText, <compare fields e.g. durationSeconds>
```
- Nests under the workflow's own prefix like the cache keys (`L2ProjectionKeys.Cache`, `src/Messaging.Contracts/Projections/L2ProjectionKeys.cs`). Add the builders there.
- `{handlerKey}` = a hash (e.g. SHA-256 hex) of the handler's key fields — the key scheme forbids `:` inside a segment and XML text can contain anything. The readable form goes in the `keyText` field.
- Closed windows: `ZRANGEBYSCORE index -inf now` — no SCAN.
- Compare reads only the compare fields (`HMGET`), never the audio blob.
- Expiry: absolute `EXPIREAT` = window start + **2 × TTL**, set when the window opens; overwrites do not extend it. The index's expiry is pushed forward on each write.
- `data` holds the normalizer's full output document (transcoded audio included) — memory cost accepted.

### SK Normalizer behaviour (dedup handler)
| Hash key | Outcome |
|---|---|
| does not exist | **Completed(A)**, `L2[entryId] = data` — exactly as today |
| exists, A wins | **Completed(A)**, `L2[entryId] = data` — exactly as today |
| exists, A loses | **Cancelled(A)** via `throw new CancelledException(...)`, no hand-over — same path as the whitelist miss in `AcmeHandler.cs:271-278` |

The normalizer only **reads** the window; it never writes it.

### Releaser behaviour
Wired as a successor of the normalizer (entry condition `PreviousCompleted`) **and** as an entry step fired by the workflow cron. It tells the two apart by the dispatch's execution id (`Guid.Empty` = cron fire, as in `WorkflowFireJob`).

| Dispatch | Action | Outcome |
|---|---|---|
| Data (exec X) | Recheck with the handler, atomically (Lua). Wins or key absent → write/overwrite the hash + ZSET member. Loses → write nothing. | **Cancelled(X)** in both cases (`throw CancelledException`) — no hand-over |
| Cron (no exec id) | For each closed window: read hash → `SendToPostAsync(data, savedExecId)` → delete hash + remove ZSET member | **Completed(winner)** per winner, with its saved exec id |
| Cron, nothing closed | — | **Cancelled**, no exec id (entry dispatch carries `Guid.Empty`) — same as KafkaImporter on an empty topic |

- The Releaser rechecks the **same way** the normalizer checks (two documents can both beat the stored one at the normalizer before either is stored).
- A winner thus reports **Cancelled(X)** when stored and **Completed(X)** when released. An overwritten winner's final outcome is its store-time Cancelled. So the Releaser's successors must be **`PreviousCompleted`**.
- Swept winners go out under the **cron fire's correlation id** — a document's journey shows as two runs in Kibana. Accepted.
- My calls: send **before** delete (a crash resends under the same derived key: duplicate, not loss); a hash that already expired is just removed from the ZSET; a redelivered document that finds its own execId stored counts as a win.

### No framework or orchestrator changes
Everything uses existing paths, verified in code:
- `SendToPostAsync(bytes, executionId)` lets the author choose the exec id (precedent: `Processor.KafkaImporter`, header ids, line ~252). On an entry dispatch the branch key is `EntryIds.Branch(wf, step, execId)` — deterministic, so a replay converges.
- `CancelledException` always reports the dispatch's own exec id (`ProcessDispatchHandler.cs`, `Failure(d, …)`); the author cannot override it. That is why the Releaser's store path reports Cancelled(X) — accepted by the user.
- A Cancelled outcome hands successors a new entry id with **empty data** (`StepOutcomeHandler.MaterializeAsync` copies only Completed). The user confirmed copying data on Cancelled is unnecessary.
- Entry conditions (`BaseApi.Service/Features/Step/StepEntryCondition.cs`): 0 PreviousProcessing (rejected), 1 PreviousCompleted, 2 PreviousFailed, 3 PreviousCancelled, 4 Always, 5 Never. Entry steps only honour `Never`. An entry step may also be a successor (`WorkflowEntrySteps` is an explicit list).

## Things the implementer must handle (found in code, not yet designed in detail)
1. **Pipeline order.** `NormalizationPipeline.Run` (`src/Processor.SKNormalizer/Pipeline/NormalizationPipeline.cs`) runs stages 2–7 **per item, one item after another**, so item 1 is transcoded before item 2 is even mapped. Per-document dedup before ffmpeg needs stages 2–4 for all items first, then the dedup check, then 5–7. Keep the failure semantics ("stops at the first failure").
2. Where exactly the dedup check sits: after `Augment` (whitelist gate first — a non-whitelisted document should cancel as today, not occupy a window).
3. The Releaser must parse the normalizer's output document (`FileNode` JSON, see `SKNormalizerProcessor.ReadDocument`) to find the standardized XML and compute key + compare fields with its handler copy.
4. Releaser input and output schema = the normalizer's output schema.
5. New-processor plumbing: project, Dockerfile, k8s manifest, schema registration in BaseApi, startup config-schema conformance — copy the pattern of an existing small processor (e.g. `Processor.OutcomeRecorder` or `Processor.Sample`). Check `docs/` handovers for the object-pair / EmsExporter work for the full checklist used before.
6. Tests: .NET tests are blocked by App Control on the user's dev machine (see memory) — check whether the other machine can run them.

## Open (not decided)
- Nothing blocking. Name **Releaser** chosen by the user. Confirm the L2 layout above with the user before planning (it was proposed, the user asked for it to be written up rather than objecting).
