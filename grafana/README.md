# SKP Grafana dashboards

Five boards, as plain portable JSON. **They are provisioned from this repo** -- see
**Changing a board** -- and they are also portable, so the same file lands in this
cluster's Grafana and in one on another machine without editing anything. Those two
properties are independent: provisioning is how this cluster gets them, portability is
what lets any other Grafana import them by hand.

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

**On this cluster you do not import.** The boards are provisioned from
`k8s/24-grafana-dashboards.yaml` -- see **Changing a board**. Import by hand only into a
Grafana that does not provision them, or to recover from a provisioning failure.

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

**The boards are provisioned from this repo again.** `build-dashboards.py` inlines every
board in `grafana/dashboards/` into `k8s/24-grafana-dashboards.yaml`, which is the
`grafana-dashboards` ConfigMap the pod mounts. The provider was never removed and needed no
changes -- folder `SKP`, `disableDeletion: true`, `allowUiUpdates: false`, re-read every 30s.

Provisioning had been torn out so the boards could be edited in the UI, and that trade
expired when the workflow became *edit the generator, never the JSON*: the editability being
paid for was not being used, while the durability being given up cost a hand re-import on
every restart. `allowUiUpdates: false` now makes that explicit -- a UI Save is rejected with
`Cannot save provisioned dashboard` (HTTP 400).

**The API import path is now closed, and that is the mechanism working.** Posting a board to
`/api/dashboards/db` returns `Cannot save provisioned dashboard` (HTTP 400), because the provider
sets `allowUiUpdates: false`. Regenerating and applying the ConfigMap is the only way a board
changes on this cluster. The re-import runbook above is for a Grafana that does not provision
these, or for recovering one that failed to.

**Apply it server-side, and do not believe the error if you forget:**

```bash
python grafana/build-dashboards.py
kubectl apply --server-side --field-manager=skp-dashboards -f k8s/24-grafana-dashboards.yaml
```

A plain `kubectl apply` fails with `metadata.annotations: Too long: may not be more than
262144 bytes`. That is the 256 KiB ceiling on the `last-applied-configuration` annotation
client-side apply writes -- **not** the 1 MiB ConfigMap ceiling, which the ~275 KB of boards
is comfortably under. Shrinking the boards is not the fix.

No restart is needed or wanted: the kubelet refreshes the mounted files (~60s) and the
provider re-reads them (30s), so a board updates in place within about 90s.

**Why a generated manifest rather than a `configMapGenerator`.** kustomize refuses to read
files above its own kustomization directory (`../grafana/dashboards/*.json`) without
`--load-restrictor LoadRestrictionsNone`, which would have to be remembered at every apply.
Generating the ConfigMap keeps one source of truth and needs no flags.

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

> **Superseded — `counted()` is no longer called by any panel.** Everything above is
> still the right diagnosis and the wrong remedy. "The number persists until the replica
> restarts" was written as a feature and turned out to be the cost: the absolute-total
> branch made these stats report a process lifetime rather than a range, so the verdict
> tier warned on a healthy stack and its colour stopped meaning anything. `recent()`
> replaces it and keeps both properties this section was built for. See
> **The operator review** below for the measurement.

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

**S9, the wedged replica -- the fault the suite could not inject, and what it actually showed.**

> Every other scenario removes something entirely. This one keeps the replica: process running,
> HTTP answering, metrics arriving, every liveness window passed -- and its AMQP connection closed
> and re-closed every 5s for a 60s window, so only its consumer is disturbed. The lever is
> `rabbitmqctl close_connection`, which takes the **Erlang PID, not the connection name**, and
> targets one replica because each holds exactly one connection reported under its pod IP.
> `SIGSTOP` remains the wrong tool for this and is recorded as such below.
>
> **The fault was real and it was precisely aimed.** `pipeline_consumer_channel_resets_total` went
> 1 -> 10 on the targeted replica across +195s..+255s, on both its channels, while the peer stayed
> at 1 and was never touched. The exact `peer_host` match is what bought that: pod IPs share
> prefixes here (`10.244.0.20` is a prefix of `10.244.0.205`), and a substring match would have
> disconnected every replica, which is the broker-gone scenario.
>
> **Zero steps lost**, which was the standing obligation and is the least interesting part.
>
> **`Consuming by queue and replica` stayed at 1 throughout -- and that is correct, not a miss.**
> Queried raw at a 5s step across the whole fault window, the targeted replica **never exported a
> single `consuming=0` sample**. The client's automatic recovery re-established the consumer inside
> one 10s export interval, every time. There was nothing for the panel to draw. A panel cannot show
> a gap that never reached the exporter, and no liveness window would have helped: the metric never
> carried the fault at all.
>
> So this did **not** produce a wedge. It produced a *flapping* consumer, and the stack absorbed it
> completely. That is a genuine resilience result -- repeated connection kills over a minute cost
> nothing measurable -- and it is worth more than a panel change would have been. **A true wedge --
> a consumer that stays stopped while its process reports healthy -- still has not been produced on
> this stack**, because nothing here can stop a consumer without the client putting it back.
>
> **What resolved it per replica was drawn in a form that could not resolve a replica -- now
> fixed.** Channel resets caught this fault, but the timeseries drew it as `sum by (queue,reason)`,
> and both processor replicas share one queue, so it collapsed across them exactly as
> `Consuming by queue` did before it was split. `by_instance` now carries this panel too.
> Re-judged against the recorded S9 window:
>
> | | during the fault |
> |---|---|
> | `sum by (queue,reason)` (old) | churn visible, `+195..+285s`, replica unknowable |
> | `sum by (queue,reason,service_instance_id)` (new) | `jjvhq` peak 0.150 `+195..+285s`; **`vhbrf` flat zero** |
>
> The healthy peer reading flat zero is the half worth checking: the split names the culprit
> *and* exonerates its neighbour, rather than smearing churn across both.

