# Cache items: append, remove, paged read — design

Date: 2026-11-26 · Branch: `feature/acto` · Status: approved 2026-11-26

## 1. Intent

A cache's items must be able to grow past what one HTTP request carries. Since 2026-11-24 the items are rows of
`cache_items` (one row per item, primary key `(cache_id, key)`), so storage has no practical bound — but every endpoint
still sends or returns **the whole list**, and the request body is capped by ASP.NET Core's default 30,000,000 bytes
(nothing in BaseApi raises it; Acto's nginx allows 32 MB on `/api/`). Reading the list back has the same problem.

The user wants:

- to **add items in batches** (each batch up to the 30 MB request limit), **remove items by key**, and **read items in pages**;
- **Acto** to edit items through the same paged model, with item edits **inside the board's Save and Undo**;
- edits saved from Acto to reach **running workflows right away**, as `PUT /caches/{id}/items` does today.

## 2. Goals, non-goals, anti-goals

**Goals**
- Append, remove and paged read on BaseApi, each costing in proportion to the batch or page, never to the whole cache.
- Concurrent edits to one cache succeed one after another instead of failing.
- Redis (L2) of running workflows follows each append/remove at a cost proportional to the batch.
- Acto: paged items in the Cache tab; item edits are unsaved changes with Undo; Save stays all-or-none.

**Non-goals**
- Raising the 30 MB request limit.
- A "clear all items" endpoint — `PUT /caches/{id}/items` with `[]` already clears (slowly for a large cache; accepted).
- Changing the workflow start's projection — it stays a full write of every bound cache (the user, 2026-11-26).
- A load-with-tag / swap-without-gap mechanism for replacing a large cache atomically.
- Buckets/chunks of items (considered and rejected, §4).

**Anti-goals** (would make this a failure even if it works)
- An append or remove whose cost grows with the size of the cache (today's update path does this, §3.1).
- Redis ending up different from the database after out-of-order or redelivered refresh messages. (Accepted exception:
  a refresh that fails to send after commit leaves running workflows behind until their next start, §5.5.)
- A Save that applies some of its changes and not others.

## 3. How it works today (what this changes)

### 3.1 BaseApi
- `POST /caches`, `PUT /caches/{id}`, `PUT /caches/{id}/items` all carry the full `items: [{key, value}]` and replace it.
  `GET /caches` and `GET /caches/{id}` return every item of every cache.
- `CacheEntity.Items` is **auto-included** (`CacheEntityConfiguration.cs:25`): every query of a cache loads all its rows.
- `CacheService.UpdateItemsAsync` loads the cache (all rows), then calls `UpdateAsync`, which loads it again tracked;
  `CacheItems.Apply` diffs all rows in memory; `SaveChanges` scans them. Cost per call ∝ total items.
- Each item edit marks the cache row Modified, so `updated_at` and the `xmin` concurrency token move: two concurrent
  edits of one cache → one gets 409.
- `DELETE /caches/{id}` loads the items and EF deletes them one by one (deferred minor point from the 2026-11-24 review).
- Validation (`CacheDtoValidator.cs`): key 1–256 chars, no `:`; value a string ≤ 1,048,576 chars; a key twice → 400.

### 3.2 Acto
- The board loads every cache with all items into its state as dictionary text (`api/toModel.ts:78,114`).
- The Cache tab edits the whole dictionary as one table (`inspector/tabs/CacheTab.tsx`, `DictEditor`).
- Save (`design/saveBoard.ts`) builds model changes (`design/changes.ts`) and sends them to `POST /model/apply`
  (`BaseApi.Service/Features/Molecule/ModelChanges.cs`): every change through the same `BaseService` a PUT uses, one
  transaction, a savepoint per change, commit only if all pass (≤ 500 changes). A cache change carries the full items.
- Acto never calls `PUT /caches/{id}/items`, so **a Save today reaches no running workflow** until its next start.
- The chat's `read_board` returns a cache's items text including unsaved edits (`chat/tools`).

### 3.3 Redis projection
Per workflow (a cache bound to 3 workflows is stored 3 times):
```
skp:wf:{wf}:cache:{root}         → JSON string: every key name ("was projected" marker + key list)
skp:wf:{wf}:cache:{root}:{key}   → value
```
- **Start** (`OrchestrationService.cs:213-216` → `L2ProjectionWriter`): full write of every bound cache, from the cache
  read DTO's `Items`; deletes keys left from the previous start.
- **`PUT /caches/{id}/items`** → `RefreshCache` → `RefreshCacheHandler`: reads the cache with all rows, rewrites the whole
  dictionary in each workflow that is bound, live, not being deleted, and projected this root at its last start;
  deletes keys no longer held (`L2ProjectionWriter.WriteCacheAsync`).
- Readers: processors read the entry key per lookup; the SK Normalizer (`RedisFieldWhitelist.cs`) reads the root key
  only to tell "never projected" (absent → defect) from "empty" (`[]`). The key list itself is read only by BaseApi.
- Redis runs without persistence (`k8s/…redis.yaml`): a Redis restart empties it; the start is what rebuilds.

## 4. Approaches considered

| Approach | Trade-off | Verdict |
|---|---|---|
| **A. One `cache_items` table; append = direct set-based upsert, remove = direct delete, page = keyset read** | Keeps the existing table; each call ∝ batch; one row per key so overwrite/delete are a single index hit | **Chosen** |
| B. Buckets: cache → N `cache_items` groups of up to X items, a new group when one is full | Overwrite and delete must search every bucket; deletes leave half-empty buckets that need compaction; Postgres has no size problem to solve | Rejected (user agreed) |
| C. Raise the request limit, keep whole-list endpoints, bulk-write behind them | No API change, but one request holds the whole cache in memory, all-or-nothing, risks timeouts; reads still return everything | Rejected in favour of A |

Redis refresh after append/remove:

| Approach | Trade-off | Verdict |
|---|---|---|
| **Message carries the touched keys; handler reads each key's current DB state and SETs or DELs** | ∝ batch; order- and redelivery-safe (end state comes from the DB) | **Chosen** |
| Today's full rewrite per edit | ∝ whole cache, per batch — quadratic over a batched load | Rejected |
| Message carries keys + values | ∝ batch, but an out-of-order message can restore an older value | Rejected |

Start: considered skipping a cache whose stamp in Redis matches the DB; **the user chose to leave the start as it is**.

## 5. Design — BaseApi

### 5.1 Endpoints

| Endpoint | Behaviour |
|---|---|
| `POST /caches/{id}/items` | **Append** (§5.2) |
| `POST /caches/{id}/items/remove` | **Remove keys** (§5.3) |
| `GET /caches/{id}/items?after={key}&limit={n}` | **Page** (§5.4) |
| `PUT /caches/{id}/items` | Replace all — **unchanged** behaviour; `[]` clears. Still the full-rewrite refresh. |
| `GET /caches`, `GET /caches/{id}` | **No `items`**; adds `itemCount` (read from the stored `caches.item_count` column, below) |
| `POST /caches`, `PUT /caches/{id}` | **No `items`** (breaking). A cache is created empty; items go through append. |
| `DELETE /caches/{id}` | Same contract; deletes the cache row without loading items; the DB cascade (`fk_cache_items_cache_id`) removes them |

**Stored count (as built).** `itemCount` is a stored column `caches.item_count` (integer, not null, default 0), not a
`count(*)` per read: a listing must never touch the item rows (S8). Migration `20261127120000_CacheItemCount` adds it and
backfills it from the rows already there (`UPDATE caches c SET item_count = (SELECT count(*) FROM cache_items i WHERE
i.cache_id = c.id)`). Append and remove move it by exactly what the batch added or removed, under the cache row lock;
`PUT …/items` and model apply keep it in step the same way, so it cannot drift.

Validation per item is today's (`CacheRules`): key 1–256 chars, no `:`; value a string ≤ 1,048,576 chars.
An empty `items` / `keys` list → 400 *(my call: an empty batch is most likely a caller bug)*.

### 5.2 Append

Request: `{ "items": [ { "key": "a", "value": "1" }, … ] }` (≤ 30 MB body).

1. Validate each item. A key repeated **within the batch**: the **last occurrence wins** and the key is reported
   (the user). This differs from full `PUT`/create, which keep refusing repeats with 400. Done in code before SQL —
   Postgres refuses an `ON CONFLICT` statement that touches one row twice.
2. One transaction:
   1. `UPDATE caches SET updated_at = now(), updated_by = … WHERE id = @id` — 0 rows → 404. This **locks the cache row**:
      concurrent appends/removes on one cache serialize instead of 409-ing, and can't deadlock on overlapping keys.
      Raw SQL bypasses the audit interceptor, so it sets the same audit fields the interceptor would.
   2. `SELECT key FROM cache_items WHERE cache_id = @id AND key = ANY(@keys)` — which keys already exist (for the report;
      accurate because the row lock holds).
   3. Upsert:
      ```sql
      INSERT INTO cache_items (cache_id, key, value)
      SELECT @id, k, v FROM unnest(@keys::text[], @values::text[]) AS t(k, v)
      ON CONFLICT (cache_id, key) DO UPDATE SET value = excluded.value
        WHERE cache_items.value IS DISTINCT FROM excluded.value;
      ```
      Two parameters at any batch size (a `VALUES` list hits Postgres's 65,535-parameter limit at ~32k rows); unchanged
      rows aren't rewritten. Binary `COPY` into a temp table + the same merge is the fallback if this is ever too slow.
   4. Commit, then send the refresh (§5.5).

   **Slicing (as built).** Steps 2 and 3 run per slice of at most **5,000 rows** (`CacheItemsStore.SliceSize`), all slices
   in the one transaction after the one stamp, so there is still one lock, one stamp, one count update and one report.
   Why: one statement over a whole 50,000-item batch passes two `text[]` parameters of ~25 MB that Postgres holds in
   memory at once, and the dev Postgres (256Mi limit) was OOM-killed by it during S2. Slices keep that bounded.
3. Existing key → **overwritten, last write wins** (the user); resending a failed batch is safe.
4. No new indexes — the primary key is all the upsert needs.

Response 200:
```json
{ "added": 49200, "overwritten": 790, "repeatedInBatch": 10,
  "overwrittenKeys": ["a", "k17", "…"], "repeatedKeys": ["x"], "keysTruncated": false }
```
Key lists capped at 1,000 names each; `keysTruncated` true when any list was cut *(my call: an all-overwrite batch would
otherwise echo back as many keys as it sent)*.

### 5.3 Remove

Request: `{ "keys": ["a", "b", …] }`. Key rules as for append. Same transaction shape: lock + stamp (404 if missing),
`DELETE FROM cache_items WHERE cache_id = @id AND key = ANY(@keys) RETURNING key` (per slice of at most 5,000 keys, in the
one transaction, as in §5.2), commit, refresh. A key not stored is
not an error — it is reported; resending is safe. Repeats in the batch are collapsed and reported.

Response 200: `{ "removed": 9800, "notFound": 190, "repeatedInBatch": 10, "notFoundKeys": […], "repeatedKeys": […], "keysTruncated": false }`.

`POST …/remove` rather than `DELETE` with a body *(my call: some clients and proxies drop a DELETE body)*.

### 5.4 Paged read

`GET /caches/{id}/items?after={key}&limit={n}` → `{ "items": [ {key, value}, … ], "next": "<last key>" | null }`.

- Keyset paging on the primary key: `WHERE cache_id = @id AND key > @after ORDER BY key LIMIT @n`. Adds/removes
  between pages never shift or skip items.
- **Order is the database's order of `key`** (the column's collation, which the primary-key index uses), not .NET
  ordinal. `after` must compare in the same collation so the index is used. Clients must not assume ordinal order.
  (Today `CacheItems.ToDtos` sorts ordinal in memory; full reads that keep that are unaffected.)
- `limit`: default 500, maximum 5,000 *(my call)*; out of range → 400. Missing cache → 404.
- **Character budget (as built, final review I3).** A page also stops at **8,000,000** key + value characters
  (`CacheRules.PageCharBudget`): rows are taken in key order while the running total stays within it, so a page of large
  values holds fewer than `limit` rows and carries `next` (the last key returned). The first row is always returned, even
  one alone over the budget, so paging always advances. The cut is chosen from `key` and `char_length(value)` first and
  only the chosen rows' values are then read, so neither Postgres nor BaseApi holds `limit` × 1 MiB at once (500 values
  of 1 MiB would be ~1 GB as UTF-16 in a 512Mi pod). Example: values of 1,048,576 chars with 3-char keys → 7 rows per page.

### 5.5 Redis refresh for append/remove

- After commit, BaseApi sends `RefreshCacheItems { cacheId, keys }` — the **touched keys only, no values** — split into
  messages of ~10,000 keys *(my call)*.
- Handler: same workflow filter as today's `RefreshCacheHandler` (bound, live, not deleting, root projected at last
  start). Reads the touched keys' **current** rows from the DB once; per workflow: key present → `SET` entry + add to the
  key set; absent → `DEL` entry + remove from the key set. End state comes from the DB, so out-of-order or redelivered
  messages are harmless.
