# Handover — Processor.Analyst

**Date:** 2026-09-25
**Branch:** `feature/path-importer`
**State:** The Anthropic → Kimi K3 backend swap is complete (6 of 6 tasks, reviewed). Registration and
workflow wiring — the prior handover's "Task 16" — is **still unstarted**, and for a different reason now
(see below).
**Head at handover:** `fa4a8f1`. This backend-swap plan's work starts at `0ed5649` (exclusive, the prior
handover commit) — 13 commits.
**Suite:** 1549 total / 0 failed / 1512 succeeded / 37 skipped, every skip under `Live/`. Confirmed by
running `src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe` directly on a quiet machine. Read
that *shape*, never a remembered total.

---

## What this is

`Processor.Analyst` is a scheduled processor that does what an operator does when they glance at the
dashboards. It is dispatched with a target `workflowId` and a time window, reads the same Kibana and
Grafana panels a human reads, drives a language model through a five-stage investigation, and either
writes a finding to L2 or says nothing. It reads; in this milestone it cannot modify anything.

**Current design (the backend swap):** `docs/superpowers/specs/2026-09-25-analyst-kimi-k3-backend-design.md`
**Current plan:** `docs/superpowers/plans/2026-09-25-analyst-kimi-k3-backend.md`
**The full argument behind §9.2's amendment, the env-var-only condition, and the `reasoning_effort`
default lives in the tracked source, not scratch:** `src/Processor.Analyst/Model/AnalystModelOptions.cs`
carries it in the class comment and on each property. The ledger below is the secondary reference — it
predates that comment being written out in full and will not survive `git clean -fdx`.
**Its ledger — the rulings behind every backend-swap decision:**
`.superpowers/sdd/2026-09-25-analyst-kimi-k3-backend/progress.md`

**Prior design (everything the swap did not touch — the loop, the BIT, the five stage tools, disposition
rules):** `docs/superpowers/specs/2026-09-24-analyst-processor-design.md`, plan
`docs/superpowers/plans/2026-09-24-analyst-processor.md`, ledger
`.superpowers/sdd/2026-09-24-analyst-processor/progress.md`.

**Both ledgers are the real record. Read the relevant one before changing anything in
`src/Processor.Analyst/`.** They are gitignored scratch and will not survive `git clean -fdx`; if either is
gone, `git log 0ed5649..HEAD` (this swap) or `git log c2cbcda..0ed5649` (the original build) is the
fallback, but the reasoning is only in the ledgers.

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
were found and closed during the original build (two of them in the final whole-branch review), and this
swap re-verified the property holds for the new backend: `KimiAnalystModel` maps every transport and HTTP
fault to `AnalysisImpossibleException`, most-specific-first, which is disposition-critical — it becomes
`Failed`, never a quiet Cancelled. If you change anything near `Terminate`, `StageAssertions`,
`AnalystProcessor.AnalyseAsync`, or `KimiAnalystModel`'s error translation, that is the property to
protect.

---

## The backend: Kimi K3 over a plain `HttpClient`

The Anthropic adapter is **deleted**, not retained behind a switch — `Model/AnthropicAnalystModel.cs` and
its tests are gone, the `Anthropic` NuGet package is removed from `Directory.Packages.props` and the
offline `nugets/` store. `Model/KimiAnalystModel.cs` is the one implementation of `IAnalystModel`.

**Backend:** `kimi-k3` at `https://api.moonshot.ai/v1`, reached over a plain `HttpClient` +
`System.Text.Json` — deliberately **not** a client library (not the `openai-dotnet` SDK, not any
Anthropic-style SDK). The endpoint returns a non-standard `reasoning_content` field on assistant turns
that must be replayed unchanged on every later call, and holding the raw JSON — rather than a typed
model that only round-trips the fields it knows about — is what guarantees that field survives. See spec
§4 for the full transport tradeoff (multi-model support is explicitly out of scope, which is what tips the
decision away from a client library).

### Four environment variables, deployment-supplied

| Variable | Value |
|---|---|
| `Analyst__Model__ApiKey` | the Moonshot key |
| `Analyst__Model__BaseUrl` | `https://api.moonshot.ai/v1` |
| `Analyst__Model__ModelId` | `kimi-k3` |
| `Analyst__Model__ReasoningEffort` | `high` |

