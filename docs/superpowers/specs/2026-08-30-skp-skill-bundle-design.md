# The SKP skill bundle: compiling this system for a small offline model

Date: 2026-08-30
Status: approved, not yet implemented
Scope: new `skp-toolkit/` package, new `.claude/skills/skp*`, read-only against `src/`
Depends on: the deployed system (platform deployment is out of scope)

## 1. Why

The system ships to an offline machine running Claude Code with a **small model
and a small context window**. That model must operate and extend the system
accurately: an operator builds and monitors workflows, a developer builds
concrete processors.

A strong model is available **here**, once, with the whole codebase in context
and a live cluster to verify against. The design goal follows from that
asymmetry: **spend expensive reasoning now to produce an artifact that requires
cheap reasoning later.** Every judgment made at authoring time is a judgment the
offline model never has to make correctly.

## 2. The principle: lookup, not recall

The failure mode is not stupidity, it is **confabulation**. A small model that
does not know the orchestrator's result queue emits `orchestrator-results` --
plausible, wrong, and delivered in the same tone as a correct answer. Recall
gaps become silent wrong actions.

So: **never require the model to remember anything.**

| What would be recalled | Where it goes instead |
| --- | --- |
| Queue names, key formats, gate order, field shapes | the generated **catalog** |
| The workflow id from four turns ago, the last built hash | the **memory folder** |
| "Is this graph legal", "did this run succeed", "is this pod's unreadiness expected" | the **verbs** |
| "What do I do next" | the `NEXT:` breadcrumb printed by the previous verb |

Selection degrades gracefully with model size. Synthesis does not. The offline
model only selects.

The property that makes it hold: **lookup makes ignorance detectable.** A missing
catalog entry is an error the model reports. A recall gap is invisible -- nothing
distinguishes a remembered fact from an invented one. This is also why the
catalog is *generated* rather than hand-written: a hand-written catalog is recall
with extra steps, and fails the same silent way when the C# moves.

## 3. The system being compiled (substrate, unchanged by this work)

**Authoring plane** -- `BaseApi.Service`, `/api/v1.0/...`. Five CRUD entities
(`schemas`, `processors`, `steps`, `assignments`, `workflows`) plus
`POST /orchestration/{start,stop}`, which validate synchronously in a locked gate
order (existence, cycle, schema edge, payload-vs-config-schema, processor
liveness) and return `202` once the projection write is queued.

**Runtime plane** -- the orchestrator (leader-elected, L1 in memory mirrored from
L2 in Redis) fires a workflow's cron, dispatches entry steps to
`processor-{processorId}`, and advances successors from reported outcomes.
Execution blobs live at `skp:data:{guid}` with **no TTL**; reclaim is explicit.

**Observability plane** -- Prometheus for rates and per-replica health,
Elasticsearch for per-run history. Grafana boards remain the human's view; the
bundle reads HTTP, never a board.

**Blackbox** -- Postgres, Redis, RabbitMQ, ES, Prometheus, Grafana, the
orchestrator and the API as infrastructure. **Not blackbox** --
`BaseProcessor.Core`, whose authoring contract the developer skill must teach.

## 4. Bundle shape

```
skp-toolkit/
  skp/
    profile.py       endpoints + token, from the memory folder; never printed
    clients/         pg, redis, rabbit(AMQP), es, prom, api(REST), cluster(oc|kubectl)
    model/           COMPILED catalog + flow topology -- generated, not written
    verbs/           the leaf commands
    inspect/         bounded read-only primitives
    compile.py       regenerates model/ and leaf bodies; fails loudly on drift
    annotations/     the hand-written inputs (see 9.2)
    eval/            task set (ships) + runner and scorer (do not ship)
.claude/skills/
  skp/                       router -- a decision table, nothing else
  skp-author/  skp-operate/  skp-observe/  skp-investigate/  skp-remediate/
  skp-processor-build/  skp-processor-ship/
```

### 4.1 Naming convention

