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
  chaos-timeline.js        samples every board at intervals across a fault window
  chaos-probe.py           the same window from Prometheus, segmented before/during/after
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

## Watching a fault, not a moment

`audit-boards.js` and `audit-nav.js` each capture a single instant, which answers *does
this panel render*. It cannot answer the question an outage asks: does this panel
**change** when the thing it watches breaks, and how long does it take.

```bash
node grafana/chaos-timeline.js --label s3-broker --duration 680 --interval 15
python grafana/chaos-probe.py --fault-at <ISO> --heal-at <ISO>
```

`chaos-timeline.js` opens all five boards once, keeps them open, and samples each in
rotation. Loading fresh per sample would cost ~100s a sweep against a 60s fault window --
the whole outage would fall between two samples. Loading once and letting `&refresh=`
repaint in place costs ~2s a board. Background tabs get their timers throttled by
Chromium, which stalls Grafana's own refresh loop, so each page is brought to the front
before it is read.

`chaos-probe.py` is the companion that makes a finding a fact rather than an impression.
It range-queries every panel expression across the same window and segments it
before / during / after. A panel that stayed green while its own expression moved is a
threshold or rendering defect; a panel that stayed green while its expression stayed flat
is a missing signal. Different findings, different fixes.

## What the boards could not see, and what changed

Seven resilience scenarios run one class at a time, each watched through all five boards.
Every number below is measured, not inferred.

### The resolution floor, which everything else sits on

**This section described a cadence the stack no longer has, and is rewritten rather than
appended to.** The services now export OTLP every **10s** and Prometheus scrapes every
**15s**, so the effective resolution is **15s** and Grafana floors `$__rate_interval` at
**60s** -- every stat is a range query at a **15s step** reduced to `lastNotNull`.

Before this change the datasource declared `timeInterval: 60s` because that was the OTLP
export cadence, which floored `$__rate_interval` at **240s** and put every stat on a
**60s step**. Two consequences followed, kept here as the before-case because they are the
evidence the change was worth making:

- **No rate panel could resolve a 60-second fault.** With the entire pipeline stopped,
  `System flowing` still read 1.12 req/s a hundred seconds later; through a sixty-second
  broker outage it moved 1.12 -> 0.92 and never left green. At `$__rate_interval` = 60s a
  sixty-second fault is no longer diluted across a four-minute average -- it now falls
  inside a single rate window instead of a quarter of one.
- **The stat tier lagged the data by up to a minute on top of that.** In the Redis
  scenario the gate metric fell at data-time t+175s and the stat rendered it at t+235s.
  `kubectl` showed Redis NotReady 33 seconds before the boards did. At the new cadence
  that render lag is bounded by one scrape (15s) rather than one old-cadence step (60s).

Both are stated on the `System flowing` description now, because a reader who does not
know the rate window will read that panel as a liveness check and be wrong.

Six panel descriptions were left quoting the old 60s cadence and the 240s rate window it
forced, and an earlier revision of this paragraph said they "should be regenerated the
next time `build-dashboards.py` runs". **That was wrong, and it is worth knowing why: the
stale text was IN the generator**, in the `desc=` strings, so regenerating reproduced it
exactly. Nothing self-heals here -- `dashboards/*.json` is a build artefact and every word
in it comes from `build-dashboards.py`. They have since been fixed at the source and the
boards regenerated: claims about the system now read 60s/15s/10s, and the measurements
taken at the old cadence are kept, because they are the evidence behind the panel shapes,
labelled as before-figures.

### A stale-held gauge counts the dead

The collector republishes a series after the process feeding it is gone, and Prometheus's
five-minute lookback holds it after that. Every gauge stat was therefore reading the
posture of processes that no longer existed.

With **all three orchestrator replicas deleted for 58 seconds**, confirmed against
`kubectl`: `Consuming` 1, `L2 gate` 1, `Hydration admitted` 1, `Workers reporting` 5 --
green throughout. The only number that moved anywhere was `Leaders elected`, and only
because a leader releases its lease on graceful shutdown; an outright kill leaves it at 1.

