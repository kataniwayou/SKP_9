# Per-Replica Panels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the two panels that claim to show one replica of many failing actually distinguish a departed replica from a working one, and prove it against a scenario.

**Architecture:** `Replica fan-out` and `Consuming by queue` are the only panels that can resolve a single replica, and the partial-replica-loss scenario showed neither reacts usefully when one of two processors goes away. Neither is broken exactly — both are ambiguous. `Replica fan-out` rates a counter that is stale-held after its process dies, so a departure *decays toward zero* over the rate window and looks identical to a replica that stopped working. `Consuming by queue` aggregates `min by (queue)`, and both processor replicas share one queue, so it cannot name which replica is at fault. Two expression changes fix both, and the existing scenario proves them.

**Tech Stack:** Python 3.11 generator (`grafana/build-dashboards.py`), Grafana 12.3.9, Prometheus, xUnit v3 (Microsoft.Testing.Platform), Playwright.

**Spec:** `grafana/README.md`, the "Partial replica loss" bullet under the open gaps — the measured result this plan responds to.

## Global Constraints

- **Dashboards are generated.** Edit `grafana/build-dashboards.py` and regenerate with `python grafana/build-dashboards.py`. **Never hand-edit `grafana/dashboards/*.json`** — the orchestrator and processor boards share six panels emitted from `pipeline_shared()` precisely so they cannot drift.
- Re-import generated boards over the Grafana API (`http://localhost:13000`, admin:admin). **Never restart Grafana** — its storage is an `emptyDir` and a restart destroys every hand-imported board, including `skp-runtime`, which the generator cannot rebuild.
- `LIVENESS` is `"40s"` and lives in `grafana/build-dashboards.py`. Every liveness window must use it, not a literal — `grafana/check-expressions.py` enforces this and will fail the build if they disagree.
- Chaos gates: `SKP_REALSTACK=1` and `SKP_CHAOS=1`. **`--filter` is not a flag this runner has** — it prints its help text and runs nothing, which reads like a hang. Use `--filter-class`.
- The soak's drain check fails if the standing orchestration (`4cd8af45-1295-43db-ab2e-e955dd82b5c5`) fired in the last 40s. Stop it and wait 55s before any scenario.
- Never scale Redis. `references/` is read-only.
- Playwright is at `grafana/node_modules`; `export NODE_PATH="$PWD/grafana/node_modules"`.

---

### Task 1: Make a departed replica end its line instead of fading

`Replica fan-out` is `sum by (service_instance_id) (rate(pipeline_messages_consumed_total{...,disposition="acked"}[$__rate_interval]))`. When a replica goes away its counter is stale-held by the collector and by Prometheus's lookback, so `rate()` keeps returning a decaying non-zero value until the last sample leaves the window. The line sags to zero over a minute and then persists at zero — visually identical to a replica that is present and doing nothing, which is the exact distinction this panel exists to draw.

Gating the series on liveness makes the two cases look different: **a line that ends is a replica that left; a line flat at zero beside working peers is a replica that stopped working.**

**Files:**
- Modify: `grafana/build-dashboards.py` — the `Replica fan-out` panel in `build_processor()` (currently near line 1266; locate it by its title, not its line number)
- Regenerate: `grafana/dashboards/skp-processor.json`

**Interfaces:**
- Consumes: `LIVENESS` and the `live()` helper already defined in the generator.
- Produces: nothing later tasks depend on structurally; Task 3 judges the rendered result.

- [ ] **Step 1: Change the expression and rewrite the description**

Replace the `Replica fan-out` panel with:

