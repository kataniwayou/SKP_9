# Design: entity names on log records, resolved from L2

Date: 2026-09-29
Status: spec reviewed against the code 2026-09-29 and amended; awaiting user review

## Goal

Remove BaseApi's coupling to Elasticsearch -- the Lookup feature, the enrich policy, the
`logs@custom` ingest pipeline, and the `Elasticsearch` address in appsettings -- and have the
orchestrator and the processors stamp entity names on their own log records, resolved from L2 once
and held in memory.

## Current state (confirmed)

- `OrchestrationService.StartAsync` (`src/BaseApi.Service/Features/Orchestration/OrchestrationService.cs:144`)
  calls `_lookup.PublishAsync(LookupRowExtractor.From(snapshot))` after the validation gates and
  before `StartOrchestration` is sent. It bulk-writes one row per workflow, step and processor
  (`id`, `name`, `version`, `kind`) to the `skp-entity-lookup` index and executes the enrich policy.
  A publish failure refuses the start.
- `LookupProvisioningService` creates the index, the enrich policy and the `logs@custom` pipeline at
  boot.
- The pipeline builds `attributes.WorkflowName`, `StepName` and `ProcessorName` as `{name}_{version}`,
  falls back to the raw GUID on a miss, and builds `WhitelistOwner` as `{StepName} · {WhitelistRoot}`
  (stored double-encoded as `Â·`).
- The coupling lives in `appsettings.json` (`Elasticsearch` section) and in
  `k8s/30-baseapi-service.yaml:97` (`Elasticsearch__BaseUrl`).

## Decisions

| #  | Decision |
|----|----------|
| D1 | **Name format:** `{name}_{version}-{last two GUID groups}`, e.g. `analyst-monitor_1.0.0-9aff-a7f22ee09224` for id `208cba76-d635-4721-9aff-a7f22ee09224`. The 64-bit suffix makes each name unique by itself; no `(name, version)` database constraint is needed. |
| D2 | **Fallback:** the suffix alone, e.g. `9aff-a7f22ee09224`. It has no `_` or version, so unresolved records are easy to filter, and `*9aff-a7f22ee09224` matches both forms of one entity. |
| D3 | **Separate resolution:** `WorkflowId`, `StepId` and `ProcessorId` are each resolved from L2 on their own, and none depends on another id being present. `ProcessorId` also goes through L2, even inside the processor it identifies. |
| D4 | **Dispatch messages stay ids-only:** no name travels next to its id in `ProcessDispatch`, `ProcessedData` or `NextStepHandoff`. |
| D5 | **Only the orchestrator and the processors add names.** BaseApi's logging code is unchanged: no name attributes, no L2 reads, no DB lookups for names. |
| D6 | **Location:** `BaseConsole.Core`, the only project both `Orchestrator` and `BaseProcessor.Core` reference, and which BaseApi does not. |
| D7 | **`WhitelistOwner` is dropped.** Whitelist records already carry `WhitelistRoot`, `WhitelistValue` and `WhitelistVerdict` plus every id (verified on over 10,000 live records: none missing `WorkflowId`, `StepId` or `ProcessorId`) and, after this change, every name. |
| D8 | **Name keys are written on every start and never deleted.** Stop does not clean them up. |

## Components

### 1. Shared formatter -- `Messaging.Contracts`

- `Format(name, version, id)` returns the full name; `Fallback(id)` returns the suffix.
- It is the only place the format rule exists. The fallback therefore cannot drift from the suffix
  of a full name.

### 2. Source of names -- BaseApi (`BaseApi.Service`)

- `OrchestrationService.ToDefinition` builds the formatted names from the snapshot it has already
  loaded: the workflow, every step and every processor.
- **The name map.** `StartOrchestrationHandler` writes L2 asynchronously and has only the
  `StartOrchestration` message (`WorkflowL1`), which carries ids only. The names exist only in the
  snapshot on the request side, so they travel in the message as one flat map on `WorkflowL1`:

  ```
  StartOrchestration
   └ WorkflowL1
      ├ WorkflowId, EntryStepIds, Cron, Steps[], Caches[]   (unchanged)
      └ Names: { "<workflowId>":  "analyst-monitor_1.0.0-9aff-a7f22ee09224",
                 "<stepId>":      "sk-normalizer-sample_1.0.0-…",
                 "<processorId>": "sk-normalizer_1.0.0-…" }
  ```

  It covers the workflow, every step and every processor in the snapshot, each id once (a processor
  used by several steps appears once). `StartOrchestration` is a control message consumed by BaseApi,
  not a dispatch message, so D4 holds.
