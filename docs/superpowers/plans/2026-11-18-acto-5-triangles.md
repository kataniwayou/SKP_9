# Acto Plan 5 — Triangles over one shared graph — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Acto's frame model with the database's own model: one shared graph of steps, wires and caches, each workflow a draggable triangle pointing at its entry steps, saved board-wide through BaseAPI's existing all-or-nothing `POST /model/apply`.

**Architecture:** BaseAPI gains only nullable locations (`BoardX`/`BoardY`) on steps, caches and workflows, plus a startup fill from old layouts. Acto's state becomes a plain mirror of the database rows (`BoardState`); every edit is a pure function over it; Save diffs the loaded rows against the board's rows and sends them as CRUD changes to `/model/apply`, then dry-runs (`/workflows/{id}/validate`) and republishes the Kibana SVG of every affected workflow. The board renders with React Flow's own handles, connections, edges, selection, minimap and controls.

**Tech Stack:** ASP.NET Core 8 + EF Core (Postgres), Mapperly, FluentValidation, xUnit (MTP runner); React 19, `@xyflow/react` 12.12, Vite, Vitest + Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-18-acto-triangles-design.md` (amends `docs/superpowers/specs/2026-11-17-acto-design.md`; read both — the newer one wins).

## Global Constraints

- **No Acto rule the database (as BaseAPI enforces it) does not have** [user]. A refusal Acto shows is BaseAPI's own answer, or a uniqueness rule BaseAPI enforces (duplicate next step / entry step / cache / assignment id).
- React Flow's own conventions for wiring and look: `<Handle>`, `onConnect` + `isValidConnection`, custom edge components, `selected`, `<MiniMap>`, `<Controls>`, `<Background>` [user].
- Save = one board-wide button; all or nothing; the dry run reports, never blocks or undoes [user].
- A workflow is a triangle: solid arrows only from its tip to each entry step; dashed lines from its back to each cache [user].
- No multi-select of triangles [user]. Steps, wires, caches: Ctrl+click multi-select with the light bar and numbered badges (unchanged).
- Toolbars: triangle = Start/Stop · Delete; step = Copy · Delete; cache = Delete; wire = Delete; entry arrow = Delete; cache line = Delete. Paste = Ctrl+V only; Delete key does nothing; no key hints shown (unchanged user rules).
- One Undo/Redo history for the whole board (Inspector header buttons + Ctrl+Z/Y).
- New workflow: `new-workflow-N`, version `1.0.0`, no cron. New cache: `new-cache-N`, `1.0.0`.
- Acto never reads or writes `Workflow.Layout`; WorkflowStudio is untouched and best-effort.
- Never stage or modify the user's uncommitted files: `k8s/31-workflow-studio.yaml` (holds a real key — never print or commit it), `k8s/32-valence.yaml`, `k8s/43-processor-analyst.yaml`, `src/Processor.Analyst/Bit/RehearsalGraph.cs`, `src/WorkflowStudio/src/canvas/nodes/Chip.tsx`, untracked docs, `.playwright-mcp/`, `.wf-restore.json`, `tools/deck-to-pptx/`, `tools/simulate-unapproved-feed.py`. Stage files by path, never `git add -A`.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (or the model that wrote it).
- Dev machine: .NET tests may be blocked by Windows App Control (0x800711C7) — then run them in `mcr.microsoft.com/dotnet/sdk:8.0-bookworm-slim` as described in memory `dev-machine-quirks`; the test runner is MTP (`dotnet bin/Debug/net8.0/BaseApi.Tests.dll --filter-class "<Ns.Class>"`). No kind CLI: load images with `docker save … | docker exec -i desktop-control-plane ctr -n k8s.io images import -`, then `rollout restart`, then restart the port-forward.
- e2e runs write only throwaway rows they create (names prefixed `e2e-`) and delete them afterwards; never press Start/Stop on a real workflow; never save a processor or schema edit.

## Review Focus

1. **Save order breaks a foreign key** — deleting a step that a workflow enters / an assignment references / another step wires into, in the same Save that removes those references, must pass. Pinned in Task 6 (`orders deletes after the updates that free them`).
2. **Shared payload row edited** — editing workflow A's payload whose row B also links must leave B's payload unchanged after Save. Pinned in Task 5 (`copy-on-write`) and Task 14 (e2e).
3. **Draft restored over newer data** — a reloaded draft whose rows changed elsewhere must be refused at Save as "changed elsewhere", never overwrite. Pinned in Task 6 (`updates carry the stamp the board read`) and Task 8 (`draft keeps its read stamps`).
4. **Deleting a running triangle** — refused with BaseAPI's message, board unchanged. Pinned in Task 9 (`running refusal leaves the board`).
5. **Location erased by an old caller** — a CRUD update without locations (WorkflowStudio, Valence) must keep the stored location. Pinned in Task 1 (`an update without a location keeps it`).

---

## File map

BaseAPI (`src/BaseApi.Service`):
- Modify `Features/Step/StepEntity.cs`, `Features/Cache/CacheEntity.cs`, `Features/Workflow/WorkflowEntity.cs` — `double? BoardX`, `double? BoardY`.
- Modify `Features/{Step,Cache,Workflow}/*Dtos.cs` — trailing optional `double? BoardX = null, double? BoardY = null` on Create, Update and Read DTOs.
- Modify `Features/{Step,Cache,Workflow}/*EntityMapper.cs` — map them; on update, null keeps the stored value.
- Create `Persistence/Migrations/<timestamp>_AddBoardLocations.cs` (+ Designer, snapshot).
- Create `Features/Board/LocationFill.cs` (pure computation) and `Features/Board/LocationFillService.cs` (startup hosted service); register in the Workflow or a new Board service-collection extension.
- Tests: `src/tests/BaseApi.Tests/Board/BoardLocationTests.cs`, `src/tests/BaseApi.Tests/Board/LocationFillTests.cs`.

Acto (`src/Acto/src`), new or rewritten:
- `design/board.ts` — `BoardState` and row types; `boardFromDtos`.
- `design/edits.ts` — every pure edit.
- `design/payloads.ts` — per-workflow assignments, copy-on-write.
- `design/changes.ts` — diff → `ModelChange[]`; `affectedWorkflows`; `changedKeys`.
- `design/boardStore.ts` — rewritten: one history, draft, saving, problems, failures.
- `design/saveBoard.ts` — replaces `saveWorkflow.ts`.
- `design/diagramSvg.ts` — rewritten per workflow.
- `board/loadBoard.ts`, `board/placement.ts`, `board/toFlow.ts`, `board/Board.tsx`, `board/connect.ts` (new), `board/nodes/TriangleNode.tsx` (new), `board/nodes/CacheNode.tsx` (new), `board/nodes/StepCard.tsx`, `board/edges/{LinkWire,EntryEdge,CacheLinkEdge}.tsx`, `board/BoardMiniMap.tsx`, `board/selection.ts`, `board/picks.ts`, `board/selectionBar.ts`.
- `inspector/InspectorPanel.tsx`, `toolbox/ToolboxPanel.tsx`, `operate/{deleteWorkflow,clipboard,runWorkflow}.ts`, `shell/Shell.tsx` (Save button), `App.tsx`.
- `chat/tools/*.ts`, `chat/prompt.ts`, `chat/toolTypes.ts`.
- `api/client.ts` (`listSteps`, `listAssignments`, `applyModel`, `validateModel`), `api/toModel.ts`, `api/schema.d.ts` (regenerated).
- Delete: `design/state.ts`, `design/request.ts`, `design/shared.ts`, `design/drafts.ts`, `design/saveWorkflow.ts`, `design/fixtures.ts` (replaced), `board/layoutDoc.ts`, `board/roles.ts`, `board/cacheChips.ts`, `board/nodes/WorkflowFrame.tsx`, `board/nodes/CacheChip.tsx`, `board/dropTarget.ts` (frame targeting), their tests, and the frame parts of `board/placement.ts`/`board/geometry.ts`.

---

### Task 1: BaseAPI — locations on steps, caches and workflows

**Files:**
- Modify: the three entities, their DTO files, their mappers (see file map)
- Create: migration `AddBoardLocations` (`dotnet ef migrations add AddBoardLocations -p src/BaseApi.Service -o Persistence/Migrations`)
- Test: `src/tests/BaseApi.Tests/Board/BoardLocationTests.cs` (follow the Postgres-backed style of `src/tests/BaseApi.Tests/Cache/WorkflowCacheJunctionTests.cs`)

**Interfaces:**
- Produces: JSON fields `boardX`, `boardY` (number | null) on `StepReadDto`, `CacheReadDto`, `WorkflowReadDto` and accepted on their create/update DTOs; columns `BoardX`, `BoardY` (`double precision`, nullable).

- [ ] **Step 1: Write the failing tests**

```csharp
[Fact] public async Task AStepKeepsTheLocationItWasCreatedWith()
{   // POST a step with BoardX 120.5, BoardY -40 → GET returns 120.5, -40
}
[Fact] public async Task AnUpdateWithALocationMovesIt()
{   // PUT the step with BoardX 300, BoardY 10 → GET returns 300, 10
}
[Fact] public async Task AnUpdateWithoutALocationKeepsIt()
{   // PUT the step with BoardX/BoardY null → GET still returns 300, 10
}
[Fact] public async Task CachesAndWorkflowsCarryLocationsTheSameWay()
{   // the three cases above for a cache and a workflow
}
```

- [ ] **Step 2: Run them to see them fail** — `dotnet build src/tests/BaseApi.Tests && dotnet src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.dll --filter-class "BaseApi.Tests.Board.BoardLocationTests"` → compile errors (no `BoardX`).

- [ ] **Step 3: Implement.** Add the properties to the three entities; trailing optional parameters `double? BoardX = null, double? BoardY = null` on the six create/update records and the three read records (existing positional call sites keep compiling). In each mapper's update, set `BoardX`/`BoardY` only when the DTO's value is non-null (Mapperly: ignore the members in the generated update and assign in a partial wrapper). Generate the migration; check it only adds six nullable columns.

- [ ] **Step 4: Run the class again** → PASS. Then the whole suite's Step/Cache/Workflow classes (`--filter-class` for `WorkflowCacheJunctionTests`, `NullCollectionCascadeTests`, `DesignFieldsTests`, `WorkflowReadEnrichmentTests`) → PASS.

- [ ] **Step 5: Commit** — `feat(baseapi): optional board locations on steps, caches and workflows`.

### Task 2: BaseAPI — fill missing locations from old layouts at startup

**Files:**
- Create: `Features/Board/LocationFill.cs`, `Features/Board/LocationFillService.cs`; register the hosted service after the migration runner
- Test: `src/tests/BaseApi.Tests/Board/LocationFillTests.cs` (pure unit tests on `LocationFill`)

**Interfaces:**
- Produces: `internal static class LocationFill { public static LocationPlan Compute(IReadOnlyList<LayoutSource> workflows, IReadOnlySet<Guid> stepsWithoutLocation, IReadOnlySet<Guid> cachesWithoutLocation, IReadOnlySet<Guid> workflowsWithoutLocation, IReadOnlyDictionary<Guid, Guid[]> entryStepsOf); }` with `record LayoutSource(Guid WorkflowId, DateTime UpdatedAt, string? Layout)` and `record LocationPlan(IReadOnlyDictionary<Guid,(double X,double Y)> Steps, IReadOnlyDictionary<Guid,(double X,double Y)> Caches, IReadOnlyDictionary<Guid,(double X,double Y)> Workflows)`.

Layout JSON as Acto and WorkflowStudio wrote it: `{ "steps": { "<id>": {x,y} }, "caches": { "<id>": {x,y} }, "board": {x,y,w,h}? }`. A step's board position is `board.x + steps[id].x`, `board.y + 46 + steps[id].y` when `board` exists (46 = Acto's frame header height, `HEADER_H` in `src/Acto/src/board/geometry.ts`), else `steps[id]` as is. Same for caches. A workflow without location goes at its first entry step's computed position minus `(160, 0)`.

- [ ] **Step 1: Write the failing tests**

```csharp
[Fact] public void AStepTakesItsPositionFromTheNewestLayoutThatPlacesIt()   // two layouts place S; the later UpdatedAt wins
[Fact] public void TheOldActoFrameOffsetIsAdded()                          // board {x:1000,y:500}, step {x:20,y:30} → (1020, 576)
[Fact] public void OnlyMissingLocationsAreFilled()                         // a step not in stepsWithoutLocation is absent from the plan
[Fact] public void ATriangleGoesLeftOfItsFirstEntryStep()                  // entry step at (400,200) → workflow (240,200)
[Fact] public void MalformedLayoutsAreIgnored()                            // "not json", "[]", {steps:{a:"x"}} → empty plan, no throw
```

- [ ] **Step 2: Run** `--filter-class "BaseApi.Tests.Board.LocationFillTests"` → FAIL (no type).
- [ ] **Step 3: Implement `LocationFill.Compute`** with `System.Text.Json`, and `LocationFillService : IHostedService` that reads the null-location rows and the workflows' `Layout`/`UpdatedAt`/entry steps, applies the plan with `ExecuteUpdate`-style writes **that do not touch `UpdatedAt`** (a location fill must not make Acto's next save look stale), logs how many it filled, and never throws out of `StartAsync` (log and continue).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(baseapi): fill missing board locations from old layouts at startup`.

### Task 3: Deploy BaseAPI and regenerate Acto's API types

**Files:**
- Modify: `src/Acto/src/api/schema.d.ts` (generated), `src/Acto/src/api/types.ts`

**Interfaces:**
- Produces: TS types `ModelChangesDto`, `ModelChangeDto`, `ModelApplyResultDto`, `ModelValidateResultDto`, `ModelChangeResultDto`, and `boardX`/`boardY` on step/cache/workflow DTOs, exported from `api/types.ts`.

- [ ] **Step 1:** `docker build -f src/BaseApi.Service/Dockerfile -t baseapi-service:local .`, import into the node, `kubectl -n skp rollout restart deploy/baseapi-service`, `rollout status`, restart the 18080 port-forward if it dropped.
- [ ] **Step 2: Verify** — `curl -s localhost:18080/api/v1/steps | head -c 400` shows `"boardX"`; the pod log shows the fill's count line; `curl -s localhost:18080/api/v1/workflows` still lists the 5 workflows.
- [ ] **Step 3:** `cd src/Acto && npm run gen:api`; export the types above from `api/types.ts`; `npm run typecheck` → clean.
- [ ] **Step 4: Commit** — `chore(acto): regenerate API types for board locations and model changes`.

### Task 4: Acto — `BoardState` and the graph edits

**Files:**
- Create: `src/Acto/src/design/board.ts`, `src/Acto/src/design/edits.ts`, `src/Acto/src/design/boardFixtures.ts`
- Test: `src/Acto/src/design/edits.test.ts`

**Interfaces:**
- Produces (`design/board.ts`):

```ts
export interface StepRow { id: Id; name: string; version: string; description: string | null; processorId: Id | null;
  nextStepIds: Id[]; entryCondition: number; at: Point | null; updatedAt: string | null }   // updatedAt null = created on the board
export interface CacheRow { id: Id; name: string; version: string; description: string | null; root: string; items: string; at: Point | null; updatedAt: string | null }
export interface WorkflowRow { id: Id; name: string; version: string; description: string | null; cronExpression: string | null;
  entryStepIds: Id[]; assignmentIds: Id[]; cacheIds: Id[]; at: Point | null; updatedAt: string | null }
export interface AssignmentRow { id: Id; stepId: Id; name: string; version: string; description: string | null; payload: string; updatedAt: string | null }
export interface ProcessorRow extends Processor { updatedAt: string }
export interface SchemaRow extends Schema { updatedAt: string | null }
export interface BoardState { workflows: Record<Id, WorkflowRow>; steps: Record<Id, StepRow>; caches: Record<Id, CacheRow>;
  assignments: Record<Id, AssignmentRow>; processors: Record<Id, ProcessorRow>; schemas: Record<Id, SchemaRow> }
export type Edit = { state: BoardState } | { refused: string };
export type ItemRef = { kind: 'step' | 'cache' | 'workflow'; id: Id };
export function reachOf(b: BoardState, workflowId: Id): Set<Id>;   // steps reachable from its entry steps (reuse model/reachability.ts)
```

- Produces (`design/edits.ts`): `addStep(b, processor: Processor, at: Point, id: Id)`, `addCache(b, at, id)`, `addWorkflow(b, at, id)` (names `new-workflow-N` / `new-cache-N`, smallest free N, version `1.0.0`), `moveItems(b, moved: { ref: ItemRef; at: Point }[])`, `addWire(b, from, to): Edit`, `removeWires(b, wires: [Id, Id][])`, `addEntry(b, wf, step): Edit`, `removeEntries(b, pairs: [Id, Id][])`, `linkCache(b, wf, cache): Edit`, `unlinkCaches(b, pairs: [Id, Id][])`, `deleteSteps(b, ids: Id[])`, `deleteCaches(b, ids: Id[])`, `setWorkflowField(b, id, field, value)`, `setStepField(b, id, field, value)`, `setCacheField(b, id, field, value)` — all return a new `BoardState` (or `Edit`) and never mutate.

- [ ] **Step 1: Write the failing tests** (fixture: two workflows `daily`, `hourly` both entering `fetch`; `fetch → expand`; cache `c1` linked by `daily`; one orphan step `lonely`):

```ts
it('adds a wire once; the same wire again is refused', () => {
  const r = addWire(board(), 'fetch', 'lonely'); expect('state' in r && r.state.steps.fetch.nextStepIds).toEqual(['expand', 'lonely']);
  expect(addWire(board(), 'fetch', 'expand')).toEqual({ refused: 'That wire already exists' });
});
it('allows a wire from a step to itself (the dry run reports the cycle)', () => {
  expect('state' in addWire(board(), 'fetch', 'fetch')).toBe(true);
});
it('adds an entry arrow once', () => {
  expect(addEntry(board(), 'daily', 'fetch')).toEqual({ refused: 'daily already starts at fetch-orders' });
});
it('deleting a step removes its wires, the entry arrows into it and every payload on it', () => {
  const s = deleteSteps(board(), ['fetch']);
  expect(s.steps.fetch).toBeUndefined();
  expect(s.workflows.daily.entryStepIds).toEqual([]);
  expect(Object.values(s.assignments).some(a => a.stepId === 'fetch')).toBe(false);
  expect(s.workflows.daily.assignmentIds.every(id => s.assignments[id])).toBe(true);
});
it('deleting a cache unlinks it from every workflow', () => { /* daily.cacheIds no longer has c1 */ });
it('moving changes only the location', () => { /* moveItems → only .at differs (deepEqual on the rest) */ });
it('new names take the smallest free number', () => { /* new-workflow-1 exists → new-workflow-2 */ });
it('reachOf follows wires from the entry steps only', () => { expect(reachOf(board(), 'daily')).toEqual(new Set(['fetch', 'expand'])); });
```

- [ ] **Step 2:** `npx vitest run src/design/edits.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** `board.ts` and `edits.ts`. Refusal texts use display names (`That wire already exists`, `<workflow> already starts at <step>`, `<workflow> already uses <cache>`) — these are BaseAPI's uniqueness rules surfaced early, nothing else is refused.
- [ ] **Step 4:** run → PASS.
- [ ] **Step 5: Commit** — `feat(acto): board state as the database's rows, with pure graph edits`.

