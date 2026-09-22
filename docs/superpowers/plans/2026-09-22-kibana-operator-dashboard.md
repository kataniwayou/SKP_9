# Kibana Operator Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy Kibana beside the existing Elasticsearch and give an operator one generic dashboard that answers, for any published workflow, "is it running, and if something is wrong, which step is it?"

**Architecture:** An ingest-time `logs@custom` pipeline enriches every newly indexed log record with human-readable workflow/step/processor names from a lookup index, and stamps `skp.outcome_record: true` on exactly the subset of records that constitute one step outcome. A `tools/` script feeds the lookup index from the BaseApi REST routes and re-executes the enrich policy. Kibana reads the enriched fields through one data view backing four chained controls, a stacked-bars Lens, a pie Lens and a Discover drill-down.

**Tech Stack:** Elasticsearch 8.15.5 (basic license, enrich processor, ingest pipeline `_simulate`), Kibana 8.15.5, kustomize, Python 3 with `requests` (stdlib + `requests` only — **there is no pytest in this environment and this plan does not introduce one**), kubectl/kind.

**Spec:** `docs/superpowers/specs/2026-09-22-kibana-operator-dashboard-design.md` — read it before Task 1. Every section reference below (§4.1, §6.5, §9…) points into it. The spec is the argument; this plan is the execution.

## Global Constraints

- **Elasticsearch is 8.15.5 and is NOT adopted into `k8s/`.** It runs from an out-of-band apply (`elasticsearch-0`, Service `elasticsearch:9200`). Do not write a manifest for it. (§2)
- **Kibana is pinned to 8.15.5**, patch-exact, never a floating tag. Kibana refuses to start against a different ES minor. (§10)
- **Licence is `basic`.** No feature requiring gold/platinum. No alerting, no Watcher, no Kibana rule. (§2)
- **The ingest pipeline must never drop a document.** Every processor that can fail carries `ignore_missing`/`ignore_failure` as appropriate, and the pipeline carries a top-level `on_failure` that stamps `skp.enrich_error` and lets the document through. (§6.5)
- **`logs@custom` is created, never edited into a managed pipeline.** Do not modify `logs@default-pipeline` or the `logs` index template. (§6.5)
- **The counted set is a scope PREFIX plus one named template, never a template list.** `scope.name` starting `BaseProcessor.Core.Processing.` with `attributes.Result` present, OR `scope.name == Orchestrator.Messaging.StepOutcomeHandler` AND template == the terminal-step one AND `Result == "Completed"`. Getting either half wrong is the defect the whole spec is written around. (§4.1, §4.2)
- **Kibana saved objects are hand-exported NDJSON, hand-imported.** No provisioning ConfigMap, matching how `grafana/dashboards/*.json` is handled. (§8)
- **`k8s/` manifests use memory-only `resources`.** There is no `cpu` key anywhere in `k8s/` and this plan does not add the first one.
- **Every string field in the log index is mapped `keyword`** by the `all_strings_to_keywords` dynamic template. `match`/`match_phrase` silently return zero hits. Use `term`, `prefix`, `wildcard`. (§7.4)
- **Host access is 127.0.0.1 port-forwards on offset ports.** ES is `localhost:19200`, BaseApi is `localhost:18080`. Kibana gets `15601`. Everything stays ClusterIP; no NodePort, no Ingress.
- **Enrichment is forward-only.** Records already in the index keep their GUIDs; there is no reindex. (§6.3)

---

## File Structure

| file | responsibility |
|---|---|
| `k8s/24-kibana.yaml` | Kibana 8.15.5 Service + Deployment. Nothing else; no ES, no saved objects. |
| `k8s/kustomization.yaml` | *modify* — add `24-kibana.yaml` after `23-grafana.yaml`. |
| `k8s/port-forward-realstack.ps1` | *modify* — add the eighth forward, `kibana 15601:5601`. |
| `elastic/README.md` | What lives in `elastic/`, and the exact install order (index → policy → execute → pipeline). The pipeline is useless before the policy exists. |
| `elastic/entity-names-index.json` | Mapping for `skp-entity-names`: three `keyword` fields. Separate from the policy because the index must exist before the policy can name it. |
| `elastic/enrich-policy.json` | `skp-entity-lookup`, `match` on `entity_id`. |
| `elastic/logs-custom-pipeline.json` | The `logs@custom` body of §6.5. The single source of truth for what an outcome record is. |
| `elastic/simulate-outcome-classification.json` | `_ingest/pipeline/_simulate` fixture: one document per template of §4, plus an unmatched-GUID document and a `Result`-less one. This is the test suite for the pipeline. |
| `elastic/kibana-export.ndjson` | Data view, 2 Lens panels, saved search, dashboard. Hand-imported. |
| `tools/sync-entity-names.py` | BaseApi REST → `skp-entity-names` → re-execute the policy. On demand and after any publish. |
| `tools/verify-kibana-dashboard.py` | §9 checks 1–7 and 9, executable. Check 8 stays manual (a UI click). |
| `docs/testing/kibana-operator-dashboard.md` | Operator notes: the §4.4 healthy shape, the keyword caveat, the forward-only window, and the best-effort-log caveat of §10. |

---

## Task 1: Kibana reachable

Kibana first, because every later task is verified through it or beside it, and because a version mismatch with ES is a hard stop worth discovering before any ES object exists.

**Files:**
- Create: `k8s/24-kibana.yaml`
- Modify: `k8s/kustomization.yaml`
- Modify: `k8s/port-forward-realstack.ps1:46-54`
- Create: `tools/verify-kibana-dashboard.py`

**Interfaces:**
- Consumes: the running `elasticsearch` Service on `:9200` in namespace `skp`.
- Produces: Kibana Service `kibana:5601` in `skp`, reachable from the host at `http://localhost:15601`. Later tasks assume that URL. Also produces the `Checks` harness in `tools/verify-kibana-dashboard.py` — `Checks.report(number, title, ok, detail)` — which Tasks 2, 3, 4 and 5 all extend.

- [ ] **Step 1: Write the failing test**

Create `tools/verify-kibana-dashboard.py` with only check 1 for now. Later tasks extend the same file.

```python
#!/usr/bin/env python3
"""
Executable form of section 9 of docs/superpowers/specs/2026-09-22-kibana-operator-dashboard-design.md.

Every check prints PASS or FAIL with the measured numbers beside it, and the script exits non-zero
if any check failed. Check 8 (a drill-down click) is not here: it is a UI action and is listed in
docs/testing/kibana-operator-dashboard.md as the one manual step.

RUN THIS FROM POWERSHELL against live port-forwards:
    ./k8s/port-forward-realstack.ps1
    python tools/verify-kibana-dashboard.py
"""
import argparse
import sys

import requests

DEFAULT_ES = "http://localhost:19200"
DEFAULT_KIBANA = "http://localhost:15601"
DEFAULT_API = "http://localhost:18080"
DATA_STREAM = "logs-generic.otel-default"

# The chain this dashboard is VALIDATED against, not the one it is built for (spec section 1).
VALIDATION_WORKFLOW = "filefetcher-archiveexpander-chain"


class Checks:
    """Collects results so one failure does not hide the checks after it."""

    def __init__(self):
        self.failures = 0

    def report(self, number, title, ok, detail):
        print(f"[{'PASS' if ok else 'FAIL'}] check {number}: {title} - {detail}")
        if not ok:
            self.failures += 1
        return ok


def check_1_kibana_reaches_es(checks, kibana_url):
    """Kibana is up and its Elasticsearch connection is green."""
    try:
        response = requests.get(f"{kibana_url}/api/status", timeout=15)
        body = response.json()
        overall = body["status"]["overall"]["level"]
        es_plugin = body["status"]["core"]["elasticsearch"]["level"]
    except Exception as exc:  # noqa: BLE001 - any failure here IS the check failing
        return checks.report(1, "Kibana reaches ES", False, f"{type(exc).__name__}: {exc}")
    ok = overall == "available" and es_plugin == "available"
    return checks.report(1, "Kibana reaches ES", ok,
                         f"overall={overall} elasticsearch={es_plugin}")


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--kibana-url", default=DEFAULT_KIBANA)
    parser.add_argument("--es-url", default=DEFAULT_ES)
    parser.add_argument("--api-url", default=DEFAULT_API)
    args = parser.parse_args()

    checks = Checks()
    check_1_kibana_reaches_es(checks, args.kibana_url)

    print()
    print(f"{checks.failures} check(s) failed")
    return 1 if checks.failures else 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `python tools/verify-kibana-dashboard.py`
Expected: `[FAIL] check 1: Kibana reaches ES - ConnectionError: ...` — nothing is listening on 15601.

- [ ] **Step 3: Write the manifest**

Create `k8s/24-kibana.yaml`. The header comment carries the decisions, matching the house style of `23-grafana.yaml`.

```yaml
# ============================================================================
# kibana — log exploration UI for the operator dashboard (ClusterIP Service + Deployment).
# ============================================================================
# Like 23-grafana.yaml this has NO compose ancestor, so the header records decisions
# rather than a port record.
#
# IMAGE PIN — 8.15.5, patch-exact, and it MUST equal the Elasticsearch version. Kibana
# refuses to start against a different ES minor and says so in one line at boot.
# Upgrade the two together or not at all.
#
# ELASTICSEARCH IS NOT MANIFESTED HERE, DELIBERATELY. ES 8.15.5 runs in this namespace
# from an out-of-band apply; there is no manifest for it in k8s/. This file adds Kibana
# BESIDE that, and adopting ES into k8s/ is a separate decision about what k8s/ owns.
# So this manifest depends on a Service it does not declare, which the design calls out
# as a known asymmetry and not an oversight.
#
# NO PERSISTENCE VOLUME, AND UNLIKE GRAFANA THAT COSTS NOTHING. Kibana keeps its saved
# objects in the .kibana* indices INSIDE Elasticsearch, not on local disk, so a pod
# recreate loses no dashboard. There is no emptyDir here because there is nothing to
# put in one.
#
# THE THREE ENCRYPTION KEYS ARE FIXED, NOT GENERATED. Without them Kibana mints a random
# key at every boot, logs three warnings, and any saved object with an encrypted field
# becomes unreadable after a restart. They are plain values for the same reason the
# Grafana admin password is: the in-cluster ES and Prometheus are both unauthenticated,
# everything is ClusterIP behind a loopback port-forward, and auth hardening is out of
# scope. Putting them in skp-dev-secrets would imply a security property this posture
# does not have.
#
# AUTH POSTURE (accepted, not mitigated) — Elasticsearch security is off on this cluster,
# so Kibana needs no credentials and presents no login. Identical to the Grafana posture.
apiVersion: v1
kind: Service
metadata:
  name: kibana
  namespace: skp
  labels:
    app: kibana
    app.kubernetes.io/part-of: skp