With **both processors deleted for 58 seconds** the processor board did not change a
single stat, and `Workers reporting` went **5 -> 7** -- the dead replicas counted
alongside their replacements. `Identity ready by replica` drew four lines for two pods.

Every gauge expression is wrapped in `last_over_time(...[LIVENESS])` (`present_over_time`
where it is reporters being counted), which yields only series with a real sample in the
window. **`LIVENESS` is `40s`**, and it is one constant in `build-dashboards.py` rather
than a literal, because the alert rules have to agree with it -- see below.
`Workers reporting` counts live reporters. A `Workers missing (5m)` stat reports the
deepest dip in a fixed five-minute window, so it names how many replicas left without
being told how many there should be. A `Data freshness` stat carries the number every
other panel is downstream of.

**Two things about that window and that stat were got wrong first, and both were caught
by replaying the recorded outages rather than by reasoning.**

The window started at 2m, which sounded safely above the then-60s cadence and was useless:
a replica that vanishes for a minute has to fall out of the window *before its replacement
starts reporting*, and at 2m it never does. Replayed against three recorded ~58s
disappearances, 2m dipped on none of them; **100s** dipped on all three and stayed flat
through the undisturbed baseline. Measured worst-case staleness on a healthy stack was
then 57s, so 100s kept ~40s of headroom. **Those are before-figures.** At the 10s export
cadence against a 15s scrape the effective sample spacing is 15s, and the window tracked
down with it to the current **40s** -- wide enough to survive one late sample, tight enough
that a replica which vanishes for a minute falls out before its replacement reports.

`Workers missing` was peak-minus-current, which put a fault stat on the wrong side of its
own signal. The dip is only ~30s wide and a stat panel is a range query at the datasource
step, so the subtraction missed it about half the time -- and did, on the confirming re-run
at the old **60s step**, where the board showed `Workers missing 0` through an outage the
same expression had caught an hour earlier. It is now peak-minus-trough over `[5m:15s]`
subqueries, which pin the evaluation at 15s regardless of the panel step. At the 60s panel
step then in use that read 0 across the whole undisturbed baseline and 3 across every
disappearance -- the measurement showing the subqueries had decoupled the stat from the
step. Note the window: it is a **fixed five minutes, not `$__range`**, so the number does
not change when the reader zooms and back-to-back scenarios stop reporting the earlier,
deeper one. Row 2 of the Flow board is therefore titled by tense rather than by window, and
the board description names this stat as the one exception to "range-scoped".

**It still cannot be prompt, but it is twice as prompt.** A replica is missing once it has
skipped its liveness window, so detection costs roughly the liveness window plus one
export. At the 60s cadence that was **100-130s**, which for a sixty-second disappearance
is after the event has ended. Measured at the current cadence across three replica-loss
scenarios it is **~52-66s** (table below). What has not changed is the floor: a fault
shorter than the sampling period is not observable, and no query fixes that. A pod-liveness
scrape would. The panel says so in its own description.

**The same arithmetic is what sizes the alert rules, and it bit them.** The observable dip
is not the outage:

    observable dip = outage - LIVENESS + one export = 58s - 40s + ~10s ~= 28s

so a 58-second replica loss is true for only **two rule evaluations** at the 15s group
interval -- 15s of continuous truth. `WorkersMissing` shipped at `for: 2m` and had never
fired; `for: 30s` was tried and also reached `pending` only; `for: 15s` fires. The liveness
window that stops the boards counting the dead is the same window that eats most of the
outage before the alert can see it.

`Data freshness` is the one that degrades rather than dips, and on the confirming re-run
it was the panel that caught the orchestrator disappearance: 42-45s through health,
**2 mins** while the replicas were away.

### A fault counter must be counted, not rated

The same lesson the hop gaps already learned, unlearned three panels over. Scaling the
broker to zero produced **two transient publishes and one parked delivery**. `Not acked`,
`Ack lost`, `Egress faults` and `Retry amplification` are rates, so all four read 0.00
for all three events -- 1/240 is a rounding error. The only trace anywhere was a new
legend entry on a timeseries.

