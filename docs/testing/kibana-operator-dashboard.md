# Kibana operator dashboard — operator notes

Design: `docs/superpowers/specs/2026-09-22-kibana-operator-dashboard-design.md`.
Objects: `elastic/`. Install order and re-sync instructions: `elastic/README.md`.

## Opening it

```
./k8s/port-forward-realstack.ps1
```

Then `http://localhost:15601` → Dashboards → **SKP — workflow step outcomes**. There is no login.

Pick a workflow in the first control. Step and Outcome then offer only values present under it.
The bins chart is one bar per STEP, clustered side by side at each time bucket; the pie is the
outcome distribution for the same selection. Click a pie slice to filter the dashboard in place, or
use the panel's drill-down to open the same selection in Discover.

**Why step and not processor.** `sk-normalizer` serves two steps in this chain (the Acme and
AlphaBeta branches) and `kafka-exporter` serves two (`export-outcome` and `split-exporter`), so a
per-processor split collapses four steps into two bars and hides which one is failing. Ten steps,
ten bars. `skp.processor_name` is still a column in the Discover drill-down when you want it.

## What a healthy run looks like

There is **no expected profile encoded anywhere in the dashboard**, deliberately — it presents the
distribution and you decide what is correct for the workflow in front of you. Bins are *not*
expected to be equal: volume falls at a step that filters and rises at one that fans out.

For the one workflow this was validated against, `filefetcher-archiveexpander-chain` driven by
`tools/simulate-endless-feed.py`, one cycle of five files produces **30** counted outcomes —
26 Completed, 3 Failed, 1 Cancelled. Measured over 43 consecutive cycles on 2026-09-22, the totals
were exact, not approximate: 1290 counted records, 1118 Completed / 129 Failed / 43 Cancelled.

Per STEP, which is what the bins chart draws — ten bars summing to 30:

| step | per cycle | processor |
|---|---|---|
| split-filefetcher | 5 | file-fetcher |
| split-importer | 5 | kafka-importer |
| split-archiveexpander | 4 | archive-expander |
| export-outcome | 3 | kafka-exporter |
| record-outcome | 3 | outcome-recorder |
| sk-normalizer-sample | 3 | sk-normalizer |
| split-archivecollapser | 2 | archive-collapser — runs once per normalizer branch |
| split-exporter | 2 | kafka-exporter |
| split-filepersister | 2 | file-persister |
| sk-normalizer-alphabeta | 1 | sk-normalizer |

Rolled up per processor, which is what check 4 asserts:

| processor | per cycle | breakdown |
|---|---|---|
| kafka-importer | 5 | 5 Completed |
| file-fetcher | 5 | 4 Completed, 1 Failed |
| archive-expander | 4 | 3 Completed, 1 Failed |
| sk-normalizer | 4 | 2 Completed, 1 Failed, 1 Cancelled |
| outcome-recorder | 3 | 3 Completed |
| archive-collapser | 2 | 2 Completed |
| file-persister | 2 | 2 Completed |
| kafka-exporter | 5 | terminal-step Completed only: 2 documents + 3 failure exports |

The three Failed and one Cancelled per cycle are the simulator's design, not a fault: it writes one
file per outcome the chain can produce. A cycle with **zero** failures means something other than
the simulator is feeding the chain.

## Three things that will mislead you

**1. Every string in this index is a `keyword`.** The `all_strings_to_keywords` dynamic template
maps them all, so `match` and `match_phrase` need the *entire* field value and return zero hits
otherwise — silently, with no error. In Discover, filter structurally on `attributes.*` rather than
text-matching `body.text`, and reach for `wildcard` only when you must hunt free text:

```
attributes.Result: "Failed" and skp.processor_name: "sk-normalizer"      <- works
body.text: "cancelled"                                                    <- zero hits, always
body.text: *cancelled*                                                    <- works, slowly
```

**2. Enrichment is forward-only, and the window opened when the pipeline was installed.**
Documents indexed before then keep their raw GUIDs and carry no `skp.*` fields at all — they are
not merely unnamed, they are *uncounted*, because `skp.outcome_record` is stamped at ingest time.
Widening the time range past the install date does not show you more history; it shows you the same
records in an emptier chart. The dashboard's stored range is the last 1 hour for this reason, and
there is no reindex planned.

**3. A workflow published after the last sync shows GUIDs in the controls.** Enrich reads a
point-in-time snapshot of the lookup index. Fix it with:

```
python tools/sync-entity-names.py
```

Records indexed *before* that sync keep their GUIDs — see point 2. Run the sync right after
publishing, not after noticing. Nothing runs it automatically: not a cron, and **not a dashboard
refresh**. A refresh only re-queries what is already indexed.

