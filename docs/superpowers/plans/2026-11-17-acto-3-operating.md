# Acto Plan 3 — Operating Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator run the board: Ctrl+click several things and act on them from a pinned bar, Start/Stop and
Delete workflows from the toolbar, copy and paste steps, nudge with the arrow keys, edit a step's processor and its
schema slots, and keep shared steps/processors/caches from colliding between workflows.

**Architecture:** Builds on Plan 2's pure `WorkflowState` edits, per-workflow `History` and `boardStore`. The single
`Selection` becomes an ordered list of picks (`Selection[]`); single-pick UI is unchanged, several picks get the
selection bar. Operations that call BaseAPI (run, delete) live in `src/Acto/src/operate/` as plain async functions
over `StudioApi`, `BoardStore` and `OutputStore`, like Plan 2's `saveWorkflow`. The shared-entity lock is a pure
diff (`changedEntities`) the store checks before it commits any edit.

**Tech Stack:** as Plan 2 — React 19, `@xyflow/react` 12.12, Vitest + Testing Library (`fireEvent`), Playwright.

**Spec:** `docs/superpowers/specs/2026-11-17-acto-design.md` (§6, §6a, §8a–8c, §10, §11) · Plan 2:
`docs/superpowers/plans/2026-11-17-acto-2-designing.md` · WorkflowStudio sources ported from:
`src/WorkflowStudio/src/app/deleteWorkflow.ts`, `app/runWorkflow.ts`, `store/picks.ts`, `design/clipboard.ts`
(`freeOffset`), `app/saveDesign.ts:60-121` and `design/design.ts:130-185` (processor fields, slot copies).

**Plan series:** 1 viewer (done) · 2 designing (done) · **3 operating (this)** · 4 chat, themes, deployment,
transition, incremental frame loading.

## Global Constraints

- Everything in Plans 1 and 2's Global Constraints still holds (paths, deps, colours, geometry 46/28/210×92,
  try/catch storage, no keyboard hints, `fireEvent` in tests, one trigger per action, Undo/Redo only in the Inspector
  header + Ctrl+Z/Ctrl+Y).
- Toolbars (single pick, dark with arrow): workflow **▶ Start** (green, class `go`) or **■ Stop** (red, class `stop`) ·
  **Save** · **Delete**; step **Copy** · **Delete**; wire **Delete**; cache **Delete**. Start shows while the workflow
  is not running (enabled only when `stopped`); Stop shows while `running`.
- Several picks: no per-node toolbar; a light **selection bar pinned top-centre** of the board, accent border, a pink
  pill `n SELECTED` first; a pink numbered badge (pick order, from 1) on every picked frame, step, wire and cache.
  Bar actions: steps/wires → **Copy** · **Delete**; workflows → **▶ Start n** (stopped ones) · **■ Stop n** (running
  ones) · **Save n** (unsaved ones) · **Delete**; a button whose n is 0 is not shown; mixed → the text
  `no action in common`.
- One action = **one undo step per workflow it touched**. Undo/Redo act on the workflow of the **last** pick.
- Keys (never shown): Ctrl+V paste, Ctrl+Z/Ctrl+Y, arrows nudge picked steps (or a picked frame) by **8 px**,
  Esc cancels a drag in progress. All ignored while typing in an input, textarea, select or contentEditable. The
  Delete key does nothing.
- Never-saved workflow (`entry.base === null`): Start/Stop refused with `<name>: not saved yet — BaseAPI has no such
  workflow`; Delete just discards it (no request).
- Output keeps the newest **500** lines (`OUTPUT_LIMIT = 500`).
- Run timeout `RUN_TIMEOUT_MS = 30_000`; fresh live reading for Delete `FRESH_READING_MS = 5000`.
- Clipboard in **sessionStorage** key `acto.clip` (this tab, survives refresh), try/catch.
- Lock message: `<entity> is being changed in <workflow> — save or undo it there first`.

## Review Focus

1. **Delete while the live reading is stale or missing** — the frame must stay and Output must say why; the dry run
   is never skipped. Test in Task 3.
2. **Paste where it would overlap** — pasted steps land on free space inside the target frame (never on top of an
   existing step, never above the header); the frame grows to hold them. Test in Task 4.
3. **Undo after a multi-pick Delete across two workflows** — each workflow undoes on its own; undoing one leaves the
   other deleted. Test in Task 5.
