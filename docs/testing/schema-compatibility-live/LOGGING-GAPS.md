# Logging gaps found while running the schema-compatibility live suite

Raised per the suite's brief: where the logs cannot support a verdict, say so rather than work
around it. Each entry says which layer owns it — **base** (BaseProcessor.Core / BaseConsole.Core),
**concrete** (a named processor), or **orchestrator** — what the log says today, and what a verdict
needed it to say. None of these stopped the suite; the "Blocked a verdict" line says what each one
cost.

Run: 2026-09-12, workflow `sc-chain` (`9a3d2a6b-3617-4f22-9ff8-77c19a95ff19`), a deep clone of
`filefetcher-archiveexpander-chain`.

---

## G1 — base — a schema rejection never names the schema that rejected it

`BaseProcessor.Core.Processing.ProcessedDataHandler` logs

```
output failed its schema — reported failed: /providerName:
attributes: StepId, ProcessorId, EntryId, ExecutionId, WorkflowId, CorrelationId, SchemaErrors
```

There is no `SchemaId`, no schema name and no version anywhere on the line.

**Why it matters here specifically.** A schema edge is a row id on the *processor*, shared by every
workflow, and this suite's whole second half re-points those ids. When a document is refused, the
first question is "refused against which row — the original, or the one the test re-pointed to?" and
the log cannot answer it. During S1–S3 the only way to attribute a rejection is to correlate the log
timestamp against a separate record of what the edge pointed at in that minute, which is exactly the
kind of inference a log should make unnecessary.

**Wanted:** `SchemaId` on the line, and ideally the schema's name and version, since the id alone
still needs a lookup.

**Blocked a verdict:** no — timestamps plus the suite's own mutation log closed the gap, but the
attribution is circumstantial rather than logged.

---

## G2 — base — the rejection reason is discarded, only the pointer and keyword survive

The same line's `SchemaErrors` reads, verbatim, for the two data-side violations:

| Seeded record | `SchemaErrors` |
|---|---|
| `{"filePath": "...", "providerName": "acme"}` | `/providerName: ` |
| `{"path": "..."}` | `: required; /path: ` |

Both end in a colon with nothing after it, and the second begins with one.

**Cause, confirmed in code.** `ProcessorJsonSchemaValidator.cs:148`:

```csharp
.SelectMany(d => d.Errors!.Select(kv => $"{d.InstanceLocation}: {kv.Key}"))
```

The `Errors` dictionary is keyword → message, and only `kv.Key` is formatted. **`kv.Value` — the
human-readable reason — is dropped.** Where the keyword itself is empty (which is what
JsonSchema.Net produces for an `additionalProperties` violation) the entry degrades to a bare
pointer and a colon, saying that `/providerName` is wrong but not that it is *unexpected*.

`: required; /path: ` is worse than it looks: the empty pointer is the document root, `required`
is the keyword, and **the name of the missing property is in the dropped `kv.Value`.** A reader
sees that something required is missing at the root and is not told that it is `filePath`.

**Wanted:** format `{kv.Key}: {kv.Value}` (or just `kv.Value`, which usually embeds the keyword),
and keep the pointer. The fix is one line and turns `: required; /path: ` into something like
`required: Required properties [filePath] are not present; /path: unevaluated`.

**Blocked a verdict:** no, but only because the suite controls the input and already knows which
property it corrupted. An operator reading this line cold could not tell a missing `filePath` from
a missing anything-else, which is precisely the diagnosis the line exists to provide.

---

## G3 — orchestrator / BaseApi — a publish-time schema refusal loses its diagnosis on the way to ES

Setting the clone's expander payload to `{"maxDepth": 0}` and starting the workflow is refused. The
**HTTP response** is precise:

```json
{ "status": 422, "title": "Assignment payload does not conform to its config schema",
  "errors": { "gate": "payloadConfigSchema",
    "offending": { "assignmentId": "53e67e7a-...", "errors": ["/maxDepth: 0 should be at least 1"] } },
  "correlationId": "9c8e55f92cb9461c8c410e7646610e98" }
```

The **log** that reaches ES is `BaseApi.Core.Exceptions.Refusal`, and it carries:

```
body:  the request was refused with 422: Assignment payload does not conform to its config schema
attrs: StatusCode, Title, RequestPath, RequestId, ConnectionId, TraceId, SpanId, ParentId
```

Missing: **`WorkflowId`**, the **offending assignment id**, the **specific errors**, and the
**`correlationId` the response returned**. The gate name (`payloadConfigSchema`) is gone too.

**Why it matters here specifically.** The brief requires every verdict proven by ES logs. A
publish-time refusal can be proven to have *happened*, and nothing more — not which workflow, not
which assignment, not which rule. Worse, the absent `WorkflowId` means the natural query (filter by
the workflow under test) returns **nothing at all**, so a refusal looks identical to a request that
was never made. I only found this line by dropping the workflow filter and reading every baseapi
warning in the window.

**Wanted:** `WorkflowId`, `CorrelationId`, and the offending detail on the `Refusal` line — the
information already exists at the point where the response is built.

**Blocked a verdict:** **partially.** S2's verdict ("the edge gate refused the start, and why") is
provable from ES only as "a 422 refusal occurred on `/api/v1/orchestration/start` at this second".
Attributing it to this workflow rests on the suite being the only caller. On a busy API that
inference would not hold.

---

## G4 — orchestrator / BaseApi — a deliberate 422 also logs as an unhandled exception at Error

The same refusal emits a second line, one millisecond apart:

```
Erro  ExceptionHandlerMiddleware  An unhandled exception has occurred while executing the request.
```

