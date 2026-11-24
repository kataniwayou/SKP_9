# Cache Items Child Table Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A cache's items stop being one `jsonb` document capped at 1,048,576 characters and become rows in a `cache_items` child table, sent over the API as a list of `{ key, value }` pairs; the L2 projection stays a key/value dictionary, unchanged.

**Architecture:** `CacheItem` (`cache_id`, `key`, `value`; PK `(cache_id, key)`, cascade with its cache) is an auto-included collection navigation on `CacheEntity`, so every existing `CacheEntity` query keeps seeing the items. Writes go through one helper that diffs the stored rows against the requested pairs (update a kept key in place, delete a dropped one, add a new one) and marks the cache row Modified when anything changed, so `UpdatedAt` and `xmin` still move. The two places that build `CacheL1` turn the rows into the `Dictionary<string,string>` they already pass on; `L2ProjectionWriter`, `CacheL1` and the Redis keys are not touched. The frontends convert at their API boundary only; their internal dictionary text is unchanged.

**Tech Stack:** .NET 8, EF Core 8.0.27 + Npgsql (snake_case names), FluentValidation, Mapperly, xUnit v3 (MTP runner); Acto / WorkflowStudio / Valence: TypeScript, vitest.

**Spec:** this conversation's analysis (2026-11-24) and the user's ruling "b, child table". The decisions it settled are listed under Decisions below.

## Decisions

