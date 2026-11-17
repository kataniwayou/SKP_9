# Acto Plan 2 — Designing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Acto's board editable: move and resize frames, move steps, draw and delete wires, drop steps and
caches from the toolbox, create workflows, edit fields in the Inspector, undo/redo per workflow, and Save one
workflow (design + validate + Kibana diagram) — all on the branch `feature/acto` that holds Plan 1.

**Architecture:** Each workflow gets an immutable `WorkflowState` (its fields, steps with positions and links,
assignments, linked caches, frame) derived from the loaded `BoardWorkflow`. Every edit is a pure function
`WorkflowState → WorkflowState`; a per-workflow history keeps past/future states; a `boardStore` (external store,
`useSyncExternalStore`) holds base + history for every workflow and derives the `BoardWorkflow`s the Plan 1 board
already draws. Save turns `base` vs `current` into BaseAPI's existing `DesignSaveRequest` (no server change).

**Tech Stack:** as Plan 1 — React 19.3, `@xyflow/react` 12.12.0 (`NodeResizer`, `onConnect`, drag and drop via
`screenToFlowPosition`), Vitest + Testing Library (`fireEvent`), Playwright.

**Spec:** `docs/superpowers/specs/2026-11-17-acto-design.md` · Plan 1: `docs/superpowers/plans/2026-11-17-acto-1-board-viewer.md`

**Plan series:** 1 viewer (done) · **2 designing (this)** · 3 operating: Start/Stop, workflow Delete with dry run,
copy/paste, Ctrl+click multi-select and its bar, the shared-entity lock, and processor/schema-slot editing (shared
entities need the lock first) · 4 chat, themes, deployment, transition.

## Global Constraints

- Everything in Plan 1's Global Constraints still holds (paths, deps, colours, geometry 46/28/210×92, storage keys,
  try/catch storage, no keyboard hints, `fireEvent` in tests).
- One trigger per action: toolbar buttons per kind — workflow **Save** (and later Plan 3 buttons), step **Delete**,
  wire **Delete**, cache **Delete** (unlink). No Delete key. Undo/Redo only in the Inspector header plus Ctrl+Z /
  Ctrl+Y (never shown). Paste/copy are Plan 3.
