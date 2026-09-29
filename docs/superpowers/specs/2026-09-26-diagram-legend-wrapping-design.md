# Design — wrap the diagram legend's config line

**Date:** 2026-09-26
**Status:** awaiting review
**Scope:** `kibana/publish-diagram.py` only. No API, no schema, no workflow row.

---

## 1. The problem, measured

`publish-diagram.py` refuses to publish the `analyst-monitor` drawing:

```
analyst-monitor   2 on the spine, 0 on the sink, 1950x262
  gate passed: every edge drawn and labelled, nothing escapes the viewBox, the SVG parses
  margins 40/6/222/21 measured
RENDER CHECK FAILED - nothing published:
  - wasted canvas: 222px of right margin      (MAX_MARGIN = 160)
```

The structural gate passes. What fails is the layout-quality check that exists to stop a canvas
being wider than its drawing — a real past bug, where a fixed 1580-wide canvas scaled a three-step
drawing down to a third of the panel.

**The cause is one long line, and it is long because of key *count*, not value length.** `cfg_text`
joins every `key: value` pair of a step's payload onto a single row:

| assignment | joined line | keys |
|---|---|---|
| `analyst-monitor-cfg` | **750 chars** | **7** |
| `asg-kafka-importer` | 91 chars | 4 |
| `split-importer-cfg` | 89 chars | 4 |
| `split-filefetcher-cfg` | 76 chars | 3 |

The Analyst payload has 7 keys where nothing else has more than 4, so its row is ~8× the next
longest. `vb_w` is derived from it at line 532 (`X0 + 260 + text_w(cfg_text(config(sid)), 11)`), and
because `text_w` is a deliberately generous estimate — Python has no text engine — the canvas
overshoots the real rendered width by ~11–13%. On a 1688px content width that is 222px of slack,
past the 160px allowance.

**Per-value truncation cannot fix this, and that is established rather than assumed.** With
`MAX_VALUE_CHARS` at 80 / 56 / 48 / 40 the right margin goes 276 → 247 → 235 → **222**. It
asymptotes, because capping each value does not reduce the number of pairs on the row.

## 2. Why wrapping rather than a line-level cap

A line-level cap would pass the gate immediately and is two lines of code. It is rejected because it
would drop trailing keys — on the Analyst payload, `wallClockSeconds` would simply not appear.

This file already records that exact mistake under `EVERY KEY AND ITS VALUE`: the legend once showed
`list(cfg)[:2]`, which hid `allowedExtensions` — the whitelist deciding one of the chain's five
outcomes — "with nothing to say a key was hidden." A cap with an ellipsis is better than that, since
the elision announces itself, but it still trades information for layout.

Wrapping trades **vertical space**, which this drawing has: 262px tall for a two-box graph, with the
canvas sized from content rather than fixed. Nothing is lost.

## 3. The change

### 3.1 Wrap by pair, never mid-pair

`cfg_text` and the span-emitting loop both consume `config(sid)` → a list of `(key, value)` pairs.
Wrapping packs pairs greedily into rows subject to a width budget, and **never splits a pair across
rows**. That keeps each row's `.lg-key` / `.lg-val` / `.lg-punct` span structure intact and keeps a
key visually attached to its value.

Introduce one function, the single place the row split is decided:

```python
def cfg_rows(pairs, budget_px):
    """The config pairs packed into rows, each row's rendered estimate <= budget_px."""
```

Both the emitter and the `vb_w` computation must consume this same function's output, for the reason
`fmt_value` already documents: the drawing and the width estimate must never disagree about how wide
a line is.

### 3.2 `MAX_VALUE_CHARS` stays

Per-value truncation is retained and is not redundant. A single value wider than the whole budget
cannot be packed into any row, so the cap is what guarantees `cfg_rows` terminates with every pair
placed. 80 is the measured value: of 89 payload values in the deployment only the Analyst's 524-char
`prompt` exceeds it, so no existing drawing changes.

### 3.3 The four sites that assume one row per step

These are the whole change surface. Each currently hard-codes "one legend row per spine step".