**Skills are hyphenated, verbs are spaced, and a skill's group is its own name.**
The skill `skp-author` drives the `skp author ...` command group; `skp-operate`
drives `skp operate ...`, and so on. Three groups have no skill of their own
because every skill uses them: `skp init`, `skp doctor`, `skp map`.

This is deliberate and load-bearing: it is one mapping instead of two, so a model
that has loaded `skp-investigate` already knows its commands begin
`skp investigate`.

### 4.2 Compensating mechanisms

Two exist specifically for the model:

**Errors name their own remedy.** Every failure prints the reference file that
explains it -- `EXIT 3 -- start rejected at gate 'schemaEdge'. See
references/gate-schema-edge.md`. The *tool* decides when context is needed, which
it can do correctly and the model cannot. This is what keeps a leaf under budget
while still covering every failure it can reach.

**Every verb prints `NEXT:`.** `skp processor-ship build` ends with
`NEXT: skp processor-ship register --hash <sha>`. Multi-step procedures stop depending on a
plan surviving in context; the model follows a breadcrumb one command at a time.

## 5. `skp init` and the memory folder

`skp init` is the first command. Every other verb refuses to run without it,
exiting with `NEXT: skp init`, so a model that starts mid-procedure is routed back
rather than guessing.

It collects the **source root**, the **cluster** (API URL, token, project) and the
**six service endpoints** (Postgres, Redis, RabbitMQ, Elasticsearch, Prometheus,
BaseAPI) -- asking only for what it cannot derive, and showing
what it derived for confirmation rather than assuming silently.

It produces:

```
<memory folder>/            path chosen at init
  profile.json    source root, cluster URL, project, resolved endpoints
  token           mode 0600, its own file, never inlined
  model/          the compiled catalog and topology
  compile.lock    source hashes (drift) + generated-file hashes (hand-edit)
  state/          breadcrumbs: last workflow id, correlation id, source hash
  cases/          investigation case files
```

Init does three jobs because they share one prerequisite: it resolves the givens,
**compiles `model/` from the source root it was just given**, and **probes all
seven targets -- those six plus the cluster API -- printing a reachability table**. That last part means an
unreachable Elasticsearch surfaces once, at init, as a named red row -- not three
days later as an empty ledger the model reports as "no records".

`skp init --refresh` re-probes and recompiles. The token is written once, never
echoed; traced output renders `Authorization: <token from profile>`.

**`state/` compensates for forgetfulness.** Verbs record what they acted on; later
verbs default to it. `skp operate verify` with no arguments verifies the run that
`skp operate start` just started.

## 6. The capability catalog

Indexed on **two axes**, because the model arrives from both directions: "what can
Redis do" and "I am investigating -- what is available".

### 6.1 The intent taxonomy (closed, seven)

| Intent | Meaning |
| --- | --- |
| **design** | author or modify a definition |
| **control** | change runtime state |
| **observe** | describe current state |
| **analyze** | quantify over a window |
| **investigate** | localize an unknown fault |
| **verify** | assert an expectation holds, and fail if it does not |
| **remediate** | repair a known condition |

Closed is load-bearing: an open vocabulary means the model invents a category,
finds nothing, and improvises. `verify` is deliberately separate from `observe` --
observe describes, verify asserts and can fail, which is what lets a ship or a
start end in a checkable state.

### 6.2 Entry fields

id, component, operation, `intents[]`, **what it authoritatively answers**, **what
it must never be used for**, write authority, cost, and the wrapping verb if one
exists.

The "never used for" field is doing real work: it is what stops the model asking
Postgres what is currently running. Postgres holds the *definition*; L2 holds the
*projection*; they diverge legitimately between a `PUT` and the next `start`.

### 6.3 Components and what each authoritatively answers

**BaseAPI -- the only write authority.** Five entities x five verbs (`GET` list,
`GET {id:guid}`, `POST`, `PUT {id}`, `DELETE {id}`) under
`/api/v1.0/{schemas,processors,steps,assignments,workflows}`, plus
`GET /processors/by-source-hash/{hash}` -- catalogued with the trap that matching
is byte-exact lowercase, so a mixed-case hash 404s past an existing row. Plus
`POST /orchestration/{start,stop}` with the five gates and their status codes, and
the three `/health/*` paths, whose meanings differ per workload.

