# Handover: endless split-chain feed, and the Kibana operator dashboard spec

Date: 2026-09-22
Branch: `feature/path-importer`
Commits: `72e5b8c` (the simulator), `84beb2c` (the Kibana spec)
Spec: `docs/superpowers/specs/2026-09-22-kibana-operator-dashboard-design.md`

## What this session produced

1. **`tools/simulate-endless-feed.py`** — an endless feed that drives
   `filefetcher-archiveexpander-chain` with a fixed outcome mix, for long-run analysis.
   Built, verified live, committed, and **still running** (see §"Live state").
2. **The Kibana dashboard spec** — design agreed with the user, self-reviewed, committed.
   **Awaiting the user's review before an implementation plan is written.** Nothing has been
   built for it; no Kibana exists.

The user's stated next move: *modify something in code first*, then resume. So the plan for the
spec has not been started on purpose, not forgotten.

## Live state — read this before assuming anything is idle

| what | where | note |
| --- | --- | --- |
| the feed | background task `btt57vu7d` | 5 files / 30s, endless. 230 cycles, 23 wipes, clean |
| its log | `scratchpad/endless-feed.log` (teed) | task output file also holds it |
| Grafana forward | background task `bromoizgw`, `localhost:13000` | **unsupervised** — dies on pod restart, does not respawn |

**The feed keeps producing until it is stopped.** It wipes `/mnt/skp-files/in` and `.../out` every
50 files, so it is not filling anything up, but it is generating continuous Elasticsearch volume
and Kafka records. To stop it, kill the task; on exit it prints the `--start-serial` to resume from.
**If it was killed without a clean exit, resume at `--start-serial 900400` or higher** — the last
observed cycle was `900231` and reusing a serial makes two runs indistinguishable by filename.

Remember that a killed background task can leave an orphan runner; verify the process tree before
relaunching, and `pkill` does not exist on this machine.

## The simulator

Five files a cycle, each built to trip exactly one stage. Roles are in the filename.

| role | file | trips | outcome |
| --- | --- | --- | --- |
| badext | `sim-NNNNNN-badext.dat` | FileFetcher `allowedExtensions: [".zip"]` | Failed |
| corrupt | `sim-NNNNNN-corrupt.zip` | ArchiveExpander signature cross-check | Failed |
| triple | `sim-NNNNNN-triple.zip` | `AcmeHandler.ValidateContent`, nodes != 2 | Failed |
| artist | `sim-NNNNNN-artist.zip` | `AcmeHandler.Augment` artist gate | **Cancelled** |
| good | `sim-NNNNNN-good.zip` | nothing | Completed → `out/` |

All five were confirmed live with their intended log messages. Design notes worth keeping:

- **`badext` carries a perfectly good archive** under a `.dat` name. If its bytes were junk too,
  two explanations would fit and the record would prove nothing.
- **`corrupt` is not an input-schema failure.** ArchiveExpander's registered `inputSchemaId` is
  `file-envelope`, written by FileFetcher itself, so no file on disk can violate it. The real
  file-driven rejection is `FileContentBuilder.Build`'s declaration cross-check.
- **The file lands before its path is seeded**, and the wipe waits for `skp-splitchain` lag to
  drain plus a settle. Wiping under lag turns every role into a missing-file fetch failure and
  destroys the run's premise. Verified across a wipe: 17 fetcher failures in the window, all of
  them the intended whitelist rejection, zero missing-file failures.
- **Role 5's artist must be on the live whitelist.** Default `SKP Live Suite`, which matches the
  live `chain-artists` cache. `tools/make-sample-archives.py` writes `Acme Test Artist`, which is
  role 4's behaviour — that is why this tool builds its own archives.

## Facts established this session that are expensive to rediscover

### Elasticsearch: every string is a `keyword`

The index template's `all_strings_to_keywords` dynamic template maps every string, including
`body.text`, to `keyword` with `ignore_above: 1024`. **`match` and `match_phrase` silently return
zero hits** unless the whole field value matches. This cost two failed query rounds. Use `wildcard`
on `body.text`, or better, aggregate on `attributes.*`, which are all indexed keywords.

