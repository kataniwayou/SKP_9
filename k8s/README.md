# Running the stack on kind

What this deploys: Postgres, Redis, RabbitMQ, the API, two replicas of the discovery-shell
processor, and three replicas of the orchestrator control plane.

The observability stack — collector, Prometheus, Grafana, Elasticsearch — is **not** included here.
Every application exports OTLP to `http://otel-collector:4317` if something is listening there and
fails quietly if nothing is, so a collector is an enrichment rather than a dependency. If the
namespace already has one running, telemetry lands without any further action.

**If your namespace already has infrastructure running, apply only the application manifests.**
Re-applying the StatefulSets would restart working Postgres, Redis and RabbitMQ for no benefit, and
some of their fields are immutable once created:

```bash
kubectl apply -f k8s/30-baseapi-service.yaml -f k8s/33-processor-sample.yaml \
  -f k8s/36-orchestrator.yaml
```

## Build and load

All three Dockerfiles take the **repository root** as their build context, because restore needs
`NuGet.config`, the props files and the local `nugets/` feed:

```bash
docker build -f src/BaseApi.Service/Dockerfile   -t baseapi-service:local   .
docker build -f src/Processor.Sample/Dockerfile  -t processor-sample:local  .
docker build -f src/Orchestrator/Dockerfile      -t orchestrator:local      .

kind load docker-image baseapi-service:local
kind load docker-image processor-sample:local
kind load docker-image orchestrator:local
```

Every application manifest uses `imagePullPolicy: IfNotPresent` against a `:local` tag, so there is
no registry and nothing is ever pulled. The corollary is that rebuilding an image does **not**
update a running pod — `kubectl rollout restart` is what picks up new bits.

```bash
kubectl apply -k k8s/
kubectl -n skp rollout status deploy/baseapi-service
kubectl -n skp rollout status sts/orchestrator
```

The API applies its own migrations during startup and only then flips its startup gate, so
`/health/startup` going green means the schema is in place. No init container, no manual step.

**Never scale `sts/orchestrator` down.** Each replica owns a durable fan-out queue named after its
pod, and a queue whose replica is gone for good stays bound to `orchestrator-fanout`, accumulating a
copy of every announcement with nothing draining it. Scaling up is safe. Removing a replica for good
means deleting its `orchestrator-control.orchestrator-N` queue on the broker in the same change. The
manifest says the same thing at the top of `k8s/36-orchestrator.yaml`.

## Register the processor, which is the part that is easy to misread

**The processor pods will sit `0/1 READY` and stay there, and that is correct.** Readiness reports
identity resolution; identity is resolved by asking the API for the processor row whose `SourceHash`
matches the one embedded in the image. Until such a row exists there is nothing to resolve, and the
pod is live, healthy, retrying, and unready. No restart will change that — which is precisely why
this is a readiness signal and not a liveness one.

The hash is in the logs. Loop A prints it on every retry:

```bash
kubectl -n skp logs deploy/processor-sample | grep "source hash"
# info: no processor registered for source hash 9f2c...; retrying in 00:00:08
```

Register a row carrying it. The schema ids are all null — this shell has no schemas, so Loop B has
nothing to resolve and goes straight through:

```bash
kubectl -n skp port-forward svc/baseapi-service 8080:8080 &

curl -X POST http://localhost:8080/api/v1.0/processors \
  -H 'Content-Type: application/json' \
  -d '{
        "name": "sample",
        "version": "1.0.0",
        "description": "discovery shell",
        "sourceHash": "<paste the hash from the logs>",
        "inputSchemaId": null,
        "outputSchemaId": null,
        "configSchemaId": null
      }'
```

Within one backoff interval both pods should go ready:

```bash
kubectl -n skp get pods -l app=processor-sample -w
```

The controller is `ProcessorsController`, so the route is `/processors` — plural. A singular URL
returns a bare 404 with no body, which is easy to mistake for the API not being reachable.

## What to check, and what each check proves

```bash
kubectl -n skp exec sts/redis -- redis-cli KEYS 'skp:proc:*'
```

