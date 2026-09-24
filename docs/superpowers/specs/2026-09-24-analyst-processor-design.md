# Processor.Analyst — a scheduled operator surrogate that reads the boards

**Date:** 2026-09-24
**Status:** Designed, name confirmed, all decisions resolved except §19.1 (scheduling). Not implemented.
**Introduces:** `src/Processor.Analyst/`, a k8s manifest for it, one config schema row, one finding
schema row, and the solution's first LLM dependency (`Anthropic` NuGet package, pinned in
`Directory.Packages.props`).
**Amends:** nothing. `BaseProcessor.Core` is unchanged. No watched workflow is modified in any way.
**Depends on:** the existing Grafana and Kibana panels as the evidence surface; `Processor.KafkaExporter`
as the delivery leg; the orchestrator's cron and explicit-start behaviour; a reachable model endpoint.

**Scope note.** This document designs the **structure**: the workflow shape, the disposition
semantics, the two-layer prompt split, the five-stage mission, the preflight BIT, the tool surface,
the model seam, and the finding contract. It deliberately does **not** write the analytical prompt
itself — that is payload, it is expected to change fifty times, and freezing it here would be a
category error. §17 lists what else is deferred on purpose.

---

## 1. The decision

> **`Processor.Analyst` does on a schedule what an operator does when he glances at the boards.**
> It is dispatched with the id of a workflow to investigate and a time window. It reads the same
> Kibana and Grafana panels a human reads, correlates across them, forms and tries to kill
> hypotheses, and either writes a finding to L2 or says nothing. It reads; in this milestone it
> cannot write anything anywhere except its own finding.

It is not looking for a specific fault. It is looking for a *trend of behaviour* and an explanation
of it — and it is expected to report the trend rather than route around it.

Two properties define everything downstream:

**It is a participant, not an outside observer.** It is an ordinary processor in an ordinary
workflow, so it inherits cron, entry conditions, retry semantics, lineage, liveness and the deploy
loop for free, and its own runs are observable exactly like every other processor's.

**It is stateless across dispatches.** There is no memory of the previous run. A trend is re-derived
from the configured window every time. This is the single most important constraint in the design,
and §13 explains why it is a feature.

---

## 2. Workflow shape

`Processor.Analyst` runs in **its own workflow**, on **its own cron**, with **two steps**.

```
[cron] → Analyst → KafkaExporter
```

**One monitor workflow per watched workflow.** Cadence becomes a per-target decision: a busy pipeline
gets fifteen minutes, a quiet one gets a day. The target is a payload variable, not a hardcoded
identity, so the same processor image serves every monitor.

**Step 1 — Analyst.** Receives the target `workflowId`, the window, the prompt and its budget from
the step payload. Reads panels. Ends in exactly one of three dispositions (§3).

**Step 2 — KafkaExporter.** Reads the finding from L2 and publishes it. It knows nothing about
analysis.

### 2.1 Step 2 must NOT use entryCondition `4`

`entryCondition` 4 is `Always`, and every sample step uses it, so copying a sample is how a failed
step dispatches its successor anyway. On a monitor that is catastrophic: an Analyst step that timed
out, blew its budget or could not reach Elasticsearch would still fire the exporter, and the operator
would receive a confident-looking empty finding. **Step 2 gates on step 1 having Completed.**

A monitor that reports all-clear because it crashed is the worst failure this design can have. Every
other decision in this document is downstream of refusing it.

### 2.2 The watched workflow is untouched

No step is added to it, no schema changes, no coupling. The Analyst's own executions land in lineage
under the Analyst workflow's id, so **every business-layer (Elasticsearch) query it issues is scoped
by the target `workflowId` from its payload** — it stays out of its own mirror by construction, not
by an exclusion clause someone must remember to keep writing.

**Amended 2026-09-24 (Task 14 review, C3): the ops layer is not, and cannot be, scoped by `workflowId`
the same way.** `pipeline_*` metrics carry no workflow label at all — they are labelled by queue,
destination and replica (`service_instance_id`), never by a workflow id — and a single processor
replica ordinarily serves several workflows over its lifetime. A Prometheus panel therefore reads
host-level telemetry for the replica, not evidence scoped to the monitored workflow specifically; a
queue-wait spike it shows may belong to a different workflow entirely running on the same replica.
Every ops panel's own description says so explicitly, so the model is told this in the one channel
that reaches it (the panel descriptions), not only here.