**S10, a dependency 685x slower -- and every board reads green.**

> The first fault this suite has injected that is *slow* rather than absent. Toxiproxy sits
> permanently between the processor and Redis (`k8s/13-toxiproxy.yaml`), and a 300 ms downstream
> latency toxic is added for the usual 60s window. Only the processor is repointed; the
> orchestrator and the API still address Redis directly.
>
> **The injection was measured, not assumed.** From inside the cluster, `redis-cli --latency`
> through the proxy:
>
> | | min | max | avg | samples in ~3s |
> |---|---|---|---|---|
> | no toxic | 0 | 1 | **0.44 ms** | 97 |
> | 300 ms toxic | 301 | 302 | **301.25 ms** | 4 |
>
> A 685x increase in round-trip latency. This check exists because a scenario that injects nothing
> and passes is the worst failure a resilience suite has available, and the S9 write-up above is
> where that habit came from.
>
> **Nothing showed it. Not one panel, not one stat.** Across the whole run:
>
> - `process p95` flat at **0.024 s**, before, during and after -- no bump anywhere
> - `process mean` flat at ~0.011 s
> - `gate open` **1.000** throughout
> - `gate trips` -- **no series at all**
> - `consuming` **1.000** throughout
> - every run Complete, nothing lost
>
> **The reason is an instrumentation gap, not a panel one: there is no store-latency instrument on
> this stack.** No `redis_*` metric, no probe duration, nothing that times a call to L2. The metric
> list has `pipeline_process_duration_seconds` and `pipeline_produce_duration_seconds` and that is
> the whole of it, and neither moved -- the L2 gate probes on its own 5s timer rather than inside
> the processing path, so a slow store does not inflate the one duration the boards do draw.
>
> So the honest statement is stronger than "a panel missed it": **these boards cannot see a degraded
> dependency at all, only an absent one.** Nine scenarios injected absence and the boards were
> tuned until they caught it. The first scenario to inject slowness found nothing to tune.
>
> Closing it needs an instrument before it needs a panel -- a timer around the L2 probe, or around
> store calls generally, exported as a histogram. That is production code and wants its own plan.
>
> **Closed twice over, and the second one is the general fix.** The store probe was timed first
> (see below), which catches a slow dependency but only the one the probe happens to call. Then
> `pipeline.step.elapsed` timed the whole step door to door, and re-running this exact scenario
> moved it from **0.050-0.060s to 0.973s** on p95 -- a fault that "not one panel, not one stat"
> could see now lands red on the board an operator opens first. See **Step latency, and the fault
> that finally moved a panel**.

**S11, a store slower than its own probe timeout -- and it reads exactly like an outage.**

> Same lever, 3 s instead of 300 ms, which is past the 2 s `L2GateOptions.ProbeTimeout`. The probe
> cannot finish inside its budget, so the gate closes. What the boards then show:
>
> | | before | during | after |
> |---|---|---|---|
> | `gate open` (processor) | 1 | **0** | 1 |
> | `consuming` (processor) | 1 | **0** | 1 |
> | `process p95` | 0.024 s | **0.024 s** | 0.024 s |
>
> `Consuming 0`, `L2 gate 0` is **character for character the "Redis paused" row** in the second-run
> table above. A store that is merely slow and a store that is gone produce the same reading, and
> nothing anywhere separates them.
>
> **Put S10 and S11 together and the shape is a cliff, not a gradient.** At 300 ms -- 685x slower
> than normal -- literally nothing moves. At 3 s, everything moves at once and reports an outage.
> There is no intermediate rendering, because there is no intermediate *instrument*: the boards have
> exactly two states for the store, working and gone, and which one a degraded store gets depends on
> which side of a 2 s probe timeout it lands. Note the duration panel is flat at 0.024 s even here,
> in the run where the pipeline demonstrably stopped.
>
> **This is the third instance of one missing distinction**, not three coincidences: a wipe reads
> like a pause, a slow store reads like an absent one, and a departed replica once read like an idle
> one. Each time the instrument answers "is it there" when the question was "what is it doing".
>
> **Attribution, which the boards do get right.** Only the processor's path to Redis was slow:
>
> | | during |
> |---|---|
> | processor gate | **0** |
> | orchestrator gate | **1** |
> | Flow board `L2 gate` (min across services) | **0** |
>
> The worker boards name the affected workload correctly and exonerate the other. The Flow stat is a
> `min`, so it reads 0 -- right for its tier, which asks *is something broken*, but on its own it
> would send an operator to Redis when Redis was entirely healthy and only one client's path to it
> was degraded. Open the worker board before touching the dependency.

**The permanent extra hop cost nothing, and that was checked rather than assumed.**

> Toxiproxy sits in the processor's Redis path on every run now, not just chaos ones, so every
> earlier measurement is taken through a component that did not exist when it was taken. Both Redis
> scenarios were re-run to find out whether that mattered.
>
> `RedisUnavailableScenarioTests` and `RedisWipeScenarioTests` both pass. But a pass only proves no
> steps were lost -- it says nothing about whether the boards still *detect* anything, which is the
> half that would have regressed. Reading the verdict stats over the same half hour shows three
> distinct dips to 0 on both `L2 gate` and `Consuming`, one per scenario:
>
> | episode | scenario |
> |---|---|
> | 11:20:11 .. 11:20:41 | S11, the 3 s latency |
> | 11:31:41 .. 11:33:11 | Redis unavailable (CLIENT PAUSE) |
> | 11:39:41 .. 11:40:41 | Redis wipe |
>
> Same readings the second-run table records. The hop is invisible in every direction that matters.

**Closing it: the store probe is timed now, and the fault that was invisible is not.**