Expect three keys for one processor with two replicas: the index set at `skp:proc:{processorId}` and
one entry per replica at `skp:proc:{processorId}:{podName}`. Two distinct instance keys is the
per-replica liveness scheme working — one shared key would mean the replicas were overwriting each
other.

```bash
kubectl -n skp exec sts/redis -- redis-cli SMEMBERS 'skp:proc:<processorId>'
kubectl -n skp exec sts/redis -- redis-cli GET 'skp:proc:<processorId>:<podName>'
```

The set members should be the two pod names, matching `service.instance.id` on those pods' telemetry
— that correspondence is the whole reason the instance id is resolved once from `POD_NAME` rather
than defaulted separately in three places. The entry should read `"status":"Healthy"` with
`"interval":10`, and its TTL should be 40s — four times that interval — refreshed every 10s by the
liveness loop. The reader calls the same entry stale at twice its interval, so between 20s and 40s
without a beat the key still exists but no longer counts, which is what lets the gate distinguish a
wedged replica from one that was never there.

The sequence worth watching rather than just the end state: before registration the entries are
absent, immediately after identity resolves they appear as `Unhealthy`, and they turn `Healthy` once
the loops finish. A replica that is starting is never *absent* after it knows its own id — absent and
unhealthy are different answers, and the orchestration gate counts them separately.

## Probes, and why they differ

All three workloads expose the same three paths — on 8080 for the API, 8081 for the two console
services — and the paths do not mean the same thing in each. Readiness in particular answers a
different question in all three, so the column that matters is the one for the workload in front of
you.

| Probe | API | Processor | Orchestrator |
|---|---|---|---|
| `/health/startup` | migrations applied | the loops are running | the loops are running |
| `/health/ready` | startup latched and Postgres reachable | identity resolved | this replica has hydrated |
| `/health/live` | the probe loop is turning | both loops are turning | both loops are turning |

**Startup is a one-way latch everywhere**: once green it never goes back. The API's covers schema
migration, which is why its budget is the generous one. On both console services it flips on a
loop's first beat — the liveness loop on the processor, the hydration loop on the orchestrator —
deliberately ahead of any dependency work, so a dependency outage can never fail it and can never
turn a slow broker into a `CrashLoopBackOff`.

**Readiness is the only probe allowed to sit red for the length of an outage and recover without a
restart**, which is why each workload puts its "no restart will help" condition here — and why the
three conditions have nothing in common:

- The API fails readiness on its startup check and on Postgres. Redis and the broker appear on the
  readiness body but are capped at `Degraded`: they are hard dependencies for the control paths and
  no dependency at all for CRUD, so they are reported without being able to pull the pod out of the
  Service.
- The processor reports identity resolution, and stays red until a processor row matching the
  image's `SourceHash` exists — the registration section above is the whole story. `0/1 READY`
  there is the system working, not a fault.
- The orchestrator reports that this replica has finished rebuilding its L1 mirror from L2. No
  Service routes traffic to these pods, so a readiness failure pulls nothing; all it gates is the
  `READY` column, where `0/1` means "still hydrating". It is load-bearing together with
  `podManagementPolicy: Parallel`: under the default `OrderedReady` a readiness-gated pod would
  block the next replica's creation, and a slow Redis would become a whole-service non-deploy.

**Liveness deliberately consults nothing external, on any of the three.** That is a rule rather than
an accident — every `live`-tagged check is either `self` or a loop heartbeat. A broker or Redis
outage must not restart these pods: the startup loops are built to retry against it indefinitely,
and a restart only discards the backoff progress and starts the wait again.

## Teardown

```bash
kubectl delete -k k8s/
```

Redis is ephemeral by design and leaves nothing behind. Postgres and RabbitMQ each keep a per-pod
PVC, and `kubectl delete -k` does not remove them — a StatefulSet's claims outlive it deliberately.
For a genuinely clean start:

```bash
kubectl -n skp delete pvc --all
```

Worth knowing before you interpret a re-deploy: without that, a fresh Postgres comes back with the
old schema and rows, so a processor row registered in a previous run is still there and the pods go
ready immediately.

## Resilience scenarios