**Postgres -- authoritative for the definition.** `Schemas`, `Processors`,
`Steps`, `Assignments`, `Workflows`, and the junctions `StepNextSteps`,
`WorkflowEntrySteps`, `WorkflowAssignments` -- marked as *the* source of truth for
edges and bindings, since the entities deliberately do not carry them and the read
DTOs are enriched after mapping. Read-only.

**Redis -- authoritative for what is projected and what is in flight.** The seven
key families: `skp:`, `skp:{workflowId}`, `skp:{workflowId}:{stepId}`,
`skp:proc:{processorId}`, `skp:proc:{processorId}:{instanceId}`,
`skp:data:{guid}`, `skp:keeper:probe:{h}`.

> This section said **six** until the generated extractor was first run against
> `L2ProjectionKeys.cs` and returned a seventh: `KeeperProbe`, the gate probe's
> scratch key, written then deleted with a short TTL as the net for a crash
> between the two. It was declared in the source the whole time and missing from
> this document, which is the argument for a generated catalog stated as
> evidence rather than as intent -- a hand-written one would have shipped with
> six entries and nothing would ever have contradicted it.

With two semantics nobody infers: a liveness entry is **stale
at 2x its interval but present until 4x**, so absent and unhealthy are different
answers; and `skp:data:*` has **no TTL**, so a lingering blob is a real leak worth
reporting, not garbage awaiting collection.

**RabbitMQ -- authoritative for stuck work.** `orchestrator-control`,
`orchestrator-result`, `orchestrator-result-post` and their `.dead` queues,
`processor-{id}` / `.dead`, the RPC queues `processor-identity-query` and
`schema-definition-query`, the `orchestrator-fanout` exchange with its per-replica
queues, and both DLX names.

> **Constraint inherited from `2026-08-22-pipeline-metrics-design.md`: the HTTP
> management API is not available.** The broker is org-owned and its owners
> monitor it; `src/` contains no `:15672` and no `/api/queues`, and this bundle
> adds none. Depth and consumer count come from AMQP `queue.declare` passive, and
> from the `pipeline.queue.depth`, `pipeline.queue.consumers` and
> `pipeline.deadletter.depth` series the services already export from inside the
> process. Reading a parked message's *content* is not offered: it requires
> consuming, which is a mutation of the queue under investigation.

**Elasticsearch -- authoritative for run history.** The data stream, the field
shapes (`attributes.{OriginalFormat}` is the template; `attributes.CorrelationId`,
`.Result`, `.WorkflowId`; `StepId` and `EntryId` ride the dispatch scope), the
run-scoped template vocabulary from `Templates.cs`, and the rule that `WorkflowId`
alone **cannot** identify a run, because the control-plane endpoints log it too.
Queries are bounded on time and workflow: an unbounded aggregation on this index
looks like a hang.

**Prometheus -- authoritative for rates and per-replica health.** The `pipeline.*`
family -- `messages.produced`/`consumed`, `queue.wait`, `queue.depth`,
`queue.consumers`, `consumer.duration`, `produce.duration`, `deadletter.depth`,
`gate.{open,trips,probe.duration}`, `loop.iterations`, `identity.ready`, `leader`,
`hydration.admitted`, `process.start.timestamp` -- carrying the label fact that
breaks every naive query: **`instance` is the scrape target, not the replica;
per-replica requires `service_instance_id`.**

**Cluster (`oc` / `kubectl`) -- authoritative for pod reality.** Pods, rollouts,
logs, and per-workload readiness semantics, with `0/1 READY` on a processor
catalogued as *expected pending registration* rather than a fault.

### 6.4 Queries

`skp map --component redis`, `skp map --intent investigate`, and
`skp map --answers "why did a run stop"` resolving a question to entries.

