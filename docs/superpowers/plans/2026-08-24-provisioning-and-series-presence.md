# Provisioning and Series Presence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the dashboards survive a Grafana restart by provisioning them from the repo, and give the chaos probe the one reading it lacks — whether a *series* stopped, rather than whether the pooled values moved.

**Architecture:** Two independent changes to existing tooling, neither of which touches production code.

The first restores provisioning. The provider ConfigMap is already fully written — file provider, `SKP` folder, `disableDeletion: true`, `allowUiUpdates: false`, 30s re-read — and only `grafana-dashboards` is empty. Provisioning was torn out so the boards could be edited in the UI, and that trade has since expired: the workflow is now "edit `build-dashboards.py`, never the JSON", so the editability being paid for is not used. `build-dashboards.py` gains a ConfigMap emitter, because kustomize's `configMapGenerator` cannot read `../grafana/dashboards/*.json` without `--load-restrictor LoadRestrictionsNone`, and generating the manifest keeps "the boards are generated" true all the way to the cluster.

The second closes the blind spot that produced a wrong finding on 2026-08-24. `chaos-probe.py` already range-queries every panel expression across a fault window, but `seg()` pools every sample from every series into one list, so a panel whose *one* replica departed still reports values throughout — the survivor's. Per-series presence is a set operation on top of the range data the probe already fetches: which series had a real sample before the fault, which during, which after.

**Tech Stack:** Python 3.11 (stdlib only — no PyYAML, no pytest), kubectl, kustomize (via `kubectl apply -k`), Grafana 12.3.9, Prometheus.

**Spec:** `grafana/README.md` — the sections **"Grafana restarts destroy every dashboard"** (Task 1) and **"A Grafana legend is not evidence that a line is still being drawn"** (Task 2). Both record the measured failures these tasks respond to.

## Global Constraints

- **Never restart Grafana.** Its storage is an `emptyDir` and a restart destroys every hand-imported board. Everything here is designed to avoid one: a ConfigMap change reaches the pod through the kubelet's own refresh (~60s) and the provider re-reads every 30s. **Do not `kubectl rollout restart`, do not delete the pod, and do not `kubectl apply -k k8s/` wholesale** — apply the single ConfigMap file by name.
- **Dashboards are generated.** Edit `grafana/build-dashboards.py` and regenerate. Never hand-edit `grafana/dashboards/*.json`. `skp-runtime.json` is the exception — it is not generated, only nav-stamped by `normalize_imported()`, and it *is* tracked in git.
- **`LIVENESS` is `"40s"`** and lives in `grafana/build-dashboards.py`. `grafana/check-expressions.py` fails the build if any liveness window disagrees. This plan does not change it.
- **The ConfigMap ceiling is 1 MiB.** The five boards total ~248 KB, roughly 4x under. If they ever approach ~700 KB the remedy documented in `k8s/23-grafana.yaml` is to split into two ConfigMaps and add a second provider entry. Do not pre-split.
- **Newlines are `chr(10)`, not an escape.** This file already does that
  (`PARA = chr(10) + chr(10)`), and it survives being pasted through tooling that
  collapses backslash escapes -- which turned a `|\n` into a real newline once and
  produced an unterminated string literal.
- **No new dependencies.** `check-expressions.py` and `chaos-probe.py` are stdlib-only standalone scripts, and there is no pytest in this environment. Tests are plain-`assert` scripts that exit non-zero, matching `check-expressions.py`'s "a script that fails the build" idiom.
- Prometheus is at `http://localhost:19090`, Grafana at `http://localhost:13000` (admin:admin, and anonymous access is ON with org role Viewer).
- `references/` is read-only. Never scale Redis.

---

### Task 1: Provision the dashboards from the repo

The five boards exist only inside a pod's `emptyDir`. They are all tracked in git and the live `skp-runtime` matches its checked-in copy panel-for-panel, so a restart today costs re-import toil rather than the board — but it is toil on every restart, it blocks deploying these boards to any other cluster, and it means the thing an operator opens is not the thing in version control.

**Files:**
- Modify: `grafana/build-dashboards.py` — add `write_configmap()` and call it from `main()`
- Create: `k8s/24-grafana-dashboards.yaml` — generated, ~250 KB, contains all five boards
- Modify: `k8s/kustomization.yaml` — add the new resource
- Modify: `k8s/23-grafana.yaml` — correct the two comments that describe a `configMapGenerator` that no longer exists

