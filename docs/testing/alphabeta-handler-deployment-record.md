# AlphaBeta handler — what was changed on the live system, and how to undo it

**Date:** 2026-09-14 (supersedes the first draft of the same day, which recorded a standalone handler
that was never wired)
**Processor:** `sk-normalizer` (`1673b377-8237-4d41-b420-3099a27f7dbf`)
**Workflow:** `filefetcher-archiveexpander-chain` (`1a56b3ca-e276-4815-87fa-5c2f48ab6dad`), 9 steps → 10

Git records the code. It does not record any of the below, which is why this file exists: every
change here lives in a database row or a kind node.

---

## 1. What was built

`filefetcher-archiveexpander-chain` now forks at the normalizer and writes **two** files per input:

```
expander → sk-normalizer [Acme] ─┬→ collapser → persister → exporter → acme-<guid>.zip
                                 └→ sk-normalizer [AlphaBeta] → collapser → persister → exporter → track01.xml
```

**One processor row, two steps, two payloads.** Both steps point at `1673b377-…`; which handler runs
is decided per dispatch by the step payload, exactly as `Sample` and `Acme` have always coexisted.
No second pod, no second processor row.

**AlphaBeta runs AFTER Acme, not beside it.** Its entry condition is `PreviousCompleted`, so an Acme
failure skips it — there is no XML to lift and nothing to redo. A parallel branch off the expander
would repeat the whole provider mapping and would still run after its sibling had failed.

**AlphaBeta renders nothing.** It finds the `.xml` entry Acme already produced and passes those bytes
through as a leaf-root document. `ArchiveCollapser` carries a `Bytes` root through unpacked, so
`file-persister` writes an `.xml` and no zip is ever created on that branch. **Verified live: the
standalone `track01.xml` is byte-identical to the copy inside the archive** — same 621 bytes, same
sha256 — because there is only ever one document, not two producers kept in step.

## 2. The processor rows

**Final state.** Every schema edge this work touched is back where it started; only the two identity
fields on `sk-normalizer` are genuinely changed.

| row | field | before | after |
|---|---|---|---|
| `sk-normalizer` `1673b377-…` | `sourceHash` | `6dd9967793…` | `0b6759dd7740417ae77dd7d294df997816989f6b3331a1465eebf90b42a9b12c` |
| | `configSchemaId` | `b243856f-…` | `7f6e4ecd-095b-4ffa-83eb-94a1506fe5f4` |
| | `inputSchemaId` | `e33f8079` (archive-document) | `e33f8079` — nulled, then restored |
| | `outputSchemaId` | `e33f8079` (archive-document) | `e33f8079` — nulled, then restored |
| `archive-collapser` `76146a07-…` | `inputSchemaId` | `e33f8079` (archive-document) | `e33f8079` — nulled, then restored |
| `file-persister` `c046fb57-…` | `inputSchemaId` | `f495b02e` (file-envelope) | `f495b02e` — nulled, then restored |

`file-fetcher` was considered twice and **left alone throughout**. Every other field on all three
rows is unchanged; each call was a GET-then-resend, because **`PUT` replaces the row** and a partial
body silently wipes `name`, `version`, `description` and `sourceHash`.

**The nulls are recorded rather than erased, because logs from that window will not make sense
without them.** Between the first deploy and the restoration the four edges were null, deliberately:
a statement that the `sk-normalizer` row's shape depends on its payload, since one handler emits a
container and the other a leaf.

### Why the original values are the only ones that fit

Not a preference — the id gate forces it. `SchemaEdgeValidator` compares row **ids**, not schema
content, so each edge admits exactly the parent's output row, or null:

- `archive-expander` out is `e33f8079`, so `sk-normalizer` in must be `e33f8079` or null.
- The AlphaBeta step's parent is the Acme step, on the **same row**, so `sk-normalizer` in must equal
  its own out.
- The collapser's two parents are both that row, so its in must be `e33f8079` too; its child is the
  persister, so its out must be `f495b02e`.

A tighter schema is attractive and unusable. Both handlers refuse a leaf root, so an input requiring
`content` to be an array would catch that mis-feed at publish instead of in the handler — but a new
row is refused by the id gate even when its definition is byte-identical. That is finding **F1**,
where `archive-document-twin` was refused against a verified-identical source.

### What `archive-document` has to admit, and does

Validated offline against the live definition, then confirmed live (§5). `content` is
`["string","array","null"]`, which is what makes the whole fork expressible:

| document | edge | |
|---|---|---|
| folder of `.wav` + `.json` | expander out → Acme in | VALID |
| folder of `.mp3` + `.xml` | Acme out → AlphaBeta in | VALID |
| **leaf root** — the XML alone, `content` a base64 string | AlphaBeta out → collapser in | VALID |
| `content: null` — archive expanded to nothing | any | VALID |

`file-envelope` is stricter — six required fields, `additionalProperties: false` — and still admits
both branches, because the envelope *shape* does not vary: only `extension` differs (`.zip` vs
`.xml`) and it is an unconstrained string.