`increase()` alone does not fix it either. These counters have **no series at all** in
health -- the .NET counter is created on first increment -- so the first burst of a fault
type arrives as a series whose first sample is already non-zero, and `increase()` measures
growth *within* the window and reports 0 for exactly the case the verdict tier exists to
catch. The `counted()` helper takes the larger of in-window growth and absolute total,
which read 2 and 1 where `increase()` read 0.

These stats are warn-at-one rather than red: once a fault series exists it is exported for
the life of the process, so the number persists until the replica restarts. A fault that
happened twenty minutes ago should not vanish from the verdict tier, but it should not
read as an outage in progress either.

### The Flow board could not tell Redis from RabbitMQ

Both render as `Consuming 0` with every other stat green. The discriminator -- the L2 gate
closes for Redis and stays open for the broker -- existed only on the worker boards, so
the board an operator is told to open first could say *something broke* but not *what*.
`L2 gate` is now on the Flow verdict tier.

The `Posture` timeseries had the same hole from the other side: it drew gate, leader,
hydration and identity, and omitted **consuming** -- the one posture signal that actually
moved, in the Redis, broker and both-down scenarios alike. So the board's only history of
the fault was a stat sparkline three centimetres wide. Consuming is on the panel now.

### What the second run through the suite showed

The whole suite was run again against the rebuilt boards. Six of the fixes fired on the
faults that had been invisible to them:

| fault | Consuming | L2 gate | Egress faults | Channel resets | Workers reporting | Workers missing | Data freshness |
|---|---|---|---|---|---|---|---|
| baseline | 1 | 1 | 0 | 0 | 5 | 0 | 41s |
| Redis paused | **0** | **0** | 0 | 0 | 5 | 0 | 40s |
| broker gone | **0** | 1 | **2** | **10** | 5 | 0 | 40s |
| both gone | **0** | **0** | **4** | **29** | 5 | 0 | 39s |
| orchestrator gone | 1 | 1 | 0 | 0 | **5→2** | **3** | **2 mins** |
| processors gone | 1 | 1 | 0 | 0 | **5→3** | 2 | **2 mins** |
| L2 wiped | **0** | **0** | 0 | 0 | 5 | 2 | 54s |

The first three rows are the discrimination that was missing: a store fault, a broker
fault and both at once are now three different readings on the board an operator opens
first, where before they were one. `Egress faults` counted the two transient publishes
that read `0.00 req/s` as a rate. On the worker boards `Not acked` reached 1 on the Redis
and wipe scenarios, where the rate form had been flat zero.

Rows five and six are the ones the old boards could not see at all. Against `kubectl`
confirming all three orchestrator replicas absent for 58s, the previous build held every
stat green; this one drops `Workers reporting` to 2, names `Workers missing` as 3, and
takes `Data freshness` from 43s to 2 minutes. For the processor pair the old build's
worker count went **up**, to 7. Detection landed ~110s after the pods went, which was the
predicted 100-130s at the 60s export cadence -- still after a sixty-second outage had
already ended.

**A third run, at the 10s export / 15s scrape cadence, measured this again rather than
assuming the cadence change fixed it.** All eight scenarios (the six above, the L2 wipe,
and a new partial-replica-loss case) were re-run with `chaos-timeline.js` sampling every
board every 15s, and the true fault instant taken from `kubectl` pod-transition
timestamps rather than the predicted t0+150s:

| scenario | replicas removed | true fault instant (`kubectl`) | first sample a verdict stat moved | measured latency |
|---|---|---|---|---|
| orchestrator gone (S5) | 3 of 3 | pods absent ~21:56:29 | `Workers reporting` 5->2, `Workers missing` 0->3 at 21:57:20.85 | **~52s** |
| processor gone (S6) | 2 of 2 | pods absent ~22:06:38.6 | `Workers reporting` 5->3, `Workers missing` 0->2 at 22:07:44.87 | **~66s** |
| one processor replica gone (S8, new) | 1 of 2 | pod absent ~22:28:28.3 | `Workers reporting` 5->4, `Workers missing` 0->1 at 22:29:20.95 | **~53s** |

