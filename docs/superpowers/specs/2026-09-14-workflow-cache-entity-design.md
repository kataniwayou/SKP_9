# CacheEntity — a workflow-scoped dictionary projected into L2 for the run's lifetime

**Date:** 2026-09-14
**Status:** Designed, all decisions resolved. Not implemented.
**Introduces:** `src/BaseApi.Service/Features/Cache/` (seven files), `WorkflowCaches` +
`WorkflowCachesConfiguration`, `CacheEntityConfiguration`, one migration, two builders on
`L2ProjectionKeys`, one field on `WorkflowRootProjection`, one property on `SKNormalizerConfig`.
**Amends:** `AppDbContext`, `AppFeatures`, `WorkflowDtos`, `WorkflowDtoValidator`,
`WorkflowService` (both overrides), `WorkflowGraphLoader`, `WorkflowGraphSnapshot`,
`OrchestrationService.ToDefinition`, `WorkflowL1`, `L2ProjectionWriter`, `L2Cleanup`.
**Does NOT amend:** `BaseProcessor.Core`, `ProcessDispatchHandler`, `StepEntity`, `StepL1`,
`StepProjection`, any step payload, or any config schema row.

---

## 1. The decision

> **A workflow may reference any number of `CacheEntity` rows. Starting the workflow writes each
> one's dictionary into L2 under `skp:{workflowId}:cache:{root}`; stopping it deletes them. A
> processor reads a whitelist by being handed the full address in its step payload — it composes
> nothing and knows nothing about workflows.**

The cache is coupled to the **workflow**, not to the step and not to the processor. Every cache the
workflow names is projected on start regardless of whether any processor reads it, and every one is
removed on stop. Which processor uses which cache is not modelled in the database at all.

### 1.1 What this is NOT

**It is not a per-step binding.** An earlier shape put `CacheEntityId` on `StepEntity` and derived
the workflow's cache set by walking its steps. Rejected: the cache belongs to the workflow, and the
walk made the projected key set depend on graph reachability — a step temporarily unreachable would
silently drop its whitelist from L2.

**It is not injected.** Three intermediate designs had `OrchestrationService.ToDefinition` rewrite
step payloads to insert a resolved `cacheAddress`. Rejected (§8.1). The operator authors the full
address; nothing rewrites a payload.

**It is not a Redis hash.** A `HSET` at `skp:{workflowId}:cache:{root}` would be one key, one atomic
write, one `DEL`, and no key list to record anywhere. Rejected deliberately in favour of
human-readable flat keys that `GET` and `KEYS skp:{workflowId}:cache:*` render legibly (§8.2).

**It does not gate anything.** No new validator, and the locked gate order in
`OrchestrationService.StartAsync` is unchanged (§7.3).

**It is not yet used.** `SKNormalizerConfig` gains `CacheAddress` in this change and nothing reads
it (§6). The whitelist behaviour — look up `{CacheAddress}:{name}`, `CancelledException` on a miss —
is a separate, later change.

---

## 2. Why this exists

Some processors need to drop work that is not on an approved list: `SKNormalizer` should proceed
only when a document's name appears on a whitelist, and otherwise end its branch with a `Cancelled`
outcome rather than a failure. The list is operational data — it changes without a redeploy, it
differs per workflow, and it is read on the hot path by every replica of a processor for every
document.

That rules out the two obvious homes. It cannot live in the step payload: the payload is validated
against a frozen config schema, and a thousand-name list is not configuration. It cannot live in
Postgres: the processors do not talk to Postgres, by design — L2 is the only store on their side of
the boundary.

So it is authored in the API as a first-class entity, and projected into L2 with exactly the same
lifetime as the workflow graph it belongs to — written by the same handler, in the same batch,
removed by the same cleanup. A whitelist cannot outlive the run that needed it, and cannot be
missing while that run is live.

---

## 3. Data model

### 3.1 `CacheEntity`