### 6.5 Completeness, enforced at compile time

- **Every discovered surface is catalogued.** `compile.py` enumerates the real
  surfaces from source -- endpoints, tables, key families, queues, ES fields,
  `pipeline.*` instruments, cluster operations -- and fails if any lacks an entry.
  Coverage is provable, not believed.
- **Every entry carries at least one intent; every intent has coverage.** An
  untagged capability is a compile error. An intent with no entries is a **gap in
  the shipped system**, reported rather than hidden.

## 7. Investigation

Analysis answers a known question; investigation localizes an unknown fault.
Localizing a fault in a pipeline does not require reasoning if the topology is
known -- it requires walking it. So the architecture is not something the model
understands, it is something it **traverses**.

**The flow topology ships as data**: each hop, its owning component, what it
writes and where, and what evidence proves it happened. Generated from the same
sources as the catalog.

**Cut points** are the ordered checkpoints along one run's life. Each is a single
command with two branches.

| # | Question | Evidence |
| --- | --- | --- |
| 1 | Is the workflow projected at all? | Redis `skp:{workflowId}` |
| 2 | Did a fire happen? | ES `dispatched an entry step`; Prom `pipeline.leader` |
| 3 | Did the dispatch reach the processor's queue? | AMQP passive depth + consumers on `processor-{id}` |
| 4 | Did a replica pick it up? | ES `running the step` for that `StepId` |
| 5 | Did the author's transform return? | ES `the step returned after {ElapsedMs}ms` |
| 6 | Did the branch's output land? | ES `branch completed`; Redis `skp:data:{entryId}` |
| 7 | Did the outcome reach the orchestrator? | `orchestrator-result` depth; ES `the entry step completed with {Result}` |
| 8 | Did successors advance? | ES `advanced {N} successor(s)` |
| 9 | Did it terminate? | ES terminal record; reclaim of the last blob |

Cross-cutting checks explain a stall at *any* cut point rather than one: DLQ
depths, `pipeline.gate.open`, per-replica liveness with the 2x/4x rule, and
processor readiness against the registered hash.

**The model bisects; it does not diagnose.** Last checkpoint that passed, first
that failed -- the boundary *is* the fault location, and the toolkit names what
that boundary means. Present at 5, absent at 6: an author returned without
sending, legal for a sink and a bug for a transform. Present at 3 with zero
consumers: no ready replica, which loops back to the hash. Present at 6, absent at
7: a lost outcome.

**When the ladder ends, access opens.** The model falls through to the catalog and
the bounded primitives, gathers evidence, and **reports rather than concludes**.
"I traced to the boundary between 6 and 7; here is what each store holds; I have
no rule for this" is a useful output. An invented cause is not.

**A case file accumulates to disk** as findings are gathered, so a twenty-step
investigation does not depend on twenty steps surviving in context -- and a human
can read the trail afterwards, or the model can resume it cold.

## 8. Write authority

**Reads: unrestricted**, all seven components, no gate.

**Writes: routed through BaseAPI by default**, because that is the path that
validates. Direct mutation of Redis, Postgres or the broker is **possible but
gated**: explicitly flagged, human-confirmed at the moment of use, and recorded in
the case file. Purging a DLQ or clearing a stranded `skp:data:` key is legitimate
operator work; doing it as a silent side effect of an investigation is not. The
gate is on the small model acting unilaterally, not on the capability existing.

## 9. The skill surface

Intents categorize *capabilities*; skills are entry points for *jobs*. Forcing
them 1:1 would give fourteen skills, most empty.

