# Spec: L2 projection, start-driven (final)

Status: design approved 2026-09-30, not implemented. Brainstormed in one session; every decision below
was confirmed by the user.

## 1. Principles

1. **The database is the only source of truth.** L2 (Redis) is a projection of it. **Only a workflow
   start aligns L2 — and only for the entities of the workflow being started.**
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
| `skp:wf:{id}` | HASH | `name`, `store` (flattened L1 structure), `roots` (cache root list) | start | never |
| `skp:wf:{id}:cache:{root}` | STRING | JSON key list | start | start, when the root is unbound |
| `skp:wf:{id}:cache:{root}:{key}` | STRING | one value | start | start, when the item or root is gone |
| `skp:step:{id}` | HASH | `name` | start (each step of the workflow) | never (steps are shared) |
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
  1. Write the workflow's keys (overwrite): `skp:wf:{id}` (`name`, `store`, `roots`), its cache rows,
     `skp:step:{id}` `name` for each of its steps.
  2. Delete its own leftovers only: cache roots no longer bound (via the previous `roots`) and cache
     items removed (via each root's previous key list). Never step keys, never other workflows' keys.
  3. `SADD skp:live {id}`.
  4. Publish `OrchestrationStarted(workflowId)` (id only), only after the writes.
  A failed publish requeues; steps 1–4 are idempotent.

### 3.3 Stop
- **HTTP:** enqueue; a send failure returns 500.
- **Consumer:** `SREM skp:live {id}`, **then** publish `OrchestrationStopped(workflowId)`. No cleanup.
  A failed publish requeues; both steps are idempotent.

### 3.4 Removed from BaseApi
- L2 work on entity create/update/delete and at BaseApi startup.
- `L2Cleanup` on stop.
- Processor names in `ToDefinition` / `Names`.

## 4. Orchestrator

- **Start announcement:** if the id is not in `skp:live`, do nothing. Otherwise read `skp:wf:{id}`
  `store` → build the L1 entry (**overwrite**), preload workflow/step/processor names into the name
  dictionary, schedule if `Cron` is set.
- **Startup (hydration):** `SMEMBERS skp:live` → the same `ActivateAsync` per id.
- **Stop announcement:** guard is `SISMEMBER skp:live` (was: root key exists). Still live → ignore
  (a later start overtook it). Otherwise unschedule and mark the L1 entry stopped. No L2 or L1 cleanup.
- **Runtime:** `WorkflowL1Store` and the name dictionary only; L2 only for `skp:data:*`.
- **Stopped entries stay in L1** — `L1ReapService` is removed; in-flight outcomes resolve through the
  stopped entry until the workflow is restarted or the pod restarts.

## 5. Processor

- Every heartbeat: `name` on `skp:proc:{id}` (from `ProcessorIdentity`), `SADD` to
  `skp:proc:{id}:instances`, the liveness key — all with the TTL.
- Workflow/step names load lazily into L1 via `EntityNameResolver`, cached until pod restart.
- SKNormalizer reads `skp:wf:{id}:cache:{root}[:{key}]` per lookup (values change only at start).

## 6. Accepted behaviour

- Redis is ephemeral; a Redis restart wipes everything until each workflow is started again.
- Keys of deleted workflows and steps persist forever; nobody reads them.
- A failed start consumer is repaired only by the next start of that workflow.
- A rename is visible for workflow/step names at the workflow's next start; for a processor at pod
  restart.
- A processor whose instances are all down longer than the TTL loses its name key; an orchestrator
  restarting meanwhile logs the id suffix until an instance returns.
- Restarting a workflow overwrites its L1 entry; lineages still in flight resolve against the new
  definition.
- An orchestrator restart loses a stopped workflow's in-flight lineages (hydration reads only
  `skp:live`).

## 7. Deferred

- Deleting an entity that a running workflow references.
