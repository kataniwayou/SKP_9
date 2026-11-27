# Acto cache items: fit-to-height pages and jump to key

Date: 2026-11-27. Status: draft for approval.
Approved mock (the user's "prefecto"): https://claude.ai/artifact/J2a2QGpsEYJ5i3a1MQKCpL (fit-to-height, per-page summary, board Save and Undo; version 3 adds the jump-to-key box and the `from` / `before` reads).

## Why

A cache can now hold a million items (proved on the live chain, 2026-11-27). Acto's Cache tab still shows them the way it did for small caches: a 500-row page that scrolls inside the Inspector, a count with no separators, Previous and Next only, and an "Unsaved" list for the whole cache. At a million items that means a scrollbar inside a scrollbar, no way to reach a key you know, and unsaved changes you have to hunt for. The user wants the list to fit the panel, a summary that describes only what is on screen, and a way to go straight to a key.

## Goals

- The Items list shows as many rows as fit the Inspector's height, with no scrolling inside the list.
- Resizing recalculates the page size and keeps the first visible row in place.
- Prev and Next move a page at a time; the position reads `rows a–b · page n of m`.
- A jump-to-key box, above the summary, opens the list at a key or the first key after it.
- The unsaved summary counts only the rows on screen: modified, added, deleted.
- Saving, discarding, undo and redo are the board's, unchanged: no Save inside the Items section.

## Non-goals

- Contains-search (match text anywhere in a key or value). See Approaches.
- Bulk editing in Acto (pasting thousands of items). Big loads stay on the API and the chat tools.
- Any change to how items are saved or refreshed into Redis (`model/apply`, per-key refresh).
- A count of unsaved changes on other pages. The board's `Save · N` is the only whole-board signal, as today.

## Anti-goals (a failure even if it works)

- A list that scrolls inside the Inspector, or a page size the user has to choose.
- A summary that counts changes the user cannot see.
- A second Save or a separate undo history for items.
- A resize that sends a request per pixel, or loses the user's place.

## Layout (top to bottom, in the Cache tab's Items field)

```
Items · 1,000,001 stored
[ jump to key…            ] [Go] [×]       ← cache-wide, not page-scoped
on this page:  1 modified  1 added  1 deleted   (or: no unsaved changes on this page)
┌ KEY ───────────────┬ VALUE ─────────────────────┬ ┐
│ …as many rows as fit the height, 27 px each…     │
└──────────────────────────────────────────────────┘
‹ Prev   Next ›                rows 1–16 · page 1 of 62,501
[ key ] [ value ] [Add]
```

The jump box sits above the summary because it belongs to the cache, not to the page. The count uses thousands separators.

## Approaches considered (search)

1. **Jump to key (chosen, my call).** Type a key or the start of one; the list opens at the first key that is equal or later in the cache's order. Uses the primary key index `(cache_id, key)`, so it costs the same as any page read at a million items. It also fits the paging, because a jump is just a page that starts somewhere else.
2. **Contains-search.** Match the text anywhere in keys (or values), and page through the matches. Needs a scan of up to a million rows per request without a trigram index (`pg_trgm`), and paging through matches needs its own cursor. More useful for "which keys mention Acme", but heavier on BaseApi and Postgres and a different feature. Left out; can be added later as a filter.
3. **Search in the browser.** Only works on rows already loaded, which is one page. Doesn't answer "where is this key" at all. Rejected.

The user asked for "search or jump to key"; I picked 1. If you meant contains-search, say so and this section changes.

## How it works

### Page size

Rows = floor((list height − header row 24 px) ÷ 27 px), clamped to 5–200 (my call; BaseApi's own maximum is 5,000). Measured with a `ResizeObserver` on the list area, debounced 150 ms, so a drag sends one request.

### Reads (BaseApi changes)

Today `GET /caches/{id}/items` takes `after` (exclusive, forward) and `limit`. This design adds two optional parameters and one response field (my calls):

| Parameter / field | Meaning | Used by |
|---|---|---|
| `from` (new) | first key ≥ `from`, ascending | jump to key; resize keeps the first visible row (re-read `from` = that row) |
| `before` (new) | the `limit` keys < `before`, returned ascending | Prev, exactly one page back at the current size |
| `after` (as today) | keys > `after`, ascending | Next |
| `index` (new, response) | how many keys sort before the page's first row | `page n of m` after a jump, where the position is unknown |

Exactly one of `from`, `before`, `after` may be given (400 otherwise). The 8,000,000-character page budget applies to all three. `index` is a `count(*)` over the primary key up to the first row. Its cost at a million items must be measured in the plan; if it's slow, the fallback is to show `page n of m` only when the position is known from moving forward from the start, and `rows from <key>` otherwise.

Why `before` rather than remembering where earlier pages started: after a resize or a jump, remembered starts are the wrong size or don't exist. With `before`, Prev is always exactly one page of the current size.

### Resize

The first visible row is the anchor. Taller: one read `from` = the anchor with the new `limit`. Shorter: rows drop off the bottom, no request. The position line updates.

### Jump to key

Enter or Go reads `from` = the typed text. If the first row isn't exactly the typed key, a one-line note under the box says `no key "<text>" — showing from the next key`. If no key is at or after it, the list shows the last page and the note says `no key at or after "<text>"`. × clears the box and the note and returns to the first page. The typed text is a key search, so the `:` and 256-character rules for keys don't apply to it (it's never stored).

### Unsaved summary (this page only)

The chips count, among the rows on screen: modified (stored key, changed value), added (key not stored yet), deleted (stored key marked for removal). Recomputed whenever the visible rows change: Next, Prev, jump, resize, or an edit or undo. With none, it reads `no unsaved changes on this page`. Rows keep today's marks: amber for modified, green for added, struck for deleted, ↺ to revert, × to delete.

Today's separate "Unsaved" table above the stored rows goes away. An unsaved added key shows on the page where it sorts: between that page's first and last stored key, using `Intl.Collator('en-US')`. Postgres orders keys with the `en_US.utf8` collation, and the browser's collator is close but not guaranteed identical. So an added key right at a page boundary may show on the neighbouring page. It's still counted wherever it shows, so it's never lost (builder's call to keep this simple).

### Saving, undo, redo

Unchanged. Each item edit (value, add, ×, ↺) is one step in the board's history. Inspector Undo and Redo, the top bar's Discard and `Save · N`, and the 30 MB local refusal all behave as today. An undo of a change on another page takes effect there, and this page's summary changes only if the row is on screen.

### Chat (aligned with the Inspector, user's requirement)

The chat's cache-item tools follow the same rules as the Items list.

- **`read_cache_items`** takes exactly one of `from` (jump to key: the first key equal or later), `before` (the page before a key) or `after` (the page after a key), plus `limit`. The chat has no panel height, so `limit` stays: default 500, at most 5,000, and the answer is still capped at 100,000 characters.
- Its answer gives `item_count`, `index` (keys before the first row), `rows` as `a–b of item_count`, `prev` (pass as `before`; null on the first page) and `next` (pass as `after`; null on the last page). A cut page sets `next` to the last key given, as today. A jump that isn't an exact match carries the same note as the Inspector: `no key "<text>" — showing from the next key`, or `no key at or after "<text>"`.
- **Unsaved changes for this page only.** Each row carries `state`: `modified`, `added` or `deleted`, and no `state` when unchanged. A deleted row stays in the page, marked. Today it's left out. An unsaved added key is placed where it sorts, as in the Inspector. The answer's `unsaved` becomes this page's counts `{modified, added, deleted}`. The whole-cache list of unsaved edits leaves this tool.
- **`read_board` keeps the whole-cache view.** Its per-cache `unsaved_items {set, removed}` stays as it is. That's the chat's equivalent of the board's `Save · N` (my call).
- **`set_cache_items` and `remove_cache_items` are unchanged.** Each call is one undoable edit on the board, saved by the board's Save, the same as an edit in the Inspector.
- Tool descriptions change to match. A never-saved cache still answers with its unsaved items only: they're all `added`, on one page.

## Constraints

- Acto talks only to BaseApi (`src/Acto/src/api/client.ts`). The openapi file and `schema.d.ts` change with the new parameters. `schema.d.ts` is hand-edited, since `npm run gen:api` can't restore its tool here.
- The new parameters are optional, so the chat tool `read_cache_items` and any other caller of `after`/`limit` keep working.
- BaseApi .NET tests run in the SDK container (App Control blocks the rebuilt test DLL on this machine).

## Left to the builder

- Component split inside `CacheItemsTable.tsx` (fit hook, jump box, summary, table).
- Exact empty, loading and error states. Keep today's Retry.
- Tests: Vitest for page size from height, anchor on resize, summary counts per page, jump notes, Prev via `before`, and the chat tool's new answer (states, page counts, cursors, cap). BaseApi tests for `from`, `before`, `index` and the one-of rule. An e2e run against the 1M cache on dev is optional.

## Open (your call)

- Approach 1 versus contains-search (above).
- The 5–200 row clamp.
