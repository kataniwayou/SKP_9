# Design — Processor.Analyst on Kimi K3

**Date:** 2026-09-25
**Status:** awaiting review
**Supersedes, in part:** `2026-09-24-analyst-processor-design.md` §9.1, §9.2, §9.4 (backend, model-id
constancy, credentials). Everything else in that design stands unchanged.
**Prior art this rests on:** Ruling 35 in `.superpowers/sdd/2026-09-24-analyst-processor/progress.md`.

---

## 1. Purpose

Replace the Anthropic backend with Moonshot's **Kimi K3**, reached over its OpenAI-compatible **HTTP
API**, and make the backend's three coordinates — **model id, API key, base URL** — deployment-supplied
environment variables rather than compiled constants.

Throughout this document, *OpenAI-compatible* describes the **wire protocol**, which is settled and not
in question. *OpenAI SDK* means the `openai-dotnet` **client library**, which §4 examines separately and
largely rejects. The two are independent choices and the distinction is load-bearing.

The Anthropic adapter is **deleted**, not retained behind a switch. There is one backend.

**Endpoint facts this design is built on** (verified 2026-09-25): K3 launched 16 July 2026; weights on
Hugging Face 27 July. `https://api.moonshot.ai/v1`, model id `kimi-k3`, keys from `platform.kimi.ai`.
2.8T parameters / 104B active, 1M context, **$3 per MTok input / $15 output**. Thinking is **always on**
and cannot be disabled. `reasoning_effort` accepts `low`, `high`, `max`, defaulting to `max`.

---

## 2. What does not change

This is the seam earning its keep, and it is most of the system:

The investigation loop, the preflight BIT, the five stage-recording tools, the two terminal tools, the
trace assembled from what actually executed, the panel seam, the budget ledger, and every disposition
rule. All sit above `IAnalystModel` and are exercised against a stub model (§16.2 of the prior design),
so the large majority of the 145 Analyst tests should pass untouched.

**The disposition rule is unchanged and remains the thing to protect.** A step's disposition describes
whether the analysis *ran*, never what it concluded. `Cancelled` means it ran and found nothing —
silence that downstream reads as the all-clear. A backend fault must therefore never reach `Cancelled`.

---

## 3. The hard requirement: replay assistant turns verbatim

**This is non-negotiable and it is where this work will fail if it fails.**

Moonshot's K3 documentation states that responses carry a `reasoning_content` field separate from
`content`, and:

> "Return the complete assistant message unchanged in multi-turn conversations and tool calls."

The loop replays the whole transcript on every call. Turn 1 replays nothing; **turn 2 is the first
replay.** An adapter that rebuilds the assistant turn from its visible parts — `content` plus
`tool_calls` — drops `reasoning_content`, the turn is no longer "unchanged", and **every investigation
dies on its second model call** while every offline test passes, because no offline test completes a
real two-turn loop.

That is not a hypothesis. It is Ruling 35: the identical defect existed on the Anthropic adapter, which
dropped signed thinking blocks the same way, and was found by reading the vendor's own documented loop
rather than by any test.

**The mechanism already exists.** `ModelToolCall.ProviderEcho` carries provider-opaque state for the
assistant turn, set by the adapter and interpreted only by it. The loop copies `ModelReply.ToolCalls`
into the transcript unchanged and copies nothing else out of a reply, which is why the echo rides on a
tool call: it round-trips without the loop learning anything about reasoning. That property must be
preserved here — the loop still has no notion of "thinking".

For this adapter the echo is **the raw assistant message JSON as received**, replayed byte-for-byte.

A reply with no tool calls carries no echo and needs none: the loop rejects such a reply outright, so
that turn is never replayed.

---

## 4. Transport decision

The request was "via the OpenAI SDK". Evidence gathered while writing this spec argues against its
typed surface, so all three options are recorded and one needs sign-off.

### Rejected — OpenAI .NET SDK, strongly-typed surface