**These must remain environment variables, never a reloadable ConfigMap file.** Model id and effort both
change the preflight BIT's verdict, and `PreflightBit` caches on a hash of the prompt alone — so something
must guarantee a changed value can never meet a warm cache. Environment variables freeze at container
start: editing one in the Deployment rolls the pods, and `BitCache` is per-replica, in memory, and dies
with the process it lived in. A live file swap under a mounted ConfigMap would break this silently — the
process would keep answering from a verdict earned on the old model or effort. `AnalystModelOptions` is
bound via `IOptions<T>` (a snapshot, not `IOptionsMonitor`), and that is intentional; it must stay that way.
This is an amendment to the prior design's §9.2 (which compiled these values as constants for the same
reason) — the ruling and its reasoning are recorded in the current ledger, not restated here to avoid a
second, possibly-diverging account.

**`reasoning_effort` is set explicitly to `high`.** The endpoint defaults to `max` — the most expensive
setting — and reasoning tokens bill as output at $15/MTok on what will eventually be an unattended cron.
Never let a future change silently inherit the default; if it needs to move, the scored-window replay set
(below) is what should justify the move, not a hunch.

**A hazard that no longer exists:** the prior design's §9.3 documented an Opus 5 trap — with thinking
disabled, the model occasionally wrote a tool call into visible text that never ran, and the loop believed
it had read a panel it had not. K3 cannot disable thinking, so this failure mode is structurally
impossible on this backend. `InvestigationLoopTests.cs:290` was updated to say so instead of citing Opus 5.

### The API key: inline, no Kubernetes Secret

The key is a plain value in `src/Processor.Analyst/appsettings.json` and
`k8s/43-processor-analyst.yaml`, **not** a Kubernetes Secret. This was the user's explicit decision, made
after being shown the consequence: both files are tracked, so the key enters git history permanently and
**rotating it is a commit, not a `kubectl` command**. It was reaffirmed on the reasoning "no secret - the
api key same threat as `Analyst__Model__ModelId`" — the same argument that already applied to the other
three coordinates.

**Rotation is no longer a `kubectl` operation on all three fronts.** The key is baked into the image
layer from `appsettings.json`, so a rotation now has to touch `appsettings.json`, the manifest
(`k8s/43-processor-analyst.yaml`), **and a rebuilt image** — editing the manifest alone leaves the image's
own copy stale. Pod-read RBAC also now exposes the key where secret-read RBAC used to be the boundary:
anyone who can `kubectl exec` or read the pod spec can read it, which is a wider surface than the old
Secret-scoped RBAC.

**The current key is a dead placeholder, not a live credential to protect urgently.** Its account is
creditless — spent down to connectivity and minimal-functionality checks before this task started — and
separately the key was pasted into a chat transcript, so it must be treated as compromised regardless of
the no-Secret decision. Both facts make the git-history exposure currently theoretical. **The accepted
tradeoff only bites for real the moment someone funds the account and a live key lands in a tracked
file — that is the moment to revisit this decision, not before.**

### The load-bearing property: verbatim replay

An assistant turn is replayed **verbatim** from the provider's raw JSON, via `ModelToolCall.ProviderEcho`
— never rebuilt from `content` + `tool_calls`. The loop copies `ModelReply.ToolCalls` into the transcript
unchanged and copies nothing else out of a reply, which is why the echo rides on a tool call: it
round-trips without the loop ever learning anything about "thinking" or "reasoning". Nothing above
`IAnalystModel` may gain such a notion — see the interface's own doc comment.

**Rebuilding drops `reasoning_content` and fails every investigation on its second model call, while
every offline test passes**, because turn 1 replays nothing and no offline test completes a real two-turn
loop. This exact defect shipped once before, on the Anthropic adapter, dropping signed thinking blocks the
same way — found by reading the vendor's own documented loop, not by any test (Ruling 35, prior ledger).

The guarding test — `AnAssistantTurnReplaysItsProviderEchoVerbatimRatherThanRebuildingIt` — was
**red-checked twice**: once by the implementer (disabled the replay guard, confirmed exactly that test
failed 13/14, restored it, confirmed 14/14), and independently by the controller, who both re-ran the
red-check itself and separately grepped the committed source to confirm no disabled-guard artifact had
leaked into the commit. A green test against a reconstructing adapter would have been worthless; this is
the one property no offline test would otherwise reach.

