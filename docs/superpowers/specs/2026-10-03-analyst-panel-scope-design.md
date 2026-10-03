# The Analyst reads each panel's scope -- design

Date: 2026-10-03. Status: draft for review. Branch: `feature/path-importer`.

## 1. Problem

On 2026-10-03 the deployed Analyst published a **false high-severity finding**. It was Kafka
`skp-analyst-findings` offset 58, window 14:58:00-15:13:00Z, Notable, *deterministic / system /
high*: "run-boundaries is under-recording the workflow's terminal outcomes". It expected 130
`split-exporter` (S10) and 45 `export-outcome` (S5) terminal records, and saw 126 and 39.

A check in Elasticsearch found no loss. Over the 15 fires that entered the window, followed to
completion with no end cut:

| | routing predicts | ES holds |
|---|---|---|
| items imported | -- | 120 |
| failed (13 each at filefetcher, archiveexpander, normalizer-sample) | -- | 39 |
| cancelled | -- | 13 |
| S10 terminal | 2 x (120 - 39 - 13) = 136 | 136 |
| S3 `record-outcome` | 39 | 39 |
| S5 terminal | 39 | 39 |

Both gaps come from the edges of the window:

- **End edge.** Fire `1c4af708...` entered at 15:13:00.017Z, 22 ms before the window closed. Its 10
  S10 terminals landed by 15:13:00.782Z. `run-boundaries` counts the fire but drops its terminal
  records, because they are stamped after the window end. 126 + 10 = 136.
- **Start edge.** The model took its 45 failures from `step-outcomes` and `failure-causes`. Both
  count every record stamped in the window, including records of fires that entered before 14:58.
  `run-boundaries` excludes those fires. For the fires it does count, 39 failures map to 39 S5
  terminals.

At a steady feed the two edges roughly cancel, and offset 57, an hour earlier, correctly called a
similar gap "the last fire still in flight". Here the feed mix changed six minutes before the window
end: the endless feed stopped at 15:06 and the approved feed started. The edges no longer cancelled.

The panels are not wrong. **The Analyst did arithmetic across two panels without knowing that
they count different sets of records.** It then classified the gap as deterministic although
its own `onset` field says "earlier onset not established".

## 2. Principle (decided)

**Panels keep their own scopes.** Each answers its own question, as the operator's boards do. For
example, `step-outcomes` asks what happened in these 15 minutes, while `run-boundaries` asks what
the fires that started in these 15 minutes did. Aligning them to one scope would remove distinctions
an operator relies on, and the next panel added would differ again. So the Analyst must know each
panel's scope and reason across scopes correctly.

Consequences:

- No panel query changes. The Kibana counterparts are untouched, and the maintenance rule in
  `PanelRegistry` is unaffected.
- The fix lives in what the model is told (panel descriptions and the primer) and in what the BIT
  checks (a new rehearsal).
- "Prefer duplicate over missing" still holds. A gap larger than the edges can explain is still
  reported. Only a gap the edges fully explain stops being evidence of loss.

## 3. Design

### D1. Every panel states its scope, in one fixed form

Each `PanelDefinition.Description` gains a scope sentence. It always takes the same three-part form,
so the model can line two panels up:

> **Scope:** *what is counted* (records, fires, series, a level) / *how time selects it* (stamped
> in the window; entered in the window; sampled at an instant; rate over a trailing interval) /
> *what that does at the edges*.

The audit below covers today's wording. All 11 panels get the sentence; the gaps are the reason for
this design.

| panel | counts | time selection | edge behaviour today's text omits |
|---|---|---|---|
| step-outcomes | outcome records, any fire | stamped in window | includes records of fires that entered before the window; excludes records after the end, even for fires that entered inside |
| step-failures | Failed records + 5 samples, any fire | stamped in window | same as step-outcomes |
| failure-causes | Failed records by cause; per-bucket imported, failed and cancelled | stamped in range | a bucket's failures can belong to items imported in an earlier bucket (half stated today) |
| run-boundaries | fires that **entered** in window; their entry and terminal records | entry in window **and** each record stamped in window | drops terminal records stamped after the end, for fires that entered inside; never sees fires that entered before |
| refused-messages | refusal events | stamped in window | stated (events, not a level) |
| dead-letter-depth | queue depth | a level at each sample | stated (a level, not in-window events) |
| queue-wait, produce-duration, consumer-duration-mean | means per replica | rate over a trailing 60 s at each step | the first minute of a window includes pre-window traffic |
| processor-liveness | ready ratio per replica | the trailing 40 s at each step | the first 40 s include pre-window state |

### D2. The primer teaches arithmetic across scopes

Add one rule to `ContractPrompt.FrameworkPrimer`, after the `run-boundaries` and `step-outcomes`
rules:

- A count from one panel predicts a count on another only when both cover the same fires.
  `step-outcomes`, `step-failures` and `failure-causes` count records stamped in the window;
  `run-boundaries` counts fires that entered in it. Their difference includes an **edge
  residue**: work from fires that entered before the window, and terminal records of fires still
  running at its end.
- The residue is bounded by about one fire's work at each edge. Estimate that from
  `recordsImported / fires` and the routing; for example, two S10 records per successful item.
- A conservation gap within that bound, with no corroboration, is the residue and not a finding.
  Corroboration means dead-letter growth, parked refusals, or a gap that persists.