4. **Editing a shared step in B while A has unsaved changes to it** — refused with the lock message, B's history gets
   no step; after A saves, B shows A's values and keeps B's own unsaved work. Test in Tasks 8 and 9.
5. **A pick that disappears** (workflow deleted, step undone away) — picks drop it, the Inspector and bar never
   crash, Ctrl+V with a dead pick says to select a workflow. Test in Tasks 1 and 3.

---

### Task 1: Picks — Ctrl+click several things

**Files:**
- Create: `src/Acto/src/board/picks.ts`, `src/Acto/src/board/picks.test.ts`
- Modify: `src/Acto/src/board/Board.tsx`, `board/toFlow.ts`, `board/nodes/{WorkflowFrame,StepCard,CacheChip}.tsx`,
  `board/edges/LinkWire.tsx`, `board/board.css`, `src/Acto/src/App.tsx`, `inspector/InspectorPanel.tsx`
- Test: `board/Board.test.tsx`, `inspector/InspectorPanel.test.tsx`, `App.test.tsx`

**Interfaces:**
- Consumes: `Selection` (`board/selection.ts`), `keepExistingSelection` (`session/view.ts`).
- Produces:
  ```ts
  export type Pick = Selection;
  export function pickKey(p: Pick): string;            // 'wf:<wf>' | 'st:<wf>:<step>' | 'wi:<wf>:<wire>' | 'ca:<wf>:<cache>'
  export function togglePick(picks: readonly Pick[], p: Pick): Pick[];   // removes if present, else appends
  export const lastPick = (picks: readonly Pick[]): Pick | null;
  export function livePicks(picks: readonly Pick[], workflows: BoardWorkflow[]): Pick[];  // drops picks whose thing is gone
  ```
  `BoardProps`: `selection`/`onSelect` replaced by `picks: Pick[]` and `onPick(p: Pick | null, additive: boolean)`
  (additive = Ctrl or Meta held). Node and edge data gain `pick?: { no: number; solo: boolean }` (no = 1-based order,
  solo = exactly one pick). `InspectorPanel({ workflows, picks, store })`.

- [ ] **Step 1: Write failing tests** — `picks.test.ts`: `togglePick([], a)` → `[a]`; `togglePick([a,b], a)` → `[b]`;
  `pickKey` of a step `{kind:'step',workflowId:'w1',stepId:'s1'}` is `'st:w1:s1'`; `livePicks` drops a step pick whose
  step is not in its workflow's `stepIds` and a workflow pick whose workflow is gone. `Board.test.tsx`: Ctrl+click on
  two step cards calls `onPick(step, true)` each time; with two picks each picked node shows `.pick-no` with `1` and
  `2` and no `[role=toolbar]` renders; with one pick the toolbar renders and no `.pick-no`. `InspectorPanel.test.tsx`:
  three picks → heading `3 selected` and one row per pick in pick order (workflow name / step name / `from → to` /
  cache name); Undo/Redo act on the last pick's workflow. `App.test.tsx`: plain click replaces picks, Ctrl+click
  toggles; dragging one of two picked steps keeps both picks; keyboard selection (React Flow's Enter on a focused
  node) reaches the Inspector (Plan 1 carry-over); a picked step undone away drops out of the picks (Review Focus 5).
- [ ] **Step 2: Run** `npx vitest run src/board src/inspector src/App.test.tsx` → the new tests FAIL.
- [ ] **Step 3: Implement** `picks.ts`; App holds `picks: Pick[]`, `onPick` = `additive ? togglePick : [p]` (null
  clears), runs `livePicks` whenever `workflows` change; `SavedView.selection` keeps `lastPick` (one pick restored).
  The undo/redo key handler uses `lastPick(picks)?.workflowId`. Per-node toolbars render only when `pick.solo`.
  Badge CSS: pink circle 18 px, white 600 11px text, top-left −8/−8, same size at any zoom (scale by `1/zoom` like
  the toolbar).
- [ ] **Step 4: Run** the same command → PASS; `npx vitest run` and `npx tsc --noEmit` green.
- [ ] **Step 5: Commit** — `feat(acto): Ctrl+click picks several things, numbered badges`.

### Task 2: Start and Stop