`src/BaseApi.Service/Features/Cache/CacheEntity.cs`, `CacheEntity : BaseEntity`, sealed. Inherits
`Id`, `Name`, `Version`, `Description` and the four audit fields like every other domain entity.

| Property | Column | Rules |
|---|---|---|
| `Root` | `root`, `varchar(200)`, required | Non-empty, trimmed on assignment, must not contain `:`. Unique index `uq_cache_root`. |
| `Items` | `items`, `jsonb`, required | A flat JSON object whose every value is a string. Keys follow the same rules as `Root`. Max 1 MB. |

`Root` is trimmed on assignment, in the property setter, following
`ProcessorEntity.InstanceId` — the invariant goes on the data, where no write path can route around
it. It is **not** normalized to null when blank: unlike `InstanceId`, blank is not a meaningful state
here, so the validator refuses it and the column is `IsRequired()`.

**`Root` must be unique** because it is the operator's handle for a dictionary, and it appears
verbatim inside the L2 address. Two rows sharing a root would produce two dictionaries claiming one
address — and since a workflow may name both, the second write would overwrite the first with no
error at any layer.

**Neither `Root` nor any key may contain `:`.** The address is built by concatenation, so a colon
inside a root or key forges a different address: root `a` with key `b:c` and root `a:b` with key `c`
produce the same string. Refused at the validator, on both create and update.

**Constraint names follow the parsed convention.** `PostgresExceptionMapper.ExtractColumn` strips a
`{kind}_{owner}_` prefix using the *table* name, trying the exact name then its s-stripped singular —
so with `DbSet<CacheEntity> Caches` giving table `caches`, the index must be `uq_cache_root` for a
duplicate to report the column as `root`. `uq_cache_entity_root` would report `entity_root`. The
junction names itself exactly, so `fk_workflow_caches_cache_id` strips to `cache_id`. This is also
why the junction column is `CacheId` and the DTO collection `CacheIds` — `WorkflowAssignments` names
`AssignmentEntity` as `AssignmentId`, and the mapper depends on that convention holding.

**No outgoing foreign keys.** `CacheEntity` sits beside `SchemaEntity` as a second root of the
foreign-key graph: nothing it references, referenced only through the junction.

### 3.2 `WorkflowCaches`

`src/BaseApi.Service/Features/Workflow/WorkflowCaches.cs` — `{ Guid WorkflowId, Guid CacheId }`,
sealed, **not** a `BaseEntity`, which is what keeps it out of the `xmin` shadow-token loop in
`BaseDbContext.OnModelCreating`. A straight copy of `WorkflowAssignments`.

`WorkflowCachesConfiguration` mirrors `WorkflowAssignmentsConfiguration` exactly: composite key
`(WorkflowId, CacheId)`; `fk_workflow_caches_workflow_id` cascading, so deleting a workflow
removes its junction rows; `fk_workflow_caches_cache_id` restricting, so deleting a cache a
workflow still names raises SQLSTATE 23001 and becomes a 422.

As everywhere else in this codebase, **there are no navigation properties**. The collection lives on
the DTOs and is kept in step by `WorkflowService.SyncJunctionsAsync`.

### 3.3 Migration

`AddCacheEntity` — additive only:

- `CREATE TABLE caches` with the `BaseEntity` columns, `root`, `items jsonb`, and the `xmin`
  shadow token the base context stamps.
- `CREATE UNIQUE INDEX uq_cache_root ON caches (root)`.
- `CREATE TABLE workflow_caches` with its composite key and two foreign keys.

No existing table is altered, no column is added to an existing row, and there is no backfill. A
deployment that applies this migration and changes nothing else behaves identically to today.

---

## 4. API surface

`Features/Cache/` is modelled on `Features/Assignment/`, which is the closest existing feature:
a `BaseEntity` whose substance is one required `jsonb` column, with a service that overrides
nothing. Schema is a closer structural match at the entity level but drags in `JsonSchemaConfig`,
`Responders/`, a frozen-definition exception and its handler, and a 132-line service — none of which
applies here.