`src/tests/BaseApi.Tests/Live/Resilience` drives **seven** timed orchestrations against this
namespace and verifies them from Elasticsearch records:

- **S1** happy path, **S2** Redis unavailable, **S3** RabbitMQ unavailable, **S4** both unavailable,
  **S5** Redis scaled to zero (an L2 wipe, not an outage) — these five take a *dependency* away.
- **S6** processor unavailable, **S7** orchestrator unavailable — these two take a *worker* away
  instead, scaling the processor Deployment and the orchestrator StatefulSet to zero in turn.

Each scenario takes 7-8 minutes; a full pass of all seven is roughly an hour. They assume exclusive
use of the cluster: a workflow started by someone else mid-soak is attributed to the scenario, and
running them concurrently races independent restore paths across the same objects — the test project
enforces serialisation itself, so this is a correctness note, not an instruction to add locking.

They are gated on **two** environment variables — `SKP_REALSTACK=1` and `SKP_CHAOS=1` — because they
pause Redis and scale StatefulSets/Deployments to zero. `SKP_REALSTACK=1` alone runs the read-only
live tests and never touches infrastructure.

Run one scenario at a time, by name — this is the form the implementation plans prescribe, and the
only way to see a scenario's `TestOutputHelper` output, which the runner hides for a passing test:

```
./k8s/port-forward-realstack.ps1
$env:SKP_REALSTACK = "1"; $env:SKP_CHAOS = "1"
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj -- --filter-method "*ScenarioName*"
```

The bare `--` before `--filter-method` is load-bearing: without it, MSBuild parses the switch itself
and rejects it rather than passing it through to the test runner. Running the whole
`BaseApi.Tests.csproj` project without a filter runs all seven back to back, in the same order.

The forward script supervises what it starts, and needs to: `kubectl port-forward` exits on
`error: lost connection to pod`, and RabbitMQ provokes that reliably — a client aborting the AMQP
handshake mid-`starting`, which is what cancelling a processor boot looks like to the broker, makes
it reset the connection. The forward is collateral, so the test that caused it usually passes and
every broker-dependent test *after* it fails on a one-to-two-minute timeout that reads exactly like
an identity-resolution bug. Unsupervised, that is three failures and a five-minute suite; supervised
it is zero and fifty seconds. Two more switches:

```
./k8s/port-forward-realstack.ps1 -Status   # which forwards are up, and how often each has restarted
./k8s/port-forward-realstack.ps1 -Stop     # tear down the forwards and their supervisors
```

`-Status` showing restarts against `rabbitmq` and zero elsewhere is the healthy picture, not a
warning. Per-forward logs are in `%TEMP%\skp-port-forwards\`.

Four notes an operator will otherwise learn the hard way:

- **NetworkPolicy does nothing here.** kindnetd runs without `--network-policy`, so a policy is
  accepted by the API server and enforced by nothing. Redis is made unavailable with
  `redis-cli CLIENT PAUSE ... ALL`, which also expires on its own so a killed run cannot wedge the
  cluster.
- **Never scale Redis down to simulate an outage.** It runs `--save "" --appendonly no` with no PVC,
  so scaling to zero wipes L2 rather than interrupting it. That is scenario S5, which asserts a
  bounded blast radius rather than zero loss.
- **RabbitMQ scale-down is safe**, because its StatefulSet has a 1Gi PVC on the mnesia directory.
- **After S5, confirm re-projection before walking away.** It deliberately wipes L2 — the projected
  workflow and every processor liveness key are gone, not merely unavailable — and the scenario's own
  assertions only prove the *pipeline* recovered, not that an operator glancing at the cluster
  afterward will see a workflow. Check with
  `curl -s http://localhost:18080/api/v1/workflows` before leaving.

Design: `docs/superpowers/specs/2026-08-22-live-stack-resilience-scenarios-design.md`

## Seeding files for processor-filefetcher

`processor-filefetcher` reads absolute paths under `/mnt/skp-files/in`, mounted read-only from the
kind node. **That path is on the node container, not on Windows** — the node was created without
`extraMounts` and Docker cannot add one to a running container. `processor-archiveexpander`, one hop
downstream, never sees a path at all — it reads the envelope FileFetcher already built.

