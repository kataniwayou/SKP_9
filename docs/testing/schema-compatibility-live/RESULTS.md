# Schema-compatibility live suite — results

**Run:** 2026-09-12, 17:12–17:34 UTC, live `skp` cluster.
**Subject:** `sc-chain` (`9a3d2a6b-3617-4f22-9ff8-77c19a95ff19`), a deep clone of
`filefetcher-archiveexpander-chain` — same seven processor rows, its own steps, assignments, topics
(`skp-paths-sc` / `skp-documents-sc`) and output folder (`/mnt/skp-files/out/sc`).
**Evidence:** every verdict below is taken from the `logs-generic.otel-default` datastream, scoped by
`attributes.ExecutionId` (lineage) or `attributes.WorkflowId` (pre-lineage), health probes excluded.
Helper: `es-trace.py` in this directory.
**Scope:** business logic and rejection decisions only. No resilience, retries, broker faults or timing.

## Verdict summary

| # | Challenge | Expected | Observed | Verdict |
|---|---|---|---|---|
| D1 | conforming archive, `maxDepth 4` | round trip | persisted + exported | **PASS** (no false positive) |
| D2 | record with extra key `providerName` | refused at hop 1 | `output failed its schema — /providerName:` | **TRUE POSITIVE** |
| D3 | record with `path` not `filePath` | refused at hop 1 | `output failed its schema — : required; /path:` | **TRUE POSITIVE** |
| D4 | non-archive bytes named `.zip` | refused by expander, not by schema | `leading bytes are no archive…treating it as corrupt` | **TRUE POSITIVE** (business, not schema) |
| D5 | three entries sharing a basename | schema-valid, refused by handler | expander OK (3 entries) → `…also holds track01.txt` | **TRUE POSITIVE** (the schema/business boundary) |
| D6 | nested archive, `maxDepth 1` | inner stays a leaf, refused | `DepthReached 1 of 1` → `item 'inner' … holds 0 and 0` | **TRUE POSITIVE** |
| D7 | same archive, `maxDepth 4` | expected to pass; it does not | `DepthReached 2 of 4` → same message | **TRUE POSITIVE, unexpected** — see F2 |
| D8 | `maxDepth 0` | refused at publish | 422 `/maxDepth: 0 should be at least 1` | **TRUE POSITIVE** (config-schema surface) |
| S-TP | normalizer.in = `file-locator` vs expander.out = `archive-document` | refused at start | 422 schema-edge mismatch | **TRUE POSITIVE** |
| S-FP | normalizer.in = byte-identical twin of expander.out | should start | **422, identical message** | **FALSE POSITIVE — see F1** |
| S1 | both sides re-pointed to a tightened schema | refused at runtime | passed until pods restarted, then refused | **TRUE POSITIVE only after restart — see F3** |
| S3 | importer edge re-pointed to a permissive locator | D2's record now passes | full round trip | **PASS** (proves D2 was schema-driven) |
| S4 | restore every edge, re-run D1 and D2 | D1 passes, D2 refused | exactly that | **PASS** (restore verified) |

Thirteen challenges: nine correct rejections, three correct passes, **one false positive**.

## F1 — The edge gate compares ids, not schemas, so identical schemas are refused

`SchemaEdgeValidator` is a Guid comparison:

```csharp
if (parentOut.Value != childIn.Value)
    throw OrchestrationValidationException.SchemaEdge(parent.Id, child.Id);
```

Pointing the normalizer's input at `archive-document-twin` — a row whose definition is byte-identical
to the expander's output row (verified `twin.definition == source.definition`) — refuses the workflow
with *"parent output schema does not match child input schema."* Every document valid against one is
valid against the other. Nothing is wrong, and the chain cannot start.

**Why it matters beyond the test.** This is the shape of any ordinary schema-evolution step: publish
`v2` of a contract, migrate consumers one at a time. That is impossible here — the two sides must
carry the *same row id*, so a new version must be adopted by producer and consumer in one atomic
change, across every workflow sharing those processor rows. Combined with F3 (processors cache at
startup) there is no ordering of operations that is safe without downtime: re-point both, then
restart both, and every document in between is validated against whichever side happens to be stale.

**What passing the gate does not mean.** It proves the two sides were *configured with the same row*.
It proves nothing about the data — D2, D3 and D5 all passed the gate and were refused at runtime.