```python
        timeseries(lay, "Replica fan-out",
                   [(f'sum by (service_instance_id) (rate(pipeline_messages_consumed_total'
                     f'{{{f},disposition="acked"}}[$__rate_interval])) '
                     f'and on(service_instance_id) '
                     f'present_over_time(pipeline_identity_ready_ratio{{{f}}}[{LIVENESS}])',
                     "{{service_instance_id}}")],
                   desc="Replicas share one queue, so the broker round-robins. A "
                        "replica sitting near zero while the others work is consuming "
                        "nothing despite looking healthy." + PARA +
                        "**A line that ENDS is a replica that left; a line flat at zero "
                        "beside working peers is a replica that stopped working.** Those "
                        "are different incidents and the panel could not tell them apart "
                        "before: a departed replica's counter is stale-held by the "
                        "collector and by Prometheus's lookback, so `rate()` returned a "
                        "decaying value for a full rate window and the line sagged to "
                        "zero rather than stopping. The `and on(service_instance_id) "
                        "present_over_time(...)` clause drops any replica that has not "
                        "reported inside the liveness window, so a departure now ends "
                        "the series." + PARA +
                        "Measured: when one of two processors was scaled away, this "
                        "panel kept drawing the departed replica for the rest of the run "
                        "and only ever gained the replacement's name.",
                   unit="reqps"),
```

The `and on(service_instance_id)` form is a filter, not an arithmetic join: it keeps left-hand samples whose `service_instance_id` has a match on the right, and drops the rest. `pipeline_identity_ready_ratio` is the right liveness witness here because every processor replica exports it once per export interval regardless of whether it is consuming — so it says "this replica is reporting", which is exactly the question, and it does not go quiet just because the replica has no work.

- [ ] **Step 2: Regenerate and check the expression against live Prometheus**

```bash
cd /c/Users/UserL/source/repos/SK_P9
python grafana/build-dashboards.py
python grafana/check-expressions.py http://localhost:19090
```

Expected: `skp-processor.json` regenerates, and the summary line reports `0 invalid`. One empty panel ("Dependency name resolution" on skp-baseapi) is expected and pre-existing — no DNS-failure series exist on a healthy stack. `check_liveness_windows()` must also pass; it fails the run if any liveness window disagrees with `LIVENESS`.

- [ ] **Step 3: Prove the new expression drops a departed replica, using data already on disk**

The previous partial-replica-loss run is still in Prometheus. Compare old and new forms across a window where one replica was absent:

```bash
python - <<'PY'
import json, urllib.parse, urllib.request, datetime
P = "http://localhost:19090"
def series_count(expr, when):
    u = P + "/api/v1/query?" + urllib.parse.urlencode({"query": expr, "time": when.timestamp()})
    return len(json.load(urllib.request.urlopen(u, timeout=20))["data"]["result"])
OLD = 'sum by (service_instance_id) (rate(pipeline_messages_consumed_total{disposition="acked",service_name="sample-proc-v9"}[1m]))'
NEW = OLD + ' and on(service_instance_id) present_over_time(pipeline_identity_ready_ratio{service_name="sample-proc-v9"}[40s])'
now = datetime.datetime.now(datetime.timezone.utc)
print(f"{'':22} old  new")
print(f"{'now (both alive)':22} {series_count(OLD, now):>3}  {series_count(NEW, now):>3}")
PY
```

Expected on a healthy stack: both forms report the same number of series (2). That proves the filter does not drop live replicas — the false-positive direction. The true-positive direction (a departure ending the line) is Task 3's job, against a live fault. **Do not claim the panel is fixed on the strength of this step alone** — that is the same half-test that let two unfireable alert rules ship.

- [ ] **Step 4: Re-import the processor board**

```bash
python -c "
import json
d=json.load(open('grafana/dashboards/skp-processor.json',encoding='utf-8'))
print(json.dumps({'dashboard':d,'overwrite':True,'message':'replica fan-out liveness gating'}))" > /tmp/imp.json
curl -s -u admin:admin -X POST http://localhost:13000/api/dashboards/db \
  -H 'Content-Type: application/json' --data-binary @/tmp/imp.json \
  | python -c "import json,sys;r=json.load(sys.stdin);print(r.get('status'),r.get('version'))"
