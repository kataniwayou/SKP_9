# Processor Two-Stage Boot — Design

**Date:** 2026-08-19
**Status:** Accepted
**Supersedes:** the identity-rides-per-record arrangement described in
`2026-08-18-processor-sample-discovery-design.md` §10.

## 1. Problem

A processor's real identity — `ProcessorId`, `Name`, `Version` — lives in a BaseApi database row and
arrives over the bus after discovery. Its OpenTelemetry resource is built during host construction,
long before that. The two cannot meet.

This was verified against OpenTelemetry 1.15.3 rather than assumed:

| Probe | Result |
|---|---|
| `Resource` mutation API | none — `get_Attributes()` only, no setter |
| `IResourceDetector.Detect()` for logs | ran during `builder.Build()` |
| `IResourceDetector.Detect()` for metrics | ran before the first hosted service started |
| `builder.Services.Add(...)` after `Build()` | `InvalidOperationException: The service collection cannot be modified because it is read-only.` |
| `builder.Logging.AddOpenTelemetry(...)` after `Build()` | same exception |
| `Sdk.CreateMeterProviderBuilder()` | exists; a provider built late **does** see a late value |
| `Sdk.CreateLoggerProviderBuilder()` | does not exist in 1.15.3 |

`IResourceDetector` is the latest hook `ResourceBuilder` offers and it still fires before any
`IHostedService` runs. Identity comes from `ProcessorStartupOrchestrator`, which *is* an
`IHostedService`. So no in-host arrangement can put identity on the resource.

## 2. Decision

Resolve identity **before** the host is built, then wire OpenTelemetry with it.

```
Stage 0  minimal probe listener on ConsoleHealth:Port
         /health/startup 200 · /health/live 200 · /health/ready 503
         console logging only (stdout → kubectl logs)

Stage 1  RabbitMQ connection + proc-reply-{instanceId} + ReplySlot + QueueSender
         ask processor-identity-query, unbounded backoff, until ProcessorIdentityFound
             ← IIdentityBootstrap, the substitution seam

Stage 2  stop the probe listener
         AddBaseConsoleObservability(cfg, source: "worker",
                                     serviceName:    identity.Name,
                                     serviceVersion: identity.Version,
                                     resourceAttributes: [ProcessorId])
         build the host with IProcessorContext pre-seeded, start it

Stage 3  ProcessorStartupOrchestrator runs Loop B only, then MarkHealthy
```

### 2.1 Why the probe listener is load-bearing

Without it nothing answers `:8081` during Stage 1, the startup probe fails its
`initialDelay 5s + 30 × 5s ≈ 155s` budget, and the kubelet restarts the container. That would
violate a requirement stated in two places:

> `ProcessorStartupOrchestrator`: "Both loops retry without limit, and that is the requirement rather
> than a fallback. A processor image can be deployed before its database row exists, so 'not found'
> is a normal early answer, not an error — a bounded retry would turn an ordering the operator is
> allowed to choose into a crash loop."

> `k8s/33-processor-sample.yaml`: "deliberately not gated on identity: a processor waiting on an
> unregistered row is starting correctly, however long that takes."

With the listener, external behaviour is **identical to today**: pod up, startup green, live green,
ready red, retrying forever. The endless loop is the same endless loop; only its location moves.

### 2.2 Redis is not in the critical path

Stage 1 needs RabbitMQ only. Verified: `IConnectionMultiplexer` is a lazy `TryAddSingleton`, the
manifest uses `abortConnect=false`, `WriteUnhealthyAsync` returns early while `Identity is null`, and
`ProcessorLivenessHeartbeat` gates its write on `IsHealthy`. Nothing touches Redis before identity.

### 2.3 Loop A is removed, not kept as a fallback

Once Stage 1 is unbounded, an in-host retry is dead code. `ProcessorStartupOrchestrator` keeps
Loop B, the first L2 write, `MarkHealthy` and heartbeat retirement; it loses `ResolveIdentityAsync`
and its `ISourceHashProvider` dependency.

Keeping both would reintroduce the failure this design exists to remove: two code paths producing
two different resource shapes for the same processor, so replicas of one deployment could disagree
on `service.name`.

## 3. Resource contract

| Source | Logs resource | Metrics resource |
|---|---|---|
| `identity.Name` | `service.name` | `service.name` |
| `identity.Version` | `service.version` | `service.version` |
| `identity.Id` | `ProcessorId` | `processorId` |
| pod name | `service.instance.id` | `service.instance.id` |
| tier | `Source` = `worker` | `source` = `worker` |

Casing follows the convention already stated in both observability extensions: PascalCase on logs,
camelCase on metrics.

**Metrics `service.name` carries the name only.** The current
`AddService(serviceName: $"{name}_{version}")` interpolation is removed; version is passed to
`AddService` as `serviceVersion` and becomes `service.version` in its own right. The interpolation
existed to give a sentinel one human-readable label; with real identity it only hides the version
inside a name and forces logs and metrics to disagree on what `service.name` means.