| New file | Modelled on | Delta |
|---|---|---|
| `CacheEntity.cs` | `AssignmentEntity.cs` | no `StepId`; `Items` for `Payload`; add `Root` |
| `CacheDtos.cs` | `AssignmentDtos.cs` | `Root` + `Items` in place of `StepId` + `Payload` |
| `CacheDtoValidator.cs` | `AssignmentDtoValidator.cs` | keeps the `Cascade(Stop)` → `MaximumLength` → `JsonDocument.Parse` idiom for `Items`; adds the object-of-strings walk and the `Root` rules |
| `CacheEntityMapper.cs` | `AssignmentEntityMapper.cs` | field swap; same five `MapperIgnoreTarget` attributes |
| `CacheService.cs` | `AssignmentService.cs` | rename only — **no overrides** |
| `CacheController.cs` | `AssignmentController.cs` | rename only — the same eight-line `BaseController` shell every feature has |
| `CacheServiceCollectionExtensions.cs` | `AssignmentServiceCollectionExtensions.cs` | rename only |

`CacheEntityConfiguration` takes its `jsonb` line from `SchemaEntityConfiguration` (the minimal
four-line form) and its named unique index and `HasMaxLength` from `ProcessorEntityConfiguration`,
which is the only precedent for a required scalar carrying a named unique index.

Registration: `DbSet<CacheEntity> Caches` and `DbSet<WorkflowCaches> WorkflowCaches` on
`AppDbContext`; `services.AddCacheFeature()` in `AppFeatures.AddAppFeatures`, placed after
`AddSchemaFeature()` and before `AddProcessorFeature()` — both are FK-graph roots, and the list reads
root-first.

### 4.1 Workflow DTOs

`WorkflowCreateDto`, `WorkflowUpdateDto` and `WorkflowReadDto` each gain
`List<Guid>? CacheIds`, positioned immediately after `AssignmentIds`. Optional and nullable,
exactly like `AssignmentIds` — an existing client that omits it is unaffected.

`WorkflowDtoValidator` gains the same rule `AssignmentIds` has: when present, no element may be
`Guid.Empty`.

`WorkflowService.SyncJunctionsAsync` gains a third block, identical in shape to the assignment
block: clear on update, insert when present and non-empty. `EnrichReadAsync` gains a third lookup and
a third line in its `with` expression.

`WorkflowGraphLoader` stage 1 gains a third junction read alongside `WorkflowEntrySteps` and
`WorkflowAssignments`; stage 3 batches the referenced `CacheEntity` rows alongside processors,
schemas and assignments. `WorkflowGraphSnapshot` gains
`Dictionary<Guid, CacheReadDto> Caches`, cleared in `Dispose` with the rest.

---

## 5. Projection

### 5.1 Keys

Two builders on `Messaging.Contracts.Projections.L2ProjectionKeys`:

```
Cache(workflowId, root)           => "skp:{workflowId:D}:cache:{root}"
CacheEntry(workflowId, root, key) => "skp:{workflowId:D}:cache:{root}:{key}"
```

**This is a new key shape, and the XML doc should say so.** Every literal discriminator in the
existing scheme sits immediately after the prefix — `skp:proc:…`, `skp:data:…`. These are the first
to place one *after* the workflow id. It cannot collide with the step key `skp:{wf}:{stepId}`,
because `cache` is not a GUID, and keeping a workflow's keys contiguous under one scan prefix is
worth more here than symmetry with `proc:` and `data:`.

`{root}` and `{key}` are interpolated verbatim. They are safe to interpolate because §3.1 refuses a
colon in either, at the only layer that can write one.

### 5.2 Write

`L2ProjectionWriter.WriteAsync` takes the caches from `WorkflowL1` and adds to its **existing
batch**, alongside the root, the parent-index member and the step keys:

