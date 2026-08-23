# Brief — watch the chaos suite through the operator dashboards

Written 2026-08-23 at `20c6e7f`, for a session starting with cleared context.

Session scaffolding, not project documentation. Delete it once the work lands.

---

## The job

Run the seven resilience scenarios and **watch them through the Grafana boards as an
operator would**, not through test output. The question is not whether the scenarios pass —
they have their own verdicts. It is whether the boards make each fault **legible**: does an
operator staring at these panels see that something broke, see *what* broke, and see it
without being told where to look?

Produce, at the end, a list of findings and concrete dashboard improvements.

Anything a panel cannot show, or shows too late, or shows so ambiguously that a reader
would reach for kubectl instead, is a finding. So is a panel that stays green through an
outage it should have caught.

## The scenarios

`src/tests/BaseApi.Tests/Live/Resilience/`

| Test | Fault | Injected by |
| --- | --- | --- |
| `EveryRunCompletesWhenNothingIsTakenAway` | none — baseline | — |
| `NoStepIsLostWhileRedisIsUnavailable` | Redis unreachable | `CLIENT PAUSE` |
| `NoStepIsLostWhileTheBrokerIsDown` | RabbitMQ gone | scale to 0 |
| `NoStepIsLostWhileBothDependenciesAreUnavailable` | Redis + RabbitMQ | both |
| `NoStepIsLostWhileTheOrchestratorIsGone` | orchestrator gone | scale to 0 |
| `NoStepIsLostWhileTheProcessorIsGone` | processor gone | scale to 0 |
| `TheWipeIsBoundedVisibleAndFullyRecoveredFrom` | L2 contents wiped | — |

`CLIENT PAUSE` rather than a NetworkPolicy because kindnetd enforces no NetworkPolicy on
this cluster — one is silently ignored, the other actually blocks. **Never scale Redis**:
that wipes L2 as a side effect and turns every scenario into the wipe scenario.

## Running it

Double-gated so it cannot run by accident:

```bash
./k8s/port-forward-realstack.ps1          # supervised forwards; -Stop to tear down
SKP_REALSTACK=1 SKP_CHAOS=1 dotnet run --project src/tests/BaseApi.Tests -c Debug -- \
  --filter-class "BaseApi.Tests.Live.Resilience.<ScenarioClass>"
```

The scenarios are **serialised on purpose** (`9d899fd`) — two chaos runs at once fight over
the same cluster. Run them one class at a time so each fault window is attributable.

`--filter` is not a flag this runner has; it prints its whole help text and runs nothing,
which reads exactly like a hang. Use `--filter-class` / `--filter-method`.

### Port collisions to clear first

`port-forward-realstack.ps1` claims **5673, 18080, 14317, 18889, 6380, 19200, 19090**. A
previous session may hold ad-hoc forwards on 18080/19090/19200 — kill those first or the
script's forwards silently lose. A dead `kubectl port-forward` keeps the socket bound, so
the port looks free in `netstat` while refusing connections.

**Grafana is not in that script.** Add it: `kubectl -n skp port-forward svc/grafana 13000:3000`

## Watching

Five boards, all imported already, anonymous access works (no login):

| | |
| --- | --- |
| `http://localhost:13000/d/skp-flow` | cross-service conservation — **open this first** |
| `http://localhost:13000/d/skp-orchestrator` | 3 replicas, 5 queues |
| `http://localhost:13000/d/skp-processor` | n replicas, 1 queue |
| `http://localhost:13000/d/skp-baseapi` | HTTP ingress only |
| `http://localhost:13000/d/skp-runtime` | deep .NET runtime |

Capture with `playwright-skill`. Two scripts already exist and should be reused:

- `grafana/audit-boards.js` — opens each board, reports every panel's rendered state
- `grafana/audit-nav.js` — proves every board can reach every other

For this job you want a **third**: capture each board at intervals across a fault window, so
the before / during / after of one outage is comparable. Panels take **15–25 s** to paint
after load; a screenshot at 10 s catches an empty grid and reads as a bug that is not there.

Set the board time range to bracket the fault window tightly. An hour-wide range flattens a
90-second outage into a spike you have to hunt for.

## What will mislead you

**A counter reset looks like a fault.** Scaling a service to zero and back restarts its
counters. Any `rate()`/`increase()` window spanning the restart reports garbage for a few
minutes. Seen already: a produce-duration p95 reading 4.9 s and a hop gap of 15 messages,
both pure artefact. Wait the window out before believing a number, and cross-check a
quantile against the mean on the same panel — the mean is bucket-independent and was what
exposed the histogram defect.