### Task 5: Acto — payloads per workflow, processor/schema edits, removing a workflow

**Files:**
- Create: `src/Acto/src/design/payloads.ts`
- Modify: `src/Acto/src/design/edits.ts` (processor/schema edits, `withoutWorkflow`)
- Test: `src/Acto/src/design/payloads.test.ts`, `src/Acto/src/design/edits.test.ts`

**Interfaces:**
- Consumes: Task 4's types.
- Produces: `assignmentOf(b, wf: Id, stepId: Id): AssignmentRow | null` (the first of the workflow's assignments for that step), `assignmentsOf(b, wf): AssignmentRow[]` (all it links, in `assignmentIds` order), `linkedBy(b, assignmentId): Id[]`, `setPayload(b, wf, stepId, payload: string, newId: () => Id): BoardState`, `removeAssignment(b, wf, assignmentId): BoardState`, `withoutWorkflow(b, wf): BoardState`, and the ported processor/schema edits `setProcessorField(b, processorId, field, value)`, `setSlotSchema(b, processorId, slot: Slot, copy: SchemaCopy, newId)`, `clearSlot(b, processorId, slot)` (same semantics as today's `design/state.ts` versions: a slot edit makes a new schema row and points the processor at it).

- [ ] **Step 1: Write the failing tests**

