# Reading the Kibana panels through the workflow graph

Analysis of 2026-10-01, for `filefetcher-archiveexpander-chain`. **The point:** every number on the
operator dashboard (`SKP — workflow step outcomes`) is a function of two things: the workflow graph,
and what each fire imported. Read with the graph, a panel has an expected value, and a deviation
from it means something specific. Read without the graph, a panel only shows that something changed,
not whether it should have.

Every formula below was checked against Elasticsearch over three windows with known input. All three
match exactly, with no residue (§5).

## 1. The graph

Read live from BaseApi with `read_graph()` from `kibana/publish-diagram.py`. A step's outcome becomes a
**terminal** when no next step accepts it. `entryCondition` decides acceptance: 1 = Completed,
2 = Failed, 3 = Cancelled, 4 = Always, 5 = Never.

| step | entered on | next steps | terminal on |
|---|---|---|---|
| split-importer (entry, cron) | Always | split-filefetcher, record-outcome | Cancelled |
| split-filefetcher | Completed | split-archiveexpander, record-outcome | Cancelled |
| split-archiveexpander | Completed | sk-normalizer-sample, record-outcome | Cancelled |
| sk-normalizer-sample | Completed | **split-archivecollapser, sk-normalizer-alphabeta** (fork), record-outcome | Cancelled |
| sk-normalizer-alphabeta | Completed | split-archivecollapser, record-outcome | Cancelled |
| split-archivecollapser | Completed | split-filepersister, record-outcome | Cancelled |
| split-filepersister | Completed | split-exporter, record-outcome | Cancelled |
| split-exporter | Completed | record-outcome | **Completed**, Cancelled |
| record-outcome (failure sink) | Failed | export-outcome | Failed, Cancelled |
| export-outcome | Completed | — | every outcome |

Three shapes govern every panel:
- **The fork at `sk-normalizer-sample`.** A good record splits into two branches: Acme goes straight
  to the collapser, and AlphaBeta goes through `sk-normalizer-alphabeta` first. Both then pass the
  collapser, persister and exporter. Everything downstream of the fork runs twice per good record.
- **The failure sink.** Every Failed outcome, at any step, goes to `record-outcome` and then
  `export-outcome`, and ends there once.
- **Cancelled ends where it happens.** No step accepts Cancelled, so a cancel is a terminal at the
  step that cancelled.

## 2. The input, in the terms the graph needs

Per window: **N** records imported, of which **G** good, **F** failed (F_fetch + F_expand + F_norm, by
the step that failed), **C** cancelled. Plus **E** empty polls (fires that imported nothing).

How each `simulate-endless-feed.py` role travels, and what each record leaves behind:

| record | path | terminals |
|---|---|---|
| good | fork → both branches → split-exporter ×2 | **2** |
| badext (`.dat`) | filefetcher Failed → record-outcome → export-outcome | 1 |
| corrupt | archiveexpander Failed → sink | 1 |
| triple | sk-normalizer-sample Failed → sink | 1 |
| artist (not whitelisted) | sk-normalizer-sample Cancelled | 1 |
| empty poll (no record) | split-importer Cancelled | 1 |

`simulate-approved-feed.py` sends only good records, so G = N and F = C = 0.

## 3. What each panel should show

### 3.1 Step outcome bins (one bar per step)

| step | Completed | Failed | Cancelled |
|---|---|---|---|
| split-importer | N (one per record, not per poll) | — | E |
| split-filefetcher | N − F_fetch | F_fetch | — |
| split-archiveexpander | N − F_fetch − F_expand | F_expand | — |
| sk-normalizer-sample | G | F_norm | C |
| sk-normalizer-alphabeta | G | — | — |
| split-archivecollapser | **2G** | — | — |
| split-filepersister | **2G** | — | — |
| split-exporter | **2G** | — | — |
| record-outcome | F | — | — |
| export-outcome | F | — | — |

What the graph lets you read off the bars:
- **Steps after the fork at exactly 2× `sk-normalizer-alphabeta`.** Anything else means one branch lost
  records between the fork and the end.
- **`record-outcome` = `export-outcome` = the sum of every Failed bar.** If the sink falls short of the
  failures, failure records are being lost. If it exceeds them, the sink itself is failing.
- **Volume drops from one step to the next by exactly that step's Failed and Cancelled counts.** A drop
  with no matching Failed or Cancelled is lost work.
- **The importer's Completed bar counts records, not polls.** Its Cancelled bar counts empty polls. The funnel's importer slice in §3.3 counts the same thing: one outcome record per record imported, plus one per empty poll.

### 3.2 Outcome pie

- **Failed = F**, one per failed record, counted at the step that failed.
- **Cancelled = C + E.** Cancelled records and empty polls look the same here, so the importer's
  Cancelled bar (§3.1) is what tells them apart.
- **Completed is inflated by the graph:** every good record contributes 11 Completed (importer,
  fetcher, expander, sample normalizer and alphabeta once each, then collapser, persister and exporter
  twice each). The approved window confirms it: 500 records, 5,500 Completed. Every
  failure also contributes 2 Completed in the sink. So the pie's Completed share is not a success
  rate. A rising Completed share can simply mean more good records went through the long fork.

### 3.3 Step funnel pie

One pie, two rings. The inner ring is the step's **role in this workflow** (`entry`, `intermediate`,
`terminal`, stamped by the orchestrator from the workflow's own graph); the outer ring is the **step**.
Each slice counts the orchestrator's one per-outcome record for that step, and only for fires whose
`entry` record falls inside the window, so a fire that began before the window never shows up as
downstream work.