> S10 and S11 said the boards could not see degradation. The fix is an **instrument**, not a panel
> -- there was nothing to draw, because nothing was timing the call. `pipeline.gate.probe.duration`
> is a seconds histogram recorded on all three exit paths of `L2GateProbe.IsHealthyAsync`, tagged
> `outcome` = `healthy` / `timeout` / `failed`, sharing the transport's bucket ladder.
>
> **Verified against the same fault that exposed the gap**, re-run unchanged at the same 15s
> sampling resolution. The only difference is that the instrument now exists:
>
> | | baseline | during the 300 ms fault | after |
> |---|---|---|---|
> | **probe mean** | 0.8 ms | 142.6 → **301.4** → 117.2 ms | 0.7 ms |
> | **probe p95** | ~2 ms | 475.0 → 487.5 → 467.7 ms | ~2 ms |
> | `process p95` | 24.1 ms | 24.0 → 23.2 → 23.5 ms | 24.0 ms |
> | `gate open` | 1 | 1 → 1 → 1 | 1 |
> | `consuming` | 1 | 1 → 1 → 1 | 1 |
>
> **The probe mean peaks at 301.4 ms against an injected 300 ms**, and the independent control
> through `redis-cli --latency` read 301.25 ms. Three measurements agreeing to a fraction of a
> millisecond.
>
> Everything that was blind is still blind, correctly: the gate has no business tripping at 300 ms
> and it did not. The instrument is the only thing that moved, by ~375x on the mean.
>
> **Read the mean, not the p95, for the magnitude.** 487 ms is interpolation inside the
> `(0.25, 0.5]` bucket, not an observation -- which is exactly the property the produce-duration
> panel already documents as the reason for plotting the mean beside the quantiles. This run is a
> clean demonstration of that rationale rather than a defect in it.
>
> The three-sample ramp (142.6 → 301.4 → 117.2) is the 1-minute rate window smearing a 60-second
> fault; only the middle sample sees the fault for its whole window.
>
> **What is still not covered.** The instrument times the *probe*, not real store calls, which is
> deliberate -- the probe ticks every 5s whether or not work is flowing, so it reports during idle
> periods, where a histogram over real traffic goes quiet exactly when a pipeline has stalled. The
> consequence is that a store which is slow *only under load* would still be missed. Only the
> console probe is instrumented; **the API's copy is not**, and that remains a separately-recorded
> gap.

**Green now means the expected rate, not merely a non-zero one.**

> `System flowing` went green above **0.0001 req/s**. So the colour answered *is anything moving*
> while the panel's own text claimed it answered *has throughput changed* -- and a collapse from
> 1.39 to 0.001 req/s, a thousandfold, stayed green. That is the steady-state twin of the S10
> finding: these boards were built to detect absence, and absence is not the only way a pipeline
> goes wrong.
>
> Green is now **0.9 - 2.0 req/s**, orange outside it, red only at a standstill. Verified against
> the live system: 1.335 req/s reads green, and a halving, a tenth and a thousandth all read orange
> where every one of them previously read green.
>
> **The window had to be pinned to make a band possible at all.** Traffic is bursty -- one cron fire
> every 30s -- and the panel used `$__rate_interval`, 60s here, which cannot smooth that. Measured
> at one instant, sampling every 5s:
>
> | rate window | sampled every | min | max | spread |
> |---|---|---|---|---|
> | `[60s]` | 5s | 0.957 | 1.905 | **0.948** |
> | `[60s]` | 30s | 1.107 | 1.394 | 0.287 |
> | `[4m]` | 5s | 1.344 | 1.524 | 0.180 |
>
> A band on the 60s form would flap on burst phase alone. The stat is pinned at `[4m]`, where the
> steady state is **1.383-1.392 req/s across eighteen undisturbed minutes** -- a spread of 0.5%.
>
> **The middle row of that table is a trap worth naming.** Confirming this with a range query
> stepped at 30s samples a 30s-periodic signal at exactly its own period, aliases the swing away,
> and reports a rock-steady value that depends entirely on which phase you landed on. It read a
> confident 0.961 that way, against a true mean of 1.386, and it looked like the tightest number in
> the whole measurement.

**Three panels now say where normal ends.**

> The measured normals were written in panel descriptions -- prose you have to hover to read -- so
> an operator had to already know that 24ms was right. They are reference lines now: **5ms** on
> store probe latency (steady p95 ~2ms, jitter to 6ms), **50ms** on produce duration (steady 20-35ms)
> and **50ms** on process duration (steady 17-43ms, clustered at 24ms).
>
> Not alarm thresholds -- none of these panels has a failure mode that a single number separates.
> They answer the question a stat row cannot: *is what I am looking at the normal value?* A p95
> settling above the line is a dependency or a transform getting slower, which no verdict stat will
> ever show, because nothing is broken.
>
> **These are the most deployment-specific numbers on these boards** -- they describe this workload
> rather than this architecture, and unlike `LIVENESS` they are not enforced by any check. Re-derive
> all four before trusting a green band anywhere else.

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
>
> `chaos-probe.py` now does this for you: `spans()` reports where each series' line ENDS, and
> the run prints `line ENDS at +195s (window +0..+410s): service_instance_id=...` beside the
> panel. Re-judging the recorded run names the departed replica by itself on both per-replica
> panels, while the orchestrator's aggregate `Consuming by queue` reports nothing ended --
> the measured contrast behind the claim above.
>
> **Presence in a window was not enough, and the reason is worth keeping.** The first
> implementation asked whether a series was present before the fault and absent during it.
> That reported *nothing* for this run, correctly: a departed replica keeps drawing for up to
> a rate window after its last export, so its series IS present early in any window drawn at
> the true fault instant. The only way to make that test say "departed" is to slide the
> window until it agrees. Where a line ends is a property of the series, not of the window it
> is judged in -- so that is what the probe asks. `grafana/test-chaos-probe.py` pins both
> directions, including the one that matters: a series flat at zero beside working peers is
> **not** reported as departed.

**Grafana restarts destroyed every dashboard, until the boards were provisioned again.**