- one `StringSet` at `Cache(workflowId, root)` holding the JSON array of that dictionary's keys;
- one `StringSet` at `CacheEntry(workflowId, root, key)` per pair, value written verbatim.

Same batch, for the same reason the step keys are in it: a failure leaves either the whole
projection or none of it, never a graph whose whitelists are half-written. **No TTL, ever** —
reclaim is explicit on stop, matching every other L2 key.

Caches are deduplicated by cache id before writing. The junction cannot hold a duplicate (composite
primary key), but the writer should not depend on a constraint two layers away.

### 5.3 The record, and where it lives

`WorkflowRootProjection` gains `[property: JsonPropertyName("cacheRoots")] List<string>? CacheRoots`.
It records **only the roots**. Each root key records its own key list.

This is the one place the design splits the record across two levels, so the reasoning matters. The
file's doctrine is that the root records every key it wrote, because "a walk that meets an
already-missing step key cannot follow its successors, so it strands every step beyond that point."
That argument is about *reachability* — a step key names the next step. A cache root names nothing;
its key list is a flat leaf. So recording the key list at the root key costs one extra `GET` per
cache at stop and buys the property that made the flat-key choice worth making: an operator who
reads `skp:{wf}:cache:{root}` sees the dictionary's contents listed, in one key, by name.

The roots themselves must still be in `WorkflowRootProjection`, because nothing else tells cleanup
which roots exist for a workflow. Discovering them with `KEYS`/`SCAN` is the walk this codebase
refuses everywhere else.

A root written before this change deserializes `cacheRoots` as null and is read as empty — so an
in-flight workflow projected by the old writer is cleaned up correctly by the new cleanup.

### 5.4 Cleanup

`L2Cleanup.RemoveAsync`, after deserializing the root and before building its batch: for each entry
in `CacheRoots`, `GET` the cache root key, parse its key list, and add to the **existing delete
batch** one `KeyDelete` per `CacheEntry` plus one for the cache root itself.

A cache root key that is already absent contributes nothing and is not an error — same rule as an
absent workflow root. That is what keeps a redelivered stop, a repeated stop, and a stop for
something never started all quiet successes.

### 5.5 Wire contract

`WorkflowL1` gains `List<CacheL1> Caches`, and `CacheL1` is
`(string Root, Dictionary<string, string> Items)`.

`OrchestrationService.ToDefinition` populates it from `snapshot.Caches`, deserializing each
`Items` document into the dictionary as it flattens. This is the same work it already does for the
assignment payload: resolve a junction here, while both sides are in hand, so the consumer never
learns the junction exists.

`StepL1` and `StepProjection` are **unchanged**. No step payload is read, rewritten or inspected by
any part of this design.

---

## 6. The processor change

`SKNormalizerConfig` becomes:

```csharp
public sealed record SKNormalizerConfig(string Handler, string? CacheAddress = null) : ProcessorConfig;
```

That is the entire processor-side change. `SKNormalizerProcessor` does not read it, no Redis call is
added, and no whitelist behaviour ships in this change.

**Why add a property nothing uses.** It is the seam, and adding it now is free while adding it later
is not. `ProcessorConfig.SerializerOptions` sets only `PropertyNameCaseInsensitive`, leaving
`UnmappedMemberHandling` at its default of Skip — so a payload carrying `cacheAddress` today would
be silently discarded, and one carrying it after this change binds. Declaring it now means the
behaviour change later is a handler edit, not a contract edit.