| Skill | Persona | Intents | Job |
| --- | --- | --- | --- |
| `skp` | -- | -- | Router: a decision table keyed on the user's own words |
| `skp-author` | operator | design, verify | intent -> spec file -> offline validation against all five gates -> applied in dependency order |
| `skp-operate` | operator | control, verify | start, stop, the `Never` freeze -- each ending in a proof it took effect |
| `skp-observe` | operator | observe, analyze | current picture and windowed quantities |
| `skp-investigate` | operator | investigate, observe, analyze | the cut-point ladder, the case file, evidence when the ladder ends |
| `skp-remediate` | both | remediate, verify | the known repairs, human-confirmed, recorded |
| `skp-processor-build` | developer | design, verify | scaffold, the `ProcessAsync` contract, hermetic tests before deployment |
| `skp-processor-ship` | developer | control, verify, remediate | build, push, apply, read the pod's hash, repoint the row, confirm ready |

**The router is the only component that must handle ambiguity**, so it is the only
one tuned by hand. "Nothing is running" and "my workflow didn't fire" both land on
`skp-investigate`, not `skp-observe`, because the person asking does not yet know
which they need.

**A session has one shape**: `skp init` if cold -> router picks a leaf -> the leaf
runs verbs -> each verb prints `NEXT:` -> the model follows it. The model never
plans.

**Leaf bodies are generated** from the leaf's intent slice of the catalog, its verb
list, its `NEXT:` graph, and its annotations. A new capability appears in the slice
on the next compile; nobody has to remember which skills mention it.

### 9.1 Budgets

Router <= 400 tokens. Each leaf <= 1200 tokens. A leaf over budget **fails the
build** rather than silently degrading the model that loads it. Everything else
lives behind `references/`, loaded only when an error names it.

### 9.2 The hand-written surface

Annotations only, versioned beside the generator, never inside a generated file:
the "never used for" fields, the meaning of each cut-point boundary, and the
router's phrase table.

## 10. The developer capability surface

Generated from the **authoring** sources -- `BaseProcessor.Core`,
`Processor.Sample`, `SampleConfig`, and the sample's `appsettings.json`, `.csproj`
and `Dockerfile`. Three things are extracted, and keeping them apart is what makes
the skill usable.

**What an author may do** -- a short closed list, which is why it compiles well:
override `ProcessAsync` and nothing else; `SendToPostAsync(bytes, executionId, ct)`
to emit one branch; `NewExecutionId()` to open a lineage; `FailedException` /
`CancelledException` for an explicit outcome; a bare `return` to end a branch
silently; `ILogger<T>` by constructor injection, riding the framework's dispatch
scope. Config is any record deriving `ProcessorConfig`, bound case-insensitively
with unknown properties ignored.

**What the framework already provides** -- from `AddBaseProcessor` and
`AddProcessorExecution`: messaging, Redis, health checks, preflight, instance id,
the liveness writer and heartbeat, the two-loop startup orchestrator, the topology,
both queue handlers, gating, the queue-depth and dead-letter probes, the metrics
host. This half answers the question a developer actually asks -- *do I need to
write this?* -- authoritatively, instead of them registering a second Redis client
beside the one already there.

**What must hold** (annotations; no extractor produces these): the processor is a
singleton at prefetch 1, so per-dispatch state is a plain field and adding
concurrency breaks lineages silently; `ProcessAsync` must survive running twice;
`ct` is never cancelled in production; log the *shape* of data, never its content,
while config is safe to render; `executionId == Guid.Empty` is the entry-step test,
truer than `data.Length`; `PostSendException` must be rethrown bare, because
wrapping it converts a recoverable replay into a reported success that never
happened.

**The composition shape** is taken from the sample as working files rather than
described, because each of these fails silently or late if missed: `Program.cs`'s
SIGTERM registration before any host exists (Stage 1 may wait forever, so that pod
is exactly the one an operator deletes); `ProcessorHost.Create`'s ordering
constraint that identity must reach `AddBaseConsoleObservability` *before* the
meter provider is built, since a resource is immutable once materialised; the
`.csproj`'s `Import` of `SourceHash.targets`; the Dockerfile's repo-root context
and `aspnet` base rather than `runtime`.

**The `appsettings.json` surface** is catalogued as configuration capability:
`Service`, `ConnectionStrings:Redis`, `RabbitMq`, `Processor` (`Interval`,
`StartupInterval`, `RequestTimeout`, `BackoffCap`), `ConsoleHealth:Port`,
`Logging` -- with `Interval` linked to the operator's liveness staleness rule,
since it is the same number read from both sides.

