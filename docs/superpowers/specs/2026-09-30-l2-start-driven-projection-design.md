# Spec: L2 projection, start-driven (final)

Status: approved 2026-09-30; implemented on `feature/path-importer` (merge b2667d8, participant
alignment f7a8cf1) and live on dev. The offline machine is not migrated. Every decision below was
confirmed by the user.

## 1. Principles

1. **The database is the only source of truth.** L2 (Redis) is a projection of it. **Only a workflow
   start aligns L2 — for every entity that participates in the workflow being started, including
   entities shared with other workflows** (§3.5).
2. **Nothing else writes the projection.** CRUD, entity deletion and BaseApi startup never touch L2.
3. **A parent key is never deleted while its row exists.** Values and child keys may be overwritten,
   or deleted and rewritten.
4. **The orchestrator and processors work from L1.** L2 is read only to load L1 (activation, startup,
   names). The two runtime exceptions are execution blobs (`skp:data:*`) and SKNormalizer's cache
   lookups.
5. **Once started, database edits cannot affect a running workflow.** Its L1 definition and names are
   frozen until its next start.
6. **Processors own their keys.** BaseApi never writes or deletes `skp:proc:*`; they expire by TTL.

## 2. Key layout

| Key | Type | Content | Writer | Removed by |
|---|---|---|---|---|
| `skp:wf:{id}` | HASH | `name`, `store` (flattened L1 structure), `roots` (cache root list) | start | never (a deleted workflow is never started again) |
| `skp:wf:{id}:cache:{root}` | STRING | JSON key list | start | start, when the root is unbound |
| `skp:wf:{id}:cache:{root}:{key}` | STRING | one value | start | start, when the item or root is gone |
| `skp:step:{id}` | HASH | `name` | start (each step of the workflow) | start, when the workflow dropped the step and its row is gone (§3.5) |
| `skp:live` | SET | running workflow ids | start `SADD` / stop `SREM` | never |
| `skp:proc:{id}` | HASH + TTL | `name` | processor instance, every heartbeat | TTL |
| `skp:proc:{id}:instances` | SET + TTL | instance ids | processor instance, every heartbeat | TTL; `L2OrphanSweeper` removes dead ids |
| `skp:proc:{id}:{instanceId}` | STRING + TTL | liveness entry | processor instance, every heartbeat | TTL |
| `skp:data:{entryId}` | STRING | execution blob | unchanged | unchanged |

- Full name: `{name}_{version}-{idSuffix}` for every entity (`EntityNames.Format`); the suffix is part of
  the entity id, never an instance id — StatefulSet or not.
- Processor TTL = liveness TTL (4 × heartbeat interval).
- Retired: `skp:` (parent index), `skp:{wf}` (root), `skp:{wf}:{step}`, `skp:proc:{p}` as a SET,
  `skp:name:{id}`.

## 3. BaseApi

### 3.1 HTTP rules
- Controllers (CRUD, start, stop) work against the database only. Every L2 operation is enqueued on
  `orchestrator-control` and consumed by BaseApi's own gated consumer.
- A failed enqueue returns **500** with a message (`brokerOp`), as start does today.
- The L2 gate never blocks HTTP; it only pauses the consumer.
- Start and stop share one queue, one consumer, prefetch 1.

### 3.2 Start
- **HTTP (unchanged):** validate (existence, cycle, schema edge, payload vs config schema, processor
  liveness), build the definition, enqueue. The liveness read is the one L2 read on the HTTP path
  (422 for a dead processor; 500 `redisOp=ProcessorLiveness` when Redis is unreachable).
- **Consumer, in order:**
  1. Align the participants with the database (§3.5), in ONE pipelined batch whose deletes come
     first: delete removed participants' keys, then write every added and kept participant's keys.
  2. `SADD skp:live {id}`.
  3. Publish `OrchestrationStarted(workflowId)` (id only), only after the writes.
  A failed publish requeues; steps 1–3 are idempotent.
