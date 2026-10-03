# The Analyst as operator -- design

Date: 2026-10-03. Branch: `feature/path-importer`. Status: draft for review.

## 1. Why

The Analyst replaces the operator. Its job is to hand the operator the **key insight that calls for
intervention**, not only to say whether components work.

Today it cannot. On 2026-10-03 07:25Z it judged a window **Quiet** in which 80% of imported items
were rejected (24 failed, 8 cancelled, 8 delivered of 40). Every failure named the item itself, and
prompt v13 says such a failure "is not a fault" and that a count the routing explains "is expected
however large it is". The window held a deterministic raw-data problem -- a provider sending bad
files -- and the report said nothing. (On dev that rate is the endless feed's design, which is
exactly what a declared expectation, section 4.5, is for.)

## 2. What the user decided (2026-10-03)

| # | Decision |
|---|---|
| U1 | The Analyst replaces the operator. Operational and realistic behaviour is in scope: input health and trends, not only system faults. |
| U2 | Not every failure is notable, but a trend is suspicious. |
| U3 | Every suspected anomaly is classified **deterministic** or **transient**. |
| U4 | A deterministic problem -- system (code, configuration, infrastructure) or raw data (a provider's input) -- demands operator intervention and is reported with the key insight. |
| U5 | A transient problem is reported too, at lower severity. It is never suppressed or folded into Quiet. |
| U6 | The line between the two depends on the time window, so classification needs several independent kinds of evidence. |
| U7 | For now transient is classified by the **nature** of the problem; proving it by recurrence can need history beyond one workflow run. |
| U8 | The agent may query back as far as the workflow's **current start**, and no further, for every panel (Elasticsearch and Prometheus alike). Using history is optional. |
| U9 | History is used **on demand**, when a problem appears; the agent must know the limit up front. |
| U10 | The start is found in Elasticsearch logs. |
| U11 | The graph is understood in layers by entry condition (Completed / Failed / Cancelled), e.g. that every work step sends Failed to one recorder that exports to a topic. Not every workflow has such a sink. |

## 3. Decisions taken in this spec (override in review)

| # | Decision | Why |
|---|---|---|
| D1 | **"Normal" is declared, not learned.** An optional `expectations` object in the Analyst step payload states what a workflow is allowed to do (section 4.5). Without one, any deterministic problem is reported. No learned baseline in this iteration. | A learned baseline makes a source that was always bad look normal, and needs cross-run history (U7). A declared value is explicit, per workflow, and testable. |
| D2 | **Verdicts keep their four names and gain a fixed meaning:** Notable = at least one deterministic problem; Drifting = only transient problems; Quiet = no problem, or only what the declared expectations allow; Inconclusive = the evidence cannot decide. | Reuses the existing enum (Drifting has no producer today), so readers of the topic keep working. |
| D3 | **Each insight carries its classification**: `classification` (deterministic / transient), `domain` (system / data), `severity` (high / low, derived from classification), `onset` (first seen within the history limit, or "since start"). This needs a new finding schema row (v4). | Schema rows are frozen; severity cannot ride inside free text. |
| D4 | **The run start is resolved by the processor, not the model**, before the loop, and stated in the first message. | U9: the limit must be known up front, and a turn spent finding it is wasted. |
| D5 | **The graph's layers are computed in code**, like the routing today. | A misread entry condition corrupts every expectation built on it (the reason `GraphRenderer` exists). |

## 4. Design

### 4.1 Run context in the first message

`AnalystProcessor` already renders the running graph into the first message. It gains a second
block, `<run-context>`, built by a new `IRunContextSource` (Elasticsearch-backed):

- **Start:** the latest BaseApi record `accepted start for workflow {WorkflowId}` for the target,
  with no later `accepted stop`. Not the orchestrator's `activated workflow` record: it is also
  written on every orchestrator pod restart (on 2026-10-02 at 14:14, 17:52 and 22:43, none of them
  starts).
- **History limit:** `max(start, now - 30 days)` (`AnalystProcessor.MaxWindow`). If no start is
  found within retention, the limit is unknown and history is unavailable (below): reaching back to
  the earliest data held could cross the real start (U8).
- **Deploy markers:** orchestrator `activated workflow {id}` records after the start, by minute.
  Code -- and the meaning of a counter -- can change inside one run (StepRole `terminal` changed at
  22:43 on 2026-10-02); a cause that appears or vanishes at a marker points to the deploy.

Example:

```
<run-context>
Window under judgement: 07:10:00Z to 07:25:00Z.
History available back to 2026-10-02 12:51:47Z (the workflow's current start). Nothing before it
was produced by this projection; queries are clamped to it.
Deploys inside that range (orchestrator restarts): 14:14Z, 17:52Z, 22:43Z.
</run-context>
```

A failure to resolve the start is not a failed dispatch: the block says "history unavailable" and
history reads are refused, so the investigation degrades to window-only, as today.

### 4.2 Graph layers in the briefing

`GraphRenderer` gains a **Layers** section after the routing table, computed from entry conditions:

- **Per result** (Completed, Failed, Cancelled): the steps that result moves through, and where it
  ends.
- **Handlers:** steps entered on Failed or Cancelled (condition 2 or 3), each with its fan-in (the
  steps that route that result to it) and where the handler's own path ends.
- **Unhandled results:** results that end at a step with no taker -- including a handler's own
  failure (on the chain, `record-outcome` Failed and `export-outcome` Failed end with nothing to
  catch them).
- **Conservation equations** the agent must check, generated from the layers, e.g.
  `Σ Failed(8 work steps) = outcomes(record-outcome) = outcomes(export-outcome)`.

For the chain that reads: one failure sink, `record-outcome`, fan-in 8, exporting through
`export-outcome`; cancellations unhandled everywhere. A workflow without a handler shows an empty
Failed layer, and the briefing says that failures there are recorded only in logs.

### 4.3 History reads

`read_panel` gains an optional `from` (ISO-8601). Without it the reading covers the window, as
today. With it:

- the range is `[max(from, history limit), window end]` -- clamped in code, and the reading states
  the range actually served;
- the trace records the range, so a reader can tell a window read from a history read;
- the criterion-ordering rule (`StageAssertions`) treats any read of a panel, window or history, as
  reading that panel.

Range-dependent shape, so a since-start read fits the token budget:

| Range | Elasticsearch panels | Prometheus panels |
|---|---|---|
| window | as today | as today |
| history | totals plus a **bucketed series** with at most 48 buckets (bucket = range / 48, rounded up to a whole minute) | `step` chosen so each series has at most 48 points (`PrometheusPanelSource` already caps points) |

### 4.4 New panel: `failure-causes`

Elasticsearch, scoped to the workflow. For the requested range:

- **Per cause:** step, how it was logged (`author-reported` = "the author reported the step
  failed", `faulted` = "the transform faulted", `other`), the cause text normalised (paths, file
  names, ids, numbers and GUIDs replaced by placeholders), count, first seen, last seen.
- **Per bucket:** items imported, failed, cancelled, and the failed share.
- The panel's trust follows the other Elastic panels (scope count; zero = untrusted).

It answers what `step-failures` cannot: the mix of causes (five samples cannot prove it), their
persistence and onset, and the rejection share over time.

### 4.5 Declared expectations

Optional `expectations` in the Analyst step payload (new config schema row):

```json
"expectations": {
  "maxFailedShare": 0.65,
  "maxCancelledShare": 0.25,
  "reason": "dev endless feed: 3 of every 5 files are built to fail, 1 to be cancelled"
}
```

The shares count **data-domain** outcomes only (section 4.6): failures and cancellations whose cause
names the item. A deterministic data problem whose share stays within the declared maximum is not an
insight; the Quiet reason names the expectation that covered it. Exceeding it, or a new cause
appearing, is reported. System problems are never covered by an expectation.

### 4.6 Classification and verdict

**Evidence kinds.** An insight must cite at least two different kinds:

| Kind | Deterministic | Transient |
|---|---|---|
| Nature of the cause (U7, decisive when clear) | names the item or its configuration: extension, bytes, schema, a rule that rejects it; a code defect (null reference, invalid state) | infrastructure: timeout, connection refused or reset, store or broker unavailable, a dropped response |
| How it was logged | `author-reported` | `faulted` with an infrastructure exception |
| Persistence and onset (within the history limit) | present across buckets, since the start or since a deploy marker | a burst that stopped |
| Mix | proportions fixed across buckets | one cause spiking |
| Retry and delivery | the same kind fails the same way every time | not-parked refusals, redeliveries |
| Scope | every replica, every item of a kind | one replica or pod |
| Coincidence | none | lines up with a restart, liveness drop or deploy marker |
| Conservation through the layers | handlers balance, so the problem is upstream | a handler's counts do not balance: the handling layer itself is failing |

**Domain:** `data` when the cause names the item; `system` otherwise.

**Severity:** high for deterministic, low for transient.

**Verdict (D2):** Notable if any insight is deterministic; else Drifting if any is transient; else
Quiet (with the expectation that covered anything seen); Inconclusive when the readings are in
cases (c)-(f) of stage 2 and no classification can be made.

A trend (U2) -- a share rising across buckets, or a new cause appearing after the start -- is an
anomaly to classify by the same table, never a verdict on its own.

### 4.7 Prompt v14 and the compiled primer

- Stage 1 adds a third task: read the run context and the layers; note the history limit, the
  deploy markers and the conservation equations.
- Stage 3 always plans, in addition to the four existing hypotheses: **deterministic data
  problem** (killed if no failure names the item beyond the declared expectations) and **the
  failure handling is losing failures** (killed if every conservation equation balances).
- Stage 4 may use history reads, only for a hypothesis a window reading has made suspicious.
- Stage 5 classifies every surviving anomaly by section 4.6, states domain, severity, onset and the
  evidence kinds, and picks the verdict by D2.
- The text "a count the routing explains is expected however large it is" is replaced: a count the
  routing explains is not a *routing* fault, but an item-caused rate is judged against the declared
  expectations.

### 4.8 Finding schema v4

Each insight gains `classification`, `domain`, `severity`, `onset` (required) and `evidenceKinds`
(at least two). A new schema row, with both sides of the Analyst -> KafkaExporter edge repointed as
the frozen-schema rule requires. **Risk to check in planning:** edges match by schema row id, and
three schema rows serve five processors -- confirm that repointing the Analyst's output cannot break
another published workflow.

### 4.9 The BIT

The exam and the rehearsal are compiled into the Analyst and must test this role, or a prompt that
cannot do it will be cached as fit:

- **Exam:** the scenario adds a provider sending bad files with no declared expectation, and the
  fit answer reports it as a deterministic data problem.
- **Rehearsal**, three scenarios, cheapest first:
  1. quiet: the test-feed mix **with** its declared expectation -- must be Quiet;
  2. planted loss (as today) -- must be Notable, deterministic, system;
  3. the same rejections **without** an expectation, present since the start -- must be Notable,
     deterministic, data.
- `RehearsalPanels` serves `failure-causes` and history reads; `RehearsalGraph` gets a run context.

Transient classification is covered by hermetic tests and replay windows (section 6), not the
rehearsal: a rehearsal per scenario is a full paid investigation.

## 5. What does not change

- The five stages, the criterion-ordering rule and the closed panel enum.
- The orchestrator, the StepRole edges and the existing panels' window behaviour.
- No cross-run history and no learned baseline (U7, D1).
- No alerting channel: the finding still goes to `skp-analyst-findings`.

## 6. Testing

- **Hermetic:** run-start resolution (latest start, stop after start, orchestrator re-activations
  ignored, none in retention); layer computation on the chain's captured graph and on a graph with
  no handler; history clamping and the 48-bucket cap; cause normalisation; verdict mapping;
  expectation coverage; schema v4 validation.
- **Fixtures:** `RehearsalFixtureTests` extended to the new panel and the three scenarios.
- **Replay:** capture windows with history (test feed with and without an expectation; a transient
  window made by a Redis `CLIENT PAUSE` or a scaled-down processor) and score v14 against answer
  keys.
- **Live:** `AnalystBitLiveTests` against v14 before switching the deployed prompt.

## 7. Delivery order

Each step is deployable on its own:

1. Run context and graph layers in the briefing (no prompt change needed to ship them).
2. History reads and the `failure-causes` panel.
3. Declared expectations, finding schema v4, prompt v14 and the BIT -- together, because the BIT
   must test the prompt it gates.

## 8. Open risks

- **Token cost** of history reads: bounded by the 48-bucket cap and on-demand use; to measure on
  replay before step 3 ships.
- **Retention:** Elasticsearch and Prometheus retention may end before a long run's start; the
  reading must state its real range.
- **Classification by nature is a judgement.** A cause text that names neither the item nor
  infrastructure is classified by the remaining evidence kinds, or reported Inconclusive.