`skp-processor-build` scaffolds by **copying the sample's real files with
substitutions**, presents the contract as a generated checklist over the enumerated
terminals, and generates tests from the patterns in `SampleProcessorTests`.

## 11. The SourceHash rule

A source change produces a new hash, and the hash **is** identity. A pod whose hash
matches no row sits `0/1 READY` forever: retrying, never restarting, never
erroring. `skp processor-ship` refuses to call a deploy finished until the row's
`SourceHash` equals the hash the running pod reports.

**Update the row in place; do not create a new one.** Steps reference `ProcessorId`
and the work queue is `processor-{processorId}`, so minting a new row for a new
build would give the same logical processor a new id, orphan every step pointing at
the old one, and strand a queue. A rebuild of processor X is `PUT /processors/{id}`
with the new hash. Creating a row is reserved for a genuinely new processor, and
the toolkit states which it is doing and why.

**`SourceHash.targets` hashes `BaseProcessor.Core`'s sources together with the
concrete project's.** So editing the base library changes the hash of **every
processor in the fleet at once** -- one framework commit is a fleet-wide
re-registration event. `skp processor-ship` detects this and reports "this change affects N
registered processors" rather than letting someone fix one and lose an afternoon to
the other four.

**The hash is verified, never predicted.** The target normalises line endings and
path separators so a Linux and a Windows build agree -- which is a claim to check,
not to trust. The loop is: build -> apply -> read the hash the pod prints ->
repoint the row with *that* value -> confirm ready. A locally computed hash is a
prediction, and a mismatch against the pod is itself a reportable finding.

`skp-observe` inverts it: an unready replica is diagnosed as *"image hash `abc...`
has no processor row"* or *"row says `def...`, pod says `abc...`"* -- a named cause
with a fix, never "pods not ready".

## 12. Updating the bundle

**Generated files are never hand-edited.** This repo already learned this with the
Grafana boards -- *edit `build-dashboards.py`, never the JSON* -- and now enforces
it with `allowUiUpdates: false` rather than trusting convention. Skills get the
mechanism, not the convention: `compile.lock` stores each generated file's hash and
a hand-edited leaf is detected and reported. Otherwise the first person to fix a
skill directly has their fix silently reverted by the next refresh, which is worse
than being told no.

| Change | Path |
| --- | --- |
| The C# changed | `skp init --refresh`. Nobody touches a skill. Stale state is loud: verbs warn when `compile.lock` no longer matches source. |
| An annotation is wrong | Edit the annotation file beside the generator, recompile. *You do not edit the skill, you edit its input.* |
| A capability has no verb | Real development: write the verb, tag its intents, recompile. **Comes back to this repo** (see 13.4). |
| A new bundle version | Replace `skp-toolkit/`, keep the memory folder, `skp init --refresh`. Nothing about the environment is stored in the bundle. |

**`skp doctor`** runs the compile-time checks after the fact: source drift,
hand-edited generated files, dangling `NEXT:` targets, reference files named by
errors but missing, unreachable endpoints, leaves over budget. It is what an
operator runs when they suspect the toolkit rather than the system.

## 13. Verification

### 13.1 Structural (ships)

Coverage of every discovered surface; every entry tagged; every `NEXT:` target
existing; every named reference file present; every leaf under budget; the drift
lock against the C# sources. No model, no cluster. This is `skp doctor`.

### 13.2 Behavioural (ships)

Each verb asserted against a live cluster: `skp author validate` on a cyclic graph
exits non-zero naming the cycle; `skp operate verify` returns completed for a
completed run and wedged-at-step-X for a killed processor. The repo's existing resilience scenarios
already prove these states are reachable, so the oracles exist.

### 13.3 Model-facing (task set ships; runner and scorer do not)