| Line | Now | Becomes |
|---|---|---|
| 488 | `vb_h = legend_y0 + LEGEND_DY * len(spine) + CAPTION_BAND` | `LEGEND_DY * (total rows across all steps)` |
| 495 | `ly = legend_y0 + LEGEND_DY * k` | advance by the **cumulative** row count of preceding steps |
| 496 | step name emitted at every `ly` | step name on the step's **first** row only; continuation rows leave that column empty |
| 532 | `X0 + 260 + text_w(cfg_text(config(sid)), 11)` | `X0 + 260 + max(text_w(row) for row in rows)` |

Continuation rows start at the same `X0 + 260` column as the first, so the config block reads as one
left-aligned paragraph under the step name rather than a hanging indent.

### 3.4 Choosing `LEGEND_CFG_MAX_W`

A px budget, not a character count, because `vb_w` is px-driven and the gate measures px.

**Set it to 900px.** That is derived from a `--dry-run` sweep of all six existing workflows, captured
before any change (§4 item 4's baseline, table below). Both constraints are satisfied with room:

- **Upper ≈ 1100px.** `vb_w ≈ X0 + 260 + budget + VB_W_PAD`, and the estimator's slack must stay under
  `MAX_MARGIN = 160`. `kafka-import-export` is the calibration point — **structurally identical to
  `analyst-monitor` at 2 boxes and 13 texts** — and shows 110px of slack on a 961px canvas, so slack
  runs ~11–13% of content at this shape. Holding it under 160 caps the canvas at ≲1430px.
- **Lower ≈ 640px.** The widest existing single-row config line, again `kafka-import-export`: 961px
  canvas less `VB_W_PAD` and the 300px `X0 + 260` offset. Below this, an existing drawing gains a row.

The slack is intrinsic to the generous `text_w` estimate at this shape, not something the Analyst's
payload introduced — which is why the fix is to bound the line, not to loosen the gate.

**Baseline, captured 2026-09-26 with `--dry-run` (publishes nothing):**

| workflow | canvas | margins (l/t/r/b) | boxes |
|---|---|---|---|
| `filefetcher-archiveexpander-chain` | 1574x578 | 40/6/40/21 | 10 |
| `v8-fanout-proof` | 1382x342 | 5/6/4/21 | 7 |
| `sc-chain` | 1382x342 | 40/6/40/21 | 7 |
| `kafka-import-export` | 961x262 | 40/6/110/21 | 2 |
| `simple-abc` | 616x278 | 40/6/42/21 | 3 |
| `v8-fanout-proof-clone` | **produced no output** — see Risks | — | — |

If 900 turns out not to satisfy both constraints once implemented, report it rather than silently
favouring one — that would mean the estimator's slack is too large for this layout and the fix is a
different one.

## 4. Verification

**The gate is the test.** `publish-diagram.py` runs its own render check on the candidate before
publishing, in a real browser, and refuses on failure. So:

1. `analyst-monitor` publishes, with all 7 keys present across wrapped rows.
2. Bottom margin stays within `MAX_MARGIN` — `vb_h` grows with the row count, so content still fills
   the canvas vertically.
3. The `legendTop - boxBottom` gap check is unaffected: `legendTop` is the *minimum* y across
   `.lg-step` / `.lg-cfg`, which is still the first legend row.
4. **No existing drawing changes.** Re-run the script for each of the six existing workflows and
   confirm the reported `WxH` and margins are byte-identical to a run from before the change. This is
   the check that matters most, and it is cheap — capture the current numbers first.

## 5. Risks

| Risk | Handling |
|---|---|
| An existing drawing silently gains a row | §4 item 4 — capture before/after `WxH` for all six |
| A pair wider than the budget cannot be placed | `MAX_VALUE_CHARS` bounds it; assert in `cfg_rows` rather than loop forever |
| Taller canvas trips the bottom-margin check | `vb_h` is derived from the row count, so content grows with it |
| Estimate slack still exceeds `MAX_MARGIN` | §3.4 says report it rather than force it — it would mean a different fix |

## 6. Not in scope

- Any change to `MAX_MARGIN` or `MAX_GAP`. The gate is correct; loosening it to admit this drawing
  would discard the check that caught the original fixed-width bug.
- Shortening the Analyst's prompt. The prompt is the monitor's analytical substance; trimming it to
  suit a diagram is the wrong trade.
- Wrapping anything other than the config row — step names, captions and edge labels are short and
  measured fine today.