```ts
it('edits a payload in place when only this workflow links the row', () => { /* same id, new payload */ });
it('copy-on-write: a row another workflow links is copied for this one', () => {
  const s = setPayload(shared(), 'daily', 'fetch', '{"path":"/x"}', () => 'new1');
  expect(s.assignments.new1).toMatchObject({ stepId: 'fetch', payload: '{"path":"/x"}', updatedAt: null });
  expect(s.workflows.daily.assignmentIds).toContain('new1');
  expect(s.workflows.hourly.assignmentIds).toContain('a-shared');
  expect(s.assignments['a-shared'].payload).toBe(shared().assignments['a-shared'].payload);
});
it('creates a row when the workflow has none for that step', () => { /* name `<workflow>-<step>`, version 1.0.0 */ });
it('removing unlinks, and deletes the row only when nobody links it', () => { /* two cases */ });
it('a payload on a step the workflow no longer reaches stays listed', () => { /* removeWires then assignmentsOf still has it */ });
it('withoutWorkflow drops the row and its unshared assignments, keeps steps, wires and caches', () => {});
```

- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** run → PASS.
- [ ] **Step 5: Commit** — `feat(acto): payloads belong to the workflow; copy-on-write for shared rows`.

### Task 6: Acto — the Save diff as CRUD changes

