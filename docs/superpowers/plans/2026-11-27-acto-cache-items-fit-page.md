# Acto Cache Items: Fit-to-Height Pages and Jump to Key — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Cache tab's Items list fits the Inspector's height, opens at a typed key, and summarises unsaved changes for the visible rows only; the chat's `read_cache_items` follows the same pages and summary.

**Architecture:** BaseApi's item read gains `from` / `before` anchors and returns the page's position (`index`), `prev` and a `fromMatch` verdict. Acto gets one pure page-view module (merging stored rows with the board's unsaved item edits, per-page counts, cursors), a fit-rows hook, a rewritten `CacheItemsTable`, and the chat tool rebuilt on the same page-view module. Saving, undo and Redis refresh are untouched.

**Tech Stack:** .NET 8 / EF Core / Npgsql (Postgres 18, collation `en_US.utf8`); React + TypeScript, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-27-acto-cache-items-fit-page-design.md` (mock: https://claude.ai/artifact/J2a2QGpsEYJ5i3a1MQKCpL, version 3).

## Global Constraints

- Page size = floor((list height − 24 px header) ÷ 27 px), clamped **5–200**; ResizeObserver debounced **150 ms**.
- Reads: exactly one of `from`, `before`, `after` (none = first page); `limit` default **500**, 1..**5000**; page budget **8,000,000** key + value characters applies to every mode.
- Position line: `rows a–b · page n of m` (en-US thousands separators). Count line: `Items · 1,000,001 stored`.
- Jump notes, verbatim: `no key "<text>" — showing from the next key` and `no key at or after "<text>" — showing the last page`.
- Summary, verbatim: `on this page:` + chips `N modified`, `N added`, `N deleted`; none → `no unsaved changes on this page`.
- No Save, Discard, Undo or Redo inside the Items section; each item edit stays one board history step (`edit()` as today).
- Order of keys = Postgres `en_US.utf8`; Acto places unsaved added keys with `new Intl.Collator('en-US')`.
- Chat `read_cache_items`: default limit 500, max 5,000, answer ≤ **100,000** characters (`READ_TEXT_CAP`); `read_board`'s `unsaved_items` unchanged.
- Don't stage the user's uncommitted files (`k8s/43-processor-analyst.yaml`, `src/Processor.Analyst/Bit/RehearsalGraph.cs`, untracked docs/tools). Work in the main checkout. Commit per task on `feature/acto`; never push.
- .NET tests: MTP runner — `dotnet bin/Debug/net8.0/BaseApi.Tests.dll --filter-class "<Namespace.Class>"`; Postgres tests need `SKP_TEST_PG` (container `skp-test-pg`, :15432). If App Control blocks the DLL, run in `mcr.microsoft.com/dotnet/sdk:8.0-bookworm-slim` (memory `dev-machine-quirks`). Acto: `npx vitest run <file>`, `npx tsc --noEmit` in `src/Acto`.

## Review Focus

1. **A page of only unsaved added keys or an empty stored page** (new cache, or a jump past the last stored key with adds after it): Next / Prev cursors and the summary must still work — Task 3 `cursorsWhenNoStoredRowIsVisible`.
2. **A key removed by someone else between reads** used as a `before` / `from` anchor: the read still returns the neighbouring rows, no error — Task 1 `BeforeAKeyThatNoLongerExistsReturnsTheRowsBeforeIt`.
3. **Typing in the jump box with characters that sort oddly** (lower case, spaces, punctuation): BaseApi's `fromMatch` decides exact / later, not the browser — Task 1 `FromIsCaseAndCollationAware`, Task 4 `jumpNoteComesFromFromMatch`.
4. **Resizing while a page read is in flight**: the late answer for the old size must not overwrite the new one — Task 4 `aStaleReadIsIgnored`.
5. **Edits on a page, then Next and Prev back**: the edits show again on the right rows and the summary counts them again — Task 4 `summaryFollowsTheVisibleRows`.

---

### Task 1: BaseApi reads with `from` / `before`, position and match

**Files:**
- Modify: `src/BaseApi.Service/Features/Cache/CacheDtos.cs:88` (`CacheItemsPage`)
- Modify: `src/BaseApi.Service/Features/Cache/CacheItemsStore.cs:151-186` (`PageAsync`)
- Modify: `src/BaseApi.Service/Features/Cache/CacheService.cs:116-128` (`PageItemsAsync`)
- Modify: `src/BaseApi.Service/Features/Cache/CacheController.cs:55-61`
- Test: `src/tests/BaseApi.Tests/Cache/CacheItemsStoreTests.cs`, `src/tests/BaseApi.Tests/Cache/CacheItemsEndpointsTests.cs`

**Interfaces:**
- Produces:
  - `public enum CachePageMode { Start, After, From, Before }` and `public sealed record CachePageAt(CachePageMode Mode, string? Key)` with `static CachePageAt First`.
  - `public sealed record CacheItemsPage(List<CacheItemDto> Items, string? Next, string? Prev, long Index, string? FromMatch)`. `Next`: last returned key when more keys follow, else null. `Prev`: first returned key when `Index > 0`, else null. `Index`: number of keys sorting before the first returned row (empty page: the cache's row count). `FromMatch`: only for `From`: `"exact"` (first row's key equals `Key`), `"later"`, or `"none"` (no key ≥ `Key`; the page is then the last `limit` rows); null for other modes.
  - `CacheItemsStore.PageAsync(Guid cacheId, CachePageAt at, int limit, CancellationToken ct, long charBudget = CacheRules.PageCharBudget)`; keep `PageAsync(Guid, string? after, int, CancellationToken, long charBudget = …)` as a one-line overload mapping null → `First`, else `After`, so existing tests and the scale/live tests compile unchanged.
  - `CacheService.PageItemsAsync(Guid id, string? after, string? from, string? before, int? limit, CancellationToken ct)`.
  - HTTP: `GET /api/v1/caches/{id}/items?after=|from=|before=&limit=`; JSON adds `prev`, `index`, `fromMatch`.

- [ ] **Step 1: Write the failing store tests** (Postgres collection, seeded as the existing paging tests do)
  - `FromReturnsTheKeyItselfAsExact`: keys `a..j`; `PageAsync(id, new(From,"d"), 3)` → keys `d,e,f`, `Index == 3`, `FromMatch == "exact"`, `Prev == "d"`, `Next == "f"`.
  - `FromBetweenKeysStartsAtTheNextKey`: keys `a,c,e`; `From "b"` → first `c`, `FromMatch == "later"`, `Index == 1`.
  - `FromPastTheEndReturnsTheLastPage`: keys `a..j`; `From "z", limit 3` → `h,i,j`, `FromMatch == "none"`, `Index == 7`, `Next == null`.
  - `BeforeReturnsThePreviousRowsAscending`: keys `a..j`; `Before "g", limit 3` → `d,e,f`, `Index == 3`, `Prev == "d"`, `Next == "f"`.
  - `BeforeNearTheStartReturnsFewerRows`: `Before "b", limit 3` → `a`, `Index == 0`, `Prev == null`.
  - `BeforeAKeyThatNoLongerExistsReturnsTheRowsBeforeIt`: keys `a,b,d`; `Before "c", limit 5` → `a,b`.
  - `FromIsCaseAndCollationAware`: keys `SKP Big Artist 0500000`, `skp live suite`; `From "SKP Live Suite"` → first `skp live suite`, `FromMatch == "later"` (en_US.utf8 orders it there; the test asserts the database's own `ORDER BY key` agrees with the result).
  - `IndexCountsKeysBeforeTheFirstRow`: 1,200 keys; `After` the 500th key → `Index == 500`.
  - `TheCharacterBudgetCutsBeforePagesFromTheFarEnd`: `Before` with `charBudget` that fits 2 of 3 rows → returns the 2 rows nearest the anchor.
- [ ] **Step 2: Run** `--filter-class "BaseApi.Tests.Cache.CacheItemsStoreTests"` → FAIL (types missing).
- [ ] **Step 3: Implement `PageAsync(Guid, CachePageAt, int, …)`.** SQL per mode on the PK `(cache_id, key)`: Start `ORDER BY key`; After `key > @k`; From `key >= @k`; Before `key < @k ORDER BY key DESC` then reverse in memory; `From` with no rows falls back to Before-without-bound (`ORDER BY key DESC LIMIT n`) and `FromMatch = "none"`. Fetch `limit + 1` candidates to know whether more follow (forward modes); for Before, `Next` = last returned key when `EXISTS (key > last)`. Budget: `CutByBudget` over candidates in the direction read (Before: nearest the anchor first). `Index`: `SELECT count(*) FROM cache_items WHERE cache_id=@id AND key < @first` (empty page: `item_count` from `caches`). `FromMatch` "exact" uses SQL equality (`key = @k`), not C# comparison.
- [ ] **Step 4: Run** the store tests → PASS (and the existing paging tests still PASS).
- [ ] **Step 5: Write the failing endpoint tests** in `CacheItemsEndpointsTests`: `GET …/items?from=d&limit=3` → 200 with `index`, `prev`, `fromMatch`; `?after=a&before=b` → 400 naming `after, from, before` (message: `give at most one of after, from, before`); `?from=` (empty) → 400 `from must not be empty`; same for `before`.
- [ ] **Step 6: Implement** the service rule (at most one anchor, non-empty when given; existing limit rule) and the controller's two new `[FromQuery] string?` parameters. Run → PASS.
- [ ] **Step 7: Measure `index` at 1M.** Run `CacheItemsScaleTests` with a new `S11_IndexAtAMillion` (behind `SKP_SCALE=1`): seed 1,000,000 keys, time `From` at key 500,000 and at the last key, 5 runs each; record p50/max in the test output and in `src/Acto/e2e/regression/BIG-CACHE-REPORT.md` (new row "S11 index count"). If max > 500 ms, stop and report — the spec's fallback (page number only when known) then becomes Task 4's behaviour.
- [ ] **Step 8: Commit** `feat(cache): item reads from a key or before it, with position and match`.

### Task 2: Acto API client and types

**Files:**
- Modify: `src/Acto/openapi/baseapi.v1.json` (the `GET /api/v1/caches/{id}/items` parameters and `CacheItemsPage` schema)
- Modify: `src/Acto/src/api/schema.d.ts` (hand-edited: `CacheItemsPage` gains `prev?: string | null; index?: number; fromMatch?: string | null;` and the query parameters)
- Modify: `src/Acto/src/api/client.ts:35,150-153`
- Test: `src/Acto/src/api/cacheItems.test.ts`

**Interfaces:**
- Consumes: Task 1's HTTP shape.
- Produces: `export type ItemsAt = { after: string } | { from: string } | { before: string } | null;` in `src/Acto/src/api/types.ts`; `cacheItemsPage(cacheId: string, at?: ItemsAt, limit?: number): Promise<ApiResult<CacheItemsPage>>`.

- [ ] **Step 1: Write failing tests**: `cacheItemsPage('c1', { from: 'a b' }, 16)` requests `/caches/c1/items?from=a%20b&limit=16`; `{ before: 'x' }` → `before=x`; `{ after: 'k' }` → `after=k`; `null` → no anchor.
- [ ] **Step 2: Run** `npx vitest run src/api/cacheItems.test.ts` → FAIL.
- [ ] **Step 3: Implement**; update the two existing callers to the new signature (`CacheItemsTable.tsx`, `chat/tools/cacheItems.ts`: `after ? { after } : null`) so the tree type-checks.
- [ ] **Step 4: Run** the test file and `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit** `feat(acto): cacheItemsPage reads from, before or after a key`.

### Task 3: Page view and fit rows (pure)

**Files:**
- Create: `src/Acto/src/design/itemsPage.ts`, `src/Acto/src/design/itemsPage.test.ts`
- Create: `src/Acto/src/inspector/useFitRows.ts`, `src/Acto/src/inspector/useFitRows.test.ts`

**Interfaces:**
- Consumes: `ItemEdits` (`{ set: Record<string,string>; removed: string[] }`) from `design/board.ts`.
- Produces:
  - `export type RowState = 'modified' | 'added' | 'deleted';`
  - `export type PageRow = { key: string; value: string; stored: string | null; state?: RowState };` (`stored`: the stored value, null for an added key)
  - `export function pageView(stored: { key: string; value: string }[], edits: ItemEdits, edges: { atStart: boolean; atEnd: boolean }, size: number): PageRow[]` — merges stored rows with edits; an added key (in `edits.set`, not among `stored` keys of this page) is included when it sorts within the page (after the first stored key, or anywhere before it when `atStart`; before the last stored key, or anywhere after it when `atEnd`); sorted with `new Intl.Collator('en-US').compare`; cut to `size`. A stored key in `edits.removed` → `deleted` (value = stored); in `edits.set` with a different value → `modified`.
  - `export function pageSummary(rows: PageRow[]): { modified: number; added: number; deleted: number }`
  - `export function summaryText(s): string` — the Global Constraints wording (`no unsaved changes on this page` / `on this page: …`).
  - `export function fitRows(listHeightPx: number): number` — the clamp 5–200, 27 px rows, 24 px header.
  - `export function useFitRows(ref: RefObject<HTMLElement | null>): number` — ResizeObserver, 150 ms debounce, initial measure without delay.
  - Cursors: `export function cursors(rows: PageRow[]): { after: string | null; before: string | null }` = last / first visible key (stored or added).

- [ ] **Step 1: Write failing tests** in `itemsPage.test.ts`:
  - `marksModifiedAddedDeleted`: stored `a=1,b=2,c=3`, edits `set {b:'9', bb:'x'}`, `removed ['c']`, edges both false, size 10 → `a`, `b`(modified, stored '2'), `bb`(added), `c`(deleted).
  - `addedOutsideThePageIsNotShown`: stored `m,n`, set `{a:'1', z:'2'}`, edges false → only `m,n`.
  - `addedBeforeTheFirstPageIsShownAtStart` / `addedAfterTheLastPageIsShownAtEnd`.
  - `cutsToSize`: 3 stored + 2 added within range, size 4 → 4 rows in collation order.
  - `cursorsWhenNoStoredRowIsVisible`: stored `[]`, set `{a,b}`, both edges true → rows `a,b` added; `cursors` → `{after:'b', before:'a'}`.
  - `summaryTextWording`: `{0,0,0}` → `no unsaved changes on this page`; `{1,2,0}` → `on this page: 1 modified · 2 added` (chips rendered by the component; the text form is for the chat and aria).
  - In `useFitRows.test.ts`: `fitRows(24 + 27*16) === 16`, `fitRows(10) === 5`, `fitRows(100_000) === 200`.
- [ ] **Step 2: Run** both files → FAIL.
- [ ] **Step 3: Implement** both modules.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(acto): page view of cache items with per-page unsaved state`.

### Task 4: Cache tab Items list

**Files:**
- Modify: `src/Acto/src/inspector/CacheItemsTable.tsx` (rewrite of its body; same export and props)
- Modify: `src/Acto/src/app.css` (`.dict*` rules near line 119-140: fixed 27 px rows, the list area `flex: 1; overflow: hidden`, jump row, chips — reuse `--dirty-*` / `--run-*` style tokens from `tokens.css`)
- Modify: `src/Acto/src/inspector/tabs/CacheTab.tsx` only if the Items field needs to fill the remaining Inspector height (the list must not scroll inside)
- Test: `src/Acto/src/inspector/CacheItemsTable.test.tsx` (rewrite)

**Interfaces:**
- Consumes: `cacheItemsPage(id, at, limit)` (Task 2); `pageView`, `pageSummary`, `cursors`, `useFitRows` (Task 3); `setCacheItem`, `removeCacheItem`, `revertCacheItem` from `design/edits` (as today).
- Produces: no new exports. Accessible names the e2e specs will use: textbox `Jump to key`, buttons `Go`, `Clear jump`, `Prev`, `Next`, `Add item`; textboxes `New key`, `New value`; cells `Key <k>`, `Value <k>`; buttons `Remove <k>`, `Revert <k>`, `Restore <k>`; the summary has `role="status"`.

Behaviour, from the spec: count line, jump row, jump note, summary, the fitted table, nav row (`‹ Prev`, `Next ›`, position line), add row. Read requests: first page `null`; Next `{ after: cursors.after }`; Prev `{ before: cursors.before }`; resize taller `{ from: firstVisibleKey }` with the new size; shorter → no request, rows cut; jump `{ from: text }`; Clear → `null`. Prev disabled when the response's `prev` is null; Next disabled when the response's `next` is null and `pageView` cut no rows. Today's separate "Unsaved" table is removed: unsaved rows show in place. Position: `rows index+1–index+storedShown · page floor(index/size)+1 of ceil(itemCount/size)`. A new (never saved) cache shows only its added rows (no reads), as today. Keep today's Retry on a failed read and the refused-key message under the add row. Each value commit, add, ×, ↺ stays one `edit()` call.

- [ ] **Step 1: Write failing tests** (mock `cacheItemsPage` returning pages by anchor; `vi.mock('./useFitRows', …)` so the fitted size is a test-controlled value, 4 unless a test changes it):
  - `readsAPageOfTheFittedSize`: itemCount 10; first call `cacheItemsPage('c1', null, 4)`; 4 rows; position `rows 1–4 · page 1 of 3`; count line `Items · 10 stored`.
  - `nextReadsAfterTheLastVisibleKey` / `prevReadsBeforeTheFirstVisibleKey`.
  - `summaryFollowsTheVisibleRows`: page 1 has one removed key → `on this page: 1 deleted`; Next to a page without edits → `no unsaved changes on this page`; Prev → `1 deleted` again.
  - `jumpReadsFromTheTypedText` and `jumpNoteComesFromFromMatch`: `fromMatch: 'later'` → note `no key "x" — showing from the next key`; `'none'` → `no key at or after "x" — showing the last page`; `'exact'` → no note; Clear → note gone and a `null` read.
  - `growingReadsFromTheFirstVisibleKey`: fitted rows 4 → 6 → `cacheItemsPage('c1', { from: <first key> }, 6)`; shrinking 6 → 3 → no new call.
  - `aStaleReadIsIgnored`: resolve the size-4 read after the size-6 read → table shows the size-6 page.
  - `editsAreBoardStepsAndNoSaveHere`: editing a value then `store.undo()` restores it; no button named `Save` inside the component.
  - `aNewCacheShowsOnlyAddedRows`; `aFailedReadShowsRetry`.
- [ ] **Step 2: Run** `npx vitest run src/inspector/CacheItemsTable.test.tsx` → FAIL.
- [ ] **Step 3: Implement** the component and CSS.
- [ ] **Step 4: Run** the file, `npx vitest run` (whole Acto suite) and `npx tsc --noEmit` → PASS (fix `InspectorPanel.test.tsx`, `EntityForm.test.tsx`, `App.test.tsx` expectations that named the old `Previous` / `Unsaved items` / `N stored` text).
- [ ] **Step 5: Commit** `feat(acto): cache items fit the Inspector, jump to key, per-page unsaved summary`.

### Task 5: Chat `read_cache_items`

**Files:**
- Modify: `src/Acto/src/chat/tools/cacheItems.ts` (`readCacheItems`, `cappedPage`)
- Test: `src/Acto/src/chat/tools/cacheItems.test.ts`

**Interfaces:**
- Consumes: `cacheItemsPage(id, at, limit)` (Task 2); `pageView`, `pageSummary`, `cursors` (Task 3).
- Produces: tool parameters `{ cache_id, from?, before?, after?, limit? }` (more than one anchor → `fail('give at most one of from, before, after', …)`); answer JSON `{ item_count, index, rows: "a–b of N", items: [{key, value, state?}], prev, next, unsaved: {modified, added, deleted}, note }`. Edges for `pageView`: `atStart = index === 0`, `atEnd = next === null`; size = `limit`. `note` keeps today's "one page of … / the last page / cut to 100000 characters" sentence and appends the jump note from `fromMatch` (same wording as the Inspector). Cutting to `READ_TEXT_CAP` keeps today's rules (rows cut from the end, `next` = last included key, a lone oversized first row's value shortened with `value_truncated`).

- [ ] **Step 1: Write failing tests**: `fromJumpsAndNotes` (`fromMatch: 'later'` → note contains `no key "b" — showing from the next key`, call `('c1', {from:'b'}, 500)`); `beforeAndAfterAreCursors` (`prev`/`next` from the page; passing `before` calls `{ before }`); `moreThanOneAnchorIsRefused`; `rowsCarryStateAndDeletedRowsStay` (a removed key stays with `state:'deleted'`; a set key `modified`; an added key in range `added`); `unsavedCountsThisPageOnly` (an added key outside the page isn't counted); `aNeverSavedCacheAnswersItsAddedItems` (no read; every item `state:'added'`, `index 0`, `prev`/`next` null); existing cap tests still pass with the new fields; the description mentions `from`, `before`, `after` and "this page only".
- [ ] **Step 2: Run** `npx vitest run src/chat/tools/cacheItems.test.ts` → FAIL.
- [ ] **Step 3: Implement**; update the tool description to the new contract.
- [ ] **Step 4: Run** the file and the whole suite → PASS.
- [ ] **Step 5: Commit** `feat(acto): chat reads cache items by the same pages and per-page summary`.

### Task 6: e2e specs, rollout to dev, check at 1M

**Files:**
- Modify: `src/Acto/e2e/helpers.ts:280-284`, `src/Acto/e2e/cache.spec.ts`, `src/Acto/e2e/regression/11-caches-and-api.spec.ts`, `src/Acto/e2e/regression/15-big-cache.spec.ts`, `src/Acto/e2e/regression/3-drafts.spec.ts` (only the selectors and texts Task 4 changed)
- Modify: `src/Acto/e2e/regression/BIG-CACHE-REPORT.md` (new section for this run)

- [ ] **Step 1:** Update the specs to Task 4's names. Add to `15-big-cache.spec.ts`: `B1 fits the panel` (resize the browser 800 → 1000 px high → row count grows, one `items?from=` request), `B2 jump` (`SKP Big Artist 05` → first row `SKP Big Artist 0500000`, note `no key "SKP Big Artist 05" — showing from the next key`, position `page n` with n = floor(500,000 ÷ visible rows) + 1), `B3 per-page summary` (edit a row, Next, summary resets, Prev, summary back).
- [ ] **Step 2:** Run the full .NET suite in the SDK container with `SKP_TEST_PG` → PASS except the pre-existing failures in memory `dev-machine-quirks`. Run `npx vitest run` and `npx tsc --noEmit` → PASS.
- [ ] **Step 3:** Build and load the BaseApi and Acto images (memory: `docker save … | docker exec -i desktop-control-plane ctr -n k8s.io images import -`), restart BaseApi then Acto (k8s/README.md order). No migration in this change.
- [ ] **Step 4:** Load a 1M test cache **not bound to any workflow** (`POST /caches`, then 20 × 50k `POST …/items`), run `npm run e2e -- e2e/cache.spec.ts` and `npm run e2e:regression` (chain running; memory: start it after a reboot) → PASS except named pre-existing failures. Then delete the test cache. Leave the chain's `chain-artists` cache as it is.
- [ ] **Step 5:** Record results (timings for first page, jump, Next/Prev at 1M; S11 from Task 1) in `BIG-CACHE-REPORT.md`; update memory `acto-cache-items-fit-page` to built/deployed.
- [ ] **Step 6: Commit** `test(acto): e2e for fitted cache pages, jump and per-page summary`.