**Files:**
- Create: `src/Acto/src/operate/runWorkflow.ts`, `operate/runWorkflow.test.ts`, `operate/transitions.ts`,
  `operate/transitions.test.ts`
- Modify: `board/Toolbar.tsx`, `board/nodes/WorkflowFrame.tsx`, `board/nodes/boardContext.ts`, `App.tsx`,
  `output/outputStore.ts` (+ its test)

**Interfaces:**
- Consumes: `StudioApi.startWorkflow/stopWorkflow`, `LiveStore` (`getState`, `onWorkflowChange`), `statusOf`,
  `BoardStore.entry`, `describeError`.
- Produces:
  ```ts
  export const RUN_TIMEOUT_MS = 30_000;
  export type RunOp = 'start' | 'stop';
  export async function runWorkflow(api: StudioApi, store: BoardStore, output: OutputStore, live: LiveStore,
    workflowId: Id, op: RunOp, later?: (run: () => void, ms: number) => void): Promise<'requested' | 'refused' | 'failed'>;
  export function watchTransitions(live: LiveStore, output: OutputStore, nameOf: (id: Id) => string | null): () => void;
  ```
  `ToolbarActions` gains `start(wf: string): void`, `stop(wf: string): void`; `BlockStatus` gains
  `run: LiveStatus`. `Toolbar` gains prop `run?: { op: RunOp; enabled: boolean; onRun: () => void }`.

- [ ] **Step 1: Write failing tests** — `runWorkflow.test.ts` with a fake api/live:
  - never-saved workflow → `'refused'`, no request, Output `new-workflow-1: not saved yet — BaseAPI has no such workflow`;
  - unsaved Start → Output first `orders: started the saved workflow; your unsaved changes are not part of this run`,
    then `orders: Start requested`, request sent;
  - 422 `{detail:'processor liveness: x is not live'}` → `'failed'`, Output error `orders: Start refused — processor liveness: x is not live`;
  - network error → Output error `orders: Start failed — Network error: …`;
  - accepted, live still `stopped` when `later`'s callback runs → Output error `orders: Start accepted, but it is still not running after 30 s`; live `running` by then → no such line.
  `transitions.test.ts`: a `onWorkflowChange` event `{workflowId:'w1', running:true}` → Output ok `orders is running`;
  `running:false` → info `orders stopped`; unsubscribe stops logging. `outputStore` test: 501 logs keep the last 500.
  Toolbar test: status `stopped` → `▶ Start` enabled; `running` → `■ Stop`; `checking` → `▶ Start` disabled.
- [ ] **Step 2: Run** `npx vitest run src/operate src/output src/board` → FAIL.
- [ ] **Step 3: Implement.** App starts `watchTransitions` in an effect (name from `store.entry(id)?.history.present.fields.name`)
  and passes `start`/`stop` in `toolbar`; the frame reads `useWorkflowStatus` for the button.
- [ ] **Step 4: Run** the same command → PASS; full `npx vitest run`, `npx tsc --noEmit` green.
- [ ] **Step 5: Commit** — `feat(acto): start and stop a workflow from its toolbar; output keeps 500 lines`.

### Task 3: Delete workflows (dry run, confirm in the toolbar)

**Files:**
- Create: `src/Acto/src/operate/deleteWorkflow.ts`, `operate/deleteWorkflow.test.ts`
- Modify: `design/boardStore.ts` (+ test), `board/Toolbar.tsx`, `board/nodes/WorkflowFrame.tsx`,
  `board/nodes/boardContext.ts`, `App.tsx`

**Interfaces:**
- Consumes: `StudioApi.listLive`, `deleteWorkflow(id, dryRun)`; `runningOf` (`live/liveState.ts`).
- Produces:
  ```ts
  export const FRESH_READING_MS = 5000;
  export interface DeletePlan { ids: Id[]; names: string[]; steps: number; assignments: number; caches: number;
    processors: number; neverSaved: Id[] }
  export async function prepareDelete(api: StudioApi, store: BoardStore, output: OutputStore, ids: Id[],
    wait?: (ms: number) => Promise<void>): Promise<DeletePlan | null>;
  export function confirmText(plan: DeletePlan): string;
  export async function commitDelete(api: StudioApi, store: BoardStore, output: OutputStore, plan: DeletePlan): Promise<Id[]>;
  ```
  `BoardStore.remove(id: Id): void` (drops the workflow and its draft). `ToolbarActions` gains
  `remove(wfs: string[]): void`, `confirmRemove(): void`, `cancelRemove(): void`, `pendingRemove(): DeletePlan | null`.

