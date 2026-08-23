# Observability Resolution and Alerting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the SKP operator dashboards able to resolve a one-minute fault, and make them page someone instead of waiting to be looked at.

**Architecture:** The boards' detection latency is not a panel problem — it is set by a 60-second OTLP export cadence that forces `$__rate_interval` to 240s and leaves gauges stale-held for five minutes. Lowering the export interval to 10s is one environment variable per service, after which the dashboard constants that were tuned around 60s must follow it down. The observability manifests currently live only in `references/k8s/` (a read-only copy of a prior repo), so they are brought into `k8s/` first — otherwise every change here is an unversioned edit to a live cluster. Alert rules come last, derived only from signals the chaos suite has already proven move.

**Tech Stack:** OpenTelemetry .NET 1.15.3, Prometheus (15s scrape), Grafana 12.3.9, kustomize, xUnit v3 (Microsoft.Testing.Platform), Python 3.11 generator, Playwright.

**Spec:** `grafana/README.md`, sections "What the boards could not see, and what changed" and "What the second run through the suite showed". Every number quoted in this plan is measured there.

## Global Constraints

- **Dashboards are generated.** Edit `grafana/build-dashboards.py` and regenerate. Never hand-edit `grafana/dashboards/*.json` — the orchestrator and processor boards share six panels emitted from `pipeline_shared()` precisely so they cannot drift.
- **`references/` is read-only.** It is a copy of a prior repository, kept for reading. Copy out of it; never edit it, never add it to a kustomization.
- **Two gates guard the chaos suite:** `SKP_REALSTACK=1` and `SKP_CHAOS=1`. Both are read inside the test, not as a trait filter.
- **`--filter` is not a flag this runner has.** It prints its whole help text and runs nothing, which reads exactly like a hang. Use `--filter-class` / `--filter-method`.
- **Never scale Redis** except in `RedisWipeScenarioTests`. Redis runs `--save "" --appendonly no`, so scaling it to zero destroys L2 and turns any scenario into the wipe scenario.
- **A background task reported as `killed` may still be running.** Verify the process tree with PowerShell before starting anything that touches the cluster; two orphaned runners racing the same scenario already invalidated three runs.
- **The soak's drain check fails if the standing orchestration fired in the last 40s.** After any `orchestration/start`, stop it and wait ≥45s before running a scenario.
- Standing workflow id: `4cd8af45-1295-43db-ab2e-e955dd82b5c5`. Restart it when the work is done.

---

### Task 1: Bring the observability manifests under version control

`k8s/` holds only namespace, secret, the three infrastructure stores and the three services. The collector, Prometheus, Grafana and their ConfigMaps exist in the live cluster but their source is `references/k8s/`, which is off-limits for editing. Every later task in this plan edits one of those files, so they have to have a home first.

**Files:**
- Create: `k8s/02-configmaps.yaml` (from `references/k8s/02-configmaps.yaml`)
- Create: `k8s/20-otel-collector.yaml` (from `references/k8s/20-otel-collector.yaml`)
- Create: `k8s/21-prometheus.yaml` (from `references/k8s/21-prometheus.yaml`)
- Create: `k8s/23-grafana.yaml` (from `references/k8s/23-grafana.yaml`)
- Modify: `k8s/kustomization.yaml` (resources list)

**Interfaces:**
- Consumes: nothing.
- Produces: `k8s/02-configmaps.yaml` containing ConfigMaps `otel-collector-config` (key `otel-collector-config.yaml`) and `prometheus-config` (key `prometheus.yml`); `k8s/23-grafana.yaml` containing ConfigMap `grafana-datasources` (key `prometheus.yaml`) with `jsonData.timeInterval`. Tasks 3 and 5 edit these.

- [ ] **Step 1: Copy the four manifests**

```bash
cd /c/Users/UserL/source/repos/SK_P9
cp references/k8s/02-configmaps.yaml       k8s/02-configmaps.yaml
cp references/k8s/20-otel-collector.yaml   k8s/20-otel-collector.yaml
cp references/k8s/21-prometheus.yaml       k8s/21-prometheus.yaml
cp references/k8s/23-grafana.yaml          k8s/23-grafana.yaml
```

- [ ] **Step 2: Prove the copies match what the cluster is actually running**

The copies are only trustworthy if the live ConfigMaps were built from them. Compare, do not assume — a silent drift here would be applied over the running cluster in Step 4.

```bash
kubectl -n skp get cm prometheus-config    -o jsonpath='{.data.prometheus\.yml}'          > /tmp/live-prom.yml
kubectl -n skp get cm grafana-datasources  -o jsonpath='{.data.prometheus\.yaml}'         > /tmp/live-ds.yml
kubectl -n skp get cm otel-collector-config -o jsonpath='{.data.otel-collector-config\.yaml}' > /tmp/live-otel.yml
python - <<'PY'
import pathlib, re, sys
def block(path, cm_name, key):
    text = pathlib.Path(path).read_text(encoding='utf-8')
    # the key's literal block, dedented by its own indent
    m = re.search(rf'name:\s*{cm_name}\b.*?^\s*{re.escape(key)}:\s*\|\n(.*?)(?=\n---|\Z)',
                  text, re.S | re.M)
    if not m: sys.exit(f'{cm_name}/{key} not found in {path}')
    body = m.group(1)
    indent = min(len(l) - len(l.lstrip()) for l in body.splitlines() if l.strip())
    return '\n'.join(l[indent:] for l in body.splitlines()).rstrip()
pairs = [('k8s/02-configmaps.yaml','prometheus-config','prometheus.yml','/tmp/live-prom.yml'),
         ('k8s/23-grafana.yaml','grafana-datasources','prometheus.yaml','/tmp/live-ds.yml'),
         ('k8s/02-configmaps.yaml','otel-collector-config','otel-collector-config.yaml','/tmp/live-otel.yml')]
bad = 0
for path, cm, key, live in pairs:
    a = block(path, cm, key)
    b = pathlib.Path(live).read_text(encoding='utf-8').rstrip()
    same = a == b
    print(('MATCH  ' if same else 'DRIFT  ') + f'{cm}/{key}  file={len(a)}B live={len(b)}B')
    bad += 0 if same else 1
sys.exit(bad)
PY
```

Expected: three `MATCH` lines, exit 0. On `DRIFT`, stop and reconcile by hand before continuing — the live cluster is the authority for what is currently running, the file is the authority for what should be.

- [ ] **Step 3: Add them to the kustomization**

In `k8s/kustomization.yaml`, extend `resources:` so it reads, in this order:

```yaml
resources:
  - 00-namespace.yaml
  - 01-secret.yaml
  - 02-configmaps.yaml
  - 10-postgres.yaml
  - 11-redis.yaml
  - 12-rabbitmq.yaml
  - 20-otel-collector.yaml
  - 21-prometheus.yaml
  - 23-grafana.yaml
  - 30-baseapi-service.yaml
  - 33-processor-sample.yaml
  - 36-orchestrator.yaml
```