- API shape everywhere (create, update, read, `PUT /caches/{id}/items`, the design save's `items` field): `"items": [{ "key": "...", "value": "..." }]`. The old JSON-object string is refused.
- Storage: table `cache_items`, columns `cache_id uuid`, `key varchar(256)`, `value text`; `pk_cache_items (cache_id, key)`; `fk_cache_items_cache_id` → `caches(id)` ON DELETE CASCADE. `caches.items` is dropped.
- Limits: **no cap on the dictionary as a whole.** Each key: 1–256 characters, no `:`. Each value: a non-null string up to 1,048,576 characters (`""` allowed). A key twice is refused by name (ordinal comparison, same as Redis and the PK).
- Order: rows have no order. Reads return items ordered by key, ordinal. The design save treats the same pairs in another order as no change.
- `CacheL1`, `L2ProjectionWriter`, `L2ProjectionKeys`, `Messaging.Contracts`: unchanged, so no NuGet repack.
- Frontends keep their internal dictionary text (`items: string`) and convert at the API boundary. Their chat tools, DictEditor and diagrams are untouched apart from the per-entry limits.

## Global Constraints

- Key max length `256` (`CacheRules.MaxKeyLength`), value max `1_048_576` characters (`CacheRules.MaxValueChars`). `CacheRules.MaxItemsChars` is deleted.
- Error messages (the tests match on these substrings): `Items must be a list.` · `Items must not contain a null item.` · `Items must not contain an empty key.` · `Items key '{k}' must not contain ':'.` · `Items key '{k}' must be at most 256 characters.` · `Items value for key '{k}' must be a string.` · `Items value for key '{k}' must be at most 1048576 characters.` · `Items key '{k}' appears more than once.` Every one goes on property `Items`, and only the first offending item is reported (as today).
- Migration name `20261125120000_CacheItemsTable`; the exact SQL is pinned in `CacheItemsTableMigrationTests`.
- Work in the main checkout around the user's uncommitted edits (memory: work-in-main-checkout). Stage only the files each task names.
- .NET tests run as `dotnet bin/Debug/net8.0/BaseApi.Tests.dll --filter-class "<Namespace.Class>"` (MTP; `dotnet test --filter` is ignored). If App Control blocks a freshly built DLL (0x800711C7), run in the `mcr.microsoft.com/dotnet/sdk:8.0-bookworm-slim` container as described in memory `dev-machine-quirks`.

## Review Focus

1. **An existing key longer than 256 characters** — the old validator had no key bound, so the Up migration's insert into `varchar(256)` would fail. The migration must fail loudly rather than truncate. Task 4 checks the live data before applying it.
2. **An items-only edit through any path** (full PUT, `PUT /items`, design save) — the cache row's `UpdatedAt` must advance, or the Acto board's stale-edit check is blind to it. Pinned by `AnItemsOnlyUpdateStampsTheCache` and `AnItemsOnlyDesignChangeStampsTheCache`.
3. **A key kept across an edit while its rows are still tracked** — replacing the collection would throw "another instance with the same key value is already being tracked". Pinned by `AnUpdateOnTheSameTrackedContextAsTheCreateSucceeds` and `AKeptKeyTakesItsNewValueBesideAnAddedKey`.
4. **A client still sending the old string form** (an older Acto/Studio bundle cached in a browser, a script) — a 400 naming `items`, never a silent empty dictionary. Pinned by `ItemsOfAnyOtherShapeAreOneErrorOnTheItemsField`; the CRUD path gets ASP.NET's model-binding 400.
5. **Reading a cache without naming the items** (generic repository, `WorkflowGraphLoader`, `RefreshCacheHandler`, `MoleculeReader`) — it must still see them. Pinned by `ACacheAlwaysLoadsItsItems` and `AnUntrackedQueryOfTheCacheSeesItsItems`.

## File Structure

BaseApi.Service (one compile unit, so Task 1 is one task):
- Create `src/BaseApi.Service/Features/Cache/CacheItem.cs`: the row class.
- Create `src/BaseApi.Service/Features/Cache/CacheItems.cs`: the diff-apply, the read ordering and the dictionary conversion, shared by the service, the design save and the two `CacheL1` builders.
- Create `src/BaseApi.Service/Persistence/Configurations/CacheItemConfiguration.cs`.
- Create migration `src/BaseApi.Service/Persistence/Migrations/20261125120000_CacheItemsTable.cs` (+ `.Designer.cs`, updated `AppDbContextModelSnapshot.cs`).
- Modify `Features/Cache/CacheEntity.cs`, `CacheDtos.cs`, `CacheDtoValidator.cs`, `CacheEntityMapper.cs`, `CacheService.cs`; `Persistence/Configurations/CacheEntityConfiguration.cs`; `AppDbContext.cs`; `Features/Orchestration/OrchestrationService.cs:214-221`; `Features/Orchestration/Messaging/RefreshCacheHandler.cs:77-79`; `Features/Workflow/Design/DesignFields.cs:73-84,108`; `Features/Workflow/Design/SharedStages.cs:150-220`.

Tests: **already written** (red) in this checkout. See the list per task.

---

### Task 1: BaseApi stores items as rows and speaks pairs

**Files:**
- Create: the three BaseApi files and the migration above
- Modify: the BaseApi files above
- Tests (already written, red):
  - `src/tests/BaseApi.Tests/Cache/CacheModelTests.cs` (rewritten)
  - `src/tests/BaseApi.Tests/Cache/CacheDtoValidatorTests.cs` (rewritten)
  - `src/tests/BaseApi.Tests/Cache/CacheItemsUpdateTests.cs` (rewritten)
  - `src/tests/BaseApi.Tests/Cache/CacheItemsPersistenceTests.cs` (new)
  - `src/tests/BaseApi.Tests/Persistence/CacheItemsTableMigrationTests.cs` (new)
  - `src/tests/BaseApi.Tests/WorkflowGraph/DesignFieldsTests.cs` (+3 tests)
  - `src/tests/BaseApi.Tests/WorkflowGraph/DesignSharedStagesTests.cs` (+5 tests)
  - fixtures moved to the new shape: `Cache/CacheDefinitionTests.cs`, `Cache/RefreshCacheHandlerTests.cs`, `Board/BoardLocationTests.cs`, `WorkflowGraph/GraphHarness.cs` (`CacheAsync(root, params (string Key, string Value)[] items)`), `WorkflowGraph/DesignCreateDeleteTests.cs`, `Live/L2AlignmentLiveTests.cs`, `Live/WorkflowDesignLiveTests.cs`

**Interfaces (produces):**
- `public sealed class CacheItem { Guid CacheId; string Key = ""; string Value = ""; }`. Not a `BaseEntity`, like the junctions, so it stays out of the `xmin` loop.
- `CacheEntity.Items : List<CacheItem>` (initialised `[]`)
- `public sealed record CacheItemDto(string Key, string Value)`
- `CacheCreateDto`/`CacheUpdateDto`/`CacheReadDto` keep their positional order, with `string Items` replaced by `List<CacheItemDto> Items`. `CacheItemsUpdateDto(List<CacheItemDto> Items)`.
- `CacheRules.MaxKeyLength = 256`, `CacheRules.MaxValueChars = 1_048_576`, `CacheRules.CheckItems<T>(IReadOnlyList<CacheItemDto>? items, ValidationContext<T> ctx, string property)`
- `internal static class CacheItems`:
  - `static List<CacheItemDto> ToDtos(IEnumerable<CacheItem> rows)`: ordered by key, ordinal
  - `static Dictionary<string, string> ToDictionary(IEnumerable<CacheItem> rows)` and `ToDictionary(IEnumerable<CacheItemDto> items)`: ordinal comparer
  - `static bool Apply(DbContext db, CacheEntity target, IReadOnlyList<CacheItemDto> items)`: diffs `target.Items` (which must be loaded, as auto-include guarantees) against `items`. It sets `Value` on kept keys whose value differs, removes dropped rows from the collection (EF deletes the orphan), and adds new `CacheItem`s. If anything changed it sets `db.Entry(target).State = EntityState.Modified` when the entry was `Unchanged`, and returns `true`.
  - `static bool Same(IReadOnlyList<CacheItemDto> a, IReadOnlyList<CacheItemDto> b)`: equal as sets of pairs, order ignored

- [ ] **Step 1: Confirm the tests are red for the expected reason**

Run: `dotnet build src/tests/BaseApi.Tests -nologo -v q`
Expected: compile errors only for the missing `CacheItem`, `CacheItemDto`, `CacheRules.MaxKeyLength`/`MaxValueChars`, and `List<CacheItemDto>` vs `string` on the cache DTOs and entity. No other kind of error.

- [ ] **Step 2: Entity, row, configuration**

`CacheItem.cs` as above. In `CacheEntity`, replace `string Items` with `List<CacheItem> Items { get; set; } = []` and rewrite the `<c>Items</c>` paragraph of its doc. In `CacheItemConfiguration`:
- `HasKey(CacheId, Key)`
- `Key`: `IsRequired().HasMaxLength(CacheRules.MaxKeyLength)`
- `Value`: `IsRequired().HasColumnType("text")`
- `HasOne<CacheEntity>().WithMany(c => c.Items).HasForeignKey(i => i.CacheId).HasConstraintName("fk_cache_items_cache_id").OnDelete(DeleteBehavior.Cascade)`

In `CacheEntityConfiguration`, drop the `Items` jsonb property and add `entity.Navigation(e => e.Items).AutoInclude()`. Add `public DbSet<CacheItem> CacheItems => Set<CacheItem>();` to `AppDbContext`; the DbSet name is what makes the table `cache_items`.

- [ ] **Step 3: Migration**

Run `dotnet ef migrations add CacheItemsTable` from `src/BaseApi.Service`, rename the file to timestamp `20261125120000`, then order `Up` as:
1. `CreateTable cache_items`
2. `migrationBuilder.Sql("INSERT INTO cache_items (cache_id, key, value) SELECT c.id, e.key, e.value FROM caches c CROSS JOIN LATERAL jsonb_each_text(c.items) e;")`
3. `DropColumn items`

`Down`:
1. `AddColumn items jsonb NOT NULL defaultValue "{}"`
2. `Sql("UPDATE caches c SET items = COALESCE((SELECT jsonb_object_agg(i.key, i.value) FROM cache_items i WHERE i.cache_id = c.id), '{}'::jsonb);")`
3. `DropTable cache_items`

Add a class doc in the style of `RemoveWorkflowCron`, saying why the copy must come before the drop.

- [ ] **Step 4: DTOs and validator**

DTOs as in Interfaces. `CacheRules.CheckItems` checks, in this order: list null → `Items must be a list.`. Then, per item in order: null item → empty or null key → `:` → key length → null value → value length. It tracks seen keys in a `HashSet<string>(StringComparer.Ordinal)` and reports a duplicate at its second occurrence. Each check emits the exact message from Global Constraints and returns after the first failure.

All three validators (`CacheCreateDtoValidator`, `CacheUpdateDtoValidator`, `CacheItemsUpdateDtoValidator`) use `RuleFor(x => x.Items).Custom((items, ctx) => CacheRules.CheckItems(items, ctx, nameof(...Items)))`. Delete `MaxItemsChars`, `Serialize`, and the JSON parsing. Also fix the duplicated `<summary>` above `CacheItemsUpdateDtoValidator`.

- [ ] **Step 5: Mapper and service**

`CacheEntityMapper`:
- generated `ToEntity`: `[MapperIgnoreTarget(Items)]` and `[MapperIgnoreSource(Items)]`; the public `ToEntity` wrapper sets `entity.Items = dto.Items.Select(i => new CacheItem { Key = i.Key, Value = i.Value }).ToList()`
- `UpdateFields`: ignores `Items` both ways. `Update` does **not** touch items, and its doc says so and points to `CacheItems.Apply`.
- `ToRead`: ignores `Items`; the wrapper does `with { Items = CacheItems.ToDtos(entity.Items) }`

`CacheService`:
- override `SyncJunctionsAsync`: on update, call `CacheItems.Apply(DbContext, entity, updateDto.Items)`; on create, do nothing, because `ToEntity` already built the rows
- `UpdateItemsAsync`: pass `dto.Items` straight into the `CacheUpdateDto`; `Serialize` is gone

Update the service's class doc ("no junctions to synchronize" is no longer true).

- [ ] **Step 6: The two `CacheL1` builders**

`OrchestrationService` (~line 217): `new CacheL1(dto!.Root, dto.Items.ToDictionary(i => i.Key, i => i.Value, StringComparer.Ordinal))`.
`RefreshCacheHandler` (~line 78): `new CacheL1(cache.Root, CacheItems.ToDictionary(cache.Items))`, and delete the "parse cannot fail" comment and the `System.Text.Json` using if it is now unused.

- [ ] **Step 7: Design save**

`DesignFields.Apply(CacheUpdateDto ...)`: change `"items" => dto with { Items = ItemsOf(v, key, errors) ?? dto.Items }` and add `private static List<CacheItemDto>? ItemsOf(JsonElement v, string key, List<FieldError> errors)`. It accepts only an array whose every element is an object with string `key` and string `value` properties. Anything else adds one `FieldError("items", "items must be a list of { key, value } pairs.")` and returns null. `DesignFields.UpdateOf(CacheEntity e)` passes `CacheItems.ToDtos(e.Items)`.

`SharedStages`:
- Create branch: the "same row already" tuple compare takes `existing.Items` out of the tuple and adds `&& CacheItems.Same(CacheItems.ToDtos(existing.Items), dto.Items)`.
- Update branch: after `_mapper.Update(dto, entity)`, call `CacheItems.Apply(_db, entity, dto.Items)`. For the log, pass `("items", before.Items, CacheItems.Same(before.Items, dto.Items) ? before.Items : dto.Items)` so that `DesignLogText.Fields`' `Equals` sees the same reference when nothing changed. `items` is already in `Opaque`, so the log line reads "items changed".

- [ ] **Step 8: Regenerate Valence's model-fields snapshot**

Run the test `Molecule.ValenceFieldsSnapshotTests` with `VALENCE_FIELDS_SNAPSHOT=write`, then without the variable.
Expected: `src/Valence/src/api/model-fields.snapshot.json` changes only in the `caches` table's `items` field (type, column null, no rules). If `ModelFields.TypeOf` throws on `List<CacheItemDto>`, map it to `"object[]"` there and add that case to the snapshot test's doc.

- [ ] **Step 9: Run the cache, design, board, molecule and migration suites**

Run, one `--filter-class` each:
- `BaseApi.Tests.Cache.CacheModelTests`, `CacheDtoValidatorTests`, `CacheItemsUpdateTests`, `CacheItemsPersistenceTests`, `CacheDefinitionTests`, `RefreshCacheHandlerTests`, `CacheProjectionWriteTests`, `CacheRefreshWriteTests`
- `BaseApi.Tests.Persistence.CacheItemsTableMigrationTests`
- `BaseApi.Tests.WorkflowGraph.DesignFieldsTests`, `DesignSharedStagesTests`, `DesignCreateDeleteTests`, `DesignLogTests`
- `BaseApi.Tests.Board.BoardLocationTests`
- `BaseApi.Tests.Molecule.ValenceFieldsSnapshotTests`, `ModelRelationsTests`

Expected: all PASS. If `ModelRelationsTests` pins the relation list, `cache_items → caches` is the one new relation; add it to that test's expectation.

Then run the whole suite. Expected: only the pre-existing failures listed in memory `dev-machine-quirks`.

- [ ] **Step 10: Commit**

```bash
git add src/BaseApi.Service src/tests/BaseApi.Tests src/Valence/src/api/model-fields.snapshot.json
git commit -m "feat(cache): items are rows in cache_items, sent as [{key,value}]; no whole-dictionary cap"
```

---

### Task 2: Acto sends and reads pairs

**Files:**
- Create: `src/Acto/src/api/cacheItems.ts`
- Modify: `src/Acto/src/api/toModel.ts:77,113`, `src/Acto/src/design/changes.ts:51-53`, `src/Acto/src/model/dict.ts`, `src/Acto/src/inspector/DictEditor.tsx:2,37` (and wherever a value problem is shown), `src/Acto/src/api/schema.d.ts` (regenerate from BaseApi's OpenAPI, as the repo does; otherwise hand-edit the three cache DTOs' `items` to `{ key: string; value: string }[]`)
- Tests (already written, red): `src/Acto/src/api/cacheItems.test.ts` (new), `src/Acto/src/model/dict.test.ts` (new), `src/Acto/src/api/toModel.test.ts` (+2), `src/Acto/src/design/changes.test.ts` (+1, one changed), `src/Acto/src/api/fixtures.ts` (`items: []`)

**Interfaces:**
- Consumes: BaseApi's `items: { key: string; value: string }[]` from Task 1.
- Produces, in `api/cacheItems.ts`:
  - `export interface CacheItemDto { key: string; value: string }`
  - `itemsToText(items: readonly CacheItemDto[] | null | undefined): string`, which is `dictText` over the pairs
  - `itemsFromText(text: string): CacheItemDto[]`, which is `parseDict`'s entries, throwing `Error(reason)` when it is not ok
- Produces, in `model/dict.ts`: `MAX_KEY_CHARS = 256`, `MAX_VALUE_CHARS = 1_048_576`, and `valueProblem(value: string): string | null` (`Value must be at most 1048576 characters`). `keyProblem` adds `Key must be at most 256 characters` after the `:` check. `MAX_DICT_CHARS` and `textProblem`'s size check are deleted.

- [ ] **Step 1: Run `npx vitest run src/api src/model/dict.test.ts src/design/changes.test.ts` in `src/Acto`.** Expected: FAIL (missing `./cacheItems`, missing exports, `items` mismatches).
- [ ] **Step 2: Implement `api/cacheItems.ts`.** Make `cacheFromDto`/`cacheRowFromDto` use `itemsToText(dto.items)` and `cacheBody` use `itemsFromText(c.items)`. Make the dict.ts bound changes. In `DictEditor`, `committable` stops checking the whole-text length; a row whose value fails `valueProblem` is treated like a key problem (it keeps its last committed entry).
- [ ] **Step 3: Run the same vitest command, then the full `npm test` and `npx tsc --noEmit`.** Expected: PASS, and no type errors (the chat tools and diagramSvg still read `items` as text).
- [ ] **Step 4: Commit.** `git add src/Acto/src && git commit -m "feat(acto): cache items cross the API as [{key,value}]; per-entry limits replace the 1 MB cap"`

---

### Task 3: WorkflowStudio and Valence follow

Studio is being replaced by Acto (memory `acto-studio`), but it is still deployed (`k8s/31-workflow-studio.yaml`), and its design save would start getting 400s on `items`. Keep its change to the boundary only.

**Files:**
- Create: `src/WorkflowStudio/src/api/cacheItems.ts` (same exports as Acto's; Studio's dict module is `store/dict.ts`)
- Modify: `src/WorkflowStudio/src/api/toModel.ts:77`; `src/WorkflowStudio/src/app/saveDesign.ts` (the new-cache `fields` around line 91 and the existing-cache `fields`: whenever `fields.items` is a string, send `itemsFromText(fields.items)`); `src/WorkflowStudio/src/store/dict.ts` and `panels/DictEditor.tsx` (the same bound changes as Acto); `src/WorkflowStudio/src/api/fixtures.ts:26` (`items: []`); `src/Valence/src/api/project.ts:10` (`items?: { key: string; value: string }[]`)
- Test: `src/WorkflowStudio/src/api/cacheItems.test.ts`, a copy of Acto's; `src/WorkflowStudio/src/store/dict.test.ts`, where the `MAX_DICT_CHARS` case at line 20 becomes Acto's three per-entry cases; `src/WorkflowStudio/src/app/saveDesign.test.ts`, plus:

```ts
it('sends a cache\'s items as pairs, for a pasted cache and an edited one', () => {
  // build a request with one pasted cache (items '{"a":"1"}') and one Inspector edit setting items '{"b":"2"}'
  expect(req.newCaches![0]!.fields.items).toEqual([{ key: 'a', value: '1' }]);
  expect(req.caches!.find((c) => c.id === 'c1')!.fields!.items).toEqual([{ key: 'b', value: '2' }]);
});
```
(Use the file's existing request builder and fixtures. The assertions are the contract.)

- [ ] **Step 1: Write the Studio tests and confirm they fail** (`npx vitest run src/api/cacheItems.test.ts src/store/dict.test.ts src/app/saveDesign.test.ts` in `src/WorkflowStudio`).
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Studio `npm test` and `npx tsc --noEmit`; Valence `npm test` and `npx tsc --noEmit`.** Expected: PASS, except Studio's known `e2e/designer.spec.ts` failures (memory), which are not run here anyway.
- [ ] **Step 4: Commit.** `git add src/WorkflowStudio/src src/Valence/src/api/project.ts && git commit -m "feat(studio,valence): cache items as [{key,value}] at the API boundary"`

---

### Task 4: Live rollout check

- [ ] **Step 1: Pre-check the data the migration will copy** (dev Postgres, via the usual port-forward):
```sql
SELECT c.root, e.key, length(e.key) FROM caches c CROSS JOIN LATERAL jsonb_each_text(c.items) e
WHERE length(e.key) > 256 OR e.key = '' OR position(':' in e.key) > 0;
SELECT count(*) AS pairs FROM caches c CROSS JOIN LATERAL jsonb_each_text(c.items) e;
```
Expected: the first query returns no rows. Note the pair count. If it returns rows, stop and ask the user; do not truncate keys.
- [ ] **Step 2: Build and roll out BaseApi, Acto and Studio** (the images and steps the repo's rollout uses; the migration runs at BaseApi startup). Then `SELECT count(*) FROM cache_items;`. Expected: equal to the noted pair count, and `\d caches` shows no `items` column.
- [ ] **Step 3: Run the live tests `Live.L2AlignmentLiveTests` and `Live.WorkflowDesignLiveTests`** (`RealStack` enabled). Expected: PASS. L2 alignment proves the per-key Redis layout is unchanged on start and on refresh.
- [ ] **Step 4: Acto by hand:** open a cache, add 1,500 entries (paste a dictionary of ~1.5 MB), save, reload. Expected: all 1,500 entries come back after the reload, ordered by key (the API reads them by key, not in the order the board sent them). A running workflow bound to the cache gets the refresh (check one `…:cache:{root}:{key}` in Redis).
- [ ] **Step 5: Update memory** with the outcome, and commit any rollout-script change.