- **Key names move to a Redis set** (`SADD`/`SREM`) beside the root, at an address no entry can collide with (entry keys
  can't contain `:`, so e.g. `skp:wf:{wf}:cache:{root}::keys` is safe). The **root key stays** as the "was projected"
  marker, so the SK Normalizer is unchanged. The start and `PUT …/items` write the set too, and find leftovers from it.
- After deploy, a running workflow's root still holds the old JSON list; the writer reads it as the key list when the
  set is absent *(my call; the alternative is "restart running workflows after deploy")*.
- Stopped workflows are not touched; they read the DB at their next start.
- **If sending the refresh fails after commit** (the user, 2026-11-26): accepted — the data is committed and running
  workflows catch up at their next start. The direct endpoints answer as `PUT …/items` does today (the failure surfaces,
  resending is safe); a Save reports a warning naming the cache(s) whose running workflows were not refreshed. No outbox.

### 5.6 Start (Redis write unchanged; where the items come from changes)
The start still writes every bound cache in full (the user). What changes (the user, 2026-11-26, after the builder check):

- Today `OrchestrationService.ToDefinition` puts every bound cache's full items into `CacheL1.Items` inside the
  `StartOrchestration` message. With append a cache can outgrow a broker message (RabbitMQ 4.x default
  `max_message_size` is 16 MiB) and the workflow could not start.
- **The start message carries each bound cache's id and root only.** `StartOrchestrationHandler` (BaseApi, has the DB)
  reads the item rows when it writes Redis, then writes them as today.
- This also closes the start-vs-refresh race: today the start reads items in the HTTP request and writes them later in
  the handler, so a refresh landing in between could be overwritten by older values. Reading at write time removes it.
- `Messaging.Contracts` (`WorkflowL1` / `CacheL1`) changes shape; the start snapshot no longer loads item rows; the
  "payload snapshotted at start" rule now holds for payloads, not cache items (cache items are already live via refresh).

### 5.7 Removing auto-include
`CacheEntity.Items` stops being auto-included. Paths that need items load them explicitly: start snapshot, `PUT …/items`,
`RefreshCacheHandler`. Everything else (list, read, metadata update, model apply of a cache row) touches no item rows.

### 5.8 Model apply (Acto's Save)
*(My call, from the user's 2026-10-17 ruling that Save is all-or-none.)* Item edits join `POST /model/apply` as new
changes so a Save stays one transaction:

- table `cache_items` (as built; the draft said `cacheItems`), ops `append` (row `{ cacheId, items: [{key, value}] }`) and `remove` (row `{ cacheId, keys: […] }`).
  `cacheId` may be a client id of a cache created earlier in the same batch (the existing `made` mapping).
- Each runs the §5.2/§5.3 SQL inside the batch's transaction and savepoint; its report is returned in the change's result.
- No `updatedAt` check on item ops (last write wins per key). A cache **row** update in the same Save is still checked,
  so a Save editing a cache's fields 409s if someone else appended to it meanwhile — as any concurrent edit does today.
- Refresh messages for every touched cache are sent **after** the batch commits; a dry run (`/model/validate`) sends none.
- The 30 MB limit applies to the whole Save request.

## 6. Design — Acto

- **Board state:** caches load without items (only `itemCount`). Per cache, the board holds an **overlay of unsaved
  item edits**: keys set (with value) and keys removed. Undo/redo work on the overlay like any other board edit; the
  cache counts once in the unsaved count while it has item edits (rows are counted per `cache:<id>` key in `changes.ts`). Discarding the board clears it.
- **"Take stored" after a stale-row refusal** (the user, 2026-11-26): drops only the cache's **field** edits and **keeps
  its unsaved item edits** — item ops can't conflict (last write wins per key), and a large paste must not be lost
  because someone else changed the cache's description. Item-only edits never trigger a stale refusal.
- **Cache tab:** shows a page from `GET …/items` with the overlay applied (edited values shown, removed keys marked,
  new keys listed); next/previous paging; editing a cell, adding a key, deleting a key edit the overlay.
- **Save:** `boardChanges` emits `cache_items` `append` / `remove` from the overlay (a new cache: `create` of the
  row, then its `append`). Item ops follow the cache's own create/update in the batch. The append/remove report is shown
  in the Save output (counts).
- **Effect:** saved item edits reach running workflows right away — new for Acto's Save.
- **Local size refusal (as built, A5).** Before sending, Save measures the UTF-8 bytes of exactly the `/model/apply` body;
  over **30,000,000 bytes** (`MAX_REQUEST_BYTES`, BaseApi's request limit) it refuses locally with an error line ("over
  BaseApi's 30 MB request limit — save fewer item edits at a time"), sends nothing and keeps the edits. A browser without
  `Expect: 100-continue` would otherwise see a connection reset rather than the 413.
- `itemsToText`/`itemsFromText` and whole-dictionary text go away for cache items; `DictEditor` is reworked for paged
  rows or replaced.

## 7. Big-data test plan

The point of this work is scale, so it is proven at scale, not only with unit-sized caches (the user, 2026-11-26).
Thresholds are *my call* and are recorded with the measured numbers.

**Reference load:** one cache of **1,000,000 items** (keys `k0000000…`, values ~500 chars), loaded as ~20 appends of
~50,000 items (~26 MB each), plus a second cache with values at the 1 MiB maximum.

### 7.1 BaseApi against a real Postgres (scale suite, run on demand, not in the default test run)
| # | Scenario | Pass |
|---|---|---|
| S1 | Batched load of the reference cache | every batch 200; batch 20's time ≤ 1.5× batch 1's (flat, not growing); final `itemCount` = 1,000,000 |
| S2 | Request size edge | a body just under 30,000,000 bytes → 200; just over → 413; nothing stored by the refused one |
| S3 | 8 parallel appends to one cache, overlapping keys | all 200, no 409, no deadlock; final rows = union, each overlapping key holds one of the sent values |
| S4 | Resend a batch | 200; `overwritten` = batch size, `added` = 0; row count unchanged |
| S5 | Repeats within a batch | last occurrence stored; reported in `repeatedKeys` |
| S6 | Remove 100,000 keys in one request (incl. 1,000 absent) | `removed` = 99,000, `notFound` = 1,000; time ∝ batch |
| S7 | Page through all 1M items (limit 5,000) while appends/removes run | every key present throughout appears exactly once; no page error |
| S8 | `GET /caches`, `GET /caches/{id}` on the 1M cache | no item rows read (query log); response small |
| S9 | `DELETE /caches/{id}` on the 1M cache | one cascade, completes in seconds, BaseApi memory flat |
| S10 | BaseApi memory during S1 | peak bounded by ~a few × one batch, not growing with the cache |

### 7.2 Redis projection (live on dev)
| # | Scenario | Pass |
|---|---|---|
| R1 | Start a workflow bound to the 1M cache | start message has no items (size of a few KB); Redis holds 1M entries + key set; start time recorded |
| R2 | Append a 50k batch while it runs | Redis matches the DB for every touched key; refresh time ∝ batch |
| R3 | Remove 50k keys while it runs | entries and set members gone |
| R4 | Redeliver / reorder refresh messages | Redis still equals the DB (full compare of the 1M cache) |
| R5 | Redis restart, then start | full rebuild; full compare passes |
| R6 | Workflow running from before deploy (old JSON key list) | first refresh after deploy works; no workflow restart needed |
| R7 | SK Normalizer lookups during R2/R3 | no "never projected" defects |

### 7.3 Acto (e2e, against the dev stack)
| # | Scenario | Pass |
|---|---|---|
| A1 | Open the board with the 1M cache | board load doesn't fetch items; opens as fast as without it |
| A2 | Cache tab paging | first page shows quickly; next/previous; values correct |
| A3 | Edit/add/remove items across several pages, Undo, Save | unsaved count right; Undo restores; Save is one `model/apply`; running workflow sees the edits right away |
| A4 | Stale-row Save + "Take stored" | field edits dropped, item edits kept |
| A5 | Save whose items push the request past 30 MB | a clear refusal, nothing applied, edits kept |

Results (timings, memory, sizes) go into a short report next to the regression README.

## 8. Constraints

- ASP.NET Core default request body 30,000,000 bytes; Acto nginx `client_max_body_size 32m` on `/api/`.
- `POST /model/apply`: ≤ 500 changes, one transaction, savepoint per change.
- Redis has no persistence; the start is the only full rebuild.
- `.NET` tests run in the SDK container (App Control blocks the rebuilt test DLL locally).
- Acto's `npm run gen:api` can't restore its tool locally; `schema.d.ts` is hand-edited.

## 9. Left to the builder

- Exact DTO/record names, file layout, how raw SQL is issued (Npgsql command vs EF `SqlQuery`), message type name.
- Whether `PUT …/items` is moved onto the set-based path now (allowed, not required).
- The Cache tab's exact look; whether it gets a key search (allowed via a `prefix` filter on the page endpoint if added).
- How the chat reads and edits items under paging. Constraint: it must go through the same overlay (unsaved edits count,
  Undo applies) and never silently read only the loaded page as if it were the whole cache.
- Updating everything that reads items from the cache DTO: BaseApi tests (`src/tests/BaseApi.Tests/Cache/*`,
  `GraphHarness`), Acto unit tests and fixtures, e2e (`cache.spec.ts`, `chat-skills.spec.ts`,
  `regression/11-caches-and-api.spec.ts`, `seed.ts`, `stack.ts`), `openapi/baseapi.v1.json`, `schema.d.ts`.
- Rollout order on dev (BaseApi before Acto, since the API break lands in both).