Only these four are copied. `references/k8s/` also holds `13-elasticsearch.yaml`, `22-otel-collector-servicemonitor.yaml`, `31-orchestrator.yaml`, `32-keeper.yaml` and `34-orchestrator-rbac.yaml`, and they stay where they are: this plan changes none of them, and `31-orchestrator.yaml` is superseded here by `k8s/36-orchestrator.yaml`. Elasticsearch is running in the cluster and its manifest is still only in `references/` — that is a real gap, but it is a separate tidy-up and adopting it here would mean applying an untested manifest over a StatefulSet holding the log data every chaos scenario reads.

- [ ] **Step 4: Verify the kustomization builds and is a no-op against the cluster**

```bash
kubectl kustomize k8s/ > /tmp/built.yaml && grep -c "^kind:" /tmp/built.yaml
kubectl -n skp diff -k k8s/ > /tmp/adopt-diff.txt 2>&1; echo "diff exit=$?"
```

The gate is **not** `diff exit=0`, and expecting that would be wrong for two reasons that have nothing to do with this task. `kubectl apply -k` stamps `app.kubernetes.io/managed-by: kustomize` on everything it manages, and the live objects were applied without it, so every resource shows a label-only hunk. Separately, `k8s/33-processor-sample.yaml` carries a pre-existing one-line drift against the cluster.

What must hold is narrower, and is what this task is actually responsible for: **no hunk touches any of the four adopted objects except that label.** Check it directly — save this as `/tmp/gate.py` and run `python /tmp/gate.py`:

```python
import pathlib, re
text = pathlib.Path('/tmp/adopt-diff.txt').read_text(encoding='utf-8', errors='replace')
subst = [l for l in text.splitlines()
         if re.match(r'^[+-][^+-]', l)
         and 'managed-by' not in l
         and not re.match(r'^[+-]\s*generation:', l)]
print(f'{len(subst)} substantive changed line(s):')
for l in subst:
    print('   ', l)
```

Expected: the only substantive lines are `- value: unresolved` and `+ value: processor`. That is `Service__Name` on `processor-sample` — a fallback the manifest's own comment says is used only when a host starts without identity resolution, which the sample never does. It is not one of the four adopted files and it predates this task. Leave it alone: Task 3 rolls `processor-sample` anyway and will carry it.

Any substantive line naming `otel-collector`, `prometheus`, `grafana` or one of the three ConfigMaps means a copy genuinely differs from the cluster — go back to Step 2.

- [ ] **Step 5: Commit**

```bash
git add k8s/02-configmaps.yaml k8s/20-otel-collector.yaml k8s/21-prometheus.yaml k8s/23-grafana.yaml k8s/kustomization.yaml
git commit -m "chore(k8s): bring the observability manifests into this repo

The collector, Prometheus, Grafana and their ConfigMaps were running in the
cluster from copies in references/, which is a read-only snapshot of a prior
repository. Every change to scrape cadence, datasource resolution or alert
rules would otherwise be an unversioned edit to a live cluster, lost the next
time it is recreated. Verified byte-identical to the running ConfigMaps and
applied as a no-op."
```

---

### Task 2: Prove the export cadence is 60s and env-overridable

Before changing anything, pin the current behaviour down as a number. The claim this whole plan rests on is that series resolution is 60s because of the SDK default, not because of anything in `src/`. `AddOtlpExporter()` is called with no options in both observability extensions, so the interval comes from `OTEL_METRIC_EXPORT_INTERVAL`, which OpenTelemetry .NET 1.15.3 reads from the environment.

**Files:**
- Test: none — this is a measurement against the live stack, recorded in the commit message of Task 3.

**Interfaces:**
- Consumes: nothing.
- Produces: the before-number that Task 3's verification is compared against.

- [ ] **Step 1: Measure the current per-series resolution**

```bash
curl -s http://localhost:19090/api/v1/query \
  --data-urlencode 'query=count_over_time(pipeline_gate_open_ratio[2m])' \
  | python -c "import json,sys;[print(r['metric'].get('service_instance_id'), r['value'][1]) for r in json.load(sys.stdin)['data']['result']]"
```

Expected: every series reports `2` — two samples in two minutes, i.e. a 60s cadence. Record the output.

- [ ] **Step 2: Confirm nothing in `src/` sets the interval**

```bash
grep -rn "ExportIntervalMilliseconds\|PeriodicExportingMetricReader\|MetricReaderOptions" src/ --include=*.cs
```

Expected: no matches. The only exporter registrations are the bare `AddOtlpExporter()` calls at `src/BaseApi.Core/DependencyInjection/ObservabilityServiceCollectionExtensions.cs:70` and `:94`, and `src/BaseConsole.Core/DependencyInjection/BaseConsoleObservabilityExtensions.cs:116` and `:154`. If this grep finds anything, the environment variable will be ignored and this plan needs a code change after all — stop and re-scope.

- [ ] **Step 3: No commit**

Nothing changed. Carry both outputs into Task 3.

---

### Task 3: Lower the export interval to 10s

10s rather than 15s deliberately. Prometheus scrapes every 15s, and because the collector emits explicit sample timestamps (`send_timestamps: true`) Prometheus discards a re-scrape bearing a timestamp it already stored. An export interval equal to the scrape interval aliases: the two drift in and out of phase and some scrapes carry nothing new. Exporting faster than the scrape guarantees every scrape carries a fresh sample, which makes the effective resolution the scrape interval, 15s.

**Files:**
- Modify: `k8s/30-baseapi-service.yaml:71-72` (env block)
- Modify: `k8s/33-processor-sample.yaml:48-49` (env block)
- Modify: `k8s/36-orchestrator.yaml:176-177` (env block)

**Interfaces:**
- Consumes: Task 1's manifests.
- Produces: a 15s effective series resolution, which Tasks 4 and 5 retune against.

- [ ] **Step 1: Add the variable to all three services**

In each of the three files, immediately after the existing `OTEL_EXPORTER_OTLP_ENDPOINT` entry, add:

```yaml
            # 10s, against a 15s Prometheus scrape. The collector emits explicit sample
            # timestamps and Prometheus discards a re-scrape bearing one it already stored,
            # so an export interval EQUAL to the scrape interval aliases and leaves some
            # scrapes with nothing new. Exporting faster than the scrape makes the effective
            # resolution the scrape interval.
            #
            # Load-bearing for the dashboards: Grafana derives $__rate_interval from the
            # datasource's timeInterval, which must track this value. At 60s it floored the
            # rate window at 240s, which is why a sixty-second outage moved no rate panel.
            - name: OTEL_METRIC_EXPORT_INTERVAL
              value: "10000"
```

Keep the indentation of the surrounding `env:` entries — 12 spaces before `- name:` in all three files.

- [ ] **Step 2: Apply and roll**

```bash
kubectl apply -k k8s/
kubectl -n skp rollout status deploy/baseapi-service --timeout=180s
kubectl -n skp rollout status deploy/processor-sample --timeout=180s
kubectl -n skp rollout status sts/orchestrator --timeout=300s
```

Expected: three successful rollouts. If `processor-sample` times out with pods `Running` and `0/1` ready, that is the designed two-stage boot waiting for a processor row whose `SourceHash` matches its image — the image has not changed here, so this should not happen; if it does, check `pipeline_identity_ready_ratio` before assuming a crash.

- [ ] **Step 3: Verify the resolution actually changed**

Wait two minutes after the rollout completes so the window contains only post-rollout samples.