A validation refusal is the gate doing its job. Logging it at **Error** as **unhandled** overstates
it: it is handled — `Refusal` at `Warning` is the same event, correctly classified. Any error-rate
alert or dashboard that counts Error-level lines will count deliberate schema rejections as faults,
and a suite like this one generates them on purpose.

**Wanted:** the refusal path should not reach the unhandled-exception handler, or that handler should
log a known refusal at the severity `Refusal` already uses.

**Blocked a verdict:** no. It is noise, but it is noise in the exact severity band an operator
watches.

---

## G5 — base — nothing logs which schema a processor is actually enforcing, and this produced a false PASS

**This is the one that nearly cost a wrong verdict, so it leads the list in severity.**

S1 re-pointed both sides of the expander→normalizer edge to `archive-document-tightened`, which
requires a `metadata.provenanceTag` the expander never emits. The workflow started (the edge gate
compares ids, and both sides matched), the control document was seeded, and the chain **completed
end to end** — persisted and exported, no rejection anywhere.

That result is wrong, and nothing in the logs says so. The processors had resolved and cached their
schemas at startup; the re-pointed edge was invisible to them. After
`kubectl rollout restart` of the expander and normalizer, the identical seed was rejected exactly as
designed:

```
!! archive-expander  output failed its schema — reported failed:
   /metadata: required; /content/0/metadata: required; /content/1/metadata: required
```

So between a re-point and a restart, **the published contract and the enforced contract differ, and
every log line in the window looks healthy.** A `Completed` run is indistinguishable from a run that
was never checked against the schema the operator believes is in force.

**Wanted, in order of value:**
1. A startup line per processor naming each schema it resolved — id, name, version — so "what is
   this pod enforcing" is answerable from logs.
2. The schema id on the validation line itself (this is G1, and it would also have caught this: the
   passing run would have shown the OLD id while the workflow was published against the new one).
3. Ideally, invalidation or a warning when a processor's registered schema id changes underneath it.

**Blocked a verdict:** **yes, temporarily.** S1's first run produced a clean PASS that I had to
disprove by restarting pods and re-running. Without suspecting the cache, the suite would have
recorded "a tightened schema is not enforced" as a finding about validation, which is false. I did
not stop the suite — the restart was enough — but this is the gap most likely to mislead someone
reading these logs in production.

---

## G6 — orchestrator — a schema-edge refusal names the steps but never the schemas

The mismatch true positive and the mismatch false positive produce **byte-identical diagnostics**:

```
422 Schema-edge mismatch between steps
detail: Schema-edge mismatch on edge 'a37bb2d5-...' -> 'ceb2d18b-...':
        parent output schema does not match child input schema.
errors.offending: { parentStepId, childStepId }
```

The first case had `archive-document` against `file-locator` — genuinely incompatible. The second had
`archive-document` against a **byte-identical copy of itself**. Same message, same fields, no way to
tell them apart, and the sentence "parent output schema does not match child input schema" is
factually untrue in the second case: the schemas match perfectly, the row **ids** differ.

**Wanted:** the two schema ids (and names/versions) in `offending`. The reader's next question is
always "which two schemas?", and today that means querying both processor rows by hand.

**Blocked a verdict:** no — I knew which ids I had set. But the message actively misleads about what
was compared, which is worse than saying too little.

---

## G7 — concrete (SKNormalizer) — one message for two opposite situations

D6 (`maxDepth: 1`) and D7 (`maxDepth: 4`) on the same nested archive both fail with:

```
normalizing sc-nested.zip failed: item 'inner': an Acme item needs exactly one .wav and one .json,
and this one holds 0 and 0
```

The situations are not the same. At depth 1 the inner archive is an **unexpanded leaf** and raising
MaxDepth is the fix. At depth 4 it is a **fully expanded folder containing exactly the pair Acme
wants**, and no MaxDepth will ever help, because `AcmeHandler.Locate` groups only the ROOT's entries.
The log says "holds 0 and 0" in both cases, so an operator cannot tell a configuration problem from
a categorically unusable shape.

**Wanted:** say what the node actually is. "item 'inner': its single node is a folder, not a file"
versus "…is an unexpanded archive (MaxDepth 1 of 1 reached)" would separate the two, and the handler
knows which is which — it has the `FileContent` discriminator in hand.

**Blocked a verdict:** no. I distinguished them from the expander's `DepthReached` attribute
(`1 of 1` vs `2 of 4`) on the preceding line — which works only because the expander logs well.

---

## Not a gap: what the logs did well

Worth recording, because the gaps above are easier to act on against a baseline.

- **`ExecutionId` on every line from the importer onward** made each lineage a single ES query across
  seven services. Without it this suite would not have been runnable as specified.
- **Structured attributes carry the reasoning inputs**: `MaxDepth`, `DepthReached`, `EntryCount`,
  `Handler`, `ItemCount`, `ConvertedCount`, `SizeBytes`. D6 vs D7 was resolvable *only* because of
  these.
- **The concrete processors' own failure messages are excellent** — the expander's "the file is named
  '.zip' and its leading bytes are no archive this processor knows — treating it as corrupt rather
  than recording it as a plain file" states the decision AND the alternative it rejected. The
  contrast with G2's `: required; /path: ` is stark, and both are on the same failure path.
- **The chain-stop is always explicit**: "the terminal step completed with Failed — no successor
  accepts it, the run ends here" appears on every true positive, which is exactly the round-trip
  stop the brief asks to justify.
- **BaseApi's config-schema errors are legible** (`/maxDepth: 0 should be at least 1`) — the same
  class of error that BaseProcessor.Core renders unreadable. The good formatting already exists in
  the codebase; G2 is a one-line fix to match it.