> The `grafana-dashboards` ConfigMap was empty and Grafana's storage is an `emptyDir`, so
> **any restart of the Grafana pod lost every hand-imported board.** This was found when a
> mandated rollout restart wiped `skp-runtime`, the one board the generator cannot rebuild
> -- though it is tracked in git, so the cost was re-import toil rather than the board. The
> README already said boards were imported by hand; it did not say a restart was
> destructive, which is the part that actually cost you something.
>
> Closed by provisioning them from the repo -- see **Changing a board** above. All five
> report `provisioned=true` in folder `SKP` with panel counts 20/20/26/25/17 (28/22/38/36/17
> after the operator review below), and anonymous
> viewers get 200 on every one, so the ACL artefact recorded below did not recur.
>
> **Then actually restarted, because everything above is upstream of the claim.** A
> `kubectl rollout restart deployment/grafana` replaced the pod with a fresh `emptyDir`, and
> all five boards came back by themselves: same uids, same folder, same panel counts, still
> `provisioned=true`, anonymous 200 on every one, no duplicates, the `skp-prometheus`
> datasource re-provisioned as default, and a query through Grafana's datasource proxy
> returning live data. `skp-runtime` -- the board a restart destroyed last time and the
> generator cannot rebuild -- returned with its 17 panels.
>
> Provisioning being configured correctly is not the same claim as the boards surviving a
> restart, and this project has twice shipped the first while believing the second.
>
> **The restart kills the Grafana port-forward.** `kubectl port-forward svc/grafana
> 13000:3000` binds to a pod, not to the service, so the old process survives the pod that
> backed it and every request returns `000`. Kill it and start a new one before concluding
> anything about the boards.
>
> **The storage is still an `emptyDir`, deliberately (DASH-03).** That is now the mechanism
> rather than the hazard: a pod recreate must rebuild every board from this repo, which is
> what makes the repo the source of truth instead of whatever a human last imported.

## Reading the boards

Four tiers on the worker boards, in the order the questions actually get asked:

1. **Verdict** — stat row. Is it broken **right now**? Fault stats here count over a
   fixed 5m and go green again when the fault stops, which is what makes the colour on
   this row worth reading.
2. **Since** — stat row. What has already **happened** in the visible range? The same
   instruments, `$__range` instead of 5m, plus dead-letter depth and process restarts.
3. **Pipeline** — timeseries and state timelines. What is broken?
4. **Runtime** — collapsed, two panels. Is the process why?

`skp-flow` has the same tense split (Verdict / Since / Flow) and has had since it was
built; the worker boards had one row doing both jobs until the operator review below.
`skp-baseapi` has three tiers (Verdict / Ingress / Runtime) and no Since row -- it
carries `DNS failures (range)` and `Process restarts` instead.

Live panel counts, all `provisioned=true` in folder `SKP`:

| board | panels | rows |
|---|---|---|
| `skp-flow` | 28 | Verdict / Since / Flow |
| `skp-baseapi` | 22 | Verdict / Ingress / Runtime |
| `skp-orchestrator` | 38 | Verdict / Since / Pipeline / Runtime |
| `skp-processor` | 36 | Verdict / Since / Pipeline / Runtime |
| `skp-runtime` | 17 | (no rows) |

The collapsed Runtime tier carries **two** panels -- thread-pool queue and GC pause --
because those only explain a symptom you are already looking at. Exception rate and
process restarts used to be there and are on the visible tier now; the review section
below has the measurement that moved them. The remaining thirteen runtime metrics answer
memory-and-perf questions and live on `skp-runtime.json`.

### Why fault panels end in `or vector(0)` — and the three that must not

A counter that has never incremented exports no series, so a fault expression written
plainly renders **No data** — visually identical to a broken query, a bad variable, or a
dead scrape. On a healthy stack that is most of them: measured on this cluster, only one
of six `disposition`/`reason` pairs exists, `landed="false"` has never occurred, and
`pipeline_duplicate_suppressed_total` has zero series.

Most fault stats therefore end `or vector(0)` and are thresholded green-at-zero, so
healthy reads as an explicit green `0`. Breakdown-by-label panels that cannot use that
trick (the fallback would draw an unlabelled series) set `noValue` text instead.

**The trick is wrong wherever absence and zero are different facts, and it had silently
become wrong in four places.** A trailing `or vector(0)` substitutes for an empty result,
and "nothing reported" then renders identically to "nothing happened" — in green, on a
verdict tier:

- **The two hop gaps.** `sum(A) - sum(B) or vector(0)`: `sum()` over an empty vector
  yields no sample, the subtraction propagates the emptiness, and the fallback painted a
  total outage as a perfect conservation. The fallback is per-side now, so an absent
  producer reads −3813 and an absent consumer +3821.
- **The three dead-letter stats.** No probe reporting is not the same fact as no messages
  dead-lettered. They carry `noValue` text instead, which is how the processor board says
  `not probed` rather than a reassuring `0` — see the instrumentation gap below.

The rule the boards follow now: `or vector(0)` where the metric exists and the counter
simply has not fired; `noValue` text where the *series* not existing is itself the thing
worth knowing.

### Two panels that mean less than they look like

**`pipeline_leader_ratio` is not a fault signal.** Two of three orchestrator replicas
read `0` by design, and `StepOutcomeHandler` is deliberately not leader-gated, so a
follower at zero is still expected to be consuming. The verdict stat is
`count(pipeline_leader_ratio == 1)`, which must be exactly 1 — zero means nobody holds
the lease, two means a split.

This paragraph existed while `Leader by replica` rendered every follower **red**, because
a red-below-1 posture threshold is what 0 means everywhere else on these boards. The
panel said the opposite of the text above it for as long as both existed. Colours on the
state timelines come from per-value mappings now, so follower is blue, a processor
waiting for its identity row is orange, and only genuinely-wrong states are red.