- **`Names` is optional and defaults to empty.** A `StartOrchestration` published before this change
  (a message still queued across the rollout) deserializes with no map, the projection is written
  without names, and the workflow starts; its records log the D2 suffix until its next start.
- **Alternatives rejected:**
  - Name fields on `WorkflowL1` / `StepL1` would put ids and names side by side and repeat a shared
    processor's name on every step.
  - The handler reading the DB itself would be a second, racy source: an edit between the request
    and the handler would project names for a state the gates never approved.
- `L2ProjectionWriter` writes `skp:name:{id}` -> name for every map entry, in the same `CreateBatch`
  as the root and step keys. **A batch is pipelined, not a MULTI transaction.** The names are written
  with the projection, and if a write fails, the message is redelivered and the whole clean-then-write
  runs again, as the writer's own contract already describes.
- **The root key does not store the map.** The root holds `WorkflowRootProjection` (entry step ids,
  step ids, cron, liveness, cache roots), not `WorkflowL1`. The flat `skp:name:*` keys are the single
  store of names.
- Removed: the Lookup feature (`ElasticLookupPublisher`, `IEntityLookupPublisher`,
  `LookupProvisioningService`, `LookupRowExtractor`, `LookupRow`, `ElasticLookupOptions`,
  `LookupServiceCollectionExtensions`), its DI wiring (`OrchestrationServiceCollectionExtensions.cs:49`),
  its tests (`src/tests/BaseApi.Tests/Lookup/ElasticLookupPublisherTests.cs`, `LookupRowExtractorTests.cs`,
  `StartPublishesLookupBeforeSendTests.cs`), the `Elasticsearch` appsettings section, and
  `Elasticsearch__BaseUrl` in `k8s/30-baseapi-service.yaml`. The "names before start" ordering and
  the rule that an ES failure refuses the start go with it. The Analyst's own Elasticsearch client
  (`ElasticPanelSource`, `PanelSourceOptions`) is separate and unaffected.

### 3. L2 key

- `skp:name:{id}` is a plain Redis String, in its own namespace following the precedent of
  `skp:data:` and `skp:proc:`. It is added to `L2ProjectionKeys`.
- **Verified safe with the orphan sweeper.** `RedisL2InstanceIndexStore.ListIndexKeysAsync` scans
  only `skp:proc:*` and then keeps only Set-type keys, so a name key fails both filters. Every other
  reader (`L2WorkflowReader`, `L2ProjectionWriter`, `L2Cleanup`, the dispatch handlers,
  `ProcessorLivenessWriter`) uses exact keys or the `skp:` parent-index set. No production code
  scans `skp:*`.
- **Keys to avoid:** `skp:{id}` has the same shape as a workflow root and would pollute any
  running-set read of `skp:*`. `skp:proc:{id}:name` sits inside the sweeper's scan pattern.
- **No cleanup on stop.** `L2Cleanup` deletes only exact keys built from the root. Processors and
  steps are shared across workflows, and records from a run keep arriving after its stop. The cost is
  one short string per entity ever started. A deleted entity's key remains in Redis permanently,
  which does no harm.

### 4. Resolver -- `BaseConsole.Core`