**Files:**
- Create: `src/Acto/src/design/changes.ts`
- Test: `src/Acto/src/design/changes.test.ts`

**Interfaces:**
- Consumes: Tasks 4–5; `ModelChangeDto` from `api/types.ts`.
- Produces:

```ts
export type Table = 'workflows' | 'steps' | 'caches' | 'assignments' | 'processors' | 'schemas';
export interface ModelChange { op: 'create' | 'update' | 'delete'; table: Table; id: Id; row?: object; updatedAt?: string }
export function boardChanges(base: BoardState, cur: BoardState): ModelChange[];
export function changedKeys(base: BoardState, cur: BoardState): Set<string>;   // `step:<id>`, `cache:<id>`, `workflow:<id>`, `assignment:<id>`, `processor:<id>`, `schema:<id>`
export function affectedWorkflows(base: BoardState, cur: BoardState): Id[];   // spec §4b: row changed, or reaches (before or after) a created/changed/deleted step
```

Rules: a row is **created** when `updatedAt === null` and it is not in `base`; **updated** when in both and different (deep equal on the row minus `updatedAt`), sending `updatedAt` = the cur row's `updatedAt` (the stamp the board read — a restored draft keeps its old stamp so a newer stored row is refused); **deleted** when in `base` and not in `cur`, with base's `updatedAt`. Row bodies are exactly the CRUD create/update DTOs (`boardX`/`boardY` from `at`; `null` when `at` is null). Order: creates (schemas, caches, steps with `nextStepIds` filtered to ids not created in this save, assignments, workflows) → updates (processors, steps — including created steps whose `nextStepIds` named created ids, with no `updatedAt` — caches, assignments, workflows) → deletes (assignments, steps, caches, schemas). Processors are never created or deleted.