**Scope: `BaseConsole.Core` only.** `BaseApi.Core`'s equivalent keeps its interpolation, because
changing it would break existing queries on `exported_job="baseapi_0.0.0"`.

### 3.1 ProcessorId is the identity; Name and Version are labels

`uq_processor_source_hash` is the **only** unique index on the processor table. `Name` and `Version`
are unconstrained columns.

```
SourceHash  ──1:1──  ProcessorId     enforced by uq_processor_source_hash
Name, Version        free text, not unique, may repeat across rows,
                     and may stay identical while SourceHash changes
```

A rebuild changes `SourceHash` with no guarantee anyone bumps `Name` or `Version`. Two genuinely
different builds — different `SourceHash`, different `ProcessorId`, different code — can therefore
carry identical `Name` and `Version` and would **silently merge into one series**.

So `ProcessorId` must be on the resource for both signals, and any query that must be exact keys on
`ProcessorId` / `processorId`. `service.name` is for display and grouping only.

### 3.2 What lands in Prometheus

Measured against the live cluster: Prometheus scrapes the collector as one target, so `job` is always
`otel-collector` and the OTel `service.name` arrives prefixed as `exported_job`. `service_name`,
`processorId` and `source` exist as their own labels. `processorId` is already a label today
(emitted per-datapoint by the reference build), so moving it to the resource keeps the label name
and does not break existing dashboards.

## 4. Accepted costs

**An unresolved processor is invisible to the collector.** While Stage 1 loops, no OTLP provider
exists, so no logs reach Elasticsearch and no metric series reach Prometheus. Today an unresolved
processor still ships both.

Accepted because the operator's first move on a starting processor is `kubectl logs`, and console
logging is wired throughout Stage 1.

Mitigations, both optional and out of scope here:
1. a `filelog` receiver on the collector scraping pod stdout, which would cover the window with no
   application change;
2. a miss counter on BaseApi's `GetProcessorBySourceHashHandler`, which sees every stuck processor's
   repeated query and survives the pod — the better alerting surface.

**One extra broker connect.** Stage 1's connection is disposed before the host builds its own. They
never overlap. The reply queue is exclusive and auto-delete, so it dies with the connection, and
`ReplyQueueConsumer.EnsureStartedAsync` already re-declares it by design.

**A sub-second probe gap** between stopping the Stage 0 listener and the host's
`EmbeddedHealthEndpointService` binding the same port. The kubelet probes every 5s with
`failureThreshold: 30`, so a single missed probe is not observable.

## 5. Out of scope

- Gate A / `ConfigSchemaCoverageCheck` — not yet present in `src/`.
- The dispatch queue bind — `ProcessorStartupOrchestrator` still carries its `NOTE:` marking where
  it belongs, before the latch flips.
- Changing `BaseApi.Core`'s observability extension.
- Automating processor row registration in the deploy pipeline.

## 6. Verified

Confirmed against the live `skp` namespace on the kind cluster `desktop`, 2026-08-19.

| | |
|---|---|
| Image | `processor-sample:local` — `sha256:38f3bac801d90ce16d2eb520d85c5a957fe5a8b4991c5a6a82301d4b3f26bcd4` |
| `SourceHash` (computed in the Linux publish) | `d872fa9315de05f492b338ba2db8ac4209d4d09f6dfaede4d8ef56f28d87e2fe` |
| Row it resolved | `5fed54d3-41ce-4eed-9cea-1363cb4f7509` — `sample-proc` `1.2.0` |

**§2.1 held under the real kubelet, which is the claim no test can make.** The rollout deliberately
went out before the row was registered. The new pod sat `Running`, `Ready=false`, **0 restarts** for
roughly four minutes — well past the startup probe's `5s + 30 × 5s ≈ 155s` budget — logging
`no processor registered for source hash d872fa93…; retrying in 00:00:30` to stdout throughout. It
resolved on its own the moment the row appeared, and still never restarted:

```
no processor registered for source hash d872fa93…; retrying in 00:00:30   (×n)
identity resolved: processor 5fed54d3-41ce-4eed-9cea-1363cb4f7509 (sample-proc 1.2.0)
processor healthy; startup loops retired
```

**§3's contract, observed on both replicas.** Metrics at the collector's Prometheus endpoint:

```
job="sample-proc"                                  service_version="1.2.0"
processorId="5fed54d3-41ce-4eed-9cea-1363cb4f7509" source="worker"
service_instance_id="processor-sample-6c8787cdf8-ft6gv" / "…-x6t7x"
```

Logs in Elasticsearch, under the PascalCase convention:

```
service.name=sample-proc   service.version=1.2.0
ProcessorId=5fed54d3-41ce-4eed-9cea-1363cb4f7509   Source=worker
```

`service.name` is the name alone — the `{name}_{version}` interpolation is gone, and `job` no longer
reads `unresolved_0.0.0`. `IdentityName` appears on zero records from this build, and on zero records
from any service in the ten minutes after the rollout; the pre-rollout history still carries it.
`baseapi_0.0.0` is unchanged, as §3 requires.
