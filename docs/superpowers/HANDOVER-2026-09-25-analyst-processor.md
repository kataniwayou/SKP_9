# Handover — Processor.Analyst

**Date:** 2026-09-25
**Branch:** `feature/path-importer`
**State:** Tasks 1–15 of 16 complete and reviewed as merge-ready. **Task 16 is unstarted and deliberately so.**
**Head at handover:** `7b2b4fb`. The plan's work starts at `c2cbcda` (exclusive) — 32 commits.
**Suite:** 1533 total / 0 failed / 37 skipped, every skip under `Live/`. Read that *shape*, never a remembered total.

---

## What this is

`Processor.Analyst` is a scheduled processor that does what an operator does when they glance at the
dashboards. It is dispatched with a target `workflowId` and a time window, reads the same Kibana and
Grafana panels a human reads, drives a language model through a five-stage investigation, and either
writes a finding to L2 or says nothing. It reads; in this milestone it cannot modify anything.

**Design:** `docs/superpowers/specs/2026-09-24-analyst-processor-design.md`
**Plan:** `docs/superpowers/plans/2026-09-24-analyst-processor.md`
**Full execution ledger — 34 rulings with reasoning and cost-if-wrong, every parked finding, every
deferred minor:** `.superpowers/sdd/2026-09-24-analyst-processor/progress.md`

**The ledger is the real record. Read it before changing anything in `src/Processor.Analyst/`.** It is
gitignored scratch and will not survive `git clean -fdx`; if it is gone, `git log c2cbcda..HEAD` is the
fallback, but the reasoning is only in the ledger.

---

## The one rule everything turns on

**A step's disposition describes whether the analysis RAN, never what it concluded.**

| Disposition | Meaning | Exports? |
|---|---|---|
| **Completed** | ran, produced a finding worth a human's attention | yes |
| **Cancelled** | ran, found nothing contributing — **silence, which downstream reads as the all-clear** | no |
| **Failed** | could not run | no |

An analysis that finds the system on fire is a *successful* analysis. **The worst failure this design can
have is a monitor reporting all-clear because it broke.** Four separate routes to an unearned Cancelled
were found and closed during execution — two of them in the final whole-branch review. If you change
anything near `Terminate`, `StageAssertions`, or `AnalystProcessor.AnalyseAsync`, that is the property to
protect.

---

## Task 16 — why it stopped, and what it needs

Task 16 is registration and workflow wiring. **Every step is irreversible, outward-facing, or
security-sensitive**, which is why it was not executed without a human decision:

1. **POST two schema rows** (`analyst-config`, `analyst-finding`) — **a referenced schema definition can
   never be edited.** A mistake is a new row, both sides re-pointed, and a restart.
2. **POST the processor registration row** with the SourceHash the built image claims.
3. **Create a Kubernetes Secret** `analyst-model` holding a real Anthropic API key.
4. **Build a two-step monitor workflow** and start it on a cron — which then calls a **paid API**
   unattended, on a schedule.

Post the schema rows **verbatim from the files the tests read**, so the row and the test can never
disagree:
- config ← `src/tests/BaseApi.Tests/Schemas/analyst-config.json`
- finding ← `src/tests/BaseApi.Tests/Schemas/analyst-finding.json`

### Before anything irreversible: one smoke test

**The adapter drops thinking blocks on the round-trip.** `AnthropicAnalystModel.ToReply` discards them and
`ToMessage` reconstructs assistant turns from text + tool_use only. Thinking is on by default on
`claude-opus-5`, and the Messages API requires thinking blocks echoed back unmodified on assistant turns
carrying tool use. If that applies here, **every multi-turn investigation fails on its second model call.**

No offline test can catch this — nothing in the branch has ever completed a real two-turn loop. Verify a
two-turn investigation against the live API **before** POSTing anything that cannot be undone. The failure
is loud (`AnthropicApiException` → `AnalysisImpossibleException` → Failed), not silent, but it would make
the processor inert.

### Current cluster state

Both `processor-analyst` pods are in `CreateContainerConfigError` — sole event `secret "analyst-model" not
found`, repeating. That is **correct**: the Secret is deliberately created out of band. `PodScheduled` and
`Initialized` are true; only `Ready` is false. The image is built and `kind load`ed into cluster `desktop`.

A **rollout timeout is the expected outcome** even once the Secret exists, until registration lands — an
unregistered processor waits rather than crashing (Running/NotReady, 0 restarts, by design).

### Two gotchas that will bite

- **`entryCondition` 4 is `Always`, and every sample step uses it.** Step 2 (KafkaExporter) must gate on
  step 1 having **Completed**. Copying a sample ships a monitor that fires the exporter from a *crashed*
  Analyst step and delivers a confident empty finding. Read the value back after setting it.
- **A workflow needs a cron AND an explicit start.** With neither, the orchestrator logs nothing and the
  whole thing looks broken.
- **`ConfigSchemaConformance` has no opinion on `Guid`** — it cannot catch a wrong JSON *type* on
  `targetWorkflowId` in the posted row. Only publish-time payload validation does. Get that field right by
  hand.

### The iteration loop, once running