**The cost, and when it actually lands.** Every config schema in the live chain sets
`"additionalProperties": false`, SKNormalizer's included — `required: ["handler"]`, nothing else
permitted (`docs/rebuild-filefetcher-archiveexpander-chain.md:203`). `ConfigSchemaConformance.Check`
compares the *shape of the config record* against that definition — not against any payload — and it
runs in `SKNormalizerConfigSchemaTests`, and in `ProcessorStartupOrchestrator` at startup against the
live schema row. So the cost arrives with `CacheAddress` itself, in this change, not later when the
whitelist behaviour ships: the in-repo fixture
(`src/tests/BaseApi.Tests/Schemas/sknormalizer-config.json`) is updated here to declare
`cacheAddress` alongside `handler`, and the live schema row must be replaced — POSTing a new row,
re-pointing both sides, and restarting, since definitions are frozen — before a build carrying the
property is deployed, or the replica fails startup conformance and publishes UNHEALTHY. Because
three schema rows serve five processors, re-pointing one can disturb an unrelated published
workflow.

`BaseProcessor.Core`, `ProcessDispatchHandler`, `BaseProcessorOfT` and the other nine processors are
untouched.

---

## 7. Failure modes

### 7.1 A workflow names a cache that does not exist

Impossible. `fk_workflow_caches_cache_id` refuses it at insert, and the 23503 path already
maps to a 4xx.

### 7.2 A payload names an address for a cache the workflow does not have

Not detectable at start — the API never reads addresses out of payloads, by design. When the
behaviour ships, the processor's lookups all miss and every document cancels, which is
indistinguishable from an empty whitelist.

This is the accepted cost of removing injection, and the mitigation belongs with the behaviour, not
here: the processor treats a **null** `CacheAddress` as a payload defect (`FailedException`, loud on
the first document) rather than a cache miss, so the common mistake — forgetting the address
entirely — is loud. A *wrong* address stays silent. Nothing in this change can observe it, and
nothing in this change creates it.

### 7.3 Gate order

`OrchestrationService.StartAsync`'s locked order — existence, cycle, schema edge, payload-config
schema, processor liveness — is **unchanged**. No gate is added. There is nothing left to check: the
foreign key guarantees every named cache exists, and no other cache invariant is knowable from the
workflow alone.

### 7.4 An empty `Items`

Legitimate. `{}` writes a cache root holding an empty key list and no entries, and means "allow
nothing" once the behaviour ships. Refusing it would refuse a valid intent, so the validator permits
`{}` while still requiring the column to be present.

### 7.5 A large dictionary

`Items` is capped at 1 MB by the validator, following `AssignmentEntity.Payload`. A workflow naming
several caches near that cap produces a correspondingly large single Redis batch on start. Accepted
for now; whitelists in practice are small. If it becomes a problem the fix is chunking the batch,
not a TTL.

---

## 8. Alternatives rejected

### 8.1 Injecting the address into step payloads

Three intermediate designs had `ToDefinition` parse each step payload, insert
`cacheAddress = skp:{workflowId}:cache:{root}`, and re-serialize — running after all five gates, so
`additionalProperties: false` never saw it and no schema row had to change.

It was attractive precisely because it made the address unforgeable: the operator could not
hand-write a workflow id, and an assignment reused by a second workflow could not carry the first
one's id. It died on the coupling. With the cache owned by the workflow and not by the step, nothing
in the data says *which* of N addresses a given step should receive, so injection degenerates into
either writing all of them into every payload (and requiring the processor to pick by a root it
names elsewhere) or reintroducing a per-step binding. Both are more machinery than handing the
operator a string to paste.

The cost carried forward is §7.2: a hand-written address can be wrong, and nothing will say so.

### 8.2 A Redis hash per cache

`HSET skp:{workflowId}:cache:{root}` with fields as keys collapses the whole storage question: one
key per cache instead of one per entry, one atomic write, one `DEL` on stop, no key list recorded
anywhere, and the orphan problem cannot exist because there are no children to strand. The
processor's ergonomics would be identical — the payload still carries one address, and the lookup
becomes `HGET address name` instead of `GET address:name`.

Rejected on a stated requirement: the keys must be human-readable and individually inspectable.
`GET skp:{wf}:cache:{root}:acme` answering directly, and `KEYS skp:{wf}:cache:*` listing a
workflow's whitelists by name, is worth the extra keys and the key list. §5.3 is the cost of that
choice.