Put a file where the pod can read it:

    docker cp ./orders.zip desktop-control-plane:/mnt/skp-files/in/

Then the Kafka record the importer consumes names it:

    {"filePath": "/mnt/skp-files/in/orders.zip"}

It survives pod restarts and the `kind load` + SourceHash-repoint deploy loop. Only recreating the
cluster loses it.

### The FileFetcher / ArchiveExpander workflow

`KafkaImporter → FileFetcher → ArchiveExpander → KafkaExporter`. **Every edge is `entryCondition: 1`
(`PreviousCompleted`), not `4` (`Always`).**

`Always` is what the sample steps use, and copying it here is a live bug rather than a style
choice: a failed importer hands off with `ExecutionId` empty, and an `Always`-wired downstream step
then runs on an entry-shaped dispatch every time the step before it fails — on the
`FileFetcher → ArchiveExpander` edge specifically, that means expanding a file that was never
fetched. That is the class of error `BaseImporter`'s edge guard exists to make impossible. `0`
(`PreviousProcessing`) is rejected by the step validator and is also what an omitted field binds to,
which is why the value is always stated.

`processor-filefetcher` takes an absolute path, admits the file against an extension whitelist and a
size range without opening it, and emits the file's bytes with its identity. Its step payload:

    {"allowedExtensions": [".zip"], "minimumSizeBytes": 0, "maximumSizeBytes": 33554432}

`maximumSizeBytes` must not exceed the pod's `FileFetcher__MaxFileSizeBytes`, or every dispatch fails
with a config error naming both numbers. It bounds the file on disk, and only the file — what an
archive expands to is a separate limit, one hop downstream.

`processor-archiveexpander` takes that envelope and expands archives to the step's `maxDepth`,
producing the same document as before. Its step payload:

    {"maxDepth": 1}

`maxDepth` is optional and defaults to 1 — the top-level archive is expanded and its entries are
left as files. The default comes from an omitted field, not a zero: `0` is a rejected payload, as is
anything above 64. Raise it to open archives inside archives:

    {"maxDepth": 2}

The cumulative size of everything an archive expands to, across every level, is no longer a step
field — it moved to the pod-level `ArchiveExpander__MaxExpandedBytes`, a memory guard an operator
sizes against the container limit rather than a number a workflow author could ever have known.

**Check the registered output schema before raising `maxDepth`.** The schema states its depth
structurally and is a row against the processor identity, so it caps every workflow using this
processor — the baseline admits depth 1. A step producing a document deeper than the schema admits
fails validation in the post handler, which reports `Failed` with `EntryId: Guid.Empty` and no file
path. The processor logs the depth it actually reached (`expanded to depth N of M`); that line is the
only place the number survives.

### Verifying processor-filefetcher and processor-archiveexpander

Four steps, in this order, and a test that proves each one landed. The order matters: step 3 is what
makes every later assertion mean anything, and running the live suite before it passes vacuously.

**1. Build, load, repoint both hashes.**

```bash
docker build -f src/Processor.FileFetcher/Dockerfile -t processor-filefetcher:local .
docker build -f src/Processor.ArchiveExpander/Dockerfile -t processor-archiveexpander:local .
kind load docker-image processor-filefetcher:local
kind load docker-image processor-archiveexpander:local
```

Then repoint both processor rows' `SourceHash` to this build's. Every rebuild needs it — the value
changes on any source edit, and a pod whose hash matches no row resolves no identity. `dotnet build`
prints both (`SourceHash (Processor.FileFetcher): …` and `SourceHash (Processor.ArchiveExpander): …`),
and the live suite reads them from the assembly rather than a constant, so neither ever needs pasting
into a test.

**2. Delete the retired Deployment, apply the manifests, then restart both.**

`processor-filereader` was renamed to `processor-archiveexpander`, not edited in place — `kubectl
apply` matches on `metadata.name`, so applying the rename over the old name creates a second
Deployment and leaves the first one running, a retired pod still consuming from its queue under an
identity row that is about to change beneath it. Delete it before applying:

