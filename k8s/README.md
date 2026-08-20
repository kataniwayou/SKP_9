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

| Probe | Answers | Fails when |
|---|---|---|
| `/health/startup` | the loops are running | never, in practice — it flips on the liveness loop's first beat |
| `/health/ready` | identity and schemas resolved | no matching processor row, or the API is unreachable |
| `/health/live` | the loops are still turning | a loop has wedged or died |

Liveness deliberately consults nothing external. A broker or Redis outage must not restart these
pods: the startup loop is built to retry against it indefinitely, and a restart only discards the
backoff progress and starts the wait again.

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
