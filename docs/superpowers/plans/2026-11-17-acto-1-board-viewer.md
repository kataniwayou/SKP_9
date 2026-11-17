# Acto Plan 1 — Board Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working, read-only Acto at `src/Acto` that shows every workflow on one board as frames with steps, coloured
arrow-headed wires, first/parked tags, live running state and processor health, plus the resizable panel shell, a
read-only Inspector, a Toolbox listing Steps with health, and the Output panel; and WorkflowStudio keeping Acto's
`board` field when it saves.

**Architecture:** A new Vite + React 19 app beside WorkflowStudio. Data, API, model and live code is copied from
WorkflowStudio (its tests come along); everything about the board is new and split into pure modules
(`board/*.ts`: layout parsing, placement, step roles, wires, loading, React Flow mapping) with thin React components
on top. No dockview, no elkjs, no circuit model.

**Tech Stack:** Vite 8, React 19, TypeScript 5.9, `@xyflow/react` 12.12.0, `@microsoft/signalr` 10.0.11, ajv 8.17.1,
Vitest 5 + Testing Library + jsdom, Playwright 1.63.

**Spec:** `docs/superpowers/specs/2026-11-17-acto-design.md`

**Plan series** (each leaves working software; Plans 2–4 are written after this one lands):
1. **Board viewer** (this plan).
2. Designing: step/frame drag and resize, wiring, toolbox drops, Inspector editing, one history per workflow, Save +
   validate + Kibana SVG, new workflow, caches.
3. Operating: toolbars (single with arrow, multi bar), Start/Stop, Delete with dry run, copy/paste, Ctrl+click
   multi-select, shared-entity lock.
4. Chat, light/dark themes, nginx/Dockerfile/`k8s` manifest, transition.

## Global Constraints

- App lives in `src/Acto`; npm package name `acto`. All commands below run from `src/Acto` unless they say otherwise.
- Dependencies exactly: `@microsoft/signalr` 10.0.11, `@xyflow/react` 12.12.0, `ajv` 8.17.1, `react` 19.3.0,
  `react-dom` 19.3.0; dev deps as WorkflowStudio's `package.json` (same versions). **No** `dockview-react`, **no**
  `elkjs`, **no** `@fontsource/*` (fonts come from CSS stacks; the board uses "Inter Tight", "Helvetica Neue", Arial,
  sans-serif and "IBM Plex Mono", ui-monospace, Consolas, monospace).
- Same-origin with BaseAPI: API base `/api/v1`, hub `/api/hubs/liveness`; dev proxy `/api` → `process.env.SKP_API ??
  'http://localhost:18080'` with `ws: true`. Dev port 5174; e2e port 5180.
- Simplicity: no menu bar, no keyboard hints shown anywhere.
- Entry-condition colours (wire, arrowhead, pill) on the white board: 1 Completed `C` `#0F9488`, 2 Failed `F`
  `#E0482F`, 3 Cancelled `X` `#C27C06`, 4 Always `A` `#7C4FD6`, 5 Never `N` `#DB2777`; anything else `?` `#64748B`.
- State colours: running `#16A34A`, stopped `#DC2626`, checking/unknown `#D97706`; health dot healthy `#16A34A`,
  unhealthy `#DC2626`, undetermined `#94A3B8`; selection accent `#FF0072`.
- Geometry: frame header 46 px; frame padding 28 px; step card 210 × 92 px; frame minimum 420 × (46 + 150) px.
- localStorage keys: `acto.panels`, `acto.outputNewestFirst`, `acto.view`. Every read/write in try/catch.
- WorkflowStudio must keep working: its full Vitest suite stays green after Task 1.

## Review Focus

1. **One workflow's graph fails to load** (404, 500, network) — the other frames still appear and Output names the one
   that failed. Test in Task 5.
2. **Malformed or missing layout** (`null`, a string, `board` with non-numbers, steps with `NaN`) — treated as absent,
   the workflow is auto-placed, nothing throws. Tests in Task 3.
3. **A cycle in the links** (A→B→A) or a `nextStepIds` id not in the workflow — roles and wires terminate; the unknown
   id draws no wire. Tests in Task 4.
4. **Live feed not connected / status unknown** — frame badge reads "Checking…" in amber and health dots are grey; no
   crash when a processor id is missing from the snapshot. Test in Task 8.
5. **A workflow with no steps** — an empty frame at minimum size with the line "Empty workflow". Test in Task 6.

---

### Task 1: WorkflowStudio keeps `board` when it saves

**Files:**
- Modify: `src/WorkflowStudio/src/design/layoutDesign.ts` (`SavedLayout`, `layoutOf`)
- Test: `src/WorkflowStudio/src/design/layoutDesign.test.ts`

**Interfaces:**
- Produces: `SavedLayout.board?: { x: number; y: number; w: number; h: number }`; `layoutOf` copies
  `shown.graph.layout.board` through unchanged when it is an object of four finite numbers, and omits it otherwise.

- [ ] **Step 1: Write the failing tests** (in the existing `describe` for `layoutOf`, using the file's existing document
  fixture helper)