## F2 — MaxDepth cannot rescue a nested pair, and the failure looks the same either way

The same nested archive (`inner.zip` containing `track01.wav` + `track01.json`) fails at both depths:

| `maxDepth` | expander | normalizer |
|---|---|---|
| 1 | `expanded … 1 entries, reaching depth 1 of 1` | `item 'inner': … holds 0 and 0` |
| 4 | `expanded … 1 entries, reaching depth 2 of 4` | `item 'inner': … holds 0 and 0` |

At depth 4 the inner archive **is** expanded — `DepthReached 2` proves it — and the pair Acme wants
exists one level down. It is still refused, because `AcmeHandler.Locate` groups only the ROOT's
entries: a nested pair arrives as one folder-node item, and `ValidateContent` counts zero `.wav` and
zero `.json`.

This is a contract mismatch, not a bug in either component. `archive-document 3.0.0` is recursive and
admits arbitrary nesting; `AcmeHandler` accepts exactly one flat level. The schema cannot express the
handler's real requirement, so the only thing between a well-formed nested document and a failed
round trip is a runtime message reading `holds 0 and 0`. Logged as G7.

## F3 — A re-pointed schema edge is not enforced until the processor restarts

Covered in full as **G5** in `LOGGING-GAPS.md`, and repeated here because it is a behavioural finding
as much as a logging one: after re-pointing both sides of an edge to a tightened schema, the chain
**completed successfully** against a document that violates it. The processors were still enforcing
the schemas they resolved at startup. A `rollout restart` made the same seed fail correctly.

Publish-time gates read the database fresh; processors do not. The window between them is unbounded
and silent.

## F4 — The rejection decisions themselves are sound

The brief asks whether each failure decision is justified, because a failure ends the round trip. On
the evidence, every rejection observed was correct and stopped at the right component:

- The **producing** side validates its own output (D2/D3 at the importer, S1 at the expander), so bad
  data never reaches the next queue. Consumer-side input validation never fired in this suite — while
  the edge gate enforces id equality and both sides share a row, it is close to unreachable.
- **Business rules are refused by the component that owns them**, with messages naming the document,
  the item and the offending entry (D4, D5). These are the best diagnostics in the system.
- **The chain stop is explicit every time**: `the terminal step completed with Failed — no successor
  accepts it, the run ends here`, because successors carry `entryCondition: PreviousCompleted`. No
  partial output was produced on any failed run — verified in `/mnt/skp-files/out/sc`, which holds
  only `sc-d1.zip`, from the passing runs.
- The single wrong rejection (F1) happens at **publish**, not at runtime, so it costs a deployment
  rather than a document.

## Incidental finding — an assignment payload is not validated when it is written

`PUT /api/v1/assignments/{id}` accepted `{"maxDepth": 0}` without complaint; the violation surfaced
only at `POST /orchestration/start`. Storing a payload that can never be published is legal, and the
author learns about it at deploy time rather than at edit time. The same PUT is what the suite used
to vary MaxDepth, so this is not a defect it encountered — but it is the reason D8's rejection lands
at publish rather than earlier.

## State after the run

- All seven processor schema edges restored and verified (`restore-edges.ps1`, all `RESTORED`),
  confirmed by S4 re-running D1 clean and D2 refused.
- Three schema rows created and left **unreferenced**: `archive-document-twin` (`ef246bdb…`),
  `archive-document-tightened` (`68ef4073…`), `file-locator-open` (`f33d3018…`). Safe to delete.
- `sc-chain` and its 7 steps / 7 assignments remain, stopped. Topics `skp-paths-sc`,
  `skp-documents-sc` and folder `/mnt/skp-files/out/sc` remain.
- Seeds on the node: `sc-d1.zip`, `sc-d4.zip`, `sc-d5.zip`, `sc-nested.zip`.
- The other five workflows were stopped for the duration and have been **restarted and verified
  projected** (`v8-fanout-proof`, `v8-fanout-proof-clone`, `simple-abc`, `kafka-import-export`,
  `filefetcher-archiveexpander-chain`). `sc-chain` is stopped and holds no projection.
- `processor-sknormalizer` was scaled 2 → 1 for log legibility and is **back at 2**.