### 2.3 The export leg is not end-to-end testable in dev

`skp-kafka.kind` is unreachable and retried; "1/1 brokers are down" at startup is expected noise, not
an outage. Step 1 is fully verifiable locally. Step 2 can only be verified by inspecting what it
attempted to publish. Plan the Analyst step to be provable on its own.

---

## 3. Dispositions — the semantic core

**The step's disposition describes whether the analysis ran. It never describes what the analysis
concluded.**

| Disposition | Meaning | Mechanism | Exports? |
|---|---|---|---|
| **Completed** | The analysis ran and produced a finding that contributes to understanding whether something is broken or heading that way. | normal return, finding written to L2 | yes |
| **Cancelled** | The analysis ran to completion and its result does not contribute. | `throw new CancelledException(...)` | no |
| **Failed** | The analysis could not run — infra, transient, unreachable panel, model backend down, budget exhausted with no terminal answer, preflight BIT rejection. | `throw new FailedException(...)` | no |

An analysis that finds the system on fire is a **successful** analysis → Completed. A verdict is
never a failure, good or bad. A failure is a failure regardless of what partial results were in hand:
**nothing partial is ever exported.**

### 3.1 There is no `Indeterminate` verdict

"I could not tell" is not something the Analyst says; it is something the step *is*. Inability to
analyse is an exception, not a payload value. This keeps the finding schema smaller and makes the
distinction between "everything is fine" and "I could not see" structural instead of textual.

### 3.2 Silence is the all-clear

A healthy system produces no Kafka traffic at all. That is deliberate: the operator's external inbox
carries findings only, and nobody downstream has to learn what "quiet" means. Liveness is observable
internally instead — see §13.1.

### 3.3 `FailedException`'s doc comment says "business reason"

It does. The Analyst uses it for the opposite: infra and transient faults. It is simply the framework's
way to report `StepResult.Failed`, so it fits — but **put a comment at each throw site**, or the next
reader will think it is a mistake.

Genuine programming errors are left uncaught, exactly as `SKNormalizer` deliberately does not catch
bare `Exception`. A null reference in the investigation loop must not be dressed up as an infra hiccup.

### 3.4 Cron is the retry policy

There is no value in retrying a transient ES timeout inside a dispatch: the agent is stateless, so the
next tick re-derives the same window from scratch. Fail fast, fail loudly, let the schedule retry.
This is a property statelessness gives away for free.

---

## 4. The step payload

The payload is `Assignment.Payload` — arbitrary jsonb, delivered per dispatch, surfaced as `TConfig`
in `ProcessAsync`.

### 4.1 It IS schema-validated, at publish time

`PayloadConfigSchemaValidator` walks step → processor → `ConfigSchemaId` → that schema's Definition
and evaluates each assignment's payload against it, surfacing failures as a 422. The assignment entity
carries no schema reference itself, but the orchestration layer resolves one through the processor.

**The schema validates structure, never quality.** It can guarantee `prompt` is a present string. It
cannot tell whether the prompt is coherent, self-contradicting, truncated mid-sentence, or simply makes
the agent credulous. A payload can be perfectly conformant and produce worthless findings. That
residual risk is what §8 exists to reduce and §16.3 exists to measure.

### 4.2 The field list must be right on the first POST

The config schema is a schema row, and **a referenced row's Definition cannot be edited** — adding a
field later means POSTing a new row, re-pointing both sides, and restarting. Changing a *value* stays a
cheap row edit. Discovering a missing knob is the whole dance. Therefore:

| Field | Purpose |
|---|---|
| `targetWorkflowId` | which workflow to investigate. Scopes every query. |
| `window` | the analysis window, matching what the dashboards show. Months of history is explicitly not the job. |
| `prompt` | the analytical judgment layer (§5). |
| `panelSet` | which panels this assignment may consult. |
| `budget` | iteration cap, token ceiling, wall-clock (§10). |

**Deliberately NOT in the payload:** model id and effort. See §9.2.

### 4.3 What the processor must still check itself

The schema cannot express these, so `ProcessAsync` checks them before spending anything, and throws
`FailedException` on violation:

- the window is sane relative to the panels' retention
- the budget is survivable and leaves room for evidence
- the prompt is non-empty after trimming, within length bounds, and leaves token headroom for the
  panel results it will have to hold

A well-formed config the processor cannot work with is still an analysis that could not run.

---