```ts
it('carries the Acto board rectangle through unchanged', () => {
  const doc = withRawLayout({ v: 2, board: { x: 1200, y: 480, w: 960, h: 420 } });
  expect(layoutOf(doc, EMPTY_DRAFT).board).toEqual({ x: 1200, y: 480, w: 960, h: 420 });
});
it('drops a board that is not four finite numbers', () => {
  expect(layoutOf(withRawLayout({ v: 2, board: { x: 'a', y: 0, w: 1, h: 1 } }), EMPTY_DRAFT)).not.toHaveProperty('board');
  expect(layoutOf(withRawLayout(null), EMPTY_DRAFT)).not.toHaveProperty('board');
});
```
`withRawLayout(raw)` is a local helper in the test: the file's usual document fixture with `graph.layout = raw`.

- [ ] **Step 2: Run to see them fail** — from `src/WorkflowStudio`: `npx vitest run src/design/layoutDesign.test.ts` →
  2 failures.
- [ ] **Step 3: Implement** — add the optional field to `SavedLayout` and spread `{ board }` into `layoutOf`'s result
  when valid.
- [ ] **Step 4: Run the whole WorkflowStudio suite** — `npx vitest run` → all pass; `npx tsc --noEmit` → no errors.
- [ ] **Step 5: Commit** — `git add src/WorkflowStudio/src/design/layoutDesign.ts src/WorkflowStudio/src/design/layoutDesign.test.ts`
  then `git commit -m "fix(studio): a save keeps Acto's board rectangle in the layout"`.

---

### Task 2: Scaffold `src/Acto` with the copied foundation

**Files:**
- Create: `src/Acto/{package.json,tsconfig.json,vite.config.ts,index.html,playwright.config.ts}`, `src/Acto/src/main.tsx`,
  `src/Acto/src/App.tsx` (renders `<h1>Acto</h1>` for now), `src/Acto/src/smoke.test.ts`
- Copy from `src/WorkflowStudio` (same relative paths, tests included): `openapi/`, `scripts/gen-api.mjs`,
  `src/api/{client,describeError,entities,fixtures,liveStatus,liveness,schema.d,toModel,types}.ts` (+ tests),
  `src/model/*` (all), `src/live/*` (all), `src/test/{setup,fakeHub,liveStub,memoryStorage}.ts`