```

Expected: `success` and a version number.

- [ ] **Step 5: Commit**

```bash
git add grafana/build-dashboards.py grafana/dashboards/skp-processor.json
git commit -m "fix(grafana): make a departed replica end its line, not fade

Replica fan-out rates a counter the collector stale-holds after its process
dies, so a departure decayed toward zero over a full rate window and looked
exactly like a replica that was present and idle -- the one distinction the
panel exists to draw. Gating the series on a liveness witness ends the line
instead. A line that stops is a replica that left; a line flat at zero beside
working peers is a replica that stopped working."
```

---

### Task 2: Let `Consuming by queue` name the replica

`Consuming by queue` is `min by (queue) (last_over_time(pipeline_consumer_consuming_ratio{...}[40s]))`. On the orchestrator that is right: five queues, and a queue reading 0 while the others read 1 is one wedged consumer. On the processor it is not, because **both replicas consume one shared queue** — the `min` collapses across them, so the panel can say a consumer is wedged but never which one.

`pipeline_shared()` emits this panel for both boards, and that sharing is deliberate: the two boards must not drift. So the difference goes in as an explicit parameter, exactly as `role_f` already does.

**Files:**
- Modify: `grafana/build-dashboards.py` — `pipeline_shared()` (signature at line 541) and its two call sites (`build_orchestrator` line 1128, `build_processor` line 1230). Locate by name, not line number, since Task 1 shifts them.
- Regenerate: `grafana/dashboards/skp-processor.json` (and `skp-orchestrator.json`, which must come out unchanged apart from panel ids)

**Interfaces:**
- Consumes: nothing from Task 1 beyond a regenerated tree.
- Produces: `pipeline_shared(layout, f, role_f="", by_instance=False)`.

- [ ] **Step 1: Add the parameter to the shared function**

Change the signature from `def pipeline_shared(layout, f, role_f=""):` to:

```python
def pipeline_shared(layout, f, role_f="", by_instance=False):
```

and extend its docstring with:

```
    by_instance splits "Consuming by queue" per replica. On the orchestrator that would
    draw five queues times three replicas on one axis, which the panel's own note already
    warns is unreadable -- and it gains nothing there, because each orchestrator queue has
    one consumer. On the processor every replica consumes the SAME queue, so without this
    the min collapses across them and the panel can say a consumer is wedged but never
    which. A parameter rather than two copies of the panel, for the reason role_f is a
    parameter: these two boards must not drift.
```

- [ ] **Step 2: Use it in the panel**

Replace the `Consuming by queue` panel body inside `pipeline_shared` with:

```python
        timeseries(layout, "Consuming by queue" + (" and replica" if by_instance else ""),
                   [(f'min by (queue{",service_instance_id" if by_instance else ""}) '
                     f'({live(f"pipeline_consumer_consuming_ratio{{{f}}}")})',
                     "{{queue}}" + (" / {{service_instance_id}}" if by_instance else ""))],
                   desc="Per-queue view of the verdict stat. A queue reading 0 while "
                        "the others read 1 is one wedged consumer, not an outage." + PARA +
                        ("Split per replica on this board because every replica consumes "
                         "the SAME queue, so a min across the queue alone cannot name which "
                         "replica stopped. On the orchestrator each queue has one consumer "
                         "and the split would only add lines."
                         if by_instance else
                         "Aggregated by queue on this board because each queue has one "
                         "consumer. The processor board splits this per replica, where "
                         "every replica shares one queue.") + PARA +
                        "A line that ENDS is a replica that left; a line at 0 is one that "
                        "is present and not consuming." + PARA +
                        "Unfilled on purpose: the orchestrator has five queues, all sitting "
                        "at 1 in health, and five filled areas stacked on one line render as "
                        "a single opaque block in which a dip is invisible.",
                   minv=0, maxv=1, decimals=0, fill=0, draw_style="line"),