## 5. Two layers: the contract is compiled, the judgment is payload

| Layer | Lives in | Contains | Changing it costs |
|---|---|---|---|
| **Contract** | compiled into the processor | the tool protocol; the five stages and their required artifacts; the two terminal tools and their meaning; cite-your-evidence; never claim a panel you did not read | rebuild + `kind load` + SourceHash repoint |
| **Judgment** | `prompt` in the payload | what counts as a trend worth a human; how sceptical to be; which correlations matter; the specific ways *these* boards lie | a row edit + a workflow restart |

The split is about **blast radius**, not convenience. A payload edit that could delete the verify stage
or break the typed exit would turn every dispatch into a Failed step with no obvious cause, and the
person who edited the row would have no way to know why.

### 5.1 Payload edits need a workflow restart

A running workflow reads the L2 projection from its start time, so after a payload edit the pods keep
using the old prompt while the row shows the new one, silently. During heavy prompt iteration this will
bite repeatedly and look like "the change did nothing."

**The iteration loop is: edit payload → restart the workflow → confirm the prompt hash in the next
finding actually changed.** §11 puts that hash in the finding precisely so this step is possible.

---

## 6. The five-stage mission

The agent's mission is structured as **research → validate → plan → execute → verify**. The stage
skeleton and each stage's required artifact are contract; the judgment inside each stage is payload.

**Research** — what does this window look like? Broad, no hypothesis yet. The glance.

**Validate** — *is this evidence real?* Distinct from verify, and for this system probably the
highest-value stage of the five. It is where the known ways the boards lie get applied: a dead
port-forward keeps the socket bound so the port looks free and then refuses connections; a panel
missing a series renders perfectly healthy; the chaos-timeline legend samples at now−15m so no run can
ever show a line stop; degradation is two-state, so 685× slower shows nothing and past the 2s probe
timeout reads as an outage; and a stopped load generator makes a flat arrival line that is *absence of
load*, not absence of problems.

**Validate owns the Cancelled-vs-Failed decision.** Series absent where series should exist, window
only partly covered, "no data" indistinguishable from "no problem" → `FailedException`. Data present
and trustworthy and unremarkable → proceed, and a quiet ending is then honest.

**Plan** — hypotheses, and for each one **what evidence would kill it**, stated *before* executing.
This is the stage that earns its place. Without a pre-committed disconfirming criterion, verify
degenerates into the agent re-reading its own conclusion approvingly, which is worse than no verify
stage because it launders confidence.

**Execute** — gather what the plan called for.

**Verify** — did the evidence actually support the surviving hypothesis, against the criteria stated in
plan? **Verify must be able to kill the finding**: if nothing survived, the honest ending is
`report_no_finding` → Cancelled, not a hedged narrative shipped to Kafka. Verify must also **re-apply
validate's criteria to evidence gathered during execute** — otherwise the first readings are
scrutinised and the decisive ones are not.

### 6.1 The stages are recorded as typed tool calls

Not narrative sections. `record_research`, `record_validation`, `record_plan`, `record_readings`,
`record_verification`, then one terminal tool. Structured artifacts are what make the trace
machine-readable, the in-loop assertions possible (§6.3), and the finding's audit trail real.

Re-planning after execute is explicitly allowed — an investigation that genuinely needs a second look
must not be locked into one pass.

### 6.2 Name the stages; do not script them

Prompts written for earlier models tend to be over-prescriptive on Opus 5, and that *reduces* output
quality. "Before executing, state what would disprove each hypothesis" is a constraint and belongs.
"First query panel A, then panel B, then compare" is a script, and a worse one than the model would
have chosen.

### 6.3 In-loop assertions on the real run

Distinct from the preflight BIT (§8), which tests the *prompt*. These test the *artifacts of this
actual investigation*, in compiled code, by cross-reference:

- a hypothesis marked ruled-out whose stated disconfirming criterion was never read
- a verification verdict citing a reading absent from `record_readings`
- a finding whose evidence references a panel the trace shows was never consulted
- the plan recorded after execute rather than before
- a surviving hypothesis with no disconfirming criterion at all

Each is deterministic and each is a real way a plausible investigation goes wrong. Deep semantic
contradiction inside prose is out of reach and the assertions do not pretend otherwise.

### 6.4 Ruled-out hypotheses are kept