**The orchestrator's Role filter reaches four panels, not the board.** `role` is an
attribute on three instruments only — `pipeline.messages.produced`,
`pipeline.messages.consumed`, `pipeline.produce.duration`. The gauges and
`consumer.channel.resets` carry no `role`, and a `role=~"leader"` matcher does not match
a series that has no `role` label, so applying the variable board-wide would empty them.
The verdict tier is left unfiltered too: it answers *is anything wrong anywhere*, and a
role selection there would let a follower fault hide behind a leader view. There is a
note panel on the board saying so.

## The operator review

Nine changes, from a pass that asked one question of every panel: **would this help
someone detect an infra outage, a pipeline anomaly or a defect, at three in the morning,
without already knowing the system?** Every finding below was verified against live
Prometheus or against a rendered page before it was acted on, and each landed as its own
commit.

The structure was already right. Everything here is a defect inside it.

### The boards warned at rest, so the colour meant nothing

Three of the four boards showed orange on a healthy stack: `Not acked 1` and
`Channel resets 54` on the orchestrator, `Not acked 1` on the processor. An operator who
sees orange every day stops reading orange — and the one stat that had earned it,
`Dead-lettered 7`, gets the same trained indifference.

**`counted()` did not compute what its callers claimed.** It took the larger of in-window
growth and `max_over_time`, and `max_over_time` of a monotonic counter IS its current
value: the total since the process started, not since the window began. So every
description reading "counted over the visible range" described something the expression
did not compute. Measured on orchestrator channel resets over a 3h range:

| form | reads | what it actually is |
|---|---|---|
| `counted()` | 63 | the process lifetime total |
| `recent("3h")` | 54.2 | what happened in the visible three hours |
| `recent("5m")` | 0 | what is happening now |

`Not acked` read 1 against a single requeue that happened *more than three hours before
the visible range began*.

`recent()` replaces it: the larger of `increase()` (reset-aware) and a clamped
now-minus-offset delta (birth-aware). Both failure modes `counted()` existed for are
still covered — a counter that resets on restart, and a fault series whose very first
exported sample is already non-zero — without the lifetime stickiness. The verdict tier
then asks over a fixed 5m, and the range totals moved to the new Since row.

`counted()` is still in `build-dashboards.py`, uncalled, with a note: the five alert
rules in `k8s/02-configmaps.yaml` carry its shape, and changing those is a Prometheus
config edit that discards the whole TSDB. The divergence is recorded rather than papered
over.

### The two presence stats could not go red

`Workers reporting` and `Pods reporting` both carried `T_NEUTRAL`. Confirmed by reading
the computed colour out of the rendered page rather than off a screenshot:
`rgb(204,204,220)` — the same grey at 5 workers that it would show at 0. On a row titled
*is it broken?* the colour is what a reader scans before any digits, and the two panels
that answer *do the processes still exist* were the ones with none.

`Workers reporting` is red below 1, orange below `EXPECTED_WORKERS`, green at it. That
constant is new and deployment-specific, and the trade is worth stating: the panel was
built to need no expected count, and that count-free detection is untouched — it still
lives on `Workers missing (5m)`. The constant buys the **colour** only, and fails
conservatively, because fewer workers than expected reads orange rather than green.

`In-flight` and `p95 latency` keep `T_NEUTRAL` deliberately and now say why: no measured
failure value exists for either, and a step picked without one is a guess wearing a
colour.

### A fault counter must be counted — including the one nobody converted

The pipeline fault stats were converted from rates to counts because a rare fault against
a 60s rate window rounds to nothing. `DNS failures` never got the same treatment and had
the identical defect. Measured while the panel showed `0.00 req/s` in green:

| | reads |
|---|---|
| `increase(dns_lookup_duration_seconds_count{error_type!=""}[3h])` | **21.04** |
| the same over `[6h]` | **35.02** |
| the rate form the stat actually used | **0** |

— with the spikes plainly drawn on `Dependency name resolution` three panels below. The
verdict tier said the API's dependencies were fine while the board's own ingress tier
showed them failing. Split by tense now: `DNS failures (5m)` on the verdict row,
`DNS failures (range)` beside the note panel.

### Six panels drew booleans on a shared axis, so only one showed

Every series on these sits at exactly 1 in health. As overlaid lines they render as ONE
line and only the last drawn is visible, which made each panel unable to answer the
question in its own title:

| panel | what it actually rendered |
|---|---|
| `Leader by replica` | three replicas as a single filled band with slivers — handovers visible, whose they were not |
| `Consuming by queue` | five orchestrator queues as one flat line across three hours |
| `Identity ready by replica` | four series (two live, two stale-held) as one opaque block |

All six are state timelines now — one row per series, each labelled. A row that **ends**
is a replica that left; a row in the failed colour is one that is present and not
working. The line form could not distinguish those two at all.

**Two rendering defects here were invisible to `check-expressions.py` and showed up only
on screen**, which is the same lesson `audit-boards.js` was written for:

- The legend read `< 1  1+`, naming neither state. Grafana builds a state timeline's
  legend from the **threshold steps** whenever colour mode is `thresholds` and there is
  more than one step. Colour comes from the value mappings now and the mode is fixed, so
  the legend reads `leader / follower`, `consuming`, `admitted`.
- Followers rendered red, contradicting the panel's own description. See the leader note
  above.

### The flow matrix could not put a hop's two sides on one row

Both targets grouped by `(service_name, type)` and were merged on that key. But the
producer and the consumer of a type are **different services**, so the key never matched
and every hop landed as two rows with the other column blank:

```
orchestrator     process-dispatch   0.413    (blank)
sample-proc-v9   process-dispatch  (blank)    0.510
```

Two non-adjacent rows, a 23% discrepancy between them, and nothing to suggest they were
the same quantity. A conservation table that cannot put the two sides of a conservation
on one row is not one.

Grouped by `type` alone now, with a computed `gap /s` column. Live reading — four types,
four rows, every gap inside the scrape-boundary jitter the hop-gap stats already
document:

| type | produced /s | consumed /s | gap /s |
|---|---|---|---|
| next-step-handoff | 0.255 | 0.280 | −0.025 |
| process-dispatch | 0.305 | 0.255 | 0.050 |
| step-outcome | 0.240 | 0.300 | −0.060 |
| processed-data | 0.255 | 0.240 | 0.015 |

Dropping `service_name` costs the *who*, which the description says outright: that is
what `Produced by type and outcome` and `Consumed by type and disposition` on the worker
boards are for.

### The dead-letter drill-down dead-ended

`Dead-lettered 7` — the stat that found a real correctness defect — existed on `skp-flow`
alone. An operator who saw it non-zero and clicked through to a worker board found no
dead-letter panel at all; the only evidence there was a `step-outcome / parked` series
inside a five-series timeseries, at a value visually indistinguishable from zero.

Both worker boards now carry a `Dead-lettered` stat on the Since tier and a
`Dead-letter depth by queue` timeseries on the pipeline tier, emitted from the shared
functions so the two cannot drift.

**That surfaced an instrumentation gap.** `ProcessorQueues.Dead()` declares a
`processor-{id}.dead` queue, but `DeadLetterDepthProbe` is registered in
`OrchestratorHost` **only** — so the processor's dead-letter queue exists and nothing
measures its depth. The panel is kept on both boards and says so, because an unmeasured
queue an operator can name is worth more than a panel that quietly is not there.

### Restarts and exceptions were behind a collapsed row

`Process restarts` read **6 for each of the three orchestrator replicas** over a
three-hour range — eighteen process starts — while `Workers reporting` sat green at 5 and
`Workers missing (5m)` at 0, because every restart had completed and been replaced before
either could see it. The only place that fact appeared was the bottom of `skp-runtime`,
below fifteen GC panels, and behind a row titled as though it were about garbage
collection on the boards an operator actually opens.

That is not a small omission. A restart is the documented cause of the hop gaps reading
+46/−47, of `Channel resets` reaching tens, and of a replica's series ending and
restarting under a new identity. Every one of those panels tells the reader to go and
check for a restart, and none of them could be checked without expanding the
wrong-looking row.

`Exception rate` and `Process restarts` are on the visible tier of all three source
boards now, and a `Process restarts` stat sits on the Since tier of both worker boards.
Live reading on the orchestrator: **15, orange**, against green everywhere else.

### An always-blank panel teaches the wrong habit

`pipeline_duplicate_suppressed_total` has never produced a series here — zero series, and
no metric name matching `duplicate` or `suppress` exists at all, before or after a
deliberate L2 wipe. So `Duplicate suppression rate` spent a full third of a row on a flat
line at zero, on an axis auto-scaled to 0–100 req/s because there was no data to scale it
by. Its own description defended this: *"flat zero is healthy and is drawn, not left
empty."*

That reasoning is right for a signal that can move and wrong for one that never has. What
it teaches an operator is that a blank panel here is normal, and that habit is what makes
the next genuinely-empty panel invisible.

**The fix is narrower than the review proposed, and reading the source is why.** The
review said delete both duplicate-suppression panels. `ProcessDispatchHandler.cs:175`
calls `RecordDuplicateSuppressed()`, so this is an untriggered path rather than dead
code, and deleting all of it would drop coverage of a real idempotence signal the moment
it first fires. The graph goes; the stat stays, moved to the Since tier.

### What this pass did not close

Unchanged, and still the largest gaps for an operator:

- ~~**No backlog, queue depth or consumer lag anywhere.**~~ **Closed** — see
  **Queue depth, and the probe that could not see its own outage** below.
- ~~**No end-to-end latency or message age.**~~ **Closed** — see **Step latency, and the
  fault that finally moved a panel** below.
- **Degradation is still largely invisible**, beyond the store-probe instrument — see the
  S10/S11 write-up above.
- **Nothing consumes the alerts**, and no rule covers work being discarded.

## Queue depth, and the probe that could not see its own outage

The largest gap the operator review left open. `pipeline.queue.depth` and
`pipeline.queue.consumers` close it, and the way the first attempt failed is the part
worth keeping.

**Why depth changes what these boards can detect.** The hop gaps are a conservation
check — produced minus consumed — and a conservation check cannot tell a message sitting
in a queue from a message that vanished. Both render as a gap. Depth is the term that
separates them: a gap roughly equal to the depth is backlog, a gap far exceeding it is
loss.

It is also **the only leading indicator here**. Every other verdict signal is coincident
or lagging: `Consuming` drops once a consumer has already stopped, `Data freshness`
degrades after exports stop, and a departed replica costs a liveness window plus an export
(52–66s). A queue starts filling the moment a consumer is merely *slower* than its
producer, which is the shape of most real degradations.

**Read by passive `queue.declare`**, over the AMQP connection the process already holds —
the mechanism `DeadLetterDepthProbe` already used, and for the same reason: the broker and
Prometheus are org-owned in production, so no scrape target, no plugin, no broker-wide
metrics. `QueueDeclareOk` returns the consumer count alongside the message count, which is
the only **broker-side** signal on these boards. `pipeline.consumer.consuming` is the
process asserting its own health.

### The first design was blind to the outage it exists to catch

Registering the probe on the processor meant its work queue was probed **only by the pods
whose absence causes it to fill**. Measured against `rabbitmqctl` with the deployment
scaled to zero:

| time | broker | instrument |
|---|---|---|
| 16:54:23 | 0 msgs / 0 consumers | depth=0 |
| 16:54:36 | 1 msgs / 0 consumers | depth=0 |
| 16:55:16 | 2 msgs / 0 consumers | depth=0 |
| 16:55:43 | 3 msgs / 0 consumers | depth=0 |

A real backlog formed and the gauge read a confident zero throughout, because the departed
pods' last samples were held by the collector and by Prometheus's five-minute lookback.
**This is the stale-held gauge defect this file already documents, in its worst form**: a
probe cannot report the consequence of its own host being gone.