- [ ] **Step 1: Write the failing tests**

```ts
it('nothing changed, nothing sent', () => expect(boardChanges(b, b)).toEqual([]));
it('a moved step is one update carrying its location and read stamp', () => {
  expect(boardChanges(b, moveItems(b, [{ ref: { kind: 'step', id: 'fetch' }, at: { x: 5, y: 6 } }]))).toEqual([
    { op: 'update', table: 'steps', id: 'fetch', updatedAt: b.steps.fetch.updatedAt!, row: expect.objectContaining({ boardX: 5, boardY: 6 }) }]);
});
it('orders deletes after the updates that free them', () => {
  const ops = boardChanges(b, deleteSteps(b, ['fetch'])).map(c => `${c.op} ${c.table} ${c.id}`);
  expect(ops.indexOf('update workflows daily')).toBeLessThan(ops.indexOf('delete steps fetch'));
  expect(ops.indexOf('delete assignments a-daily-fetch')).toBeLessThan(ops.indexOf('delete steps fetch'));
});
it('two new steps wired to each other: create both bare, then update the wires', () => {});
it('updates carry the stamp the board read, not the base one', () => { /* cur row updatedAt 'old', base 'new' → updatedAt 'old' */ });
it('affected: every workflow reaching a changed shared step', () => { /* edit expand → daily and hourly */ });
it('affected: a workflow that stopped reaching a deleted step', () => {});
it('changedKeys counts rows, not changes', () => {});
```

- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** run → PASS.
- [ ] **Step 5: Commit** — `feat(acto): Save diff as ordered CRUD changes for /model/apply`.

### Task 7: Acto — API client and loading the board

**Files:**
- Modify: `src/Acto/src/api/client.ts`, `src/Acto/src/api/toModel.ts`, `src/Acto/src/board/loadBoard.ts`, `src/Acto/src/board/placement.ts`
- Test: `src/Acto/src/board/loadBoard.test.ts`, `src/Acto/src/board/placement.test.ts`, `src/Acto/src/api/client.test.ts`

**Interfaces:**
- Produces: `StudioApi` gains `listSteps()`, `listAssignments()`, `applyModel(changes: ModelChange[]): Promise<ApiResult<ModelApplyResultDto>>`, `validateModel(changes): Promise<ApiResult<ModelValidateResultDto>>` (`POST /model/apply` / `/model/validate` with `{ changes }`); `getGraph`, `saveDesign`, `deleteWorkflow` are removed. `loadBoard(api): Promise<ApiResult<BoardState>>` (six lists in parallel, any failure → the first error). `placeMissing(b: BoardState): BoardState` fills `at === null`: a step or cache next to what connects to it (cache 120 px below its first linking triangle; a step 280 px right of its first wired-in source), a triangle 160 px left of its first entry step, anything unconnected in a column 320 px right of everything placed; no overlaps (reuse `freeOffset` from `operate/clipboard.ts`).

- [ ] **Step 1: Write the failing tests** — `loadBoard` maps fake lists to rows (including `boardX/boardY → at`, nulls kept); orphan steps and unlinked assignments are kept; a failed list returns its error. `placeMissing` places a triangle left of its entry step, leaves placed items alone, and never overlaps two placed cards. `applyModel` posts `{ changes }` to `/api/v1/model/apply`.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement; delete `board/layoutDoc.ts`, `board/roles.ts`, `board/cacheChips.ts`, `placeFrames`/`frameSizeOf`/`minFrameSize` and their tests. **Step 4:** `npx vitest run src/board src/api` → PASS.
- [ ] **Step 5: Commit** — `feat(acto): load the whole board from BaseAPI's lists`.

### Task 8: Acto — the board store

**Files:**
- Rewrite: `src/Acto/src/design/boardStore.ts`, `src/Acto/src/design/history.ts` (generic over the state)
- Delete: `design/state.ts`, `design/request.ts`, `design/shared.ts`, `design/drafts.ts` and tests
- Test: `src/Acto/src/design/boardStore.test.ts`

**Interfaces:**
- Produces:

