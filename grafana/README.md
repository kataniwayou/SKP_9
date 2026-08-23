# SKP Grafana dashboards

Five boards, as plain portable JSON. **Nothing here is provisioned.** These files are
imported by hand, which is what lets the same file land in this cluster's Grafana and in
one on another machine without editing anything.

```
grafana/
  build-dashboards.py      generator — edit this, not the JSON
  check-expressions.py     runs every panel expression against a live Prometheus
  audit-boards.js          opens every board in a browser and reports what rendered
  audit-nav.js             checks every board can reach every other board
  dashboards/
    skp-flow.json          cross-service conservation — open this one first
    skp-baseapi.json       API HTTP ingress
    skp-orchestrator.json  orchestrator control plane
    skp-processor.json     processor replicas
    skp-runtime.json       deep .NET runtime board, all three services
```

## Importing

**Dashboards → New → Import → Upload JSON file**, then pick the Prometheus datasource
when prompted. Repeat per file. Order does not matter.

Two properties make this work anywhere:

- Every panel resolves its datasource through the `${datasource}` template variable
  rather than a hardcoded uid, so the board binds to whatever Prometheus the importing
  Grafana has. This cluster pins `uid: skp-prometheus` for its own verification script;
  the dashboards never reference it.
- Each board carries an explicit stable `uid` and `"id": null`, so re-importing an
  updated file **updates the existing board** instead of creating a second copy. The
  uids are `skp-flow`, `skp-baseapi`, `skp-orchestrator`, `skp-processor`, `skp-runtime`.

Folder is chosen at import time. Anything works; the boards link to each other by the
`skp` tag, not by folder.

## Changing a board

Edit `build-dashboards.py` and regenerate. Do not hand-edit the JSON — the orchestrator
and processor boards share six pipeline panels, emitted from one function
(`pipeline_shared`) precisely so the two cannot drift. Hand-editing one JSON reintroduces
at the presentation layer the divergence the shared-instrument design exists to prevent.

```bash
python grafana/build-dashboards.py
python grafana/check-expressions.py http://localhost:19090
```

A UI "Save" is possible here — that is the cost of dropping provisioning, which enforced
read-only. A UI edit is lost on the next import, so treat this directory as the source of
truth by convention rather than by mechanism.

`skp-runtime.json` is the one exception: it was exported from the old provisioning
ConfigMap rather than generated. `build-dashboards.py` still stamps the shared nav onto it
(`normalize_imported`), because nav is a property of the *set* of boards rather than of how
any one was authored — see below for what happened when it was not.

**Nothing is provisioned any more.** The `grafana-dashboards` ConfigMap is empty and the
file provider points at an empty directory; both are now vestigial and could be removed
from whatever applies them.

## Reading the boards

Three tiers, in the order the questions actually get asked:

1. **Verdict** — stat row. Is it broken?
2. **Pipeline** — timeseries. What is broken?
3. **Runtime** — collapsed, four panels. Is the process why?

Tier 3 carries only the four runtime metrics with a causal link to a pipeline symptom
(thread-pool queue, GC pause, exceptions, restarts). The other thirteen answer
memory-and-perf questions and live on `skp-runtime.json`.

### Why fault panels end in `or vector(0)`

A counter that has never incremented exports no series, so a fault expression written
plainly renders **No data** — visually identical to a broken query, a bad variable, or a
dead scrape. On a healthy stack that is most of them: measured on this cluster, only one
of six `disposition`/`reason` pairs exists, `landed="false"` has never occurred, and
`pipeline_duplicate_suppressed_total` has zero series.

Every fault stat therefore ends `or vector(0)` and is thresholded green-at-zero, so
healthy reads as an explicit green `0`. The three breakdown-by-label panels that cannot
use that trick (the fallback would draw an unlabelled series) set `noValue` text instead.

### Two panels that mean less than they look like