```bash
kubectl delete deployment processor-filereader -n skp --ignore-not-found
kubectl apply -k k8s/
kubectl -n skp rollout restart deploy/processor-filefetcher
kubectl -n skp rollout restart deploy/processor-archiveexpander
```

Neither Deployment exists before this step — `processor-filefetcher` is brand new and
`processor-archiveexpander` only exists once the apply above creates it — so the restarts must come
after the apply, not before it. The `:local` tag and `imagePullPolicy: IfNotPresent` mean a rebuilt
image does not reach a running pod on its own, which is what the restart is for.

**`kubectl rollout status` will time out on both, and that timeout is the expected signal.** Each pod
sits Running/NotReady with 0 restarts until its own processor row exists — it waits by design rather
than crashing, so a `CrashLoopBackOff` here means something else is wrong.

**3. Register the two schema rows, and point all three processor rows at them.**

**Two rows, not four or six.** `file-fetcher`, `archive-expander` and `archive-collapser` all touch
only two shapes between them — an envelope (`{fileName, extension, sizeBytes, createdUtc,
modifiedUtc, content}`) and a tree (`{metadata, content}`, nested to depth 2) — and
`SchemaEdgeValidator` (`src/BaseApi.Service/Features/Orchestration/Validation/SchemaEdgeValidator.cs`)
compares a parent's `OutputSchemaId` against a child's `InputSchemaId` by **id equality**, not by
comparing definitions. So every processor on a given edge must point at the *same row* — two rows
holding byte-identical JSON under two different ids are still, to the validator, an unwireable edge,
and publishing a workflow across them throws a 422 naming the pair.

| processor | inputSchemaId | outputSchemaId |
|---|---|---|
| `file-fetcher` | *(null — it is a source)* | **envelope** |
| `archive-expander` | **envelope** | **tree** |
| `archive-collapser` | **tree** | **envelope** |

The same two GUIDs appear five times across three rows. That is what makes `FileFetcher →
ArchiveExpander → ArchiveCollapser` (and `ArchiveCollapser` back into a second `FileFetcher →
ArchiveExpander` hop, since its output shape is the same envelope FileFetcher produces) a wireable
chain, and any other pairing a publish-time rejection instead of a silent no-op.

**Create the two rows.** The endpoint is `POST /api/v1/schemas` — URL-segment versioning substitutes
`{version:apiVersion}` with the bare major version (`opts.GroupNameFormat = "'v'VVV"` in
`HttpServiceCollectionExtensions.cs`), so the route is `/api/v1/schemas`, not `/api/v1.0/schemas`.
The body is `SchemaCreateDto` (`src/BaseApi.Service/Features/Schema/SchemaDtos.cs`): `name`,
`version`, `description` and `definition`, where **`definition` is a string** — the whole schema
document, serialized to text, not embedded as nested JSON — validated by
`SchemaCreateDtoValidator` as parseable JSON that is itself a valid draft 2020-12 schema. `jq -Rs`
slurps a file into exactly that string:

```bash
kubectl -n skp port-forward svc/baseapi-service 18080:8080 &

ENVELOPE=$(curl -s -X POST http://localhost:18080/api/v1/schemas \
  -H 'Content-Type: application/json' \
  -d "$(jq -Rs '{name:"file-envelope", version:"1.0.0", \
                 description:"FileFetcher/ArchiveCollapser output, ArchiveExpander input", \
                 definition:.}' \
        src/tests/BaseApi.Tests/Schemas/envelope.json)")
ENVELOPE_ID=$(echo "$ENVELOPE" | jq -r '.id')

TREE=$(curl -s -X POST http://localhost:18080/api/v1/schemas \
  -H 'Content-Type: application/json' \
  -d "$(jq -Rs '{name:"file-tree", version:"1.0.0", \
                 description:"ArchiveExpander output, ArchiveCollapser input", \
                 definition:.}' \
        src/tests/BaseApi.Tests/Schemas/tree.json)")
TREE_ID=$(echo "$TREE" | jq -r '.id')
```