`openai-dotnet` **issue #1329** documents reasoning content from non-OpenAI models via third-party
endpoints being **silently dropped**: the deserializer maps a known subset of fields and everything else
falls into unmapped-property handling that never becomes readable. Related requests (#643) confirm the
gap.

Using the typed surface would therefore reconstruct §3's defect *inside the SDK*, where no amount of
care in our own adapter can see it. **Rejected on correctness, not taste.**

### Recommended — plain `HttpClient` + `System.Text.Json`

- The echo requirement becomes trivial: keep the assistant message's raw `JsonElement` and send it back.
- **No new NuGet package.** `NuGet.config` clears nuget.org, so every package must be vendored into
  `nugets/` with its full transitive closure or the Docker build fails. This option costs nothing there.
- The wire surface we need is small: one POST to `/chat/completions`, four message roles, a `tools`
  array, `tool_calls`, and `usage`.
- It is what §9.1 of the prior design chose, for these reasons.

### Sanctioned alternative — OpenAI SDK, protocol-level only

If the SDK is required for policy reasons, use only its protocol methods (`BinaryContent` in, raw JSON
out), never the typed chat surface. Auth, retries and transport come from the SDK; the JSON stays ours,
so §3 holds.

**The tradeoff, stated plainly:** we write the JSON by hand either way, so this buys plumbing while
still paying the offline vendoring cost. It is viable, not preferable.

**Decision required at review.** Everything downstream of this section is identical under all three.

---

## 5. Configuration

### 5.1 Four environment variables, deployment-supplied

| Variable | Value | Source |
|---|---|---|
| `Analyst__Model__ModelId` | `kimi-k3` | inline in the pod template |
| `Analyst__Model__BaseUrl` | `https://api.moonshot.ai/v1` | inline in the pod template |
| `Analyst__Model__ApiKey` | the Moonshot key | `secretKeyRef` → Secret `analyst-model`, key `apiKey` |
| `Analyst__Model__ReasoningEffort` | `high` (see §5.3) | inline in the pod template |

`Analyst__Model__ApiKey` is already wired this way in `k8s/43-processor-analyst.yaml`; only the other
three are new. Credentials remain a property of *where the processor runs*, never of the assignment
payload — that rule from §9.4 is unchanged.

### 5.2 Amending §9.2: why env vars are safe here

The prior design compiled model id and effort as constants, and the handover lists that as
load-bearing. **This design changes it deliberately, and the reason the rule existed is preserved.**

The stated reason was narrow: model id and effort change the BIT's verdict, and `PreflightBit` caches on
`PromptHash.Of(prompt)` — the prompt alone. A compiled constant forced a rebuild, which restarts the
pod, which clears the cache, which re-runs the BIT.

An environment variable delivers the same guarantee, because `BitCache` is already scoped to the
process. Its own doc comment:

> "Per-replica, in memory, bounded, and lost on restart... each replica proves its own fitness with
> **its own model backend** and its own wiring, and a proof is only as good as the process holding it."

Environment variables are frozen at container start. Editing them in the Deployment rolls the pods;
editing the backing Secret does not reach a running container at all. Either way the process holding the
stale verdict is gone. A mid-rollout mix of old and new pods is fine — each replica is self-consistent,
which is exactly the property that comment blesses.

**The condition that makes this true, and must be commented as such:** these values must remain
**environment variables**. If any of them later moves to a mounted ConfigMap file with
`reloadOnChange`, the guarantee breaks *silently* — a live swap against a warm cache reusing a verdict
earned on the old model or effort. `AnalystModelOptions` is consumed via `IOptions<T>` (a snapshot, not
`IOptionsMonitor`), so nothing reloads today; the comment exists to keep it that way.

This amendment needs its own ledger ruling rather than a silent edit.

### 5.3 `reasoning_effort` — set it, never inherit it

K3 accepts `low`, `high`, `max`, and **defaults to `max`**. Thinking cannot be disabled.

`max` is the most expensive corner, reasoning tokens bill as output at $15/MTok, and the eventual monitor
workflow runs unattended on a cron. Accepting that default by silence is the wrong call. **Start at
`high`**, and let the scored-window set (§9) justify any move upward.

Effort changes the BIT's verdict exactly as model id does, so it is restart-gated by the same mechanism
and lives alongside the others. It is **never** a payload field: the BIT hashes the prompt alone, so a
row edit would reuse a verdict earned at a different effort.

### 5.4 One hazard disappears

§9.3 of the prior design documents an Opus 5 trap: with thinking disabled, the model occasionally writes
a tool call into visible text, the call never runs, nothing errors, and the loop believes it read a panel
it did not. **K3 cannot disable thinking, so this failure mode is structurally impossible.** The comment
in `InvestigationLoopTests.cs:290` should say so rather than keep citing Opus 5.

---

## 6. The adapter

`Model/KimiAnalystModel.cs`, implementing `IAnalystModel`. Everything OpenAI-shaped stays inside it;
nothing above the seam sees a wire type.

| Seam | Wire |
|---|---|
| `system` | `{"role":"system","content":…}` as the first message |
| `ModelTurn` (User) with `ToolResults` | one `{"role":"tool","tool_call_id":…,"content":…}` per result, all in the same request |
| `ModelTurn` (User) with `Text` | `{"role":"user","content":…}` |
| `ModelTurn` (Assistant) | **the stored raw assistant message, verbatim** (§3) |
| `ToolSpec` | `{"type":"function","function":{name,description,parameters}}` |
| response `tool_calls[]` | `ModelToolCall(id, function.name, JsonDocument.Parse(function.arguments))` |
| `usage.prompt_tokens` / `completion_tokens` | `ModelReply.InputTokens` / `OutputTokens` |

Three details that are easy to get wrong:

- **`function.arguments` is a JSON *string*, not an object.** It must be parsed before validation, and a
  model that emits malformed JSON must produce an error `tool_result`, not an exception.
- **All tool results for one assistant turn go back in a single request.** Splitting them trains the
  model out of parallel calls.
- **Every tool input is validated client-side** against the catalog's own schema, regardless of whether
  the server claims to enforce anything. `InvestigationLoop.Validates` already does this, and already
  handles a tool name the model invented by returning an error `tool_result` rather than crashing —
  which matters, because OpenAI-compatible self-hosted stacks are documented to hallucinate undeclared
  tools where Moonshot's own API applies constrained decoding.

### 6.1 Error translation

Every transport and HTTP fault maps to `AnalysisImpossibleException`, most-specific-first, mirroring what
the Anthropic adapter did: connection failure, HTTP error status, malformed response body, and the
client's own timeout — the last only when the caller's token is *not* cancelled, so a genuine shutdown
still parks rather than being reported as a backend fault.

**This is disposition-critical.** `AnalysisImpossibleException` becomes `Failed`. A fault that instead
leaked through as a quiet no-finding would report all-clear because the monitor broke, which is the worst
failure this design can have.

---

## 7. Deleting the Anthropic adapter

Delete `Model/AnthropicAnalystModel.cs` and `tests/BaseApi.Tests/Analyst/AnthropicAnalystModelTests.cs`,
then sweep:

| File | Change |
|---|---|
| `Directory.Packages.props:152`, `Processor.Analyst.csproj:39-40` | remove the `Anthropic` package |
| `nugets/anthropic.12.50.0.nupkg`, `nugets/README-anthropic.md` | remove from the offline store |
| `ProcessorHost.cs:138` | register `KimiAnalystModel` |
| `Model/AnalystModelOptions.cs` | add `ModelId` and `ReasoningEffort`; **rewrite the `BaseUrl` comment**, which currently forbids exactly this use |
| `Model/ModelTypes.cs:22,55` | `ProviderEcho` and budget comments cite Anthropic specifics |
| `Loop/BudgetLedger.cs:6-8` | "deliberately not Anthropic task budgets" — the rationale survives, the wording does not |
| `tests/…/AnalystHostTests.cs:80` | asserts `IAnalystModel` resolves to `AnthropicAnalystModel` |
| `tests/…/InvestigationLoopTests.cs:290` | see §5.4 |
| `k8s/43-processor-analyst.yaml:21` | the Secret comment shows an `sk-ant-…` key |

### 7.1 Two premises that must be re-verified, not reworded

**`Loop/InvestigationLoop.cs:40`.** The F5 wall-clock fix reasoned explicitly from "`AnthropicClient`
has no configured request timeout". An `HttpClient`, or the OpenAI SDK, very likely *does* default to
one. That does not break F5 — the linked token remains the real bound — but the premise changes, and a
premise silently inherited into a comment is how a closed hole reopens. Check the actual default and
state it.

**`Model/IAnalystModel.cs:6-13`.** The seam justifies itself as "the only thing that makes one binary
shippable to both the connected cluster and the air-gapped machine". With one adapter that is no longer
true. The seam remains fully justified — §16.2's stub model and the bulk of the 145 tests depend on it —
but the comment must be rewritten to the honest reason. A comment that lies about why something exists
is how the next person deletes the wrong thing.

---

## 8. Testing

**Mirror the echo tests first.** The four tests added under Ruling 35 port across nearly verbatim, with
`reasoning_content` in place of the thinking block: the echo retains the field; every tool call in a
reply carries that turn's echo; an assistant turn replays its echo verbatim rather than rebuilding it;
and a turn with no echo still translates from its visible parts.

**Red-check the load-bearing one.** Ruling 35's test was confirmed to fail with the replay path disabled
before being trusted. Do the same here. An echo test that passes against a reconstructing adapter is
worthless, and this is the one property no offline test would otherwise reach.

**Everything above the seam keeps its existing coverage** via the stub model. Expect the suite total to
move by roughly the delta between the deleted Anthropic tests and the new Kimi ones, with `0 failed` and
every skip under `Live/`. Read that *shape*, never a remembered total — and disregard any run taken while
the machine is under memory pressure, which silently reports never-run tests as skips.

**A live two-turn smoke test is still required** before anything irreversible is posted. Nothing offline
can prove §3 holds against the real endpoint; that is the whole lesson of Ruling 35.

---

## 9. Carried forward, not solved here

**The scored-window replay set (§16.3) remains a prerequisite, not a nicety.** §9.5 of the prior design
says a prompt that passes its BIT on two models is not thereby equally good on both — and this design
changes the model. Without the replay set, prompt iteration against K3 is guesswork, and no finding it
produces can be justified as trustworthy. Candidate windows already named: the 210s queue-wait cycle,
the publisher-confirm double-count, a dead port-forward reading as an outage, and a stopped load
generator whose flat line meant nothing. Assert only what is stable across nondeterministic runs; never
a golden string.

**This is a hosted backend, and that is a governance decision.** `api.moonshot.ai` is a third-party
cloud endpoint. Panel payloads are raw Elasticsearch and Prometheus operational telemetry, and they will
leave the org. This design does **not** serve the air-gapped machine the prior design described — that
would require self-hosting K3's open weights, which at 2.8T parameters is an infrastructure programme,
not a deployment step. If the air-gapped case is still wanted, it is separate work.

**The offline Elastic version gap is out of scope.** The offline machine runs Elasticsearch and Kibana
9.3.4 against 8.15.5 in dev, so the panel readers face a different major version there. Irrelevant to a
connected-cluster deployment; blocking for an offline one.

---

## 10. Open items

Blocking, expected from the user:

1. **API key** — into the `analyst-model` Secret, out of band, never in the repo or this conversation.
2. **Model id** — `kimi-k3` unless the org pins something else.
3. **Base URL** — `https://api.moonshot.ai/v1` unless the org fronts it with a proxy.

Blocking, needing a decision at review:

4. **§4** — plain `HttpClient` (recommended) or protocol-level OpenAI SDK.

Non-blocking, to confirm against the live endpoint during the smoke test:

5. Whether `reasoning_content` appears on non-streaming responses in the same shape as streaming, and
   whether the echo requirement is enforced strictly enough to fail loudly. It should fail loudly; §3
   assumes it may not.

---

## 11. Risks

| Risk | Mitigation |
|---|---|
| `reasoning_content` dropped on the round-trip | §3 and §4; red-checked test; live two-turn smoke test |
| A typed SDK silently eats the field | §4 rejects that surface on the strength of issue #1329 |
| Effort left at `max` | §5.3 sets it explicitly and restart-gates changes |
| A backend fault reported as silence | §6.1; `AnalysisImpossibleException` → `Failed` |
| Model or effort changed against a warm BIT cache | §5.2; env-var-only, restart-gated |
| Findings trusted without the replay set | §9; stated as a prerequisite, not deferred quietly |
| Telemetry leaving the org unnoticed | §9; an explicit decision, not an implementation detail |