- [ ] **Step 1: Write failing tests** (`deleteWorkflow.test.ts`):
  - live reading slower than `FRESH_READING_MS` (fake `wait` resolves first) → null, Output error
    `orders: not deleted — could not confirm it is stopped (no live reading within 5 s)`, no delete request;
  - live set contains `w1` → null, `orders: not deleted — it is running. Stop it first`;
  - dry run with errors `[{message:'step s is shared'}]` → null, `orders: not deleted — step s is shared`;
  - dry run `{steps:5, assignments:3, caches:1, processors:2}` → plan; `confirmText` = `5 steps, 3 assignments go. Delete orders?`;
  - two workflows → summed counts and `9 steps, 4 assignments go. Delete 2 workflows?`; one refused → null (all or nothing);
  - only never-saved → no request at all, `confirmText` = `Delete new-workflow-1? It was never saved.`;
  - `commitDelete`: applied → `store.remove` called, Output ok `orders deleted: 5 steps, 3 assignments`; `applied:false`
    → frame stays, errors logged; never-saved → removed, Output `new-workflow-1 discarded`.
  `boardStore` test: `remove` drops the entry and its `acto.drafts` record.
- [ ] **Step 2: Run** `npx vitest run src/operate src/design` → FAIL.
- [ ] **Step 3: Implement.** Toolbar Delete → `prepareDelete([wf])`; when a plan returns, the workflow toolbar shows
  `confirmText` + **Delete** (danger) + **Cancel** instead of its buttons. Cancel → Output `Delete cancelled — nothing
  was sent`. Any pick change drops a pending plan silently. After `commitDelete`, picks drop the deleted ids.
- [ ] **Step 4: Run** → PASS; full suite and tsc green.
- [ ] **Step 5: Commit** — `feat(acto): delete a workflow after a fresh live reading and a dry run`.

### Task 4: Copy and paste steps

**Files:**
- Create: `src/Acto/src/operate/clipboard.ts`, `operate/clipboard.test.ts`
- Modify: `design/keys.ts` (+ test), `board/Toolbar.tsx`, `board/nodes/StepCard.tsx`, `board/nodes/boardContext.ts`, `App.tsx`

**Interfaces:**
- Consumes: `WorkflowState`, `StepState`, `setPayload`-style assignment shape, `newId`, `STEP_W/STEP_H/FRAME_PAD`.
- Produces:
  ```ts
  export interface ClipStep { id: Id; name: string; version: string; description: string | null; entryCondition: number;
    processorId: Id | null; at: Point /* board coordinates */; payload: string | null }
  export interface Clip { steps: ClipStep[]; wires: [Id, Id][]; pasted: number }
  export const PASTE_CELL = 32; export const PASTE_MARGIN = 16;
  export function copyClip(parts: { state: WorkflowState; stepIds: Id[] }[]): Clip | null;
  export function pasteClip(s: WorkflowState, clip: Clip, near: Id | null, newId: () => Id): { state: WorkflowState; pasted: Id[] };
  export function freeOffset(group: Rect[], obstacles: Rect[], start: Point, margin?: number): Point;  // port of Studio's
  export function readClip(session: Storage | null): Clip | null;
  export function writeClip(session: Storage | null, clip: Clip): void;
  export function pasteKey(e: KeyboardEvent): boolean;   // in design/keys.ts
  ```
  `ToolbarActions` gains `copy(wf: string, step: string): void`.

- [ ] **Step 1: Write failing tests** (`clipboard.test.ts`):
  - `copyClip` of steps a,b (a→b, a→c) keeps wire `[a,b]` only, positions in board coordinates
    (`frame.x + at.x`, `frame.y + HEADER_H + at.y`), each step's assignment payload copied (null without one);
  - `pasteClip` into the same workflow: new ids, names `extract-2` style (unique in the workflow), same processor,
    `entryCondition` kept, wire remapped to the new ids, a new assignment with the copied payload (`isNew: true`);
  - `near` = a step at (100,60) → group top-left at (100 + STEP_W + 40, 60) unless that overlaps, then `freeOffset`;
  - no `near` → clip origin mapped into the frame plus `(pasted + 1) × 32` on both axes; never left of / above
    `FRAME_PAD` in `at` coordinates; an overlapping start moves to the nearest free 32-px offset (Review Focus 2);
  - `pasteKey` true for Ctrl+V / Meta+V on the body, false inside input/textarea/select/contentEditable;
  - `readClip` survives a throwing storage (returns null).
  App test: step toolbar **Copy** → Output `Copied 2 steps and 1 wire`; Ctrl+V with a workflow picked adds the steps
  as one undo step and picks the pasted steps; Ctrl+V with no pick → Output `Select a workflow to paste into`; with
  no clip → `Nothing copied yet`; `clip.pasted` increases per paste.