- Toolbar look: dark bar above the selected thing with a small arrow pointing at it, same size at any zoom.
- Wires: one per link, drawn by dragging from a step's right handle onto a step of the **same** workflow; refused
  (Output line, no wire) when dropped on empty board ("A wire must end on a step"), on itself ("A step cannot wire to
  itself"), as a duplicate ("That wire already exists"), or into another workflow ("A wire stays inside its workflow").
- First steps are derived (Plan 1 `stepRoles`), never drawn; Save writes `entryStepIds` = derived first steps.
- No empty step: a toolbox Steps item always creates a step **with** its processor. Dropping a Steps item on an existing
  step swaps that step's processor.
- New workflow: name `new-workflow-N` (lowest free N ≥ 1 among loaded names), version **`1.0.0`** (BaseAPI requires
  strict SemVer — the spec's "v1" would be refused), cron null, description null. New step fields: name = the
  processor's name, made unique in its workflow with `-2`, `-3`…, version `1.0.0`, description null, entry condition 1.
- New cache fields: name `new-cache-N`, version `1.0.0`, description null, root `''`, items `'{}'`.
- New ids: `crypto.randomUUID()` (copy WorkflowStudio's `design/ids.ts` `newId` into `src/Acto/src/design/ids.ts`).
- History depth 100 per workflow; consecutive edits with the same merge key (typing in one field, nudges) are one step.
- Session persistence key `acto.drafts` in **sessionStorage** (this tab), try/catch.
- Layout written on Save: `{ v: 2, sphere, steps, caches, parked, wires, board }` where `parked` and `steps` list
  **every** step in the frame, `wires` is the plain circuit WorkflowStudio reads (ids `${from}->${to}` with
  `tail { on:'step', step, y:null }` / `head { on:'step', step, y:null }`, and `wf->${id}` with
  `tail { on:'hub', angle:null }` for each first step), `sphere` = the stored one or `{ x: -150, y: firstStep.y + 46 }`.

## Review Focus

1. **Save fails** (BaseAPI `applied:false` with errors, or HTTP error) — the frame keeps its unsaved tag and its
   edits, every error reaches Output with the entity name, nothing is re-read. Test in Task 5.
2. **Another tab or WorkflowStudio changed the workflow** — the pre-save re-read finds a different stored layout:
   Output warns "orders-to-ems changed elsewhere since it was loaded; saving over it", save proceeds; a stamp conflict
   (409/422 from BaseAPI) is shown like any error. Test in Task 5.
3. **A wire dragged across frames or onto the frame body** — refused with the Global-Constraints message, the
   history gets no step. Test in Task 6.
4. **Undo after Save** — Save clears that workflow's history (the saved state is the new base); Undo is greyed, not
   reverting into a pre-save state. Test in Task 3.
5. **Refresh with unsaved work** — the draft and its history come back from sessionStorage only if the workflow's
   `updatedAt` still matches; otherwise it is dropped with an Output line. Test in Task 3.

---

### Task 1: The workflow edit model

**Files:**
- Create: `src/Acto/src/design/state.ts`, `src/Acto/src/design/ids.ts`, `src/Acto/src/design/fixtures.ts` (used by Tasks 2–9)
- Test: `src/Acto/src/design/state.test.ts`

**Interfaces:**
- Consumes: `BoardWorkflow`, `stepRoles`, `derivedEntrySteps`, `wiresOf`, `frameSizeOf` (Plan 1); `Graph`, `Id`, `Processor`, `Cache`.
- Produces (all pure, return a new state; unchanged input → same object):
  ```ts
  interface StepState { id: Id; name: string; version: string; description: string | null; entryCondition: number;
    processorId: Id | null; nextStepIds: Id[]; at: Point; updatedAt: string | null; isNew: boolean }
  interface CacheState { id: Id; name: string; version: string; description: string | null; root: string; items: string; isNew: boolean }
  interface AssignmentState { id: Id; stepId: Id; name: string; version: string; description: string | null; payload: string; updatedAt: string | null; isNew: boolean }
  interface WorkflowState { workflowId: Id; isNew: boolean; updatedAt: string | null;
    fields: { name: string; version: string; description: string | null; cronExpression: string | null };
    steps: Record<Id, StepState>; caches: Record<Id, CacheState>; assignments: Record<Id /*stepId*/, AssignmentState>;
    deletedSteps: Record<Id, string | null>; frame: Rect }
  stateOf(bw: BoardWorkflow): WorkflowState
  newWorkflowState(id: Id, name: string, at: Point): WorkflowState
  // design/fixtures.ts: bwFull(over?: { updatedAt?: string }): BoardWorkflow — workflow w1 'orders', steps a→b
  //   (names a-name, b-name, step updatedAt '2026-01-01T00:00:00Z', processor p1 'Analyst'), an assignment on a,
  //   one linked cache c1; proc(id, name): Processor; procs(): Map<Id, Processor>
  boardWorkflowOf(state: WorkflowState, base: BoardWorkflow | null, processors: ReadonlyMap<Id, Processor>): BoardWorkflow
  moveStep(s, stepId, at): WorkflowState; moveFrame(s, at: Point); resizeFrame(s, size: { w; h })  // clamps to frameSizeOf
  addStep(s, processor: Processor, at, id): WorkflowState; swapProcessor(s, stepId, processor); removeStep(s, stepId)
  addWire(s, from, to): { state: WorkflowState } | { refused: string }; removeWire(s, from, to)
  setWorkflowField(s, key: 'name'|'version'|'description'|'cronExpression', v); setStepField(s, stepId, key: 'name'|'version'|'description'|'entryCondition', v)
  setPayload(s, stepId, payload, newId: () => Id)   // creates the assignment when the step has none
  removeAssignment(s, stepId)
  addCache(s, cache: CacheState); linkCache(s, cache: Cache); unlinkCache(s, cacheId); setCacheField(s, cacheId, key: 'name'|'version'|'description'|'root'|'items', v)
  sameState(a, b): boolean
  ```
  `removeStep` also drops every wire into it, its assignment, and records `deletedSteps[id] = updatedAt` for a
  non-new step. `boardWorkflowOf` builds `stepIds`, `stepAt`, `roles`, `wires`, `entryDiff` (stored entry list vs
  derived, only for non-new workflows) and a `graph` whose steps/workflow carry the edited fields, so Plan 1's
  board, Inspector and toolbox render edits without change.

- [ ] **Step 1: Write the failing tests**

```ts
it('round-trips a loaded workflow', () => {
  const bw = bwFull();                       // fixture in design/fixtures.ts: 2 steps a→b, one assignment on a, one linked cache
  expect(boardWorkflowOf(stateOf(bw), bw, procs()).wires).toEqual(bw.wires);
});
it('adds a step with its processor and a unique name', () => {
  const s = addStep(addStep(stateOf(bw('w1', [])), proc('p1', 'Analyst'), { x: 40, y: 40 }, 'n1'), proc('p1', 'Analyst'), { x: 300, y: 40 }, 'n2');
  expect([s.steps.n1!.name, s.steps.n2!.name]).toEqual(['Analyst', 'Analyst-2']);
  expect(s.steps.n2).toMatchObject({ processorId: 'p1', version: '1.0.0', entryCondition: 1, isNew: true });
});
it('refuses self, duplicate and unknown wires', () => {
  const s = stateOf(bwFull());
  expect(addWire(s, 'a', 'a')).toEqual({ refused: 'A step cannot wire to itself' });
  expect(addWire(s, 'a', 'b')).toEqual({ refused: 'That wire already exists' });
  expect(addWire(s, 'a', 'zz')).toEqual({ refused: 'A wire stays inside its workflow' });
});
it('removing a step drops its wires and assignment and remembers the deletion', () => {
  const s = removeStep(stateOf(bwFull()), 'a');
  expect(s.steps.a).toBeUndefined(); expect(s.assignments.a).toBeUndefined();
  expect(s.deletedSteps).toEqual({ a: '2026-01-01T00:00:00Z' });
});
it('clamps a frame resize to its content', () => {
  const s = resizeFrame(stateOf(bwFull()), { w: 10, h: 10 });
  expect(s.frame.w).toBeGreaterThanOrEqual(420); expect(s.frame.h).toBeGreaterThanOrEqual(196);
});
it('creates an assignment on first payload edit', () => {
  const s = setPayload(stateOf(bw('w1', ['b'])), 'b', '{"x":1}', () => 'as1');
  expect(s.assignments.b).toMatchObject({ id: 'as1', name: 'b-name-assignment', version: '1.0.0', payload: '{"x":1}', isNew: true });
});
```
- [ ] **Step 2: Run** `npx vitest run src/design/state.test.ts` → fail. **Step 3: Implement.** **Step 4: Run** → pass;
  `npx tsc --noEmit` clean.
- [ ] **Step 5: Commit** — `feat(acto): the workflow edit model`.

---

### Task 2: The save request, layout and stored designs

**Files:**
- Create: `src/Acto/src/design/request.ts`
- Test: `src/Acto/src/design/request.test.ts`

**Interfaces:**
- Consumes: `WorkflowState`, `stepRoles`/`derivedEntrySteps`; `DesignSaveRequest` type from `api/schema.d.ts`
  (`components['schemas']['DesignSaveRequest']`).
- Produces:
  - `designRequest(base: WorkflowState | null, cur: WorkflowState, storedLayout: unknown): DesignSaveRequest` —
    `base` null = new workflow → `newWorkflow: { fields }`. Workflow: always `updatedAt`, changed `fields`,
    `entryStepIds` (derived first steps) when they differ from base's derived ones **or from the stored list**,
    `cacheIds` when the linked set differs. Steps: changed fields (including `processorId` on swap) and
    `nextStepIds` when changed, with the step's `updatedAt`. `newSteps` for `isNew` steps (`copyOf: null`,
    `processorId`, fields name/version/description/entryCondition, `nextStepIds`). `deletedSteps` from
    `deletedSteps`. Assignments: `create` (fields name, version, description, payload), `update` (changed fields,
    with `updatedAt`), `delete` (with `updatedAt`). `caches` (changed fields of linked caches), `newCaches`
    (`copyOf: null`, fields name, version, description, root, items). Optional lists are omitted when empty.
    `layout` = `layoutOf(cur, storedLayout)`.
  - `layoutOf(cur, storedLayout): object` — Global Constraints layout shape; cache positions: chips along the
    frame bottom (Task 8's `cacheChipAt`).
  - `applyStored(base: WorkflowState, stored: unknown): WorkflowState` — reapplies a stored design (BaseAPI stores
    the request minus `layout`) onto the base: field edits, next lists, new/deleted steps, assignment ops, linked/new
    caches; anything malformed is ignored.

- [ ] **Step 1: Write the failing tests**

```ts
it('sends only what changed', () => {
  const base = stateOf(bwFull()); const cur = setStepField(moveStep(base, 'b', { x: 500, y: 40 }), 'b', 'name', 'renamed');
  const r = designRequest(base, cur, null);
  expect(r.steps).toEqual([{ id: 'b', updatedAt: '2026-01-01T00:00:00Z', fields: { name: 'renamed' }, nextStepIds: null }]);
  expect(r.newSteps).toBeUndefined(); expect(r.assignments).toEqual([]);
  expect((r.layout as any).steps.b).toEqual({ x: 500, y: 40 });
});
it('writes derived first steps and a plain circuit WorkflowStudio reads', () => {
  const cur = removeWire(stateOf(bwFull()), 'a', 'b');           // a and b now have no wires (both parked)
  const r = designRequest(stateOf(bwFull()), addWire(cur, 'b', 'a').state!, null);
  expect(r.workflow!.entryStepIds).toEqual(['b']);
  expect((r.layout as any).wires).toEqual({
    'wf->b': { tail: { on: 'hub', angle: null }, head: { on: 'step', step: 'b', y: null } },
    'b->a': { tail: { on: 'step', step: 'b', y: null }, head: { on: 'step', step: 'a', y: null } } });
  expect((r.layout as any).parked).toEqual(['a', 'b']);
});
it('creates a new workflow with its steps', () => {
  const cur = addStep(newWorkflowState('nw', 'new-workflow-1', { x: 0, y: 0 }), proc('p1', 'Analyst'), { x: 28, y: 28 }, 's1');
  const r = designRequest(null, cur, null);
  expect(r.newWorkflow).toEqual({ fields: { name: 'new-workflow-1', version: '1.0.0', description: null, cronExpression: null } });
  expect(r.newSteps).toEqual([{ id: 's1', copyOf: null, processorId: 'p1', fields: { name: 'Analyst', version: '1.0.0', description: null, entryCondition: 1 }, nextStepIds: [] }]);
  expect(r.workflow!.entryStepIds).toEqual(['s1']);           // a lone step runs first
});
it('reapplies a stored design as unsaved work', () => {
  const base = stateOf(bwFull());
  const stored = JSON.parse(JSON.stringify({ ...designRequest(base, setStepField(base, 'a', 'name', 'x'), null), layout: undefined }));
  expect(applyStored(base, stored).steps.a!.name).toBe('x');
  expect(applyStored(base, 'garbage')).toBe(base);
});
```
- [ ] **Step 2–4:** run (fail) → implement → run (pass), tsc clean.
- [ ] **Step 5: Commit** — `feat(acto): build BaseAPI's design request and the layout from the edit model`.

---

### Task 3: History, the board store and refresh survival

**Files:**
- Create: `src/Acto/src/design/history.ts`, `src/Acto/src/design/boardStore.ts`, `src/Acto/src/design/drafts.ts`
- Modify: `src/Acto/src/App.tsx` (use the store instead of the `workflows` state)
- Test: `src/Acto/src/design/history.test.ts`, `src/Acto/src/design/boardStore.test.ts`, `src/Acto/src/design/drafts.test.ts`

**Interfaces:**
- Produces:
  - `history.ts`: `interface History { past: WorkflowState[]; present: WorkflowState; future: WorkflowState[]; merge: string | null }`;
    `historyOf(s)`, `commit(h, next, merge?: string)`, `undo(h)`, `redo(h)`, `canUndo`, `canRedo`; depth 100.
  - `boardStore.ts`: `createBoardStore(output: OutputStore, session: Storage | null)` with
    `load(board: BoardLoad, processors: Processor[])`, `boards(): BoardWorkflow[]` (stable array until something
    changes), `entry(id): { base: WorkflowState | null; history: History; unsaved: boolean } | null`,
    `edit(id, fn: (s) => WorkflowState, merge?: string)`, `editOrRefuse(id, fn: (s) => { state } | { refused })`
    (refusal → `output.log(text, 'warn')`, no history step), `undo(id)`, `redo(id)`, `addWorkflow(state)`,
    `replace(id, bw: BoardWorkflow)` (after a save: new base, history cleared), `subscribe(fn)`;
    `unsaved` = `!sameState(present, base)` (a new workflow is always unsaved until saved).
  - `useBoard(store)`, `useEntry(store, id)` hooks (`useSyncExternalStore`).
  - `drafts.ts`: `writeDrafts(session, entries)` / `readDrafts(session)` under `acto.drafts`:
    `{ [workflowId]: { updatedAt, history } }` for unsaved workflows only; on `load`, a draft is restored when its
    `updatedAt` equals the loaded workflow's, otherwise dropped with Output line "<name>: unsaved work from before the
    refresh was dropped because the workflow changed". A stored server design (`graph.design` non-null) with no
    session draft is applied with `applyStored` and Output line "<name>: loaded unsaved work from a save that failed".

- [ ] **Step 1: Write the failing tests**

```ts
it('merges typing into one step and caps depth', () => {
  let h = historyOf(s0);
  h = commit(h, s1, 'name:a'); h = commit(h, s2, 'name:a');
  expect(h.past).toEqual([s0]); expect(undo(h).present).toBe(s0);
  for (let i = 0; i < 120; i++) h = commit(h, { ...s0, updatedAt: String(i) });
  expect(h.past.length).toBe(100);
});
it('marks unsaved and clears it by undoing back', () => {
  const st = storeWith(bwFull());
  st.edit('w1', (s) => moveStep(s, 'a', { x: 99, y: 99 }));
  expect(st.entry('w1')!.unsaved).toBe(true);
  st.undo('w1'); expect(st.entry('w1')!.unsaved).toBe(false);
});
it('logs a refused edit and records no step', () => {
  const st = storeWith(bwFull()); st.editOrRefuse('w1', (s) => addWire(s, 'a', 'a'));
  expect(lastLine(st)).toEqual({ text: 'A step cannot wire to itself', level: 'warn' });
  expect(st.entry('w1')!.history.past).toEqual([]);
});
it('clears history when a save replaces the base', () => {
  const st = storeWith(bwFull()); st.edit('w1', (s) => moveStep(s, 'a', { x: 1, y: 1 }));
  st.replace('w1', bwFull());
  expect(canUndo(st.entry('w1')!.history)).toBe(false); expect(st.entry('w1')!.unsaved).toBe(false);
});
it('restores a draft after refresh only when the workflow is unchanged', () => {
  const session = memoryStorage(); const st = storeWith(bwFull(), session);
  st.edit('w1', (s) => moveStep(s, 'a', { x: 5, y: 5 }));
  expect(storeWith(bwFull(), session).entry('w1')!.unsaved).toBe(true);
  expect(storeWith(bwFull({ updatedAt: 'later' }), session).entry('w1')!.unsaved).toBe(false);
});
```
(`storeWith(bw, session?)` is a test helper creating a store and calling `load`.)
- [ ] **Step 2–4:** fail → implement (App now renders `useBoard(store)`; Plan 1 tests stay green) → pass.
- [ ] **Step 5: Commit** — `feat(acto): per-workflow history, the board store and drafts that survive a refresh`.

---

### Task 4: The Kibana diagram

**Files:**
- Create: `src/Acto/src/design/diagramSvg.ts`
- Test: `src/Acto/src/design/diagramSvg.test.ts`

**Interfaces:**
- Produces: `diagramSvg(bw: BoardWorkflow): string` — one standalone SVG (no external refs) of the frame's content in
  Acto's look on white `#FFFFFF`: step cards (210×92, rounded, name, processor name, FIRST/PARKED tag), coloured
  bezier wires with arrowheads and letter pills (Plan 1 `landings`, `conditionStyle`, same bezier as `LinkWire`),
  the workflow name as title, and a legend of the five conditions below. No live state (no health, no dashes).
  `viewBox` = content bounds + 24 px padding.

- [ ] **Step 1: Test** — parse the string with `DOMParser`: root `<svg>` has a `viewBox`; one `<path>` per wire whose
  `stroke` is the target's condition colour; the step names and "Completed … Never" legend texts are present; no
  `href`/`url(http` inside.
- [ ] **Step 2–4:** fail → implement → pass. **Step 5: Commit** — `feat(acto): Kibana diagram SVG in Acto's look`.

---

### Task 5: Save one workflow

**Files:**
- Create: `src/Acto/src/design/saveWorkflow.ts`
- Modify: `src/Acto/src/api/client.ts` (add `validateWorkflow(id): Promise<ApiResult<WorkflowValidationDto>>` →
  `POST /workflows/{id}/validate` with no body)
- Test: `src/Acto/src/design/saveWorkflow.test.ts`

**Interfaces:**
- Consumes: `boardStore`, `designRequest`, `diagramSvg`, `loadWorkflow` (Plan 1), `describeError`, `OutputStore`.
- Produces: `saveWorkflow(api, store, output, workflowId): Promise<'saved' | 'refused' | 'failed'>`:
  1. Re-read `getGraph`; if its `layout` JSON differs from the one loaded → warn
     `"<name> changed elsewhere since it was loaded; saving over it"`.
  2. `api.saveDesign(id, designRequest(base, present, loadedLayout))`. `applied:false` → one error line per error
     `"<name>: <entity name or id> — <message>"` and return `'refused'` (state untouched). HTTP failure → error line
     with `describeError`, `'failed'`.
  3. Applied → ok line `"<name> saved"`; `loadWorkflow` again and `store.replace`; then `validateWorkflow`: each
     problem as a warn line `"<name>: <title> — <detail>"`, and the frame gets a warning mark (store flag
     `problems: number`, shown by the frame header in Task 7); then `publishDiagram(id, diagramSvg(newBw))` → ok line
     `"<name>: Kibana diagram published"` or a warn line on failure. Return `'saved'`.

- [ ] **Step 1: Tests** with `fakeApi` extended (`saveDesign`, `validateWorkflow`, `publishDiagram` spies):
  applied path sends one request, re-reads, publishes an SVG, logs "orders saved"; `applied:false` keeps
  `unsaved === true` and logs each error; a changed stored layout logs the "changed elsewhere" warning first;
  validation problems log warn lines and set `problems`.
- [ ] **Step 2–4:** fail → implement → pass. **Step 5: Commit** — `feat(acto): save one workflow with validation and its Kibana diagram`.

---

### Task 6: Edit on the board — drag, resize, wire

**Files:**
- Modify: `src/Acto/src/board/Board.tsx`, `src/Acto/src/board/nodes/WorkflowFrame.tsx`, `src/Acto/src/board/nodes/StepCard.tsx`, `src/Acto/src/App.tsx`
- Test: `src/Acto/src/board/BoardEdit.test.tsx`

**Interfaces:**
- Consumes: `boardStore.edit/editOrRefuse`, `moveStep`, `moveFrame`, `resizeFrame`, `addWire`.
- Produces: `Board` gains `onEdit?: { moveStep(wf, step, at); moveFrame(wf, at); resizeFrame(wf, size); connect(fromWf, from, toWf, to | null) }`;
  without it the board stays read-only (Plan 1 behaviour). Frames and steps draggable (whole frame body is the
  handle; steps stay inside, `extent:'parent'`); `NodeResizer` on the selected frame with `minWidth/minHeight` from
  `frameSizeOf`; a step's right handle is a connection source, its left handle a target; `onConnect`/`onConnectEnd`
  call `connect` (target null when dropped on nothing). Drag end commits one history step (no step on mere clicks).

- [ ] **Step 1: Tests** (React Flow under jsdom: drive the handlers directly through the props React Flow receives, as
  Plan 1's Board tests do): a step drag end calls `moveStep` once with the new position; a click without movement
  calls nothing; `connect('w1','a','w2','x')` through App logs "A wire stays inside its workflow" and adds no step;
  `connect('w1','a','w1',null)` logs "A wire must end on a step".
- [ ] **Step 2–4:** fail → implement → pass. **Step 5: Commit** — `feat(acto): move and resize frames, move steps, draw wires`.

---

### Task 7: Toolbars with an arrow, and the unsaved tag

**Files:**
- Create: `src/Acto/src/board/Toolbar.tsx`
- Modify: `src/Acto/src/board/Board.tsx`, `src/Acto/src/board/nodes/WorkflowFrame.tsx`, `src/Acto/src/board/edges/LinkWire.tsx`, `src/Acto/src/board/board.css`
- Test: `src/Acto/src/board/Toolbar.test.tsx`

**Interfaces:**
- Produces: `<Toolbar selection actions />` rendered with React Flow `NodeToolbar` (frames, steps, cache chips) or
  `EdgeLabelRenderer` (wires): dark bar `#1A1D29`, white text, a 10 px rotated square as the arrow pointing at the
  selection. Buttons: workflow **Save** (accent `#FF0072` background when unsaved, plain otherwise); step **Delete**;
  wire **Delete**; cache **Delete**. Delete on a step/wire selects its workflow afterwards. Frame header shows the
  orange **unsaved** tag (`#B45309` on `rgba(217,119,6,.12)`) when `unsaved`, and an amber warning mark with the
  count when `problems > 0`.

- [ ] **Step 1: Tests:** the bar shows exactly ["Save"] for a workflow, ["Delete"] for a step, wire and cache; the
  root has class `toolbar` and contains an element with class `toolbar-arrow`; Save is highlighted only when
  unsaved; clicking Delete on a step removes it and selects its workflow; no button text contains "Ctrl".
- [ ] **Step 2–4:** fail → implement → pass. **Step 5: Commit** — `feat(acto): per-block toolbars with Save and Delete, unsaved tag`.

---

### Task 8: Toolbox drops and caches on the frame

**Files:**
- Create: `src/Acto/src/board/nodes/CacheChip.tsx`, `src/Acto/src/board/dropTarget.ts`
- Modify: `src/Acto/src/toolbox/ToolboxPanel.tsx`, `src/Acto/src/board/Board.tsx`, `src/Acto/src/board/toFlow.ts`, `src/Acto/src/App.tsx`
- Test: `src/Acto/src/board/dropTarget.test.ts`, `src/Acto/src/toolbox/ToolboxPanel.test.tsx` (extend)

**Interfaces:**
- Produces:
  - Toolbox: **Create** › Workflow (now enabled) and Cache; **Steps** (one per processor); **Caches** (every cache
    from `api.listCaches`). Items are HTML5-draggable with `dataTransfer` type `application/acto` and JSON
    `{ kind: 'workflow' } | { kind: 'cache-new' } | { kind: 'step', processorId } | { kind: 'cache', cacheId }`.
  - `dropTarget.ts`: `dropVerdict(item, at: Point, boards: BoardWorkflow[]): { do: 'newWorkflow'; at } | { do: 'addStep'; workflowId; at } | { do: 'swap'; workflowId; stepId } | { do: 'newCache'; workflowId } | { do: 'linkCache'; workflowId; cacheId } | { refused: string }`
    — workflow only on empty board ("Drop a new workflow on empty board"); steps/caches only inside a frame
    ("Drop a step inside a workflow" / "Drop a cache inside a workflow"); a step item on a step → swap; a cache
    already linked → refused "<cache> is already linked to <workflow>".
  - `cacheChipAt(index: number, frame: Rect): Point` — chips 140×28 px in a row along the frame's bottom inside the
    padding, 8 px apart; the frame grows (via `frameSizeOf` + 44 px) to fit them.
  - `CacheChip` node (`type: 'cache'`, child of the frame) showing the cache name; selectable; toolbar Delete
    unlinks (a new cache is just removed).
  - New workflow drop: `newWorkflowState(newId(), untitled, at)` added to the store; Output "new-workflow-N created —
    it is saved only when you press Save".

- [ ] **Step 1: Tests:** `dropVerdict` for each case above with exact refusal texts; Toolbox items carry the right
  `dataTransfer` JSON on `dragStart`; a linked cache renders a chip in its frame and Delete unlinks it.
- [ ] **Step 2–4:** fail → implement → pass. **Step 5: Commit** — `feat(acto): drop workflows, steps and caches from the toolbox; cache chips`.

---

### Task 9: Inspector editing, Undo/Redo header and keys

**Files:**
- Modify: `src/Acto/src/inspector/InspectorPanel.tsx`, `src/Acto/src/App.tsx`
- Create: `src/Acto/src/inspector/fields.tsx` (small field components), `src/Acto/src/design/keys.ts`
- Test: `src/Acto/src/inspector/InspectorEdit.test.tsx`, `src/Acto/src/design/keys.test.ts`

**Interfaces:**
- Consumes: `setWorkflowField`, `setStepField`, `setPayload`, `removeAssignment`, `setCacheField`, `boardStore`,
  `payloadCheck` (copied in Plan 1: validate the payload JSON against the step processor's config schema when the
  graph carries it; show its messages under the field, never block typing).
- Produces:
  - Editable fields: workflow name, version, description, cron (text; `cronText` shown under it); step name, version,
    description, entry condition (select of the five, label "Entry condition · colours every wire into this step");
    assignment payload (textarea, JSON) with **Remove assignment** (the one in-panel action); cache name, version,
    description, root, items. Each keystroke commits with merge key `field:<entity>:<key>` → one undo step per run
    of typing.
  - Header: workflow name of the selection's workflow + **Undo** / **Redo** buttons (greyed when unavailable or
    nothing selected). No Revert anywhere.
  - `keys.ts`: `undoRedoKey(e: KeyboardEvent): 'undo' | 'redo' | null` — Ctrl/Meta+Z → undo, Ctrl/Meta+Shift+Z or
    Ctrl/Meta+Y → redo; ignored when the target is an input, textarea or select. App wires it on `document`.

- [ ] **Step 1: Tests:** typing "ab" into the step name commits one history step and the card shows "ab"; Undo
  restores the old name and clears unsaved; changing the entry condition to F recolours the wires into the step
  (edge `data.condition === 2`); an invalid payload shows the checker's message and is still kept; `undoRedoKey`
  table (including the input-target case).
- [ ] **Step 2–4:** fail → implement → pass. **Step 5: Commit** — `feat(acto): edit in the inspector with one undo history per workflow`.

---

### Task 10: End-to-end designing against the live BaseAPI

**Files:**
- Create: `src/Acto/e2e/design.spec.ts`

**Interfaces:**
- Consumes: the running stack on :18080. **Writes only to a throwaway workflow it creates** and deletes afterwards
  with `POST /api/v1/workflows/{id}/delete` (no dry run) in `afterAll`.

- [ ] **Step 1: Write the spec:** drag **Workflow** from the toolbox onto empty board → a frame "new-workflow-N"
  with the unsaved tag; drag a Steps item into it → a step card; select the frame → toolbar Save → Output shows
  "new-workflow-N saved" and "Kibana diagram published", the unsaved tag disappears; reload → the frame is still
  there at the same position and size; `GET /api/v1/workflows/{id}.svg` answers 200 with an `<svg`.
- [ ] **Step 2: Run** `npx playwright test e2e/design.spec.ts` → passes (if the stack is unreachable, report it).
- [ ] **Step 3: Commit** — `test(acto): design and save a workflow end to end`.