It would have passed every check this project had. The expression returned data, the
panel rendered, the log was quiet, and the tests were green.

**The fix is that the orchestrator probes the processor's queues**, because it outlives
them. Their names are per-processor GUIDs resolved from the workflow graph at run time, so
there is no static list: `DispatchedQueues` records every queue this process has dispatched
to — a queue we have sent work to is, by definition, a queue whose backlog is our problem —
and `QueueStatsProbe` resolves its list every pass rather than once at construction. The
liveness index in L2 would have been the wrong source for exactly the reason the self-probe
was: a processor that is gone drops out of it precisely when its queue is filling.

Same test after the fix — depth tracks the broker one probe interval behind, which is the
10s interval plus an export and a scrape:

| time | broker | instrument |
|---|---|---|
| 17:05:45 | 1 msgs | depth=0 |
| 17:05:59 | 1 msgs | depth=1 |
| 17:06:25 | 2 msgs | depth=2 |
| 17:07:05 | 4 msgs | depth=3 |

### The consumers gauge needs the liveness window, and the panels carry it

Unwrapped, `max by (queue)` read a confident **2** against the broker's **0** for a whole
outage, because it picked the departed pods' stale series over the orchestrator's fresh 0.
Both forms sampled side by side:

| broker | `max by (queue)` | `max by (queue) (last_over_time(...[40s]))` |
|---|---|---|
| 0 consumers | 2 | 2 |
| 0 consumers | 2 | **0** |
| 0 consumers | 2 | **0** |

The wrapped form corrects itself within one liveness window. Every depth and consumers
panel uses it.

### Two things about the panels

**Filtered by queue, not by service.** On these instruments `service_name` labels the
process doing the *probing*, not the queue's owner — that is the whole point of the design.
Filtering the processor board by its own `service_name` would show only what the processor
reported about itself, stale-held at exactly the moment the panel matters. It keys on
`queue=~"processor-$processorId"` instead.

**Depth is a degradation signal and a poor outage signal, deliberately.** With the
processors scaled to zero the queue reached only 4 in ninety seconds, because a stalled
pipeline stops feeding itself. `Queues unconsumed` is the sharp signal for a total stop and
moved within one liveness window in the same test. Thresholds are measured: over a clean
four-minute window every orchestrator queue held a flat 0 while the processor work queue
ran **mean 0.65, max 3** — a cron fire dispatches a batch against `PrefetchCount` 1 and two
replicas drain it one at a time. Green below 5 clears that; red at 20.

### What it still cannot do

- **A consumer that reattaches inside one 10s probe interval is invisible** — which is
  exactly what the S9 flapping-connection scenario produced.
- **Depth counts messages *ready*, not unacked.** Exact only because `PrefetchCount` is 1.
- **Nothing alerts on it**, like everything else here.

## Step latency, and the fault that finally moved a panel

`pipeline.step.elapsed` and `pipeline.queue.wait` close the last measurement gap the
operator review left open: how long a workflow *step* takes, and how much of that was
spent waiting in the broker.

**Neither could be borrowed from what was already here.** There is no trace context
anywhere in `src/` — no `ActivitySource`, no `traceparent`, no propagator — so this cannot
be read off traces. And the obvious in-process stopwatch cannot span a step:
`orchestrator-result` is a shared competing-consumer queue, so a step's outcome is
routinely consumed by a **different replica** than the one that dispatched it. The
measurement has to travel with the message.

**Two headers, two questions.** `x-skp-sent-ms` is stamped fresh on every publish, so the
consumer's difference is this hop's broker wait — the term neither produce duration nor
process duration contains, and therefore the one that goes missing when an end-to-end time
grows and no component looks slow. `x-skp-origin-ms` is stamped once when a step begins and
propagated unchanged by every message that step causes, so when the orchestrator consumes
the step's outcome the difference is the whole door-to-door time.

**Propagation needed no contract change**, which is why it was done this way.
`IQueueMessageHandler` receives a body and nothing else — no properties, no headers — so a
handler cannot see what it arrived with and cannot copy it forward. Threading it through
meant changing that interface and every handler, or adding a field to three message records
and keeping them in step. An `AsyncLocal` set by the consumer before it invokes the handler
flows into everything the handler does, including its sends, and nothing else has to know
it exists.

**The chain is reset where a step is dispatched, not merely propagated.** A step's outcome
is handled by the orchestrator, which dispatches the *next* step from inside that delivery
— so an origin only ever propagated would ride from the first step to the last, and every
step after the first would report cumulative run time under a name that says step.

### It closes S10

The S10 write-up above records, of 300ms of injected Redis latency on the processor's path:
*"Nothing showed it. Not one panel, not one stat."* Process p95 flat at 24ms, gate 1,
consuming 1, every run complete. Re-run unchanged with this instrument in place:

| | baseline | during the 300ms fault |
|---|---|---|
| **step-outcome p95** | 0.050 – 0.060 s | **0.973 s** |
| **step-outcome mean** | 0.036 – 0.037 s | **0.835 s** |

Sixteen times on the quantile, twenty-three on the mean, against a fault that previously
moved nothing anywhere. The toxic was removed afterwards and its absence proven against the
proxy rather than assumed — a latency toxic has no expiry, so a killed run leaves Redis slow
indefinitely.

**The decomposition works, and that is the half worth having.** In the same window `Step
duration` spiked to ~1s while `Queue wait by hop` put a matching ~500ms spike on the
`processed-data` hop *inside the processor* — naming where the time went rather than merely
reporting that a step got slower. A rise in step time with flat queue waits is the
transform or a dependency; a rise that tracks one hop's wait is backlog on that queue, and
`Queue depth by queue` says how deep.

### The ladder is wider than the transport's, deliberately