Detection of an absent replica now lands in **~52-66s**, down from the **~110s** measured
at the 60s cadence -- roughly halved. That is close to but a little above the naive
one-liveness-window-plus-one-export arithmetic (40s + 10s = 50s): the sampler itself polls
every 15s, so a discrete reading can add up to one more poll of slack on top of what a
continuously-refreshing viewer would see, and the exact phase between the fault instant and
the collector's own export tick moves the number around scenario to scenario. `Consuming`
and `L2 gate` are not liveness-windowed and are unaffected by any of this -- they moved
within one sample of t0+150s in every dependency-down scenario (Redis, broker, both, wipe),
which is the ~15-30s the rate-independent gauges were already capable of.

Confirmed still in effect at measurement time: `count_over_time(pipeline_gate_open_ratio[2m])`
read 7-8 depending on query-to-scrape alignment (5 series, 15s scrape, 2m window), and the
Prometheus datasource's `timeInterval` was `15s`.

`Workers missing (5m)` reports the worst dip in a **fixed five-minute window**, not in the
visible range. It read the visible range once, and that is exactly the reading that had to
be fixed: back-to-back scenarios inside one range width reported the earlier, deeper event
-- 3 rather than 2 during the processor scenario -- and the number moved when the reader
zoomed. Five minutes is stated in the title for that reason. It is still a window and not
an instant, so a scenario that follows another within five minutes can still show the
earlier one; worth knowing before reading it as the count for the fault in front of you.

**Two calibrations were wrong and the re-run is what showed it**, both of them introduced
by the changes above:

- The gap band was too tight. With no restart anywhere in range -- the undisturbed
  baseline included -- start and stop transients reach **12-13 every time**, so the primary
  board went orange on a healthy soak. Green is +/-25 now; a restart in range puts 20-46
  there, which is what orange is for.
- `Retry amplification` was red at any non-zero. Counting makes it sticky for a range
  width, so **one** parked delivery during the broker scenario kept it red at 0.2% through
  the two scenarios that followed. Green below 1%, red at 5%.

### The hop-gap thresholds disagreed with each other

`T_GAP` had steps on the positive side only, and the two hop gaps are one quantity
measured in opposite directions. Measured across the suite: **+46/-47, +48/-46,
+43/-44** -- one panel orange, its twin green, for the same instant, every time. All six
were artefacts of a scale-to-zero: a replica that leaves and returns gets a new series,
and the produced and consumed counters for the same messages live on different services
that restart at different moments. The steps are symmetric now, and both descriptions say
what a restart inside the range does to them.

### Three gaps that are still open

- **The wipe is indistinguishable from the pause.** Scaling Redis to zero destroys L2;
  pausing it does not. Both render identically on every board -- gate 0, consuming 0. The
  instrument that could separate them is `pipeline.duplicate.suppressed`, whose whole
  description is "the entry was already absent", and it has **no series at all**, before
  or after a deliberate wipe. That is an instrumentation gap, not a panel one.
- **`landed="false"` still has no series**, so `Ack lost` remains unexercised by anything
  the suite can inject.
- **Nothing consumes the alerts.** The five rules in `k8s/02-configmaps.yaml` are real --
  they evaluate, they reach `firing`, and `ALERTS` records it -- but `prometheus.yml` has
  no `alerting:` stanza and `/api/v1/alertmanagers` returns empty. **A firing alert is
  currently as passive as a dashboard**: it changes state inside Prometheus and stops
  there. Nobody is paged, nothing is delivered, and the only way to see one is to query
  `ALERTS` or open Prometheus. Deliberately not closed here -- standing up an Alertmanager
  is its own piece of work -- but stated so this section does not read as though alerting
  is finished. It is instrumented, not wired.

**Partial replica loss -- what the new scenario found, and what the fix changed.**

