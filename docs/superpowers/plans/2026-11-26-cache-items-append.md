# Cache Items Append / Remove / Paged Read — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a cache grow past one 30 MB request: BaseApi appends, removes and pages items at a cost proportional to the batch; Redis of running workflows follows each edit incrementally; Acto edits items page by page inside Save and Undo; all proven at 1,000,000 items.

**Architecture:** One `cache_items` table stays. A new `CacheItemsStore` does set-based SQL (lock-and-stamp the cache row, `unnest` upsert / `DELETE … ANY`, keyset page) inside whatever transaction is current, so the direct endpoints and `POST /model/apply` share it. Edits send `RefreshCacheItems { cacheId, keys }`; its handler reads each key's current row and SETs/DELs it in Redis, where key names move to a Redis set. The start message carries cache ids, not items; the start handler reads rows. Acto replaces the items text with `itemCount` + an overlay of unsaved item edits.

**Tech Stack:** .NET 8, EF Core + Npgsql (Postgres 18), StackExchange.Redis, RabbitMQ 4.1.8, xunit.v3 (MTP runner); Acto: React + TypeScript, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-26-cache-items-append-design.md`

## Global Constraints

- Request body limit: ASP.NET Core default 30,000,000 bytes — not raised. Acto nginx `client_max_body_size 32m` unchanged.
- Key: 1–256 chars, no `:`. Value: string ≤ 1,048,576 chars (`CacheRules.MaxKeyLength`, `CacheRules.MaxValueChars`).
- Empty `items` / `keys` on append/remove → 400.
- Last write wins: existing key overwritten; a key repeated within one append/remove batch → last occurrence wins, reported.
- Report key lists capped at 1,000 names each (`keysTruncated`).
- Page: `limit` default 500, max 5,000; out of range → 400; order = Postgres order of `key` (column collation), keyset on `key > @after`.
- Refresh messages: ≤ 10,000 keys each. Reach only workflows bound + live + not deleting + root projected at last start.
- Redis key set address: `skp:wf:{wf}:cache:{root}::keys`. Root key stays as the "was projected" marker.
- Start: still a full Redis write of every bound cache; the message carries `(cacheId, root)` only.
- `POST /model/apply`: table `cache_items`, ops `append` (row `{cacheId, items}`) and `remove` (row `{cacheId, keys}`); no `updatedAt` check on them; refreshes sent only after commit; none on `/model/validate`.
- Refresh send failure after commit: no outbox; direct endpoints surface it as today; Save reports a warning naming the caches.
- "Take stored" on a stale cache row keeps that cache's unsaved item edits, drops its field edits.
- .NET tests: MTP runner — `dotnet bin/Debug/net8.0/BaseApi.Tests.dll --filter-class "<Namespace.Class>"`; if App Control blocks the DLL, run in `mcr.microsoft.com/dotnet/sdk:8.0-bookworm-slim` (see memory `dev-machine-quirks`).
- `Messaging.Contracts` is consumed as pinned NuGet 1.0.0: repack in place (`dotnet pack src/Messaging.Contracts -c Release`, delete `~/.nuget/packages/messaging.contracts/1.0.0`, `dotnet restore SK_P.sln --force-evaluate`), commit the changed `packages.lock.json` lines.
- Acto `schema.d.ts` and `openapi/baseapi.v1.json` are hand-edited (`npm run gen:api` can't restore locally).

## Review Focus

1. **Keys that differ only by case, trailing space or punctuation** — must stay distinct, and paging must return each exactly once in the DB's collation order (`after` round-trips). → Task 3 test `PageWalksMixedCaseAndPunctuationKeysOnce`.
2. **Remove-then-re-add the same key before Save** (or add-then-remove a never-stored key) — the overlay must send exactly one op for that key (append, or nothing). → Task 12 tests.
3. **Value at the bound with non-BMP characters** — 1,048,576 UTF-16 chars accepted (e.g. 524,288 emoji), one more refused, through append. → Task 2 test `AppendValueAtBoundAccepted_OneMoreRefused`.
4. **Append to a cache deleted earlier in the same Save, or created in the same Save** — deleted → that change 404s and the Save applies nothing; created → the client id is remapped. → Task 8 tests.
5. **Unsaved item edits survive a browser refresh (session draft) and a Take stored** — and a draft too large for session storage warns rather than silently losing edits. → Task 12 / Task 13 tests.

---

## File Map

**BaseApi.Service (`src/BaseApi.Service/`)**
- `Features/Cache/CacheItemsStore.cs` — **new**: set-based append/remove/page/read SQL.
- `Features/Cache/CacheItemsDtos.cs` — **new**: append/remove/page DTOs and reports.
- `Features/Cache/CacheRefreshSender.cs` — **new**: chunked `RefreshCacheItems` sends.
- `Features/Cache/CacheDtos.cs`, `CacheDtoValidator.cs`, `CacheEntity.cs`, `CacheEntityMapper.cs`, `CacheService.cs`, `CacheController.cs`, `CacheItems.cs`, `CacheServiceCollectionExtensions.cs` — modify.
- `Persistence/Configurations/CacheEntityConfiguration.cs` — drop auto-include; map `ItemCount`.
- `Persistence/Migrations/20261127120000_CacheItemCount.cs` (+ Designer, snapshot) — **new**.
- `Features/Orchestration/Messaging/RefreshCacheItemsHandler.cs` — **new**; `RefreshCacheHandler.cs`, `StartOrchestrationHandler.cs` — modify.
- `Features/Orchestration/Projection/L2ProjectionWriter.cs` — key set, incremental apply, legacy fallback.
- `Features/Orchestration/OrchestrationService.cs`, `Loading/WorkflowGraphLoader.cs` — start carries refs.
- `Features/Molecule/ModelChanges.cs`, `ModelChangesDtos.cs` — `cache_items` ops, report, warnings.

**Messaging.Contracts (`src/Messaging.Contracts/`)**: `RefreshCacheItems.cs` **new**; `MessageTypes.cs`, `WorkflowL1.cs` (+`CacheRefL1`), `Projections/L2ProjectionKeys.cs` modify.

**Tests (`src/tests/BaseApi.Tests/`)**: `Support/PostgresFixture.cs` **new**; `Cache/CacheItemsStoreTests.cs`, `Cache/CacheItemsEndpointsTests.cs`, `Cache/RefreshCacheItemsHandlerTests.cs`, `Cache/CacheKeySetWriteTests.cs`, `Molecule/ModelChangesCacheItemsTests.cs`, `Scale/CacheItemsScaleTests.cs`, `Live/CacheItemsScaleLiveTests.cs` **new**; existing cache/orchestration tests updated.

**Acto (`src/Acto/`)**: `src/api/{schema.d.ts,types.ts,client.ts,toModel.ts,cacheItems.ts,fixtures.ts}`, `src/design/{board.ts,edits.ts,changes.ts,boardStore.ts,saveBoard.ts,boardFixtures.ts}`, `src/inspector/CacheItemsTable.tsx` **new**, `src/inspector/tabs/{CacheTab.tsx,GhostTab.tsx}`, `src/chat/tools/{fields.ts,read.ts,cacheItems.ts (new)}`, `openapi/baseapi.v1.json`, `e2e/{cache.spec.ts,chat-skills.spec.ts,seed.ts,stack.ts}`, `e2e/regression/{11-caches-and-api.spec.ts,15-big-cache.spec.ts (new),README.md,BIG-CACHE-REPORT.md (new)}`.

---

### Task 1: Postgres test fixture

**Files:**
- Create: `src/tests/BaseApi.Tests/Support/PostgresFixture.cs`
- Test: `src/tests/BaseApi.Tests/Support/PostgresFixtureTests.cs`

**Interfaces:**
- Produces: `public sealed class PostgresFixture : IAsyncLifetime` with `AppDbContext NewContext(TimeProvider? clock = null)`, `string ConnectionString`, `static bool Enabled` (env `SKP_TEST_PG` set), `static void SkipUnlessEnabled()`; `[CollectionDefinition("Postgres")] PostgresCollection`. Creates database `skp_test_{guid:N}` on `SKP_TEST_PG`, runs `Database.MigrateAsync()`, drops it on dispose. Contexts get `AuditInterceptor` like `CacheItemsPersistenceTests` does.

- [ ] **Step 1:** Start a throwaway Postgres: `docker run -d --name skp-test-pg -e POSTGRES_PASSWORD=pg -p 15432:5432 postgres:18-alpine`; set `SKP_TEST_PG=Host=localhost;Port=15432;Username=postgres;Password=pg` (in the SDK container: `Host=host.docker.internal`).
- [ ] **Step 2: Failing test** `PostgresFixtureTests.MigratedDatabaseHasCacheItemsTable` — `SkipUnlessEnabled()`; `SELECT count(*) FROM information_schema.tables WHERE table_name = 'cache_items'` == 1.
- [ ] **Step 3:** Run `--filter-class "BaseApi.Tests.Support.PostgresFixtureTests"` → FAIL (type missing).
- [ ] **Step 4:** Implement the fixture.
- [ ] **Step 5:** Run → PASS; unset `SKP_TEST_PG` → SKIPPED.
- [ ] **Step 6: Commit** `test(baseapi): Postgres fixture for set-based cache item tests`.

### Task 2: Item DTOs, validators, item-count column, auto-include off

**Files:**
- Create: `src/BaseApi.Service/Features/Cache/CacheItemsDtos.cs`, `Persistence/Migrations/20261127120000_CacheItemCount.cs` (+ Designer; update `AppDbContextModelSnapshot.cs`)
- Modify: `CacheDtos.cs`, `CacheDtoValidator.cs`, `CacheEntity.cs`, `CacheEntityMapper.cs`, `CacheEntityConfiguration.cs`, `CacheService.cs`, `CacheItems.cs`
- Test: `src/tests/BaseApi.Tests/Cache/CacheDtoValidatorTests.cs`, `CacheModelTests.cs`, `Persistence/CacheItemCountMigrationTests.cs`

**Interfaces:**
- Produces (records in `BaseApi.Service.Features.Cache`):
  - `CacheItemsAppendDto(List<CacheItemDto> Items)`, `CacheItemsRemoveDto(List<string> Keys)`
  - `CacheAppendReport(int Added, int Overwritten, int RepeatedInBatch, List<string> OverwrittenKeys, List<string> RepeatedKeys, bool KeysTruncated)`
  - `CacheRemoveReport(int Removed, int NotFound, int RepeatedInBatch, List<string> NotFoundKeys, List<string> RepeatedKeys, bool KeysTruncated)`
  - `CacheItemsPage(List<CacheItemDto> Items, string? Next)`
  - `CacheCreateDto` / `CacheUpdateDto` **without** `Items`; `CacheReadDto` without `Items`, with `int ItemCount` (after `Root`).
  - `CacheEntity.ItemCount` (int, column `item_count`, not null default 0).
  - `CacheRules`: `ReportKeyCap = 1000`, `PageDefault = 500`, `PageMax = 5000`, `RefreshChunk = 10_000`; `CheckItems(items, ctx, property, refuseRepeats: bool)`; `CheckKeys(keys, ctx, property)`.
  - Validators `CacheItemsAppendDtoValidator` (non-empty, `refuseRepeats: false`), `CacheItemsRemoveDtoValidator` (non-empty, key rules). `CacheItemsUpdateDtoValidator` keeps `refuseRepeats: true`.
- `ItemCount` is a stored count *(plan's call: lets `GET /caches` answer without touching item rows; maintained by append/remove/replace in their transaction)*.

- [ ] **Step 1: Failing tests:** validator — `AppendEmptyRefused`, `AppendRepeatedKeyAccepted`, `AppendValueAtBoundAccepted_OneMoreRefused` (value of 524,288 × "😀" accepted; + "x" refused, message names the key), `RemoveEmptyRefused`, `RemoveKeyWithColonRefused`, `RemoveKey257CharsRefused`; model — `CacheItemsIsNotAutoIncluded` (`NpgsqlModel.Context()` navigation `IsEagerLoaded == false`), `CacheReadDtoHasItemCountNotItems` (reflection); migration — `CacheItemCountMigrationAddsColumnAndBackfills` (Postgres fixture: migrate to `20261126120000_…`, insert a cache + 3 item rows, migrate up, `item_count == 3`).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Migration: add column, `UPDATE caches c SET item_count = (SELECT count(*) FROM cache_items i WHERE i.cache_id = c.id)`. Mapper: ignore `Items` both ways, map `ItemCount` to read. `CacheService.SyncJunctionsAsync` no longer touches items. Remove now-unused `CacheItems.Same`.
- [ ] **Step 4:** Fix compile fallout in existing tests (they built DTOs with `Items`): create caches empty, then seed rows with `CacheItemsStore` (Task 3) or direct `CacheItem` inserts. Run the Cache test classes → PASS.
- [ ] **Step 5: Commit** `feat(baseapi): cache DTOs drop items for itemCount; append/remove DTOs and validators`.

### Task 3: `CacheItemsStore` — append, remove, page, read

**Files:**
- Create: `src/BaseApi.Service/Features/Cache/CacheItemsStore.cs`
- Test: `src/tests/BaseApi.Tests/Cache/CacheItemsStoreTests.cs` (`[Collection("Postgres")]`)

**Interfaces:**
- Produces `internal sealed class CacheItemsStore(BaseDbContext db, TimeProvider clock, IHttpContextAccessor http)`:
  - `Task<CacheAppendReport> AppendAsync(Guid cacheId, IReadOnlyList<CacheItemDto> items, CancellationToken ct)`
  - `Task<CacheRemoveReport> RemoveAsync(Guid cacheId, IReadOnlyList<string> keys, CancellationToken ct)`
  - `Task<CacheItemsPage> PageAsync(Guid cacheId, string? after, int limit, CancellationToken ct)`
  - `Task<Dictionary<string, string>> ReadAllAsync(Guid cacheId, CancellationToken ct)`
  - `Task<Dictionary<string, string?>> ReadKeysAsync(Guid cacheId, IReadOnlyCollection<string> keys, CancellationToken ct)` — value `null` for an absent key.
  - `static (List<CacheItemDto> Items, List<string> Repeated) LastWins(IReadOnlyList<CacheItemDto> items)`; same for keys: `static (List<string> Keys, List<string> Repeated) Distinct(IReadOnlyList<string> keys)`.
  - Throws `NotFoundException(nameof(CacheEntity), id)` when the stamp `UPDATE` affects 0 rows (append/remove) or the cache is absent (page).
- Append/remove SQL order per spec §5.2/§5.3: (1) `UPDATE caches SET updated_at = @now, updated_by = @user, item_count = item_count WHERE id = @id` (locks; `@user` = `HttpContext?.User?.Identity?.Name`, as `AuditInterceptor`); (2) existing-key `SELECT … key = ANY(@keys)`; (3) `unnest` upsert with `IS DISTINCT FROM` / `DELETE … RETURNING key`; (4) `UPDATE caches SET item_count = item_count + @delta`. Uses `db.Database.CurrentTransaction` when present, else opens and commits its own. Parameters as `text[]` arrays.

- [ ] **Step 1: Failing tests:** `AppendAddsRowsAndReportsAdded`; `AppendOverwritesExistingAndReportsOverwritten`; `AppendRepeatsLastWinsAndReported` (`[a=1, a=2]` → stored `2`, `repeatedKeys == ["a"]`); `AppendUnchangedValueNotRewritten` (row `xmin` unchanged); `AppendStampsCacheUpdatedAtAndItemCount`; `AppendToMissingCacheThrowsNotFound`; `ReportKeyListsCapAt1000` (1,500 overwrites → 1,000 names, `KeysTruncated`); `RemoveDeletesAndReportsNotFound`; `RemoveRepeatsCollapsedAndReported`; `ParallelAppendsToOneCacheAllSucceed` (8 contexts, overlapping keys, no exception, final count = union); `PageWalksAllKeysOnce` (2,345 keys, limit 500 → 5 pages, `Next` null at end); `PageWalksMixedCaseAndPunctuationKeysOnce` (`a`,`A`,`a `,`a-b`,`a_b`,`ä`,`Z`,`z` — union of pages == set, no duplicate); `PageLimitOutOfRange` handled at the service (Task 4), not here; `ReadKeysReturnsNullForAbsent`; `AppendInsideOuterTransactionRollsBackWithIt`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(baseapi): set-based cache item store (append, remove, page)`.