### The one null that cost something

Of the four, **only `sk-normalizer`'s output removed a control that fires.** In this system the
*producing* side validates — D2 and D3 were caught at the importer, S1 at the expander — while
consumer-side input validation has never fired in a live suite. While it was null a malformed
document from either handler would have travelled on and failed at the collapser, or packed wrong
without failing at all. The collapser's and persister's outputs were never nulled and kept enforcing
throughout.

**A changed edge is not enforced until the pod restarts.** `processor-sknormalizer`,
`processor-archivecollapser` and `processor-filepersister` were rolled for both the nulling and the
restoration; processors resolve schema definitions once at startup and never re-read them. The
restoration's logs say so rather than implying it — `definition resolved for input schema e33f8079…`
and `for output schema e33f8079…` on the normalizer, and the matching lines on the other two.

## 3. The workflow wiring

| what | id |
|---|---|
| step: `sk-normalizer-alphabeta` | `556d5234-3668-498a-ba97-fd2865594ef3` |
| assignment: `sk-normalizer-alphabeta-assignment` | `325fe0ac-c458-4fe0-8639-be336d1c6a06` |

The step carries `entryCondition: 1` (PreviousCompleted) and
`nextStepIds: [c5845265-… (collapser), 73952b09-… (record-failure)]` — the same two successors every
other chain step has. The assignment payload is `{"handler": "AlphaBeta"}`.

The Acme step `56fca87f-…` gained `556d5234-…` in `nextStepIds`, **alongside** the collapser and the
recorder it already had, so it now names three successors. The workflow gained the assignment id and
holds 10.

**`POST /orchestration/start` takes a RAW JSON GUID STRING** — not `{"workflowId": …}` — and answers
**202**. Without it the edits sit in the database and the running projection never sees them.

**Undo:** remove `556d5234-…` from the Acme step's `nextStepIds`, remove `325fe0ac-…` from the
workflow's `assignmentIds`, delete the assignment, then delete the step. **The schema edges in §2 are
already at their original values and need nothing** — they were nulled and restored within this same
day's work. Roll nothing for the undo either: removing a step changes no processor's edges. Republish
with `POST /orchestration/start` or the running projection keeps dispatching the deleted step.

## 4. The image

`processor-sknormalizer:local` rebuilt and `kind load`ed into cluster `desktop`. The kubectl context
may say `docker-desktop`; the cluster is kind. Both replicas came up `1/1` with 0 restarts, which is
what proves the Linux-computed hash matches the row — a stale row presents instead as a permanently
`0/1 READY` pod and a rollout that times out at 300s.

## 5. Verified live, 2026-09-14 08:36Z

One bundle (`both-1e5c47529766.zip`, one `track01.wav` + `track01.json` pair) seeded and published to
`skp-paths`. **Both files landed in 5 seconds:**

- `/mnt/skp-files/out/both-1e5c47529766.zip` — 823 bytes, holding `track01.mp3` (ID3-headed, 13836
  bytes, so the audio really was re-encoded) and `track01.xml`
- `/mnt/skp-files/out/track01.xml` — 621 bytes, **sha256 identical to the copy inside the zip**
- `skp-documents` carries **two** records, one per branch — the exporter now runs twice per input

The XML says `<provider>Acme</provider>`, `<codec>mp3</codec>` and `<bitrateKbps>192</bitrateKbps>`,
which is correct: Acme wrote it, and AlphaBeta copied it without touching a byte.

### Re-proved after the schema edges were restored, 09:03Z

`gated-d0b4159c4d09.zip`, same fixture, with all four edges back in force. Both files landed in 16
seconds; the standalone XML is again sha256-identical to the copy in the archive (619 bytes), and
`skp-documents` carries both records.

Three things this run proves that the first could not:

- **The publish gate accepts the restored set** — `POST /orchestration/start` answered 202, where a
  mismatched edge is a 422 naming the pair.
- **The pods resolved the definitions**, from their own logs, not inferred from a green rollout.
- **A leaf root passes producer-side output validation.** This was the genuinely open question: with
  `sk-normalizer` out enforcing `archive-document`, the XML-alone document — whose `content` is a
  base64 string rather than an array — went through. The offline validation said it would; this is
  the live system agreeing.

## 6. Two things to know before this meets a real feed

- **`track01.xml` is not one file per run.** The zip carries a guid so every run adds one; the xml
  takes the basename from *inside* the bundle, which is `track01` in every fixture we seed. The
  persister overwrites deliberately — re-running a workflow must land in the same state — so `out/`
  accumulates many zips and exactly one `track01.xml`, rewritten each time.
- **A multi-pair bundle is the one document the two branches disagree about.** Acme has a container
  to put both items in; AlphaBeta's leaf root holds one file, so it fails by name rather than
  silently dropping the second. That failure takes the `record-failure` edge like any other.