**Point all three processor rows at them.** The endpoint is `PUT /api/v1/processors/{id}` with
`ProcessorUpdateDto` (`src/BaseApi.Service/Features/Processor/ProcessorDtos.cs`): `name`, `version`,
`description`, `sourceHash`, `inputSchemaId`, `outputSchemaId`, `configSchemaId` — **all seven
fields**, because `PUT` replaces the row rather than patching it, so `name`/`version`/`description`/
`sourceHash` must be read back from the existing row (via `GET
/api/v1/processors/by-source-hash/{sourceHash}`) and echoed unchanged, or the update silently
overwrites them:

```bash
for NAME_HASH in "file-fetcher:$FILEFETCHER_HASH" \
                  "archive-expander:$ARCHIVEEXPANDER_HASH" \
                  "archive-collapser:$ARCHIVECOLLAPSER_HASH"; do
  NAME="${NAME_HASH%%:*}"; HASH="${NAME_HASH##*:}"

  ROW=$(curl -s "http://localhost:18080/api/v1/processors/by-source-hash/$HASH")
  ID=$(echo "$ROW" | jq -r '.id')

  case "$NAME" in
    file-fetcher)      IN=null;             OUT="\"$ENVELOPE_ID\"" ;;
    archive-expander)   IN="\"$ENVELOPE_ID\""; OUT="\"$TREE_ID\"" ;;
    archive-collapser)  IN="\"$TREE_ID\"";      OUT="\"$ENVELOPE_ID\"" ;;
  esac

  curl -s -X PUT "http://localhost:18080/api/v1/processors/$ID" \
    -H 'Content-Type: application/json' \
    -d "$(echo "$ROW" | jq --argjson in "$IN" --argjson out "$OUT" \
          '{name, version, description, sourceHash, \
            inputSchemaId: $in, outputSchemaId: $out, configSchemaId}')"
done
```

Replace `$FILEFETCHER_HASH` / `$ARCHIVEEXPANDER_HASH` / `$ARCHIVECOLLAPSER_HASH` with the three
hashes `dotnet build` printed for this build (`SourceHash (Processor.FileFetcher): …`, etc. — see
Step 1 above). `configSchemaId` is carried through from `$ROW` unchanged; none of the three
processors uses one.

**This is a correction against the task plan's draft `curl` bodies, which were an explicit,
unverified guess at the DTO shape.** Checked against the real source: the schema create endpoint is
`/api/v1/schemas`, not `/api/v1.0/schemas` (URL-segment versioning renders the bare major version,
confirmed by `ProcessorsController`'s own `/api/v1/processors/by-source-hash/...` route, which the
live tests already call); the processor side is a `PUT` to `/api/v1/processors/{id}` with the full
seven-field `ProcessorUpdateDto`, not a two-field patch — there is no partial-update verb, so the
four fields the plan never mentioned (`name`, `version`, `description`, `sourceHash`) have to be
read back from the existing row or the update erases them.

**Do not skip either schema.** With `OutputSchemaId` null, `TryValidate` returns true without decoding
anything: shape, entry count and depth are enforced nowhere, and a document arriving on the out
topic proves only that a document was produced. All three pods should reach Ready once their rows
exist (unready was never about the schema ids — see the identity-resolution note above — but a
missing schema id is the failure mode this step exists to close).

`ArchiveExpanderLiveTests.TheOutputSchemaRowIsRegistered` proves ArchiveExpander's half landed: it
asks BaseApi for that row by this build's source hash and fails with the step that was missed — no
row means the image was rebuilt without repointing, a null `OutputSchemaId` means the schema was
never registered. `FileFetcherLiveTests.TheOutputSchemaRowIsRegistered` is the same proof one hop
upstream, for FileFetcher's own row. `ArchiveCollapserLiveTests.TheSchemaRowsAreRegistered` is the
same proof for ArchiveCollapser's row, both ids at once; and
`ArchiveCollapserLiveTests.TheCollapserInputIdEqualsTheExpanderOutputId` is the one assertion in the
whole suite that catches the two rows drifting apart — a passing `TheSchemaRowsAreRegistered` on
both sides only proves each id is non-null, not that they are the *same* id.

**4. Wire the workflow.**

