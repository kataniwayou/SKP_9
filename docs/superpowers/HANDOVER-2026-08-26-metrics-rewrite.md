# Handover — processor metrics & dashboards rewrite

Date: 2026-08-26
Status: **complete and merged to `main`** (local only — `main` has no upstream configured, nothing was pushed)

## Where things stand

| | |
| --- | --- |
| Merged | `main` at `fd14f25`, fast-forward from `processor-sample-discovery` |
| This work | 34 commits, `pre-metrics-rewrite..main` |
| Rollback | `git reset --hard pre-metrics-rewrite` (annotated tag at `dbaa8e3`) |
| Tests | 0 failed / 678 passed / 22 skipped (all `Live/`) on `main` |
| Deployed | processor image rebuilt, `SourceHash` repointed, both pods Running/Ready 0 restarts |
| Boards | regenerated, ConfigMap replaced, Grafana restarted, 12/13 panels verified rendering |

**Spec:** `docs/superpowers/specs/2026-08-26-processor-metrics-rewrite-design.md` — the binding
authority, and it carries four self-corrections found during implementation (§7.1's join, §6's
`step.elapsed` and `channel.resets` rows, §11's `by (instance)`).
**Plan:** `docs/superpowers/plans/2026-08-26-processor-metrics-rewrite.md` — 12 tasks, all done.

## What changed

**Added (3):** `pipeline.loop.iterations{loop}` · `pipeline.process.start.timestamp` ·
`pipeline.consumer.duration{queue,type,disposition}`

**Removed (6, fleet-wide):** `consumer.consuming` · `consumer.inflight` · `consumer.channel.resets` ·
`process.duration` · `duplicate.suppressed` · `step.elapsed`

**Relabelled:** `queue.wait` lost `type` · `messages.consumed` lost `landed`
**Converted:** `deadletter.depth` polls every 5 min but reads on the park event (verified ~11s)

Verified live: loop rates at their exact cadences — `l2-gate` 0.2/s, `processor-liveness` 0.1/s,
`queue-depth` 0.1/s.

## If you pick this up again

**Verify boards by rendering, never by querying.** `cd grafana && node probe-panels.js` (set
`GRAFANA_URL` if 13000's forward is dead). A green `check-expressions.py` proved nothing here — the
cluster served 20-day-stale boards behind it for the whole rewrite. Deploying boards is three steps:
regenerate → `kubectl replace` (`apply` fails, 275KB vs a 256KB annotation cap) → restart Grafana.

**`instance` is the scrape target.** Use `service_instance_id` for anything per-replica. Measured:
1 distinct `instance` vs 2 `service_instance_id` on the same metric.

**Test-isolation rule now in force.** A test asserting an exact measurement sequence, or touching
unfiltered process-wide static state, belongs in `EnvironmentCollection` (`DisableParallelization`).
One isolating itself with a tag value nothing else emits does not. This closed a flake seen twice.

**Every new test must be proved to fail.** Two tasks shipped tests that passed with the production
change reverted and had to be rewritten. The discipline that stuck: delete the production line,
watch the test fail, restore it, record both outputs.

## Known-open, deliberately

1. **`channel.resets` removal cost** — spec §10.5. A broker connection that flaps and heals inside
   one 10s probe interval now moves no instrument. The removal was decided; the record names what
   it cost and what restoring takes.
2. **`step.elapsed`** — spec §10.4. Removed from SKP Flow, where it was the only door-to-door
   workflow latency signal. Same shape: decided, recorded, restorable from the tag.
3. **The liveness write is unwitnessed** — spec §9/§10.1. `ProcessorLivenessWriter` swallows Redis
   faults, so a processor invisible in L2 beats at full rate while publishing nothing.
4. **`GatedQueueConsumer` starts before Loop B finishes** — spec §10.2, pre-existing.
5. **The 210s queue-wait cycle** — spec §10.3, still open, `QueueDepthProbe` accused not convicted.
6. **`ProcessStartMetrics.Observe()` empty-before-`Stamp` is untested.** Skipped as flaky; the
   honest reason is "no *non-reflection* formulation exists" — a reflection-based one would work and
   this suite already uses that idiom (`ConsoleObservabilityTests.cs:85`).
7. **The spec's two named alert rules were never built** — §3 justifies the seeding rule with
   `pipeline_identity_ready_ratio == 0 for 5m` and `rate(pipeline_loop_iterations_total{loop="l2-gate"}[5m]) < 0.1`.
   Neither exists in `k8s/02-configmaps.yaml`. The payoff the rule was argued for is unclaimed.
8. **The orchestrator emits `pipeline.loop.iterations{loop="l2-gate"}` with no panel on its board.**