**Edit payload → restart the workflow → confirm the `promptHash` in the next finding changed.** A running
workflow reads the L2 projection from its start time, so without the restart the pods keep using the old
prompt while the row shows the new one, silently. The hash is what makes that confirmable.

---

## Load-bearing decisions a future session must not undo

These were each found the hard way. Reversing one silently reopens a closed hole.

- **`AddSingleton<BaseProcessor.Core.Processing.BaseProcessor, AnalystProcessor>()`** — not the concrete
  type. `AddBaseProcessor` deliberately does not register the author's processor. The wrong form ships a
  pod that looks healthy and never processes a dispatch.
- **The trace is assembled by the loop, never supplied by the model.** It is the record of what was
  executed; a model-supplied trace would be a claim. The quiet path (`report_no_finding`) is now grounded
  against it too — fabricated stages with zero panel reads must fail, not cancel.
- **`analysable: false` in `record_validation` is terminal → Failed.** A model that correctly concludes it
  cannot see must not land on silence.
- **Pre-commitment marks are per hypothesis, anchored to first appearance.** A carried-forward hypothesis
  keeps its original mark; one introduced in a re-plan is judged from then. Taking the earliest mark
  globally reopens the hole for new hypotheses.
- **Hypothesis names and disconfirming criteria are compared whitespace-normalised but NOT
  paraphrase-tolerant**, and `ContractPrompt` instructs verbatim restatement to match. **If you edit the
  prompt or the checks, edit both** — a disagreement fails every well-behaved investigation.
- **The panel seam carries the target workflow id.** Without it the monitor reads its own mirror: every
  processor here ships `Service:Name "processor"`, the Analyst included, so the `must_not(orchestrator)`
  clause does not exclude it.
- **`MaxTokenBudget` (10,000,000) is paired with the manifest's 384Mi** and each names the other. Raising
  one alone is wrong. Derivation is in the constant's doc comment.
- **Model id and effort are compiled constants**, never payload — they change the preflight BIT's verdict,
  and the BIT caches on a hash of the prompt alone.
- **The BIT judges; compiled code decides.** The judge may only emit problems, never a pass verdict.

---

## Parked, with reasons (none block merge)

| Item | Why it is parked |
|---|---|
| Eight `Task 9` / `task-3-report.md` references in `InvestigationLoopTests.cs` and `AnalystConfigSchemaTests.cs` | Scratch-directory shorthand that will dangle. Cosmetic; cheap to finish. |
| `RunAsync`'s `panels.Describe` sits outside `PanelUnavailableException` handling | Unreachable — `AnalystProcessor` is the only production caller and validates the panel set first. |
| The two wall-clock hang tests would detect a removed token linkage by **hanging**, not failing | A timeout attribute would turn a wedged suite into a named failure. |
| No processor-level test asserts `FailedException` for the F1 path | The mapping is unconditional and separately covered; the disposition follows by composition. |
| Malformed panel base address throws at DI resolution | A startup crash: loud, immediate, never reaches the loop. |
| Panel payloads enter the transcript untruncated | `MaxTokenBudget` bounds the total. Capping is an evidence-fidelity decision — it belongs with the scored-window work, where its effect on findings can be measured. |
| `NoDataDistinguishable` collapses to `SeriesPresent` on Prometheus | Genuinely unfixable from one `query_range`; documented on the type and in every ops panel description. |
| `seriesCount` cannot detect an entirely absent replica | Same reason. It is a floor, not a census, and the descriptions say so. |

---

## Environmental: the suite can silently under-report

**Three background commands were killed for low system memory during the session that built this.** On a
loaded machine, the test host can lose results for the batch in flight and Microsoft Testing Platform
surfaces them as `NotExecuted` — a test that never ran, reported as a skip. One run skipped a plain `[Fact]`
with no skip condition.

Four consecutive runs on a quiet machine produced byte-identical skip sets, all under `Live/`. **So a green
run taken under memory pressure is not trustworthy evidence.** If skip membership looks odd, check the
machine before suspecting the code.

Other repo facts worth having: `dotnet test` **silently ignores `--filter`** under MTP and reports counts
only — run `src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe` directly for names. Restore is
**offline**: `NuGet.config` clears nuget.org, so any new package must be vendored into `nugets/` with its
full transitive closure or the Docker build fails.

---

## Not built, by design

- **The scored-window replay set** (design §16.3). A held-aside set of recorded windows with known answers,
  served through the fixture `IPanelReader`, replayed offline against a candidate prompt. Without it,
  prompt iteration is guesswork — and design §9.5 makes it a prerequisite for trusting the on-prem
  `kimi-2.5` backend, since a prompt that passes its BIT on both models is not thereby equally good on both.
  The seam exists and is used throughout the tests.
- **The on-prem `kimi-2.5` adapter.** `IAnalystModel` was built for it and the Anthropic adapter proves the
  seam holds. Nothing Anthropic-only is load-bearing: budgets are loop-enforced, tool inputs are validated
  client-side.
- **Destructive capability and its whitelist.** Tools are the unit of capability, so adding it later means
  registering more tools rather than retrofitting a policy layer.
