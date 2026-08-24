# Resume — SK_P9

Written 2026-08-24, late. Replaces whatever was here before; this is the current handoff.

## Where things stand

Branch `processor-sample-discovery`, clean tree, **unpushed, no git remote configured**.
~26 commits added this session on top of `e9ee966`.

The durable write-up is `grafana/README.md`. Read that for measurements and reasoning; this
file is only state, gaps and traps.

## What this session did

**Panels that can name one replica.** `Replica fan-out` gated on liveness; `Consuming by queue`
and `Channel resets by reason` split per replica on the processor board via one `by_instance`
parameter on `pipeline_shared()`, so the two worker boards still cannot drift.

**The boards are provisioned from the repo again.** `build-dashboards.py` emits
`k8s/24-grafana-dashboards.yaml`. **Proven by actually restarting Grafana** — all five boards
came back by themselves, `skp-runtime` included.

**Three new scenarios.** S9 (one replica's AMQP connection closed repeatedly), S10 (Redis 300 ms
slow), S11 (Redis 3 s slow, past the 2 s probe timeout).

**Two instruments that did not exist.** `pipeline.gate.probe.duration` (store latency) and
`pipeline.deadletter.depth` (work refused and not dealt with). Both verified against live faults.

**`System flowing` now checks an expected band** (0.9–2.0 req/s at a pinned `[4m]` window) instead
of "non-zero", plus reference lines on three latency panels.

**`chaos-probe.py` gained `spans()`** — where each series ENDS — because a Grafana legend cannot
express it.

## The three findings that matter

**1. These boards detect absence, not degradation.** Redis made 685× slower (0.44 ms → 301 ms,
verified with `redis-cli --latency`) moved *nothing*: gate 1, consuming 1, `process p95` flat at
24 ms. Past the probe timeout it read character-for-character like Redis being *gone*. Two states,
working and gone, nothing in between. Partly closed by the probe-latency instrument; still true
for the broker, for slow-under-load, and for end-to-end duration.

**2. A live correctness defect was invisible.** Six step outcomes were found dead-lettered in
`orchestrator-result.dead` — four incidents over two days, each a workflow run that lost progress
permanently. Every board green, all five alert rules inactive. Found only by querying the broker
by hand. Cause: `InvalidOperationException` at `StepOutcomeHandler`, workflow-or-step missing from
L1. **Root cause is NOT closed** — see below.

**3. All five alert rules are absence-shaped.** `TelemetryStale`, `PipelineNotConsuming`,
`L2GateShut`, `WorkersMissing`, `EgressFaults`. Nothing covers work discarded, retried, backing up
or slowing down.

## Open, in the order I would take them

- **Nothing consumes the alerts.** No Alertmanager; `/api/v1/alertmanagers` is empty. Deliberately
  deferred by the user. Still the largest gap.
- **No alert on `pipeline_deadletter_depth`.** The instrument ships; the rule (`depth > 0 for 5m`)
  does not. Adding it means editing `prometheus.yml` — see the TSDB trap below.
- **The six parked messages are unexplained.** Narrowed, not solved: every parked step id is still
  a valid step of the workflow, so they failed the *workflow-missing* branch, not the versioning
  one. Three candidates remain — consumption admitted independently of that workflow's activation;
  L1 losing it with no record; or hydration running while L2 did not hold it (`WorkflowActivator`
  logs "L2 does not hold workflow X; nothing to activate" and returns, leaving L1 empty while the
  consumer still starts — and the chaos suite wipes L2). **Untested.**
  `StepOutcomeHandler.DescribeL1Miss` now names which lookup missed, so the next occurrence
  diagnoses itself. Reproduction attempts by broker disruption and by restart both failed to
  reproduce; base rate is ~1 per 12 h, so those negatives are weak.
- **No backlog/lag and no end-to-end latency.** The hop gap is a conservation check: a message in a
  queue and a message lost are identical to it.
- **A true wedged replica still cannot be produced.** S9 makes a *flapping* consumer — the client
  recovers inside one export interval and the stack absorbs it completely.
- **A wipe still reads identically to a pause.**
- **The API's consumer emits no metrics at all** (`BaseApi.Core/Messaging/GatedQueueConsumer.cs`:
  0 `Record(` calls against the console copy's 6).
- **Calibration constants are deployment-specific** and nothing enforces them: `LIVENESS` 40s, the
  `System flowing` band, and the three reference lines all describe *this* workload. Re-derive
  before trusting a green band elsewhere.