An agent rewarded for finding trends will keep the survivor and quietly drop the three it killed. "I
suspected the broker and ruled it out" is frequently the more valuable sentence — especially here,
where the obvious suspect has repeatedly turned out to be a port-forward, a stale package, or a filter
silently ignored. The finding carries them (§11).

---

## 7. The panel tool surface

**Panels are the tool surface.** Not raw query access. The agent gets the same curated views the
operator gets, across Elasticsearch, Grafana, and whatever is added later. A panel already has its
query written down in the dashboard JSON.

This is also the read boundary: the tool list *is* the panel list, it is inspectable, and adding a
source later means registering more panels rather than widening a permission. The Analyst's proficiency
is **correlation across panels** — it sees exactly what the operator sees and is better at holding nine
boards in mind at once. Metrics outside the panels are out of scope for this milestone.

### 7.1 One parameterized tool, not one tool per panel

The tool block is the cache prefix, so a growing panel set would inflate every request. A single
`read_panel(panelId)` plus `list_panels`, with panel descriptions moved into the system prompt, stays
flat as the set grows.

### 7.2 Every reading carries a trust annotation

Not just a value: series present or absent, window fully covered or partial, and whether "no data" was
distinguishable from "no problem". This is what lets verify re-validate cheaply and what lets the
assertions check "did it annotate before concluding?" without judging prose.

### 7.3 The agent inherits every blind spot of the boards

If the panels are its only eyes, it cannot see what the boards cannot show — and it will report a
confident quiet result over exactly those gaps, in prose, which reads more authoritative than an empty
chart does. This does not change the design, but it means **the panel set is a correctness dependency
of the Analyst**, not a convenience, and an orphaned instrument is now a monitoring bug with teeth.

### 7.4 `IPanelReader` seam

Panel reads go through a seam. Its live implementation queries the real systems; a fixture
implementation serves recorded snapshots and is what makes §16.3 possible. Not required by the BIT
(§8.2).

---

## 8. The preflight BIT

**Every dispatch, before any real analysis, the payload prompt is tested for fitness.**

The BIT is **a compiled judging prompt** carrying a hardcoded scenario and a hardcoded expected
outcome. It asks the model to evaluate the dispatched prompt's five stages against them, and it
**rejects** — rules out as unfit — any stage that is missing, malformed, or self-contradicting.

### 8.1 The BIT lives in the compiled layer

The payload prompt is what is being examined, so the exam must not be editable by its subject. The
BIT's instruction is a compiled constant and is never concatenated into the payload prompt. Changing
the exam costs a rebuild, a `kind load` and a SourceHash repoint — the right price for weakening a gate.

### 8.2 It is one model call, not a second investigation

The scenario lives inside the judging prompt as text. No tool loop, no panel reads, no fixture reader.
On a cache miss the cost is a single call.

### 8.3 Only constants participate

The BIT tests the **prompt alone**, against hardcoded scenario, window, target, budget and
expectations. No payload variable participates. Consequently the cache key (§8.6) is a hash of the
prompt and nothing else.

### 8.4 The model reports; the processor decides

The judge is forced into a typed verdict — `strict: true` on a `report_fitness` tool, or structured
outputs — returning a per-stage result (present / malformed / contradicting) with the offending text
quoted. **Compiled code turns that structure into pass/fail against a fixed threshold.** A judge allowed
to emit a free-form "looks fine" is a gate that can talk itself into passing.

### 8.5 The payload prompt is untrusted data to the judge

It arrives as content to be evaluated. Delimit it explicitly and state in the compiled prompt that the
enclosed text is the *subject* of evaluation and must never be followed. The operator is not an
adversary, but a prompt written to command one model reads as a command to this one too.

### 8.6 In-memory cache, keyed by prompt hash

The BIT is *checked* every dispatch and *run* only on a miss, so it amortises to roughly once per prompt
change per pod.

- **Canonicalize before hashing** — sort keys, normalize whitespace. Logically identical JSON that
  hashes differently misses the cache silently.
- **Cache failures as well as passes.** Otherwise a bad prompt re-runs the full BIT every dispatch,
  paying most for the configuration that deserves it least. A FAIL is safe to cache: the only fix is a
  payload edit, which changes the hash and creates a new entry.
- **Bound the dictionary.** One or two entries is realistic; unbounded is a slow leak.
- Per-replica and lost on restart, which the deploy loop causes constantly. That is correct — each
  replica proves its own fitness with its own backend and wiring.

### 8.7 A BIT rejection Fails the dispatch