- [ ] **Step 2: Run** `npx vitest run src/operate src/design/keys.test.ts src/App.test.tsx` → FAIL.
- [ ] **Step 3: Implement.** Target = last pick's workflow; `near` = last pick when it is a step. A picked wire alone
  copies nothing: Output `Nothing to copy — pick steps`.
- [ ] **Step 4: Run** → PASS; full suite and tsc green.
- [ ] **Step 5: Commit** — `feat(acto): copy steps from the toolbar, paste with Ctrl+V`.

### Task 5: The selection bar for several picks

**Files:**
- Create: `src/Acto/src/board/selectionBar.ts`, `board/selectionBar.test.ts`, `board/SelectionBar.tsx`
- Modify: `design/state.ts` (+ test), `board/Board.tsx`, `board/board.css`, `App.tsx`

**Interfaces:**
- Consumes: Tasks 1–4 (`Pick`, `runWorkflow`, `prepareDelete/commitDelete/confirmText`, `copyClip`), `saveWorkflow`.
- Produces:
  ```ts
  export type Bar =
    | { kind: 'parts'; count: number }
    | { kind: 'workflows'; count: number; start: Id[]; stop: Id[]; save: Id[] }
    | { kind: 'mixed'; count: number };
  export function barOf(picks: readonly Pick[], status: (wf: Id) => { run: LiveStatus; unsaved: boolean }): Bar | null; // null for < 2 picks
  export function deleteParts(s: WorkflowState, stepIds: Id[], wires: [Id, Id][]): WorkflowState;   // in design/state.ts
  ```
  `BoardProps` gains `bar?: ReactNode` (rendered in a `Panel position="top-center"`).

