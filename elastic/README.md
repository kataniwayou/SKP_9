# elastic/

Hand-applied Elasticsearch and Kibana objects for the operator dashboard. Nothing here is
provisioned by kustomize — the same posture as `grafana/dashboards/*.json`, which are
hand-imported. Design: `docs/superpowers/specs/2026-09-22-kibana-operator-dashboard-design.md`.

Kibana itself IS manifested, at `k8s/24-kibana.yaml`. Elasticsearch deliberately is not — it runs
from an out-of-band apply and adopting it into `k8s/` is a separate decision.

## Install order, and why it is an order

1. `entity-names-index.json` → `PUT skp-entity-names`. The policy names this index, so it must
   exist first.
2. `enrich-policy.json` → `PUT _enrich/policy/skp-entity-lookup`.
3. `POST _enrich/policy/skp-entity-lookup/_execute`. Until this runs, the policy matches nothing.
4. `logs-custom-pipeline.json` → `PUT _ingest/pipeline/logs@custom`. Elasticsearch REJECTS an
   `enrich` processor naming a policy that does not exist, so this genuinely cannot be first.
5. `kibana-export.ndjson` → Kibana → Stack Management → Saved Objects → Import.

Steps 1–3 are exactly what `tools/sync-entity-names.py` does, and it is the supported way to run
them. Re-run it after publishing any workflow, step or processor: enrich reads a point-in-time
snapshot, and a new entity shows its raw GUID until the policy is executed again.

## Changing the pipeline

`logs@custom` is *created*, never an edit to anything managed. `logs@default-pipeline` calls it
through `{"pipeline": {"name": "logs@custom", "ignore_missing_pipeline": true}}`, which is part of
the stock `logs` index template — so an Elasticsearch upgrade that replaces the managed pipeline
keeps calling this one. Never edit `logs@default-pipeline` itself.

After any edit, run the fixture before applying:

```
curl -s -H 'Content-Type: application/json' \
  -XPOST 'http://localhost:19200/_ingest/pipeline/_simulate' \
  --data-binary @elastic/simulate-outcome-classification.json
```

## Changing the enrich policy

Elasticsearch will not update a policy in place. Delete it, then re-run the sync:

```
curl -XDELETE 'http://localhost:19200/_enrich/policy/skp-entity-lookup'
python tools/sync-entity-names.py
```

A delete fails while an ingest pipeline still references the policy, so remove `logs@custom` first
if you hit that.