**Interfaces:**
- Consumes: `OUT` (the `grafana/dashboards` path) already defined in the generator.
- Produces: `write_configmap()`, and a ConfigMap named exactly `grafana-dashboards` in namespace `skp` — the name the Deployment's `gf-dashboards` volume already references. **The name must not change.**

- [ ] **Step 1: Add the ConfigMap emitter to the generator**

Add near the top of `grafana/build-dashboards.py`, just below `OUT = pathlib.Path(__file__).parent / "dashboards"`:

```python
K8S_CM = pathlib.Path(__file__).parent.parent / "k8s" / "24-grafana-dashboards.yaml"

CM_HEADER = """\
# GENERATED by grafana/build-dashboards.py -- do not edit this file.
#
# Every board in grafana/dashboards/, inlined so Grafana provisions them from the repo
# instead of from whatever a human last imported by hand. The provider that consumes this
# is `grafana-dashboard-provider` in 23-grafana.yaml: folder SKP, disableDeletion true,
# allowUiUpdates FALSE, re-read every 30s.
#
# WHY A GENERATED MANIFEST RATHER THAN A configMapGenerator. kustomize refuses to read
# files above its own kustomization directory (`../grafana/dashboards/*.json`) unless it is
# run with --load-restrictor LoadRestrictionsNone, which would have to be remembered at
# every apply. Emitting the ConfigMap from the generator keeps a single source of truth --
# the boards are generated all the way to the cluster -- and needs no flags.
#
# APPLYING THIS DOES NOT AND MUST NOT RESTART GRAFANA. The pod's storage is an emptyDir;
# a restart destroys anything not provisioned. Apply this file by name, never `-k` the
# whole directory. The kubelet refreshes the mounted files (~60s) and the provider re-reads
# them (30s), so the boards update in place within about 90s.
#
# allowUiUpdates: false means a UI Save is rejected with `Cannot save provisioned
# dashboard` (HTTP 400). That is the point: it makes the repo the single source of truth.
# Edit grafana/build-dashboards.py and regenerate.
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-dashboards
  namespace: skp
  labels:
    app.kubernetes.io/part-of: skp
data:
"""


def write_configmap():
    """Inline every board in OUT into the ConfigMap the Grafana pod mounts.

    Reads the directory rather than the four generated boards, for the same reason
    normalize_imported() does: skp-runtime.json is authored elsewhere but is still one of
    the boards an operator opens, and a provisioning set that silently omitted it would
    leave exactly one board dying on every restart -- the one this script cannot rebuild.
    """
    parts = [CM_HEADER]
    for path in sorted(OUT.glob("*.json")):
        parts.append(f"  {path.name}: |" + chr(10))
        for line in path.read_text(encoding="utf-8").splitlines():
            parts.append((f"    {line}" if line.strip() else "") + chr(10))
    K8S_CM.write_text("".join(parts), encoding="utf-8")
    kb = K8S_CM.stat().st_size / 1024
    print(f"{K8S_CM.relative_to(K8S_CM.parent.parent)}  "
          f"{len(list(OUT.glob('*.json')))} boards, {kb:.0f} KB (ConfigMap ceiling 1024 KB)")
```

Then in `main()`, add the call **after** `normalize_imported()` — the nav stamp mutates
`skp-runtime.json` on disk, and the ConfigMap must carry the stamped version:

```python
    normalize_imported()
    write_configmap()
```

- [ ] **Step 2: Regenerate and confirm the YAML round-trips to the exact JSON**

A hand-built block scalar is the one place this task can silently corrupt a board, so check
it with kubectl's own YAML parser rather than by eye:

**Two shell traps here, both of which cost a cycle.** `/tmp` is not one place: Git Bash
maps it into `AppData/Local/Temp` while Windows Python reads `/tmp` as `C:	mp`, so a
bash redirect followed by a Python open of the same path fails with `FileNotFoundError`.
And `python - <<PY` hands the heredoc to stdin, so a script fed that way cannot also
read a pipe. Write the checker to a file and pipe into it.

```bash
cd /c/Users/UserL/source/repos/SK_P9
python grafana/build-dashboards.py
cat > "$SCRATCH/roundtrip.py" <<'PY'
import json, pathlib, sys
cm = json.load(sys.stdin)["data"]
disk = {p.name: p.read_text(encoding='utf-8') for p in pathlib.Path('grafana/dashboards').glob('*.json')}
assert set(cm) == set(disk), (sorted(cm), sorted(disk))
for name in sorted(disk):
    a, b = json.loads(cm[name]), json.loads(disk[name])
    assert a == b, f"{name} does not round-trip"
    print(f"  {name:26} round-trips, uid={a['uid']}")
print(f"{len(cm)} boards OK")
PY
kubectl create --dry-run=client -o json -f k8s/24-grafana-dashboards.yaml \n  | python "$SCRATCH/roundtrip.py"
```

Expected: five lines, each with its uid, then `5 boards OK`. Any assertion failure means
the block-scalar indentation is wrong — fix `write_configmap()`, do not hand-edit the YAML.

- [ ] **Step 3: Register the manifest with kustomize and correct the stale comments**

In `k8s/kustomization.yaml`, add the new file to `resources`, directly after `23-grafana.yaml`:

```yaml
  - 23-grafana.yaml
  - 24-grafana-dashboards.yaml
```

`k8s/23-grafana.yaml` describes a `configMapGenerator` that is not in `kustomization.yaml`
— it was removed when the boards were un-provisioned, and the comments were left behind.
Two edits.

First, in the CONFIGMAP SIZE CEILING comment, replace:

```
# `grafana-dashboards` ConfigMap (kustomization.yaml configMapGenerator) carries both
# dashboards; two 15-25 panel dashboards measure 40-120 KB, roughly 10x under. If the
```

with:

```
# `grafana-dashboards` ConfigMap (GENERATED into 24-grafana-dashboards.yaml by
# grafana/build-dashboards.py) carries all five boards at ~250 KB, roughly 4x under. If they
```

Second, on the volume, replace:

```yaml
            name: grafana-dashboards           # GENERATED by kustomization.yaml configMapGenerator
                                               # (disableNameSuffixHash: true keeps this name stable)
```

with:

```yaml
            name: grafana-dashboards           # GENERATED into 24-grafana-dashboards.yaml by
                                               # grafana/build-dashboards.py -- name is load-bearing
```

- [ ] **Step 4: Record the pre-apply state, so a regression is provable**

```bash
curl -s -u admin:admin "http://localhost:13000/api/search?query=&type=dash-db" \
  | python -c "
import json,sys
for d in sorted(json.load(sys.stdin), key=lambda x: x['uid']):
    print(f\"{d['uid']:18} folder={d.get('folderTitle','General'):10} title={d['title']}\")" \
  | tee /tmp/boards-before.txt
```

Expected: five rows, all `folder=General`. Keep this file — Step 6 compares against it.

- [ ] **Step 5: Apply the ConfigMap alone**

**Server-side, and the error you get otherwise names the wrong number.** A plain
`kubectl apply` fails with `metadata.annotations: Too long: may not be more than 262144
bytes` -- that is the 256 KiB ceiling on the last-applied-configuration annotation
client-side apply writes, not the 1 MiB ConfigMap ceiling. The data is comfortably under
the limit that governs it; shrinking the boards is not the fix.

```bash
kubectl apply --server-side --field-manager=skp-dashboards -f k8s/24-grafana-dashboards.yaml
kubectl get pod -n skp -l app=grafana -o jsonpath='{.items[0].metadata.name}{"  restarts="}{.items[0].status.containerStatuses[0].restartCount}{"  age="}{.items[0].status.startTime}{"\n"}'
```

Expected: `configmap/grafana-dashboards configured`, and the pod name, restart count and
start time **unchanged from before the apply**. If the pod restarted, the boards are gone
— stop, re-import all five from `grafana/dashboards/` through the API, and work out what
restarted it before trying again.

- [ ] **Step 6: Wait for the refresh and verify all five are provisioned**

The kubelet refresh (~60s) and the provider interval (30s) can stack, so allow ~2 minutes.

```bash
sleep 120
for uid in skp-flow skp-baseapi skp-orchestrator skp-processor skp-runtime; do
  curl -s -u admin:admin "http://localhost:13000/api/dashboards/uid/$uid" | python -c "
import json,sys
d=json.load(sys.stdin)
m,b=d.get('meta',{}),d.get('dashboard',{})
def n(ps):
    c=0
    for p in ps: c+=1+n(p.get('panels',[]))
    return c
print(f\"$uid  provisioned={m.get('provisioned')}  folder={m.get('folderTitle')}  panels={n(b.get('panels',[]))}\")"
done
```

Expected: five rows, every one `provisioned=True` and `folder=SKP`. The folder move is
expected and harmless — board URLs are keyed by uid, not by folder, so existing links and
`chaos-timeline.js` (which builds `/d/<uid>`) keep working.

Panel counts must match the generated boards: flow 20, baseapi 20, orchestrator 26,
processor 25, runtime 17.

- [ ] **Step 7: If any board did not become provisioned, clear the DB copy and let the provider create it**

Only run this for boards that Step 6 reported as `provisioned=False`. Grafana can decline
to take over a uid that already exists as a hand-created dashboard; the log says so:

```bash
kubectl logs -n skp -l app=grafana --tail=200 | grep -iE "provision|dashboard" | tail -30
```

Every board is in git, so deleting the DB copy is safe — the provider recreates it from the
ConfigMap within 30s:

```bash
curl -s -u admin:admin -X DELETE "http://localhost:13000/api/dashboards/uid/<uid>" \
  | python -c "import json,sys;print(json.load(sys.stdin).get('message'))"
sleep 45
curl -s -u admin:admin "http://localhost:13000/api/dashboards/uid/<uid>" \
  | python -c "import json,sys;print('provisioned=',json.load(sys.stdin)['meta']['provisioned'])"
```

Expected: `provisioned= True`. Do **not** restart Grafana to force this.

- [ ] **Step 8: Verify as a viewer, not as admin**

Un-provisioning once left `skp-runtime` with an empty ACL, and anonymous viewers got
`Failed to load dashboard — Forbidden` while admin saw it fine. Provisioning changes the
ACL again, so check it the same way — **without credentials**:

```bash
for uid in skp-flow skp-baseapi skp-orchestrator skp-processor skp-runtime; do
  printf "%-18s anon=%s\n" "$uid" \
    "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:13000/api/dashboards/uid/$uid)"
done
```

Expected: five `anon=200`. A `403` means the provisioned ACL did not inherit; grant it
explicitly, as the README records:

```bash
curl -s -u admin:admin -X POST "http://localhost:13000/api/dashboards/uid/<uid>/permissions" \
  -H 'Content-Type: application/json' \
  -d '{"items":[{"role":"Viewer","permission":1},{"role":"Editor","permission":2}]}'
```

- [ ] **Step 9: Prove the expressions still resolve on the provisioned boards**

```bash
python grafana/check-expressions.py http://localhost:19090
```

Expected: `0 invalid`, and the LIVENESS coupling check passes. This runs against the JSON
on disk, which is now the same JSON the cluster serves — that equality is the whole point
of the task.

- [ ] **Step 10: Commit**

```bash
git add grafana/build-dashboards.py k8s/24-grafana-dashboards.yaml k8s/kustomization.yaml k8s/23-grafana.yaml
git commit -m "feat(grafana): provision the boards from the repo again

The five boards lived only in a pod emptyDir, so every Grafana restart cost a
hand re-import and nothing could be deployed to another cluster. The provider
ConfigMap was already fully written -- SKP folder, disableDeletion,
allowUiUpdates false, 30s re-read -- and only grafana-dashboards was empty.

Provisioning was torn out so the boards could be edited in the UI, and that
trade expired when the workflow became edit-the-generator-never-the-JSON: the
editability being paid for is not used any more.

The generator emits the ConfigMap because kustomize refuses to read files above
its own directory without --load-restrictor LoadRestrictionsNone, which would
have to be remembered at every apply. This way the boards are generated all the
way to the cluster."
```

---

### Task 2: Give the chaos probe per-series presence

`chaos-probe.py` range-queries every panel expression across a fault window and reports
min/mean/max per segment. But `seg()` pools every sample from every series into one list,
so when one replica of two departs, the pooled values keep flowing — the survivor's — and
`len(series)` counts the union across the whole window. The probe therefore cannot say the
thing that mattered on 2026-08-24: **a line ended.**

That gap is why the departure was judged from `chaos-timeline.js` legends instead, which
render at `now-15m` and list every series with data anywhere in the range — so a run shorter
than the range can never show a name disappear, whatever the lines do. It reported a working
panel as broken. The fix belongs here, in the tool that already has the range data, not in
the sampler.

**Files:**
- Modify: `grafana/chaos-probe.py` — add `fingerprint()` and `present()`, use them in `main()`
- Create: `grafana/test-chaos-probe.py` — assertions for the presence logic

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `fingerprint(metric: dict) -> str`, `real(v) -> bool`, `present(series, lo, hi) -> set[str]` and `spans(series, lo, hi) -> dict[str, tuple[float, float]]`, plus five new keys on each JSON row: `series_before`, `series_during`, `series_after` (ints), `left`/`arrived` (lists of fingerprints) and `ended` (list of `{series, at}`).

**`spans()` was added during execution, and the reason is the whole point of the task.**
The plan originally judged a departure by set difference — a series present before the fault
and absent during it. Run against the recorded r5-partial data that reported **nothing**, and
correctly so: a departed replica keeps drawing for up to a rate window after its last export,
because that is what `rate()` does, so its series *is* present in the early part of any fault
window drawn at the true fault instant. The only way to make the set difference say
"departed" is to slide the window until it agrees — which is not measuring, and is the
failure this project keeps re-learning.

Where a line **ends** is a property of the series, not of the window it is judged in. `spans()`
asks that instead, and needs no window tuning. `present()` is kept — it is tested, and segment
membership is still the right question for "did this panel have data at all".

- [ ] **Step 1: Write the failing test**

Create `grafana/test-chaos-probe.py`:

```python
#!/usr/bin/env python3
"""Assertions for chaos-probe's per-series presence logic.

The distinction under test is the one the boards exist to draw and the one a Grafana
legend cannot express: a series that STOPS is a replica that left; a series sitting at
zero beside working peers is a replica that stopped working. Pooled values cannot tell
them apart, which is how a working panel was once reported as broken.

    python grafana/test-chaos-probe.py
"""

import importlib.util
import pathlib
import sys

_spec = importlib.util.spec_from_file_location(
    "chaos_probe", pathlib.Path(__file__).parent / "chaos-probe.py")
cp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cp)


def series(instance, points):
    return {"metric": {"__name__": "x", "service_instance_id": instance},
            "values": [[float(t), str(v)] for t, v in points]}


def test_fingerprint_ignores_metric_name():
    a = cp.fingerprint({"__name__": "one", "service_instance_id": "a", "queue": "q"})
    b = cp.fingerprint({"__name__": "other", "queue": "q", "service_instance_id": "a"})
    assert a == b, (a, b)
    assert a == "queue=q,service_instance_id=a", a


def test_a_series_that_stops_is_reported_as_left():
    gone = series("a", [(0, 1), (10, 1), (20, 1)])
    stays = series("b", [(0, 1), (10, 1), (20, 1), (30, 1), (40, 1)])
    before = cp.present([gone, stays], 0, 25)
    during = cp.present([gone, stays], 25, 50)
    assert before - during == {"service_instance_id=a"}, (before, during)


def test_a_series_flat_at_zero_is_not_reported_as_left():
    """The false-positive direction. An idle replica is present, not departed --
    telling these apart is the entire point, so zero must count as a sample."""
    idle = series("a", [(0, 1), (10, 1), (30, 0), (40, 0)])
    before = cp.present([idle], 0, 25)
    during = cp.present([idle], 25, 50)
    assert before - during == set(), (before, during)
    assert during == {"service_instance_id=a"}, during


def test_a_new_series_is_reported_as_arrived():
    replacement = series("c", [(30, 1), (40, 1)])
    before = cp.present([replacement], 0, 25)
    during = cp.present([replacement], 25, 50)
    assert during - before == {"service_instance_id=c"}, (before, during)


def test_nan_only_samples_are_not_presence():
    """NaN renders blank, not zero -- seg() already drops it and presence must agree,
    or a panel that went blank would read as a panel that kept working."""
    blank = series("a", [(30, "NaN"), (40, "NaN")])
    assert cp.present([blank], 25, 50) == set()


def test_samples_outside_the_window_do_not_count():
    s = series("a", [(0, 1), (60, 1)])
    assert cp.present([s], 25, 50) == set()


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"  ok    {t.__name__}")
        except AssertionError as e:                       # noqa: PERF203
            print(f"  FAIL  {t.__name__}: {e}")
            failed += 1
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)
```

- [ ] **Step 2: Run it and confirm it fails for the right reason**

```bash
cd /c/Users/UserL/source/repos/SK_P9
python grafana/test-chaos-probe.py
```

Expected: an `AttributeError: module 'chaos_probe' has no attribute 'fingerprint'` — the
functions do not exist yet. If instead it reports test failures, the module already has
something by these names; read it before continuing.

- [ ] **Step 3: Implement the two functions**

In `grafana/chaos-probe.py`, add directly below `seg()`:

```python
def fingerprint(metric):
    """A stable name for one series: its label set, minus the metric name.

    __name__ is dropped because a panel's expression may rename or aggregate away the
    metric while the identity that matters -- which replica, which queue -- lives in the
    remaining labels.
    """
    return ",".join(f"{k}={v}" for k, v in sorted(metric.items()) if k != "__name__")


def present(series, lo, hi):
    """Fingerprints of the series carrying at least one real sample in [lo, hi).

    Presence, not value. A replica idling at zero is PRESENT; a replica whose line stopped
    is not. seg() cannot make that distinction because it pools every series' samples into
    one list, so one departure among several peers leaves the pool still full. NaN does not
    count -- it renders blank rather than zero, and seg() already drops it.
    """
    out = set()
    for s in series:
        fp = fingerprint(s.get("metric", {}))
        for ts, v in s.get("values", []):
            if lo <= ts < hi:
                try:
                    f = float(v)
                except ValueError:
                    continue
                if f == f:                      # NaN != NaN
                    out.add(fp)
                    break
    return out
```

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
python grafana/test-chaos-probe.py
```

Expected: `6/6 passed` and exit 0.

- [ ] **Step 5: Report presence in the probe's output**

In `main()`, after the three `seg()` calls:

```python
                b = seg(series, start.timestamp(), fts)
                d = seg(series, fts, hts)
                a = seg(series, hts, end.timestamp())
```

add:

```python
                pb = present(series, start.timestamp(), fts)
                pd = present(series, fts, hts)
                pa = present(series, hts, end.timestamp())
                left, arrived = sorted(pb - pd), sorted(pd - pb)
```

Replace the `flag` line with one that reports departures and arrivals alongside movement:

```python
                flag = " <<" if moved else ("  ~" if (b and not d) else "   ")
                if left:
                    flag += f" -{len(left)}"
                if arrived:
                    flag += f" +{len(arrived)}"
```

After the existing `print(...)` for the row, name the series that moved in or out — the
count alone repeats the mistake of reporting that something changed without saying what:

```python
                for fp in left:
                    print(f"{'':56}series ENDED during fault: {fp[:70]}")
                for fp in arrived:
                    print(f"{'':56}series arrived during fault: {fp[:70]}")
```

Extend the `rows.append({...})` dict with the four new keys:

```python
                rows.append({"board": board["title"], "panel": panel["title"], "legend": legend,
                             "expr": raw, "series": len(series), "before": b, "during": d,
                             "after": a, "moved": moved,
                             "series_before": len(pb), "series_during": len(pd),
                             "series_after": len(pa), "left": left, "arrived": arrived})
```

Finally, extend the module docstring's opening paragraph so the tool says what it now
measures. Replace:

```
The companion to chaos-timeline.js, and the reason findings can be stated as facts rather
than impressions. The timeline says what a panel SHOWED; this says what the panel COULD
have shown.
```

with:

```
The companion to chaos-timeline.js, and the reason findings can be stated as facts rather
than impressions. The timeline says what a panel SHOWED; this says what the panel COULD
have shown -- both what its values did and which of its SERIES stopped.

That last part is not a refinement. chaos-timeline.js renders at now-15m and records legend
text, and a Grafana legend lists every series with data anywhere in the range -- so a run
shorter than the range cannot show a name disappear, whatever the lines do. Judged that way,
a panel that correctly ended a departed replica's line was reported as broken. Series
presence is only available here, from the range data, which is why it lives here.
```

- [ ] **Step 6: Re-judge the recorded partial-replica-loss run**

The r5-partial run is still in Prometheus and is the case the tool could not previously
read. The run started `2026-08-24T08:38:13Z`; the departed replica's last export was +185s
and its replacement's first was +255s.

```bash
python grafana/chaos-probe.py \
  --fault-at 2026-08-24T08:41:18Z --heal-at 2026-08-24T08:42:28Z --pad 170 \
  --out /tmp/r5-probe.json | grep -E "SKP Processor|ENDED|arrived|Replica fan-out|Consuming by queue"
```

Expected: on the SKP Processor board, both `Replica fan-out` and `Consuming by queue and
replica` report a series **ENDED during fault** naming a `service_instance_id` ending
`f29tb`, and a series **arrived** naming one ending `vhbrf`.

This is the reading that had to be taken by hand on 2026-08-24. If the tool now produces it
automatically, the blind spot is closed. If it does not, say so and stop — do not widen the
fault window to make it appear.

- [ ] **Step 7: Confirm the aggregate panel is measurably blinder than the split one**

The claim recorded in `grafana/README.md` is that `min by (queue)` was not merely unable to
name the replica but blind to the departure. The probe can now check that directly:

```bash
python - <<'PY'
import json
rows = json.load(open('/tmp/r5-probe.json', encoding='utf-8'))
for r in rows:
    if r["panel"].startswith("Consuming by queue"):
        print(f"{r['board']:20} {r['panel']:34} "
              f"series b/d/a={r['series_before']}/{r['series_during']}/{r['series_after']} "
              f"left={r['left']} arrived={len(r['arrived'])}")
PY
```

Expected: the SKP Orchestrator's aggregate `Consuming by queue` reports `left=[]` — no
series ended, because `min` over the shared queue is the survivor's value — while the SKP
Processor's `Consuming by queue and replica` reports exactly one departed
`service_instance_id`. That contrast is the evidence for the README's claim.

- [ ] **Step 8: Commit**

```bash
git add grafana/chaos-probe.py grafana/test-chaos-probe.py
git commit -m "feat(grafana): let the chaos probe see a series stop, not just values move

seg() pools every sample from every series into one list, so when one replica of
two departs the pooled values keep flowing -- the survivor's -- and len(series)
counts the union across the whole window. The probe could say a panel's values
moved and never that one of its lines ended.

That gap is why a departure was judged from chaos-timeline legends instead, and
a legend lists every series with data anywhere in the rendered range: a run
shorter than the range cannot show a name disappear whatever the lines do, so a
working panel was reported as broken. Presence is a set operation on range data
the probe already fetched.

Tested in both directions, because only one of them is the interesting one: a
series that stops is reported as departed, and a series flat at zero beside
working peers is NOT."
```

---

## Out of scope, and why

**Alertmanager.** The five rules still reach `firing` and stop there — `/api/v1/alertmanagers`
is empty. It was deliberately deferred by the person who asked for this plan. It remains the
largest gap between this stack and something you would trust unattended, and it is recorded
in `grafana/README.md`.

**Degradation coverage.** Every scenario in the suite injects binary absence — scaled to
zero, paused, wiped. Nothing is ever slow, and a slow dependency is the most common way
production fails. That needs latency injection the dev stack does not run, and it wants its
own plan; expect it to find boards reading green, the way the first sweep did.

**A genuinely wedged replica.** Still not producible. `SIGSTOP` wedges the wrong thing — a
frozen process stops exporting and reads as a departure. The untried approach is closing that
replica's AMQP connection through the RabbitMQ management API so the process keeps running
and reporting while its consumer stops taking deliveries. `Consuming by queue and replica`
is the panel it would exercise, and Task 2 is what would let the probe judge it.

**Re-deriving `LIVENESS` for another cluster.** `40s` was measured against a 10s export and
a 15s scrape. Anywhere else those differ and the window must be re-derived rather than
copied. `check-expressions.py`'s coupling check already has the enforcement mechanism; it
would need the cadence as an input rather than a constant.