## What the ingest pipeline costs

Measured 2026-09-22 over a timed 75-second window: `logs@custom` is invoked on **100% of documents**
(721 of 721 that `logs@default-pipeline` handled) at **0.0264 ms per document**, with zero failures.
The first reading after installation looks ~20x worse; that is one-off painless compilation, and the
counter does not move again. Re-measure at any time with:

```
curl -s 'http://localhost:19200/_nodes/stats/ingest' | python -c "import json,sys; p=list(json.load(sys.stdin)['nodes'].values())[0]['ingest']['pipelines']['logs@custom']; print('%.4f ms/doc over %s docs, failed=%s' % (p['time_in_millis']/max(p['count'],1), p['count'], p['failed']))"
```

Watch `failed` as much as the timing: a pipeline that starts failing does not drop documents (the
`on_failure` handler passes them through with `skp.enrich_error`), but it does stop counting them.

## The counts are an observability signal, not an accounting ledger

This matters enough to be the last word. The authoritative outcome of a step is the `StepOutcome`
message on `orchestrator-result`, which **never reaches Elasticsearch**. What this dashboard reads
is the *log* of that outcome, exported best-effort over OTLP.

The collector's logs pipeline has no processors and drops nothing deliberately, and since
2026-09-11 it has retry and a sending queue. But past 5 retries or a full 5000-item queue a record
is still lost — before that change it silently lost 1–3 records every ~15s, surfacing as whole hops
missing from a correlation trace. A lost record is an under-reported bin, and **a missing bar reads
exactly like a failed step.**

So: use the dashboard to find *where* to look. Confirm what actually happened in the orchestrator's
own records before acting on a gap.

## Verifying it after a change

```
python tools/verify-kibana-dashboard.py --window now-30m
```

Eight of the nine checks in §9 of the design are in there, and each prints PASS or FAIL with its
measured numbers. The ninth — clicking a pie slice and confirming Discover opens pre-filtered with
the four expected failure reasons in the rows — is a UI action and is the one manual step.

Two checks fail for reasons that are about the *traffic*, not the dashboard, and the message says so:

- **check 2** reports `is the feed running?` when nothing has been indexed in the last 10 minutes.
- **check 9** fails while only one workflow is being driven. It wants counted records under two or
  more workflow names, which is what makes "generic" more than a claim.

### Check 5 is the one to care about

It asserts that no `(StepId, ExecutionId, EntryId)` triple carries more than one counted record,
which is what stops a step being tallied two or three times across the nine templates that carry
`attributes.Result`. It is exact and has no tolerance.

**The key is three fields, and `EntryId` is not optional.** The design originally specified
`(StepId, ExecutionId)`. That is wrong: this chain fans out, so one step legitimately completes
several times inside one execution — file-persister twice per cycle, archive-collapser once per
normalizer branch — all sharing a single `ExecutionId`. On a perfectly healthy run the two-field key
reported ~15 false duplicates per 10 minutes.

**One slice is not covered: terminal-step `Completed` records, which is `kafka-exporter` alone.**
Those carry no `EntryId`, so two real branch terminations cannot be told apart from one outcome
logged twice. `attributes.role` does not help — `orchestrator-result` is a shared competing-consumer
queue and deliberately not leader-gated, so `role` only records which replica happened to take that
branch, and filtering to `role=leader` drops real outcomes. That slice is guarded numerically
instead, by check 4's per-processor assertion: a terminal outcome counted twice reads as
kafka-exporter at ~10 per cycle against its expected 5.

If check 5 ever goes red after a framework change, read §4 of the design before changing anything —
particularly the orchestrator half of the condition in `elastic/logs-custom-pipeline.json`, which is
the half that is **not** maintained automatically by the scope prefix.

## Editing the panels

The saved objects in `elastic/kibana-export.ndjson` were authored through the saved-objects API, not
the Lens editor, and then verified by rendering each one. If you change them in the UI, re-export
over that file (Stack Management → Saved Objects → select the dashboard → Export, with *Include
related objects*) and confirm the five fixed ids survive:

```
python -c "import json;print(sorted(json.loads(l)['id'] for l in open('elastic/kibana-export.ndjson',encoding='utf-8') if l.strip() and 'exportedCount' not in l))"
```

Expected: `['skp-logs', 'skp-operator-outcomes', 'skp-outcome-records', 'skp-outcomes-bins', 'skp-outcomes-pie']`.
The ids are fixed on purpose — check 9 asserts on them, and a generated UUID breaks every re-import.