"Reject" describes what the BIT does to a *stage*. What it does to the *dispatch* is `FailedException`.
An agent that just failed its fitness exam has analysed nothing, and Cancelled would read as all-clear.

### 8.8 What the BIT cannot cover

A prompt-only BIT proves the prompt is well-formed, stage-complete and non-contradicting. It cannot
prove the prompt works with *this* assignment's window, panel set or budget. Those remain the
deterministic checks in §4.3.

---

## 9. The model seam

### 9.1 `IAnalystModel`

The interface exposes "a conversation with typed tools, returning either tool calls or a terminal
result" — **above the wire format**, not raw message objects. Anthropic speaks `tool_use` /
`tool_result`; OpenAI-compatible stacks speak `tool_calls`. Both the five stage-recording tools and the
two terminal tools must be expressible on either side.

Two adapters:

- **Anthropic** — the official `Anthropic` NuGet package, `AnthropicClient`, `client.Messages.Create`,
  model `claude-opus-5`. This is the solution's first LLM dependency; pin it in
  `Directory.Packages.props` carefully, since a malformed entry there surfaces as solution-wide NU1604
  rather than anything naming the package.
- **On-prem** — a plain `HttpClient` adapter for the org's `kimi-2.5` endpoint on the offline machine.
  The Anthropic SDK cannot talk to a non-Anthropic endpoint; a `base_url` override produces wire-format
  mismatches, not a working client. This adapter is ordinary work, but it is work, not configuration.

### 9.2 Model and effort are compiled constants

They change the BIT's verdict, so as payload variables they would have to enter the hash — which
contradicts §8.3. Compiled resolves it for free: changing them requires a rebuild, which restarts the
pod, which clears the cache, which re-runs the BIT. Correctness is preserved with no extra machinery.
The cost is that trying a different effort during iteration is a rebuild rather than a row edit.

### 9.3 Anthropic-only features must not be load-bearing

Adaptive thinking, `effort`, task budgets and server-side `strict` enforcement do not exist on the
on-prem path. So:

- **the authoritative budget is loop-enforced** (§10), not `task_budget`. Task budgets may be used as a
  pacing nicety on the Anthropic path only.
- **every tool input is validated client-side**, never trusted to have been schema-checked by the server.
- Thinking is left at its default on Opus 5. Explicitly disabling it there is a known trap: the model
  occasionally writes a tool call into visible text instead of a `tool_use` block, the call never runs,
  nothing errors — in this loop that is a panel the agent believes it read and did not.

### 9.4 Credentials belong to the deployment, not the workflow

| Backend | Needs |
|---|---|
| Anthropic | `ANTHROPIC_API_KEY` from a Kubernetes Secret, mounted as an env var. Optionally `ANTHROPIC_BASE_URL`. Nothing else — no org id, no workspace id. |
| On-prem `kimi-2.5` | internal base URL; bearer token if the endpoint authenticates; CA bundle or client cert for internal TLS/mTLS; the model id string. |

Never in the assignment payload. Credentials are a property of *where the processor runs*; the payload
is a property of *what it is asked to analyse*.

### 9.5 A prompt is not equally good on both backends

The BIT verdict is model-dependent and switching backends re-runs it, which falls out correctly. But a
prompt that passes on Opus 5 and passes on `kimi-2.5` is not thereby *equally good* on both, and nothing
in this design will tell you that. §16.3 is what would — which moves it from a nice-to-have to a
prerequisite for trusting the offline deployment.

---

## 10. Budget

Enforced by the loop, in the processor: **iteration cap, wall clock, accumulated tokens.** All three
come from the payload's `budget` field.

Budget exhaustion with no terminal tool call is `FailedException` — an analysis that did not finish is
an analysis that did not run. On the Anthropic path a task budget may additionally be set so the model
paces itself and lands the plane rather than being truncated mid-thought, but nothing depends on it.

Prompt caching is structured correctly — stable prefix (tool block, system prompt) before the volatile
per-dispatch content (target, window timestamps) — but **expect little from it**: cache entries live
about five minutes and cron intervals are longer, so most dispatches are cold. Check
`usage.cache_read_input_tokens` rather than assuming.

**A redelivered message re-runs the whole investigation and bills for it.** Worth knowing before a
broker hiccup charges twice.

---

## 11. The finding document