### The seam, and why it still exists

`IAnalystModel` now has exactly one implementation. Its justification has narrowed and changed: it is no
longer "the only thing that makes one binary shippable to both the connected cluster and the air-gapped
machine" (see "What is still not done" below — that claim is no longer true). It is now justified purely as **the test
seam** — the investigation loop, the preflight BIT and every disposition rule are exercised against a stub
implementation, which is why the large majority of the suite passed untouched by this swap — plus the
boundary a future model change is contained to. Multi-model support is explicitly out of scope by decision.
See `Model/IAnalystModel.cs`'s doc comment, which was rewritten to say this rather than the now-false claim
it used to carry.

---

## What is still not done

Two items must not disappear into "shipped":

1. **The live two-turn smoke test has never run.** Nothing offline can prove the verbatim-replay
   requirement (above) holds against the real endpoint — that is the whole lesson of the defect it
   guards against. It has a second reason to be outstanding right now: **the account is creditless.**
   That is not purely bad news — a creditless key fails **loudly**: a non-2xx response trips
   `!IsSuccessStatusCode` → `AnalysisImpossibleException` → `Failed`. A quota rejection is therefore the
   cheapest available proof that the failure path reaches `Failed` rather than silence, and is worth
   running deliberately at smoke-test time for exactly that reason — even before the account is funded.
2. **The scored-window replay set (prior design §16.3) is still a prerequisite, not a nicety.** The prior
   design's §9.5, cited in the current spec's §9, holds that a prompt passing its BIT on two models is not thereby equally good on both, and this work
   changed the model. Without the replay set, prompt iteration against K3 is guesswork, and **no finding
   it produces can be justified as trustworthy** until it exists. Candidate windows already named in the
   spec: the 210s queue-wait cycle, the publisher-confirm double-count, a dead port-forward reading as an
   outage, and a stopped load generator whose flat line meant nothing.

Also carried forward, unchanged by this work:

- **The air-gapped machine is not served by this design**, and that is a deliberate governance decision,
  not an oversight. `api.moonshot.ai` is a hosted, third-party endpoint; panel payloads are raw
  Elasticsearch and Prometheus operational telemetry and they leave the org when sent to it. Serving the
  offline case would mean self-hosting K3's open weights, which at 2.8T parameters is an infrastructure
  programme, not a deployment step. If the offline case is still wanted, it is separate work.
- **The `ship/` offline-baseline drop was deliberately not advanced by this task, and that is not an
  oversight either.** `ship/` exists to carry changes to the air-gapped machine, and per the point above
  this design does not target that machine at all — there is nothing meaningful to ship there. `ship/`
  also does not exist in this working tree (it is untracked by design, never aligned to a commit), so
  running `tools/ship-delta.ps1` against an absent baseline would have staged the entire curated scope as
  a "delta" rather than produce a real diff. If the offline case becomes real work later, it needs its own
  drop — the adapter cannot reach `api.moonshot.ai` from that machine regardless of what ships.
- **The offline Elasticsearch/Kibana version gap (9.3.4 there vs. 8.15.5 in dev) is out of scope for the
  same reason** — irrelevant to a connected-cluster deployment, blocking only for an offline one that this
  design does not serve.

### Registration and workflow wiring — still where the prior handover left it

The prior handover's "Task 16" (POST the two schema rows, POST the processor registration row, wire a
cron workflow) has not moved. One of its four original steps has changed:

- ~~Create a Kubernetes Secret `analyst-model` holding a real API key~~ — **superseded.** There is no
  Secret in this design; the key is one of the four inline environment variables above. Do not create one.
- The other three steps — POST the two schema rows verbatim from
  `src/tests/BaseApi.Tests/Schemas/analyst-config.json` and `analyst-finding.json`, POST the processor
  registration row with the built image's SourceHash, and build/start a two-step cron workflow — are
  unchanged and still outstanding. See the prior design's plan for the two gotchas that will bite
  (`entryCondition` 4 is `Always` and every sample step uses it; a workflow needs a cron *and* an explicit
  start) and the iteration loop once running (edit payload → restart the workflow → confirm the
  `promptHash` changed).