**`or vector(0)` does not rescue NaN.** It substitutes for an *empty* result. A quantile
over zero traffic is 0/0 = NaN, which renders blank. Stats that can go NaN carry `noValue`
text instead — if a blank panel appears during an outage, check which of the two it is.

**The nav bar loads late.** It is built from a tag search issued after first paint. A fixed
wait under-counts it; `audit-nav.js` reported all five boards stranded twice, wrongly,
before the wait was fixed.

**`pipeline_leader_ratio` = 0 is normal on two of three replicas.** `StepOutcomeHandler` is
deliberately not leader-gated. The condition worth alarming on is
`count(pipeline_leader_ratio == 1) != 1`.

**An unregistered processor waits rather than crashing.** Running/NotReady with 0 restarts
is by design; `pipeline_identity_ready_ratio` is the panel that says so.

**The API's queue side emits nothing** (§10 of the pipeline-metrics design). Absence on the
Flow board is not evidence of zero traffic through the API's queues, and the return-hop gap
will not balance because the API consumes `step-outcome` invisibly.

## State to know

- Branch `processor-sample-discovery`, head `20c6e7f`, **unpushed**, 6 commits from today.
- Hermetic gate: `dotnet run --no-build` from `src/tests/BaseApi.Tests` — **588 total, 570
  passed, 18 skipped, 0 failed**. Read the shape, not the total; the skips are `Live/`.
- A workflow orchestration (`4cd8af45-1295-43db-ab2e-e955dd82b5c5`, cron `*/30 * * * * *`)
  was started earlier and left running deliberately. **The chaos suite will tear it down**
  — it scales the orchestrator, processor and broker to zero. Restart it afterwards with
  `POST /api/v1.0/orchestration/start` and the workflow id as a bare JSON string.
- Rebuilding the processor image changes its `SourceHash`, and the pod then sits
  Running/NotReady until the processor row is repointed via
  `PUT /api/v1.0/processors/{id}`. The hash is in the pod logs.
- Nothing is provisioned in Grafana any more; the `grafana-dashboards` ConfigMap is empty
  and the file provider points at an empty directory. Boards are imported by hand from
  `grafana/dashboards/`. See `grafana/README.md`.

## Deliverable

Findings and dashboard improvements. For each: which scenario exposed it, what the operator
saw, what they should have seen, and the panel change that closes the gap. Ship the changes
through `grafana/build-dashboards.py` — never by hand-editing the JSON, since the two worker
boards share six panels emitted from one function precisely so they cannot drift.

---

## The prompt

Paste this into the fresh session.

```
Run the chaos suite on SK_P9 and judge the dashboards, not the scenarios.

REPO:   C:\Users\UserL\source\repos\SK_P9
BRANCH: processor-sample-discovery (head 215e8a4, unpushed)

READ FIRST: docs/superpowers/BRIEF-chaos-dashboard-observation.md
It has the scenario table, the run commands and their double gate, the port
collisions, and six measured things that will mislead you during an outage.
The counter-reset one will bite in most scenarios — read it before believing
any number taken across a scale-to-zero.

THE JOB
Run the seven resilience scenarios in src/tests/BaseApi.Tests/Live/Resilience/,
one class at a time, and watch each one through the Grafana boards the way an
operator would. Judge the BOARDS, not the scenarios — the scenarios carry their
own verdicts.

For each fault, answer: does an operator see that something broke, see WHAT
broke, and see it without reaching for kubectl? A panel that stays green through
an outage it should have caught is a finding. So is one that shows the fault too
late, or too ambiguously to act on, or that cries wolf when nothing is wrong.

BUILD THE MISSING TOOL FIRST
grafana/audit-boards.js and grafana/audit-nav.js each capture a single moment.
This job needs a third script that samples every board at intervals across a
fault window, so before / during / after are comparable for one outage. Panels
take 15-25s to paint after load; sample accordingly.

DELIVER
Findings plus concrete dashboard improvements. For each: which scenario exposed
it, what the operator saw, what they should have seen, and the panel change that
closes the gap. Ship changes through grafana/build-dashboards.py — never by
hand-editing the JSON, since the two worker boards share six panels emitted from
one function precisely so they cannot drift.

ACCEPTED TRADE
The suite scales the orchestrator, processor and broker to zero, so it destroys
the orchestration deliberately left running (workflow 4cd8af45-1295-43db-ab2e-
e955dd82b5c5). That was flagged and accepted. Restart it when the run is done.
```