```ts
export interface BoardStore {
  load(b: BoardState): void;                      // base = b; restores the session draft (key `acto.board`) when present
  state(): BoardState;                            // present
  base(): BoardState;
  edit(fn: (b: BoardState) => BoardState, merge?: string): void;      // refused while saving ("Saving — wait for it to finish")
  editOrRefuse(fn: (b: BoardState) => Edit): void;                    // a refusal goes to Output as a warning
  undo(): void; redo(): void; canUndo(): boolean; canRedo(): boolean;
  unsaved(): Set<string>;                         // changedKeys(base, present)
  saving(): boolean; setSaving(on: boolean): void;
  saved(fresh: BoardState): void;                 // base = present = fresh; history and draft cleared; failures cleared
  dropWorkflow(id: Id): void;                     // withoutWorkflow on base and every history state; consecutive equal states merged
  problems(wf: Id): number; setProblems(wf: Id, n: number): void;
  failures(): Map<string, string>; setFailures(f: Map<string, string>): void;   // key as changedKeys → BaseAPI's message
  subscribe(fn: () => void): () => void;
}
export function createBoardStore(output: OutputStore, session: Storage | null): BoardStore;
export function useBoardState(store: BoardStore): BoardState;
```

History depth 100 and merge keys as today. The draft stores the whole history; on `load`, a draft restores over the fresh base as is (rows keep the stamps they were read with — Task 6 then sends those stamps).

- [ ] **Step 1: Write the failing tests** — one history across workflows (edit A then B, undo twice restores both); merge key merges typing; `unsaved()` counts changed rows; edit while saving is refused with the message; draft survives a new store on the same storage; **draft keeps its read stamps** (load a fresher base, draft row keeps `updatedAt` 'old'); `dropWorkflow` removes it from past/present/future and keeps a step delete made before it; storage that throws (`blocked` storage stub from `src/test/memoryStorage.ts`) never breaks editing.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** run → PASS.
- [ ] **Step 5: Commit** — `feat(acto): one board store with one history and one draft`.

### Task 9: Acto — Save, the dry run, Kibana, and deleting a triangle

**Files:**
- Create: `src/Acto/src/design/saveBoard.ts`
- Rewrite: `src/Acto/src/design/diagramSvg.ts`, `src/Acto/src/operate/deleteWorkflow.ts`
- Delete: `design/saveWorkflow.ts` and its test
- Test: `src/Acto/src/design/saveBoard.test.ts`, `src/Acto/src/design/diagramSvg.test.ts`, `src/Acto/src/operate/deleteWorkflow.test.ts`

**Interfaces:**
- Produces: `saveBoard(api, store, output): Promise<'nothing' | 'refused' | 'saved'>`; `diagramSvg(b: BoardState, workflowId: Id): string`; `prepareDelete(api, store, output, wf: Id): Promise<DeletePlan | null>` and `commitDelete(api, store, output, plan): Promise<boolean>` with `DeletePlan { workflowId: Id; changes: ModelChange[]; lines: string[] }`.

Save (spec §8): nothing changed → `'nothing'`. Else `setSaving(true)`; `applyModel(boardChanges(base, present))`. Not applied → for every result with `ok: false`, an Output error `<kind> <name>: <message>` (409 → `<name> changed elsewhere — undo your changes to it, or reload`), `setFailures`, `'refused'`. Applied → map created ids through `made`, `loadBoard` again and `store.saved(fresh)` (on a failed re-read: `saved(present with made ids)` and an Output warning to reload), then for each `affectedWorkflows` id still on the board: `validateWorkflow` → `setProblems` and its problems to Output; `publishDiagram(id, diagramSvg(fresh, id))`. Always `setSaving(false)`.

Diagram: only the workflow's triangle, entry arrows, `reachOf` steps and their wires, its caches with dashed lines, at their locations, in Acto's look on white, no live state, legend below (port today's renderer's look).