- **`entry`** is the step a fire is dispatched to. Its slice is **not** the number of fires. The split
  importer returns one outcome per record it imported, plus one Cancelled "no successor accepts it"
  record for each empty poll. It equals the number of fires only when every poll imports exactly one
  record or none. The fire count is the panel's `fires` (distinct entry correlation ids), not this slice.
- **`intermediate`** steps are everything between: read the slices left to right as a funnel.
- **`terminal` means "a step with no successors returned an outcome".** It is a property of the graph,
  not of the result, so a terminal step that Failed still counts as terminal.
- **Cancellations show as the drop between a step and its successors.** A cancelled step ends its
  branch in place and advances nothing, so the next slice is smaller by exactly the Cancelled count.
  Failed steps drop out the same way, apart from the sink the failure is routed to.
- **Fan-out raises the count instead of dropping it.** After the fork every step is at 2x
  `sk-normalizer-alphabeta`, which is the §3.1 rule seen from the pie.

The `endless-feed-steprole` window, verified live on 2026-10-02 after the StepRole deploy
(12:57:45 to 13:12:45 UTC; 15 fires, all of which imported, 125 records = 25 feed cycles), reads in
graph (chain) order **125 / 125 / 100 / 75 / 25 / 50 / 50 / 50 / 75 / 75**. Those are split-importer,
split-filefetcher, split-archiveexpander, sk-normalizer-sample, sk-normalizer-alphabeta,
split-archivecollapser, split-filepersister, split-exporter, record-outcome and export-outcome. That is
not the pie's slice order: the pie groups by role first (the inner ring), so its slices run entry
(125), then the intermediates (550), then the terminal (75). The entry 125 is records imported (no
empty polls in that window), not the 15 fires. The three 50s are the post-fork steps at 2 x 25, and
the two 75s are the failure sink. If a post-fork step is not 2 x alphabeta, or the sink is
not the sum of the Failed bars, branches started and did not end.

The Step and Outcome dashboard controls do **not** apply to this panel. They filter out the scheduler's
entry record, which carries no Result, so they empty or skew the pie. The workflow control scopes it.

### 3.4 Whitelist pies

- **Only `sk-normalizer-sample` looks anything up** (root `chain-artists`). `sk-normalizer-alphabeta`
  is the same processor type but has no whitelist on its branch; the graph can't tell you that, only
  the measurements can.
- **Listed = G, Unlisted = C.** A record that fails before the lookup (triple, at ValidateContent) or
  never reaches the normalizer (badext, corrupt) makes no lookup. So lookups = G + C, not N.
- **Unlisted should equal `sk-normalizer-sample`'s Cancelled bar.** A difference means a cancel with
  another cause, or a lookup whose cancel didn't happen.

### 3.5 Refused messages table

This one is **largely outside the graph**. A refusal happens at the broker or consumer, so no edge
predicts it. The graph only gives the refused message's step its place in the run. It was empty in all
three windows.

## 4. What the graph cannot tell you

- **The input.** N, the mix, and records per fire set every count. The graph only multiplies them.
- **Handler behaviour.** Which step can cancel and why (the artist whitelist in AcmeHandler), that only
  the sample normalizer has a whitelist, and that triple fails before the lookup. These live in the
  handlers, not the step rows (see the header of `publish-diagram.py`).
- **Which definition was running.** The graph is the definition as it is now. A running workflow uses
  its last start's definition, so after an edit the graph can be ahead of the run.
- **What happens on disk.** The persister runs 2G times, but the AlphaBeta branch writes a bare
  `track01.xml` under one shared name. Every board reads correctly while `out/` holds G + 1 files, not
  2G.

## 5. Verification

**This table is RunPosition-era history (before 2026-10-02).** Its "entry" and "terminal" figures use
the old meaning, where terminal counted branch ends, including empty polls. They do not describe the
current StepRole funnel (§3.3), where terminal means a step with no successors returned an outcome.
Only the 2026-10-02 funnel window in §3.3 is stated in current terms.

ES|QL over `logs-generic.otel-default`, scoped to the chain's WorkflowId. Script:
`panel_facts.py`, kept with this session's scratch, not committed.

| window (UTC, 2026-09-30/10-01) | input | prediction | measured |
|---|---|---|---|
| 20:18–20:38, mixed feed, 30s cron | 37 of each role; N 185, G 37, F 111, C 37, E 3 | collapser/persister/exporter 74; sink 111; sample 37/37/37; entry 40; terminal 74+111+37+3 = 225; Listed 37, Unlisted 37 | all exact |
| 20:45–21:40, approved feed, 10s→60s cron | N = G = 500, E 69 | alphabeta 500; collapser/persister/exporter 1000; entry 159; terminal 1000+69 = 1069; Listed 500 | all exact |
| 04:00–05:00, idle, 60s cron | E 60 | importer Cancelled 60; entry 60, terminal 60 | all exact |

RunPosition-era measurement: in the approved window, the old `entry` (159, one per fire's dispatch)
equals the importer's polls (90 with records + 69 empty). The StepRole funnel's entry slice would
instead read records imported + empty polls (§3.3). Every
fire that entered also ran: the backlog seen briefly at the 10s cron had drained by the window's end.

## 6. Consequences for the Analyst

The Analyst reads these panels with no knowledge of the graph. Its run-boundaries description
taught a fixed ratio that does not exist; §3.3 now replaces it with the step funnel. What it needs, for this workflow, is the content
of §1 to §3: the fork, the sink, cancel-ends-in-place, and the formulas. Delivering that is the
subject of the revised spec `docs/superpowers/specs/2026-10-01-analyst-run-boundaries-and-graph-design.md`.