**`pipeline_leader_ratio` is not a fault signal.** Two of three orchestrator replicas
read `0` by design, and `StepOutcomeHandler` is deliberately not leader-gated, so a
follower at zero is still expected to be consuming. The verdict stat is
`count(pipeline_leader_ratio == 1)`, which must be exactly 1 — zero means nobody holds
the lease, two means a split.

**The orchestrator's Role filter reaches four panels, not the board.** `role` is an
attribute on three instruments only — `pipeline.messages.produced`,
`pipeline.messages.consumed`, `pipeline.produce.duration`. The gauges and
`consumer.channel.resets` carry no `role`, and a `role=~"leader"` matcher does not match
a series that has no `role` label, so applying the variable board-wide would empty them.
The verdict tier is left unfiltered too: it answers *is anything wrong anywhere*, and a
role selection there would let a follower fault hide behind a leader view. There is a
note panel on the board saying so.

## Two defects found while building these boards

### The duration histograms could not answer quantiles (fixed)

`pipeline.produce.duration` and `pipeline.process.duration` record
`Stopwatch.GetElapsedTime(...).TotalSeconds` and declare `unit: "s"`, but originally
supplied no bucket boundaries — so both inherited the .NET SDK defaults
`[0, 5, 10, 25 … 10000]`, a ladder for **milliseconds**.

Measured before the fix: 4767 of 4772 produce observations and 2233 of 2233 process
observations sat in the single `(0, 5]` bucket, so `histogram_quantile` interpolated
across it and reported **~4.9 s for a send that really took 15 ms**. Nothing errored. The
number was the bucket edge wearing a latency's clothes.

Both meter providers now carry an explicit view, and the panels are back on p95/p99:

| | before | after |
|---|---|---|
| produce p95 | 4491 ms | **24.6 ms** |
| process p95 | 4750 ms | **23.9 ms** |
| mean (unchanged, bucket-independent) | 12–15 ms | 12–15 ms |

`EgressMeter.LatencySecondsBoundaries()` owns the ladder — a 1-2.5-5 progression from 1 ms
to 10 s — and both views share it, so a hop's send time and its transform time stay
readable on one axis. The view for `pipeline.produce.duration` lives in
`AddBaseConsoleObservability` so both roles inherit it; the one for
`pipeline.process.duration` lives in `ProcessorHost`, matching how the processor's meter
itself is registered and keeping the shared method role-agnostic.

`AddView` rather than `InstrumentAdvice` on the `CreateHistogram` call: advice needs
.NET 9 and these projects target net8.0.

**Both panels also plot the mean beside the quantiles**, and that is not decoration. The
mean comes from `sum/count` and is independent of bucket boundaries, so a wild divergence
between it and p50 means the ladder has stopped fitting the data. That divergence is
precisely what exposed this defect.

`LatencyHistogramBucketTests` guards it. A view whose instrument name matches nothing is
silently ignored, so the tests read boundaries off an exported metric rather than asserting
that `AddView` was called — and they were confirmed to fail against the pre-fix build.

**Redeploy note.** Changing boundaries changes the `le` label set. Old and new series with
a shared boundary (`le="5"`, `le="10"`) are the *same* Prometheus series, so a query window
spanning the rollout sees a counter reset and reports nonsense for a few minutes. Wait out
the window before reading quantiles after a deploy.

### `allValue: ".*"` broke the processor board

Grafana's convenient default for an All option is the regex `.*`, and on the processor
board -- the only one whose `service_name` is a selector rather than a constant -- that
matched **every service**, not every processor. The board rendered `next-step-handoff` and
`process-dispatch`, two types no processor ever produces, because All was quietly pulling
in the orchestrator.

Caught by looking at a rendered board, not by any query check: every expression was valid
and every one returned data. It was the wrong data.

The variable now sets no `allValue`, so Grafana expands All to the enumerated option list
`(sample-proc-v9|sample-proc|...)`. Any future variable that scopes a board to a subset of
services needs the same treatment.