```bash
curl -s http://localhost:19090/api/v1/query \
  --data-urlencode 'query=count_over_time(pipeline_gate_open_ratio[2m])' \
  | python -c "import json,sys;[print(r['metric'].get('service_instance_id'), r['value'][1]) for r in json.load(sys.stdin)['data']['result']]"
```

Expected: every series reports `8` — eight samples in two minutes, a 15s effective resolution, up from the `2` recorded in Task 2. Anything still reporting `2` means the variable did not reach that pod; check `kubectl -n skp exec <pod> -- env | grep OTEL`.

- [ ] **Step 4: Commit**

```bash
git add k8s/30-baseapi-service.yaml k8s/33-processor-sample.yaml k8s/36-orchestrator.yaml
git commit -m "perf(observability): export metrics every 10s instead of 60s

The 60s cadence was the OpenTelemetry SDK default, not a decision: both
observability extensions call AddOtlpExporter() with no options, so
OTEL_METRIC_EXPORT_INTERVAL governs it. It set the floor under every
detection latency the chaos suite measured -- \$__rate_interval floored at
240s, gauges stale-held for five minutes, and a sixty-second fault reported
110s after the pods went.

Measured: count_over_time(<series>[2m]) goes 2 -> 8."
```

---

### Task 4: Retune the datasource and the dashboard constants

`timeInterval` is what Grafana derives `$__rate_interval` from, and it is documented in `23-grafana.yaml` as the *effective series resolution*, explicitly not the scrape interval. It has to follow Task 3 down or every rate panel keeps a 240s window over data that no longer needs one. The dashboard constants tuned around a 60s cadence — the liveness window and the staleness thresholds — follow too.

**Files:**
- Modify: `k8s/23-grafana.yaml:244` (`timeInterval`) and its comment block at `:229-243`
- Modify: `grafana/build-dashboards.py` (`LIVENESS`, `T_STALE`)
- Regenerate: `grafana/dashboards/skp-flow.json`, `skp-orchestrator.json`, `skp-processor.json`, `skp-baseapi.json`

**Interfaces:**
- Consumes: the 15s effective resolution from Task 3.
- Produces: `LIVENESS = "40s"`, `$__rate_interval` of 60s. Task 6's alert rules use the same 40s liveness window and must match this constant.

- [ ] **Step 1: Update the datasource**

In `k8s/23-grafana.yaml`, replace `timeInterval: "60s"` with `timeInterval: "15s"`, and replace the comment block above it so it no longer describes the old cadence:

```yaml
      # EFFECTIVE series resolution, which is NOT prometheus.yml's scrape_interval and is
      # NOT the SDK's export interval either -- it is whichever of the two is coarser.
      #
      # The collector's prometheus exporter emits EXPLICIT millisecond timestamps on every
      # sample (verify with
      # `kubectl -n skp exec deployment/prometheus -- wget -qO- http://otel-collector:8889/metrics`
      # -- each line carries a third field). Prometheus honours an explicit timestamp and
      # discards a re-scrape bearing one it already stored, so the stored resolution is the
      # coarser of the export interval and the scrape interval. The services export every
      # 10s (OTEL_METRIC_EXPORT_INTERVAL) and Prometheus scrapes every 15s, so it is 15s.
      # Measured: count_over_time(<any series>[2m]) == 8.
      #
      # Grafana derives $__rate_interval = max(4 x timeInterval, step + scrape). At 15s that
      # is 60s, spanning four samples. This value must track the export cadence: at 60s it
      # floored $__rate_interval at 240s, which is why a sixty-second outage moved no rate
      # panel on any board.
      timeInterval: "15s"
```

- [ ] **Step 2: Update the generator constants**

In `grafana/build-dashboards.py`, change the `LIVENESS` value and the paragraph that justifies it:

```python
# 40s, and the number is measured rather than chosen. The export cadence is 10s against a
# 15s scrape, so the effective sample spacing is 15s and the window has to survive one late
# sample without declaring a healthy replica dead -- and it has to be tight enough that a
# replica which vanishes for a minute falls out of it before its replacement starts
# reporting. At the old 60s cadence the equivalent number was 100s; 2m failed outright,
# never dipping on three recorded ~58s disappearances.
LIVENESS = "40s"
```

And bring `T_STALE` down with it — the sawtooth it has to clear is now 0-15s, not 0-60s:

```python
# Seconds since the least-fresh service last exported. The effective resolution is 15s, so
# this sawtooths 0-15 in health; anything above that means a service has stopped reporting.
T_STALE = [{"color": "green", "value": None},
           {"color": "orange", "value": 45},
           {"color": "red", "value": 90}]
```

- [ ] **Step 3: Regenerate and validate every expression**

```bash
python grafana/build-dashboards.py
python grafana/check-expressions.py http://localhost:19090
```

Expected: four boards regenerated; `110 expressions returning data · 0 empty · 0 invalid`. An `empty` line names a panel whose expression now matches nothing — most likely a liveness window that is too tight — and must be resolved before continuing.

- [ ] **Step 4: Apply the datasource and re-import the boards**

> **WARNING — restarting Grafana destroys every hand-imported board.** Grafana's storage on this stack is an `emptyDir`: its SQLite database dies with the pod. Only the four boards `build-dashboards.py` emits can be rebuilt from source. **`skp-runtime` cannot** — it predates the generator, is not in the ConfigMap, and exists only as rows in that database. A `rollout restart` deletes it permanently, along with any dashboard permissions, annotations, or edits made through the UI.
>
> Restart Grafana **only** when a provisioned file has genuinely changed (a datasource ConfigMap is read at boot, which is why this step needs it), and re-import the four generated boards immediately afterwards, as the loop below does. For a boards-only change, **skip the restart entirely** — the import API updates a live Grafana in place and is the safe default:
>
> ```bash
> # boards-only change: no restart, just re-import
> curl -s -u admin:admin -X POST http://localhost:13000/api/dashboards/db ...
> ```
>
> After any restart, confirm all five boards are present before continuing:
>
> ```bash
> curl -s -u admin:admin "http://localhost:13000/api/search?tag=skp" | python -c "import json,sys;[print(d['uid']) for d in json.load(sys.stdin)]"
> ```
>
> Expected: `skp-flow`, `skp-orchestrator`, `skp-processor`, `skp-baseapi`, **and `skp-runtime`**. If `skp-runtime` is missing it is gone, and no step in this plan can restore it.

```bash
kubectl apply -k k8s/
kubectl -n skp rollout restart deploy/grafana && kubectl -n skp rollout status deploy/grafana --timeout=120s
for f in grafana/dashboards/skp-flow.json grafana/dashboards/skp-orchestrator.json \
         grafana/dashboards/skp-processor.json grafana/dashboards/skp-baseapi.json; do
  python -c "
import json,sys
d=json.load(open('$f',encoding='utf-8'))
print(json.dumps({'dashboard':d,'overwrite':True,'message':'15s resolution retune'}))" > /tmp/imp.json
  curl -s -u admin:admin -X POST http://localhost:13000/api/dashboards/db \
    -H 'Content-Type: application/json' --data-binary @/tmp/imp.json \
    | python -c "import json,sys;r=json.load(sys.stdin);print('$f ->',r.get('status'),r.get('version'))"