spec:
  # ClusterIP (default) — host reach is the 127.0.0.1:15601 forward in port-forward-realstack.ps1.
  selector:
    app: kibana
  ports:
    - port: 5601
      targetPort: 5601
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: kibana
  namespace: skp
  labels:
    app: kibana
    app.kubernetes.io/part-of: skp
spec:
  replicas: 1
  selector:
    matchLabels:
      app: kibana
  template:
    metadata:
      labels:
        app: kibana
    spec:
      securityContext:
        # the official image already defaults to uid 1000 (kibana); pinning it makes that
        # explicit so the container can never silently run as root — same rule as grafana's 472.
        runAsUser: 1000
        runAsGroup: 0
        fsGroup: 1000
      containers:
        - name: kibana
          image: docker.elastic.co/kibana/kibana:8.15.5
          ports:
            - containerPort: 5601
          env:
            # bare Service DNS; the ES Service is out-of-band but its name is stable
            - name: ELASTICSEARCH_HOSTS
              value: "http://elasticsearch:9200"
            - name: SERVER_NAME
              value: "kibana"
            # 0.0.0.0, or Kibana binds loopback INSIDE the container and the probe never passes
            - name: SERVER_HOST
              value: "0.0.0.0"
            # the browser reaches Kibana through the host forward, and generated links
            # (drill-downs, shared URLs) must point there rather than at the Service DNS
            - name: SERVER_PUBLICBASEURL
              value: "http://localhost:15601"
            # fixed dev keys — see THE THREE ENCRYPTION KEYS in the header. 32 chars each.
            - name: XPACK_SECURITY_ENCRYPTIONKEY
              value: "skpdevkibanasecurity000000000000"
            - name: XPACK_ENCRYPTEDSAVEDOBJECTS_ENCRYPTIONKEY
              value: "skpdevkibanasavedobjects00000000"
            - name: XPACK_REPORTING_ENCRYPTIONKEY
              value: "skpdevkibanareporting00000000000"
            # no outbound calls from a dev cluster (same rule as grafana's analytics pair)
            - name: TELEMETRY_ENABLED
              value: "false"
            - name: TELEMETRY_OPTIN
              value: "false"
            # Kibana's node process sizes its heap from the cgroup and will happily exceed the
            # 1536Mi limit and OOMKill. Cap it under the limit.
            - name: NODE_OPTIONS
              value: "--max-old-space-size=1024"
          # /api/status returns 200 with {"status":{"overall":{"level":"available"}}} once the
          # saved-objects migration has finished. Probe trio matches 23-grafana.yaml.
          startupProbe:
            # 60 × 5s = a 300s budget. Kibana's first boot runs a saved-objects migration
            # against ES and is minutes, not seconds — an order of magnitude past Grafana's ~9s.
            httpGet:
              path: /api/status
              port: 5601
            periodSeconds: 5
            failureThreshold: 60
          readinessProbe:
            httpGet:
              path: /api/status
              port: 5601
            periodSeconds: 10
            timeoutSeconds: 5
            failureThreshold: 3
          livenessProbe:
            httpGet:
              path: /api/status
              port: 5601
            periodSeconds: 15
            timeoutSeconds: 5
            failureThreshold: 6
          resources:
            # memory-only — there is no `cpu` key anywhere in k8s/ and this is not the place to
            # introduce one. Kibana 8.15 idles well above Grafana; the node heap is capped at
            # 1024Mi above and the limit leaves headroom over it for the rest of the process.
            requests:
              memory: "512Mi"
            limits:
              memory: "1536Mi"
```

- [ ] **Step 4: Register it with kustomize**

In `k8s/kustomization.yaml`, add this line immediately after `- 23-grafana.yaml`:

```yaml
  - 24-kibana.yaml
```

- [ ] **Step 5: Add the port-forward**

In `k8s/port-forward-realstack.ps1`, in the `$forwards` array (currently seven entries, lines 46-54), extend the last entry with a comma and add the eighth:

```powershell
    @{ svc = "prometheus";     local = 19090; remote = 9090 },
    @{ svc = "kibana";         local = 15601; remote = 5601 }
```

- [ ] **Step 6: Apply and wait**

```bash
kubectl apply -k k8s/
kubectl -n skp rollout status deployment/kibana --timeout=360s
```

Expected: `deployment "kibana" successfully rolled out`. If it times out, read `kubectl -n skp logs deployment/kibana` — an ES version mismatch says so in one line, and a saved-objects migration in progress says that too and just needs longer.

- [ ] **Step 7: Restart the forwards and run the test**

```bash
pwsh -File k8s/port-forward-realstack.ps1
python tools/verify-kibana-dashboard.py
```

Expected: `[PASS] check 1: Kibana reaches ES - overall=available elasticsearch=available`

- [ ] **Step 8: Commit**

```bash
git add k8s/24-kibana.yaml k8s/kustomization.yaml k8s/port-forward-realstack.ps1 tools/verify-kibana-dashboard.py
git commit -m "feat(k8s): deploy Kibana 8.15.5 beside the out-of-band Elasticsearch

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: The lookup index, the enrich policy, and the sync tool

The pipeline of Task 3 cannot be created before the policy it references exists — Elasticsearch rejects an `enrich` processor naming an unknown policy. So the lookup comes first.

**Files:**
- Create: `elastic/README.md`
- Create: `elastic/entity-names-index.json`
- Create: `elastic/enrich-policy.json`
- Create: `tools/sync-entity-names.py`
- Modify: `tools/verify-kibana-dashboard.py`

**Interfaces:**
- Consumes: BaseApi at `http://localhost:18080`, routes `/api/v1/workflows`, `/api/v1/steps`, `/api/v1/processors`. Each returns a JSON array whose elements carry at least `{"id": "<guid>", "name": "<string>"}` — verified live on 2026-09-22, so no client-side join is needed.
- Produces: index `skp-entity-names` holding documents `{entity_id, entity_name, entity_kind}` where `entity_kind` is one of `workflow`, `step`, `processor`; and an **executed** enrich policy `skp-entity-lookup` matching on `entity_id` and carrying `entity_name` and `entity_kind`. Task 3's pipeline names both by those exact strings.

