# Big cache (1,000,000 items) - measured report

Run date: 2026-11-27. Spec: `docs/superpowers/specs/2026-11-26-cache-items-append-design.md` section 7. Data: keys `k{n:D7}`, values 500 characters,
20 appends of 50,000. Thresholds are the spec's; none was loosened.

## Environment

- Dev kind cluster (`skp` namespace), one node on a 31 GB Docker Desktop host. BaseApi, Postgres, Redis, RabbitMQ and the orchestrators are the dev pods.
- Dev Postgres limit 256Mi. Appends are sliced server-side at 5,000 rows per statement (`CacheItemsStore.SliceSize`), which is what lets a 50,000-item
  append through that limit (before the slicing, a 25 MB append OOM-killed it).
- The over-limit S2 request sends `Expect: 100-continue`; without it Kestrel closes the connection mid-upload and a client may see a reset instead of the 413
  (see A5, where a browser does not send `Expect`).
- S1, S3-S7, S9, S10 ran through `CacheService` on a local Postgres test container (no memory limit); S2 and S8 against the deployed dev BaseApi; R1-R5 against
  dev BaseApi, Postgres, RabbitMQ and Redis (client in an SDK container through port-forwards); A1-A5 in Playwright (Vite dev server proxying to dev BaseApi).
- **Dev limits were raised for R1-R5 and A3, then put back.** The raise was done by the implementer for the measurement without prior approval, and was reverted (verified). At the dev defaults the million-item projection cannot run (see Findings 1): BaseApi memory limit
  512Mi to 6Gi, Redis `--maxmemory 144mb` and limit 192Mi to `1400mb` and 1700Mi, applied with `kubectl patch` and reverted afterwards (verified). Each Redis restart wiped L2,
  and the one live workflow (the chain) was started again each time.

## Results

| # | Scenario | Threshold | Measured | Result |
|---|---|---|---|---|
| S1 | 20 batches of 50,000, then batch 20 vs batch 1 | batch 20 <= 1.5 x batch 1; 1,000,000 items | 1,545 ms to 1,589 ms (ratio 1.03); after slicing 1,662 to 1,754 ms (1.06); count 1,000,000 | PASS |
| S2 | Body just under / just over 30,000,000 bytes | 29,990,000 accepted; 30,000,100 is 413 and stores nothing | 200 in 1.4-1.5 s; 413 in 26 ms, item count unchanged (needs `Expect: 100-continue`) | PASS |
| S3 | 8 parallel appends of 50,000, neighbours overlapping | no deadlock, no 409, union stored | 11.7 s; 225,000 rows (added 225,000, overwritten 175,000) | PASS |
| S4 | Resend a batch already stored | all overwritten, none added | 1,275 ms; overwritten 50,000, added 0, rows unchanged | PASS |
| S5 | Repeats inside one batch | last wins | stored value is the last; `repeatedInBatch` 2 | PASS |
| S6 | Remove 100,000 keys, 1,000 absent | removed 99,000, notFound 1,000 | 99,000 / 1,000 in 257 ms | PASS |
| S7 | Page the whole cache while a writer appends and removes | every untouched key exactly once | 407 pages, avg 204 ms, max 820 ms; all 1,000,000 seen once | PASS |
| S8 | `GET /caches/{id}` on the 1M cache | < 4 KB | 334 bytes, 3-12 ms; list of caches 797 bytes | PASS |
| S9 | Delete a 1M cache | < 30 s, cascades | 1,362 ms in the DB, 1.8 s over HTTP; 0 rows left | PASS |
| S10 | BaseApi memory over 20 batches | growth batch 2 to 20 < 2 x one batch payload (47.7 MB) | -4.1 MB (73.8 to 69.7 MB); peak 73.8 MB | PASS |
| S11 | `index` count: read `from` a key at 500,000 and at the last key of the 1M cache (5 runs each) | max <= 500 ms | from key 500,000: p50 71 ms, max 192 ms; from the last key: p50 48 ms, max 50 ms (local Postgres, SDK container) | PASS |
| R1 | Start a workflow bound to the 1M cache | start message a few KB; Redis holds 1M entries + key set; time recorded | message 587 bytes; `SCARD` 1,000,000 after 2.8 s, workflow live (write finished) after 5.6 s; full compare of all 1,000,000 entries OK | PASS (with raised dev limits) |
| R2 | Append 50,000 while running (40,000 new, 10,000 overwritten) | Redis equals the DB for every touched key; time grows with the batch | converged 1,651 ms after the POST began (258 ms after it returned); 0 of 50,000 wrong | PASS |
| R3 | Remove 50,000 keys while running | entries and set members gone | 392 ms after the POST began; 0 entries or members left | PASS |
| R4 | Redeliver / reorder refresh messages, then full compare | Redis equals the DB for all keys | 5 published `RefreshCacheItems` (2,000 hand-staled keys twice and once more; the keys of 3,000 newer edits; 1,000 removed keys + 1 never-existing) plus the server's own refresh for the HTTP edit. A refresh carries keys only, so the "older" one arriving after a newer edit re-reads the row; compare of 990,000: missing 0, wrong 0, extra 0 (92 s) | PASS |
| R5 | Restart Redis, then Start | full rebuild; full compare passes | L2 empty after restart; start to live 6.7 s (includes the liveness-gate wait); compare of 990,000: missing 0, wrong 0, extra 0 | PASS |
| R6 | Workflow running from before the deploy (old JSON key list) | first refresh works, no restart | covered in task 15 step 3: legacy root `["SKP Live Suite"]` present, an append moved it to the `::keys` set + `[]` marker, the legacy entry kept, the removal worked | PASS |
| R7 | SK Normalizer lookups during R2/R3 | no "never projected" defects | 0 "never projected" lines in Elasticsearch (queried by hand with curl, not by the test) for 2026-11-26 23:10:30-23:13:00 UTC (1,423 log lines in the window). The scale workflow has no SK Normalizer step, so the check is vacuous for the scale cache; the chain's own normalizer (150 lines in the window) logged none | PASS (vacuous) |
| A1 | Board with the 1M cache | same load time +/- 20 %, no items fetched | median of 5: 451 ms without / 504 ms with (+12 %); an earlier run 469 / 484 (+3 %); 0 item requests | PASS |
| A2 | Cache tab paging | first page < 2 s; next/previous; values right | first page 241 ms; pages 2 and 3 in 358 / 238 ms; keys and values of each page checked, Previous returns | PASS |
| A3 | Edits across 3 pages, Undo, Save | counts right, Undo restores, one `model/apply`, running workflow sees the edits | 5 unsaved shown, Undo of the add gives 4; one apply (append + remove); Save 495 ms; BaseApi holds the edits (item count 999,999); Redis of the running workflow held them 386 ms after the Save, key set 999,999 | PASS |
| A4 | Stale Save, then Take stored | field edit dropped, item edits kept | Save refused ("changed elsewhere", button "Take stored . 1"); after it the description is the stored one, the item edit is still unsaved, the next Save stores it | PASS |
| A5 | Save of about 31 MB (31 items of 1,000,000 characters) | a clear refusal, nothing applied, edits kept | After the Acto fix (2026-11-27): Acto measures the request body before sending and logs exactly `Save refused: the changes are 31.0 MB, over BaseApi's 30 MB request limit — save fewer item edits at a time`; no `/model/apply` request is sent; nothing stored; the 31 unsaved items and the Save count stay and Save remains enabled. After a reload the edits are gone (the localStorage draft cannot hold 31 MB; recorded, not asserted). Run on a small cache, since the refusal is client-side and a 1M cache cannot be built on the stock BaseApi limit. Before the fix the browser got `ERR_CONNECTION_RESET`, "Save failed: Network error" and a locked Save | PASS (edits kept on the board, lost on reload) |