## What only a rendered board showed

Every one of these passed `check-expressions.py` — valid PromQL, data returned. They were
found by opening the boards in a browser (`playwright-skill`, script in the scratchpad; it
walks each panel and reports No-data and error states, which is the part a query check
cannot see).

**A conservation gap must be counted, not rated.** The hop-gap stats originally plotted
`rate(produced) - rate(consumed)` with a fault threshold just above zero. Two counters
scraped independently never agree instant to instant: measured over an hour, that
difference had p50 `+0.000` but a max of `+0.074 req/s` and **exceeded the threshold in 13%
of samples** — the operator's primary board would have been red an eighth of the time with
nothing wrong. The same hour in counts: 1311 produced, 1313 acked. The panels now use
`increase(...[$__range])` in messages, with a green band wide enough for scrape-boundary
rounding. A real leak grows with the range; jitter does not.

**`or vector(0)` does not rescue NaN.** The BaseAPI p95 stat rendered blank whenever there
was no traffic, because `histogram_quantile` over an all-zero rate is 0/0. The fallback
substitutes for an *empty* result, and NaN is a result. Any stat that can go NaN needs
`noValue` text as well.

**An axis scaled by a transient hides the healthy line.** Retry amplification sits flat at
zero in health, but a rollout spike had left the axis running to 10000%, squashing the real
signal into the baseline. It now carries `axisSoftMax`, which floors the axis without
capping genuine excursions.

**Five filled series on one line are one opaque block.** "Consuming by queue" draws the
orchestrator's five queues, all at 1 in health. With area fill they merged into a solid
shape in which a dip — the entire point of the panel — was invisible. Unfilled now.

Two smaller ones: an instant-query table carried a Time column identical on every row while
its value columns were clipped, and a panel titled "Route match failures" plotted every
match status including success.

## A tag is not a link, and un-provisioning drops permissions

Two failures that only showed up by clicking through the boards.

**The runtime board was a one-way door.** It carried the `skp` tag, so it appeared in every
other board's nav — but it had no `links` of its own, so landing on it left the reader with
no way back, and only there. A tag makes a board a *destination*; a link makes it an
*origin*. Nothing had been checking the two agreed. `build-dashboards.py` now stamps the
nav onto any board in the directory it did not generate, and `audit-nav.js` fails if any
board cannot reach every other.

**Un-provisioning a dashboard can strip its permissions.** Removing `runtime.json` from the
ConfigMap so it could be edited like the other four left the board with an empty ACL rather
than an inherited one, and anonymous viewers got `Failed to load dashboard — Forbidden`
while an admin saw it fine. The generated boards each carry an explicit ACL granting Viewer
and Editor; the orphaned one carried none. Fixed on this instance with:

```bash
curl -u admin:admin -X POST http://localhost:3000/api/dashboards/uid/skp-runtime/permissions   -H 'Content-Type: application/json'   -d '{"items":[{"role":"Viewer","permission":1},{"role":"Editor","permission":2}]}'
```

This is an artefact of un-provisioning a board that already existed. A clean import onto a
fresh Grafana inherits folder permissions normally and will not hit it — but check as
whoever will actually read the board, not as admin, because admin sees it either way.

## Known gap: the API's queue side

`BaseApi.Core/Messaging/GatedQueueConsumer.cs` is a separate copy of the consumer with
its own observability wiring, and the API host does not register the
`Messaging.Transport` meter. The API's `start-orchestration` publish and its
`step-outcome` consumption emit **no metrics at all** — see §10 of
`docs/superpowers/specs/2026-08-22-pipeline-metrics-design.md`.

So absence on the Flow board is not evidence of zero traffic through the API's queues,
and any produced-vs-consumed comparison crossing into the API will not balance. This is
deliberate and stated on a text panel on `skp-baseapi.json` rather than left as an empty
graph.
