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

| row | field | before | after |
|---|---|---|---|
| `sk-normalizer` `1673b377-…` | `sourceHash` | `6dd9967793…` | `0b6759dd7740417ae77dd7d294df997816989f6b3331a1465eebf90b42a9b12c` |
| | `configSchemaId` | `b243856f-…` | `7f6e4ecd-095b-4ffa-83eb-94a1506fe5f4` |
| | `inputSchemaId` | `e33f8079` (archive-document) | **null** |
| | `outputSchemaId` | `e33f8079` (archive-document) | **null** |
| `archive-collapser` `76146a07-…` | `inputSchemaId` | `e33f8079` (archive-document) | **null** |
| `file-persister` `c046fb57-…` | `inputSchemaId` | `f495b02e` (file-envelope) | **null** |

`file-fetcher` was considered and **left alone**. Every other field on all three rows is unchanged;
each call was a GET-then-resend, because **`PUT` replaces the row** and a partial body silently wipes
`name`, `version`, `description` and `sourceHash`.

**None of the four nulls was required, and that is worth writing down.** Every edge already matched
(`archive-document → archive-document` on both normalizer steps, `file-envelope` into the persister),
and `SchemaEdgeValidator` passes on a null on *either* side, so no edge could have failed. They were
asked for deliberately, as a statement that the sk-normalizer row's shape now depends on its payload:
one handler emits a container, the other a leaf.

**The output null costs something the three input nulls do not.** In this system the *producing* side
is what validates — D2 and D3 were caught at the importer, S1 at the expander — while consumer-side
input validation has never fired in a live suite. Nulling `sk-normalizer`'s `outputSchemaId` removes
the check that its document is a well-formed `archive-document` before it reaches the next queue. A
malformed document from either handler now travels on and fails at the collapser, or packs wrong
without failing at all.

**A changed edge is not enforced until the pod restarts.** `processor-sknormalizer`,
`processor-archivecollapser` and `processor-filepersister` were all rolled for exactly this reason;
processors resolve schema definitions once at startup and never re-read them.

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
workflow's `assignmentIds`, delete the assignment, delete the step, restore the four schema ids in §2,
roll the three deployments, then republish.

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

## 6. Two things to know before this meets a real feed

- **`track01.xml` is not one file per run.** The zip carries a guid so every run adds one; the xml
  takes the basename from *inside* the bundle, which is `track01` in every fixture we seed. The
  persister overwrites deliberately — re-running a workflow must land in the same state — so `out/`
  accumulates many zips and exactly one `track01.xml`, rewritten each time.
- **A multi-pair bundle is the one document the two branches disagree about.** Acme has a container
  to put both items in; AlphaBeta's leaf root holds one file, so it fails by name rather than
  silently dropping the second. That failure takes the `record-failure` edge like any other.