- It keeps names in a `ConcurrentDictionary<Guid, string>`.
- On a miss it does one MGET of `skp:name:{id}` for every id on the record.
- **It reads through a small read-only name-source interface**, not through Redis directly.
  - In the orchestrator, `L2WorkflowReader` implements it. That keeps the reader's core invariant
    (`L2WorkflowReader.cs:10-18`: the orchestrator's only Redis access, read-only). The MGET is the
    `StringGetAsync(RedisKey[])` overload, which is **not used anywhere today** (the reader calls only
    the single-key form, `:73`, `:94`). It is a new read in the same operation family, so the
    invariant comment's "three operations" is updated deliberately to name it as the fourth.
  - In processors, a plain Redis implementation.
- **Name reads are fault-isolated.** A Redis fault in `L2WorkflowReader`'s projection reads propagates
  on purpose, to requeue the message and trip the gate (spec §7.4). A name read must never do either:
  it catches its own fault and returns the D2 fallback, separately from the projection reads.
- A missing key or an unreachable Redis produces the D2 fallback. Misses are **not cached**, and a
  lookup failure never fails a step or a delivery, requeues a message, or trips a gate.
- Resolved names are cached with no expiry.
- **Accepted limit:** after an entity is renamed and its workflow restarted, a processor that already
  cached the old name keeps logging it until its pod restarts, because only orchestrator replicas are
  bound to the fanout exchange. If that proves misleading, the remedy is a cache expiry, with no
  message change.

### 5. Where the resolver is called

- **At the delivery, in `BaseConsole.Core/Messaging/GatedQueueConsumer.cs`.** It reads the ids from
  the message headers (`MessageIdHeaders.ReadScope`), resolves the names, and opens a names scope
  **at the level that encloses both the `try` around `HandleAsync` and its `catch`**. Log scopes
  carry into everything the handler calls, so every record inside it inherits the names: the
  handlers' own id scopes, `ProcessDispatchHandler` -> `ExecuteAsync` -> processor code (including
  `RedisFieldWhitelist.Record`), and the park line. No log call site changes, and neither does
  `ExecutionLogScope`.
  - **Why not a scope wrapping only the call.** `HandleAsync` runs inside a `try`
    (`GatedQueueConsumer.cs:346-368`) and the park line (`RefusalTemplates.Parked`) is logged in the
    `catch` (`:434-439`), after the unwinding exception has disposed any scope opened inside the `try`.
    That is why the park line already re-reads its ids from the headers (`:427-433`). A names scope
    opened as `using (…) { await HandleAsync(…); }` would be gone by then too.
- **Every orchestrator delivery carries its ids in headers.** `QueueSender.BuildProperties` calls
  `MessageIdHeaders.Stamp` on every publish (`QueueSender.cs:164`), and `QueueFanoutPublisher` uses
  the same `BuildProperties` (`QueueFanoutPublisher.cs:55`):

  | Message | Consumer | Ids in headers |
  |---------|----------|----------------|
  | `StartOrchestration` / `StopOrchestration` | BaseApi | out of scope (D5) |
  | `OrchestrationStarted` / `OrchestrationStopped` (fanout) | orchestrator | `x-skp-workflow-id` (`IWorkflowScopedMessage`) |
  | `StepOutcome`, `NextStepHandoff` | orchestrator | workflow, execution, step, processor, entry (`IExecutionMessage`) |

- **One helper opens the names scope.** It lives in `BaseConsole.Core`, takes the ids, and is used by
  the consumer and by every site outside a delivery.
- **Orchestrator cache fill:** `L2WorkflowReader` fetches the workflow's names with one MGET when it
  loads the workflow.
- **Orchestrator log sites outside a delivery** call the helper explicitly:
  - `HydrationService.cs:205` -> `WorkflowActivator`: boot activation of every workflow in the parent
    index ("activated workflow {WorkflowId}", "L2 does not hold workflow…"). The helper is opened
    per workflow in the hydration loop.
  - `WorkflowFireJob` (lines 90, 257): the cron fire.
  - `WorkflowScheduler.cs:131`: "cron … yields no future fire time".
  - `L1ReapService.cs:159-164`: the periodic reap line, "reaped {ReapedCount} workflow(s)…
    {WorkflowIds}". It names **several** workflows in one record, so a per-workflow scope does not fit.
    It resolves each id through the resolver and adds the names to the record as a
    `{WorkflowNames}` list beside `{WorkflowIds}`. The names keys outlive a stop (D8), so a reaped
    workflow still resolves.
- **Processor startup and liveness records** carry only `ProcessorId`. They resolve through
  `skp:name:{processorId}` and log the suffix until some workflow that uses the processor has been
  started.

## Observability changes

- **ES teardown, on every stack BaseApi has booted against: dev (8.15.5) and the offline
  air-gapped stack (9.3.4).** Delete, in this order, the `logs@custom` pipeline, the
  `skp-entity-lookup` enrich policy (it cannot be deleted while a pipeline references it), and the
  `skp-entity-lookup` index. This is mandatory: while the pipeline exists, an enrich match overwrites
  the name the code set with the old `name_version` format. The three `DELETE` calls ship with the
  offline delta (`ship/`, via `tools/ship-delta.ps1`) as a runbook step, because the offline machine
  has no access to this repo's dev forwards.
