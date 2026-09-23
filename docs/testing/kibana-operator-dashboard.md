# Kibana operator dashboard — operator notes

Design: `docs/superpowers/specs/2026-09-22-kibana-operator-dashboard-design.md`.
Objects: `kibana/`. Install and regeneration: `kibana/README.md`.

**Amended 2026-09-22.** The Elasticsearch side of this dashboard is gone — no ingest
pipeline, no enrich policy, no lookup index, no sync script. Names are now rendered by the
data view, and §13 of the design is the argument. Three of the notes below changed
materially as a result; they are marked where they did.

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
ten bars. `attributes.ProcessorId` is still a column in the Discover drill-down when you want it, and it renders as a processor name there too.

**The bars are ordered by when each step first fired**, not by volume, so a cluster reads
left-to-right roughly in pipeline order. That order is derived from the data -- a hidden
`min(@timestamp)` the terms aggregation sorts on -- never from a hardcoded step list, so a
different workflow orders itself with no edit. Measured stable across 3m, 7m and 12m windows.

Two steps sit earlier than the graph would put them, and that is real rather than a glitch:
`record-outcome` lands third and `export-outcome` fifth, because a file that fails at the fetch
short-circuits straight to them within milliseconds. "First fired" is earliest arrival across all
branches, not depth in the workflow graph. Strict graph order would mean reading `nextStepIds`
from the API and pinning a step list into the panel, which is exactly the hardcoding that would
stop the dashboard being generic.

**Zoom in to read it.** The bins panel is full width with the pie beneath it, but ten clustered
bars per time bucket only resolve when there are few buckets on screen. Roughly ten buckets is the
comfortable limit: at a 5-minute range each cluster is clearly separated and you can read the
5-5-4-3-3-3-2-2-2-1 shape straight off the chart, while at 25 minutes the same chart is a picket
fence of 3-pixel bars. The stored default range is 1 hour, which is wide enough to span several cron ticks -- so treat
the opening view as "is anything wrong", then drag-select on the chart or narrow the time picker to
actually read it. It no longer has anything to do with staying inside an enriched window; there is
no such window any more. The
Step control is the other way in: pick two or three steps and the clusters get their width back.

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
attributes.Result: "Failed" and attributes.ProcessorId: "1673b377-..."   <- works
attributes.Result: "Failed" and attributes.ProcessorId: "sk-normalizer"  <- ZERO HITS (see 3)
body.text: "cancelled"                                                    <- zero hits, always
body.text: *cancelled*                                                    <- works, slowly
```

**2. Names are rendered, not stored — so free text needs the GUID.** CHANGED. The panels aggregate
on `attributes.WorkflowId`, `attributes.StepId` and `attributes.ProcessorId`, and the data view
substitutes `{name}_{version}` when Kibana draws. The name exists **only at render time**. It is not
a field, so you cannot filter or search on it:

```
attributes.StepId: "split-importer_1.0.0"     <- ZERO HITS. There is no such value in the index
attributes.StepId: "ab9d8741-c109-..."        <- works. Copy the id out of the Step control
```

This is a real regression against the design that came before, which wrote enriched name fields you
could query. It buys the removal of every Elasticsearch-side object, and it was taken deliberately.

**3. All history is covered now, and a rename rewrites it.** CHANGED, and it replaces two notes that
said the opposite. The previous design enriched documents at index time, so anything indexed before
the pipeline was installed carried raw GUIDs, was uncounted, and could never be recovered without a
reindex. Formatting happens at read time, so **every record ever written is labelled**, however old.

The cost is the mirror image. The lookup is a flat map applied to all of time and `Version` is
mutable on the same row, so `{name}_{version}` means *what this entity is called now*, not what it
was called when the record was written. Bump a step's version and every historical bar for it
relabels.

**4. Names ride on the records themselves.** They used to come from a `static_lookup` formatter on
the data view, pushed by BaseApi when a dashboard render fetched `lookup/ping.svg`. Before that they
came from naming records `OrchestrationService` wrote at start time, which the cron path never
produced. Both are gone.

The name is now stamped onto each record at ingest by the `logs@custom` pipeline, from a lookup
index BaseApi writes at every workflow start. Nothing pushes to Kibana and nothing triggers it: the
data view carries an empty `fieldFormatMap` and an empty `runtimeFieldMap`.

What that costs you: **a rename no longer re-labels history.** Formatting happened when you looked,
so it covered every record ever indexed; stamping happens once, at index time. A record says what
the entity was called when it ran, which is the correct thing for a log to say, but it is a real
change in behaviour. It also means a step that has never executed is in no dropdown — structurally,
since it has no records to carry a name.

An unmatched id still renders as **itself**, never blank and never as a shared "unknown" string —
the same reason the formatters omitted `unknownKeyValue`.

## What the ingest pipeline costs

`logs@custom` runs on 100% of documents at **0.0232 ms each**, measured on 9.3.4 from
`_nodes/stats/ingest`.

**Watch its `failed` counter, not just its count.** A processor that throws inside `logs@custom`
fails the whole indexing request: the record is not indexed unnamed, it is *dropped*. This is not
hypothetical — the first version of this pipeline used `copy_from` on the id fields without guarding
them, and `copy_from` against an absent path throws. Most records here carry no ids at all, so it
rejected **4,279 documents out of 29,518** before anybody looked at the counter. Every `set` that
reads a field now carries an `if` that checks it is there, and
`ElasticLookupPublisherTests.Every_fallback_set_guards_the_field_it_copies_from` fails the build if
one loses it.

```
curl -s localhost:19200/_nodes/stats/ingest | jq '.nodes[].ingest.pipelines["logs@custom"]'
```

A non-zero `failed` means records are being lost right now.

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
node run.js tools/verify-kibana-panels.js
```

**The two ask different questions and you want both.** The Python script asks Elasticsearch whether
the DATA each panel needs exists. It cannot see a panel that failed to mount, a control bound to a
field the mapping does not have, or a chart that rendered its axes and nothing else — all three of
which have happened on this board. The Node script opens it in a real browser and asserts every
panel and control arrived, including a count of plotted series per chart, because a Lens panel
contains a canvas whether or not it drew a single bar.

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
particularly the orchestrator half of the condition in `kibana/logs-custom-pipeline.json`, which is
the half that is **not** maintained automatically by the scope prefix.

## Editing the panels

The saved objects in `kibana/kibana-export.ndjson` were authored through the saved-objects API, not
the Lens editor, and then verified by rendering each one. If you change them in the UI, re-export
over that file (Stack Management → Saved Objects → select the dashboard → Export, with *Include
related objects*) and confirm the five fixed ids survive:

```
python -c "import json;print(sorted(json.loads(l)['id'] for l in open('kibana/kibana-export.ndjson',encoding='utf-8') if l.strip() and 'exportedCount' not in l))"
```

Expected: `['skp-logs', 'skp-operator-outcomes', 'skp-outcomes-bins', 'skp-outcomes-pie']`.
The saved search `skp-outcome-records` was deleted — nothing could open it (§7.4 of the design).
The ids are fixed on purpose — check 9 asserts on them, and a generated UUID breaks every re-import.