- [ ] **Step 1: Write failing tests** — `barOf`: steps+wires from two workflows → `parts`; three workflows (one
  running, one stopped, one stopped+unsaved) → `start` 2 ids, `stop` 1, `save` 1; a workflow + a step → `mixed`;
  cache picks count as parts. `SelectionBar` render: pill `3 SELECTED`; `▶ Start 2`, `■ Stop 1`, `Save 1`, `Delete`;
  `Save 0` not rendered; mixed shows `no action in common` and no buttons. `deleteParts` removes the steps (as
  `removeStep`) and the wires. App test (Review Focus 3): pick a step in w1 and a wire in w2, bar **Delete** → both
  workflows changed, `store.entry('w1').history.past.length` and w2's each grow by 1; undo w1 restores the step and w2
  keeps its wire deleted; afterwards picks = the last pick's workflow. Bar **Delete** for two workflows shows the
  summed `confirmText` in the bar with **Delete**/**Cancel**.
- [ ] **Step 2: Run** `npx vitest run src/board src/design src/App.test.tsx` → FAIL.
- [ ] **Step 3: Implement.** Save n saves one workflow after another (await each). The bar stays put while panning
  (React Flow `Panel`), light background, 1 px accent border.
- [ ] **Step 4: Run** → PASS; full suite and tsc green.
- [ ] **Step 5: Commit** — `feat(acto): selection bar with the actions every pick has`.

### Task 6: Arrow nudges and Esc

**Files:**
- Modify: `design/keys.ts` (+ test), `board/Board.tsx` (+ test), `App.tsx`

**Interfaces:**
- Produces: `export function nudgeKey(e: KeyboardEvent): { dx: number; dy: number } | null` (Arrow keys → ±8 px;
  null while typing or with Ctrl/Meta/Alt). Board: Esc while a node drag is in progress puts the dragged nodes back
  where the drag began and commits nothing.

- [ ] **Step 1: Write failing tests** — `nudgeKey`: ArrowLeft → `{dx:-8,dy:0}`, ArrowDown → `{dx:0,dy:8}`, inside an
  input → null. App: two picked steps in w1, three ArrowRight presses → each step +24 x and **one** undo step (merge
  key `nudge:w1`); a picked frame moves the frame; a nudge never puts a step above the header band (clamped like
  `extent`). Board: drag start, Esc, drag stop → `onEdit.moveStep` not called and the node is back at its start.
- [ ] **Step 2: Run** `npx vitest run src/design/keys.test.ts src/board src/App.test.tsx` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; full suite and tsc green.
- [ ] **Step 5: Commit** — `feat(acto): arrow keys nudge picks, Esc cancels a drag`.

### Task 7: Edit a step's processor and its schema slots

**Files:**
- Modify: `design/state.ts`, `design/request.ts`, `design/boardStore.ts` (stored designs), `inspector/InspectorPanel.tsx`,
  `inspector/fields.tsx` (+ tests: `state.test.ts`, `request.test.ts`, `InspectorEdit.test.tsx`)

**Interfaces:**
- Consumes: `Processor`, `Schema` (with `definition`), `checkPayload`, `newId`.
- Produces (WorkflowState gains an optional map; absent = `{}`, so older session drafts still load):
  ```ts
  export type Slot = 'input' | 'output' | 'config';
  export interface SchemaCopy { id: Id; name: string; version: string; description: string | null; definition: string }
  export interface ProcessorEdit { fields: Partial<{ name: string; version: string; description: string | null }>;
    slots: Partial<Record<Slot, { copy: SchemaCopy } | { cleared: true }>> }
  // WorkflowState: processors?: Record<Id, ProcessorEdit>
  export function setProcessorField(s: WorkflowState, base: Processor, key: 'name' | 'version' | 'description', v: string | null): WorkflowState;
  export function setSlotField(s: WorkflowState, base: Processor, slot: Slot, original: Schema | null,
    key: 'name' | 'version' | 'description' | 'definition', v: string | null, newId: () => Id): WorkflowState;
  export function clearSlot(s: WorkflowState, base: Processor, slot: Slot): WorkflowState;
  ```
  Rules (Studio's): the first edit of a slot makes a **copy** (new id, the original's fields) and points the slot at it
  — the original schema is never rewritten; a copy typed back to the original removes it; a field typed back to the
  base value removes that field; an empty `ProcessorEdit` is removed. The request sends
  `processors: [{ id, fields: { ...fields, <slot>SchemaId: null for cleared }, slots: { <slot>: copy.id } }]` and
  `schemas: [copies]` — same keys as `src/WorkflowStudio/src/app/saveDesign.ts:60-121` (check its test for the exact
  field names before writing).

- [ ] **Step 1: Write failing tests** — state: editing config definition creates one copy with a new id and the
  original's name/version; a second keystroke edits the same copy; typing it back removes it (same object as before
  the first edit is not required, `sameState` with the base is); `clearSlot` then undo restores. Request: one processor
  with a renamed field and a config copy → `processors[0]` = `{ id, fields: { name }, slots: { config: copyId } }` and
  `schemas[0].id === copyId`; a cleared input slot → `fields.inputSchemaId === null`. Stored design (`applyStored`)
  with `processors`/`schemas` restores the same `ProcessorEdit`. Inspector: step → Processor section with name,
  version, description and three slots (In/Out/Config) showing schema name + version, a JSON definition textarea and a
  **Clear** button; typing in the Config definition re-checks the payload against the copy; every edit is one undo
  step per field (merge key `field:processor:<id>:<key>` / `field:slot:<id>:<slot>:<key>`).
- [ ] **Step 2: Run** `npx vitest run src/design src/inspector` → FAIL.
- [ ] **Step 3: Implement.** `boardWorkflowOf` shows edited processor fields (the step card's processor name) and the
  slot copy as the processor's schema. A schema whose `definition` is not loaded shows `definition not loaded` and its
  slot is read-only.
- [ ] **Step 4: Run** → PASS; full suite and tsc green.
- [ ] **Step 5: Commit** — `feat(acto): edit a step's processor and its schema slots in the inspector`.

### Task 8: The shared-entity lock

**Files:**
- Create: `src/Acto/src/design/shared.ts`, `design/shared.test.ts`
- Modify: `design/boardStore.ts` (+ test), `board/nodes/StepCard.tsx`, `inspector/InspectorPanel.tsx`, `App.tsx`

**Interfaces:**
- Consumes: `WorkflowState`, `ProcessorEdit` (Task 7), `BoardWorkflow`.
- Produces:
  ```ts
  export type EntityKey = `step:${Id}` | `processor:${Id}` | `cache:${Id}`;
  /** Entities whose stored fields differ: a step's fields, processorId, nextStepIds or deletion (not its position);
   *  a processor with a ProcessorEdit; a cache's fields (not linking/unlinking). */
  export function changedEntities(base: WorkflowState | null, cur: WorkflowState): Set<EntityKey>;
  export function holders(boards: BoardWorkflow[]): Map<EntityKey, Id[]>;   // workflows that show each step/processor/cache
  export function entityLabel(key: EntityKey, boards: BoardWorkflow[]): string;  // 'step extract', 'processor Analyst', 'cache rates'
  ```
  `BoardStore.lockedBy(key: EntityKey, except: Id): Id | null` — the other workflow holding an unsaved change to it.
  `edit`, `editOrRefuse`, `undo` and `redo` compute `changedEntities(present, next)`; if any key is locked by another
  workflow the edit is refused with the Global-Constraints lock message and the history is unchanged.
  Schemas are covered through their processor: a slot edit is a processor change, and a schema is never rewritten.

- [ ] **Step 1: Write failing tests** — `changedEntities`: a moved step → empty; a renamed step → `step:s1`; a new
  wire out of s1 → `step:s1`; a ProcessorEdit → `processor:p1`; a linked cache → empty, an edited cache → `cache:c1`.
  Store (Review Focus 4): s1 in w1 and w2; rename s1 in w1, then rename it in w2 → refused, Output `step extract is
  being changed in orders — save or undo it there first`, w2 history unchanged; undo the rename in w1 → w2 may edit.
  Redo in w1 after w2 took the lock → refused. StepCard shows `shared · 2` on a shared step; the Inspector shows
  `being changed in orders` and its fields disabled for a locked step/processor/cache. The first wiring change out of
  a shared step logs once `extract is shared with billing: changing its wires changes what billing runs too`.
- [ ] **Step 2: Run** `npx vitest run src/design src/board src/inspector` → FAIL.
- [ ] **Step 3: Implement.** Other frames show the **saved** value with the lock note (not A's pending value — Ruling R2).
- [ ] **Step 4: Run** → PASS; full suite and tsc green.
- [ ] **Step 5: Commit** — `feat(acto): one workflow at a time may change a shared step, processor or cache`.

### Task 9: Deleting a shared step here, and re-reading sharers after a save

**Files:**
- Modify: `design/state.ts`, `design/saveWorkflow.ts`, `design/boardStore.ts`, `App.tsx` (+ tests)

**Interfaces:**
- Consumes: `holders`, `changedEntities` (Task 8), `loadWorkflow` (`board/loadBoard.ts`).
- Produces:
  ```ts
  export function removeStepHere(s: WorkflowState, stepId: Id, shared: ReadonlySet<Id>): { state: WorkflowState } | { refused: string };
  export async function refreshSharers(api: StudioApi, store: BoardStore, output: OutputStore, savedId: Id, changed: Set<EntityKey>): Promise<void>;
  // BoardStore:
  rebase(id: Id, bw: BoardWorkflow, keys: Set<EntityKey>): void;
  ```
  `removeStepHere` (spec §8b): a non-shared step → `removeStep`. A shared step: refused with `<step> is reached from
  <source>, which <other workflows> share too — deleting it here would change them` when a **shared** step of this
  workflow wires to it; otherwise its incoming wires from this workflow's steps go, it leaves `steps` and its
  assignment here goes, and it is **not** added to `deletedSteps`. `rebase`: the re-read becomes the base; in every
  history state the entities in `keys` take the re-read values and stamps (positions kept); steps the re-read brings
  in that the state lacks are added next to their source (`source.at.x + STEP_W + 60`, same y), else at the re-read
  position. `saveWorkflow` computes `changedEntities(entry.base, present)` before saving and, after an applied save,
  calls `refreshSharers` for every other workflow in `holders` of those keys, logging `<B>: re-read after <A> saved`.

- [ ] **Step 1: Write failing tests** — `removeStepHere` for the three cases (non-shared, shared reached from a
  non-shared source, shared reached from a shared source → refused); request for a shared removal holds no
  `deletedSteps`. `rebase`: w2 unsaved (moved step s9) and s1 shared, w1 saved a rename of s1 → w2's present has the
  new name and stamp, s9 still moved, `unsaved` still true; a newly reached step appears right of its source.
  `saveWorkflow`: an applied save of a shared-step change calls `getGraph` for the sharer only.
- [ ] **Step 2: Run** `npx vitest run src/design` → FAIL.
- [ ] **Step 3: Implement.** The step toolbar and the bar's Delete use `removeStepHere` with
  `shared` = step ids whose `holders` list more than one workflow: `deleteParts` (Task 5) gains a `shared` parameter
  and goes through `removeStepHere`; a refused step stays and its refusal goes to Output.
- [ ] **Step 4: Run** → PASS; full suite and tsc green.
- [ ] **Step 5: Commit** — `feat(acto): delete a shared step from one workflow only; sharers re-read after a save`.

### Task 10: Minimap and board carry-overs

**Files:**
- Modify: `board/Board.tsx`, `board/placement.ts`, `shell/Shell.tsx` (+ tests), `board/board.css`

**Interfaces:** none new. Behaviour (spec §5, Plan 1 carry-overs): minimap draws each frame's name, outlines the
picked frames in the accent colour (others green/red by state), and a click on a frame centres the board on it
(`setCenter`, current zoom); `placeFrames` breaks equal `createdAt` ties by id; splitters write their size on pointer-up
only.

- [ ] **Step 1: Write failing tests** — placement: two workflows with the same `createdAt` place in id order whatever
  the input order; Shell: a splitter drag of 5 pointermoves writes `acto.panels` once (on pointerup); Board: the
  minimap node for a picked frame has the accent stroke; `onMiniMapClick` on a frame calls `setCenter` with its centre.
- [ ] **Step 2: Run** `npx vitest run src/board src/shell` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; full suite and tsc green.
- [ ] **Step 5: Commit** — `feat(acto): minimap names, picks and click-to-jump; stable placement; splitter writes on release`.

### Task 11: End-to-end operating against the live BaseAPI

**Files:**
- Create: `src/Acto/e2e/operate.spec.ts`

**Interfaces:** the stack on :18080. Writes **only** to throwaway workflows it creates; never presses Start (a real
processor could run — Ruling R5); `afterAll` deletes any it created that are still there
(`POST /api/v1/workflows/{id}/delete`).

- [ ] **Step 1: Write the spec:** create two throwaway workflows from the toolbox, each with one step, Save both via
  Ctrl+click + bar **Save 2**; pick one step, **Copy**, pick the other workflow, Ctrl+V → its frame has 2 steps and
  the unsaved tag; Ctrl+click both frames → bar shows `2 SELECTED`, **Delete** → bar shows `… Delete 2 workflows?`,
  confirm → both frames gone and `GET /api/v1/workflows` lists neither; the toolbar of an existing **stopped**
  workflow shows `▶ Start` (do not press it).
- [ ] **Step 2: Run** `npx playwright test e2e/operate.spec.ts` → passes (if the stack is unreachable, report it).
- [ ] **Step 3: Commit** — `test(acto): operate the board end to end`.

---

## Rulings made while writing this plan

- **R1** Several picks restore as one: the saved view keeps only the last pick. Costs: a refresh loses a multi-pick.
- **R2** A shared entity locked by A shows its **saved** value elsewhere with "being changed in A", not A's pending
  value (spec §8b says it "shows the pending change"). Costs: B shows the old value until A saves.
- **R3** Schemas are locked through their processor: slot edits make copies, so no schema is changed in place.
- **R4** Multi-workflow Delete is all-or-nothing: one refusal in the dry runs refuses the whole confirm.
- **R5** The e2e never presses Start: starting a throwaway workflow would run a real processor. Start/Stop are covered
  by unit tests and one manual check.
- **R6** Incremental frame loading (spec §5 "frames appear as graphs arrive") moves to Plan 4 with performance work;
  fine at today's 5 workflows.
- **R7** Clipboard is per tab (sessionStorage), like drafts, and survives a refresh as WorkflowStudio's did.