- **Kibana (`kibana/kibana-export.ndjson`):**
  - `skp-whitelist-pies` ("Whitelist verdicts by value"): replace the `terms` split on
    `attributes.WhitelistOwner` with a `multi_terms` split on `attributes.StepName` +
    `attributes.WhitelistRoot`, keeping one pie per pair.
  - **The pinned literal becomes per-environment (decided 2026-09-29).** The new format's suffix
    differs per stack, because the offline machine re-creates its rows. `tools/offline/pin-workflow-control.py`
    rewrites the pin from that stack's `skp:name:*` before import: on dev (then committed) and on the
    offline machine (shipped via `tools/offline/`, alongside `kibana/`). The board keeps opening on one
    workflow everywhere. The literal `filefetcher-archiveexpander-chain_1.0.0`, formerly pinned verbatim, lives
    in `skp-operator-outcomes`' options-list control (`fieldName: attributes.WorkflowName`), not in
    the whitelist pies. The same literal in `docs/rebuild-filefetcher-archiveexpander-chain.md` is
    left alone: that file holds frozen registered schema and workflow bodies.
- **`tools/verify-kibana-dashboard.py`:**
  - Update `WHITELIST_SPLIT_FIELD` and the owners aggregation (lines 148, 624, 636). The ~19
    asserted `name_version` literals stay as they are: resolved names are compared on their base
    (the suffix stripped), so the script works on any stack. Literals with suffixes would pass on
    dev alone.
  - **Replace its name source.** `load_names()` reads the `skp-entity-lookup` index with `_search`,
    which the teardown deletes. It reads the `skp:name:*` keys from Redis through the supervised
    port-forward instead (SCAN `skp:name:*`, then MGET), since those keys are now the single store of
    names. A tool scanning that pattern does not break the sweeper claim in component 3, which is
    about production code.
  - Its docstring still describes a retired data-view formatter mechanism (`KibanaLookupPublisher`,
    `static_lookup`); the data view's `fieldFormatMap` is empty. Rewrite those passages to say the
    names are fields the processes set themselves.
- **`kibana/README.md:76`:** remove the description of the pipeline-built `WhitelistOwner`.
- **Mixed-format period:** until retention expires them, older records carry `name_version` and the
  garbled `WhitelistOwner`. Panels grouping on the name fields show two buckets per entity during
  that window. The new whitelist panel does not read `WhitelistOwner`.
- **BaseApi's records** lose the `WorkflowName` the pipeline adds today and carry ids only.

## Failure behaviour

| Situation | Result |
|-----------|--------|
| Name key missing (a dispatch in flight after a stop, Redis wiped) | suffix; not cached; the next start rewrites the key |
| Redis unavailable | suffix; the step runs normally |
| Entity renamed and its workflow restarted | orchestrator correct; cached processors show the old name until their pod restarts (accepted) |
| Elasticsearch down | no effect on starts or on the names |

## Resolved items

1. **Id headers on control messages.** Every message the orchestrator consumes is stamped with its ids
   on publish, fanout included. See component 5.
2. **The name map.** A flat id-to-name map on `WorkflowL1`, written to `skp:name:{id}`, and not stored
   in the root. See component 2.

## Testing

- Formatter: full name, fallback, and the suffix matching between them.
- Resolver: hit; miss not cached; Redis failure returns the suffix without throwing; concurrent first
  lookups.
- Resolver: a name-source fault returns the suffix and does not propagate (no requeue, no gate trip).
- Consumer: a record inside `HandleAsync` carries all three names; **a park line, logged in the
  consumer's `catch` after the handler threw, carries them too**; a fanout `OrchestrationStarted`
  record carries `WorkflowName`; a post-handler record for a branch with no data (no `EntryId`)
  carries the names.
- Outside deliveries: hydration, cron fire and scheduler records carry the names; the reap line
  carries a `WorkflowNames` list matching its `WorkflowIds`.
- Contract: a `StartOrchestration` without `Names` deserializes and starts the workflow.
- Projection writer: every name-map entry is written as `skp:name:{id}`; stop leaves them in place;
  the root JSON is unchanged.
- `ToDefinition`: the map holds each id once, including a processor shared by several steps.
- Sweeper: remains blind to `skp:name:*`.
- Kibana verification script passes against the new split and literals, resolving names from Redis.