Delete: `prepareDelete` builds `delete workflows/<id>` (with its `updatedAt`) plus `delete assignments/<a>` for each of its assignments no other workflow links, runs `validateModel`; refused (e.g. running: BaseAPI's 422 detail) → Output error, `null`. `commitDelete` → `applyModel`; applied → `store.dropWorkflow(id)` and remove it from the base rows; Output lists what went.

- [ ] **Step 1: Write the failing tests** — save sends the diff and adopts the re-read; refusal keeps the board and marks failures; 409 message text; validate and publish run for exactly the affected workflows; a step-only change on a shared step republishes both workflows; diagram for `daily` includes `expand` and `c1` and excludes `lonely` and `hourly`'s triangle; **running refusal leaves the board** (fake `validateModel` answers the 422 → store untouched, Output names "running: stop it first"); delete keeps steps.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** run → PASS.
- [ ] **Step 5: Commit** — `feat(acto): board-wide save through /model/apply, dry run and Kibana per affected workflow`.

### Task 10: Acto — rendering the board with React Flow

**Files:**
- Rewrite: `src/Acto/src/board/toFlow.ts`, `src/Acto/src/board/Board.tsx`, `src/Acto/src/board/nodes/StepCard.tsx`, `src/Acto/src/board/BoardMiniMap.tsx`, `src/Acto/src/board/board.css`
- Create: `src/Acto/src/board/connect.ts`, `src/Acto/src/board/nodes/TriangleNode.tsx`, `src/Acto/src/board/nodes/CacheNode.tsx`, `src/Acto/src/board/edges/EntryEdge.tsx`, `src/Acto/src/board/edges/CacheLinkEdge.tsx`
- Delete: `board/nodes/WorkflowFrame.tsx`, `board/nodes/CacheChip.tsx`, `board/dropTarget.ts` and tests
- Test: `src/Acto/src/board/toFlow.test.ts`, `src/Acto/src/board/connect.test.ts`, `src/Acto/src/board/Board.test.tsx`

**Interfaces:**
- Produces: `toFlow(b: BoardState, view: { workflow: Id | null; picks: Pick[]; live: (wf: Id) => RunState; health: … }): { nodes: Node[]; edges: Edge[] }` with node types `workflow` (handles: source `tip` on the right, source `back` on the left), `step` (target `in` left, source `out` right), `cache` (target `in` top); edge types `wire` (step→step, colour/letter/arrowhead from the target's entry condition, as today's `LinkWire`), `entry` (tip→step, solid, ink colour; accent when its workflow is selected), `cacheLink` (back→cache, dashed). Edge ids: `wire:<from>:<to>`, `entry:<wf>:<step>`, `cache:<wf>:<cache>`. `connect.ts`: `connectionKind(c: Connection, b: BoardState): 'wire' | 'entry' | 'cacheLink' | null` — `out→in` on two steps is a wire, `tip→in` on a step an entry, `back→in` on a cache a cache link, anything else null; used as React Flow's `isValidConnection` and by `onConnect` to call Task 4's edit (a refusal goes to Output).
- Dimming: with a workflow selected, nodes and edges outside `reachOf` ∪ its caches ∪ itself get class `dim`; each lit step's footer shows that workflow's payload summary (`payloadKeyCount`), otherwise the step's version.
- Every node and the triangle are draggable; a drag stop commits one `moveItems` (one history step for a multi-drag), keeping the 6 px `CLICK_SLOP`.
- Minimap: React Flow `<MiniMap>` with node colours by kind (triangles green/red by run state, steps by processor tone, caches grey), click-to-jump kept.

- [ ] **Step 1: Write the failing tests** — `toFlow` gives one node per step/cache/workflow and one edge per wire/entry/cache link; dims what `daily` does not reach; `connectionKind` cases (all three kinds valid, step→triangle null, tip→cache null, back→step null); `Board` renders a triangle with its two handles and a cache node (Testing Library, React Flow test stubs already in `src/test/setup.ts`).
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** `npx vitest run src/board` → PASS; `npm run typecheck` clean for these files (App wiring follows in Task 12).
- [ ] **Step 5: Commit** — `feat(acto): triangles, steps and caches on React Flow with its own connections`.

### Task 11: Acto — selection and the Inspector

**Files:**
- Rewrite: `src/Acto/src/board/selection.ts`, `src/Acto/src/board/picks.ts`, `src/Acto/src/inspector/InspectorPanel.tsx`, `src/Acto/src/inspector/ProcessorSection.tsx`
- Test: `src/Acto/src/board/picks.test.ts`, `src/Acto/src/inspector/InspectorPanel.test.tsx`

**Interfaces:**
- Produces: `type Pick = { kind: 'workflow'; id: Id } | { kind: 'step'; id: Id } | { kind: 'cache'; id: Id } | { kind: 'wire'; from: Id; to: Id } | { kind: 'entry'; workflowId: Id; stepId: Id } | { kind: 'cacheLink'; workflowId: Id; cacheId: Id }`; `selectPick(prev: { workflow: Id | null; picks: Pick[] }, p: Pick | null, additive: boolean): { workflow: Id | null; picks: Pick[] }` — a triangle click sets `workflow` and `picks = [it]` (Ctrl ignored for triangles); a step/cache/wire click keeps `workflow` and replaces (or, additive, toggles) picks; an entry or cache-link click sets `workflow` to its workflow; empty board clears both.
- Inspector (spec §6): workflow → name, version, cron (with the cron text), description, entry steps and caches (listed, each with Remove), location, **Assignments** (each: step name, payload editor with the JSON check from `model/payloadCheck.ts`, Delete); step → shared fields marked "shared" (name, version, description, entry condition, processor section with slots), and with a workflow selected **Payload · <workflow>** (or "not in <workflow>" when not reached, still editable via the workflow's list); cache → its fields; wire/entry/cache link → from/to and the condition text. Undo/Redo in the header act on the board history.

- [ ] **Step 1: Write the failing tests** — `selectPick` cases above; Inspector shows the payload for `daily` then `hourly` on the same step; editing it calls `setPayload` for the selected workflow only; with no workflow selected no payload field appears; the workflow's list shows an assignment on an unreached step.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** run → PASS.
- [ ] **Step 5: Commit** — `feat(acto): click a triangle first; the Inspector shows that workflow's payloads`.

### Task 12: Acto — toolbars, toolbox, clipboard, Save button, App wiring

**Files:**
- Modify: `src/Acto/src/board/Toolbar.tsx`, `src/Acto/src/board/selectionBar.ts`, `src/Acto/src/board/SelectionBarView.tsx`, `src/Acto/src/toolbox/ToolboxPanel.tsx`, `src/Acto/src/operate/clipboard.ts`, `src/Acto/src/operate/runWorkflow.ts`, `src/Acto/src/design/keys.ts`, `src/Acto/src/shell/Shell.tsx`, `src/Acto/src/App.tsx`
- Test: the matching `*.test.ts(x)` files

**Interfaces:**
- Toolbars per Global Constraints. Selection bar actions = common to all picks: steps/caches Copy · Delete (caches: Delete only, so a mix shows Delete), wires/entries/cache links Delete.
- Toolbox: Create › Workflow (drop anywhere → `addWorkflow`), Create › Cache (drop anywhere → `addCache`), Steps (drop anywhere → `addStep`). No drop target logic beyond "on the board".
- Clipboard: Copy = picked steps (shared fields + wires among them, no payloads) into `acto.clip`; Ctrl+V pastes at a free offset (`freeOffset`) as new steps.
- Save button in the top bar: `Save` with the unsaved count (`Save · 3`), disabled when nothing changed or saving; runs `saveBoard`.
- Triangle marks: running dot from the live state, a problem badge from `problems(wf)`, a failure outline from `failures()`.
- `App.tsx` wires store, board, inspector, toolbox, Save, Start/Stop (`runWorkflow` unchanged in behaviour, now reading names from `BoardState`) and delete (Task 9) together; removes every frame/lock/rebase path.

- [ ] **Step 1: Write the failing tests** — toolbar buttons per kind; selection bar for a step+cache mix shows only Delete; toolbox drop creates a triangle at the drop point; paste adds new steps without payloads; Save button text and disabled state; Esc clears picks (D1, kept).
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** `npm test` (all) → PASS; `npm run typecheck` → clean; `npm run build` → ok.
- [ ] **Step 5: Commit** — `feat(acto): toolbars, toolbox, clipboard and the board-wide Save button`.

### Task 13: Acto — chat tools and prompt

**Files:**
- Rewrite: `src/Acto/src/chat/tools/{read,workflows,design,fields,common}.ts`, `src/Acto/src/chat/prompt.ts`, `src/Acto/src/chat/toolTypes.ts`
- Test: the matching tests, including the prompt drift test

**Interfaces:**
- `ToolContext.store` is the new `BoardStore`; `workflowArg` reads `store.state().workflows`.
- Tools: `list_workflows`, `read_board` (graph: steps, wires, caches, triangles with entry steps/caches/cron/state; replaces `read_design`), `read_entity`, `read_output`, `list_processors`, `list_caches`, `list_schemas`, `new_workflow`, `add_step`, `add_cache`, `connect` (wire), `disconnect`, `set_entry`, `remove_entry`, `link_cache`, `unlink_cache`, `set_field` (kind + id), `set_payload` (workflow_id, step_id, payload), `remove_assignment` (workflow_id, assignment_id), `set_processor`, `move_blocks`, `pick`, `copy`, `paste`, `delete_picked`, `delete_workflow` (asks first, pins the id), `save` (board-wide, asks first), `undo`, `redo`, `start`, `stop`. Removed: anything about frames, parked/first steps, the lock, per-workflow save, `create_assignment` (replaced by `set_payload`).
- Prompt: the model of spec §1 in three sentences (shared graph; triangle = entry steps + its payloads/caches/cron; Save is board-wide, the dry run reports); no frame, lock or parked wording (the drift test lists the tool names and forbids `frame`, `parked`, `locked`).

- [ ] **Step 1: Write the failing tests** — each edit tool changes the store as its edit function does, one history step each; `set_payload` on a shared row copies; `save` asks then runs `saveBoard`; drift test.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** `npm test` → PASS.
- [ ] **Step 5: Commit** — `feat(acto): chat tools for the shared graph and board-wide save`.

### Task 14: Acto — headed Playwright suite

**Files:**
- Rewrite: `src/Acto/e2e/*.spec.ts`, `src/Acto/e2e/helpers.ts`, `src/Acto/e2e/fixtures.ts`, global setup/teardown (throwaway rows prefixed `e2e-`, deleted in teardown through `/model/apply`)

Specs (each a file):
- `board.spec.ts` — loads every step (orphans too), triangles with tip arrows and dashed cache lines, minimap, theme, Fit.
- `create.spec.ts` — toolbox drops (workflow, cache, step), drawing a wire, an entry arrow (tip→step), a cache link (back→cache); refused duplicates show BaseAPI's uniqueness message.
- `select.spec.ts` — triangle first: payloads switch between two `e2e-` workflows sharing an entry step; dimming; Ctrl+click multi-select on steps; triangles not multi-selected; Esc.
- `inspector.spec.ts` — every field; payload JSON check; undo/redo across two workflows.
- `save.spec.ts` — Save writes everything (reload shows it), refusal keeps the board (a new triangle without an arrow), **shared payload copy-on-write** (edit A's payload, B unchanged after reload), dry run marks a failing triangle, Kibana SVG republished for both workflows sharing a step (`GET /workflows/{id}.svg` changed).
- `delete.spec.ts` — delete a never-started `e2e-` triangle: its steps stay; confirm text.
- `moving.spec.ts` — drag triangle, step, cache; multi-drag one undo step; click slop.
- `chat.spec.ts` — one read-only question (skipped without `KIMI_*`).

- [ ] **Step 1:** write the specs. **Step 2:** `npm run e2e` against the dev server → all pass (or skipped chat without key). **Step 3:** `node scripts/e2e-watch.mjs` (headed) → all pass. **Step 4:** confirm the 5 real workflows are unchanged (`GET /workflows` names and `updatedAt` equal before/after).
- [ ] **Step 5: Commit** — `test(acto): headed e2e suite for triangles, shared graph and board-wide save`.

### Task 15: Deploy Acto and check it live

- [ ] **Step 1:** `docker build -q -f src/Acto/Dockerfile -t acto:local .`; import into `desktop-control-plane`; `kubectl -n skp rollout restart deploy/acto`; `rollout status`; restart the 18083 port-forward.
- [ ] **Step 2: Verify** — served `index.html` references the new bundle; open http://localhost:18083 with Playwright: 5 triangles, every step drawn, clicking `filefetcher-archiveexpander-chain` lights its steps and shows its payloads; no console errors other than known ones.
- [ ] **Step 3:** Update `k8s/README.md` only if a deploy step changed; commit if so — `docs(k8s): …`.