**Current cluster state, verified by `kubectl` at handover time:** both `processor-analyst` pods are
`CreateContainerConfigError`, sole event `secret "analyst-model" not found`, ~18h old. That is the deployed
manifest from *before* this swap's commit `fa4a8f1` — the running cluster has not had the new manifest
(the one with no `secretKeyRef`, inline env vars) applied yet. Re-applying `k8s/43-processor-analyst.yaml`
is expected to move the pods past this specific error into the Running/NotReady state described next.
Once applied, **a rollout timeout is the expected outcome** until registration lands — an unregistered
processor waits rather than crashing (Running/NotReady, 0 restarts, by design).

---

## Load-bearing decisions a future session must not undo

These were each found the hard way. Reversing one silently reopens a closed hole.

- **`AddSingleton<BaseProcessor.Core.Processing.BaseProcessor, AnalystProcessor>()`** — not the concrete
  type. `AddBaseProcessor` deliberately does not register the author's processor. The wrong form ships a
  pod that looks healthy and never processes a dispatch.
- **The trace is assembled by the loop, never supplied by the model.** It is the record of what was
  executed; a model-supplied trace would be a claim. The quiet path (`report_no_finding`) is grounded
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
- **Model id and reasoning effort are environment variables, never a reloadable config source** (amended
  from "compiled constants" by this swap — see §5.2 above). The property they protect is unchanged: they
  change the preflight BIT's verdict, and the guarantee against a stale cache now rests on env vars
  freezing at container start rather than on a rebuild.
- **The API key is an environment variable, by the same "property of where the processor runs, never of
  the assignment payload" rule as the other three coordinates** — never accept it in a dispatch payload.
- **The BIT judges; compiled code decides.** The judge may only emit problems, never a pass verdict.
- **An assistant turn is replayed verbatim from the provider's raw JSON** (`ModelToolCall.ProviderEcho`),
  never rebuilt from its visible parts. See "The load-bearing property" above — this is the swap's own
  addition to this list, and reversing it is the specific defect this whole backend change existed to
  avoid repeating.

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
| `ModelTypes.cs:22`'s retained clause "some backends require an assistant turn to be echoed back..." reads oddly with exactly one backend wired up | True statement about a class of backend, not a claim about what is wired; the plural phrasing was deliberately left alone during this sweep. Superseded in part by the final-fix-wave review's F6: the clause's old "byte-for-byte" wording overstated the guarantee (it is semantically unchanged, property-for-property — string escaping is not preserved) and was corrected, independent of the "some backends" phrasing question, which still stands. |

---

## Environmental: the suite can silently under-report

On a loaded machine, the test host can lose results for the batch in flight and Microsoft Testing Platform
surfaces them as `NotExecuted` — a test that never ran, reported as a skip. This was seen during the
original build (one run skipped a plain `[Fact]` with no skip condition) and remains true here; it was not
observed during this swap's own runs, but the risk did not go away. If skip membership looks odd, check the
machine before suspecting the code — and re-run rather than trust a single green pass taken under load.

Other repo facts worth having: `dotnet test` **silently ignores `--filter`** under MTP and reports counts
only — run `src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe` directly for names. Restore is
**offline**: `NuGet.config` clears nuget.org, so any new package must be vendored into `nugets/` with its
full transitive closure or the Docker build fails. This swap added no packages — `System.Text.Json` is
in-box and `Microsoft.Extensions.Http` was already referenced.

---

## Not built, by design

- **The scored-window replay set** (prior design §16.3). A held-aside set of recorded windows with known
  answers, served through the fixture `IPanelReader`, replayed offline against a candidate prompt. See
  "What is still not done" above — this swap raises its priority rather than lowering it, since it changed
  the very model the existing BIT passes were earned against.
- **Multi-model / backend-selection support.** `IAnalystModel` is the seam a future change would use, but
  there is exactly one adapter, registered once, and adding a second is explicitly out of scope by
  decision — not a gap, a boundary.
- **Destructive capability and its whitelist.** Tools are the unit of capability, so adding it later means
  registering more tools rather than retrofitting a policy layer.
- **Self-hosting K3 for the air-gapped machine**, and closing the offline Elasticsearch 9.3.4 gap — both
  under "What is still not done" above, both out of scope for a connected-cluster deployment.
