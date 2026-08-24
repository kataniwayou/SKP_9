# Resume — SK_P9

Written 2026-08-24. Replaces whatever was here before; this is the current handoff.

## Where things stand

Branch `processor-sample-discovery`, **230 commits ahead of `main`, unpushed, clean tree.**
There is **no git remote configured**, so a PR is not available without adding one. `main`
is 0 commits behind, so a merge would fast-forward — but it would bring all 230 commits,
not just recent work. Integration was deliberately deferred.

Two plans completed, one written and not started.

**Done — chaos through the dashboards (2026-08-23).** Ran the seven resilience scenarios
watching the Grafana boards as an operator. Found the boards read green through outages they
should have caught, and fixed them: liveness-wrapped gauges, fault stats counted rather than
rated, symmetric hop-gap thresholds, and an `L2 gate` stat on the Flow board that separates a
store fault from a broker fault.

**Done — observability resolution and alerting (2026-08-24), 19 commits.** The boards could
not resolve a fault shorter than ~2 minutes because series only updated every 60s. Export
cadence 60s → 10s; datasource, liveness and staleness constants tracked down with it; the
Flow verdict tier split by tense; five Prometheus alert rules added; a partial-replica-loss
scenario added; the whole suite re-run.

**Result: 8/8 scenarios pass, all five alert pass conditions met.** Series resolution
60s → 15s. Detection of an absent replica **~110s → ~52-66s**.

The durable write-up is `grafana/README.md` — read that, not this file, for the measurements
and the reasoning.

## Next task, planned and not started

`docs/superpowers/plans/2026-08-24-per-replica-panels.md` — three tasks, both expression
changes already verified to parse against live Prometheus.

1. `Replica fan-out` rates a counter the collector stale-holds, so a departed replica's line
   *decays* toward zero over a rate window and looks exactly like a replica that is present
   and idle — the one distinction the panel exists to draw. Gate it on liveness so the line
   ends instead.
2. `Consuming by queue` aggregates `min by (queue)`, and both processor replicas share one
   queue, so it can say a consumer is wedged but never which one. Split per replica on the
   processor board only, via a `by_instance` parameter on `pipeline_shared()` — the way
   `role_f` already works, because those two boards must not drift.
3. Run the scenario and judge the panels. **Do not widen the liveness window to force a
   pass** — a window wide enough to fix a rendering complaint is too wide to detect an
   absence, and that trade has been got wrong twice here.

## Open gaps, all recorded in `grafana/README.md`

- **Nothing consumes the alerts.** No Alertmanager; `/api/v1/alertmanagers` is empty. Rules
  change state inside Prometheus and stop. This is the biggest gap between the current state
  and something you would trust unattended.
- A **wipe is indistinguishable from a pause** — "wait" versus "your data is gone". Needs an
  L2 epoch gauge, which is production code and wants its own plan.
- `Ack lost` is unexercised; `landed="false"` has never occurred on this stack.
- A **slow** rather than absent dependency is untested — the most common production failure,
  and it needs latency injection the dev stack does not run.
- **A wedged replica cannot be produced by `SIGSTOP`.** The mechanism works —
  `kubectl debug --image=busybox:1.36 --target=processor-sample` shares the PID namespace,
  PID 1 is `dotnet`, `kill -0 1` succeeds — but a frozen process stops exporting metrics, so
  Prometheus cannot distinguish it from a departure. A real wedge needs the process still
  reporting while its consumer stops taking deliveries.

## The lesson worth carrying

Two alert rules shipped that were **arithmetically incapable of firing** and had never fired
once. They were validated only as `state=inactive` on a healthy stack — which tests that a
rule does not cry wolf and says nothing about whether it can fire at all. It was caught only
by querying `ALERTS` history as a range.

**Validate every alert in both directions.** A silent rule on a healthy stack is half a test,
and it is the half that hides dead alerts.

## Traps, each of which has cost a run here

- The soak's drain check fails if the standing orchestration fired in the **last 40s**. Stop
  workflow `4cd8af45-1295-43db-ab2e-e955dd82b5c5` and wait 55s before any scenario.
- **A background task reported as killed may still be running.** Two orphaned runners racing
  the same scenario invalidated three runs. Verify the process tree with PowerShell before
  starting anything that touches the cluster.
- **`--filter` is not a flag this runner has.** It prints its whole help text and runs
  nothing, which reads exactly like a hang. Use `--filter-class`.
- **Restarting Grafana destroys every hand-imported board**, including `skp-runtime`, which
  the generator cannot rebuild. Storage is an `emptyDir` and the provisioning ConfigMap is
  empty. Re-import from `grafana/dashboards/` after any restart.
- **Never scale Redis** except via `RedisWipeScenarioTests`; it runs with persistence off, so
  scaling it to zero destroys L2 and turns any scenario into the wipe scenario.
- Dashboards are **generated** — edit `grafana/build-dashboards.py`, never the JSON. The two
  worker boards share six panels emitted from one function so they cannot drift, and
  `check-expressions.py` now also fails the build if a liveness window disagrees with
  `LIVENESS`.
- Playwright lives at `grafana/node_modules` (`export NODE_PATH="$PWD/grafana/node_modules"`).
- One processor pod carries a leftover ephemeral `wedgeprobe` container from an
  investigation. Ephemeral containers cannot be removed from a running pod; it disappears
  when that pod is next replaced.

---

## The prompt

Paste this into the fresh session.

```
Continue SK_P9. Read docs/superpowers/RESUME.md first — it has the state, the
open gaps, and the traps that have each cost a run.

REPO:   C:\Users\UserL\source\repos\SK_P9
BRANCH: processor-sample-discovery (unpushed, clean, no remote configured)

The observability resolution + alerting work is DONE: 8/8 chaos scenarios pass,
all five alert pass conditions met, detection latency ~110s -> ~52-66s. The
write-up is grafana/README.md.

NEXT: execute docs/superpowers/plans/2026-08-24-per-replica-panels.md — three
tasks fixing the two panels that claim to show one replica of many failing and
cannot. Both expression changes are already verified to parse against live
Prometheus. Use subagent-driven development.

Two things to carry in:

- Validate anything alert-shaped in BOTH directions. Two rules shipped here
  that were arithmetically incapable of firing, validated only as
  state=inactive on a healthy stack. Read ALERTS history as a range query.
- Do not widen the liveness window to make a panel look right. A window wide
  enough to fix a rendering complaint is too wide to detect an absence.

The single biggest gap left is that nothing consumes the alerts — there is no
Alertmanager, so a firing alert is as passive as a dashboard. That is worth
doing before more panel work if you would rather.
```