## Traps, each of which cost time here

- **`kubectl apply` fails on the dashboards ConfigMap** with `metadata.annotations: Too long`. That
  is the 256 KiB last-applied-annotation ceiling, **not** the 1 MiB ConfigMap ceiling. Use
  `kubectl apply --server-side --field-manager=skp-dashboards -f k8s/24-grafana-dashboards.yaml`.
- **Dashboards are provisioned now**, so `/api/dashboards/db` returns `Cannot save provisioned
  dashboard`. Regenerate and apply the ConfigMap; hand import is the recovery path only.
- **Restarting Prometheus discards the entire TSDB.** It has no storage volume, and both config
  files are `subPath`-mounted so `apply` and `/-/reload` cannot see a change. Batch config edits.
- **`kind load` cannot install ghcr images** carrying attestation manifests (`ctr: content digest
  not found`). Use `docker pull --platform linux/amd64` → tag → save →
  `docker exec -i desktop-control-plane ctr -n k8s.io images import -`.
- **From Git Bash, prefix `kubectl exec ... -- /binary` with `MSYS_NO_PATHCONV=1`** or the leading
  slash becomes `C:/Program Files/Git/...`. Same for `kubectl cp` with a Windows path.
- **`powershell.exe` cannot load a .NET 8 assembly** (SourceHash reads). Use `pwsh`.
- **`/tmp` is not one place**: Git Bash maps it into AppData; Windows Python reads `C:\tmp`.
- **Elasticsearch `body.text` is not analysed** — `match`/`match_phrase` on it return 0 even for
  text that is there. Filter client-side. And **a 500-hit ascending query silently truncates**: it
  returned "no lifecycle events" for all four incidents until sorted descending.
- **OpenTelemetry unit `"1"` appends `_ratio`** to the Prometheus name. That is where
  `pipeline_gate_open_ratio` comes from. For a count use `"{message}"`.
- **`LogDebug` is below the level shipped to the log store.** A loop that only logs failures at
  Debug is indistinguishable from a loop that is working.
- **A shared-library change does not move `Processor.Sample`'s SourceHash** — no row repoint needed.
- The soak's drain check fails if the standing orchestration (`4cd8af45-1295-43db-ab2e-e955dd82b5c5`)
  fired in the last 40s. Stop it, wait 55s.
- **A background task reported as killed may still be running.** Verify the process tree first.
- **`--filter` is silently ignored** by this runner. Use `--filter-class` or `--filter-method`.
- Never scale Redis except via `RedisWipeScenarioTests`.
- **`orchestrator-result.dead` holds 7, but only 6 are real.** The 7th is synthetic, injected to
  validate the new diagnostic: correlation `deadbee5-0000-4000-8000-000000000001`.

## The lesson worth carrying

Every real finding this session came from **measuring the instrument, not trusting it**. A green
expression check, a passing chaos scenario, and a quiet log are each compatible with an instrument
that is not wired at all — and all three happened. The dead-letter gauge itself shipped a
confident green `0` while the broker held 7, because of a unit suffix.

---

## The prompt

```
Continue SK_P9. Read docs/superpowers/RESUME.md first — it has the state, the
open gaps, and the traps that have each cost time.

REPO:   C:\Users\UserL\source\repos\SK_P9
BRANCH: processor-sample-discovery (unpushed, clean, no remote configured)

The dashboards are provisioned from the repo and survive a Grafana restart
(tested). Store latency and dead-letter depth are instrumented and verified
against live faults. grafana/README.md is the write-up.

Pick one:

- Wire an Alertmanager, or at least add a dead-letter alert rule. Nothing
  consumes the five existing rules, and none of them covers work being
  discarded. Note a Prometheus config edit needs a restart that discards the
  TSDB.
- Chase the six parked step outcomes. Narrowed to the workflow-missing branch
  with three candidates; StepOutcomeHandler.DescribeL1Miss now names which
  lookup failed, so check orchestrator-result.dead and the log at that
  timestamp. Remember the 7th message there is synthetic.
- Add backlog/lag and end-to-end latency. The hop gap cannot tell a queued
  message from a lost one.

Two things to carry in:

- Validate instruments in BOTH directions, and against ground truth. A green
  expression check, a passing scenario and a quiet log are all compatible with
  an instrument that is not wired.
- Prometheus and RabbitMQ are ORG-OWNED in production. No scrape targets, no
  plugins, no broker-wide metrics. Anything new must be exported by the app
  through OTLP.
```