`EgressMeter.LatencySecondsBoundaries` stops at **10s**, which is right for a broker round
trip and wrong here: these instruments exist because a pipeline can fall behind, and a
backlogged step is measured in minutes. Everything past the last boundary lands in `+Inf`,
where a quantile has nothing to interpolate between and reports the last edge — the
millisecond-ladder defect from the other end, and just as silent. The arrival ladder reaches
**300s**.

The low end starts at **10ms** rather than 1ms, and that is honesty rather than laziness:
both ends of every measurement here are stamped on different processes. On this single-node
cluster skew is nil; across nodes NTP leaves milliseconds to tens of milliseconds, which is
irrelevant at this magnitude and fatal to a figure claiming to resolve a 24ms hop. A ladder
resolving 1ms would invite someone to read noise as a latency.

`ArrivalHistogramBucketTests` guards both, by reading boundaries off an exported metric
rather than asserting `AddView` was called — a view whose instrument name matches nothing is
silently ignored. Writing those tests reproduced a smaller version of the same trap: they
recorded *before* resolving the `MeterProvider`, so the SDK had not yet subscribed, the
export was empty, and the assertion failed exactly as it would for a genuinely missing view.

### What it still cannot do

- **Absent headers are skipped, never recorded as zero.** During any rollout some messages
  carry neither, and the API publishes through a copy of the sender that stamps nothing —
  so a shortfall in the count is the API's share before it is anything else.
- **Elapsed is clamped at zero.** A clock running backwards shows as a visible pile at
  zero rather than poisoning the quantiles.
- **Nothing alerts on it**, like everything else here.

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
shape in which a dip — the entire point of the panel — was invisible. Unfilling them was
the first fix and it was not enough: unfilled lines at the same value still overlap, and
only the last drawn is visible. These six panels are **state timelines** now, one row per
series. See the operator review below.

Two smaller ones: an instant-query table carried a Time column identical on every row while
its value columns were clipped, and a panel titled "Route match failures" plotted every
match status including success.

**A stat with no thresholds renders the same grey at 5 and at 0.** `Workers reporting` and
`Pods reporting` both carried `T_NEUTRAL`, which a query check cannot see and a screenshot
can be misread about — the colour was confirmed by reading `getComputedStyle(...).color`
off the rendered page: `rgb(204,204,220)`.

**A state timeline legends itself from the threshold steps, not from the data.** Six panels
converted to `state-timeline` rendered a legend reading `< 1  1+`, naming neither state,
because Grafana takes that path whenever colour mode is `thresholds` and there is more than
one step. In the same conversion every follower replica rendered **red**, because
red-below-1 is what a posture threshold means — contradicting the panel description sitting
directly above it. Both are in **The operator review**; both passed
`check-expressions.py` without complaint.

**An always-blank panel is invisible to a query check by construction.** `Duplicate
suppression rate` returned data on every run of `check-expressions.py` — `or vector(0)` saw
to that — while rendering an empty graph on an axis scaled 0–100 req/s. A check that asks
"did this expression return something" cannot ask "was the something worth a panel".

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

## Known gap: the orchestrator's queues are unobserved while the orchestrator is gone

The co-location blind spot, third instance. A queue is measured by the process that probes
it, and the orchestrator is the only process probing `orchestrator-control`,
`orchestrator-result` and `orchestrator-result-post` — so when it is scaled to zero, those
queues stop being observed by anything.

**Measured, with broker truth beside the instrument every 15s.** The orchestrator was
absent for ~64 seconds:

| time | broker `orchestrator-result` | live series | queues observed | `Queues unconsumed` |
|---|---|---|---|---|
| 19:34:18 | cons=3 | 3 | 7 | 0 |
| 19:34:34 | **cons=0** | 3 | 7 | 0 |
| 19:34:51 | **cons=0** | 3 | 7 | 0 |
| 19:35:07 | **cons=0** | **NONE** | **1** | 0 |
| 19:35:23 | **cons=0** | **NONE** | **1** | 0 |
| 19:35:39 | cons=3 | 3 | 7 | **5** |

Two distinct failures in one window. First the stale-held pair — the broker says nothing is
listening while the instrument still reports 3, for the two samples it takes the liveness
window to expire. Then the blind pair: the series drop out entirely, **`queues observed`
falls from 7 to 1**, and `Queues unconsumed` reads a confident **0** — not because nothing
is wrong but because six of the seven queues are no longer being watched at all. The stat
cannot tell "no queues unconsumed" from "six queues unobservable".

The `5` on the last row is real and is the panel working: the replacement replicas were
reporting before their consumers had reattached.

**The fix is not yet made, because there is a genuine fork.** The processor already sends
step outcomes to `OrchestratorQueues.Result`, so recording sends in `DispatchedQueues` on
the processor side would cover the queue that matters most — but not `orchestrator-control`
or `-result-post`, which only the orchestrator ever sends to. Covering those means either
giving the processor a static list of orchestrator queue names, which couples it to another
role's topology, or recording every send inside `QueueSender` itself, which is automatic
and complete but would also probe the exclusive per-replica reply queues and, since
`DispatchedQueues` never forgets, keep warning about them after they are deleted.

Until it is closed, read `Workers reporting` and `Data freshness` for an orchestrator
outage. Both moved correctly throughout this window.

## Known gap: the processor's dead-letter queue is not probed

`ProcessorQueues.Dead()` declares a `processor-{id}.dead` queue, but
`DeadLetterDepthProbe` is registered in `OrchestratorHost` only. So the queue exists,
messages can be parked into it, and **nothing measures its depth** — the same class of
blind spot the dead-letter instrument was built to close on the orchestrator side, left
open on the other.

Found while adding the dead-letter drill-down, not by a failing check. `Dead-lettered` on
`skp-processor` reads `not probed` and `Dead-letter depth by queue` carries no-value text
saying the same, because a green `0` there would claim something nobody has measured.

Closing it is one `AddHostedService` in the processor host plus the queue names to probe.
Unlike the API gap above, this one is an oversight rather than a decision.