- **Why deletes come first:** the batch is pipelined, not MULTI, so a dropped connection applies a
  prefix of it. The removals are computed from what the previous start recorded (`store`, `roots`,
  each root's key list), which this batch overwrites. With the deletes first, a torn batch leaves those
  records intact and the rerun computes the same removals. Deletes and writes never touch the same key.
- **What a start guarantees, and when.** Once a start has been *processed* — the id is in `skp:live`
  and `OrchestrationStarted` has been published — `skp:wf:{id}` and the keys of every current
  participant match the database as it was at validation, and the keys of removed participants are
  deleted, except a dropped step whose row still exists (§3.5). Specifically:
  - **Not at the HTTP response.** `202 Accepted` means validated and enqueued. Until the consumer runs,
    L2 still holds the previous definition (or nothing); while the L2 gate is closed (Redis unreachable)
    the write waits. A Redis fault (gate trips) or a failed send requeues and reruns the whole handler,
    and a torn batch leaves a prefix applied until that rerun. Any other failure — including a database
    fault in the dropped-step lookup — parks the message: the start is not applied, L2 keeps the previous
    definition, and only the next start repairs it (§6). `OrchestrationStarted` is the signal: it is
    published only after the write and the `SADD`.
  - **The database as of validation.** The definition is built at HTTP time and carried in the
    message; an edit between the response and the consumer reaches L2 at the next start (§1, principle 5).
  - **Deliberately left unaligned:** a dropped step whose row still exists keeps its key and its
    last-written name until a workflow that uses it starts; a previous `store` or list that is missing
    or unreadable yields no removals (§3.5); a deleted workflow's own keys; processor keys (§5).

### 3.3 Stop
- **HTTP:** enqueue; a send failure returns 500.
- **Consumer:** `SREM skp:live {id}`, **then** publish `OrchestrationStopped(workflowId)`. No cleanup.
  A failed publish requeues; both steps are idempotent.

### 3.4 Removed from BaseApi
- L2 work on entity create/update/delete and at BaseApi startup.
- `L2Cleanup` on stop.
- Processor names in `ToDefinition` / `Names`.

### 3.5 Participant alignment

**Referential integrity is the foundation.** Every reference between entities is a foreign key with
`ON DELETE RESTRICT`; BaseApi adds no application check (`BaseService.DeleteAsync` loads, deletes,
commits). A delete of a referenced row fails in Postgres (SQLSTATE 23001) and BaseApi answers 422.

| If A references B… | …B cannot be deleted while A exists | Foreign key |
|---|---|---|
| workflow → entry step | step | `workflow_entry_steps.step_id` |
| workflow → assignment | assignment | `workflow_assignments.assignment_id` |
| workflow → cache | cache | `workflow_caches.cache_id` |
| step → next step | next step (and a step with successors is itself blocked) | `step_next_steps.next_step_id` / `.step_id` |
| step → processor | processor | `steps.processor_id` |
| assignment → step | step | `assignments.step_id` |
| processor → input/output/config schema | schema | `processors.*_schema_id` |

Deleting a workflow is never blocked: it cascades only its own junction rows, and the entities it
referenced become deletable once nothing else references them.

**Consequences.**
- At a start, every participant exists — validation just passed against the same rows.
- A participant's row can only disappear after every workflow has stopped referencing it. So a start
  that deletes the key of a removed participant whose row is gone can never take a key from another
  workflow; and overwriting a shared participant's key cannot disturb another RUNNING workflow, which
  works from L1.
- Database work never affects an operational workflow: renames, edits and deletes reach a workflow
  only at its next start.

**Participants of one start** (`WorkflowGraphLoader.LoadL1Async`):

| Entity | Found through | In L2 |
|---|---|---|
| Workflow | the requested id | `skp:wf:{id}` (`name`, `store`, `roots`), `skp:live` |
| Steps | `workflow_entry_steps`, then every step reachable through `step_next_steps` (breadth-first) | structure inside `store`; `skp:step:{id}` `name` |
| Assignments | `workflow_assignments` | no key: each payload is embedded in its step inside `store` |
| Caches | `workflow_caches` | `skp:wf:{id}:cache:{root}` (key list) and `…:{key}` (entries); root list in `roots` |
| Processors | each step's `processor_id` | read at HTTP start (liveness); keys owned by the processor instances (§5) |
| Schemas | each processor's input/output/config schema | none; used only for validation at HTTP start |

**The alignment**: the start compares its participants from the database with the previous
participants recorded in L2 (the previous `store` and `roots`, and each root's key list):

| | Steps | Caches | Assignments | Workflow |
|---|---|---|---|---|
| **Added** | write `skp:step:{id}` name | write the root and its entries | embedded in the new `store` | — |
| **Kept** | overwrite the name with the database value | overwrite; delete the entries whose items were removed | overwritten with `store` | overwrite `name`, `store`, `roots` |
| **Removed** | delete `skp:step:{id}` if the row is gone; keep it if the row still exists (another workflow may use it) | delete the root and its entries (these keys belong to the workflow) | leave with the old `store` | — |

- Only removed step ids are looked up in the database, in one query; a start that removed nothing makes
  no database read.
- A previous `store` or list that is missing or unreadable contributes no removals: without a record of
  what was removed, nothing is deleted on a guess.
- If two workflows dropped the same step, whichever starts first deletes its key; the other's delete
  is a no-op.

**Outside start alignment, by design:**
- **Processors.** Each processor instance owns `skp:proc:{id}` (§5). A deleted processor's keys expire
  by TTL about 4 heartbeat intervals after its last instance stops — never while one still runs, since
  every beat refreshes them. A restarted pod whose row is gone does not resolve its identity and writes
  nothing.
- **Schemas.** No L2 keys; processors fetch their definitions from BaseApi at boot.
- **A deleted workflow's own keys.** Nothing starts a deleted workflow, so its `skp:wf:{id}` hash and
  cache keys are never cleaned (a few small keys per deleted workflow; nobody reads them).

## 4. Orchestrator

- **Start announcement:** if the id is not in `skp:live`, do nothing. Otherwise read `skp:wf:{id}`
  `store` → build the L1 entry (**overwrite**), schedule if `Cron` is set, and **refresh** the
  workflow, step and processor names in the name dictionary (a found name overwrites the cached one; a
  miss or a failed read keeps it), so a rename shows from the workflow's next start.
- **Startup (hydration):** `SMEMBERS skp:live` → the same `ActivateAsync` per id.
- **Stop announcement:** guard is `SISMEMBER skp:live` (was: root key exists). Still live → ignore
  (a later start overtook it). Otherwise unschedule and mark the L1 entry stopped. No L2 or L1 cleanup.
- **Runtime:** `WorkflowL1Store` and the name dictionary only; L2 only for `skp:data:*`.
- **Stopped entries stay in L1** — `L1ReapService` is removed; in-flight outcomes resolve through the
  stopped entry until the workflow is restarted or the pod restarts.

## 5. Processor

- Every heartbeat, all with the TTL, in this order: the liveness key `skp:proc:{id}:{instanceId}`,
  `SADD` the instance id to `skp:proc:{id}:instances`, then `name` on `skp:proc:{id}` =
  `{name}_{version}-{idSuffix}` (the version is inside the name; there is no separate field).
- **Identity is fixed at pod boot.** `Id`, `Name`, `Version` and the schema ids are resolved once from
  BaseApi (by SourceHash) and never re-read; the name hash, the `IdentityName` log attribute and the
  OTel resource (`service.name`/`service.version`) all come from it. A database rename or version change
  of a processor takes effect only when its pods restart; a workflow start cannot change it.
- A new-image processor that finds a retired SET at `skp:proc:{id}` (WRONGTYPE) deletes it and rewrites
  the name hash once; the liveness key is written before the name, so a name failure never costs it.
- Workflow/step names load lazily into L1 via `EntityNameResolver`, cached until pod restart.
- SKNormalizer reads `skp:wf:{id}:cache:{root}[:{key}]` per lookup (values change only at start).

## 6. Accepted behaviour

- Redis is ephemeral; a Redis restart wipes everything until each workflow is started again. Whether
  to persist it is a resource-allocation decision outside this design.
- A deleted step's key is removed by the next start of a workflow that dropped it; a deleted
  workflow's own keys persist (nothing starts it again); nobody reads them.
- A failed start consumer is repaired only by the next start of that workflow.
- A rename is visible for workflow/step names at the workflow's next start; for a processor at pod
  restart.
- A processor whose instances are all down longer than the TTL loses its name key; an orchestrator
  restarting meanwhile logs the id suffix until an instance returns.
- Restarting a workflow overwrites its L1 entry; lineages still in flight resolve against the new
  definition.
- An orchestrator restart loses a stopped workflow's in-flight lineages (hydration reads only
  `skp:live`).

## 7. Deleting a referenced entity

Not a gap: referential integrity refuses the delete while any workflow references the entity
(§3.5), and a workflow that stopped referencing it keeps running from L1 unaffected. Its key is aligned
at the next start of a workflow that dropped it.