> Scaling the processor deployment from 2 to 1 is the first scenario that removes *part* of a
> dependency rather than all of it. The pipeline held -- no step lost. What the boards did with
> it is more interesting than that. The first reading was:
>
> - **`Replica fan-out` did not show it.** It is `sum by (service_instance_id) (rate(...))`
>   over a counter that is stale-held after its process dies, so a departed replica's series
>   persists at rate zero instead of ending. The line flattens; it never stops.
> - **`Consuming by queue` cannot show it at all.** Both processor replicas consume one shared
>   queue, so a per-queue panel has no per-replica resolution by construction. This panel was
>   never capable of this case, which is worth saying outright rather than filing as a miss.
> - **`Workers reporting` and `Workers missing (5m)` did show it** -- 5->4 and 0->1 -- and are the
>   only things that did.
>
> Both panels were changed and the scenario re-run. Judged against Prometheus range queries over
> the run rather than against the sampled legends -- see the next bullet for why that distinction
> decides the whole result. The departed replica's last export was at +185s.
>
> - **`Consuming by queue and replica` now shows it, and the first reading understated the
>   panel.** Split per replica on the processor board, `min by (queue,service_instance_id)`
>   draws the departed replica's line to +195s and stops; the survivor runs the whole 555s; the
>   replacement's line starts at +255s. The aggregate form is a single flat line at 1 across the
>   entire run -- not merely unable to name the replica, but blind to the departure altogether,
>   because `min` over one shared queue is the survivor's value. That is the improvement, and it
>   is the one worth having.
> - **`Replica fan-out`'s first reading was wrong about the cause, and the fix is narrower than
>   it looks.** The line does not persist at zero: ungated, `rate()` ends when fewer than two
>   samples remain in the rate window, which at the board's usual 1m `$__rate_interval` is +210s
>   -- 25s after the last export, and *before* the 40s liveness window expires. So the liveness
>   gate is **a no-op at the range this board is normally read at**, and measured that way it
>   changes nothing.
>
>   It becomes load-bearing when the range is widened, because `$__rate_interval` grows with it.
>   Measured on the same run: ungated, the departed line ran to +210s at a 1m rate interval,
>   +270s at 2m, +450s at 5m and past the end of the run at 10m, fading toward zero the whole
>   way. Gated, it ends at +210s in all four, at its true last rate rather than a decayed one.
>   The panel's honesty used to depend on the time range; now it does not. That is a smaller
>   claim than "the panel could not tell a departure from an idle replica", and it is the one
>   the measurement supports.
> - **`Workers reporting` and `Workers missing (5m)` still show it** and are still the fastest
>   signal.

**A Grafana legend is not evidence that a line is still being drawn.**

> The first reading above -- "the panel kept drawing the departed replica for the rest of the
> run and only ever gained the replacement's name" -- came from `chaos-timeline.js`, which
> renders each board at `from=now-15m` and records the panel's **legend text**. A Grafana
> timeseries legend lists every series with data anywhere in the range, so a series whose line
> stopped four minutes ago keeps its legend entry for the remaining eleven. A run shorter than
> the range therefore *cannot* show a name disappearing, no matter what the lines do. Both
> panels' legends accumulated names and dropped none, before and after the fix, exactly as that
> mechanism requires.
>
> This is the `state=inactive` mistake wearing different clothes: an instrument that reports the
> same value whatever the system does, read as though it were reporting on the system. **Judge
> series presence with a `query_range` against Prometheus, and use the sampled legends only for
> what they can actually say** -- which panels had data at all, and what the verdict stats read.

**Grafana restarts destroy every dashboard.**

> The `grafana-dashboards` ConfigMap is empty and Grafana's storage is an `emptyDir`, so
> **any restart of the Grafana pod loses every hand-imported board.** This was found when a
> mandated rollout restart wiped `skp-runtime`, which is the one board the generator cannot
> rebuild. The README already says boards are imported by hand; it did not say that a restart
> is destructive, which is the part that actually costs you something. Re-import from
> `grafana/dashboards/` after any Grafana restart. Fixing it properly means provisioning the
> boards or giving Grafana a PVC.

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