Field shape: `body.text`, `severity_text`, `attributes.{…}`, `resource.attributes.{…}`.
`@timestamp` is epoch-millis-as-string but is mapped `date`, so range queries work.

### `attributes.Result` spans six templates, and counting all of them is wrong

By design — `OutcomeLogScope` documents that the field should span processor and orchestrator so a
search finds both. For **counting**, that tallies a lineage two or three times. The spec's §4 has
the full table and the counted subset. The one trap: the orchestrator's terminal-step template
carries `Completed` for terminal-only steps (new information — it is the only witness for
`kafka-exporter`) **and** `Cancelled` restating a cancel the processor already emitted (a duplicate).
Count the terminal template only where `Result` is `Completed`.

Healthy shape for this workflow under the simulator: **30 outcomes per cycle, 26:3:1**.

### The enrich join works here, and the hook is free

`logs@default-pipeline` is `index.default_pipeline` on the write index and its last processor calls
`logs@custom` with `ignore_missing_pipeline: true`. **`logs@custom` is undefined (404)** — the
supported extension point is unclaimed. An enrich policy was created, executed and simulated
successfully on this cluster's `basic` license (GUID → name, unknown ids pass through untouched).
**All proof artifacts were deleted**; the cluster carries nothing from it.

Kibana is **not installed** — no pod, no service, no manifest. ES is **8.15.5**, and **ES itself has
no manifest in `k8s/`** either; it was applied out of band.

### Produce-duration latency is a publisher-confirm floor, not a hot spot

Nine services all sit at 10–14 ms mean, which is the finding. The control that identifies it:
`get-processor-by-source-hash` publishes at **1.76 ms** through the same `QueueSender`, same
`DeliveryModes.Persistent`, same confirms — its destination is a **classic** queue, while every
pipeline queue is **quorum**. RabbitMQ is a single node, so this is the Raft WAL fsync, not network
consensus. Distribution: 27.7% ≤10 ms, 80.2% ≤15 ms, 100% ≤50 ms.

**The flat 50 ms line on the Grafana panels is a threshold annotation** (`thresholdsStyle: line`,
`value: 0.05`), not a series. Nothing crossed it. The p95 excursions to 30–40 ms are quantile
interpolation: the ladder doubles at 25 ms, so one bucket spans 25–50 ms holding 3% of samples.
Read the means.

### The wipe re-phases the importer

Importer dispatch duration stepped 10.2 s → 17.6 s → 10.3 s across the first wipe. The baseline is
`idleTimeoutSeconds: 10`. Pre-wipe, cycles landed at `:13/:43`, 8 s after the cron at `:05/:35` —
inside the idle window, so each arrival reset the timer. The drain-wait shifted cycles to `:16/:46`,
just outside it. **The simulator's phase relative to the cron is not fixed and every wipe shifts
it**, so time-based metrics will step for reasons unrelated to the files. Aligning cycle starts to
wall-clock boundaries would fix it; not done.

### Two things in the cluster that are not the simulator's doing

- **`orchestrator-result.dead` holds 10 messages**, flat for at least six hours before the run
  started. Pre-existing. It is why the orchestrator board's "Dead-letter depth (all queues)" tile
  is amber. The processor board reads 0 and is not contradicting it — that panel scopes processor
  queues only.
- **`/mnt/skp-files/out/sc/`** belongs to the `sc-chain` workflow. `rm -f` does not recurse, so
  neither the manual clean nor the simulator's wipe touches it. Also **`track01.xml`** appears in
  `out/` each cycle — the AlphaBeta branch persisting its own artifact under the item basename,
  rewritten rather than accumulated.

## Next steps

1. The user modifies code (unspecified at handover time).
2. **The Kibana spec needs the user's review.** Only after that: the implementation plan.
3. If the feed is still wanted during that work, leave `btt57vu7d` running; otherwise stop it and
   note the serial.

## Not done, deliberately

- No implementation of the Kibana dashboard — spec only, review pending.
- No Kibana manifest, no `logs@custom` pipeline, no lookup index on the cluster.
- No change to Elasticsearch's unmanaged status in `k8s/`.
- No wall-clock alignment in the simulator.
- The five dashboard ideas the user halted are recorded in §12 of the spec and were not built.