- A gap beyond the bound, or one that is corroborated, is evidence of loss and is reported.
- The window end needs most care: the last fire is often still running when the window closes.

The Layers `Check:` lines from `GraphRenderer` stay as they are. They state what must balance for
whole fires. The new rule says which panels can be set against them, and with what allowance.

### D3. A gap is deterministic only with persistence

Extend the classification rule. A conservation gap may be classified deterministic only when a
history read shows it recurs. The test: read `run-boundaries` and `step-outcomes` again with
`from`. The edge residue stays about one fire per edge however long the range, while a real
accounting loss grows with the range. With no history available (no workflow start in the run
context), an uncorroborated gap within the bound cannot be deterministic.

This only enforces the rule the v14 contract already has, that persistence is the evidence for
deterministic. The offset-58 finding skipped it, as its own onset field admits.

### D4. A fourth rehearsal: the window edges do not cancel

Add `RehearsalPanels.EdgeSkewed()`, a healthy window whose edges do not cancel. Built on the same
`RehearsalGraph` and per-step ledger:

- A pre-window fire contributes failure-path records to the stamped-in-window panels
  (`step-outcomes`, `failure-causes` buckets, `step-failures`) but not to `run-boundaries`.
- The last fire enters before the window end. Its exit records fall after the end, so
  `run-boundaries` terminal is short by that fire's exit records.
- The feed mix changes mid-window, so the two residues point the same way and do not cancel.
- There is no loss: no dead-letter growth and no refusals. Declared expectations cover the
  item-caused failures.

Expected conclusion: **no finding** (Quiet). A finding with any deterministic insight fails the BIT,
with a message saying the gap was the window edge.

Constraints:

1. **The fixture's history read must stay consistent.** A history read of a window-only fixture
   panel is currently answered with the window (the parked finding "the rehearsal's served-range
   label for window-only panels"). Here a prompt following D3 *will* read `run-boundaries` and
   `step-outcomes` with `from`. The fixture must serve the widened range so the residue stays at
   one fire per edge. Otherwise a prompt that reasons correctly fails, which is the same trap the
   fixture rules already warn about.
2. **The loss rehearsal must still fail an over-lenient prompt.** `HoldingDiscardedWork` loses 17
   items against about 2.7 items per fire, with dead-letter growth and 17 parked refusals. That is
   far past the bound, and corroborated. A prompt that calls it residue still fails there. Together
   the two scenarios fence the rule from both sides.
3. `RehearsalFixtureTests` walks the new ledger against the graph. Every residue must be one the
   stated edges produce.

Order and cost: quiet, then edge-skew, then loss, then bad input. Edge-skew goes second because it
is a cheap rejection of the most expensive real failure mode, a false page. This adds one
investigation to a full BIT, about 5-8 minutes and roughly 0.3-0.5M tokens. That is within the
rehearsal's 1200 s cap per scenario.

## 4. Considered and rejected

- **Align the panels to one set of fires** (a closed-fire statement in `run-boundaries`). Rejected
  by the principle in §2: it removes scopes an operator relies on, and the next panel differs again.
- **A grace period on `run-boundaries` terminal records only.** It fixes the end edge (126 -> 136)
  and leaves the start edge (45 vs 39). It also changes a panel query and its Kibana counterpart.
- **Primer wording without a rehearsal.** The model already argued past the in-flight explanation
  once. Without a BIT scenario nothing detects a prompt that does it again.
- **Deferred: expose edge facts on `run-boundaries`**, such as the latest entry time, items imported
  by the last fire, and records of fires that entered before the window. It would make the bound
  exact rather than estimated. Revisit if D2's estimate proves too loose in replays.

## 5. Rollout

1. Code: panel descriptions (D1), primer rule (D2, D3), rehearsal scenario and grading (D4), tests.
2. The payload prompt (v14) is unchanged unless review finds it contradicts D2. The primer is
   compiled, so the rebuild moves the SourceHash and the next dispatch pays a full BIT.
3. Rebuild, `kind load`, repoint the `analyst` row, roll out, and fire once with the declared
   expectations.
4. Docs: the runbook hash, the offline note, and memory.

## 6. Acceptance

- Unit tests: every panel description carries a `Scope:` sentence; the `EdgeSkewed` ledger walks
  against the graph; grading fails a deterministic finding on edge-skew and passes no finding.
- **Replay of the offset-58 window** (14:58-15:13Z), captured with `AnalystReplayCapture`, concludes
  Quiet. Capture it before implementation starts, so it is a regression case and not a
  reconstruction. Replays of the offset-56 (Quiet) and offset-57 (Notable, data) windows keep their
  conclusions.
- A live BIT on dev passes all four scenarios.

## 7. Open questions for review

1. Should the Kibana panels carry the same scope sentence in their descriptions, so the operator and
   the Analyst read the same caveat? This changes no query. Recommended: yes.
2. Edge-skew's expected verdict is Quiet with declared expectations. Should a second variant without
   expectations (expected: Notable, *data* only, never *system*) be added, or is that already covered
   by the bad-input scenario? Recommended: covered; do not add.
3. The replay captures and scoring were never approved in the operator-role plan. This spec's
   acceptance relies on three replays. Approve them for this work?