- [ ] **Step 1: Write the failing test**

Append a check function to `tools/verify-kibana-dashboard.py`:

```python
def check_2a_lookup_is_populated(checks, es_url, api_url):
    """The lookup index holds one row per live entity, and the policy has been executed.

    This is the precondition half of spec check 2: enrichment cannot land if the lookup is
    empty or the policy was never executed after the last sync.
    """
    try:
        counts = {}
        for kind, route in (("workflow", "workflows"), ("step", "steps"),
                            ("processor", "processors")):
            live = requests.get(f"{api_url}/api/v1/{route}", timeout=15).json()
            hit = requests.post(f"{es_url}/skp-entity-names/_count",
                                json={"query": {"term": {"entity_kind": kind}}},
                                timeout=15).json()
            counts[kind] = (len(live), hit.get("count", -1))
        policies = requests.get(f"{es_url}/_enrich/policy/skp-entity-lookup", timeout=15).json()
        enrich_indices = requests.get(
            f"{es_url}/_cat/indices/.enrich-skp-entity-lookup*?format=json", timeout=15).json()
    except Exception as exc:  # noqa: BLE001
        return checks.report("2a", "Lookup populated", False, f"{type(exc).__name__}: {exc}")

    matched = all(live == indexed for live, indexed in counts.values())
    has_policy = bool(policies.get("policies"))
    executed = len(enrich_indices) > 0
    detail = ", ".join(f"{k}: api={v[0]} index={v[1]}" for k, v in counts.items())
    detail += f", policy={has_policy}, .enrich-* indices={len(enrich_indices)}"
    return checks.report("2a", "Lookup populated", matched and has_policy and executed, detail)
```

and call it in `main()` immediately after check 1:

```python
    check_2a_lookup_is_populated(checks, args.es_url, args.api_url)
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `python tools/verify-kibana-dashboard.py`
Expected: `[FAIL] check 2a: Lookup populated - ...` — the index does not exist, so `_count` returns `index_not_found_exception` and each count reads `-1`.

- [ ] **Step 3: Write the two ES object bodies**

`elastic/entity-names-index.json` — the request body for `PUT skp-entity-names`:

```json
{
  "settings": {
    "number_of_shards": 1,
    "number_of_replicas": 0
  },
  "mappings": {
    "properties": {
      "entity_id": { "type": "keyword" },
      "entity_name": { "type": "keyword" },
      "entity_kind": { "type": "keyword" }
    }
  }
}
```

`elastic/enrich-policy.json` — the request body for `PUT _enrich/policy/skp-entity-lookup`:

```json
{
  "match": {
    "indices": "skp-entity-names",
    "match_field": "entity_id",
    "enrich_fields": ["entity_name", "entity_kind"]
  }
}
```

- [ ] **Step 4: Write the sync tool**

Create `tools/sync-entity-names.py`:

```python
#!/usr/bin/env python3
"""
Feeds the GUID -> name lookup that the logs@custom enrich processors read, then re-executes the
policy so the change is actually visible to ingest.

WHY THE BASEAPI AND NOT POSTGRES. One query against the database would replace three HTTP reads,
but it binds this tool to someone else's schema and needs credentials nothing else in tools/
carries -- the existing scripts talk to Kafka and to the API over the network, never to a
datastore directly. The volume makes the cost irrelevant: six workflows, ten steps in the largest,
eight processors.

RE-EXECUTING THE POLICY IS NOT OPTIONAL AND IS WHY THIS IS A SCRIPT. The enrich processor reads a
point-in-time SNAPSHOT of the lookup index, materialised into a hidden .enrich-* index when the
policy is executed. Adding a row changes NOTHING until the policy runs again. Leaving that step to
the operator is the single most likely way for a freshly published workflow to show GUIDs, so this
tool always does it last and offers no flag to skip it.

THE OLD .enrich-* INDEX IS CLEANED UP BY ELASTICSEARCH ITSELF after a successful execute. Do not
delete it by hand: a delete racing a live ingest fails documents that were mid-pipeline.

ENRICHMENT IS FORWARD-ONLY. Running this does not fix documents already in the log index; they
keep their GUIDs forever. There is no reindex.

RUN THIS FROM POWERSHELL, against live port-forwards:
    ./k8s/port-forward-realstack.ps1
    python tools/sync-entity-names.py
"""
import argparse
import json
import sys

import requests

DEFAULT_API = "http://localhost:18080"
DEFAULT_ES = "http://localhost:19200"
INDEX = "skp-entity-names"
POLICY = "skp-entity-lookup"

# route suffix -> the entity_kind stamped on its rows
ROUTES = (("workflows", "workflow"), ("steps", "step"), ("processors", "processor"))