```

- [ ] **Step 3: Turn it on for the processor only**

In `build_processor()`, change `panels += pipeline_shared(lay, f)` to:

```python
    panels += pipeline_shared(lay, f, by_instance=True)
```

Leave `build_orchestrator()`'s call (`panels += pipeline_shared(lay, f, role_f=rf)`) alone.

- [ ] **Step 4: Regenerate and confirm the orchestrator board did not change in substance**

```bash
python grafana/build-dashboards.py
python grafana/check-expressions.py http://localhost:19090
git diff grafana/dashboards/skp-orchestrator.json | grep -E '^[+-]' | grep -v '^[+-][+-]' | grep -vE '^\s*[+-]\s*"id":'
```

Expected: `0 invalid` from the expression check, and the last command prints **nothing** — the orchestrator board must differ only in panel ids, if at all. Any substantive orchestrator hunk means `by_instance` leaked into the wrong board.

- [ ] **Step 5: Re-import both worker boards**

```bash
for f in skp-processor skp-orchestrator; do
  python -c "
import json
d=json.load(open('grafana/dashboards/$f.json',encoding='utf-8'))
print(json.dumps({'dashboard':d,'overwrite':True,'message':'consuming-by-queue per replica'}))" > /tmp/imp.json
  curl -s -u admin:admin -X POST http://localhost:13000/api/dashboards/db \
    -H 'Content-Type: application/json' --data-binary @/tmp/imp.json \
    | python -c "import json,sys;r=json.load(sys.stdin);print('$f',r.get('status'),r.get('version'))"
done
```

Expected: two `success` lines.

- [ ] **Step 6: Commit**

```bash
git add grafana/build-dashboards.py grafana/dashboards
git commit -m "fix(grafana): let Consuming by queue name the replica on the processor

Both processor replicas consume one shared queue, so min by (queue) collapsed
across them -- the panel could say a consumer was wedged and never which one.
The orchestrator keeps the aggregate: each of its queues has one consumer, and
five queues times three replicas on one axis is the opacity the panel's own
note warns about. A parameter rather than two copies, for the reason role_f is
a parameter: these two boards must not drift."
```

---

### Task 3: Prove it against a live fault, and record what it shows

Both changes are so far verified only in the false-positive direction — they do not drop live replicas. Whether a departure actually ends a line is a claim about a fault, and only a fault can settle it. This project has already shipped two alert rules that were validated exactly that far and turned out to be incapable of firing.

**Files:**
- Modify: `grafana/README.md` — the "Partial replica loss" bullet under the open gaps

**Interfaces:**
- Consumes: the regenerated and re-imported boards from Tasks 1 and 2.
- Produces: the recorded result.

- [ ] **Step 1: Confirm you are the only thing driving the cluster**

```bash
powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe' or Name='dotnet.exe'\" | Where-Object { \$_.CommandLine -like '*chaos-timeline*' -or \$_.CommandLine -like '*BaseApi.Tests*' } | Select-Object ProcessId,CommandLine"
```

Expected: no rows. A background job reported as killed may still be running; two orphaned runners racing the same scenario invalidated three runs earlier in this project.

- [ ] **Step 2: Run the partial-replica-loss scenario with the sampler**

```bash
cd /c/Users/UserL/source/repos/SK_P9
curl -s -X POST http://localhost:18080/api/v1/orchestration/stop \
  -H 'Content-Type: application/json' -d '"4cd8af45-1295-43db-ab2e-e955dd82b5c5"'
sleep 55
export NODE_PATH="$PWD/grafana/node_modules"
node grafana/chaos-timeline.js --label r5-partial --duration 560 --interval 15 &
sleep 25
SKP_REALSTACK=1 SKP_CHAOS=1 dotnet run --project src/tests/BaseApi.Tests --no-build -c Debug -- \
  --filter-class "BaseApi.Tests.Live.Resilience.PartialReplicaLossScenarioTests"