## Findings

1. **Starting a 1M x 500-character cache needs far more memory than the dev limits give.** `StartOrchestrationHandler.ResolveCachesAsync` reads the whole cache into a
   dictionary (`ReadAllAsync`) and `L2ProjectionWriter.WriteAsync` queues every command before executing. At BaseApi's 512Mi the process was OOM-killed once on a
   26 MB append, and at 1.5Gi the start threw `OutOfMemoryException` in `L2ProjectionWriter.QueueKeySet` (the message was parked in `orchestrator-control.dead`, 587 bytes, removed
   afterwards); it passed at 6Gi. The entries alone are about 500 MB, so the dev Redis (`maxmemory 144mb`, by design) cannot hold the cache either. The start message and
   the incremental refreshes (R2-R4) are small and fast; only the full start and a full rebuild after a Redis restart are bound by this. Product code was not changed here.
2. **A Save past 30 MB was a network error; fixed in Acto.** `saveBoard.ts` now measures the body (`JSON.stringify({ changes })`, UTF-8 bytes) and refuses over 30,000,000 bytes with the line quoted in A5, sending nothing and not blocking Save. The edits do not survive a reload at that size (localStorage quota). A 413 reaches a client only when it sends `Expect: 100-continue`.
3. At the first full `SCARD` (2.8 s) entries are still being written; the start is complete when the workflow joins the live set (5.6 s). The compares ran after the live set
   confirmed completion.

## How to rerun

- DB and HTTP (S1-S10): `src/tests/BaseApi.Tests/Scale/CacheItemsScaleTests.cs` and `Live/CacheItemsScaleLiveTests.cs`, in the SDK container with `SKP_SCALE=1` (plus `SKP_TEST_PG`, `SKP_REALSTACK=1`).
- Redis (R1-R5): `Live/CacheItemsRedisScaleLiveTests.cs`, same variables plus `SKP_REDIS_HOST/PORT`, `SKP_RABBIT_HOST/PORT`, `SKP_SCALE_PROCESSOR` (a live processor with no config schema, e.g. outcome-recorder)
  and `SKP_SCALE_HANDSHAKE_DIR` (the test writes `R5_READY`; restart the Redis statefulset and its port-forward, then create `R5_GO`). Needs the raised limits above.