A fixed set of prompts in the personas' own words -- "workflow X ran but nothing
happened", "I changed my processor and the pods won't come up", "build me a
workflow that does A then B" -- each with an expected verdict, replayed by a small
model with only the bundle available.

**Fabrication is scored separately from failure.** A run where the model says "no
catalog entry -- here is the evidence" **passes**. A run where it confidently names
a wrong cause **fails, even if the cause happens to be right**. This is the layer
that tests the premise the whole design rests on.

Validation runs **here**, using Haiku subagents driving the bundle blind -- no
context beyond the skills themselves. This is also how the router is tuned, since
misrouting is the one failure the structural checks cannot catch.

The *task set* ships as a human-runnable acceptance checklist: it is small, static,
and is the explicit statement of what the bundle promises to handle. The *runner
and scorer* stay in this repo.

### 13.4 The consequence, stated rather than discovered

**No Haiku-class model is reachable on the offline machine.** So model-facing
validation can only happen here, and any change made offline is structurally
checked but not model-checked. That is acceptable only while offline changes stay
in a narrow band: **regeneration after a C# edit, and annotation fixes.** Anything
that adds a verb, changes the router, or restructures a leaf returns to this repo,
is evaluated, and ships as a new bundle version. This is a design constraint, not a
preference.

## 14. Out of scope

- **Platform deployment.** The system is already deployed. The one deploy the
  bundle owns is a *new processor workload*, with cluster mechanics pushed into the
  profile so kind and OpenShift are two profiles of one procedure.
- **OpenShift manifests for the platform** -- assumed to exist already.
- **Grafana boards.** They remain the human's view; the bundle reads HTTP.
- **Changes to `src/`.** This work reads the source; it does not modify it.

## 15. Risks

| Risk | Mitigation |
| --- | --- |
| `compile.py` parses C# heuristically and misreads a construct | The coverage check fails loudly on an unrecognised surface; Roslyn is not available offline and primary-constructor parsing is a known trap in this repo |
| The router misroutes and the model runs a confident wrong leaf | Layer 13.3 tunes it; the router is the only hand-tuned component |
| A capability gap is found offline with no strong model to fill it | The coverage check reports gaps; the escape hatch keeps the capability reachable meanwhile |
| The catalog drifts from a C# change nobody recompiles | `compile.lock` + verb-level staleness warnings + `skp doctor` |
| An investigation mutates the system it is investigating | Reads are unrestricted; every write is gated, confirmed and recorded |

## 16. Implementation phases

The work is large but coherent. It decomposes along one axis -- each phase is
independently useful and independently verifiable, and each later phase consumes
the previous one's output rather than reworking it.

| Phase | Delivers | Done when |
| --- | --- | --- |
| **1. Ground** | `profile.py`, the seven clients, `skp init`, the memory folder, the reachability table | `skp init` against the dev cluster prints seven rows and writes a profile |
| **2. Compile** | `compile.py`, the catalog, the flow topology, the coverage and tagging checks, `compile.lock`, `skp map`, `skp doctor` | Every discovered surface has a tagged entry; drift and hand-edits are detected |
| **3. Operator verbs** | `author`, `operate`, `observe`, and the cut-point ladder behind `investigate`, with case files | The behavioural assertions in 13.2 pass against the dev cluster |
| **4. Developer verbs** | `processor-build` scaffolding and contract checklist, `processor-ship` with the SourceHash rule | A scaffolded processor reaches `1/1 READY` through the verbs alone |
| **5. Skills** | The router and seven generated leaves, budgets enforced at build | Every leaf compiles under budget; `NEXT:` graph has no dangling targets |
| **6. Evaluate** | The task set, the runner, the scorer; Haiku subagents driving the bundle blind | Fabrication rate measured and the router tuned against it |
| **7. Package** | The offline bundle, the acceptance checklist, the update paths | A clean machine reaches a working `skp init` from the bundle alone |

Phase 5 depends on 2 for its generated bodies and on 3 and 4 for its verb lists,
which is why the skills come late: a leaf generated before its verbs exist would
be prose, and prose is what this design replaces.