def load_body(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def fetch_entities(api_url, timeout):
    """Three list reads, flattened into lookup rows. No client-side join is needed: every route
    already returns `id` and `name` on each element."""
    rows = []
    for route, kind in ROUTES:
        response = requests.get(f"{api_url}/api/v1/{route}", timeout=timeout)
        response.raise_for_status()
        for entity in response.json():
            rows.append({
                "entity_id": entity["id"],
                "entity_name": entity["name"],
                "entity_kind": kind,
            })
    return rows


def ensure_index(es_url, mapping, timeout):
    """Create the index if absent. An existing index is left alone -- the mapping is three keyword
    fields and has no reason to change, and recreating it would drop rows a concurrent reader is
    using."""
    if requests.head(f"{es_url}/{INDEX}", timeout=timeout).status_code == 200:
        return "exists"
    response = requests.put(f"{es_url}/{INDEX}", json=mapping, timeout=timeout)
    response.raise_for_status()
    return "created"


def bulk_index(es_url, rows, timeout):
    """Upsert by _id = entity_id, so a renamed entity replaces its row rather than duplicating it.

    A row for a DELETED entity is not removed here. It is harmless -- nothing will ever look that
    GUID up again -- and a delete pass would have to distinguish "the API no longer lists it" from
    "the API read failed", which is a far worse failure mode than a stale row.
    """
    lines = []
    for row in rows:
        lines.append(json.dumps({"index": {"_index": INDEX, "_id": row["entity_id"]}}))
        lines.append(json.dumps(row))
    payload = ("\n".join(lines) + "\n").encode("utf-8")
    response = requests.post(f"{es_url}/_bulk?refresh=true", data=payload,
                             headers={"Content-Type": "application/x-ndjson"}, timeout=timeout)
    response.raise_for_status()
    body = response.json()
    if body.get("errors"):
        failed = [item for item in body["items"] if item["index"].get("error")]
        raise RuntimeError(f"bulk reported {len(failed)} failed row(s): {failed[:3]}")
    return len(rows)


def ensure_policy(es_url, policy_body, timeout):
    """PUT is idempotent for an unchanged body, but Elasticsearch REJECTS a changed policy in
    place, so an edit to enrich-policy.json needs the policy deleted first. Say so rather than
    failing opaquely."""
    response = requests.put(f"{es_url}/_enrich/policy/{POLICY}", json=policy_body, timeout=timeout)
    if response.status_code == 400 and "already exists" in response.text:
        return "exists (delete it first if enrich-policy.json changed)"
    response.raise_for_status()
    return "created"


def execute_policy(es_url, timeout):
    response = requests.post(
        f"{es_url}/_enrich/policy/{POLICY}/_execute?wait_for_completion=true", timeout=timeout)
    response.raise_for_status()
    return response.json().get("status", {}).get("phase")


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--api-url", default=DEFAULT_API)
    parser.add_argument("--es-url", default=DEFAULT_ES)
    parser.add_argument("--index-body", default="elastic/entity-names-index.json")
    parser.add_argument("--policy-body", default="elastic/enrich-policy.json")
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--dry-run", action="store_true",
                        help="read the API and print the rows; touch nothing in Elasticsearch")
    args = parser.parse_args()

    rows = fetch_entities(args.api_url, args.timeout)
    print(f"read {len(rows)} entities from {args.api_url}")
    if args.dry_run:
        for row in rows:
            print(f"  {row['entity_kind']:<9} {row['entity_id']}  {row['entity_name']}")
        return 0

    print(f"index {INDEX}: {ensure_index(args.es_url, load_body(args.index_body), args.timeout)}")
    print(f"indexed {bulk_index(args.es_url, rows, args.timeout)} row(s)")
    print(f"policy {POLICY}: "
          f"{ensure_policy(args.es_url, load_body(args.policy_body), args.timeout)}")
    phase = execute_policy(args.es_url, args.timeout)
    print(f"policy executed: phase={phase}")
    if phase != "COMPLETE":
        print("ERROR: policy execution did not complete; enrichment will keep using the previous "
              "snapshot", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 5: Write `elastic/README.md`**

````markdown
# elastic/

Hand-applied Elasticsearch and Kibana objects for the operator dashboard. Nothing here is
provisioned by kustomize — the same posture as `grafana/dashboards/*.json`, which are
hand-imported. Design: `docs/superpowers/specs/2026-09-22-kibana-operator-dashboard-design.md`.

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
````

- [ ] **Step 6: Run the sync and the test**

```bash
python tools/sync-entity-names.py --dry-run
python tools/sync-entity-names.py
python tools/verify-kibana-dashboard.py
```

Expected from the sync: a final line `policy executed: phase=COMPLETE`.
Expected from the test: `[PASS] check 2a: Lookup populated - workflow: api=6 index=6, step: api=N index=N, processor: api=8 index=8, policy=True, .enrich-* indices=1`

- [ ] **Step 7: Commit**

```bash
git add elastic/README.md elastic/entity-names-index.json elastic/enrich-policy.json tools/sync-entity-names.py tools/verify-kibana-dashboard.py
git commit -m "feat(elastic): entity-name lookup index and enrich policy, fed from the BaseApi

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: The `logs@custom` pipeline

The load-bearing task. The classification rule of §4.1 is implemented exactly once, here, and the fixture is written before the pipeline so the rule is tested rather than asserted.

**Files:**
- Create: `elastic/simulate-outcome-classification.json`
- Create: `elastic/logs-custom-pipeline.json`
- Modify: `tools/verify-kibana-dashboard.py`

**Interfaces:**
- Consumes: enrich policy `skp-entity-lookup` from Task 2, **executed**.
- Produces: pipeline `logs@custom`, stamping on every newly indexed document — `skp.workflow_name`, `skp.step_name`, `skp.processor_name` (string; absent when the GUID is unmatched), `skp.outcome_record` (boolean `true`; absent otherwise), and `skp.enrich_error` (string; only on pipeline failure). Tasks 4 and 5 query exactly those names.

- [ ] **Step 1: Write the failing test — the simulate fixture**

Create `elastic/simulate-outcome-classification.json`. Twelve documents: one per template of §4 (nine), plus an unmatched-GUID document and a `Result`-less one. The GUIDs are real ids from this cluster, so the expected names are real too — replace them with the output of `python tools/sync-entity-names.py --dry-run` if they have changed.

The em dash in the templates that carry one is written `—` rather than literally, so the file survives an editor that is not UTF-8. The exact template strings come from `src/tests/BaseApi.Tests/Live/Resilience/Templates.cs`, which is where they are already centralised — copy them from there rather than retyping them.

```json
{
  "pipeline": { "processors": [ { "pipeline": { "name": "logs@custom" } } ] },
  "docs": [
    { "_source": { "scope": { "name": "BaseProcessor.Core.Processing.ProcessedDataHandler" },
      "attributes": { "Result": "Completed", "{OriginalFormat}": "branch completed in {ElapsedMs}ms",
        "WorkflowId": "1a56b3ca-e276-4815-87fa-5c2f48ab6dad",
        "StepId": "b9c13653-6558-4445-9d20-ab0a6d3fd48f",
        "ProcessorId": "8f8344b1-caf6-4482-8710-a3249a238e3c" } } },

    { "_source": { "scope": { "name": "BaseProcessor.Core.Processing.ProcessedDataHandler" },
      "attributes": { "Result": "Failed",
        "{OriginalFormat}": "output failed its schema {OutputSchemaId} — reported failed: {SchemaErrors}" } } },

    { "_source": { "scope": { "name": "BaseProcessor.Core.Processing.ProcessDispatchHandler" },
      "attributes": { "Result": "Failed",
        "{OriginalFormat}": "input failed its schema {InputSchemaId} — reported failed: {SchemaErrors}" } } },

    { "_source": { "scope": { "name": "BaseProcessor.Core.Processing.ProcessDispatchHandler" },
      "attributes": { "Result": "Failed",
        "{OriginalFormat}": "the author reported the step failed: {Reason}" } } },

    { "_source": { "scope": { "name": "BaseProcessor.Core.Processing.ProcessDispatchHandler" },
      "attributes": { "Result": "Cancelled",
        "{OriginalFormat}": "the author cancelled the branch: {Reason}" } } },

    { "_source": { "scope": { "name": "BaseProcessor.Core.Processing.ProcessDispatchHandler" },
      "attributes": { "Result": "Failed",
        "{OriginalFormat}": "the transform faulted — reporting the step failed" } } },

    { "_source": { "scope": { "name": "Orchestrator.Messaging.StepOutcomeHandler" },
      "attributes": { "Result": "Completed",
        "{OriginalFormat}": "the terminal step completed with {Result} — no successor accepts it, the run ends here" } } },

    { "_source": { "scope": { "name": "Orchestrator.Messaging.StepOutcomeHandler" },
      "attributes": { "Result": "Cancelled",
        "{OriginalFormat}": "the terminal step completed with {Result} — no successor accepts it, the run ends here" } } },

    { "_source": { "scope": { "name": "Orchestrator.Messaging.StepOutcomeHandler" },
      "attributes": { "Result": "Completed",
        "{OriginalFormat}": "the entry step completed with {Result}" } } },

    { "_source": { "scope": { "name": "Orchestrator.Messaging.StepOutcomeHandler" },
      "attributes": { "Result": "Failed",
        "{OriginalFormat}": "advancing {SuccessorCount} successor(s) on a {Result} step — their entry conditions accept it" } } },

    { "_source": { "scope": { "name": "BaseProcessor.Core.Processing.ProcessedDataHandler" },
      "attributes": { "Result": "Completed", "{OriginalFormat}": "branch completed in {ElapsedMs}ms",
        "WorkflowId": "00000000-0000-0000-0000-000000000000",
        "StepId": "00000000-0000-0000-0000-000000000000",
        "ProcessorId": "00000000-0000-0000-0000-000000000000" } } },

    { "_source": { "scope": { "name": "BaseProcessor.Core.Consuming.SomeFutureHandler" },
      "attributes": { "{OriginalFormat}": "a record with no Result at all" } } }
  ]
}
```

The **expected** classification, which Step 5 checks document by document:

| # | document | `skp.outcome_record` | why |
|---|---|---|---|
| 1 | `branch completed` | **true** | processor scope prefix, has `Result` |
| 2 | output-schema Failed | **true** | processor scope prefix — **one of the three that never fired in the measured window, and the whole reason the rule is a prefix** |
| 3 | input-schema Failed | **true** | same |
| 4 | author reported failed | **true** | processor scope prefix |
| 5 | author cancelled | **true** | processor scope prefix |
| 6 | transform faulted | **true** | processor scope prefix — the third never-fired template |
| 7 | terminal, Completed | **true** | the orchestrator clause; the only witness of a terminal step |
| 8 | terminal, **Cancelled** | *absent* | the §4.2 defect. The processor already emitted #5 for this step |
| 9 | entry step completed | *absent* | restates the processor's outcome |
| 10 | advancing successors | *absent* | restates the processor's outcome |
| 11 | unmatched GUIDs | **true** | counted, but carries no `skp.*_name` — the document must survive intact |
| 12 | no `Result` at all | *absent* | not an outcome record; also proves the prefix test does not fire on `Result`-less records |

Documents 1 and 11 together are spec check 3: the unmatched one must come back present and unfailed.

- [ ] **Step 2: Run it to make sure it fails**

```bash
curl -s -H 'Content-Type: application/json' \
  -XPOST 'http://localhost:19200/_ingest/pipeline/_simulate' \
  --data-binary @elastic/simulate-outcome-classification.json
```

Expected: an error, `pipeline with id [logs@custom] does not exist`. Nothing is classified yet.

- [ ] **Step 3: Write the pipeline**

Create `elastic/logs-custom-pipeline.json`:

```json
{
  "description": "SKP: resolve entity GUIDs to names, and mark the records that count as one step outcome. See section 6.5 of docs/superpowers/specs/2026-09-22-kibana-operator-dashboard-design.md.",
  "processors": [
    {
      "enrich": {
        "field": "attributes.WorkflowId",
        "policy_name": "skp-entity-lookup",
        "target_field": "_tmp_wf",
        "max_matches": 1,
        "ignore_missing": true,
        "ignore_failure": true
      }
    },
    {
      "enrich": {
        "field": "attributes.StepId",
        "policy_name": "skp-entity-lookup",
        "target_field": "_tmp_step",
        "max_matches": 1,
        "ignore_missing": true,
        "ignore_failure": true
      }
    },
    {
      "enrich": {
        "field": "attributes.ProcessorId",
        "policy_name": "skp-entity-lookup",
        "target_field": "_tmp_proc",
        "max_matches": 1,
        "ignore_missing": true,
        "ignore_failure": true
      }
    },
    {
      "set": {
        "field": "skp.workflow_name",
        "copy_from": "_tmp_wf.entity_name",
        "if": "ctx._tmp_wf != null",
        "ignore_failure": true
      }
    },
    {
      "set": {
        "field": "skp.step_name",
        "copy_from": "_tmp_step.entity_name",
        "if": "ctx._tmp_step != null",
        "ignore_failure": true
      }
    },
    {
      "set": {
        "field": "skp.processor_name",
        "copy_from": "_tmp_proc.entity_name",
        "if": "ctx._tmp_proc != null",
        "ignore_failure": true
      }
    },
    {
      "set": {
        "field": "skp.outcome_record",
        "value": true,
        "if": "if (ctx.attributes == null) { return false; } def result = ctx.attributes.Result; if (result == null) { return false; } def scope = ctx.scope?.name; if (scope == null) { return false; } if (scope.startsWith('BaseProcessor.Core.Processing.')) { return true; } if (scope == 'Orchestrator.Messaging.StepOutcomeHandler') { def template = ctx.attributes['{OriginalFormat}']; return template == 'the terminal step completed with {Result} — no successor accepts it, the run ends here' && result == 'Completed'; } return false;",
        "ignore_failure": true
      }
    },
    {
      "remove": {
        "field": ["_tmp_wf", "_tmp_step", "_tmp_proc"],
        "ignore_missing": true
      }
    }
  ],
  "on_failure": [
    {
      "set": {
        "field": "skp.enrich_error",
        "value": "{{ _ingest.on_failure_processor_type }}: {{ _ingest.on_failure_message }}"
      }
    },
    {
      "remove": {
        "field": ["_tmp_wf", "_tmp_step", "_tmp_proc"],
        "ignore_missing": true
      }
    }
  ]
}
```

Three things in this body are load-bearing and must not be "tidied":

- **The processor half of the condition is `startsWith`, not a template list.** A list makes the three rarely-fired failure templates of §4 invisible — and those are exactly the ones an operator needs to see.
- **The orchestrator half tests `result == 'Completed'`.** Without it every cancellation is counted twice; 46 of them in the measured window (§4.2).
- **`on_failure` sets a field and lets the document through.** A logging pipeline must never drop a log because a lookup missed. A silently discarded error record is worse than an unresolved GUID.

Two smaller notes for whoever edits this next. The `_tmp_*` targets are removed in the happy path *and* again in `on_failure`, because a failure after the enrich processors would otherwise leave the raw lookup objects in the indexed document. And the em dash inside the painless condition arrives as a real em dash once Elasticsearch parses the JSON escape, which is what makes it compare equal to the template.

- [ ] **Step 4: Install it**

```bash
curl -s -H 'Content-Type: application/json' \
  -XPUT 'http://localhost:19200/_ingest/pipeline/logs@custom' \
  --data-binary @elastic/logs-custom-pipeline.json
```

Expected: `{"acknowledged":true}`. A `policy [skp-entity-lookup] does not exist` here means Task 2 Step 6 was skipped.

- [ ] **Step 5: Run the fixture and verify it passes**

```bash
curl -s -H 'Content-Type: application/json' \
  -XPOST 'http://localhost:19200/_ingest/pipeline/_simulate' \
  --data-binary @elastic/simulate-outcome-classification.json > /tmp/simulated.json

python -c "import json; docs=json.load(open('/tmp/simulated.json'))['docs']; [print(i, 'outcome_record=' + str(d['doc']['_source'].get('skp',{}).get('outcome_record')), 'names=' + str({k:v for k,v in d['doc']['_source'].get('skp',{}).items() if k.endswith('_name')})) for i,d in enumerate(docs,1)]"
```

Expected, exactly:

```
1 outcome_record=True names={'workflow_name': 'filefetcher-archiveexpander-chain', 'step_name': ..., 'processor_name': 'file-fetcher'}
2 outcome_record=True names={}
3 outcome_record=True names={}
4 outcome_record=True names={}
5 outcome_record=True names={}
6 outcome_record=True names={}
7 outcome_record=True names={}
8 outcome_record=None names={}
9 outcome_record=None names={}
10 outcome_record=None names={}
11 outcome_record=True names={}
12 outcome_record=None names={}
```

Documents 8, 9, 10 and 12 reading `None` is the whole point. If **8** reads `True`, the terminal-`Result` test is missing and every cancellation will be double-counted. If **2, 3 or 6** reads `None`, the condition has decayed into a template list and the three rarest failure paths are invisible.

Then confirm no document leaks an intermediate target:

```bash
grep -c "_tmp_" /tmp/simulated.json
```

Expected: `0`.

- [ ] **Step 6: Confirm it lands on real traffic**

Add two checks to `tools/verify-kibana-dashboard.py`:

```python
def check_2b_enrichment_lands(checks, es_url):
    """A document indexed AFTER the pipeline was installed carries the four skp fields.

    Scoped to the last 10 minutes precisely because enrichment is forward-only (spec 6.3): an
    unscoped query would find 24M pre-install documents and report a false failure.
    """
    body = {
        "size": 1,
        "query": {"bool": {"filter": [
            {"term": {"skp.outcome_record": True}},
            {"range": {"@timestamp": {"gte": "now-10m"}}},
        ]}},
        "sort": [{"@timestamp": "desc"}],
    }
    try:
        hits = requests.post(f"{es_url}/{DATA_STREAM}/_search", json=body, timeout=20).json()
        docs = hits["hits"]["hits"]
    except Exception as exc:  # noqa: BLE001
        return checks.report(2, "Enrichment lands", False, f"{type(exc).__name__}: {exc}")
    if not docs:
        return checks.report(2, "Enrichment lands", False,
                             "no skp.outcome_record document in the last 10m - is the feed running?")
    skp = docs[0]["_source"].get("skp", {})
    present = [f for f in ("workflow_name", "step_name", "processor_name", "outcome_record")
               if f in skp]
    return checks.report(2, "Enrichment lands", len(present) == 4, f"fields present: {present}")


def check_3_unmatched_ids_survive(checks, es_url):
    """An unresolvable GUID leaves the document intact rather than failing it.

    Runs through _simulate rather than indexing junk into the live data stream.
    """
    doc = {
        "pipeline": {"processors": [{"pipeline": {"name": "logs@custom"}}]},
        "docs": [{"_source": {
            "scope": {"name": "BaseProcessor.Core.Processing.ProcessedDataHandler"},
            "attributes": {"Result": "Completed",
                           "{OriginalFormat}": "branch completed in {ElapsedMs}ms",
                           "WorkflowId": "00000000-0000-0000-0000-000000000000"}}}],
    }
    try:
        result = requests.post(f"{es_url}/_ingest/pipeline/_simulate", json=doc, timeout=20).json()
        source = result["docs"][0]["doc"]["_source"]
    except Exception as exc:  # noqa: BLE001
        return checks.report(3, "Unmatched ids survive", False, f"{type(exc).__name__}: {exc}")
    skp = source.get("skp", {})
    ok = (source.get("attributes", {}).get("Result") == "Completed"
          and skp.get("outcome_record") is True
          and "workflow_name" not in skp
          and "enrich_error" not in skp)
    return checks.report(3, "Unmatched ids survive", ok, f"skp={skp}")
```

and in `main()`, after the check 2a call:

```python
    check_2b_enrichment_lands(checks, args.es_url)
    check_3_unmatched_ids_survive(checks, args.es_url)
```

Start `tools/simulate-endless-feed.py` if it is not already running, wait two minutes for enriched documents to arrive, then:

```bash
python tools/verify-kibana-dashboard.py
```

Expected: checks 1, 2a, 2 and 3 all PASS.

- [ ] **Step 7: Commit**

```bash
git add elastic/logs-custom-pipeline.json elastic/simulate-outcome-classification.json tools/verify-kibana-dashboard.py
git commit -m "feat(elastic): logs@custom enriches names and marks step-outcome records

The counted set is a scope prefix plus the terminal-step Completed template, per
section 4 of the design: a template list would hide the three rarely-fired failure
paths, and counting the terminal template's Cancelled half double-counts every
cancellation.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: The counting checks

Spec check 5 is the regression test for the design's central risk, and it is written here — against live traffic — before any Kibana panel is built on top of the counts. A panel built on a miscount looks perfectly healthy.

**Files:**
- Modify: `tools/verify-kibana-dashboard.py`

**Interfaces:**
- Consumes: `skp.outcome_record`, `skp.processor_name`, `skp.workflow_name`, `attributes.Result`, `attributes.StepId`, `attributes.ExecutionId` on documents indexed after Task 3.
- Produces: checks 4, 5 and 7 in the same `Checks` harness, plus the module-level helpers `_counted_query(window, workflow=None)` and `_terms(es_url, field, window, workflow=None, size=50)` and the constants `PER_CYCLE_TOTAL`, `PER_CYCLE_BY_PROCESSOR`, `PER_CYCLE_BY_RESULT`. Task 5 reuses `_terms` and `PER_CYCLE_BY_PROCESSOR`.

- [ ] **Step 1: Write the failing test**

Append to `tools/verify-kibana-dashboard.py`:

```python
# Spec section 4.4, measured over 45 cycles. One cycle of five files yields 30 counted outcomes.
# Cycles are derived from kafka-importer, which emits exactly one Completed per file and never
# fails in a healthy run, so it is the only processor whose count IS the cycle count.
PER_CYCLE_TOTAL = 30
PER_CYCLE_BY_PROCESSOR = {
    "kafka-importer": 5,
    "file-fetcher": 5,
    "archive-expander": 4,
    "sk-normalizer": 4,
    "outcome-recorder": 3,
    "archive-collapser": 2,
    "file-persister": 2,
    "kafka-exporter": 5,
}
PER_CYCLE_BY_RESULT = {"Completed": 26, "Failed": 3, "Cancelled": 1}


def _counted_query(window, workflow=None):
    filters = [
        {"term": {"skp.outcome_record": True}},
        {"range": {"@timestamp": {"gte": window}}},
    ]
    if workflow:
        filters.append({"term": {"skp.workflow_name": workflow}})
    return {"bool": {"filter": filters}}


def _terms(es_url, field, window, workflow=None, size=50):
    body = {"size": 0, "query": _counted_query(window, workflow),
            "aggs": {"by": {"terms": {"field": field, "size": size}}}}
    result = requests.post(f"{es_url}/{DATA_STREAM}/_search", json=body, timeout=30).json()
    return {b["key"]: b["doc_count"] for b in result["aggregations"]["by"]["buckets"]}


def check_4_totals_match_the_cycle(checks, es_url, window):
    """Counted records over the window equal 30 x cycles, within one cycle of edge slop.

    The slop is honest rather than lax: a fixed time window almost never starts and ends on a
    cycle boundary, so a partial cycle at either edge shifts the total. That is exactly why
    check 5 exists and is exact -- this one catches gross miscounting, check 5 catches the
    subtle kind.
    """
    try:
        by_processor = _terms(es_url, "skp.processor_name", window, VALIDATION_WORKFLOW)
    except Exception as exc:  # noqa: BLE001
        return checks.report(4, "Totals match the cycle", False, f"{type(exc).__name__}: {exc}")
    importer = by_processor.get("kafka-importer", 0)
    if importer < 5:
        return checks.report(4, "Totals match the cycle", False,
                             f"only {importer} kafka-importer records in {window}; "
                             "is the feed running?")
    cycles = importer / 5.0
    total = sum(by_processor.values())
    expected = PER_CYCLE_TOTAL * cycles
    ok = abs(total - expected) <= PER_CYCLE_TOTAL
    return checks.report(4, "Totals match the cycle", ok,
                         f"cycles={cycles:.1f} total={total} expected~{expected:.0f} "
                         f"by_processor={by_processor}")


def check_5_one_witness_per_step(checks, es_url, window):
    """No (StepId, ExecutionId) pair carries more than one counted record. EXACT, no tolerance.

    This is the structural version of check 4 and the check that would have caught the
    terminal-Cancelled defect of spec section 4.2: it fails even when two counting errors
    cancel each other out in the total.
    """
    body = {
        "size": 0,
        "query": _counted_query(window),
        "aggs": {"pairs": {
            "multi_terms": {
                "terms": [{"field": "attributes.StepId"}, {"field": "attributes.ExecutionId"}],
                "size": 5000,
                "min_doc_count": 2,
            }}},
    }
    try:
        result = requests.post(f"{es_url}/{DATA_STREAM}/_search", json=body, timeout=60).json()
        offenders = result["aggregations"]["pairs"]["buckets"]
    except Exception as exc:  # noqa: BLE001
        return checks.report(5, "One witness per step", False, f"{type(exc).__name__}: {exc}")
    if not offenders:
        return checks.report(5, "One witness per step", True,
                             "no duplicated (StepId, ExecutionId) pair")
    sample = [(b["key"], b["doc_count"]) for b in offenders[:3]]
    return checks.report(5, "One witness per step", False,
                         f"{len(offenders)} duplicated pair(s), e.g. {sample}")


def check_7_pie_matches_bins(checks, es_url, window):
    """The three Result slices sum to the bins total, in roughly 26:3:1 per cycle."""
    try:
        by_result = _terms(es_url, "attributes.Result", window, VALIDATION_WORKFLOW, size=10)
        by_processor = _terms(es_url, "skp.processor_name", window, VALIDATION_WORKFLOW)
    except Exception as exc:  # noqa: BLE001
        return checks.report(7, "Pie matches bins", False, f"{type(exc).__name__}: {exc}")
    sums_match = sum(by_result.values()) == sum(by_processor.values())
    only_three = set(by_result) <= set(PER_CYCLE_BY_RESULT)
    completed = by_result.get("Completed", 0)
    ratios_ok = True
    if completed:
        for name, per_cycle in PER_CYCLE_BY_RESULT.items():
            expected = completed * per_cycle / PER_CYCLE_BY_RESULT["Completed"]
            if abs(by_result.get(name, 0) - expected) > max(2.0, expected * 0.25):
                ratios_ok = False
    ok = sums_match and only_three and ratios_ok
    return checks.report(7, "Pie matches bins", ok,
                         f"by_result={by_result} sum_equals_bins={sums_match} "
                         f"only_three_values={only_three} ratio_ok={ratios_ok}")
```

Add the `--window` argument in `main()`:

```python
    parser.add_argument("--window", default="now-30m",
                        help="ES date-math lower bound. It must sit AFTER the pipeline was "
                             "installed: enrichment is forward-only, older records are "
                             "unenriched, and a wide window reports false failures.")
```

and the three calls, after check 3:

```python
    check_4_totals_match_the_cycle(checks, args.es_url, args.window)
    check_5_one_witness_per_step(checks, args.es_url, args.window)
    check_7_pie_matches_bins(checks, args.es_url, args.window)
```

- [ ] **Step 2: Prove check 5 can fail**

A check that has never gone red is not a test. Install a deliberately wrong pipeline — the §4.2 defect, terminal-Cancelled reinstated — let a few cycles run, and watch check 5 catch it.

```bash
python -c "
import json
p = json.load(open('elastic/logs-custom-pipeline.json', encoding='utf-8'))
condition = p['processors'][6]['set']['if']
assert \" && result == 'Completed'\" in condition, 'the condition moved; find it before editing'
p['processors'][6]['set']['if'] = condition.replace(\" && result == 'Completed'\", '')
json.dump(p, open('/tmp/defective-pipeline.json', 'w', encoding='utf-8'))
print('terminal-Result test removed')
"
curl -s -H 'Content-Type: application/json' \
  -XPUT 'http://localhost:19200/_ingest/pipeline/logs@custom' \
  --data-binary @/tmp/defective-pipeline.json
```

Wait ~90 seconds so three cycles are indexed under the defective pipeline, then:

```bash
python tools/verify-kibana-dashboard.py --window now-80s
```

Expected: `[FAIL] check 5: One witness per step - N duplicated (StepId, ExecutionId) pair(s), e.g. ...`
The duplicated pairs are sk-normalizer's cancelled steps, witnessed once by the processor and once by the orchestrator. If check 5 stays green here, it is not testing what it claims to and must be fixed before proceeding — that is the whole purpose of this step.

- [ ] **Step 3: Restore the correct pipeline and watch it go green**

```bash
curl -s -H 'Content-Type: application/json' \
  -XPUT 'http://localhost:19200/_ingest/pipeline/logs@custom' \
  --data-binary @elastic/logs-custom-pipeline.json
rm /tmp/defective-pipeline.json
```

Wait ~2 minutes so the window contains only correctly classified records, then:

```bash
python tools/verify-kibana-dashboard.py --window now-90s
```

Expected: checks 4, 5 and 7 all PASS, with check 5 reading `no duplicated (StepId, ExecutionId) pair`.

- [ ] **Step 4: Commit**

```bash
git add tools/verify-kibana-dashboard.py
git commit -m "test(elastic): counting checks for the outcome set, exact on one-witness-per-step

Check 5 was proved red against a pipeline with the terminal-Cancelled defect
reinstated, then green against the shipped one.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: The dashboard

**Files:**
- Create: `elastic/kibana-export.ndjson`
- Modify: `tools/verify-kibana-dashboard.py`

**Interfaces:**
- Consumes: the enriched fields from Task 3, Kibana from Task 1, and `_terms` from Task 4.
- Produces: saved objects with these exact ids, which check 9 asserts on — data view `skp-logs` over `logs-generic.otel-default`; Lens `skp-outcomes-bins` and `skp-outcomes-pie`; saved search `skp-outcome-records`; dashboard `skp-operator-outcomes`.

Build these **in the Kibana UI and export**, rather than hand-writing NDJSON. Lens panel state is a large nested structure with generated column ids; hand-authoring it is how you get a panel that imports without error and renders nothing. This is the same posture as `grafana/dashboards/*.json` — hand-*edited* after an export, never hand-*written*.

- [ ] **Step 1: Write the failing test**

Append to `tools/verify-kibana-dashboard.py`:

```python
def check_6_every_processor_has_a_bin(checks, es_url, window):
    """All eight participating processors appear, including the terminal-step-only kafka-exporter.

    kafka-exporter is the one that proves the terminal-step clause of spec 4.1 is doing its job:
    it emits ZERO processor-side records, so without that clause its bin is simply absent and an
    operator reads a working export step as a dead one.
    """
    try:
        by_processor = _terms(es_url, "skp.processor_name", window, VALIDATION_WORKFLOW)
    except Exception as exc:  # noqa: BLE001
        return checks.report(6, "Every processor has a bin", False, f"{type(exc).__name__}: {exc}")
    missing = [p for p in PER_CYCLE_BY_PROCESSOR if by_processor.get(p, 0) == 0]
    return checks.report(6, "Every processor has a bin", not missing,
                         f"{len(by_processor)} series present, missing={missing or 'none'}")


def check_9_generic_across_workflows(checks, es_url, kibana_url, window):
    """The dashboard's objects exist under their fixed ids, and more than one workflow has
    counted, named records.

    The UI half of spec check 9 -- selecting a second workflow in the control and watching the
    panels repopulate -- is a click and lives in the operator notes. What is checkable here is the
    precondition that makes it work: the data is keyed on workflow NAME, and a second workflow is
    present in it.
    """
    expected_objects = {"skp-logs", "skp-outcomes-bins", "skp-outcomes-pie",
                        "skp-outcome-records", "skp-operator-outcomes"}
    try:
        found = requests.get(
            f"{kibana_url}/api/saved_objects/_find"
            "?type=dashboard&type=lens&type=search&type=index-pattern&per_page=100",
            headers={"kbn-xsrf": "true"}, timeout=20).json()
        ids = {obj["id"] for obj in found.get("saved_objects", [])}
        by_workflow = _terms(es_url, "skp.workflow_name", window)
    except Exception as exc:  # noqa: BLE001
        return checks.report(9, "Genuinely generic", False, f"{type(exc).__name__}: {exc}")
    missing_objects = expected_objects - ids
    ok = not missing_objects and len(by_workflow) >= 2
    return checks.report(9, "Genuinely generic", ok,
                         f"workflows with counted records={list(by_workflow)}, "
                         f"missing saved objects={missing_objects or 'none'}")
```

and in `main()`, after check 7:

```python
    check_6_every_processor_has_a_bin(checks, args.es_url, args.window)
    check_9_generic_across_workflows(checks, args.es_url, args.kibana_url, args.window)
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `python tools/verify-kibana-dashboard.py --window now-30m`
Expected: check 6 may already PASS (it reads data, not Kibana), and check 9 FAILs with `missing saved objects={'skp-logs', 'skp-outcomes-bins', ...}`.

If check 6 fails with `missing=['kafka-exporter']`, stop and re-read §4.2 — the terminal-step clause is not working, and no amount of dashboard work will make that bin appear.

- [ ] **Step 3: Create the data view**

Kibana → Stack Management → Data Views → Create data view.
- Name: `skp-logs`
- Index pattern: `logs-generic.otel-default`
- Timestamp field: `@timestamp`
- **Custom data view ID: `skp-logs`** — expand *Advanced settings* on the create form. A generated UUID makes check 9 and every future re-import unstable.

- [ ] **Step 4: Build the bins panel**

Kibana → Visualize → Create visualization → Lens. Data view `skp-logs`.
- Chart type: **Bar vertical stacked**
- Horizontal axis: **Date histogram** on `@timestamp`, interval **Auto**
- Vertical axis: **Count of records**
- Break down by: **Top values of `skp.processor_name`**, size **20**, "Group remaining as Other" **off**
- Layer filter (the filter icon on the layer): KQL `skp.outcome_record: true`
- Appearance → Color palette: pick a **categorical** palette and leave it fixed. Lens assigns colour by term, so a processor keeps its colour between visits as long as the palette does not change.
- Title: `Step outcomes over time`
- Save with a **custom ID of `skp-outcomes-bins`**. If the save form does not offer one, save normally and rewrite the `id` in the exported NDJSON at Step 8, then re-import once to confirm the dashboard still resolves the reference.

- [ ] **Step 5: Build the pie panel**

Lens again, data view `skp-logs`.
- Chart type: **Pie**
- Slice by: **Top values of `attributes.Result`**, size **3**
- Size by: **Count of records**
- Layer filter: KQL `skp.outcome_record: true`
- Colours: assign all three explicitly — Completed green, Failed red, and **Cancelled amber, visibly distinct from Failed**. A policy rejection and a defect send an operator to different places, and a pie that renders them as two similar reds destroys that distinction.
- Title: `Outcome distribution`, custom ID `skp-outcomes-pie`.

- [ ] **Step 6: Build the saved search**

Discover, data view `skp-logs`, query `skp.outcome_record: true`.
Add columns in this order: `@timestamp`, `skp.processor_name`, `skp.step_name`, `attributes.Result`, `attributes.Reason`, `attributes.ExecutionId`, `body.text`.
Save as `Outcome records`, custom ID `skp-outcome-records`.

- [ ] **Step 7: Assemble the dashboard**

New dashboard; add both Lens panels from the library.

**Controls** (Add panel → Controls), four options-list controls in this order:

| control | field | selection |
|---|---|---|
| Workflow | `skp.workflow_name` | single — untick "Allow multiple selections" |
| Processor | `skp.processor_name` | multi |
| Step | `skp.step_name` | multi |
| Outcome | `attributes.Result` | multi |

In the Controls settings, enable **"Chain controls"** so each control narrows the next: Processor and Step then offer only values present under the selected Workflow. The Step control is not redundant with Processor — §4.3 shows `sk-normalizer` serving two steps in the validation workflow, and Step is what separates them.

**Drill-down:** pie panel → context menu → Create drilldown → *Go to Discover* → target `Outcome records` → tick **"Use filters and query from origin dashboard"** and **"Use date range from origin dashboard"**.

**Time range:** set to **Last 1 hour**, then save with *"Store time with dashboard"* ticked. Short enough that an operator lands inside the enriched window (§6.3) rather than on GUID-legended history, and long enough to span several ticks of a 30-second workflow.

Save as `SKP — workflow step outcomes`, custom ID `skp-operator-outcomes`.

- [ ] **Step 8: Export**

Stack Management → Saved Objects → select the dashboard → **Export**, with *"Include related objects"* ticked. Save the download as `elastic/kibana-export.ndjson`.

Confirm the five ids are in the file:

```bash
python -c "
import json
ids = [json.loads(l)['id'] for l in open('elastic/kibana-export.ndjson', encoding='utf-8')
       if l.strip() and 'exportedCount' not in l]
print(sorted(ids))
"
```

Expected: `['skp-logs', 'skp-operator-outcomes', 'skp-outcome-records', 'skp-outcomes-bins', 'skp-outcomes-pie']`

- [ ] **Step 9: Prove the export round-trips**

An export that cannot be re-imported is not a deliverable, and the hand-import posture means this is the only thing standing between a pod recreate and a lost dashboard.

```bash
curl -s -XPOST 'http://localhost:15601/api/saved_objects/_import?overwrite=true' \
  -H 'kbn-xsrf: true' -F file=@elastic/kibana-export.ndjson
```

Expected: `"success":true` and `"successCount":5`. Open the dashboard afterwards and confirm both panels still render data rather than an empty frame.

- [ ] **Step 10: Run the tests**

```bash
python tools/verify-kibana-dashboard.py --window now-30m
```

Expected: checks 1, 2a, 2, 3, 4, 5, 6, 7 and 9 all PASS, and check 6's detail names 8 series with `missing=none`.

- [ ] **Step 11: Commit**

```bash
git add elastic/kibana-export.ndjson tools/verify-kibana-dashboard.py
git commit -m "feat(elastic): operator dashboard saved objects - controls, bins, pie, drilldown

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Operator notes

The notes carry three things an operator cannot deduce from the dashboard and will otherwise get wrong: what a healthy shape looks like, why Discover returns nothing for a sensible-looking search, and why the counts are not a ledger.

**Files:**
- Create: `docs/testing/kibana-operator-dashboard.md`

**Interfaces:**
- Consumes: everything above. Nothing consumes this.

- [ ] **Step 1: Write the notes**

Create `docs/testing/kibana-operator-dashboard.md`:

`````markdown
# Kibana operator dashboard — operator notes

Design: `docs/superpowers/specs/2026-09-22-kibana-operator-dashboard-design.md`.
Objects: `elastic/`. Install order and re-sync instructions: `elastic/README.md`.

## Opening it

```
./k8s/port-forward-realstack.ps1
```

Then `http://localhost:15601` → Dashboards → **SKP — workflow step outcomes**. There is no login.

Pick a workflow in the first control. Processor, Step and Outcome then offer only values present
under it. The bins chart is one coloured series per processor over time; the pie is the outcome
distribution for the same selection. Click a pie slice to filter the dashboard in place, or use the
panel's drill-down to open the same selection in Discover.

## What a healthy run looks like

There is **no expected profile encoded anywhere in the dashboard**, deliberately — it presents the
distribution and you decide what is correct for the workflow in front of you. Bins are *not*
expected to be equal: volume falls at a step that filters and rises at one that fans out.

For the one workflow this was validated against, `filefetcher-archiveexpander-chain` driven by
`tools/simulate-endless-feed.py`, one cycle of five files produces **30** counted outcomes —
26 Completed, 3 Failed, 1 Cancelled:

| processor | per cycle | breakdown |
|---|---|---|
| kafka-importer | 5 | 5 Completed |
| file-fetcher | 5 | 4 Completed, 1 Failed |
| archive-expander | 4 | 3 Completed, 1 Failed |
| sk-normalizer | 4 | 2 Completed, 1 Failed, 1 Cancelled |
| outcome-recorder | 3 | 3 Completed |
| archive-collapser | 2 | 2 Completed — runs once per normalizer branch |
| file-persister | 2 | 2 Completed |
| kafka-exporter | 5 | terminal-step Completed only: 2 documents + 3 failure exports |

The three Failed and one Cancelled per cycle are the simulator's design, not a fault: it writes one
file per outcome the chain can produce. A cycle with **zero** failures means something other than
the simulator is feeding the chain.

## Three things that will mislead you

**1. Every string in this index is a `keyword`.** The `all_strings_to_keywords` dynamic template
maps them all, so `match` and `match_phrase` need the *entire* field value and return zero hits
otherwise — silently, with no error. In Discover, filter structurally on `attributes.*` rather than
text-matching `body.text`, and reach for `wildcard` only when you must hunt free text:

```
attributes.Result: "Failed" and skp.processor_name: "sk-normalizer"      ← works
body.text: "cancelled"                                                    ← zero hits, always
body.text: *cancelled*                                                    ← works, slowly
```

**2. Enrichment is forward-only, and the window opened the day the pipeline was installed.**
Documents indexed before then keep their raw GUIDs and carry no `skp.*` fields at all — they are
not merely unnamed, they are *uncounted*, because `skp.outcome_record` is stamped at ingest time.
Widening the time range past the install date does not show you more history; it shows you the same
records in an emptier chart. The dashboard's stored range is the last 1 hour for this reason, and
there is no reindex planned.

**3. A workflow published after the last sync shows GUIDs in the controls.** Enrich reads a
point-in-time snapshot of the lookup index. Fix it with:

```
python tools/sync-entity-names.py
```

Records indexed *before* that sync keep their GUIDs — see point 2. Run the sync right after
publishing, not after noticing.

## The counts are an observability signal, not an accounting ledger

This matters enough to be the last word. The authoritative outcome of a step is the `StepOutcome`
message on `orchestrator-result`, which **never reaches Elasticsearch**. What this dashboard reads
is the *log* of that outcome, exported best-effort over OTLP.

The collector's logs pipeline has no processors and drops nothing deliberately, and since
2026-09-11 it has retry and a sending queue. But past 5 retries or a full 5000-item queue a record
is still lost — before that change it silently lost 1–3 records every ~15s, surfacing as whole hops
missing from a correlation trace. A lost record is an under-reported bin, and **a missing bar reads
exactly like a failed step.**

So: use the dashboard to find *where* to look. Confirm what actually happened in the orchestrator's
own records before acting on a gap.

## Verifying it after a change

```
python tools/verify-kibana-dashboard.py --window now-30m
```

Eight of the nine checks in §9 of the design are in there, and each prints PASS or FAIL with its
measured numbers. The ninth — clicking a pie slice and confirming Discover opens pre-filtered with
the four expected failure reasons in the rows — is a UI action and is the one manual step.

Check 5 is the one to care about. It asserts that no `(StepId, ExecutionId)` pair carries more than
one counted record, which is what stops a step being tallied two or three times across the nine
templates that carry `attributes.Result`. It is exact and has no tolerance. If it ever goes red
after a framework change, read §4 of the design before changing anything — particularly the
orchestrator half of the condition in `elastic/logs-custom-pipeline.json`, which is the half that
is **not** maintained automatically by the scope prefix.
`````

- [ ] **Step 2: Verify the whole suite one more time, cold**

```bash
pwsh -File k8s/port-forward-realstack.ps1 -Stop
pwsh -File k8s/port-forward-realstack.ps1
python tools/verify-kibana-dashboard.py --window now-30m
```

Expected: a final line reading `0 check(s) failed`.

- [ ] **Step 3: Do the one manual check**

Open the dashboard, click the **Failed** pie slice, and use the drill-down. Confirm Discover opens
pre-filtered and that the rows name the four expected reasons — the extension-whitelist rejection,
the corrupt archive signature, the node-count rejection, and the artist gate. That is spec check 8.

Then select `simple-abc` in the Workflow control and confirm every panel repopulates with no edit.
That is the UI half of spec check 9, and it is the check that would catch the dashboard having been
built for one workflow.

- [ ] **Step 4: Commit**

```bash
git add docs/testing/kibana-operator-dashboard.md
git commit -m "docs(testing): operator notes for the Kibana step-outcome dashboard

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Deferred, and why

Recorded so a later reader knows these were weighed during planning, not overlooked.

- **Adopting Elasticsearch into `k8s/`.** §2 makes it an explicit non-goal. Kibana is manifested against a Service that has no manifest, which is an asymmetry rather than an oversight — and resolving it is a separate decision about what `k8s/` is allowed to own.
- **Emitting `WorkflowName`/`StepName`/`ProcessorName` from `BaseProcessor.Core`** (§6.4). It would retire the lookup index, the policy, the sync script and the whole staleness window. It is a code change across two projects plus a redeploy of every processor, and it is the better end state. The enrich fields are named `skp.*_name` precisely so that switching to it later is a data-view change rather than a dashboard rewrite.
- **A second dashboard** carrying the five panels declined in §12 — a failure-reason terms table, failure ratio over time, a heartbeat tile, step-duration percentiles from `attributes.ElapsedMs`, and a lineage funnel on unique `CorrelationId` per step. They belong to a second dashboard if the first proves useful.
- **Automating the saved-object import.** The repo's posture is hand-import (§8), matching Grafana. Task 5 Step 9 proves the export round-trips through the import API, which is the part that actually protects the work; wrapping that call in a script would be a second source of truth for which objects exist.