### Task 4: Endpoints, service, delete fix, replace path

**Files:**
- Modify: `CacheController.cs`, `CacheService.cs`, `CacheServiceCollectionExtensions.cs`
- Create: `src/BaseApi.Service/Features/Cache/CacheRefreshSender.cs`
- Test: `src/tests/BaseApi.Tests/Cache/CacheItemsEndpointsTests.cs` (Postgres), `CacheItemsUpdateTests.cs`

**Interfaces:**
- Consumes: Task 3 `CacheItemsStore`.
- Creates in `Messaging.Contracts` (repack per Global Constraints): `RefreshCacheItems.cs` — `public sealed record RefreshCacheItems(Guid CacheId, List<string> Keys);`; `MessageTypes.RefreshCacheItems = "refresh-cache-items"`.
- Produces:
  - `CacheRefreshSender(IQueueSender sender)`: `Task SendKeysAsync(Guid cacheId, IReadOnlyCollection<string> keys, CancellationToken ct)` (chunks of `CacheRules.RefreshChunk`, to `OrchestratorQueues.Control`); `Task SendFullAsync(Guid cacheId, CancellationToken ct)` (today's `RefreshCache`). On failure sets `ex.Data["brokerOp"]` as today and rethrows.
  - `CacheService.AppendItemsAsync(Guid id, CacheItemsAppendDto dto, ct) → CacheAppendReport`; `RemoveItemsAsync(Guid id, CacheItemsRemoveDto dto, ct) → CacheRemoveReport`; `PageItemsAsync(Guid id, string? after, int? limit, ct) → CacheItemsPage` (limit default/max per Global Constraints; out of range → `ValidationException` → 400).
  - Routes: `POST {id}/items` → 200 `CacheAppendReport`; `POST {id}/items/remove` → 200 `CacheRemoveReport`; `GET {id}/items?after=&limit=` → 200 `CacheItemsPage`. `PUT {id}/items` unchanged contract.
- `UpdateItemsAsync` (replace) now loads items with an explicit `Include`, applies `CacheItems.Apply`, sets `ItemCount = items.Count`, sends `SendFullAsync`.
- `DELETE /caches/{id}` needs no code: with auto-include off, the DB cascade removes items.

- [ ] **Step 1: Failing tests:** `AppendEndpointReturnsReportAndSendsKeyRefresh` (recording `IQueueSender`: one message, keys = batch); `AppendOf25000KeysSendsThreeRefreshMessages`; `RemoveEndpointSendsKeyRefresh`; `PageEndpointDefaultsTo500`; `PageLimit5001Is400`; `PageLimit0Is400`; `ReplaceItemsSetsItemCountAndSendsFullRefresh`; `DeleteCacheWith10000ItemsCascades` (no `CacheItem` tracked — `ChangeTracker.Entries<CacheItem>()` empty — rows gone); `ListCachesDoesNotReadItemRows` (EF `LogTo` capture contains no `cache_items`).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(baseapi): append, remove and paged read endpoints for cache items`.

### Task 5: Redis key set and incremental cache apply

**Files:**
- Modify: `src/Messaging.Contracts/Projections/L2ProjectionKeys.cs`, `src/BaseApi.Service/Features/Orchestration/Projection/L2ProjectionWriter.cs`
- Test: `src/tests/BaseApi.Tests/Cache/CacheKeySetWriteTests.cs`, update `CacheProjectionWriteTests.cs`, `CacheRefreshWriteTests.cs` (use `Support/InMemoryL2` if it supports sets; otherwise extend it with `SADD/SREM/SMEMBERS/SCARD`)

**Interfaces:**
- Produces:
  - `L2ProjectionKeys.CacheKeySet(Guid workflowId, string root) => $"{Cache(workflowId, root)}::keys"`.
  - `L2ProjectionWriter.ApplyCacheKeysAsync(Guid workflowId, string root, IReadOnlyDictionary<string, string?> current, CancellationToken ct) → Task<bool>` — false when the root is not in the workflow's `roots`; per key: value → `SET entry` + `SADD`; null → `DEL entry` + `SREM`.
  - `WriteAsync` and `WriteCacheAsync`: write the root as `[]` (marker), the set as `DEL` + `SADD` all keys; leftovers come from the set.
  - `private Task<List<string>> ReadKeyNamesAsync(IDatabase db, Guid wf, string root)` — the set's members; **legacy fallback** when the set doesn't exist: the root's JSON list (pre-deploy format); `ApplyCacheKeysAsync` first seeds the set from that list and rewrites the root to `[]`.

- [ ] **Step 1: Failing tests:** `StartWritesKeySetAndEmptyMarkerRoot`; `ApplyAddsEntryAndSetMember`; `ApplyNullDeletesEntryAndSetMember`; `ApplyOnUnprojectedRootReturnsFalseAndWritesNothing`; `ApplySeedsSetFromLegacyJsonRoot` (root `["a","b"]`, no set → after apply of `c`: set = {a,b,c}, root `[]`); `StartLeftoversReadFromSet` (previous set {a,b}, next {a} → entry b deleted); `FullRefreshUsesSet`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement; repack `Messaging.Contracts`. **Step 4:** Run → PASS; `SKNormalizer` test classes still PASS (root marker present).
- [ ] **Step 5: Commit** `feat(projection): cache key names in a Redis set; incremental per-key apply`.

### Task 6: `RefreshCacheItemsHandler`

**Files:**
- Create: `src/BaseApi.Service/Features/Orchestration/Messaging/RefreshCacheItemsHandler.cs`; register beside `RefreshCacheHandler`.
- Modify: `RefreshCacheHandler.cs` (reads items via `CacheItemsStore.ReadAllAsync`, no auto-include)
- Test: `src/tests/BaseApi.Tests/Cache/RefreshCacheItemsHandlerTests.cs`, update `RefreshCacheHandlerTests.cs`

**Interfaces:**
- Consumes: `CacheItemsStore.ReadKeysAsync` (Task 3), `L2ProjectionWriter.ApplyCacheKeysAsync` (Task 5), `RefreshCacheItems` (Task 4).
- Produces: handler for `MessageTypes.RefreshCacheItems`; same filter as `RefreshCacheHandler` (bound ∩ live, `IsDeletingAsync` skipped, unprojected root skipped); missing cache → log + return; empty `CacheId` or null body → `JsonException` (parked).

- [ ] **Step 1: Failing tests:** `AppliesCurrentDbStateForTouchedKeys`; `RemovedKeyIsDeletedFromRedis`; `OutOfOrderMessagesEndAtDbState` (DB a=2; handle message for a twice in any order → Redis a=2); `StoppedWorkflowUntouched`; `DeletingWorkflowSkipped`; `MissingCacheIsAcknowledged`; `EmptyCacheIdParks`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(orchestration): per-key cache refresh handler`.

### Task 7: Start carries cache refs; the handler reads rows

**Files:**
- Modify: `src/Messaging.Contracts/WorkflowL1.cs` (add `public sealed record CacheRefL1(Guid CacheId, string Root);` and trailing optional `List<CacheRefL1>? CacheRefs = null` on `WorkflowL1`), `OrchestrationService.cs` (`ToDefinition`: `Caches = []`, `CacheRefs` from snapshot), `Loading/WorkflowGraphLoader.cs` (no items), `StartOrchestrationHandler.cs` (inject `CacheItemsStore`; resolve each ref with `ReadAllAsync` into `CacheL1` before `WriteAsync`; a ref whose cache is gone is skipped, as `ToDefinition` skips today)
- Test: update `Orchestration/StartDrivenProjectionTests.cs`, `OrchestrationServiceTests`-style `ToDefinition` tests; new `StartMessageCarriesNoItems`

**Interfaces:**
- Consumes: `CacheItemsStore.ReadAllAsync` (Task 3), writer (Task 5).
- Produces: `WorkflowL1.CacheRefs`. Orchestrator compiles unchanged (positional 4-arg construction still valid).

- [ ] **Step 1: Failing tests:** `StartMessageCarriesNoItems` (serialized `StartOrchestration` for a workflow bound to a 10,000-item cache < 8 KB; `CacheRefs` has the id+root); `StartHandlerReadsRowsAtWriteTime` (append after `ToDefinition`, before handle → Redis has the appended value); `StartHandlerSkipsVanishedCache`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement; repack contracts; `dotnet build SK_P.sln` succeeds (Orchestrator included). **Step 4:** PASS (+ `Orchestrator.*` test classes unchanged PASS).
- [ ] **Step 5: Commit** `feat(orchestration): start message carries cache refs; handler reads items`.

### Task 8: Model apply — `cache_items` append/remove, reports, warnings

**Files:**
- Modify: `src/BaseApi.Service/Features/Molecule/ModelChanges.cs`, `ModelChangesDtos.cs`
- Test: `src/tests/BaseApi.Tests/Molecule/ModelChangesCacheItemsTests.cs` (Postgres)

**Interfaces:**
- Consumes: `CacheItemsStore` (Task 3), validators (Task 2), `CacheRefreshSender` (Task 4).
- Produces:
  - `ModelChangeResultDto(..., JsonElement? Problem, JsonElement? Report = null)` — the append/remove report.
  - `ModelApplyResultDto(..., IReadOnlyDictionary<Guid, Guid> Made, IReadOnlyList<string>? Warnings = null)`.
  - In `RunAsync`, before the entity-table lookup: `change.Table == "cache_items"` with `Op` `append` (row → `{cacheId, items}`) or `remove` (row → `{cacheId, keys}`); `cacheId` remapped via `made`; validator then store; no `CheckFreshAsync`. Other ops on `cache_items` → `ModelChangeException`. Error text for unknown tables lists `cache_items` too.
  - Touched `(cacheId, keys)` collected per run; after `CommitAsync` only, `SendKeysAsync` each; a failed send → `Warnings += "cache <name>: running workflows not refreshed (<reason>); they catch up at their next start"`.

- [ ] **Step 1: Failing tests:** `AppendAndRemoveApplyInOneTransaction`; `AppendToCacheCreatedInSameBatchUsesMadeId`; `AppendToCacheDeletedEarlierInBatch404sAndNothingApplied`; `InvalidItemRefusesWholeSave`; `DryRunSendsNoRefresh`; `ApplySendsRefreshAfterCommitOnly` (sender called after commit — recording sender sees committed rows via a fresh context); `RefreshSendFailureBecomesWarning` (applied == true, warning names the cache); `ItemOpsSkipStaleCheck`; `CacheFieldUpdateStillStaleAfterForeignAppend` (409 `code: stale`).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS (+ existing `Molecule.*` classes PASS).
- [ ] **Step 5: Commit** `feat(model): cache item append/remove inside model apply`.

### Task 9: OpenAPI and Acto API layer

**Files:**
- Modify: `src/Acto/openapi/baseapi.v1.json`, `src/Acto/src/api/schema.d.ts`, `types.ts`, `client.ts`, `toModel.ts`, `cacheItems.ts`, `fixtures.ts`
- Test: `src/Acto/src/api/cacheItems.test.ts`, `toModel` tests

**Interfaces:**
- Produces (TS): `CacheItemDto {key; value}`, `CacheItemsPage {items: CacheItemDto[]; next: string | null}`, `CacheAppendReport`, `CacheRemoveReport` (fields as Task 2, camelCase); `CacheReadDto.itemCount`; `ModelChangeResultDto.report?`, `ModelApplyResultDto.warnings?`; `StudioApi.cacheItemsPage(cacheId: string, after?: string | null, limit?: number): Promise<ApiResult<CacheItemsPage>>` (`GET /caches/{id}/items`). Remove `itemsToText`/`itemsFromText`.

- [ ] **Step 1: Failing tests:** `cacheItemsPage builds the query (after encoded, limit)`; `toCacheRow maps itemCount and empty itemEdits`.
- [ ] **Step 2:** `npm test -- src/api` → FAIL. **Step 3:** Implement (hand-edit schema files). **Step 4:** PASS; `npm run typecheck` shows only the errors Tasks 10–13 fix (list them in the commit body).
- [ ] **Step 5: Commit** `feat(acto): API types and client for paged cache items`.

### Task 10: Board model — item overlay, edits, Save changes

**Files:**
- Modify: `src/Acto/src/design/board.ts`, `edits.ts`, `changes.ts`, `boardFixtures.ts`
- Test: `src/Acto/src/design/edits.test.ts`, `changes.test.ts`

**Interfaces:**
- Produces:
  - `export interface ItemEdits { set: Record<string, string>; removed: string[] }`; `CacheRow` drops `items`, gains `itemCount: number; itemEdits: ItemEdits` (server rows: `{set: {}, removed: []}`).
  - `setCacheItem(b, cacheId, key, value): Edit` — refuses with `keyProblem`/`valueProblem` (`model/dict`) reasons; un-removes the key.
  - `removeCacheItem(b, cacheId, key, stored: boolean): BoardState` — stored → into `removed` (and out of `set`); not stored → only out of `set`.
  - `revertCacheItem(b, cacheId, key): BoardState`.
  - `ModelChange.op` adds `'append' | 'remove'`; `Table` adds `'cache_items'`.
  - `boardChanges`: a cache **update** only when fields differ ignoring `itemEdits`; after cache creates/updates and before deletes, per cache with edits (not deleted): `{op:'append', table:'cache_items', id, row:{cacheId:id, items}}` if `set` non-empty, `{op:'remove', …, row:{cacheId:id, keys:removed}}` if `removed` non-empty. No `updatedAt` on them.
  - `changedKeys`/`unsavedMarks`/`affectedWorkflows`: a cache with item edits counts as changed (`cache:<id>`).
  - `addCache` creates `itemCount: 0, itemEdits: {set:{}, removed:[]}`.

- [ ] **Step 1: Failing tests:** `setCacheItem refuses a key with ':'`; `remove then re-add a stored key sends one append and no remove`; `add then remove a never-stored key sends nothing`; `item-only edit sends no caches update`; `field + item edit sends update then append`; `new cache with items sends create then append with the client id`; `deleted cache sends no item ops`; `item edits mark the cache unsaved`.
- [ ] **Step 2:** `npm test -- src/design` → FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(acto): cache item edits as an overlay saved through model apply`.

### Task 11: Save reports, warnings, Take stored keeps item edits

**Files:**
- Modify: `src/Acto/src/design/saveBoard.ts`, `boardStore.ts`
- Test: `src/Acto/src/design/saveBoard.test.ts`, `boardStore.test.ts`

**Interfaces:**
- Consumes: Task 9 result fields, Task 10 rows.
- Produces: after an applied Save, one `ok` line per cache with item ops: `"<cache name>: <added> added, <overwritten> overwritten, <removed> removed"` (+ `", <n> repeated"` when > 0); each `warnings[]` entry logged `warn`. `store.takeStored(fresh)`: for a stale `caches` row present in fresh, present gets `{...fresh row, itemEdits: present row's itemEdits}`; base gets the fresh row. Its output line for caches: `"Took the stored <name> — your field changes are dropped, your item edits are kept (Undo brings them back)"`.

- [ ] **Step 1: Failing tests:** `save logs the item report per cache`; `save logs refresh warnings`; `take stored keeps a stale cache's item edits and drops its field edits`; `draft round-trips item edits` (write draft, new store from session → same `itemEdits`).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(acto): Save reports item counts; Take stored keeps item edits`.

### Task 12: Cache tab — paged items table

**Files:**
- Create: `src/Acto/src/inspector/CacheItemsTable.tsx`, `CacheItemsTable.test.tsx`
- Modify: `src/Acto/src/inspector/tabs/CacheTab.tsx`, `GhostTab.tsx` (show `itemCount`, not items), `inspector/tabs/shared.tsx` or `InspectorPanel.tsx` (thread `StudioApi` to the tab if `Ctx` lacks it); retire `DictEditor` for caches (delete it if nothing else uses it)
- Test: `EntityForm.test.tsx`, `InspectorPanel.test.tsx` cache cases

**Interfaces:**
- Consumes: `StudioApi.cacheItemsPage` (Task 9), `setCacheItem`/`removeCacheItem`/`revertCacheItem` (Task 10).
- Produces: `CacheItemsTable({ cache: CacheRow, isNew: boolean, api: StudioApi, edit })`. Shows `itemCount` (stored) and unsaved counts; a section "Unsaved" listing `itemEdits.set` keys and `removed` keys (each with revert); the stored page (limit 500) with the overlay applied: edited value shown as edited, removed keys struck through with restore; Previous/Next (cursor stack of `after` values); add-key row; cell edit commits on Enter as its own undo step; a page load failure shows the error and a Retry. A new (unsaved) cache shows only the Unsaved section.

- [ ] **Step 1: Failing tests:** `shows the first page and Next`; `Next then Previous returns to page one`; `editing a stored value adds it to the overlay`; `removing a stored key strikes it through and restore reverts`; `adding a key refused with ':' shows the reason`; `a new cache shows only unsaved items`; `page load failure shows Retry`.
- [ ] **Step 2:** `npm test -- src/inspector` → FAIL. **Step 3:** Implement. **Step 4:** PASS; `npm run typecheck` clean except Task 13's chat files.
- [ ] **Step 5: Commit** `feat(acto): paged cache items table in the Cache tab`.

### Task 13: Chat tools follow the overlay

**Files:**
- Create: `src/Acto/src/chat/tools/cacheItems.ts` (+ test)
- Modify: `src/Acto/src/chat/tools/fields.ts` (drop `items` from cache fields and its parse), `read.ts` (caches give `item_count` and `unsaved_items: {set, removed}`, description updated), tool registry, `chat/prompt.ts` if it mentions items text
- Test: `auditTools.test.ts` G3 case updated, `cacheItems.test.ts`

**Interfaces:**
- Produces tools: `read_cache_items {cache_id, after?, limit?}` → stored page with the overlay applied + `next` + `unsaved` (always states it is one page of `item_count`); `set_cache_items {cache_id, items: [{key, value}]}` → `setCacheItem` per item as one board edit (Undo-able, unsaved count); `remove_cache_items {cache_id, keys}` → `removeCacheItem` (stored = not only in `set`) as one edit.

- [ ] **Step 1: Failing tests:** `read_cache_items returns one page and says so`; `set_cache_items is one undo step and marks the cache unsaved`; `set_cache_items refuses a bad key naming it`; `read_board has item_count and unsaved_items, not items`; `set_field refuses items for a cache`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** `npm test` all PASS; `npm run typecheck` clean.
- [ ] **Step 5: Commit** `feat(acto): chat reads and edits cache items page by page through the overlay`.

### Task 14: Existing e2e and regression specs

**Files:**
- Modify: `src/Acto/e2e/cache.spec.ts`, `chat-skills.spec.ts`, `seed.ts`, `stack.ts`, `regression/11-caches-and-api.spec.ts`, `regression/README.md`

- [ ] **Step 1:** Update seeds/stack to create caches empty then `POST …/items`; regression 11 asserts: `GET /caches/{id}` has `itemCount` and no `items`; append/remove/page over HTTP; Cache tab edit → Save → `GET …/items` shows it.
- [ ] **Step 2:** Run `npm run e2e -- e2e/cache.spec.ts e2e/chat-skills.spec.ts` and `npm run e2e:regression` (cluster running, see memory: start the chain after a reboot) → PASS except known pre-existing failures (name them).
- [ ] **Step 3: Commit** `test(acto): e2e follow paged cache items`.

### Task 15: Rollout to dev

- [ ] **Step 1:** Full .NET test run in the SDK container with `SKP_TEST_PG` → PASS except pre-existing failures listed in memory `dev-machine-quirks`.
- [ ] **Step 2:** Build + load BaseApi and Acto images (memory: `docker save … | docker exec -i desktop-control-plane ctr -n k8s.io images import -`); restart BaseApi; confirm migration `20261127120000_CacheItemCount` applied (`__EFMigrationsHistory`).
- [ ] **Step 3:** Without restarting running workflows, `POST /caches/{chain-artists id}/items` with one test key → Redis entry appears, set seeded from the legacy root, root now `[]` (R6). Remove it again.
- [ ] **Step 4:** Restart Acto; open the board; Cache tab pages `chain-artists`.
- [ ] **Step 5: Commit** any manifest changes; update memory `cache-items-child-table` / `cache-items-append-design`.

### Task 16: Big-data proof (spec §7)

**Files:**
- Create: `src/tests/BaseApi.Tests/Scale/CacheItemsScaleTests.cs` (`[Trait("Category","Scale")]`, skip unless `SKP_SCALE=1` and `SKP_TEST_PG`), `src/tests/BaseApi.Tests/Live/CacheItemsScaleLiveTests.cs` (RealStack + `SKP_SCALE=1`), `src/Acto/e2e/regression/15-big-cache.spec.ts` (skip unless `SKP_SCALE=1`), `src/Acto/e2e/regression/BIG-CACHE-REPORT.md`
- Shared generator: keys `k{n:D7}`, values 500 chars deterministic from `n`; 20 batches × 50,000.

- [ ] **Step 1: DB scale tests (S1, S3–S7, S9, S10)** through `CacheService` on the Postgres fixture: `S1_BatchedLoadStaysFlat` (record each batch's ms; assert batch 20 ≤ 1.5 × batch 1, `ItemCount` = 1,000,000); `S3_EightParallelAppends`; `S4_ResendIsAllOverwrite`; `S5_RepeatsLastWins`; `S6_Remove100kWith1kAbsent` (`Removed` 99,000, `NotFound` 1,000); `S7_PageAllDuringWrites` (keys never touched by the concurrent writer each appear exactly once); `S9_DeleteMillionCascades` (< 30 s); `S10_MemoryBounded` (`GC.GetTotalMemory(true)` after each batch; growth from batch 2 to 20 < 2 × one batch's payload). Each test writes its numbers to `TestContext` output.
- [ ] **Step 2: HTTP scale tests (S2, S8)** against dev BaseApi (`RealStack.BaseApiUrl`): `S2_BodyJustUnderLimitAccepted_JustOverIs413` (29,990,000 vs 30,000,100 bytes; the refused batch stores nothing); `S8_ReadsAreSmall` (`GET /caches/{id}` < 4 KB for the 1M cache, response time recorded).
- [ ] **Step 3: Redis live (R1–R7):** `R1_StartOfMillionCache` (start message size from RabbitMQ management API or BaseApi log < 8 KB; Redis `SCARD` = 1,000,000; time recorded); `R2_AppendWhileRunning`; `R3_RemoveWhileRunning`; `R4_RedeliveryAndReorder` (publish the same `RefreshCacheItems` twice and an older one after a newer edit → full compare DB vs Redis over all keys); `R5_RedisRestartThenStart` (`kubectl rollout restart statefulset/redis`, start, full compare); `R6` covered by Task 15 step 3 (record it); `R7_NormalizerNoDefects` (no "never projected" log lines in ES during R2/R3).
- [ ] **Step 4: Acto (A1–A5)** in `15-big-cache.spec.ts`: board opens with the 1M cache within the same time as without it (± 20 %); first page < 2 s; edits across 3 pages + Undo + Save → `GET …/items` shows them and running workflow's Redis has them; stale Save + Take stored keeps item edits; a Save over 30 MB → error logged, nothing applied, edits kept.
- [ ] **Step 5:** Run all with `SKP_SCALE=1`; fill `BIG-CACHE-REPORT.md` with the measured table (batch times, memory, sizes, start time, page times); link it from `regression/README.md`.
- [ ] **Step 6: Commit** `test(cache): big-data proof at 1M items and report`.