- Create: `src/Acto/src/api/designLog.ts` (the `DesignLogLine` interface and `OutputLevel` type moved out of
  WorkflowStudio's `store/saveLog.ts`/`store/output.ts`), `src/Acto/src/model/geometry.ts`
- Modify (copies only): `src/Acto/src/api/toModel.ts` imports `DesignLogLine` from `./designLog`

**Interfaces:**
- Produces: everything copied keeps its WorkflowStudio exports and names. New:
  `model/geometry.ts`: `export interface Point { x: number; y: number }`, `export interface Rect { x: number; y: number; w: number; h: number }`.
- `package.json` scripts: `dev` (`vite`), `build` (`tsc --noEmit && vite build`), `typecheck`, `test` (`vitest run`),
  `e2e` (`playwright test`), `gen:api` (`node scripts/gen-api.mjs`).
- `vite.config.ts`: WorkflowStudio's minus the `/ai` plugin and proxy (chat comes in Plan 4); port 5174; test block
  identical.

- [ ] **Step 1: Write `src/smoke.test.ts`**

```ts
import { render, screen } from '@testing-library/react';
import { it, expect } from 'vitest';
import { App } from './App';
it('renders Acto', () => { render(<App />); expect(screen.getByRole('heading', { name: 'Acto' })).toBeInTheDocument(); });
```
(Name the file `smoke.test.tsx`.)
- [ ] **Step 2: Create the config files, copy the folders, `npm install`** (copy WorkflowStudio's `package-lock.json`
  first, then `npm install` prunes dockview, elkjs and fontsource).
- [ ] **Step 3: Run** — `npx vitest run` → the copied api/model/live tests and the smoke test pass; `npx tsc --noEmit` →
  no errors. A copied test that needs a module not listed above is deleted, not ported (name each in the commit
  message).
- [ ] **Step 4: Commit** — `git add src/Acto` (with `node_modules` excluded by the repo's `.gitignore`; check
  `git status` shows none) and `git commit -m "feat(acto): scaffold with WorkflowStudio's api, model and live code"`.

---

### Task 3: Read a layout and place frames

**Files:**
- Create: `src/Acto/src/board/layoutDoc.ts`, `src/Acto/src/board/placement.ts`, `src/Acto/src/board/geometry.ts`
- Test: `src/Acto/src/board/layoutDoc.test.ts`, `src/Acto/src/board/placement.test.ts`

**Interfaces:**
- Produces:
  - `board/geometry.ts`: `HEADER_H = 46`, `FRAME_PAD = 28`, `STEP_W = 210`, `STEP_H = 92`, `FRAME_MIN_W = 420`,
    `FRAME_MIN_BODY_H = 150`, `FRAME_GAP = 80`, `BOARD_ROW_W = 2400`.
  - `board/layoutDoc.ts`: `interface ActoLayout { steps: Record<Id, Point>; caches: Record<Id, Point>; parked: Id[]; board: Rect | null }`;
    `parseActoLayout(raw: unknown): ActoLayout` (never throws; ignores anything not of the right shape, like
    WorkflowStudio's `parseLayout`, whose point/record helpers it may copy).
  - `board/placement.ts`:
    `frameSizeOf(stepAt: ReadonlyMap<Id, Point>): { w: number; h: number }` — content box of all steps + `FRAME_PAD`,
    at least `FRAME_MIN_W` × (`HEADER_H` + `FRAME_MIN_BODY_H`);
    `defaultStepPositions(entryStepIds: Id[], steps: ReadonlyMap<Id, Pick<Step,'nextStepIds'>>, placed: ReadonlyMap<Id, Point>): Map<Id, Point>` —
    returns positions for the steps **not** in `placed`: column = BFS depth from the entry steps (unreached steps go in
    the column after the deepest), x = `FRAME_PAD + column * (STEP_W + 70)`, y = `FRAME_PAD + row * (STEP_H + 40)`;
    `placeFrames(items: { id: Id; createdAt: string; stored: Rect | null; size: { w: number; h: number } }[]): Map<Id, Rect>` —
    stored rects are kept as they are; the rest, by `createdAt` ascending, go into the first free slot of rows
    `BOARD_ROW_W` wide, left to right, top to bottom, `FRAME_GAP` apart, never overlapping a stored or placed rect.

- [ ] **Step 1: Write the failing tests**

```ts
// layoutDoc.test.ts
it('reads steps, caches, parked and board', () => {
  const l = parseActoLayout({ v: 2, steps: { s1: { x: 10, y: 20 } }, caches: {}, parked: ['s1'], board: { x: 5, y: 6, w: 700, h: 300 } });
  expect(l).toEqual({ steps: { s1: { x: 10, y: 20 } }, caches: {}, parked: ['s1'], board: { x: 5, y: 6, w: 700, h: 300 } });
});
it.each([null, 'x', 42, { board: { x: 1, y: 2, w: 'w', h: 3 } }, { steps: { s1: { x: NaN, y: 0 } } }])(
  'treats %j as no layout', (raw) => {
    const l = parseActoLayout(raw);
    expect(l.board).toBeNull(); expect(l.steps).toEqual({});
  });
// placement.test.ts
it('keeps stored rects and places the rest by creation time without overlap', () => {
  const r = placeFrames([
    { id: 'b', createdAt: '2026-02-01', stored: null, size: { w: 500, h: 300 } },
    { id: 'a', createdAt: '2026-01-01', stored: null, size: { w: 500, h: 300 } },
    { id: 'k', createdAt: '2025-01-01', stored: { x: 0, y: 0, w: 600, h: 300 }, size: { w: 600, h: 300 } },
  ]);
  expect(r.get('k')).toEqual({ x: 0, y: 0, w: 600, h: 300 });
  expect(r.get('a')!.x).toBeLessThan(r.get('b')!.x + (r.get('b')!.y > r.get('a')!.y ? 1e9 : 0));
  for (const [i, p] of [...r.values()].entries()) for (const q of [...r.values()].slice(i + 1))
    expect(p.x + p.w + 79 < q.x || q.x + q.w + 79 < p.x || p.y + p.h + 79 < q.y || q.y + q.h + 79 < p.y).toBe(true);
});
it('sizes an empty frame at the minimum', () => expect(frameSizeOf(new Map())).toEqual({ w: 420, h: 196 }));
it('gives unplaced steps columns by depth', () => {
  const steps = new Map([['e', { nextStepIds: ['m'] }], ['m', { nextStepIds: [] }], ['p', { nextStepIds: [] }]]);
  const at = defaultStepPositions(['e'], steps, new Map());
  expect(at.get('e')).toEqual({ x: 28, y: 28 }); expect(at.get('m')).toEqual({ x: 308, y: 28 }); expect(at.get('p')!.x).toBe(588);
});
```
- [ ] **Step 2: Run** — `npx vitest run src/board` → fail (modules missing).
- [ ] **Step 3: Implement** the three files with the signatures above.
- [ ] **Step 4: Run** — `npx vitest run src/board` → pass.
- [ ] **Step 5: Commit** — `git commit -m "feat(acto): read layouts with a board rectangle and place frames"`.

---

### Task 4: Step roles and wires

**Files:**
- Create: `src/Acto/src/board/roles.ts`, `src/Acto/src/board/wires.ts`
- Test: `src/Acto/src/board/roles.test.ts`, `src/Acto/src/board/wires.test.ts`

**Interfaces:**
- Consumes: `Step`, `Id` (`model/graph`), `Point`, `Rect` (`model/geometry`), `STEP_W`, `STEP_H` (`board/geometry`).
- Produces:
  - `type StepRole = 'first' | 'parked' | 'reached'`;
    `stepRoles(stepIds: Id[], links: ReadonlyArray<{ from: Id; to: Id }>): Map<Id, StepRole>` — no incoming and some
    outgoing → `first`; no wires at all → `parked`, except when `stepIds.length === 1` → `first`; otherwise `reached`.
  - `derivedEntrySteps(roles: ReadonlyMap<Id, StepRole>): Id[]` (the `first` ones, in `stepIds` order).
  - `entryDiff(stored: Id[], derived: Id[]): { stops: Id[]; starts: Id[] }`.
  - `interface Wire { id: string; from: Id; to: Id; condition: number }`;
    `wiresOf(stepIds: Id[], steps: ReadonlyMap<Id, Pick<Step,'nextStepIds'|'entryCondition'>>): Wire[]` — one per
    link `from→to` where both ids are in `stepIds`; `id = \`${from}>${to}\``; `condition` = the **target's**
    `entryCondition`.
  - `conditionStyle(condition: number): { letter: string; colour: string; name: string }` — the Global Constraints
    table.
  - `landings(wires: Wire[], boxOf: (id: Id) => Rect | null): Map<string, { out: Point; in: Point }>` — out on the
    source's right edge, in on the target's left edge; a side with n > 1 wires puts wire k (sorted by the other end's
    centre y) at `top + h * (0.22 + 0.56 * k / (n - 1))`; n = 1 → the middle.

- [ ] **Step 1: Write the failing tests**

```ts
// roles.test.ts
const L = (pairs: string[]) => pairs.map((p) => ({ from: p[0]!, to: p[1]! }));
it('marks first, parked and reached', () => {
  expect(Object.fromEntries(stepRoles(['a', 'b', 'c', 'p'], L(['ab', 'bc'])))).toEqual({ a: 'first', b: 'reached', c: 'reached', p: 'parked' });
});
it('runs a lone step as first', () => expect(stepRoles(['a'], [])).toEqual(new Map([['a', 'first']])));
it('terminates on a cycle and gives no first step', () => {
  expect([...stepRoles(['a', 'b'], L(['ab', 'ba'])).values()]).toEqual(['reached', 'reached']);
});
it('reports entry differences', () => expect(entryDiff(['a', 'x'], ['a', 'b'])).toEqual({ stops: ['x'], starts: ['b'] }));
// wires.test.ts
const steps = new Map([['a', { nextStepIds: ['b', 'ghost'], entryCondition: 1 }], ['b', { nextStepIds: [], entryCondition: 2 }]]);
it('makes one wire per known link, coloured by the target', () => {
  expect(wiresOf(['a', 'b'], steps)).toEqual([{ id: 'a>b', from: 'a', to: 'b', condition: 2 }]);
  expect(conditionStyle(2)).toEqual({ letter: 'F', colour: '#E0482F', name: 'Failed' });
  expect(conditionStyle(0)).toEqual({ letter: '?', colour: '#64748B', name: 'Invalid' });
});
it('spreads and sorts landings so fan-in does not cross', () => {
  const box = (id: string) => ({ u: { x: 0, y: 0, w: 210, h: 92 }, d: { x: 0, y: 400, w: 210, h: 92 }, t: { x: 400, y: 200, w: 210, h: 92 } } as Record<string, Rect>)[id] ?? null;
  const l = landings([{ id: 'd>t', from: 'd', to: 't', condition: 1 }, { id: 'u>t', from: 'u', to: 't', condition: 1 }], box);
  expect(l.get('u>t')!.in).toEqual({ x: 400, y: 200 + 92 * 0.22 });
  expect(l.get('d>t')!.in).toEqual({ x: 400, y: 200 + 92 * 0.78 });
  expect(l.get('u>t')!.out).toEqual({ x: 210, y: 46 });
});
```
- [ ] **Step 2: Run** — `npx vitest run src/board/roles.test.ts src/board/wires.test.ts` → fail.
- [ ] **Step 3: Implement** both files.
- [ ] **Step 4: Run** → pass.
- [ ] **Step 5: Commit** — `git commit -m "feat(acto): step roles, entry differences and coloured wires with sorted landings"`.

---

### Task 5: Load the board

**Files:**
- Create: `src/Acto/src/board/loadBoard.ts`, `src/Acto/src/board/testApi.ts` (test fixture, used again in Task 9)
- Test: `src/Acto/src/board/loadBoard.test.ts`

**Interfaces:**
- Consumes: `StudioApi` (`api/client`: `listWorkflows`, `getGraph`, `getStep`, `getProcessor`), `graphFromDto`,
  `stepFromDto`, `processorFromDto` (`api/toModel`), `reachableStepIds` (`model/reachability`), `parseActoLayout`,
  `defaultStepPositions`, `frameSizeOf`, `placeFrames`, `stepRoles`, `derivedEntrySteps`, `entryDiff`, `wiresOf`.
- Produces:
  ```ts
  interface BoardWorkflow {
    graph: Graph;                 // parked steps added to graph.steps, as WorkflowStudio's loadDocument does
    stepIds: Id[];                // every step in the frame: reachable + layout parked/steps that still exist
    stepAt: Map<Id, Point>;       // relative to the frame's content origin (below the header)
    frame: Rect;                  // after placeFrames
    roles: Map<Id, StepRole>;
    wires: Wire[];
    entryDiff: { stops: Id[]; starts: Id[] };
  }
  interface BoardLoad { workflows: BoardWorkflow[]; failures: { workflowId: Id; name: string; detail: string }[] }
  loadWorkflow(api: StudioApi, workflowId: Id): Promise<ApiResult<Omit<BoardWorkflow, 'frame'> & { storedFrame: Rect | null }>>;
  loadBoard(api: StudioApi, concurrency?: number /* default 4 */): Promise<BoardLoad>;
  ```
  `loadWorkflow` follows `src/WorkflowStudio/src/app/loadDocument.ts` for parked steps (a parked id that is gone is
  dropped; any other failure is returned) but uses `parseActoLayout` and `defaultStepPositions`, and never touches
  elkjs or circuits. It never rejects (exceptions become `{ ok: false, error: { kind: 'http', status: 0, detail } }`).

- [ ] **Step 1: Create the fixture and write the failing tests.** `board/testApi.ts` exports
  `fakeApi(o: { workflows?: WorkflowReadDto[]; graph?: WorkflowGraphDto; graphs?: Record<Id, WorkflowGraphDto>; graphError?: Record<Id, ApiError>; extraSteps?: Record<Id, StepReadDto> }): StudioApi`
  (every other call answers `{ ok: false, error: { kind: 'notFound' } }`; built like the `fakeApi` in WorkflowStudio's
  `app/loadDocument.test.ts`), `wf(id: Id, createdAt = '2026-01-01'): WorkflowReadDto` (name `id + '-name'`),
  `graphWith(g: { entry: Id[]; steps: Record<Id, Id[]>; layout?: unknown }): WorkflowGraphDto` (step names
  `id + '-name'`, entry condition 1), `stepDto(id: Id): StepReadDto`.

```ts
it('loads every workflow and places them', async () => {
  const r = await loadBoard(fakeApi({ workflows: [wf('w1', '2026-01-01'), wf('w2', '2026-01-02')] }));
  expect(r.workflows.map((w) => w.graph.workflow.id)).toEqual(['w1', 'w2']);
  expect(r.failures).toEqual([]);
});
it('keeps the others when one graph fails, and names the failure', async () => {
  const r = await loadBoard(fakeApi({ workflows: [wf('w1'), wf('w2')], graphError: { w2: { kind: 'http', status: 500, detail: 'boom' } } }));
  expect(r.workflows.map((w) => w.graph.workflow.id)).toEqual(['w1']);
  expect(r.failures).toEqual([{ workflowId: 'w2', name: 'w2-name', detail: 'boom' }]);
});
it('brings parked steps from the layout and drops ones that are gone', async () => {
  const r = await loadWorkflow(fakeApi({ graph: graphWith({ entry: ['a'], steps: { a: [] }, layout: { parked: ['p', 'gone'] } }), extraSteps: { p: stepDto('p') } }), 'w1');
  expect(r.ok && r.value.stepIds).toEqual(['a', 'p']);
  expect(r.ok && r.value.roles.get('p')).toBe('parked');
});
it('reports stored first steps that differ from the wires', async () => {
  const r = await loadWorkflow(fakeApi({ graph: graphWith({ entry: ['a', 'b'], steps: { a: ['b'], b: [] } }) }), 'w1');
  expect(r.ok && r.value.entryDiff).toEqual({ stops: ['b'], starts: [] });
});
```
- [ ] **Step 2: Run** → fail. **Step 3: Implement.** **Step 4: Run** → pass.
- [ ] **Step 5: Commit** — `git commit -m "feat(acto): load every workflow onto the board"`.

---

### Task 6: Draw the board with React Flow

**Files:**
- Create: `src/Acto/src/board/toFlow.ts`, `src/Acto/src/board/Board.tsx`, `src/Acto/src/board/nodes/WorkflowFrame.tsx`,
  `src/Acto/src/board/nodes/StepCard.tsx`, `src/Acto/src/board/edges/LinkWire.tsx`, `src/Acto/src/board/board.css`
- Test: `src/Acto/src/board/toFlow.test.ts`, `src/Acto/src/board/Board.test.tsx`

**Interfaces:**
- Consumes: `BoardWorkflow`, `landings`, `conditionStyle`, `STEP_W`, `STEP_H`, `HEADER_H`.
- Produces:
  - `toFlow(workflows: BoardWorkflow[]): { nodes: Node[]; edges: Edge[] }` — per workflow a node
    `{ id: 'wf:'+id, type: 'workflow', position: frame xy, style: { width, height }, data: { workflowId } }`; per step
    `{ id: 'st:'+wfId+':'+stepId, type: 'step', parentId: 'wf:'+wfId, extent: 'parent', position: { x, y: y + HEADER_H }, data: { workflowId, stepId, role } }`
    (a step shared by two workflows gets one node per frame — ids differ by workflow); per wire
    `{ id: 'wi:'+wfId+':'+wire.id, type: 'link', source, target, data: { condition, out, in } }` with `out`/`in` from
    `landings` in board coordinates.
  - `<Board workflows={BoardWorkflow[]} selection={Selection|null} onSelect={(s: Selection|null) => void} initialZoom?={number} />` (`initialZoom` only for tests and view restore) where
    `type Selection = { kind: 'workflow'; workflowId: Id } | { kind: 'step'; workflowId: Id; stepId: Id } | { kind: 'wire'; workflowId: Id; wireId: string }`
    (exported from `src/Acto/src/board/selection.ts`).
  - Frame look: header with name, `version · cron` (cron as `cronText` from `model/cronText`, "not scheduled" when
    null), the state badge slot (Task 8), and a stripe; dotted board background; MiniMap; Controls (zoom in/out/fit).
    An empty workflow shows "Empty workflow" centred in its body. Below zoom 0.4 a frame hides its steps and wires and
    shows only its name, state and "n steps" (React Flow `useStore` on the zoom).
  - Step card look per the mock: processor icon square in the processor's colour (stable colour by processor name
    hash over the five condition colours is fine), step name, processor name, a footer with the health dot slot
    (Task 8); FIRST / PARKED tags above the card; parked cards at 60 % opacity with a dashed border.
  - `LinkWire`: a bezier from `data.out` to (`data.in.x - 9`, `data.in.y`) with control points `dx = max(40, |Δx|/2)`,
    stroke = condition colour, width 2.2, `markerEnd` arrow in that colour, and a filled circle (r 8) with the letter
    24 px before the target.

- [ ] **Step 1: Write the failing tests**

```ts
// toFlow.test.ts
it('nests steps in their frame and gives shared steps one node per frame', () => {
  const { nodes } = toFlow([bw('w1', ['a', 's']), bw('w2', ['s'])]);
  expect(nodes.filter((n) => n.type === 'step').map((n) => [n.id, n.parentId])).toEqual([
    ['st:w1:a', 'wf:w1'], ['st:w1:s', 'wf:w1'], ['st:w2:s', 'wf:w2']]);
});
it('makes one coloured edge per wire', () => {
  const { edges } = toFlow([bw('w1', ['a', 'b'], [{ id: 'a>b', from: 'a', to: 'b', condition: 4 }])]);
  expect(edges).toHaveLength(1); expect(edges[0]!.data).toMatchObject({ condition: 4 });
});
// Board.test.tsx
it('shows every workflow name, an empty frame line and the minimap', async () => {
  render(<Board workflows={[bw('w1', ['a']), bw('w2', [])]} selection={null} onSelect={() => {}} />);
  expect(await screen.findByText('w1-name')).toBeInTheDocument();
  expect(screen.getByText('Empty workflow')).toBeInTheDocument();
  expect(document.querySelector('.react-flow__minimap')).not.toBeNull();
});
it('shows only name and step count when zoomed far out', async () => {
  render(<Board workflows={[bw('w1', ['a', 'b'])]} selection={null} onSelect={() => {}} initialZoom={0.3} />);
  expect(await screen.findByText('2 steps')).toBeInTheDocument();
  expect(screen.queryByText('a-name')).toBeNull();
});
it('reports a click on a step as a step selection', async () => {
  const onSelect = vi.fn();
  render(<Board workflows={[bw('w1', ['a'])]} selection={null} onSelect={onSelect} />);
  await userEvent.click(await screen.findByText('a-name'));
  expect(onSelect).toHaveBeenCalledWith({ kind: 'step', workflowId: 'w1', stepId: 'a' });
});
```
`bw(id, stepIds, wires?)` is a test fixture in `src/Acto/src/board/fixtures.ts` (create it) returning a `BoardWorkflow`
with `name: id + '-name'`, steps named `stepId + '-name'`, positions from `defaultStepPositions`.
- [ ] **Step 2: Run** → fail. **Step 3: Implement.** **Step 4: Run** → pass, and `npx tsc --noEmit` clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(acto): draw workflows as frames with steps and coloured wires"`.

---

### Task 7: The shell — panels, splitters, Output

**Files:**
- Create: `src/Acto/src/shell/Shell.tsx`, `src/Acto/src/shell/panelSizes.ts`, `src/Acto/src/shell/shell.css`,
  `src/Acto/src/output/outputStore.ts`, `src/Acto/src/output/OutputPanel.tsx`
- Test: `src/Acto/src/shell/panelSizes.test.ts`, `src/Acto/src/shell/Shell.test.tsx`,
  `src/Acto/src/output/outputStore.test.ts`, `src/Acto/src/output/OutputPanel.test.tsx`

**Interfaces:**
- Produces:
  - `panelSizes.ts`: `interface PanelSizes { tools: number; inspector: number; bottom: number; output: number | null }`;
    `DEFAULT_SIZES = { tools: 200, inspector: 300, bottom: 190, output: null }` (`null` = half);
    `LIMITS = { tools: [150, 340], inspector: [240, 520], bottom: [90, 420], output: [200, 900] }`;
    `clampSize(key, value): number`; `readSizes(storage: Storage | null): PanelSizes` and
    `writeSizes(storage: Storage | null, s: PanelSizes): void` under `acto.panels`.
  - `<Shell toolbox board inspector output chat />` (five `ReactNode` props; `chat` renders an empty "Chat" panel in
    this plan). CSS grid as the spec's screen diagram; four splitters (`role="separator"`, `aria-orientation`), drag
    changes the size within `LIMITS`, double-click resets to the default, sizes persisted.
  - `outputStore.ts`: `type Level = 'info' | 'ok' | 'warn' | 'error'`; `interface OutputLine { at: string; text: string; level: Level }`;
    `createOutputStore(storage: Storage | null)` with `lines()`, `log(text, level?)`, `clear()`,
    `newestFirst()`, `setNewestFirst(b)` (persisted under `acto.outputNewestFirst`), `subscribe(fn)`;
    a React context `OutputProvider` / `useOutput()`.
  - `<OutputPanel />`: header "Output", a count ("3 messages"), a two-button toggle **Newest last** / **Newest first**
    (`aria-pressed`), **Clear all**; body lists lines; in Newest last the body scrolls to the end on every new line.

- [ ] **Step 1: Write the failing tests**

```ts
// panelSizes.test.ts
it('clamps and round-trips sizes', () => {
  const st = memoryStorage();
  writeSizes(st, { tools: clampSize('tools', 999), inspector: 300, bottom: clampSize('bottom', 10), output: null });
  expect(readSizes(st)).toEqual({ tools: 340, inspector: 300, bottom: 90, output: null });
  expect(readSizes(null)).toEqual(DEFAULT_SIZES);
});
// outputStore.test.ts
it('logs, clears and remembers the order', () => {
  const st = memoryStorage(); const o = createOutputStore(st);
  o.log('a'); o.log('b', 'warn'); expect(o.lines().map((l) => l.text)).toEqual(['a', 'b']);
  o.setNewestFirst(true); expect(createOutputStore(st).newestFirst()).toBe(true);
  o.clear(); expect(o.lines()).toEqual([]);
});
// OutputPanel.test.tsx
it('shows newest first when asked, and Clear all empties it', async () => {
  const o = createOutputStore(null); o.log('first'); o.log('second');
  render(<OutputProvider store={o}><OutputPanel /></OutputProvider>);
  await userEvent.click(screen.getByRole('button', { name: 'Newest first' }));
  expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('second');
  await userEvent.click(screen.getByRole('button', { name: 'Clear all' }));
  expect(screen.getByText('No messages.')).toBeInTheDocument();
});
// Shell.test.tsx
it('resets a splitter on double-click', async () => {
  render(<Shell toolbox="T" board="B" inspector="I" output="O" chat="C" />);
  const sep = screen.getAllByRole('separator')[0]!;
  fireEvent.pointerDown(sep, { clientX: 216 }); fireEvent.pointerMove(sep, { clientX: 316 }); fireEvent.pointerUp(sep);
  expect(screen.getByTestId('shell')).toHaveStyle({ '--tw': '300px' });
  fireEvent.doubleClick(sep); expect(screen.getByTestId('shell')).toHaveStyle({ '--tw': '200px' });
});
```
- [ ] **Step 2: Run** → fail. **Step 3: Implement.** **Step 4: Run** → pass.
- [ ] **Step 5: Commit** — `git commit -m "feat(acto): resizable panel shell and the Output panel"`.

---

### Task 8: Live state and processor health

**Files:**
- Create: `src/Acto/src/board/live/StateBadge.tsx`, `src/Acto/src/board/live/HealthDot.tsx`
- Modify: `src/Acto/src/board/nodes/WorkflowFrame.tsx`, `src/Acto/src/board/nodes/StepCard.tsx`,
  `src/Acto/src/board/edges/LinkWire.tsx`, `src/Acto/src/board/Board.tsx` (MiniMap `nodeStrokeColor`)
- Test: `src/Acto/src/board/live/live.test.tsx`

**Interfaces:**
- Consumes: `useWorkflowStatus(workflowId): LiveStatus`, `useHealthOf(): HealthOf`, `useProcessorLive(id)`,
  `livenessText(known, processor)` (copied `live/`), `LiveStoreProvider`, `createLiveStore`, `signalRHub`.
- Produces:
  - `<StateBadge status={LiveStatus} />`: `running` → "Running" green with a pulsing dot (no pulse under
    `prefers-reduced-motion`); `stopped` → "Stopped" red; `checking`/`unknown` → "Checking…" amber. The frame header
    stripe uses the same colour.
  - `<HealthDot processorId={Id | null} />`: green/red/grey by `useHealthOf()`; `title` = `livenessText(...)`.
  - Wires of a running workflow get class `running` (moving dashes `stroke-dasharray: 7 4`, animated; none under
    reduced motion); stopped → solid.
  - MiniMap: workflow nodes stroked green when running, red when stopped, amber otherwise.

- [ ] **Step 1: Write the failing tests** (wrap in `<LiveStoreProvider value={liveStub({...})}>`, the copied
  `test/liveStub.ts`; `renderWithLive(ui, state)` is a local helper doing exactly that)

```ts
it('shows Running, Stopped and Checking…', () => {
  const { rerender } = render(<StateBadge status="running" />); expect(screen.getByText('Running')).toBeInTheDocument();
  rerender(<StateBadge status="stopped" />); expect(screen.getByText('Stopped')).toBeInTheDocument();
  rerender(<StateBadge status="unknown" />); expect(screen.getByText('Checking…')).toBeInTheDocument();
});
it('colours a dot by health and is grey for an unknown processor', () => {
  renderWithLive(<><HealthDot processorId="p1" /><HealthDot processorId="nope" /></>,
    { processorsKnown: 'known', processors: new Map([['p1', { live: true, healthy: 2, replicas: 2, reason: null }]]) });
  const [ok, unknown] = screen.getAllByTestId('health-dot');
  expect(ok).toHaveAttribute('data-health', 'healthy'); expect(ok).toHaveAttribute('title', 'live · 2 of 2 replicas healthy');
  expect(unknown).toHaveAttribute('data-health', 'undetermined');
});
```
- [ ] **Step 2: Run** → fail. **Step 3: Implement** and wire the badge, dot and running class into the frame, card and
  wire. **Step 4: Run** → pass.
- [ ] **Step 5: Commit** — `git commit -m "feat(acto): running state on frames and wires, processor health on steps"`.

---

### Task 9: Read-only Inspector, Toolbox Steps, and the App

**Files:**
- Create: `src/Acto/src/inspector/InspectorPanel.tsx`, `src/Acto/src/toolbox/ToolboxPanel.tsx`,
  `src/Acto/src/session/view.ts`
- Modify: `src/Acto/src/App.tsx`, `src/Acto/src/main.tsx`, `src/Acto/src/smoke.test.tsx`
- Test: `src/Acto/src/inspector/InspectorPanel.test.tsx`, `src/Acto/src/toolbox/ToolboxPanel.test.tsx`,
  `src/Acto/src/session/view.test.ts`, `src/Acto/src/App.test.tsx`

**Interfaces:**
- Consumes: everything above; `api.listProcessors()`.
- Produces:
  - `<InspectorPanel workflows={BoardWorkflow[]} selection={Selection | null} />`, read-only in this plan:
    nothing selected → "Board: n workflows, r running" (r from live status); workflow → name, version, description,
    cron, steps count, wires count, position and size; step → name, version, entry condition as letter + name,
    processor name, its liveness line, role, and "shared · n" with the workflow names when the step id is in more than
    one loaded workflow; wire → from, to, "Runs when" + condition name, and the line "The colour is the entry condition
    of <to>. Change it on that step; every wire into it follows."
  - `<ToolboxPanel processors={Processor[]} />`: sections **Create** (a disabled "Workflow" item with the note
    "drop anywhere on the board" — enabled in Plan 2) and **Steps** (one item per processor: icon, name, `HealthDot`,
    and the liveness line).
  - `view.ts`: `interface SavedView { x: number; y: number; zoom: number; selection: Selection | null }`;
    `readView(storage)` / `writeView(storage, v)` under `acto.view`; the board restores it on load and fits all frames
    when there is none; a saved selection whose target no longer exists is dropped.
  - `App`: creates the API (`createApi()`), live store (`createLiveStore({ api, hub: signalRHub() })`), output store;
    calls `loadBoard`; logs `"Board loaded: n workflows"` (ok), one `"Could not load <name>: <detail>"` (error) per
    failure, and per workflow with a non-empty `entryDiff` one warn line
    `"<name>: on Save, <stops> stops being a first step; <starts> starts running"` (only the parts present), and marks
    that frame (an amber "first steps differ" tag in the header).

- [ ] **Step 1: Write the failing tests**

```ts
// view.test.ts
it('round-trips the view and survives broken storage', () => {
  const st = memoryStorage(); writeView(st, { x: 1, y: 2, zoom: 0.8, selection: { kind: 'workflow', workflowId: 'w1' } });
  expect(readView(st)).toEqual({ x: 1, y: 2, zoom: 0.8, selection: { kind: 'workflow', workflowId: 'w1' } });
  const throwing = { getItem: () => { throw new Error('blocked'); } } as unknown as Storage;
  expect(readView(throwing)).toBeNull();
});
// InspectorPanel.test.tsx
it('explains where a wire colour comes from', () => {
  const w = bw('w1', ['a', 'b'], [{ id: 'a>b', from: 'a', to: 'b', condition: 2 }]);
  render(<InspectorPanel workflows={[w]} selection={{ kind: 'wire', workflowId: 'w1', wireId: 'a>b' }} />);
  expect(screen.getByText('Failed')).toBeInTheDocument();
  expect(screen.getByText(/The colour is the entry condition of b-name/)).toBeInTheDocument();
});
it('names the workflows sharing a step', () => {
  render(<InspectorPanel workflows={[bw('w1', ['s']), bw('w2', ['s'])]} selection={{ kind: 'step', workflowId: 'w1', stepId: 's' }} />);
  expect(screen.getByText(/shared · 2/)).toBeInTheDocument();
});
// App.test.tsx (fakeApi/wf/graphWith from board/testApi, live from test/liveStub)
it('loads the board and reports a differing first step', async () => {
  renderApp(fakeApi({ workflows: [wf('w1')], graph: graphWith({ entry: ['a', 'b'], steps: { a: ['b'], b: [] } }) }));
  expect(await screen.findByText(/Board loaded: 1 workflows?/)).toBeInTheDocument();
  expect(screen.getByText(/b-name stops being a first step/)).toBeInTheDocument();
});
```
- [ ] **Step 2: Run** → fail. **Step 3: Implement**; replace the smoke test's heading check with "Acto" in the top bar.
  **Step 4: Run** — `npx vitest run` (everything) → pass; `npx tsc --noEmit` → clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(acto): read-only inspector, toolbox steps with health, view restore"`.

---

### Task 10: End-to-end against the live BaseAPI

**Files:**
- Create: `src/Acto/e2e/board.spec.ts`
- Modify: `src/Acto/playwright.config.ts` (copied from WorkflowStudio; `PORT = 5180`, same viewport 1600 × 900,
  `webServer` runs `npx vite --port 5180 --strictPort`)

**Interfaces:**
- Consumes: the running stack on `localhost:18080` (`k8s/port-forward-realstack.ps1`), GET only.

- [ ] **Step 1: Write the spec**

```ts
test('every workflow BaseAPI holds has a frame, with its state badge', async ({ page, request }) => {
  const workflows = await (await request.get('/api/v1/workflows')).json() as { name: string }[];
  await page.goto('/');
  for (const w of workflows) await expect(page.locator('.react-flow__node-workflow', { hasText: w.name })).toBeVisible();
  await expect(page.locator('.react-flow__node-workflow .state-badge').first()).toHaveText(/Running|Stopped|Checking…/);
  await expect(page.getByText(/Board loaded: \d+ workflows?/)).toBeVisible();
});
test('panels resize and remember their size', async ({ page }) => {
  await page.goto('/');
  const sep = page.getByRole('separator').first(); const b = (await sep.boundingBox())!;
  await page.mouse.move(b.x + 4, b.y + 100); await page.mouse.down(); await page.mouse.move(b.x + 104, b.y + 100); await page.mouse.up();
  await page.reload();
  await expect(page.locator('[data-panel="toolbox"]')).toHaveCSS('width', '300px');
});
```
- [ ] **Step 2: Run** (stack port-forwarded) — `npx playwright test` → 2 passed. If the stack is not reachable, say so
  in the task report instead of marking it done.
- [ ] **Step 3: Commit** — `git commit -m "test(acto): board loads every workflow from the live BaseAPI"`.