wait
```

Expected: the scenario passes. Its passing proves the pipeline is fine and says nothing about the panels.

- [ ] **Step 3: Judge the two panels from the sampled timeline**

```bash
python - <<'PY'
import json, pathlib, collections
p = pathlib.Path('.chaos-timeline/r5-partial/timeline.jsonl')
seen = collections.defaultdict(list)
for line in p.read_text(encoding='utf-8').splitlines():
    if not line.strip():
        continue
    r = json.loads(line)
    if r['board'] != 'skp-processor':
        continue
    for pn in r['panels']:
        if pn['title'].startswith(('Replica fan-out', 'Consuming by queue')):
            seen[pn['title']].append((r['elapsed'], pn['value'][:100]))
for title, rows in seen.items():
    print('##', title)
    prev = None
    for t, v in rows:
        if v != prev:
            print(f'  {t:>4}s  {v}')
            prev = v
PY
```

The legend text is the evidence. **Pass:** during the fault window the departed replica's name disappears from `Replica fan-out`'s legend and returns at restore, and `Consuming by queue and replica` carries a per-replica series whose departed member likewise drops out. **Fail:** the departed name persists through the window, exactly as it did before these changes.

Report what you see. If it fails, say so and stop — do not adjust the liveness window to force it, because a window wide enough to fix a rendering complaint is a window too wide to detect an absence, which is the trade this project has already got wrong twice.

- [ ] **Step 4: Record the result in the README**

Rewrite the "Partial replica loss" bullet under the open gaps. Keep the original measurement as the before-case — it is why the panels are shaped this way — and add what the panels do now. If the result was a failure, record the failure; a gap honestly described is worth more than a fix wrongly claimed.

- [ ] **Step 5: Restart the standing orchestration**

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:18080/api/v1/orchestration/start \
  -H 'Content-Type: application/json' -d '"4cd8af45-1295-43db-ab2e-e955dd82b5c5"'
```

Expected: `202`. Wait four minutes, then confirm `sum(rate(pipeline_messages_produced_total{type="process-dispatch"}[4m]))` is near 0.35. A 422 naming processor liveness means the pods have not finished their two-stage boot — wait 60s and retry once.

- [ ] **Step 6: Commit**

```bash
git add grafana/README.md
git commit -m "docs(grafana): record what the per-replica panels do now

The partial-replica-loss scenario is the only thing that can settle whether a
departure ends a line, and the before-case stays in the text: both panels drew
the departed replica for the rest of the run and only ever gained the
replacement's name."
```

---

## Out of scope, and why

**A genuinely wedged replica — alive, exporting, not consuming — still cannot be tested, and `SIGSTOP` is not the way in.** This was investigated before the plan was written, so the negative result is worth recording rather than rediscovering:

- The processor image is distroless and has no `kill` binary, so `kubectl exec -- kill` fails with `executable file not found in $PATH`.
- `kubectl debug --image=busybox:1.36 --target=processor-sample` does work — it shares the target's PID namespace, PID 1 is `dotnet`, and `kill -0 1` from the ephemeral container succeeds. Verified on this cluster (k8s v1.34.3). Note that an ephemeral container cannot be removed from a running pod; it persists until the pod is replaced.
- **But a `SIGSTOP`ed process stops exporting metrics too.** From Prometheus it is indistinguishable from a departed replica, which is the case Tasks 1 and 2 already cover. So the mechanism works and wedges the wrong thing.

A real wedge needs the process to keep running and reporting while its consumer stops taking deliveries — most plausibly by closing that replica's AMQP connection through the RabbitMQ management API and observing whether recovery leaves it consuming. That needs its own investigation before it can be planned, and `Consuming by queue and replica` is the panel it would exercise. Until then this plan makes both panels unambiguous for the departure case and honest about the rest.

**The wipe/pause discriminator and the missing Alertmanager** remain open and are recorded in `grafana/README.md`. Neither belongs here.