`KafkaImporter → FileFetcher → ArchiveExpander → KafkaExporter`, every edge `entryCondition: 1`,
payloads as above.

#### Running the live tests

    .\k8s\port-forward-realstack.ps1
    .\tools\kafka-dev-broker.ps1 -Up
    $env:SKP_REALSTACK = "1"
    dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj

They seed files onto the node with `docker cp`, so the kind node must be running. Eight tests now
live in two suites, split along the same line as the processors: `FileFetcherLiveTests` owns what
only the fetcher can answer — the mount, the seeding, the manifest's file ceiling, its own log line
— and `ArchiveExpanderLiveTests` keeps the end-to-end assertion on the exporter's out topic plus
everything that is genuinely about expansion. What each proves:

| Test | Suite | What only the cluster can answer |
| --- | --- | --- |
| `ASeededFileBecomesAnEnvelope` | FileFetcherLiveTests | The mount and the fetch succeed, from the fetcher's own log line |
| `AFileWithTheWrongExtensionProducesNoDocument` | FileFetcherLiveTests | The edge is `PreviousCompleted`, not `Always`, and the rejection names the path in the log |
| `TheOutputSchemaRowIsRegistered` | FileFetcherLiveTests | FileFetcher's own output schema is enforcing at all |
| `AZipOnTheNodeBecomesADocumentOnTheOutTopic` | ArchiveExpanderLiveTests | The mount, both manifests' ceilings, the wiring, end to end |
| `TheOutputSchemaRowIsRegistered` | ArchiveExpanderLiveTests | ArchiveExpander's own output schema is enforcing at all — step 3 landed |
| `AtTheDefaultDepthANestedZipStaysAFile` | ArchiveExpanderLiveTests | Nesting did not change what an existing workflow emits |
| `ACorruptZipFailsAndLogsTheFileName` | ArchiveExpanderLiveTests | A corrupt archive fails diagnosably even though ArchiveExpander has no path to log — only a file name |
| `ADocumentDeeperThanTheSchemaFailsAndLogsTheDepth` | ArchiveExpanderLiveTests | A schema rejection is diagnosable |

`ACorruptZipFailsAndLogsTheFileName` is a rename of what used to be
`ACorruptZipFailsWithThePathInTheLog`. FileReader used to log a path on this failure; ArchiveExpander
receives only an envelope from FileFetcher now and has no path to log, so the assertion moved to the
file name ArchiveExpander does carry. The "the path reaches the log store" guarantee that test used
to stand for did not disappear — it moved with the path, to FileFetcher's own rejection template
(`file {path} rejected: ...`, unchanged from FileReader), which is what
`AFileWithTheWrongExtensionProducesNoDocument` now also asserts on.

The last one **skips unless `SKP_FILEREADER_DEEP_TOPIC` names the input topic of a second workflow
whose ArchiveExpander step is wired `maxDepth: 2`** — the variable keeps its FileReader-era name on
purpose, to avoid a mismatch with the value an operator already has set. Depth is a step payload, so
one wired workflow has one depth and no message can ask for another. Wire that second workflow only
when you intend to raise depth in earnest; the test exists so that raising it without deepening the
schema is a diagnosable failure rather than a silent one.

**`ArchiveCollapserLiveTests` skips the same way, unless both `SKP_ARCHIVECOLLAPSER_IN_TOPIC` and
`SKP_ARCHIVECOLLAPSER_OUT_TOPIC` are set.** Nothing in this repo wires a workflow for
ArchiveCollapser — an operator must wire one as `KafkaImporter → ArchiveCollapser → KafkaExporter`
and point the two variables at its in and out topics before either test in that suite can run for
real; unset (the default), they skip naming exactly what to set rather than failing confusingly
against topics nothing provisions.

#### Three ways to read a false result here

- **The RabbitMQ forward dies on most runs.** Supervise it, or read its five downstream failures as
  real ones.
- **Never `netstat` the default ports** to judge reachability. The forwards are on offset ports, and
  a dead forward keeps its socket bound — the port looks free and refuses connections.
- **Never scale Redis down.** It wipes L2, and the branch outputs go with it.