Written to L2 like any other processor's output; read by KafkaExporter. Governed by a schema row, so
**its field list is frozen once referenced** — this is the expensive one to get wrong.

| Field | Why |
|---|---|
| `verdict` | the contributing-finding distinction (drift vs notable). `Quiet` and `Indeterminate` do not appear — they are dispositions, not values (§3.1). |
| `window` | the **realized** window and the counts examined, not the configured one. They diverge the moment a query truncates or a source lags. This is what makes two answers comparable (§13.1) and what turns "arrival time is drifting" into a checkable claim. |
| `narrative` | the prose an operator reads. The only part that needs the model. |
| `evidence` | the numbers the narrative rests on: name, value, and which panel and layer it came from. So a reader can disagree with the explanation without re-running the investigation. |
| `ruledOut` | hypotheses killed, with the criterion that killed them (§6.4). |
| `trace` | which panels were consulted, in order. On a hypothesis-driven agent this is how you tell "checked and it was clean" from "never looked" — without it a wrong conclusion is unauditable. |
| `promptHash` | provenance. The same value as the BIT cache key (§8.6). One number, two uses. |

Model, effort and the contract are all compiled, so they are pinned by the image and the SourceHash
lineage already records. `promptHash` plus processor version fully identifies what produced a finding.

**Deliberately excluded:** severity/priority scoring, and any recommended action. Severity belongs to
whoever consumes the Kafka message and knows who is on call; an agent that ranks its own findings
starts optimizing for being noticed. A recommendation invites someone to act on a read-only agent's
guess — which is the door the future whitelist opens deliberately, not by suggestion.

---

## 12. Redis scratch — deferred, with a reason

The design permitted a dedicated Redis segment as per-dispatch working notes, TTL'd, keyed per
`executionId`. **It is not built, because the loop gave it no consumer**: one dispatch is one process
holding one transcript in memory, and that transcript dies with the dispatch by design.

Writing it anyway would cost a round-trip per turn, a TTL to tune, and a new failure mode — Redis
unavailable failing a dispatch the agent could otherwise have completed — to persist notes nothing
reads.

**What would change that:** a transcript that outgrows the context window and needs compaction with
the dropped turns kept somewhere recoverable, or an investigation allowed to span dispatches. The
first is a real possibility on a wide panel set; the second contradicts §13 and should not happen.

**If it is ever built**, the constraints stand: its own unmistakable key prefix, keyed per
`executionId` so a redelivery cannot read another dispatch's notes, a TTL near the dispatch lifetime,
and never a reason for anyone to scale or flush Redis — scaling Redis wipes L2.

---

## 13. Statelessness, and what it buys

Nothing carries between dispatches. The agent cannot inherit yesterday's wrong conclusion because it
does not know yesterday happened. A remembered conclusion is exactly where this class of agent rots —
an agent that reads its own prior explanation at the top of its context anchors on it and confirms
rather than tests.

### 13.1 Repetition is a consistency signal, not noise

Because dispatches are stateless with overlapping windows, consecutive runs are near-identical
experiments. If tick *n* says drifting with one explanation and tick *n+1* says quiet over substantially
the same data, **that disagreement is a finding about the agent, not the system** — it is flapping, and
its narrative should not be trusted that day. Steady repetition is the agent saying "still true, still
reading, still here."

This requires no new machinery. It requires the realized window (§11) to be precise enough that two
answers can be compared, and it runs against the **internal** lineage records, not Kafka — because a
healthy system emits no Kafka traffic at all (§3.2).

Note that cancelled branches log at Information while failures log at Warning, so a quiet run is faint
in Elasticsearch on purpose. Whoever checks liveness must know to look at Information.

**Nobody may "fix" the repetition by giving the processor a memory.** It is the property, not the bug.

---

## 14. Deployment consequences

- A new processor image, a new k8s manifest, a registration row, a config schema row and a finding
  schema row. Registration is three rows across five processors and edges match by row id, so adding a
  processor is not free of blast radius — check what the new rows touch.
- Every rebuild needs its SourceHash repointed; the SourceHash fold is project-only, so a framework edit
  moves no processor hash.
- The cluster is `kind` (the context says docker-desktop), so images need `kind load`.
- An unregistered processor waits rather than crashing: Running/NotReady with 0 restarts is by design,
  and a rollout timeout is the expected signal.
- Monitor workflows need **a cron AND an explicit start**; with neither, the orchestrator logs nothing
  and the whole thing looks broken.