### 8.3 `StepEntity.CacheEntityId`

A nullable FK on the step, with the workflow's cache set derived from the steps the loader already
walks. It needed no junction, no new gate, and no schema-row churn. Rejected: the cache belongs to
the workflow. The derivation was also fragile — the projected key set would have depended on graph
reachability rather than on what the operator declared.

---

## 9. Testing

**Entity and API**, mirroring `AssignmentService`'s tests: create/read/update/delete round-trip; a
blank `Root` is a 400; a `Root` containing `:` is a 400; a duplicate `Root` is a 409 through the
existing unique-violation mapper; `Items` that is not JSON is a 400; `Items` that is an array, or an
object with a non-string value, is a 400; `Items` over the cap is a 400; `{}` is accepted.

**Junction**, mirroring the `WorkflowAssignments` tests: create with `CacheIds` and read them
back; update replaces rather than appends; deleting a referenced cache is a 422; deleting the
workflow removes the junction rows.

**Projection**, against the existing `L2ProjectionWriter`/`L2Cleanup` suites: a workflow with two
caches writes both roots and every entry in one batch; the root records both roots; cleanup removes
every entry, both cache roots and the workflow root; a second cleanup is a quiet no-op; a root JSON
with no `cacheRoots` field cleans up the graph without throwing; a cache root key deleted out from
under cleanup does not prevent the rest of the removal.

**Round-trip**, through `WorkflowGraphLoader` → `ToDefinition`: a workflow's caches reach `WorkflowL1`
with their dictionaries intact, and a workflow with no caches produces an empty list and a
byte-identical projection to today.

`SKNormalizerConfig` gets one test: a payload carrying `cacheAddress` binds it, and a payload
omitting it leaves it null.

---

## 10. File manifest

**New**

```
src/BaseApi.Service/Features/Cache/CacheEntity.cs
src/BaseApi.Service/Features/Cache/CacheDtos.cs
src/BaseApi.Service/Features/Cache/CacheDtoValidator.cs
src/BaseApi.Service/Features/Cache/CacheEntityMapper.cs
src/BaseApi.Service/Features/Cache/CacheService.cs
src/BaseApi.Service/Features/Cache/CacheController.cs
src/BaseApi.Service/Features/Cache/CacheServiceCollectionExtensions.cs
src/BaseApi.Service/Features/Workflow/WorkflowCaches.cs
src/BaseApi.Service/Persistence/Configurations/CacheEntityConfiguration.cs
src/BaseApi.Service/Persistence/Configurations/WorkflowCachesConfiguration.cs
src/BaseApi.Service/Persistence/Migrations/<stamp>_AddCacheEntity.cs
```

**Amended**

```
src/BaseApi.Service/AppDbContext.cs                              two DbSets
src/BaseApi.Service/Composition/AppFeatures.cs                   one registration
src/BaseApi.Service/Features/Workflow/WorkflowDtos.cs            CacheIds ×3
src/BaseApi.Service/Features/Workflow/WorkflowDtoValidator.cs    one rule ×2
src/BaseApi.Service/Features/Workflow/WorkflowService.cs         both overrides
src/BaseApi.Service/Features/Orchestration/Loading/WorkflowGraphLoader.cs
src/BaseApi.Service/Features/Orchestration/WorkflowGraphSnapshot.cs
src/BaseApi.Service/Features/Orchestration/OrchestrationService.cs   ToDefinition only
src/BaseApi.Service/Features/Orchestration/Projection/L2ProjectionWriter.cs
src/BaseApi.Service/Features/Orchestration/Projection/L2Cleanup.cs
src/Messaging.Contracts/WorkflowL1.cs                            Caches + CacheL1
src/Messaging.Contracts/Projections/L2ProjectionKeys.cs          two builders
src/Messaging.Contracts/Projections/WorkflowRootProjection.cs    cacheRoots
src/Processor.SKNormalizer/SKNormalizerConfig.cs                 one property
```