done
```

Expected: four `success` lines. The Grafana restart is required — a datasource change in a provisioned ConfigMap is read at boot.

- [ ] **Step 5: Confirm the boards still render on a healthy stack**

Two prerequisites, both one-off, both belonging to the first step that runs the sampler.

**Playwright is not installed anywhere durable.** `grafana/chaos-timeline.js`, `audit-boards.js` and `audit-nav.js` all `require('playwright')`, and nothing in the repo provides it — it has only ever been installed into a throwaway scratchpad, so a clean checkout cannot run any of the three. Give `grafana/` its own minimal package so the scripts are self-contained:

```bash
cat > grafana/package.json <<'JSON'
{
  "name": "skp-grafana-tooling",
  "private": true,
  "description": "Playwright for the board audit and chaos-timeline scripts. Not a build; these are operator tools run by hand.",
  "dependencies": {
    "playwright": "^1.62.1"
  }
}
JSON
(cd grafana && npm install)
```

`node_modules/` is already in `.gitignore` (line 288), so only `grafana/package.json` and `grafana/package-lock.json` are committed. The browsers themselves are already present under `~/AppData/Local/ms-playwright`; if `npm install` reports otherwise, run `(cd grafana && npx playwright install chromium)`.

**The sampler writes into an unignored path.** `chaos-timeline.js` writes to `<repo>/.chaos-timeline/<label>/` when `OUT_DIR` is unset, and nothing ignores that. Add it, or the screenshots land in `git status` and someone commits a few hundred PNGs:

```bash
grep -qxF '.chaos-timeline/' .gitignore || printf '
# chaos-timeline.js sampler output — screenshots and timelines, never committed
.chaos-timeline/
' >> .gitignore
export NODE_PATH="$PWD/grafana/node_modules"
node grafana/chaos-timeline.js --label retune-verify --duration 90 --interval 20
```

Expected: five boards, `noData 0` and `err 0` on every sweep, `Data freshness` reading under 45s, `Workers missing` 0, `Workers reporting` 5. A `Data freshness` above 45s on a healthy stack means `LIVENESS`/`T_STALE` are now too tight — widen both by 15s and repeat.

- [ ] **Step 6: Commit**

```bash
git add k8s/23-grafana.yaml grafana/build-dashboards.py grafana/dashboards .gitignore \
        grafana/package.json grafana/package-lock.json
git commit -m "fix(grafana): track the datasource and liveness window to the 15s resolution

timeInterval is the effective series resolution, not the scrape interval, and
at 60s it floored \$__rate_interval at 240s. With the services now exporting
every 10s against a 15s scrape the effective resolution is 15s, so the rate
window drops to 60s, the liveness window from 100s to 40s, and the staleness
thresholds from 90/150 to 45/90."
```

---

### Task 5: Split the verdict tier by tense

The Flow board's verdict row now mixes stats that mean *right now* with stats that mean *the worst thing in the visible range*, side by side and visually identical. `Workers missing` reported 3 during the processor scenario when the answer for that fault was 2 — carry-over from the orchestrator scenario, correct by its definition and unreadable as such. Eleven stats in one row is also past a glance.

**Files:**
- Modify: `grafana/build-dashboards.py`, `build_flow()` — the row structure and the `Workers missing` expression
- Regenerate: `grafana/dashboards/skp-flow.json`

**Interfaces:**
- Consumes: `LIVE_WORKERS` and `counted()` as defined in `build-dashboards.py`.
- Produces: two rows on the Flow board titled `1 - Verdict: is it broken right now?` and `2 - Since: what happened in this range?`; the Flow panel count rises from 19 to 20 (one extra row panel).

- [ ] **Step 1: Give `Workers missing` a fixed window**

A stat whose meaning changes when the reader zooms is a stat that will mislead someone. Replace the `$__range` subqueries with a stated five minutes, and say so in the title. In `build_flow()`:

```python
        stat(lay, "Workers missing (5m)",
             [f'(max_over_time(({LIVE_WORKERS})[5m:15s]) '
              f'- min_over_time(({LIVE_WORKERS})[5m:15s])) or vector(0)'],
             desc="The deepest dip in live worker count over the last five minutes. Names "
                  "how many replicas went away, without having to be told how many there "
                  "ought to be -- it reads 3 for a lost orchestrator StatefulSet and 2 for "
                  "a lost processor pair." + PARA +
                  "**Five minutes, not the visible range.** Peak-minus-trough over "
                  "$__range makes the number change when the reader zooms, and made "
                  "back-to-back scenarios report the earlier, deeper one: 3 during the "
                  "processor scenario, whose own answer was 2. A stated window is worth "
                  "more than a wider one." + PARA +
                  "**Peak minus trough, not peak minus now.** The dip is narrow and a stat "
                  "panel is a range query at a coarse step, so a subtraction against the "
                  "current value lands on the wrong side of the dip about half the time. "
                  "The `[5m:15s]` subqueries evaluate at 15s regardless of the panel's "
                  "step, which is what makes this catch a transient at all." + PARA +
                  "**It cannot be prompt.** A replica is only missing once it has skipped "
                  "its liveness window, so detection takes roughly the liveness window "
                  "plus one export. Nothing queryable fixes the remainder: a fault shorter "
                  "than the sampling period is not observable.",
             thresholds=T_WARN, decimals=0),
```

- [ ] **Step 2: Split the row**

In `build_flow()` the verdict tier is one `row()` at line 662 followed by eleven `stat()` calls. **No `stat()` call's expression, description or thresholds change in this step** — only which row they sit under and the order within it. Each call is identified below by the line it currently starts on, so there is no ambiguity about which block of text to move.

Replace line 662 with:

```python
    panels.append(row(lay, "1 - Verdict: is it broken right now?"))