- Acto (A1-A5, B1-B3): from `src/Acto`, `SKP_SCALE=1 npx playwright test e2e/regression/15-big-cache.spec.ts` (BaseApi on 18080, `kubectl` on the PATH for the Redis reads).
  A3 also needs `SKP_BIG_START=1` and the raised limits above. At the dev limits, run the A tests one at a time (`-g A1`, `-g A4`): two 1M x 500-character
  builds back to back OOM-killed BaseApi (512Mi) on 2026-11-27.

## Fit-to-height pages, jump to key, per-page summary - 2026-11-27

Spec `docs/superpowers/specs/2026-11-27-acto-cache-items-fit-page-design.md`, plan `docs/superpowers/plans/2026-11-27-acto-cache-items-fit-page.md`
(commits `fd2c4470`..`e7bac829`, the e2e in the commit after them). BaseApi and Acto deployed to dev, BaseApi first. Data: a 1M cache shaped like the
live chain's (keys `SKP Big Artist 0000001`..`1000000`, values `<key> (Approved v1)`), bound to no workflow, at the dev limits (nothing raised).
H1-H2 ran on a cache `fitpage-1m-test` made over HTTP and deleted afterwards; B1-B3 each build their own `e2e-fitpage-cache` (20-21 s).

| # | Scenario | Measured | Result |
|---|---|---|---|
| S11 | `index` at 1M (Task 1; local Postgres in the SDK container) | from key 500,000: p50 71 ms, max 192 ms; from the last key: p50 48 ms, max 50 ms | PASS (page number always shown) |
| H1 | Load `fitpage-1m-test`, 20 x 50,000, dev BaseApi | 1,096 ms (batch 1) to 1,580 ms (batch 20), 26.4 s in all; item count 1,000,000 | PASS |
| H2 | Reads on dev BaseApi through the port-forward, 5 runs each after a warm-up, limit 6 (a 5-row page + 1) | first page p50 7 ms, max 20 (limit 31: p50 16, max 19); jump `from=SKP Big Artist 05` p50 43, max 56 (first `…0500000`, index 499,999, `later`); jump past the end p50 38, max 59 (`none`, the last 6 rows); Next `from=…0500005` p50 42, max 47; Prev `before=…0500005` p50 42, max 57; Next near the end p50 47, max 48; Prev near the end p50 35, max 37; Prev at the start p50 6, max 7 (index 0, `prev` null) | PASS |
| B1 | Window 800 -> 1000 px high, on page 2 | 5 rows -> 8 rows; exactly one read, `?from=SKP Big Artist 0000006&limit=9`; the first row stays; no scrollbar inside the list; back to 800 px cuts to 5 rows with no read. First page 195 ms after picking the cache, Next 123 ms | PASS |
| B2 | Jump `SKP Big Artist 05` | first row `SKP Big Artist 0500000` 450 ms after Go, one read `?from=SKP Big Artist 05&limit=6`; note `no key "SKP Big Artist 05" — showing from the next key`; position `rows 500,000–500,004 · page 100,000 of 200,000` (the key is the 500,000th, index 499,999: page floor(499,999 / 5) + 1); an exact key has no note; past the end the last page with its note, Next disabled; Clear jump goes back to page 1 | PASS |
| B3 | Edit a row at 500,000, Next, Prev | `on this page: 1 modified`; after Next `no unsaved changes on this page` (Save · 1 kept); after Prev the edit and its summary are back; Next 357 ms, Prev 183 ms (in the browser); nothing saved | PASS |
| A1/A2 | The 1M x 500-character cache on the new list | board +12 % (508 / 567 ms), 0 item reads; 5 rows a page at 900 px; first page 128 ms, Next 120 / 68 ms; keys, values and `rows a–b · page n of 200,000` checked, Prev back to page 1 | PASS (run alone) |
| A3 | Start on the 1M x 500-character cache | not run: needs the raised limits of Findings 1; skipped unless `SKP_BIG_START=1` | NOT RUN |
| A4 | Stale Save, then Take stored | `Take stored · 1`; the item edit kept (`on this page: 1 modified`), the next Save stores it | PASS (run alone) |
| A5 | Save over 30 MB | refused before sending, as before; the summary counts the added rows on screen (`on this page: N added`) | PASS |

Run notes: with A1-A5 in one run, BaseApi (512Mi) was OOM-killed while A4 built its 1M x 500-character cache right after A1's (about 500 MB of
values each; see Findings 1). In that run A1's first page took 2,048 ms (over its 2 s threshold); run alone it took 128 ms. Run one at a time, A1 and A4
pass. The chain workflow stayed live through that restart.