- The Anthropic path requires egress to `api.anthropic.com`. The air-gapped machine has none, which is
  precisely why §9.1 exists.

---

## 15. Failure map

| Situation | Outcome |
|---|---|
| Panel source unreachable / times out | `FailedException` |
| Model backend unreachable or errors | `FailedException` |
| Preflight BIT rejects the prompt | `FailedException` |
| Budget exhausted with no terminal tool call | `FailedException` |
| Config well-formed but unusable (§4.3) | `FailedException` |
| Validate stage: evidence not trustworthy enough to analyse | `FailedException` |
| In-loop assertion violated (§6.3) | `FailedException` |
| Analysis completed, nothing contributing | `CancelledException` |
| Analysis completed, finding produced | normal return, finding to L2 |
| Programming error | uncaught, deliberately |

---

## 16. Testing

**16.1 Unit.** The loop's budget enforcement, the disposition mapping, the in-loop assertions, the
prompt-hash canonicalization, the BIT cache (hit, miss, cached failure, bound), config validation. None
of these need a model.

**16.2 Integration with a stub model.** `IAnalystModel` is a seam, so the whole five-stage loop can be
driven by a scripted fake that returns chosen tool calls: terminal-tool paths, re-plan, budget
exhaustion, malformed tool input, an assertion violation. This is where most confidence comes from and
it costs nothing per run.

**16.3 The scored-window set — the piece that makes "better" mean something.** A held-aside set of
recorded windows with known answers, served through the fixture `IPanelReader`, replayed offline against
a candidate prompt. Assert what is stable across nondeterministic runs: the loop terminated, a terminal
tool was called, the finding validates, the planted signal was found, the planted decoy was ruled out.
**Never a golden string** — sampling parameters are removed on Opus 5 (`temperature` and friends return
400), so output cannot be pinned, and a string comparison will fail on wording and teach everyone to
ignore the check.

Candidate windows from real history: the 210s queue-wait cycle; the publisher-confirm double-count where
~12 of ~13ms was the sender's own confirm; a window where a dead port-forward read as an outage; a window
where the load generator was stopped and the flat line meant nothing.

Without this, fifty rounds of prompt editing judged by reading one finding each will feel like progress
and will not be. It is separate work, but §9.5 makes it a prerequisite for the offline deployment rather
than a nicety.

**16.4 Live.** The suite's 2-minute window is tight; "no log line named X" usually means late, not
missing — check with `--timestamps`.

---

## 17. Deliberately deferred

- **Destructive capability and its whitelist.** v1 is read-only with no exceptions. Because tools are
  the unit of capability, adding it later means registering two or three more tools, not retrofitting a
  policy checker around a general-purpose shell. If v1 instead handed the agent a broad client "because
  everything is read-only anyway", the future whitelist would have nothing to hang on.
- **Metrics outside the panels.** Acknowledged to exist; out of scope.
- **Deduplication of repeated findings.** Belongs to the Kafka consumer, never to the processor (§13.1).
- **Severity and on-call routing.** Belongs downstream (§11).
- **The analytical prompt itself.** Payload, and expected to change constantly.

---

## 18. Resolved decisions

1. Its own workflow, own cron, two steps, one monitor per target. (§2)
2. Step 2 gates on Completed, never `entryCondition` 4. (§2.1)
3. Disposition describes whether the analysis ran, never what it concluded. (§3)
4. No `Indeterminate` verdict; silence is the all-clear. (§3.1, §3.2)
5. Prompt lives in the assignment payload; the contract stays compiled. (§5)
6. Five stages, `validate` included and owning the Cancelled-vs-Failed call. (§6)
7. Stages recorded as typed tool calls; typed terminal tools drive the disposition. (§6.1)
8. Panels are the tool surface, via one parameterized tool. (§7, §7.1)
9. Preflight BIT is a compiled judging prompt, prompt-only inputs, cached by prompt hash, rejection
   Fails the dispatch. (§8)
10. Model and effort are compiled constants. (§9.2)
11. Budget is loop-enforced so both backends behave identically. (§9.3, §10)
12. Stateless across dispatches; repetition is the consistency signal. (§13)
13. Redis scratch deferred; the loop provides no consumer for per-dispatch notes. (§12)

## 19. Open questions

1. **Whether the scored-window set (§16.3) is built before or after first deployment.** It is a
   prerequisite for trusting the offline backend but not for shipping the connected one.