```

Then reorder the eleven calls so the five present-tense ones come first, in this order:

| order | stat | currently starts at |
|---|---|---|
| 1 | `System flowing` | `:664` |
| 2 | `Consuming` | `:746` |
| 3 | `L2 gate` | `:751` |
| 4 | `Workers reporting` | `:763` |
| 5 | `Data freshness` | `:799` |

After the fifth, close the list and open the second row:

```python
    ]

    lay.newline()
    panels.append(row(lay, "2 - Since: what happened in this range?"))
    panels += [
```

Then the six range-scoped calls, in this order:

| order | stat | currently starts at |
|---|---|---|
| 1 | `Outbound hop gap` | `:679` |
| 2 | `Return hop gap` | `:701` |
| 3 | `Retry amplification` | `:716` |
| 4 | `Ack lost` | `:735` |
| 5 | `Egress faults` | `:741` |
| 6 | `Workers missing (5m)` | `:775`, as rewritten in Step 1 |

Finally renumber the two rows that follow: `2 - Flow: where is it leaking?` at line 810 becomes `3 - Flow: where is it leaking?`, and if a later row is numbered `3`, it becomes `4`.

`lay.newline()` before the second row matters: `Layout.place` wraps at the 24-column grid and would otherwise pack the first range stat onto the tail of the previous row, putting a "since" stat visually inside the "now" group — which is the exact confusion this task exists to remove.

Add to the `dashboard(...)` description for `skp-flow` so the split is explained on the board itself:

```python
        description=("Cross-service conservation for the SKP pipeline. The board to "
                     "open first: it answers whether the system is broken and where, "
                     "then links out to the source boards. The hop-gap panels span two "
                     "services and belong to neither source board." + PARA +
                     "The verdict tier is split by TENSE. Row 1 is the state right now. "
                     "Row 2 is the worst thing that happened inside the visible range, "
                     "and those stats stay non-zero after the event that caused them -- "
                     "deliberately, so an operator arriving late is still told."),
```

- [ ] **Step 3: Regenerate and validate**

```bash
python grafana/build-dashboards.py
python grafana/check-expressions.py http://localhost:19090
```

Expected: `grafana/dashboards/skp-flow.json  2 variables, 20 panels` (up from 19 — one added row), and `0 empty · 0 invalid`.

- [ ] **Step 4: Re-import and confirm the layout**

```bash
python -c "
import json
d=json.load(open('grafana/dashboards/skp-flow.json',encoding='utf-8'))
print(json.dumps({'dashboard':d,'overwrite':True,'message':'split verdict tier by tense'}))" > /tmp/imp.json
curl -s -u admin:admin -X POST http://localhost:13000/api/dashboards/db \
  -H 'Content-Type: application/json' --data-binary @/tmp/imp.json \
  | python -c "import json,sys;r=json.load(sys.stdin);print(r.get('status'),r.get('version'))"
export NODE_PATH="$PWD/grafana/node_modules"
node grafana/chaos-timeline.js --label tense-verify --duration 60 --interval 20
```

Expected: `success`; the sampler reports the Flow board with `noData 0`, `err 0`, and the five "now" stats appearing before the six "since" stats. Open one PNG under the sampler's output directory and confirm the two rows render as two labelled sections rather than one run-on grid.

- [ ] **Step 5: Commit**

```bash
git add grafana/build-dashboards.py grafana/dashboards/skp-flow.json
git commit -m "fix(grafana): split the Flow verdict tier by tense

Eleven stats sat in one row, and they did not all mean the same thing:
Consuming and L2 gate are the state now, while Egress faults, Ack lost and
Workers missing are the worst thing inside the visible range. Identical
presentation, different tense, no way for a reader to tell which was which.
Workers missing also changed meaning when the reader zoomed, and reported 3
during the processor scenario whose own answer was 2 -- it is a stated five
minutes now."
```

---

### Task 6: Alert rules for the signals that proved they move

The boards only help someone already looking. `evaluation_interval: 15s` is set in `prometheus.yml` and there are no rules at all. Every rule below is derived from a signal the chaos suite exercised, with both its healthy value and its fault value measured — no rule is written against a signal that has never been seen to move.

**Files:**
- Modify: `k8s/02-configmaps.yaml` — the `prometheus-config` ConfigMap: add a `rule_files:` stanza and a second data key `skp-rules.yml`
- Modify: `k8s/21-prometheus.yaml` — mount the same ConfigMap key into `/etc/prometheus/`

**Interfaces:**
- Consumes: `LIVENESS` from Task 4 — the rules hardcode `40s` and must be changed with it.
- Produces: alert group `skp-pipeline` with five rules: `PipelineNotConsuming`, `L2GateShut`, `WorkersMissing`, `TelemetryStale`, `EgressFaults`.

- [ ] **Step 1: Add the rules to the ConfigMap**

In `k8s/02-configmaps.yaml`, inside the `prometheus-config` ConfigMap's `data:` map, add a second key alongside `prometheus.yml`:

```yaml
  skp-rules.yml: |
    # Every rule here fires on a signal the chaos suite has actually moved, with both its
    # healthy and its fault value measured. Nothing is asserted about a signal that has
    # never been observed to change -- `landed="false"` has never occurred on this stack,
    # so there is deliberately no ack-loss rule.
    #
    # The liveness windows must track LIVENESS in grafana/build-dashboards.py. They are the
    # same decision expressed twice because Prometheus cannot read the generator. Read the
    # value out of the generator rather than copying it from this plan -- Task 4's own
    # verification step may have widened it:
    #     grep -n '^LIVENESS' grafana/build-dashboards.py
    # and substitute that value everywhere `[40s]` appears below.
    groups:
      - name: skp-pipeline
        interval: 15s
        rules:
          - alert: TelemetryStale
            # First, because every other rule is downstream of it. Healthy sawtooths 0-15s.
            expr: time() - min(max by (service_name) (timestamp(pipeline_gate_open_ratio))) > 60
            for: 1m
            labels:
              severity: warning
            annotations:
              summary: "A service has stopped exporting metrics"
              description: "Least-fresh service last exported {{ $value | humanizeDuration }} ago. Every other alert is unreliable while this is firing."

          - alert: PipelineNotConsuming
            # Measured 1 throughout the undisturbed baseline; 0 within ~40s of a Redis
            # pause, a broker outage, both at once, and an L2 wipe.
            expr: min(last_over_time(pipeline_consumer_consuming_ratio[40s])) == 0
            for: 1m
            labels:
              severity: critical
            annotations:
              summary: "A queue has no consumer"
              description: "At least one queue on a live replica is not consuming. Check L2GateShut to tell a store fault from a broker fault."

          - alert: L2GateShut
            # The discriminator: 0 for a Redis fault, 1 for a broker fault. Both close
            # PipelineNotConsuming, so this is what separates the two call-outs.
            expr: min(last_over_time(pipeline_gate_open_ratio[40s])) == 0
            for: 1m
            labels:
              severity: critical
            annotations:
              summary: "The L2 gate is shut"
              description: "Deliveries are being requeued because the projection store is unusable. If PipelineNotConsuming is firing and this is not, the fault is the broker, not the store."

          - alert: WorkersMissing
            # Peak minus trough over five minutes at 15s resolution. Measured 0 across the
            # undisturbed baseline; 3 for a lost orchestrator StatefulSet, 2 for a lost
            # processor pair.
            expr: >
              (max_over_time((count(count by (service_instance_id) (present_over_time(pipeline_gate_open_ratio[40s]))))[5m:15s])
               - min_over_time((count(count by (service_instance_id) (present_over_time(pipeline_gate_open_ratio[40s]))))[5m:15s])) > 0
            for: 1m
            labels:
              severity: warning
            annotations:
              summary: "{{ $value }} worker replica(s) went away in the last five minutes"
              description: "Replicas stopped reporting. This lags the event by roughly the liveness window plus one export, so a short disappearance is reported after it has ended."

          - alert: EgressFaults
            # unroutable = the queue is not declared; transient = the broker is unreachable.
            # Opposite remedies, which is why the reason label travels in the annotation.
            expr: sum by (service_name,outcome) (increase(pipeline_messages_produced_total{outcome=~"transient|unroutable|refused"}[5m])) > 0
            for: 1m
            labels:
              severity: warning
            annotations:
              summary: "{{ $labels.service_name }} failed to publish ({{ $labels.outcome }})"
              description: "{{ $value | printf \"%.0f\" }} send(s) did not reach the broker in five minutes. transient = broker unreachable; unroutable = queue not declared."
```

Then, in the same ConfigMap's `prometheus.yml` key, add a `rule_files` stanza immediately after the `global:` block and before `scrape_configs:`:

```yaml
    rule_files:
      - /etc/prometheus/skp-rules.yml
```

- [ ] **Step 2: Mount the new key**

> **CORRECTION (final review).** This step originally read "No change to `k8s/21-prometheus.yaml` is needed. Its `prom-config` volume mounts the whole `prometheus-config` ConfigMap with no `items:` filter, so every key in it — including the new `skp-rules.yml` — appears under the mount path." **That was wrong on both counts**, and the implementer correctly deviated from it. The volume is not mounted as a directory at all: `21-prometheus.yaml` uses a single-file **`subPath`** mount (`mountPath: /etc/prometheus/prometheus.yml`, `subPath: prometheus.yml`), deliberately, so the image's `/etc/prometheus` console libs are not shadowed. A `subPath` mount exposes exactly the one key it names, so a new key appears nowhere. The manifest needs a **second `volumeMount` block** for `skp-rules.yml`, which is what shipped.

`k8s/21-prometheus.yaml` needs a second single-file `subPath` mount beside the existing one:

```yaml
            - name: prom-config
              mountPath: /etc/prometheus/skp-rules.yml
              subPath: skp-rules.yml
```

Verify rather than assume:

```bash
grep -n -B2 -A2 "subPath" k8s/21-prometheus.yaml
```

Expected: **two** `subPath` entries, `prometheus.yml` and `skp-rules.yml`, both under `name: prom-config`. If the rules mount is missing the file will not exist in the container and Prometheus will fail to start.

> **`subPath` mounts do not live-update.** This is the consequence that matters for every later rules edit. A ConfigMap projected as a *directory* is refreshed in place by the kubelet within a minute or two; a `subPath` mount is resolved once, at container start, and never again. So `kubectl apply -f k8s/02-configmaps.yaml` changes **nothing** inside the running Prometheus — the edit is invisible until the pod is replaced:
>
> ```bash
> kubectl -n skp rollout restart deploy/prometheus
> kubectl -n skp rollout status  deploy/prometheus --timeout=120s
> ```
>
> `POST /-/reload` does not help either: the file on disk is still the old one, so Prometheus re-reads the same content. Restarting Prometheus is cheap and safe — but note its TSDB is an `emptyDir` with no PVC, so a restart **discards all history**. Any rule with an `offset` needs that much fresh data before it can evaluate: `WorkersMissing`'s `offset 5m` reference reads 0 for the first five minutes after a restart. Wait for it to warm before drawing conclusions from a chaos run.

- [ ] **Step 3: Verify the rules parse before applying them**

A bad rule file makes Prometheus refuse to start, which takes every board down with it. Check it out of band first.

```bash
python - <<'PY'
import re, pathlib
text = pathlib.Path('k8s/02-configmaps.yaml').read_text(encoding='utf-8')
m = re.search(r'^\s*skp-rules\.yml:\s*\|\n(.*?)(?=\n\s*\w[\w.-]*:\s*\||\n---|\Z)', text, re.S | re.M)
assert m, 'skp-rules.yml key not found'
body = m.group(1)
indent = min(len(l) - len(l.lstrip()) for l in body.splitlines() if l.strip())
pathlib.Path('/tmp/skp-rules.yml').write_text(
    '\n'.join(l[indent:] for l in body.splitlines()), encoding='utf-8')
print('extracted', len(body.splitlines()), 'lines')
PY
kubectl -n skp cp /tmp/skp-rules.yml "$(kubectl -n skp get pod -l app=prometheus -o jsonpath='{.items[0].metadata.name}')":/tmp/skp-rules.yml
kubectl -n skp exec deploy/prometheus -- promtool check rules /tmp/skp-rules.yml
```

Expected: `SUCCESS: 5 rules found`. Any parse error must be fixed before Step 4 — do not apply an unvalidated rule file.

- [ ] **Step 4: Apply and confirm the rules loaded and are quiet**

```bash
kubectl apply -k k8s/
kubectl -n skp rollout restart deploy/prometheus && kubectl -n skp rollout status deploy/prometheus --timeout=120s
curl -s http://localhost:19090/api/v1/rules | python -c "
import json,sys
for g in json.load(sys.stdin)['data']['groups']:
    for r in g['rules']:
        print(f\"{r['name']:22} state={r.get('state','-')} alerts={len(r.get('alerts',[]))}\")"
```

Expected: five rules, every one `state=inactive` with `alerts=0` on a healthy stack. A rule firing here is a false positive and must be retuned before Task 7 — the whole point is that none of these cry wolf.

- [ ] **Step 5: Commit**

```bash
git add k8s/02-configmaps.yaml k8s/21-prometheus.yaml
git commit -m "feat(observability): alert on the signals the chaos suite proved move

Prometheus had evaluation_interval set and no rules, so the boards only helped
someone already looking. Five rules, each derived from a signal with both its
healthy and its fault value measured across the suite: telemetry staleness
first because everything else is downstream of it, then not-consuming, the L2
gate that separates a store fault from a broker fault, missing workers, and
egress faults. Nothing is asserted about landed=false, which has never
occurred on this stack. Validated with promtool and confirmed silent on a
healthy stack."
```

---

### Task 7: A scenario for partial replica loss

Every existing scenario is "a dependency vanishes **entirely**". `Replica fan-out` and `Consuming by queue` exist specifically to show one replica out of several failing while its peers keep working, and neither has ever been exercised — the panels that claim to cover the case are unproven. Scaling the processor deployment from 2 to 1 is the smallest fault that produces it: the broker round-robins across a shared queue, so the survivor silently absorbs the departed replica's share and **total throughput barely changes**. That is precisely the failure an aggregate hides.

A frozen process was the obvious way to model a "wedged" replica and does not work here: `FaultWitness` derives the observed fault window from log records, and a `SIGSTOP`ed process writes none — the witness would find no arrival edge and the scenario would fail as inconclusive rather than telling anyone why. A graceful scale-down emits `Templates.HostShuttingDown` on the way out and `Templates.ConsumptionAdmitted` on the way back, which are exactly the templates `FaultKind.Processor` already names. So this scenario reuses `FaultKind.Processor` unchanged and `FaultWitness` needs no edit at all.

**Files:**
- Modify: `src/tests/BaseApi.Tests/Live/Resilience/ClusterControl.cs` (add `HoldScaledToAsync`)
- Create: `src/tests/BaseApi.Tests/Live/Resilience/PartialReplicaLossScenarioTests.cs`
- Test: the scenario is the test.

**Interfaces:**
- Consumes: `ClusterControl.ScaleAsync(string kind, string name, int replicas, CancellationToken)`, `ClusterControl.WaitForReadyAsync`, `OrchestrationSoak.RunAsync`, `FaultSchedule`, `OutageVerdict.AssertNoUnaccountedLoss`, `FaultKind.Processor`.
- Produces: `ClusterControl.HoldScaledToAsync(string kind, string name, int to, int restoreTo, CancellationToken)` returning `IAsyncDisposable`. Nothing later depends on it.

- [ ] **Step 1: Write the failing scenario**

Create `src/tests/BaseApi.Tests/Live/Resilience/PartialReplicaLossScenarioTests.cs`:

```csharp
using Xunit;

namespace BaseApi.Tests.Live.Resilience;

/// <summary>
/// S8. One processor replica of two goes away while the other keeps working.
/// <para>
/// <b>Why this is not S6.</b> The processor scenario scales the deployment to zero, which every
/// aggregate on every board can see. This one takes away half the capacity: the two replicas share a
/// queue and the broker round-robins across it, so the survivor absorbs the departed replica's share
/// and total throughput barely moves. Nothing in an aggregate changes. `Replica fan-out` is the panel
/// that should show one series ending while the other carries on, and until this scenario existed it
/// had never been exercised by anything.
/// </para>
/// <para>
/// The obligation is unchanged and is the point: the survivor is entitled to every delivery the
/// departed replica did not take, so no step may be lost.
/// </para>
/// <para>
/// <b>Reuses <see cref="FaultKind.Processor"/> deliberately.</b> A graceful scale-down emits the same
/// shutdown and re-admission records whether one replica leaves or both do, and that kind already
/// carries the processor service filter the witness needs. A new kind would duplicate both.
/// </para>
/// </summary>
[Trait("Category", Chaos.Category)]
[Collection(Chaos.Category)]
public sealed class PartialReplicaLossScenarioTests
{
    [Fact]
    public async Task NoStepIsLostWhileOneOfTwoProcessorReplicasIsGone()
    {
        Chaos.SkipUnlessEnabled();

        var result = await OrchestrationSoak.RunAsync(
            new FaultSchedule(
                FaultKind.Processor,
                ct => ClusterControl.HoldScaledToAsync("deployment", "processor-sample", 1, 2, ct)),
            TestContext.Current.CancellationToken);

        OutageVerdict.AssertNoUnaccountedLoss(result);
    }
}
```

- [ ] **Step 2: Run it and watch it fail to compile**

```bash
cd /c/Users/UserL/source/repos/SK_P9
dotnet build src/tests/BaseApi.Tests -c Debug
```

Expected: FAIL with `'ClusterControl' does not contain a definition for 'HoldScaledToAsync'`.

- [ ] **Step 3: Add the cluster control**

In `src/tests/BaseApi.Tests/Live/Resilience/ClusterControl.cs`, immediately after `HoldScaledDownAsync` (line 102), add:

```csharp
    /// <summary>Scales a workload to a non-zero replica count and restores it on disposal.</summary>
    /// <remarks>
    /// Separate from <see cref="HoldScaledDownAsync"/> rather than a parameter on it, because the two
    /// mean different things to a reader: that one takes a dependency away, this one takes away
    /// SOME of it. A scenario that scaled "to zero, but one" would read as a mistake.
    /// </remarks>
    public static async Task<IAsyncDisposable> HoldScaledToAsync(
        string kind, string name, int to, int restoreTo, CancellationToken ct)
    {
        if (to <= 0)
        {
            throw new ArgumentOutOfRangeException(
                nameof(to), to, "use HoldScaledDownAsync to take a workload away entirely");
        }

        await ScaleAsync(kind, name, to, ct);
        return new ScaledDown(kind, name, restoreTo);
    }
```

`ScaledDown` is reused unchanged: it already scales back to `restoreTo` first, on its own six-minute token, and waits for readiness afterwards. Nothing about restoring from 1 differs from restoring from 0.

- [ ] **Step 4: Build**

```bash
dotnet build src/tests/BaseApi.Tests -c Debug
```

Expected: `Build succeeded. 0 Warning(s) 0 Error(s)`.

- [ ] **Step 5: Confirm the hermetic suite is untouched**

The new file is under `Live/`, so it must skip without the two gates and must not move the hermetic numbers.

```bash
cd src/tests/BaseApi.Tests && dotnet run --no-build -c Debug
```

Expected: read the shape, not the total — every non-`Live/` test passing, `Live/` skipped, exit 0. The skipped count rises by exactly one against the previous baseline; failed stays 0.

- [ ] **Step 6: Run the scenario against the cluster, watched**

Stop the standing orchestration and wait out the drain window first — the soak's drain check fails on any dispatch in the last 40s.

```bash
cd /c/Users/UserL/source/repos/SK_P9
curl -s -X POST http://localhost:18080/api/v1/orchestration/stop \
  -H 'Content-Type: application/json' -d '"4cd8af45-1295-43db-ab2e-e955dd82b5c5"'
sleep 55
export NODE_PATH="$PWD/grafana/node_modules"
node grafana/chaos-timeline.js --label s8-partial --duration 560 --interval 15 &
sleep 25
SKP_REALSTACK=1 SKP_CHAOS=1 dotnet run --project src/tests/BaseApi.Tests --no-build -c Debug -- \
  --filter-class "BaseApi.Tests.Live.Resilience.PartialReplicaLossScenarioTests"
wait
```

Expected: the scenario passes.

- [ ] **Step 7: Answer the question the scenario exists to ask**

The passing scenario proves the pipeline is fine. It says nothing about the boards, which is the actual subject. From the sampled timeline:

```bash
python - <<'PY'
import json, pathlib, collections
d = pathlib.Path('.chaos-timeline/s8-partial/timeline.jsonl')
seen = collections.defaultdict(list)
for line in d.read_text(encoding='utf-8').splitlines():
    if not line.strip():
        continue
    r = json.loads(line)
    if r['board'] != 'skp-processor':
        continue
    for pn in r['panels']:
        if pn['title'] in ('Replica fan-out', 'Consuming by queue', 'Consumer inflight by queue'):
            seen[pn['title']].append((r['elapsed'], pn['value'][:90]))
for title, rows in seen.items():
    print('##', title)
    prev = None
    for t, v in rows:
        if v != prev:
            print(f'  {t:>4}s  {v}')
            prev = v
PY
```

Judge it: did `Replica fan-out` show one series ending while the other carried on, and did any aggregate on the Flow board move at all? **If every panel stayed flat, the wedge is invisible and that is the finding** — record it in `grafana/README.md` under the gaps, with the numbers, rather than letting a passing scenario stand in for a working dashboard.

- [ ] **Step 8: Commit**

```bash
git add src/tests/BaseApi.Tests/Live/Resilience/PartialReplicaLossScenarioTests.cs \
        src/tests/BaseApi.Tests/Live/Resilience/ClusterControl.cs
git commit -m "test(chaos): one processor replica of two, not both

Every scenario so far takes a dependency away entirely. Replica fan-out and
Consuming by queue exist to show one replica failing while its peers work, and
neither had ever been exercised: the replicas share a queue and the broker
round-robins, so a survivor absorbs the departed replica's share and no
aggregate moves.

A frozen process was the obvious model and does not work here -- FaultWitness
derives its window from log records and a SIGSTOPed process writes none, so the
scenario would fail as inconclusive rather than say why. A graceful scale-down
emits the same shutdown and re-admission records as the existing processor
scenario, so this reuses FaultKind.Processor and the witness is untouched."
```

---

### Task 8: Re-run the whole suite and record what changed

Both calibration errors in the previous round were found by running the suite a second time, not by reasoning. Tasks 3, 4 and 5 all change what the panels mean, so this is not optional.

**Files:**
- Modify: `grafana/README.md` — the measured detection latencies in "What the second run through the suite showed"

**Interfaces:**
- Consumes: everything above.
- Produces: the updated latency numbers the README quotes.

- [ ] **Step 1: Verify nothing else is driving the cluster**

A background task reported as `killed` may still be running; two orphaned runners racing the same scenario already invalidated three runs once.

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe' or Name='dotnet.exe' or Name='bash.exe'" |
  Where-Object { $_.CommandLine -like '*chaos-timeline*' -or $_.CommandLine -like '*BaseApi.Tests*' -or $_.CommandLine -like '*run-*' } |
  Select-Object ProcessId, Name, CommandLine
```

Expected: no rows. Kill anything listed with `Stop-Process -Id <pid> -Force` and re-check until the count is 0.

- [ ] **Step 2: Run all eight scenarios, one at a time**

Launch the sampler as its own background job and the test in the foreground, so losing one cannot lose the other. Between scenarios, stop the workflow and wait 55s.

```bash
for pair in "s1-happy HappyPathScenarioTests" \
            "s2-redis RedisUnavailableScenarioTests" \
            "s3-rabbit RabbitUnavailableScenarioTests" \
            "s4-both BothUnavailableScenarioTests" \
            "s5-orch OrchestratorUnavailableScenarioTests" \
            "s6-proc ProcessorUnavailableScenarioTests" \
            "s7-wipe RedisWipeScenarioTests" \
            "s8-partial PartialReplicaLossScenarioTests"; do
  set -- $pair
  curl -s -X POST http://localhost:18080/api/v1/orchestration/stop \
    -H 'Content-Type: application/json' -d '"4cd8af45-1295-43db-ab2e-e955dd82b5c5"'
  sleep 55
  node grafana/chaos-timeline.js --label "r3-$1" --duration 560 --interval 15 &
  sleep 25
  SKP_REALSTACK=1 SKP_CHAOS=1 dotnet run --project src/tests/BaseApi.Tests --no-build -c Debug -- \
    --filter-class "BaseApi.Tests.Live.Resilience.$2"
  wait
done
```

Expected: eight passes.

- [ ] **Step 3: Measure the detection latency for each fault**

For each scenario, the fault is injected 150s after the soak's t0 and released at 210s. Compare the first sample at which a verdict stat changed against the `kubectl` transition, exactly as the previous round did. The number to beat is the one in the README: **~110s** for an absent replica at the old cadence.

Expected: roughly **30-45s**, being one liveness window (40s) plus at most one export (10s). If it has not improved, Task 3 or Task 4 did not take effect — re-check `count_over_time(<series>[2m]) == 8` and the datasource's `timeInterval`.

- [ ] **Step 4: Update the README with the new numbers and the three findings this run produced**

Four edits to `grafana/README.md`, all in or beside the "What the second run through the suite showed" section.

**(a) The latencies.** Replace the measured detection latencies with the ones from Step 3, and state the export cadence they were measured at. Leave the old numbers visible as the before-figure — they are the evidence the change mattered.

**(b) The resolution floor section is now wrong and must be rewritten, not appended to.** It currently says `timeInterval: 60s` makes `$__rate_interval` 240s and that no rate panel can resolve a 60-second fault. That was true and is not any more. State the new chain: the services export every 10s, Prometheus scrapes every 15s, so the effective resolution is 15s and `$__rate_interval` is 60s. Keep the old figures as the before-case.

**(c) Partial replica loss — what the new scenario found.** Add it under the gaps, with all three parts, because the shape of the finding is the useful bit:

> Scaling the processor deployment from 2 to 1 is the first scenario that removes *part* of a
> dependency rather than all of it. The pipeline held — no step lost. What the boards did with
> it is more interesting than that:
>
> - **`Replica fan-out` did not show it.** It is `sum by (service_instance_id) (rate(...))`
>   over a counter that is stale-held after its process dies, so a departed replica's series
>   persists at rate zero instead of ending. The line flattens; it never stops.
> - **`Consuming by queue` cannot show it at all.** Both processor replicas consume one shared
>   queue, so a per-queue panel has no per-replica resolution by construction. This panel was
>   never capable of this case, which is worth saying outright rather than filing as a miss.
> - **`Workers reporting` and `Workers missing (5m)` did show it** — 5→4 and 0→1 — and are the
>   only things that did.
>
> So the two panels built to expose one-replica-of-many failing are not the ones that expose
> it. The worker-count stats are.

**(d) Grafana restarts destroy every dashboard.** Add this to the gaps too — it is not caused by this work, it was found by it, and it is the kind of thing that is only discovered the expensive way:

> The `grafana-dashboards` ConfigMap is empty and Grafana's storage is an `emptyDir`, so
> **any restart of the Grafana pod loses every hand-imported board.** This was found when a
> mandated rollout restart wiped `skp-runtime`, which is the one board the generator cannot
> rebuild. The README already says boards are imported by hand; it did not say that a restart
> is destructive, which is the part that actually costs you something. Re-import from
> `grafana/dashboards/` after any Grafana restart. Fixing it properly means provisioning the
> boards or giving Grafana a PVC.

- [ ] **Step 5: Restart the standing orchestration**

```bash
curl -s -X POST http://localhost:18080/api/v1/orchestration/start \
  -H 'Content-Type: application/json' -d '"4cd8af45-1295-43db-ab2e-e955dd82b5c5"'
curl -s http://localhost:19090/api/v1/query \
  --data-urlencode 'query=sum(rate(pipeline_messages_produced_total{type="process-dispatch"}[4m]))' \
  | python -c "import json,sys;r=json.load(sys.stdin)['data']['result'];print('dispatch rate:', r[0]['value'][1] if r else 'none')"
```

Expected: `202` from the start, and a dispatch rate settling near `0.367` — the healthy baseline. Give it four minutes for the rate window to fill before judging it.

- [ ] **Step 6: Commit**

```bash
git add grafana/README.md
git commit -m "docs(grafana): record detection latency at the 15s resolution

Re-ran all eight scenarios after the cadence change. The numbers replace the
ones measured at 60s; the old figures stay in the text as the before-case,
since they are the evidence the change was worth making."
```

---

## Out of scope, deliberately

**The L2 epoch gauge.** A wipe and a pause render identically on every board — gate 0, consuming 0 — and the operational difference between them is total: one means wait, the other means the data is gone. `pipeline.duplicate.suppressed` looked like the discriminator and is not: the counter is correctly wired to the entry-absent branch at `src/BaseProcessor.Core/Processing/ProcessDispatchHandler.cs:175`, so its silence means that branch never executed, not that the instrument is broken. A positive wipe signal is the right answer and it is new production code whose design is not settled — where the epoch lives, who writes it, whether it survives a legitimate flush. That needs a brainstorm and its own plan, not a task appended here.

**A fault that produces `landed="false"`.** `Ack lost` has never been non-zero, so that path is unverified. Producing it means closing a broker connection mid-handler through the management API, which is a fault-injection mechanism this suite does not have.

**A slow rather than absent dependency.** Every scenario removes something; none makes it merely late, which is the more common production failure and the one the duration histograms exist for. `CLIENT PAUSE` is the wrong tool — it blocks rather than delays — and doing it properly needs latency injection in front of Redis or the broker, which means running a proxy this cluster does not have. That is an infrastructure decision, not a test to be written, so it stays out until someone has decided whether a proxy belongs in the dev stack.
