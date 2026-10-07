# SKP Studio plan 4: the canvas designer (trial) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user design an open workflow's graph on the canvas (select, move, reshape and rewire wires, undo, discard) as a draft that never reaches BaseApi.

**Architecture:** A pure core under `src/design/` holds the draft (positions, wiring, wire shapes), applies it over the saved document, checks drops and keeps the undo history. The store keeps each document's draft, history and canvas picks; the session keeps the draft across a refresh. The canvas switches React Flow's block dragging on and adds its own layer for picks, the rubber band, alignment guides and Visio-style wire gestures.

**Tech Stack:** React 19.3, @xyflow/react 12.12.0 (pinned), TypeScript, Vitest 5, Playwright 1.63.

**Spec:** `docs/superpowers/specs/2026-10-07-skp-studio-04-canvas-designer-design.md` (parent: `docs/superpowers/specs/2026-10-05-skp-studio-design.md`).

## Global Constraints

- **No writes from the designer:** no POST, PUT or DELETE is caused by any designer action (spec §6). The Inspector's own writes (plan 3b) are unchanged.
- **No new dependencies.** @xyflow/react stays at 12.12.0; dockview-react stays at 8.4.1.
- **Grid:** every block top-left, bend and landing snaps to 8 px (`GRID` in `src/layout/geometry.ts`).
- **Session:** the design draft is an optional, validated field of a session document; `SESSION_VERSION` stays `1` (main spec §6.1).
- **History:** 100 steps per document, not kept across a refresh (spec §5.3).
- **Pop-outs:** every listener a gesture adds goes on the event's `ownerDocument`, never the global `document` (main spec §6.3).
- **Node ids** (React Flow): the hub is `wf`, a cache tag is `cache:{id}`, a step is its id. Wire ids are `{source}->{target}`, with `wf` as the hub's source.
- **Machine quirk:** in Git Bash `npm run …` prints nothing and exits 1; run npm scripts from PowerShell. `npx vitest …` and `npx playwright …` work anywhere. Run commands from `src/WorkflowStudio`.
- **E2e needs BaseApi:** the RealStack port-forward on `localhost:18080` (`k8s/port-forward-realstack.ps1`).

## Review Focus

1. A design draft that names a step, cache or wire BaseApi no longer has (deleted elsewhere) must not break the canvas: those parts are ignored (Task 3 test "ignores ids the saved document does not have").
2. A session whose design draft is malformed (hand-edited, an older shape) must open the document without its draft, not fail the page (Task 4 test "drops a malformed design draft").
3. After a refresh the draft is back but the history is empty: Undo must be disabled and must not drop the draft (Task 4 test "a restored draft has nothing to undo").
4. Delete with only blocks picked must do nothing; blocks are never removed in the trial (Task 7 test "Delete with no wire picked changes nothing").
5. Clicking another block while the Inspector has unsaved edits must still ask first, and the picks must not move until the user answers (Task 5 test "a click with unsaved Inspector edits asks before the picks move").

---

## File map

| File | Responsibility |
|---|---|
| `src/layout/nodeIds.ts` (new) | React Flow node ids shared by the pure core and the canvas |
| `src/layout/shape.ts` (new) | A wire's manual shape: bends, segments, drags, normalising |
| `src/layout/geometry.ts` | + landing clamp |
| `src/layout/router.ts` | + short-gap Z |
| `src/layout/wires.ts` | + manual shapes and landing offsets |
| `src/design/draft.ts` (new) | The draft and its pure edits; session parsing |
| `src/design/apply.ts` (new) | saved document + draft → shown document |
| `src/design/rules.ts` (new) | May this wire end be dropped here? |
| `src/design/history.ts` (new) | Undo / redo stacks |
| `src/design/hit.ts` (new) | Rectangles, hit tests, block boxes |
| `src/design/guides.ts` (new) | Alignment guides and their snap |
| `src/design/designProps.ts` (new) | What the canvas needs to design |
| `src/design/DesignContext.ts` (new) | Gesture entry points for edges and nodes |
| `src/design/DesignOverlay.tsx` (new) | Band, guides, ghost line, wire handles |
| `src/design/useRubberBand.ts`, `useBlockDrag.ts`, `useWireGestures.ts`, `useDesignKeys.ts` (new) | The canvas gestures and keys |
| `src/store/picks.ts` (new) | The canvas selection set |
| `src/store/studioState.ts` | + picks, design history, actions |
| `src/app/session.ts` | + the design draft |
| `src/canvas/WorkflowCanvas.tsx`, `toFlow.ts`, `selection.ts`, `edges/CableEdge.tsx`, `nodes/StepNode.tsx`, `nodes/WorkflowNode.tsx`, `fitText.ts`, `canvas.css`, `art.css` | Design mode in the canvas |
| `src/app/DocumentPanel.tsx`, `CapsuleToolbar.tsx`, `studioActions.ts`, `src/App.tsx` | Wiring, capsule, Discard, close guard |
| `src/panels/Inspector.tsx` | "N items selected" and the wire note |
| `e2e/designer.spec.ts` (new) | The trial on the current workflows |

---

### Task 1: The draft and its edits

**Files:**
- Create: `src/layout/nodeIds.ts`, `src/layout/shape.ts` (types only in this task), `src/design/draft.ts`, `src/design/draft.test.ts`
- Modify: `src/canvas/toFlow.ts:20-21` (re-export the node ids)

**Interfaces:**
- Produces: `SPHERE_NODE_ID`, `CACHE_NODE_PREFIX`, `cacheNodeId` (nodeIds.ts); `Bends`, `WireShape`, `Ends` (shape.ts); `Draft`, `EMPTY_DRAFT`, `isEmptyDraft`, `wireId`, `wireEnds`, `entriesOf`, `nextOf`, `moveBlocks`, `addWire`, `removeWires`, `reattach`, `setShape`, `resetRoute`, `parseDraft` (draft.ts).

- [ ] **Step 1: Create the node ids and point toFlow at them**

`src/layout/nodeIds.ts`:
```ts
/** React Flow node ids (canvas/toFlow.ts), shared with the pure design core. */
export const SPHERE_NODE_ID = 'wf';
export const CACHE_NODE_PREFIX = 'cache:';
export const cacheNodeId = (id: string): string => `${CACHE_NODE_PREFIX}${id}`;
```
In `src/canvas/toFlow.ts` replace
```ts
export const SPHERE_NODE_ID = 'wf';
export const cacheNodeId = (id: Id) => `cache:${id}`;
```
with
```ts
export { SPHERE_NODE_ID, cacheNodeId } from '../layout/nodeIds';
import { SPHERE_NODE_ID, cacheNodeId } from '../layout/nodeIds';
```
(move the `import` line up with the other imports).

- [ ] **Step 2: Create the shape types**

`src/layout/shape.ts` (Task 2 adds the functions):
```ts
/**
 * A manual route (spec §4.3), Visio's "reroute as needed": a wire leaves its source and lands on its
 * target horizontally, so its path is H V H V … H. `xs` is the x of each vertical run, `ys` the y of each
 * horizontal run between two verticals (`ys.length === xs.length - 1`). The first and last horizontal
 * runs are the source's and target's heights, so they follow the blocks; everything else stays.
 */
export interface Bends {
  xs: number[];
  ys: number[];
}

/** What the user did to one wire's shape. */
export interface WireShape {
  /** A manual route; null: the router decides. */
  bends: Bends | null;
  /** Step-local landing height on the target, when slid; null: the landing rule decides. */
  landing: number | null;
}

/** A wire's two ends: the source port and the landing. */
export interface Ends {
  sx: number;
  sy: number;
  tx: number;
  ty: number;
}
```

- [ ] **Step 3: Write the failing tests**

`src/design/draft.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { graphDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import {
  addWire, EMPTY_DRAFT, isEmptyDraft, moveBlocks, nextOf, entriesOf, parseDraft, reattach, removeWires, resetRoute, setShape, wireEnds, wireId,
} from './draft';

const chain = () => loadedDocument(graphDto({
  workflow: workflowDto({ entryStepIds: ['s1'] }),
  steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2', { nextStepIds: ['s3'] }), stepDto('s3')],
}));

describe('draft', () => {
  it('names a wire by its ends and reads them back', () => {
    expect(wireId('wf', 's1')).toBe('wf->s1');
    expect(wireEnds('s1->s2')).toEqual({ source: 's1', target: 's2' });
  });

  it('moves the hub (by its centre), a cache and a step; a move back to the saved place leaves nothing', async () => {
    const saved = await chain();
    const s1 = saved.placement.steps.get('s1')!;
    let d = moveBlocks(EMPTY_DRAFT, saved, new Map([['wf', { x: 0, y: 8 }], ['cache:c1', { x: 16, y: 24 }], ['s1', { x: s1.x + 32, y: s1.y }]]));
    expect(d.sphere).toEqual({ x: 96, y: 104 });
    expect(d.caches).toEqual({ c1: { x: 16, y: 24 } });
    expect(d.steps).toEqual({ s1: { x: s1.x + 32, y: s1.y } });
    d = moveBlocks(d, saved, new Map([['s1', s1]]));
    expect(d.steps).toEqual({});
  });

  it('adds a wire from a step and from the hub, and removing it again leaves an empty draft', async () => {
    const saved = await chain();
    let d = addWire(EMPTY_DRAFT, saved, 's1', 's3');
    expect(nextOf(saved, d, 's1')).toEqual(['s2', 's3']);
    d = addWire(d, saved, 'wf', 's2');
    expect(entriesOf(saved, d)).toEqual(['s1', 's2']);
    d = removeWires(d, saved, ['s1->s3', 'wf->s2']);
    expect(isEmptyDraft(d)).toBe(true);
  });

  it('removing a wire drops its shape', async () => {
    const saved = await chain();
    let d = setShape(EMPTY_DRAFT, 's1->s2', { bends: { xs: [600], ys: [] }, landing: 80 });
    d = removeWires(d, saved, ['s1->s2']);
    expect(d.routes).toEqual({});
    expect(nextOf(saved, d, 's1')).toEqual([]);
  });

  it('re-attaches either end', async () => {
    const saved = await chain();
    const t = reattach(EMPTY_DRAFT, saved, 's1->s2', 'target', 's3');
    expect(nextOf(saved, t, 's1')).toEqual(['s3']);
    const s = reattach(EMPTY_DRAFT, saved, 's2->s3', 'source', 'wf');
    expect(nextOf(saved, s, 's2')).toEqual([]);
    expect(entriesOf(saved, s)).toEqual(['s1', 's3']);
  });

  it('a shape with nothing set is no shape; reset route forgets it', () => {
    expect(setShape(EMPTY_DRAFT, 'a->b', { bends: null, landing: null }).routes).toEqual({});
    const d = setShape(EMPTY_DRAFT, 'a->b', { bends: null, landing: 72 });
    expect(resetRoute(d, 'a->b').routes).toEqual({});
  });

  it('parses its own JSON and drops what is not its shape', () => {
    const d = setShape(addWire(EMPTY_DRAFT, { graph: { workflow: { entryStepIds: [] }, steps: new Map() } } as never, 'wf', 's1'), 'wf->s1', { bends: { xs: [8, 16], ys: [40] }, landing: null });
    expect(parseDraft(JSON.parse(JSON.stringify(d)))).toEqual(d);
    expect(parseDraft('nope')).toBeNull();
    expect(parseDraft({ sphere: { x: 'a' }, steps: { s1: { x: 1, y: 2 }, s2: 5 }, next: { s1: ['s2', 3] }, routes: { 'a->b': { bends: { xs: [1], ys: [1] }, landing: null } } }))
      .toEqual({ ...EMPTY_DRAFT, steps: { s1: { x: 1, y: 2 } }, next: { s1: ['s2'] } });
  });
});
```

- [ ] **Step 4: Run the tests to see them fail**

Run: `npx vitest run src/design/draft.test.ts`
Expected: FAIL, `Failed to resolve import "./draft"`.

- [ ] **Step 5: Write `src/design/draft.ts`**

```ts
import type { StudioDocument } from '../app/document';
import { SPHERE_R, type Point } from '../layout/geometry';
import { CACHE_NODE_PREFIX, SPHERE_NODE_ID } from '../layout/nodeIds';
import { WORKFLOW_SOURCE, type SourceId } from '../layout/ports';
import type { Bends, WireShape } from '../layout/shape';
import type { Id } from '../model/graph';

export type { Bends, WireShape } from '../layout/shape';

/**
 * What the user changed relative to the saved workflow (spec §5.1). Positions and shapes are kept apart
 * from the wiring, so a later Save can write the layout and the graph separately. Never sent anywhere.
 */
export interface Draft {
  /** The hub's centre, when moved. */
  sphere: Point | null;
  /** Top-left corners of moved steps. */
  steps: Record<Id, Point>;
  /** Top-left corners of moved cache tags. */
  caches: Record<Id, Point>;
  /** A step's whole next-step list, when its wires changed. */
  next: Record<Id, Id[]>;
  /** The hub's whole entry list, when it changed. */
  entries: Id[] | null;
  /** By wire id (`source->target`). */
  routes: Record<string, WireShape>;
}

export const EMPTY_DRAFT: Draft = { sphere: null, steps: {}, caches: {}, next: {}, entries: null, routes: {} };

const empty = (r: Record<string, unknown>) => Object.keys(r).length === 0;

export function isEmptyDraft(d: Draft): boolean {
  return d.sphere === null && d.entries === null && empty(d.steps) && empty(d.caches) && empty(d.next) && empty(d.routes);
}

export const wireId = (source: SourceId, target: Id): string => `${source}->${target}`;

export function wireEnds(id: string): { source: SourceId; target: Id } {
  const at = id.indexOf('->');
  return { source: id.slice(0, at), target: id.slice(at + 2) };
}

/** A copy with a null prototype, so an id such as `__proto__` is an ordinary key. */
function copy<T>(r: Record<string, T>): Record<string, T> {
  return Object.assign(Object.create(null) as Record<string, T>, r);
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const samePoint = (a: Point | undefined, b: Point) => a !== undefined && a.x === b.x && a.y === b.y;

export function entriesOf(saved: StudioDocument, draft: Draft): Id[] {
  return draft.entries ?? saved.graph.workflow.entryStepIds;
}

export function nextOf(saved: StudioDocument, draft: Draft, stepId: Id): Id[] {
  return Object.hasOwn(draft.next, stepId) ? draft.next[stepId]! : saved.graph.steps.get(stepId)?.nextStepIds ?? [];
}

/**
 * Moves blocks to new top-left corners, by React Flow node id (`wf`, `cache:{id}`, a step id). A block
 * moved back to where the saved workflow has it is dropped from the draft.
 */
export function moveBlocks(draft: Draft, saved: StudioDocument, moved: ReadonlyMap<string, Point>): Draft {
  let sphere = draft.sphere;
  const steps = copy(draft.steps), caches = copy(draft.caches);
  for (const [id, p] of moved) {
    const at = { x: p.x, y: p.y };
    if (id === SPHERE_NODE_ID) {
      const centre = { x: p.x + SPHERE_R, y: p.y + SPHERE_R };
      const s = saved.placement.sphere;
      sphere = centre.x === s.cx && centre.y === s.cy ? null : centre;
    } else if (id.startsWith(CACHE_NODE_PREFIX)) {
      const cacheId = id.slice(CACHE_NODE_PREFIX.length);
      if (samePoint(saved.placement.caches.get(cacheId), at)) delete caches[cacheId];
      else caches[cacheId] = at;
    } else if (samePoint(saved.placement.steps.get(id), at)) delete steps[id];
    else steps[id] = at;
  }
  return { ...draft, sphere, steps, caches };
}

/** Changes one source's target list; a list equal to the saved one is dropped from the draft. */
function setTargets(draft: Draft, saved: StudioDocument, source: SourceId, change: (ids: Id[]) => Id[]): Draft {
  if (source === WORKFLOW_SOURCE) {
    const entries = change(entriesOf(saved, draft));
    return { ...draft, entries: sameList(entries, saved.graph.workflow.entryStepIds) ? null : entries };
  }
  const list = change(nextOf(saved, draft, source));
  const next = copy(draft.next);
  if (sameList(list, saved.graph.steps.get(source)?.nextStepIds ?? [])) delete next[source];
  else next[source] = list;
  return { ...draft, next };
}

export function addWire(draft: Draft, saved: StudioDocument, source: SourceId, target: Id): Draft {
  return setTargets(draft, saved, source, (ids) => (ids.includes(target) ? ids : [...ids, target]));
}

export function removeWires(draft: Draft, saved: StudioDocument, ids: readonly string[]): Draft {
  let d = draft;
  for (const id of ids) {
    const { source, target } = wireEnds(id);
    d = resetRoute(setTargets(d, saved, source, (xs) => xs.filter((x) => x !== target)), id);
  }
  return d;
}

/** Moves one end of a wire to another block; the wire becomes automatic (spec §4.4). */
export function reattach(draft: Draft, saved: StudioDocument, id: string, end: 'source' | 'target', to: SourceId): Draft {
  const { source, target } = wireEnds(id);
  const d = removeWires(draft, saved, [id]);
  return end === 'target' ? addWire(d, saved, source, to) : addWire(d, saved, to, target);
}

export function setShape(draft: Draft, id: string, shape: WireShape | null): Draft {
  const routes = copy(draft.routes);
  if (shape === null || (shape.bends === null && shape.landing === null)) delete routes[id];
  else routes[id] = shape;
  return { ...draft, routes };
}

export const resetRoute = (draft: Draft, id: string): Draft => setShape(draft, id, null);

// ---- session parsing: anything not of the draft's shape is dropped, never an error ----

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const toPoint = (v: unknown): Point | null => (isRecord(v) && isNum(v.x) && isNum(v.y) ? { x: v.x, y: v.y } : null);
const toIds = (v: unknown): Id[] | null => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : null);

function toBends(v: unknown): Bends | null {
  if (!isRecord(v) || !Array.isArray(v.xs) || !Array.isArray(v.ys)) return null;
  if (!v.xs.every(isNum) || !v.ys.every(isNum) || v.xs.length === 0 || v.ys.length !== v.xs.length - 1) return null;
  return { xs: [...v.xs], ys: [...v.ys] };
}

function records<T>(v: unknown, parse: (x: unknown) => T | null): Record<string, T> {
  const out = copy<T>({});
  if (!isRecord(v)) return out;
  for (const [k, raw] of Object.entries(v)) {
    const value = parse(raw);
    if (value !== null) out[k] = value;
  }
  return out;
}

/** The draft a session held, or null when it is not one at all. */
export function parseDraft(value: unknown): Draft | null {
  if (!isRecord(value)) return null;
  const routes = records(value.routes, (raw) => {
    if (!isRecord(raw)) return null;
    const shape: WireShape = { bends: toBends(raw.bends), landing: isNum(raw.landing) ? raw.landing : null };
    return shape.bends === null && shape.landing === null ? null : shape;
  });
  return {
    sphere: toPoint(value.sphere),
    steps: records(value.steps, toPoint),
    caches: records(value.caches, toPoint),
    next: records(value.next, toIds),
    entries: toIds(value.entries),
    routes,
  };
}
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/design/draft.test.ts src/canvas`
Expected: PASS (the canvas tests prove the node-id move changed nothing). If the parse test's last expectation fails on `{ xs: [1], ys: [1] }`, that is correct behaviour (ys must be one shorter than xs): the route is dropped.

- [ ] **Step 7: Commit**

```bash
git add src/WorkflowStudio/src/layout/nodeIds.ts src/WorkflowStudio/src/layout/shape.ts src/WorkflowStudio/src/design src/WorkflowStudio/src/canvas/toFlow.ts
git commit -m "feat(studio): the design draft and its pure edits (plan 4, trial)"
```

---

### Task 2: Wire shapes, the short-gap Z and routing with a draft

**Files:**
- Modify: `src/layout/shape.ts`, `src/layout/geometry.ts`, `src/layout/router.ts:76-90`, `src/layout/wires.ts:19-26, 52-73`
- Test: `src/layout/shape.test.ts` (new), `src/layout/router.test.ts`, `src/layout/wires.test.ts`

**Interfaces:**
- Consumes: `Bends`, `WireShape`, `Ends` (Task 1).
- Produces: `pointsOfShape(e: Ends, b: Bends): Pt[]`, `shapeFromPoints(pts: readonly Pt[]): Bends`, `normalize(e: Ends, b: Bends): Bends | null`, `dragSegment(b: Bends, k: number, p: { x: number; y: number }, e: Ends): { bends: Bends } | { landingY: number }`, `segmentHandles(e: Ends, b: Bends): SegmentHandle[]`, `nearestSegment(e: Ends, b: Bends, p: { x: number; y: number }): number`, `endsOf(points: readonly Pt[]): Ends`, `JOG = 16`; `LANDING_MIN = 64`, `LANDING_MAX = 128`, `clampLanding(v: number): number` (geometry); `WiringInput.shapes?: Readonly<Record<string, WireShape>>`.

- [ ] **Step 1: Write the failing shape tests**

`src/layout/shape.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { dragSegment, endsOf, nearestSegment, normalize, pointsOfShape, segmentHandles, shapeFromPoints } from './shape';

const e = { sx: 0, sy: 96, tx: 288, ty: 160 };

describe('shape', () => {
  it('turns a Z route into one vertical run and back', () => {
    const b = shapeFromPoints([[0, 96], [144, 96], [144, 160], [288, 160]]);
    expect(b).toEqual({ xs: [144], ys: [] });
    expect(pointsOfShape(e, b)).toEqual([[0, 96], [144, 96], [144, 160], [288, 160]]);
  });

  it('reads a U route and a route whose first run is vertical', () => {
    expect(shapeFromPoints([[0, 96], [24, 96], [24, 300], [264, 300], [264, 160], [288, 160]])).toEqual({ xs: [24, 264], ys: [300] });
    expect(shapeFromPoints([[0, 96], [0, 160], [288, 160]])).toEqual({ xs: [0], ys: [] });
  });

  it('keeps its bends when the ends move: only the first and last runs follow', () => {
    expect(pointsOfShape({ sx: 32, sy: 40, tx: 400, ty: 200 }, { xs: [144], ys: [] })).toEqual([[32, 40], [144, 40], [144, 200], [400, 200]]);
  });

  it('drags a vertical run sideways and an inner horizontal run up or down, snapped to 8', () => {
    const u = { xs: [24, 264], ys: [300] };
    expect(dragSegment(u, 1, { x: 51, y: 0 }, e)).toEqual({ bends: { xs: [48, 264], ys: [300] } });
    expect(dragSegment(u, 2, { x: 0, y: 333 }, e)).toEqual({ bends: { xs: [24, 264], ys: [336] } });
  });

  it('dragging the first run inserts a jog; the last run slides the landing', () => {
    expect(dragSegment({ xs: [144], ys: [] }, 0, { x: 50, y: 50 }, e)).toEqual({ bends: { xs: [16, 144], ys: [48] } });
    expect(dragSegment({ xs: [144], ys: [] }, 2, { x: 200, y: 131 }, e)).toEqual({ landingY: 128 });
  });

  it('dragging a straight wire puts a jog at both ends', () => {
    const flat = { sx: 0, sy: 96, tx: 288, ty: 96 };
    expect(dragSegment({ xs: [], ys: [] }, 0, { x: 100, y: 40 }, flat)).toEqual({ bends: { xs: [16, 272], ys: [40] } });
  });

  it('normalising removes a bend lined up with its neighbour, and returns null when none is left', () => {
    expect(normalize(e, { xs: [24, 264], ys: [96] })).toEqual({ xs: [264], ys: [] });
    expect(normalize({ sx: 0, sy: 96, tx: 288, ty: 96 }, { xs: [144], ys: [] })).toBeNull();
  });

  it('puts a handle on every run that has length, and finds the run nearest a point', () => {
    const b = { xs: [144], ys: [] };
    expect(segmentHandles(e, b)).toEqual([
      { k: 0, x: 72, y: 96, vertical: false },
      { k: 1, x: 144, y: 128, vertical: true },
      { k: 2, x: 216, y: 160, vertical: false },
    ]);
    expect(nearestSegment(e, b, { x: 150, y: 120 })).toBe(1);
    expect(endsOf([[0, 96], [144, 96], [144, 160], [288, 160]])).toEqual(e);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/layout/shape.test.ts`
Expected: FAIL, the functions are not exported.

- [ ] **Step 3: Add the landing clamp to `src/layout/geometry.ts`**

Append:
```ts
/** A slid landing stays inside the processor band, on the 8 px grid (spec §4.2). */
export const LANDING_MIN = 64;
export const LANDING_MAX = 128;
export const clampLanding = (v: number): number => Math.min(Math.max(snap(v), LANDING_MIN), LANDING_MAX);
```

- [ ] **Step 4: Add the functions to `src/layout/shape.ts`**

Append below the types:
```ts
import { GRID, snap } from './geometry';
import { simplify, type Pt } from './router';

/** How far a jog stands off the source port (spec §4.2). */
export const JOG = 16;

export interface SegmentHandle {
  /** The run's index: 0 is the first (horizontal) run, 2 × xs.length the last. */
  k: number;
  x: number;
  y: number;
  vertical: boolean;
}

export function endsOf(points: readonly Pt[]): Ends {
  const [sx, sy] = points[0]!;
  const [tx, ty] = points[points.length - 1]!;
  return { sx, sy, tx, ty };
}

/** The canonical path H V H … H, zero-length runs included, so run k is points k → k+1. */
export function pointsOfShape(e: Ends, b: Bends): Pt[] {
  if (b.xs.length === 0) return [[e.sx, e.sy], [e.tx, e.ty]];
  const pts: Pt[] = [[e.sx, e.sy]];
  let y = e.sy;
  b.xs.forEach((x, i) => {
    pts.push([x, y]);
    y = i < b.ys.length ? b.ys[i]! : e.ty;
    pts.push([x, y]);
  });
  pts.push([e.tx, e.ty]);
  return pts;
}

/** The bends of any right-angled path that starts and ends horizontally (a router route, simplified or not). */
export function shapeFromPoints(pts: readonly Pt[]): Bends {
  const runs: ({ v: true; x: number } | { v: false; y: number })[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i]!, [bx, by] = pts[i + 1]!;
    if (ax === bx && ay === by) continue;
    const v = ax === bx;
    if (runs.length > 0 && runs[runs.length - 1]!.v === v) continue;
    runs.push(v ? { v: true, x: ax } : { v: false, y: ay });
  }
  const xs: number[] = [], ys: number[] = [];
  runs.forEach((r, i) => {
    if (r.v) xs.push(r.x);
    else if (xs.length > 0 && runs.slice(i + 1).some((n) => n.v)) ys.push(r.y);
  });
  return { xs, ys };
}

/** Lines up runs that meet, drops bends that no longer turn; null when the path is straight. */
export function normalize(e: Ends, b: Bends): Bends | null {
  const s = shapeFromPoints(simplify(pointsOfShape(e, b)));
  return s.xs.length === 0 ? null : s;
}

/**
 * Run k dragged to p (spec §4.2): a vertical run moves sideways, an inner horizontal one up or down. The
 * first run leaves a fixed port, so it gets a jog first (on a straight wire, at both ends). The last run
 * slides the landing instead: its new height comes back as `landingY` (absolute, snapped).
 */
export function dragSegment(b: Bends, k: number, p: { x: number; y: number }, e: Ends): { bends: Bends } | { landingY: number } {
  const n = b.xs.length;
  const y = snap(p.y, GRID), x = snap(p.x, GRID);
  if (n === 0) return { bends: { xs: [snap(e.sx + JOG), snap(e.tx - JOG)], ys: [y] } };
  if (k === 0) return { bends: { xs: [snap(e.sx + JOG), ...b.xs], ys: [y, ...b.ys] } };
  if (k === 2 * n) return { landingY: y };
  if (k % 2 === 1) return { bends: { xs: b.xs.map((v, i) => (i === (k - 1) / 2 ? x : v)), ys: [...b.ys] } };
  return { bends: { xs: [...b.xs], ys: b.ys.map((v, i) => (i === k / 2 - 1 ? y : v)) } };
}

export function segmentHandles(e: Ends, b: Bends): SegmentHandle[] {
  const pts = pointsOfShape(e, b);
  const out: SegmentHandle[] = [];
  for (let k = 0; k < pts.length - 1; k++) {
    const [ax, ay] = pts[k]!, [bx, by] = pts[k + 1]!;
    if (ax === bx && ay === by) continue;
    out.push({ k, x: (ax + bx) / 2, y: (ay + by) / 2, vertical: ax === bx });
  }
  return out;
}

export function nearestSegment(e: Ends, b: Bends, p: { x: number; y: number }): number {
  const pts = pointsOfShape(e, b);
  let best = 0, bestD = Infinity;
  for (let k = 0; k < pts.length - 1; k++) {
    const [ax, ay] = pts[k]!, [bx, by] = pts[k + 1]!;
    if (ax === bx && ay === by) continue;
    const cx = Math.min(Math.max(p.x, Math.min(ax, bx)), Math.max(ax, bx));
    const cy = Math.min(Math.max(p.y, Math.min(ay, by)), Math.max(ay, by));
    const d = Math.hypot(p.x - cx, p.y - cy);
    if (d < bestD) { bestD = d; best = k; }
  }
  return best;
}
```
(Move both `import` lines to the top of the file.)

- [ ] **Step 5: Run the shape tests**

Run: `npx vitest run src/layout/shape.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing router and wiring tests**

Append to `src/layout/router.test.ts` (inside its top-level `describe`):
```ts
  it('a short forward gap with different heights gets a Z with its elbow 8 past the source (plan 4)', () => {
    expect(route(0, 0, 16, 32, 'a', 'b', 0, [])).toEqual([[0, 0], [8, 0], [8, 32], [16, 32]]);
  });
```
Append to `src/layout/wires.test.ts` (inside its top-level `describe`; it already builds placements: reuse its helper that returns a `Placement` with steps, or add this self-contained case):
```ts
  it('draws a manual shape with its bends kept, and a slid landing (plan 4)', () => {
    const placement = { sphere: { cx: 128, cy: 128 }, steps: new Map([['a', { x: 288, y: 32 }], ['b', { x: 576, y: 160 }]]), caches: new Map() };
    const steps = new Map([['a', stepOf('a', ['b'])], ['b', stepOf('b', [])]]);
    const [, ab] = routeWires({ entryStepIds: ['a'], steps, brokenEdges: new Set(), shapes: { 'a->b': { bends: { xs: [560], ys: [] }, landing: 72 } } }, placement);
    expect(ab!.points).toEqual([[512, 128], [560, 128], [560, 232], [576, 232]]);
  });
```
If `wires.test.ts` has no `stepOf` helper, add at its top:
```ts
const stepOf = (id: string, nextStepIds: string[]) => ({ id, name: id, version: '1.0.0', description: null, processorId: 'p', nextStepIds, entryCondition: 1, updatedAt: '', audit: { createdAt: '', createdBy: null, updatedAt: '', updatedBy: null } });
```

- [ ] **Step 7: Run them to see them fail**

Run: `npx vitest run src/layout/router.test.ts src/layout/wires.test.ts`
Expected: FAIL: the Z test gets a U route; the shape test gets the router's route.

- [ ] **Step 8: Add the short-gap Z to `route()` in `src/layout/router.ts`**

After the `if (tx - sx >= CLEARANCE) { … }` block add:
```ts
  // A forward gap of 16 to 23 px is too short for the shapes above; a Z with its elbow one grid step
  // past the source still beats a U that crosses both blocks (parked since plan 2).
  if (tx - sx >= 2 * GRID && tx - sx < CLEARANCE && sy !== ty) {
    candidates.push([[sx, sy], [sx + GRID, sy], [sx + GRID, ty], [tx, ty]]);
  }
```

- [ ] **Step 9: Honour shapes in `routeWires` (`src/layout/wires.ts`)**

Add to the imports:
```ts
import { clampLanding } from './geometry';
import { pointsOfShape, type WireShape } from './shape';
import { simplify } from './router';
```
(merge `simplify` into the existing `./router` import). Add to `WiringInput`:
```ts
  /** The draft's wire shapes by wire id (plan 4); absent: every wire is automatic. */
  shapes?: Readonly<Record<string, WireShape>>;
```
In `routeWires`, replace the body of `wires.map((w) => { … })` with:
```ts
  return wires.map((w) => {
    const id = `${w.source}->${w.target}`;
    const shape = input.shapes && Object.hasOwn(input.shapes, id) ? input.shapes[id] : undefined;
    const targets = [...departures.get(w.source)!.keys()];
    const nudge = offset(targets.indexOf(w.target), targets.length, PORT_GAP);
    const sx = departureX(w.source, placement), sy = departures.get(w.source)!.get(w.target)!;
    const at = placement.steps.get(w.target)!;
    const tx = at.x;
    const ty = shape?.landing != null ? at.y + clampLanding(shape.landing) : landings.get(w.target)!.get(w.source)!;
    const target = input.steps.get(w.target)!;
    const points = shape?.bends && shape.bends.xs.length > 0
      ? simplify(pointsOfShape({ sx, sy, tx, ty }, shape.bends))
      : route(sx, sy, tx, ty, boxIdOf(w.source), stepBoxId(w.target), nudge, boxes);
    return {
      id,
      source: w.source,
      target: w.target,
      points,
      condition: target.entryCondition,
      broken: w.source !== WORKFLOW_SOURCE && input.brokenEdges.has(id),
    };
  });
```

- [ ] **Step 10: Run the layout tests**

Run: `npx vitest run src/layout`
Expected: PASS. If an older router test pinned a U route for a 16-23 px gap, update it to the Z: that U was the parked bug.

- [ ] **Step 11: Commit**

```bash
git add src/WorkflowStudio/src/layout
git commit -m "feat(studio): manual wire shapes and slid landings; a short forward gap gets a Z (plan 4)"
```

---

### Task 3: Applying a draft, drop rules, and a cached text fitter

**Files:**
- Create: `src/design/apply.ts`, `src/design/apply.test.ts`, `src/design/rules.ts`, `src/design/rules.test.ts`
- Modify: `src/canvas/fitText.ts:62-80`, `src/canvas/fitText.test.ts`

**Interfaces:**
- Consumes: `Draft`, `isEmptyDraft` (Task 1); `WiringInput.shapes` (Task 2); `reachableStepIds` (`src/model/reachability.ts`).
- Produces: `applyDraft(saved: StudioDocument, draft: Draft): StudioDocument`; `DropVerdict = 'ok' | 'self' | 'duplicate' | 'cycle' | 'notStep'`; `canWire(shown: StudioDocument, source: SourceId, target: string, moving?: string): DropVerdict`.

- [ ] **Step 1: Write the failing tests**

`src/design/apply.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { graphDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { addWire, EMPTY_DRAFT, moveBlocks, removeWires, setShape } from './draft';
import { applyDraft } from './apply';

const chain = () => loadedDocument(graphDto({
  workflow: workflowDto({ entryStepIds: ['s1'] }),
  steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2', { nextStepIds: ['s3'] }), stepDto('s3')],
}));

describe('applyDraft', () => {
  it('returns the saved document itself for an empty draft', async () => {
    const saved = await chain();
    expect(applyDraft(saved, EMPTY_DRAFT)).toBe(saved);
  });

  it('draws moved blocks where the draft has them, and re-routes their wires', async () => {
    const saved = await chain();
    const s2 = saved.placement.steps.get('s2')!;
    const shown = applyDraft(saved, moveBlocks(EMPTY_DRAFT, saved, new Map([['s2', { x: s2.x, y: s2.y + 160 }]])));
    expect(shown.placement.steps.get('s2')).toEqual({ x: s2.x, y: s2.y + 160 });
    expect(shown.wires.find((w) => w.id === 's1->s2')!.points).not.toEqual(saved.wires.find((w) => w.id === 's1->s2')!.points);
  });

  it('parks a step nothing reaches any more, and what only it reached', async () => {
    const saved = await chain();
    const shown = applyDraft(saved, removeWires(EMPTY_DRAFT, saved, ['s1->s2']));
    expect(shown.parkedIds).toEqual(['s2', 's3']);
    expect(shown.wires.map((w) => w.id)).toEqual(['wf->s1', 's2->s3']);
    expect(saved.parkedIds).toEqual([]);
  });

  it('wires a new edge in, and a re-wired wire is not broken', async () => {
    const saved = await chain();
    const shown = applyDraft(saved, addWire(EMPTY_DRAFT, saved, 'wf', 's3'));
    expect(shown.graph.workflow.entryStepIds).toEqual(['s1', 's3']);
    expect(shown.wires.find((w) => w.id === 'wf->s3')!.broken).toBe(false);
  });

  it('ignores ids the saved document does not have (review focus 1)', async () => {
    const saved = await chain();
    const draft = {
      ...EMPTY_DRAFT,
      steps: { gone: { x: 0, y: 0 } },
      caches: { gone: { x: 0, y: 0 } },
      next: { gone: ['s1'], s1: ['s2', 'gone'] },
      entries: ['s1', 'gone'],
      routes: { 'gone->s1': { bends: null, landing: 80 } },
    };
    const shown = applyDraft(saved, draft);
    expect(shown.placement.steps.has('gone')).toBe(false);
    expect(shown.graph.steps.get('s1')!.nextStepIds).toEqual(['s2']);
    expect(shown.graph.workflow.entryStepIds).toEqual(['s1']);
    expect(shown.wires.map((w) => w.id)).toEqual(saved.wires.map((w) => w.id));
  });

  it('applies a manual shape by wire id', async () => {
    const saved = await chain();
    const w = saved.wires.find((x) => x.id === 's1->s2')!;
    const shown = applyDraft(saved, setShape(EMPTY_DRAFT, 's1->s2', { bends: null, landing: 128 }));
    const p = shown.placement.steps.get('s2')!;
    expect(shown.wires.find((x) => x.id === 's1->s2')!.points.at(-1)).toEqual([w.points.at(-1)![0], p.y + 128]);
  });
});
```
`src/design/rules.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { graphDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { canWire } from './rules';

const chain = () => loadedDocument(graphDto({
  workflow: workflowDto({ entryStepIds: ['s1'] }),
  steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2', { nextStepIds: ['s3'] }), stepDto('s3')],
}));

describe('canWire', () => {
  it('allows a new forward wire and an entry wire', async () => {
    const doc = await chain();
    expect(canWire(doc, 's1', 's3')).toBe('ok');
    expect(canWire(doc, 'wf', 's2')).toBe('ok');
  });

  it('refuses a self-loop, a duplicate, a cycle and a drop on no step', async () => {
    const doc = await chain();
    expect(canWire(doc, 's2', 's2')).toBe('self');
    expect(canWire(doc, 's1', 's2')).toBe('duplicate');
    expect(canWire(doc, 'wf', 's1')).toBe('duplicate');
    expect(canWire(doc, 's3', 's1')).toBe('cycle');
    expect(canWire(doc, 's1', 'wf')).toBe('notStep');
    expect(canWire(doc, 's1', 'nowhere')).toBe('notStep');
  });

  it('judges a moved wire without itself: dropping it back where it was is allowed', async () => {
    const doc = await chain();
    expect(canWire(doc, 's1', 's2', 's1->s2')).toBe('ok');
    expect(canWire(doc, 's2', 's1', 's2->s3')).toBe('cycle');
  });
});
```
Append to `src/canvas/fitText.test.ts` (inside its top-level `describe`):
```ts
  it('measures each text and font once (plan 4: a drag re-fits every frame)', () => {
    const measure = vi.fn((t: string) => t.length * 7);
    const fitter = createTextFitter(measure);
    fitter.fit('a long name', 40, 'f');
    const calls = measure.mock.calls.length;
    fitter.fit('a long name', 40, 'f');
    expect(measure.mock.calls.length).toBe(calls);
  });
```
(add `vi` to its vitest import if missing).

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/design src/canvas/fitText.test.ts`
Expected: FAIL: `./apply` and `./rules` do not exist; the fitter measures again.

- [ ] **Step 3: Write `src/design/apply.ts`**

```ts
import type { StudioDocument } from '../app/document';
import { snap, type Point } from '../layout/geometry';
import type { Placement } from '../layout/placement';
import { routeWires } from '../layout/wires';
import type { Graph, Id, Step } from '../model/graph';
import { reachableStepIds } from '../model/reachability';
import { isEmptyDraft, type Draft } from './draft';

/**
 * What the canvas shows (spec §5.1): the saved workflow with the draft laid over it. The wiring decides
 * reachability and so the parked steps (§3.5); moved blocks sit where the draft has them (the automatic
 * layout is not run again); wires are routed again with the draft's shapes. Parts naming what the saved
 * document does not have are ignored. Pure; an empty draft gives the saved document back unchanged.
 */
export function applyDraft(saved: StudioDocument, draft: Draft): StudioDocument {
  if (isEmptyDraft(draft)) return saved;
  const { graph } = saved;
  const has = (id: Id) => graph.steps.has(id);

  const steps = new Map<Id, Step>(graph.steps);
  for (const [id, next] of Object.entries(draft.next)) {
    const step = steps.get(id);
    if (step) steps.set(id, { ...step, nextStepIds: next.filter(has) });
  }
  const entryStepIds = (draft.entries ?? graph.workflow.entryStepIds).filter(has);
  const shownGraph: Graph = { ...graph, workflow: { ...graph.workflow, entryStepIds }, steps };

  const reachable = new Set(reachableStepIds(entryStepIds, steps));
  const parkedIds = [
    ...saved.parkedIds.filter((id) => !reachable.has(id)),
    ...[...steps.keys()].filter((id) => !reachable.has(id) && !saved.parkedIds.includes(id)),
  ];

  const placement: Placement = {
    sphere: draft.sphere ? { cx: snap(draft.sphere.x), cy: snap(draft.sphere.y) } : saved.placement.sphere,
    steps: overlay(saved.placement.steps, draft.steps),
    caches: overlay(saved.placement.caches, draft.caches),
  };
  // broken marks come from validate on the saved workflow (§4.4): a wire the draft made is never marked
  const brokenEdges = new Set(saved.wires.filter((w) => w.broken).map((w) => w.id));
  const wires = routeWires({ entryStepIds, steps, brokenEdges, shapes: draft.routes }, placement);
  return { graph: shownGraph, parkedIds, placement, wires, problems: saved.problems };
}

function overlay(base: ReadonlyMap<Id, Point>, moved: Readonly<Record<Id, Point>>): Map<Id, Point> {
  const out = new Map(base);
  for (const [id, p] of Object.entries(moved)) if (out.has(id)) out.set(id, { x: snap(p.x), y: snap(p.y) });
  return out;
}
```

- [ ] **Step 4: Write `src/design/rules.ts`**

```ts
import type { StudioDocument } from '../app/document';
import { WORKFLOW_SOURCE, type SourceId } from '../layout/ports';
import type { Id } from '../model/graph';

export type DropVerdict = 'ok' | 'self' | 'duplicate' | 'cycle' | 'notStep';

/**
 * May a wire from `source` to `target` exist in the shown document (spec §4.6)? `moving` is the id of the
 * wire whose end is being dragged: it is judged as if that wire were gone. A target is a step; a source
 * is a step or the hub. Refused: a self-loop, a duplicate, and a cycle (the target already reaches the
 * source). Entry wires never close a cycle.
 */
export function canWire(shown: StudioDocument, source: SourceId, target: string, moving?: string): DropVerdict {
  const { graph } = shown;
  if (target === WORKFLOW_SOURCE || !graph.steps.has(target)) return 'notStep';
  if (source !== WORKFLOW_SOURCE && !graph.steps.has(source)) return 'notStep';
  if (source === target) return 'self';
  const targetsOf = (id: SourceId): Id[] => {
    const list = id === WORKFLOW_SOURCE ? graph.workflow.entryStepIds : graph.steps.get(id)?.nextStepIds ?? [];
    return list.filter((t) => `${id}->${t}` !== moving);
  };
  if (targetsOf(source).includes(target)) return 'duplicate';
  if (source === WORKFLOW_SOURCE) return 'ok';
  const seen = new Set<Id>();
  const stack: Id[] = [target];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === source) return 'cycle';
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...targetsOf(id));
  }
  return 'ok';
}
```

- [ ] **Step 5: Cache measurements in `createTextFitter` (`src/canvas/fitText.ts`)**

Replace the start of `createTextFitter` with:
```ts
/** Widths are cached per text and font: a drag re-fits every label each frame (plan 4). */
const CACHE_LIMIT = 20000;

export function createTextFitter(raw: Measure): TextFitter {
  const cache = new Map<string, number>();
  const measure: Measure = (text, font) => {
    const key = `${font}\u0000${text}`;
    let width = cache.get(key);
    if (width === undefined) {
      if (cache.size >= CACHE_LIMIT) cache.clear();
      width = raw(text, font);
      cache.set(key, width);
    }
    return width;
  };
  return {
```
(the rest of the function body is unchanged; it already calls `measure`).

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/design src/canvas`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/WorkflowStudio/src/design src/WorkflowStudio/src/canvas/fitText.ts src/WorkflowStudio/src/canvas/fitText.test.ts
git commit -m "feat(studio): a draft is applied over the saved document; drops refuse self-loops, duplicates and cycles (plan 4)"
```

---

### Task 4: History, picks, the store and the session

**Files:**
- Create: `src/design/history.ts`, `src/design/history.test.ts`, `src/store/picks.ts`, `src/store/picks.test.ts`
- Modify: `src/store/studioState.ts`, `src/store/studioState.test.ts`, `src/app/session.ts`, `src/app/session.test.ts`

**Interfaces:**
- Consumes: `Draft`, `EMPTY_DRAFT`, `isEmptyDraft`, `parseDraft` (Task 1); `SPHERE_NODE_ID`, `cacheNodeId` (Task 1).
- Produces: `DesignHistory`, `HISTORY_DEPTH`, `historyOf`, `commit`, `undo`, `redo`, `canUndo`, `canRedo`; `Pick`, `pickKey`, `picksOf`, `togglePick`, `samePicks`, `nodePickIds`, `wirePickIds`; `OpenDocument.picks: Pick[]`, `OpenDocument.design: DesignHistory`; actions `select` (+ `picks?`), `pick`, `design`, `undo`, `redo`, `discardDesign`; `designDirty(doc: OpenDocument): boolean`; `SessionDoc.design?: Draft`.

- [ ] **Step 1: Write the failing tests**

`src/design/history.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { EMPTY_DRAFT, type Draft } from './draft';
import { canRedo, canUndo, commit, HISTORY_DEPTH, historyOf, redo, undo } from './history';

const d = (n: number): Draft => ({ ...EMPTY_DRAFT, steps: { s: { x: n, y: 0 } } });

describe('design history', () => {
  it('undoes and redoes, and a new step clears redo', () => {
    let h = commit(commit(historyOf(), d(1)), d(2));
    h = undo(h);
    expect(h.draft).toEqual(d(1));
    expect(canRedo(h)).toBe(true);
    h = redo(h);
    expect(h.draft).toEqual(d(2));
    h = commit(undo(h), d(3));
    expect(canRedo(h)).toBe(false);
  });

  it('keeps 100 steps', () => {
    let h = historyOf();
    for (let i = 1; i <= HISTORY_DEPTH + 20; i++) h = commit(h, d(i));
    expect(h.past).toHaveLength(HISTORY_DEPTH);
  });

  it('merges a run of nudges into one step; anything else breaks the run', () => {
    let h = commit(commit(commit(historyOf(), d(1)), d(2), 'nudge'), d(3), 'nudge');
    expect(undo(h).draft).toEqual(d(1));
    h = commit(commit(h, d(4)), d(5), 'nudge');
    expect(undo(h).draft).toEqual(d(4));
  });

  it('a restored draft has nothing to undo (review focus 3)', () => {
    const h = historyOf(d(7));
    expect(canUndo(h)).toBe(false);
    expect(undo(h)).toBe(h);
  });
});
```
`src/store/picks.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { picksOf, samePicks, togglePick } from './picks';

describe('picks', () => {
  it('follows a selection: the hub, a step, a processor (its step) and a cache', () => {
    expect(picksOf(null)).toEqual([]);
    expect(picksOf({ kind: 'workflow' })).toEqual([{ kind: 'node', id: 'wf' }]);
    expect(picksOf({ kind: 'processor', processorId: 'p', stepId: 's1' })).toEqual([{ kind: 'node', id: 's1' }]);
    expect(picksOf({ kind: 'cache', cacheId: 'c' })).toEqual([{ kind: 'node', id: 'cache:c' }]);
  });

  it('Ctrl+click adds and takes out', () => {
    const a = { kind: 'node', id: 'a' } as const, w = { kind: 'wire', id: 'a->b' } as const;
    expect(togglePick([a], w)).toEqual([a, w]);
    expect(togglePick([a, w], a)).toEqual([w]);
    expect(samePicks([a, w], [a, w])).toBe(true);
  });
});
```
Append to `src/store/studioState.test.ts` (inside its top-level `describe`; it already opens documents with `reduce`):
```ts
  describe('designing (plan 4)', () => {
    const opened = () => reduce(INITIAL_STATE, { type: 'open', workflowId: 'wf1', name: 'a', version: '1' });
    const draft = { ...EMPTY_DRAFT, steps: { s1: { x: 8, y: 8 } } };

    it('a selection carries its picks; picks alone keep the Inspector', () => {
      let s = reduce(opened(), { type: 'select', workflowId: 'wf1', selection: { kind: 'step', stepId: 's1' } });
      expect(s.docs[0]!.picks).toEqual([{ kind: 'node', id: 's1' }]);
      s = reduce(s, { type: 'select', workflowId: 'wf1', selection: { kind: 'step', stepId: 's1' }, picks: [{ kind: 'node', id: 's1' }, { kind: 'node', id: 's2' }] });
      expect(s.docs[0]!.picks).toHaveLength(2);
      s = reduce(s, { type: 'pick', workflowId: 'wf1', picks: [] });
      expect(s.docs[0]!.selection).toEqual({ kind: 'step', stepId: 's1' });
    });

    it('a design step is undone, redone and discarded; the document is marked while it has a draft', () => {
      let s = reduce(opened(), { type: 'design', workflowId: 'wf1', draft, picks: [{ kind: 'node', id: 's1' }] });
      expect(designDirty(s.docs[0]!)).toBe(true);
      expect(s.docs[0]!.picks).toEqual([{ kind: 'node', id: 's1' }]);
      s = reduce(s, { type: 'undo', workflowId: 'wf1' });
      expect(designDirty(s.docs[0]!)).toBe(false);
      s = reduce(s, { type: 'redo', workflowId: 'wf1' });
      expect(s.docs[0]!.design.draft).toEqual(draft);
      s = reduce(s, { type: 'discardDesign', workflowId: 'wf1' });
      expect(designDirty(s.docs[0]!)).toBe(false);
      expect(s.docs[0]!.design.past).toEqual([]);
    });
  });
```
(import `EMPTY_DRAFT` from `'../design/draft'` and `designDirty` from `'./studioState'`.)

Append to `src/app/session.test.ts` (inside its top-level `describe`):
```ts
  describe('the design draft (plan 4)', () => {
    const draft = { ...EMPTY_DRAFT, steps: { s1: { x: 8, y: 16 } } };

    it('keeps a document draft across a write and a read, with an empty history', () => {
      let state = reduce(INITIAL_STATE, { type: 'open', workflowId: 'wf1', name: 'a', version: '1' });
      state = reduce(state, { type: 'design', workflowId: 'wf1', draft });
      const storage = memoryStorage();
      writeSession(storage, sessionOf(state, new Map(), null));
      const back = restoredState(readSession(storage));
      expect(back.docs[0]!.design.draft).toEqual(draft);
      expect(back.docs[0]!.design.past).toEqual([]);
    });

    it('drops a malformed design draft (review focus 2)', () => {
      const storage = memoryStorage();
      storage.setItem(SESSION_KEY, JSON.stringify({ version: 1, docs: [{ workflowId: 'wf1', name: 'a', version: '1', selection: null, view: null, design: 'junk' }], activeId: 'wf1', showDetails: false, dock: null }));
      const back = restoredState(readSession(storage));
      expect(back.docs[0]!.design.draft).toEqual(EMPTY_DRAFT);
    });

    it('writes no design field while there is no draft', () => {
      const state = reduce(INITIAL_STATE, { type: 'open', workflowId: 'wf1', name: 'a', version: '1' });
      expect(sessionOf(state, new Map(), null).docs[0]).not.toHaveProperty('design');
    });
  });
```
(Reuse the file's existing in-memory `Storage` helper; if it has none, add:
```ts
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k), clear: () => m.clear(), key: () => null, get length() { return m.size; } } as Storage;
}
```
and import `EMPTY_DRAFT`, `reduce`, `INITIAL_STATE`, `SESSION_KEY`.)

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/design/history.test.ts src/store src/app/session.test.ts`
Expected: FAIL: the modules and actions do not exist.

- [ ] **Step 3: Write `src/design/history.ts`**

```ts
import { EMPTY_DRAFT, type Draft } from './draft';

/** One document's design draft and its undo / redo stacks (spec §5.3). Not kept across a refresh. */
export interface DesignHistory {
  draft: Draft;
  past: Draft[];
  future: Draft[];
  /** The kind of the last step when it may merge with the next one of its kind (a run of nudges). */
  merge: string | null;
}

export const HISTORY_DEPTH = 100;

export const historyOf = (draft: Draft = EMPTY_DRAFT): DesignHistory => ({ draft, past: [], future: [], merge: null });

/** A finished gesture. `merge`: a step of the same kind straight after this one replaces it instead of stacking. */
export function commit(h: DesignHistory, draft: Draft, merge: string | null = null): DesignHistory {
  if (draft === h.draft) return h;
  if (merge !== null && merge === h.merge) return { ...h, draft, future: [] };
  return { draft, past: [...h.past, h.draft].slice(-HISTORY_DEPTH), future: [], merge };
}

export function undo(h: DesignHistory): DesignHistory {
  const previous = h.past[h.past.length - 1];
  if (previous === undefined) return h;
  return { draft: previous, past: h.past.slice(0, -1), future: [h.draft, ...h.future], merge: null };
}

export function redo(h: DesignHistory): DesignHistory {
  const [next, ...rest] = h.future;
  if (next === undefined) return h;
  return { draft: next, past: [...h.past, h.draft].slice(-HISTORY_DEPTH), future: rest, merge: null };
}

export const canUndo = (h: DesignHistory): boolean => h.past.length > 0;
export const canRedo = (h: DesignHistory): boolean => h.future.length > 0;
```

- [ ] **Step 4: Write `src/store/picks.ts`**

```ts
import { cacheNodeId, SPHERE_NODE_ID } from '../layout/nodeIds';
import type { Selection } from './selection';

/**
 * What is picked on a document's canvas (spec §3.2): blocks by React Flow node id, wires by wire id. The
 * Inspector's selection is separate: it is the one entity shown, and only one picked block has one.
 */
export type Pick = { kind: 'node'; id: string } | { kind: 'wire'; id: string };

export const pickKey = (p: Pick): string => `${p.kind}:${p.id}`;

export function picksOf(selection: Selection | null): Pick[] {
  if (selection === null) return [];
  switch (selection.kind) {
    case 'workflow': return [{ kind: 'node', id: SPHERE_NODE_ID }];
    case 'step': return [{ kind: 'node', id: selection.stepId }];
    case 'processor': return [{ kind: 'node', id: selection.stepId }];
    case 'cache': return [{ kind: 'node', id: cacheNodeId(selection.cacheId) }];
  }
}

export function togglePick(picks: readonly Pick[], pick: Pick): Pick[] {
  const key = pickKey(pick);
  return picks.some((p) => pickKey(p) === key) ? picks.filter((p) => pickKey(p) !== key) : [...picks, pick];
}

export const samePicks = (a: readonly Pick[], b: readonly Pick[]): boolean =>
  a.length === b.length && a.every((p, i) => pickKey(p) === pickKey(b[i]!));

export const nodePickIds = (picks: readonly Pick[]): string[] => picks.filter((p) => p.kind === 'node').map((p) => p.id);
export const wirePickIds = (picks: readonly Pick[]): string[] => picks.filter((p) => p.kind === 'wire').map((p) => p.id);
```

- [ ] **Step 5: Extend the store (`src/store/studioState.ts`)**

Imports:
```ts
import { isEmptyDraft, type Draft } from '../design/draft';
import { commit, historyOf, redo, undo, type DesignHistory } from '../design/history';
import { picksOf, samePicks, type Pick } from './picks';
```
`OpenDocument` gains:
```ts
  /** What is picked on the canvas (plan 4); the Inspector's `selection` is the one entity it shows. */
  picks: Pick[];
  /** The design draft and its history (plan 4). The draft is kept in the session; the history is not. */
  design: DesignHistory;
```
`StudioAction`: change `select` and add the new actions:
```ts
  /** `picks`: what the canvas picked with it; absent, the selection's own block (or nothing). */
  | { type: 'select'; workflowId: Id; selection: Selection | null; picks?: Pick[] }
  /** Picks only (a drag of a block that was not picked): the Inspector is untouched. */
  | { type: 'pick'; workflowId: Id; picks: Pick[] }
  /** A finished design gesture (spec §5.3); `merge` joins a run of the same kind into one step. */
  | { type: 'design'; workflowId: Id; draft: Draft; merge?: string; picks?: Pick[] }
  | { type: 'undo'; workflowId: Id }
  | { type: 'redo'; workflowId: Id }
  | { type: 'discardDesign'; workflowId: Id }
```
In `reduce`, the `open` case's new document gets `picks: [], design: historyOf()`. Replace the `select` case and add the new ones:
```ts
    case 'select':
      return update(state, action.workflowId, (d) => {
        const picks = action.picks ?? picksOf(action.selection);
        const same = selectionKey(d.selection) === selectionKey(action.selection);
        if (same && samePicks(d.picks, picks)) return d;
        return same ? { ...d, picks } : { ...d, selection: action.selection, picks, inspector: EMPTY_INSPECTOR };
      });
    case 'pick':
      return update(state, action.workflowId, (d) => (samePicks(d.picks, action.picks) ? d : { ...d, picks: action.picks }));
    case 'design':
      return update(state, action.workflowId, (d) => ({
        ...d, design: commit(d.design, action.draft, action.merge ?? null), picks: action.picks ?? d.picks,
      }));
    case 'undo':
      return update(state, action.workflowId, (d) => ({ ...d, design: undo(d.design) }));
    case 'redo':
      return update(state, action.workflowId, (d) => ({ ...d, design: redo(d.design) }));
    case 'discardDesign':
      return update(state, action.workflowId, (d) => ({ ...d, design: historyOf() }));
```
Add the export:
```ts
/** The document has a design draft (spec §5.4): its tab is marked and closing it asks. */
export const designDirty = (doc: OpenDocument): boolean => !isEmptyDraft(doc.design.draft);
```

- [ ] **Step 6: Keep the draft in the session (`src/app/session.ts`)**

Imports: `import { isEmptyDraft, parseDraft, type Draft } from '../design/draft';`, `import { historyOf } from '../design/history';`, `import { picksOf } from '../store/picks';`.
`SessionDoc` gains:
```ts
  /** The document's design draft (plan 4): absent when there is none. Optional, so the version stays 1. */
  design?: Draft;
```
In `readSession`, inside the per-document `docs.push({ … })` add:
```ts
      ...(designOf(d.design)),
```
and below the file's other helpers:
```ts
function designOf(value: unknown): { design?: Draft } {
  const draft = parseDraft(value);
  return draft !== null && !isEmptyDraft(draft) ? { design: draft } : {};
}
```
In `sessionOf`, inside the per-document object add:
```ts
      ...(isEmptyDraft(d.design.draft) ? {} : { design: d.design.draft }),
```
In `restoredState`, each document gains:
```ts
      picks: picksOf(d.selection),
      design: historyOf(d.design),
```

- [ ] **Step 7: Make every other `OpenDocument` literal complete**

Run: `npx tsc -b`
Expected: errors in test helpers that build `OpenDocument` objects by hand (for example `src/test/inspector.tsx`, `src/panels/panes.test.tsx`). Add `picks: [], design: historyOf()` to each. Then delete `tsconfig.tsbuildinfo` if `tsc -b` created it.

- [ ] **Step 8: Run the tests**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/WorkflowStudio/src
git commit -m "feat(studio): each document keeps picks and a design history; the session keeps its draft (plan 4)"
```

---

### Task 5: Design mode in the canvas: shown draft, cursors, picks and the rubber band

**Files:**
- Create: `src/design/designProps.ts`, `src/design/hit.ts`, `src/design/hit.test.ts`, `src/design/DesignOverlay.tsx`, `src/design/useRubberBand.ts`
- Modify: `src/canvas/WorkflowCanvas.tsx`, `src/canvas/selection.ts`, `src/canvas/selection.test.ts`, `src/canvas/edges/CableEdge.tsx`, `src/canvas/canvas.css`, `src/canvas/art.css`, `src/canvas/WorkflowCanvas.test.tsx`, `src/app/DocumentPanel.tsx`, `src/App.tsx`, `src/App.test.tsx`, `src/panels/Inspector.tsx`, `src/panels/panes.test.tsx`

**Interfaces:**
- Consumes: `applyDraft` (Task 3); `Pick`, `togglePick`, `nodePickIds`, `wirePickIds` (Task 4); store actions `select` with `picks`, `pick`, `design`.
- Produces: `DesignProps`; `FlowRect`, `rectOf`, `itemsInRect`, `blockAt`, `topLeftOf`, `nodeBox`; `withPicks`, `selectionOfNode`, `selectionForPicks`, `PICK_CLASS`; `WorkflowCanvas` props `design?: DesignProps` and `onSelect?: (selection, picks?) => void`; `DocumentPanel` `onSelect(selection, doc, picks?)`; `DesignOverlay` props (extended by Tasks 6-8).

- [ ] **Step 1: Write the failing hit tests**

`src/design/hit.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { graphDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { blockAt, itemsInRect, rectOf, topLeftOf } from './hit';

const two = () => loadedDocument(graphDto({ workflow: workflowDto({ entryStepIds: ['s1'] }), steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')] }));

describe('hit', () => {
  it('a rectangle picks only blocks and wires lying wholly inside it', async () => {
    const doc = await two();
    const s1 = doc.placement.steps.get('s1')!;
    expect(itemsInRect(doc, rectOf({ x: s1.x - 8, y: s1.y - 8 }, { x: s1.x + 232, y: s1.y + 168 }))).toEqual([{ kind: 'node', id: 's1' }]);
    const all = itemsInRect(doc, rectOf({ x: -1e4, y: -1e4 }, { x: 1e4, y: 1e4 }));
    expect(all).toEqual(expect.arrayContaining([{ kind: 'node', id: 'wf' }, { kind: 'node', id: 's2' }, { kind: 'wire', id: 's1->s2' }, { kind: 'wire', id: 'wf->s1' }]));
  });

  it('finds the step or the hub under a point, and a block corner by node id', async () => {
    const doc = await two();
    const s2 = doc.placement.steps.get('s2')!;
    expect(blockAt(doc, { x: s2.x + 10, y: s2.y + 10 })).toBe('s2');
    expect(blockAt(doc, { x: doc.placement.sphere.cx, y: doc.placement.sphere.cy })).toBe('wf');
    expect(blockAt(doc, { x: -500, y: -500 })).toBeNull();
    expect(topLeftOf(doc, 'wf')).toEqual({ x: doc.placement.sphere.cx - 96, y: doc.placement.sphere.cy - 96 });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/design/hit.test.ts`
Expected: FAIL, no `./hit`.

- [ ] **Step 3: Write `src/design/hit.ts`**

```ts
import type { StudioDocument } from '../app/document';
import { CACHE_H, CACHE_W, SPHERE_R, STEP_H, STEP_W, type Point } from '../layout/geometry';
import { CACHE_NODE_PREFIX, cacheNodeId, SPHERE_NODE_ID } from '../layout/nodeIds';
import type { Pick } from '../store/picks';

/** A rectangle in flow coordinates, x0 ≤ x1 and y0 ≤ y1. */
export interface FlowRect { x0: number; y0: number; x1: number; y1: number }

export const rectOf = (a: Point, b: Point): FlowRect => ({ x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) });

/** A block's box by React Flow node id, or null when the document has no such block. */
export function nodeBox(doc: StudioDocument, id: string): { x: number; y: number; w: number; h: number } | null {
  if (id === SPHERE_NODE_ID) {
    const { cx, cy } = doc.placement.sphere;
    return { x: cx - SPHERE_R, y: cy - SPHERE_R, w: 2 * SPHERE_R, h: 2 * SPHERE_R };
  }
  if (id.startsWith(CACHE_NODE_PREFIX)) {
    const p = doc.placement.caches.get(id.slice(CACHE_NODE_PREFIX.length));
    return p ? { x: p.x, y: p.y, w: CACHE_W, h: CACHE_H } : null;
  }
  const p = doc.placement.steps.get(id);
  return p ? { x: p.x, y: p.y, w: STEP_W, h: STEP_H } : null;
}

export function topLeftOf(doc: StudioDocument, id: string): Point {
  const b = nodeBox(doc, id);
  return b ? { x: b.x, y: b.y } : { x: 0, y: 0 };
}

const inside = (r: FlowRect, x: number, y: number) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;

/** Every block and wire lying wholly inside the rectangle (spec §3.2). */
export function itemsInRect(doc: StudioDocument, r: FlowRect): Pick[] {
  const ids = [SPHERE_NODE_ID, ...doc.placement.steps.keys(), ...[...doc.placement.caches.keys()].map(cacheNodeId)];
  const picks: Pick[] = [];
  for (const id of ids) {
    const b = nodeBox(doc, id);
    if (b && inside(r, b.x, b.y) && inside(r, b.x + b.w, b.y + b.h)) picks.push({ kind: 'node', id });
  }
  for (const w of doc.wires) if (w.points.every(([x, y]) => inside(r, x, y))) picks.push({ kind: 'wire', id: w.id });
  return picks;
}

/** The step or the hub under a point (a wire end may be dropped on them), or null. */
export function blockAt(doc: StudioDocument, p: Point): string | null {
  for (const [id, at] of doc.placement.steps) {
    if (p.x >= at.x && p.x <= at.x + STEP_W && p.y >= at.y && p.y <= at.y + STEP_H) return id;
  }
  const { cx, cy } = doc.placement.sphere;
  return Math.hypot(p.x - cx, p.y - cy) <= SPHERE_R ? SPHERE_NODE_ID : null;
}
```

- [ ] **Step 4: Run it**

Run: `npx vitest run src/design/hit.test.ts`
Expected: PASS.

- [ ] **Step 5: Write `src/design/designProps.ts`**

```ts
import type { Pick } from '../store/picks';
import type { Draft } from './draft';

/** What the canvas needs to design (plan 4). Without it the canvas stays read-only, as before. */
export interface DesignProps {
  draft: Draft;
  picks: readonly Pick[];
  /** Picks change with no Inspector question: a drag of a block that was not picked (spec §3.4). */
  onPick: (picks: Pick[]) => void;
  /** A finished gesture: one history step (spec §5.3). */
  onCommit: (draft: Draft, options?: { merge?: string; picks?: Pick[] }) => void;
  onUndo: () => void;
  onRedo: () => void;
}
```

- [ ] **Step 6: Picks on nodes and wires (`src/canvas/selection.ts`)**

Append:
```ts
import { CACHE_NODE_PREFIX } from '../layout/nodeIds';
import type { Pick } from '../store/picks';
import type { StudioEdge } from './toFlow';

/** Picked blocks (plan 4). Drawn like the selection, except on a step whose die is the selection. */
export const PICK_CLASS = 'studio-pick';

const withClass = (current: string | undefined, add: string) => (current ? `${current} ${add}` : add);

/** Design mode: every block can be dragged; picked blocks are marked and `selected` (React Flow drags them together); picked wires are marked and drawn on top. */
export function withPicks(nodes: StudioNode[], edges: StudioEdge[], picks: readonly Pick[]): { nodes: StudioNode[]; edges: StudioEdge[] } {
  const ids = new Set(picks.filter((p) => p.kind === 'node').map((p) => p.id));
  const wires = new Set(picks.filter((p) => p.kind === 'wire').map((p) => p.id));
  return {
    nodes: nodes.map((n) => ({ ...n, draggable: true, selected: ids.has(n.id), className: ids.has(n.id) ? withClass(n.className, PICK_CLASS) : n.className })) as StudioNode[],
    edges: edges.map((e) => (e.type === 'cable' && e.data
      ? { ...e, zIndex: wires.has(e.id) ? 1 : 0, data: { ...e.data, picked: wires.has(e.id) } }
      : e)) as StudioEdge[],
  };
}

/** The selection one picked block stands for. */
export function selectionOfNode(id: string, graph: Graph): Selection | null {
  if (id === SPHERE_NODE_ID) return { kind: 'workflow' };
  if (id.startsWith(CACHE_NODE_PREFIX)) return { kind: 'cache', cacheId: id.slice(CACHE_NODE_PREFIX.length) };
  return graph.steps.has(id) ? { kind: 'step', stepId: id } : null;
}

/**
 * The Inspector's selection for a set of picks (spec §3.3): one block is its entity (the clicked die
 * stays the processor); a wire, several items or none show no entity.
 */
export function selectionForPicks(picks: readonly Pick[], clicked: { id: string; selection: Selection | null } | null, graph: Graph): Selection | null {
  if (picks.length !== 1 || picks[0]!.kind !== 'node') return null;
  const id = picks[0]!.id;
  return clicked && clicked.id === id ? clicked.selection : selectionOfNode(id, graph);
}
```
Add a test to `src/canvas/selection.test.ts`:
```ts
  it('marks picked blocks and wires (plan 4)', () => {
    const nodes = [{ id: 's1', type: 'step', position: { x: 0, y: 0 }, data: {} }, { id: 's2', type: 'step', position: { x: 0, y: 0 }, data: {} }] as never;
    const edges = [{ id: 's1->s2', type: 'cable', source: 's1', target: 's2', data: { points: [], colour: '', broken: false, delay: 0 } }] as never;
    const out = withPicks(nodes, edges, [{ kind: 'node', id: 's2' }, { kind: 'wire', id: 's1->s2' }]);
    expect(out.nodes.map((n) => [n.selected, n.className])).toEqual([[false, undefined], [true, PICK_CLASS]]);
    expect(out.edges[0]!.data).toMatchObject({ picked: true });
  });
```

- [ ] **Step 7: The wire's pick mark and hit band (`src/canvas/edges/CableEdge.tsx`)**

`CableEdgeData` gains `picked?: boolean;`. In `CableEdgeView`, change the root `<g className=…>` to:
```tsx
    <g className={`${broken ? 'wire broken' : 'wire'}${picked ? ' picked' : ''}`} style={{ '--nc': colour } as CSSProperties}>
```
(destructure `picked` in the parameters). In `CableEdge`, return the view plus a hit band:
```tsx
export function CableEdge({ id, data }: EdgeProps<CableEdgeType>) {
  const { started } = useLiveArt();
  const gestures = useContext(DesignContext);
  if (!data) return null;
  return (
    <>
      <CableEdgeView {...data} flowing={started} />
      {/* an invisible band about 8 px wide, so the hand cursor and clicks need no pixel precision (spec §4.1) */}
      <path className="nx-hit" d={pathOf(data.points)} onPointerDown={gestures ? (e) => gestures.wirePointerDown(id, e) : undefined} />
    </>
  );
}
```
(import `useContext` from react and `DesignContext` from `'../../design/DesignContext'`; create that file now:)

`src/design/DesignContext.ts`:
```ts
import { createContext, type PointerEvent as ReactPointerEvent } from 'react';
import type { SourceId } from '../layout/ports';

/** Where wires and blocks hand a press to the designer's gestures (Tasks 7-8). Null: read-only canvas. */
export interface DesignGestures {
  /** A press on a wire's hit band; a picked wire's body drags its nearest run (spec §4.2). */
  wirePointerDown(wireId: string, e: ReactPointerEvent): void;
  /** A press on a block's connection point starts a new wire (spec §4.5). */
  portPointerDown(source: SourceId, e: ReactPointerEvent): void;
}

export const DesignContext = createContext<DesignGestures | null>(null);
```

- [ ] **Step 8: Cursors and marks (CSS)**

Append to `src/canvas/canvas.css`:
```css
/* plan 4 (spec §3.1): an arrow off the blocks and on the scroll bars, a hand on blocks and wires, a closed hand while dragging */
.studio-canvas .react-flow__pane, .studio-canvas .react-flow__pane.draggable, .studio-canvas .react-flow__pane.selection { cursor: default; }
.studio-canvas .react-flow__pane.dragging { cursor: grabbing; }
.studio-canvas .react-flow__node, .studio-canvas .react-flow__node.draggable { cursor: pointer; }
.studio-canvas .react-flow__node.draggable.dragging, .studio-canvas.gesture, .studio-canvas.gesture * { cursor: grabbing !important; }
.sb .th { cursor: default; }
.studio-canvas .nx-hit { fill: none; stroke: transparent; stroke-width: 8; pointer-events: stroke; cursor: pointer; }
.studio-canvas:focus { outline: none; }
.design-overlay { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
.design-band { fill: rgba(125, 211, 252, .08); stroke: var(--accent); stroke-width: 1; stroke-dasharray: 4 3; }
```
Append to `src/canvas/art.css` (picked blocks drawn like the selection; a picked wire gets a halo):
```css
.studio-pick:not(.studio-die-sel) .blk.nx .nx-frame { stroke: var(--accent); stroke-width: 2; }
.studio-pick .wf.nx .sphere { filter: url(#glow); }
.studio-pick .cachetag.nx .nx-brk { stroke: var(--accent); stroke-width: 1.8; }
.wire.picked .w { stroke-width: 2.6; filter: drop-shadow(0 0 3px var(--accent)); }
```

- [ ] **Step 9: Write `src/design/DesignOverlay.tsx` (the band only; Tasks 6-8 add to it)**

```tsx
import { ViewportPortal } from '@xyflow/react';
import type { FlowRect } from './hit';

export interface DesignOverlayProps {
  band: FlowRect | null;
}

/** Drawn above the blocks in flow coordinates: the rubber band (spec §3.2), and from later tasks the guides, the ghost wire and a picked wire's handles. */
export function DesignOverlay({ band }: DesignOverlayProps) {
  return (
    <ViewportPortal>
      <svg className="design-overlay" width={1} height={1}>
        {band && <rect className="design-band" x={band.x0} y={band.y0} width={band.x1 - band.x0} height={band.y1 - band.y0} />}
      </svg>
    </ViewportPortal>
  );
}
```

- [ ] **Step 10: Write `src/design/useRubberBand.ts`**

```ts
import { useEffect, useRef, useState, type MutableRefObject, type PointerEvent as ReactPointerEvent } from 'react';
import { useReactFlow } from '@xyflow/react';
import type { StudioDocument } from '../app/document';
import type { Selection } from '../store/selection';
import { pickKey, type Pick } from '../store/picks';
import { selectionForPicks } from '../canvas/selection';
import type { DesignProps } from './designProps';
import { itemsInRect, rectOf, type FlowRect } from './hit';

/** Below this many screen pixels a press on empty canvas is a click, not a rectangle. */
const BAND_START = 4;

/**
 * The rectangle on empty canvas (spec §3.2): a left-button drag that does not start on a block or a wire
 * picks what lies wholly inside; with Ctrl it adds. Space+drag stays React Flow's pan.
 */
export function useRubberBand(
  shown: MutableRefObject<StudioDocument>,
  design: DesignProps | undefined,
  onSelect: ((selection: Selection | null, picks?: Pick[]) => void) | undefined,
  suppressPaneClick: MutableRefObject<boolean>,
): { band: FlowRect | null; onPointerDownCapture: (e: ReactPointerEvent) => void } {
  const { screenToFlowPosition } = useReactFlow();
  const [band, setBand] = useState<FlowRect | null>(null);
  const space = useRef(false);
  const owner = useRef<Document | null>(null);

  useEffect(() => {
    const doc = owner.current ?? document;
    const down = (e: KeyboardEvent) => { if (e.key === ' ') space.current = true; };
    const up = (e: KeyboardEvent) => { if (e.key === ' ') space.current = false; };
    doc.addEventListener('keydown', down);
    doc.addEventListener('keyup', up);
    return () => { doc.removeEventListener('keydown', down); doc.removeEventListener('keyup', up); };
  }, []);

  const onPointerDownCapture = (e: ReactPointerEvent) => {
    const target = e.target as Element;
    owner.current = target.ownerDocument;
    if (!design || !onSelect || e.button !== 0 || space.current || !target.closest('.react-flow__pane')) return;
    const doc = target.ownerDocument;
    const start = { x: e.clientX, y: e.clientY };
    const a = screenToFlowPosition(start);
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < BAND_START) return;
      moved = true;
      setBand(rectOf(a, screenToFlowPosition({ x: ev.clientX, y: ev.clientY })));
    };
    const up = (ev: PointerEvent) => {
      doc.removeEventListener('pointermove', move);
      doc.removeEventListener('pointerup', up);
      setBand(null);
      if (!moved) return;
      suppressPaneClick.current = true; // the click that ends the drag must not clear what it picked
      const inside = itemsInRect(shown.current, rectOf(a, screenToFlowPosition({ x: ev.clientX, y: ev.clientY })));
      const picks = ev.ctrlKey ? [...design.picks, ...inside.filter((p) => !design.picks.some((q) => pickKey(q) === pickKey(p)))] : inside;
      onSelect(selectionForPicks(picks, null, shown.current.graph), picks);
    };
    doc.addEventListener('pointermove', move);
    doc.addEventListener('pointerup', up);
  };

  return { band, onPointerDownCapture };
}
```

- [ ] **Step 11: Restructure `WorkflowCanvas` for design mode (`src/canvas/WorkflowCanvas.tsx`)**

Split the component: `WorkflowCanvas` keeps the provider and context wrappers and renders an inner `CanvasBody` with all props (hooks that need React Flow must live under `ReactFlowProvider`). Props gain:
```ts
  /** Design mode (plan 4); omitted: read-only, as before. */
  design?: DesignProps;
```
and `onSelect` becomes `onSelect?: (selection: Selection | null, picks?: Pick[]) => void;`.

Inside `CanvasBody`:
```tsx
  const shownDoc = useMemo(() => (design ? applyDraft(doc, preview ?? design.draft) : doc), [doc, design?.draft, preview]);
  const shownRef = useRef(shownDoc);
  shownRef.current = shownDoc;
  const flow = useMemo(() => toFlow(shownDoc, fitter), [shownDoc, fitter]);
  const marked = useMemo(() => (design ? withPicks(flow.nodes, flow.edges, design.picks) : flow), [flow, design?.picks]);
  const shown = useMemo(() => withSelection(marked.nodes, selection), [marked.nodes, selection]);
  const suppressPaneClick = useRef(false);
  const suppressNodeClick = useRef(false);
  const { band, onPointerDownCapture } = useRubberBand(shownRef, design, onSelect, suppressPaneClick);
```
with `const [preview, setPreview] = useState<Draft | null>(null);` (Tasks 6-8 set it). Click handlers in design mode:
```tsx
  const onNodeClick: NodeMouseHandler = (event, node) => {
    if (!onSelect) return;
    if (suppressNodeClick.current) { suppressNodeClick.current = false; return; }
    const clicked = selectionFromClick(node, event.target as Element, shownDoc.graph);
    if (!design) { onSelect(clicked); return; }
    const pick: Pick = { kind: 'node', id: node.id };
    const picks = event.ctrlKey ? togglePick(design.picks, pick) : [pick];
    onSelect(selectionForPicks(picks, { id: node.id, selection: clicked }, shownDoc.graph), picks);
  };
  const onEdgeClick: EdgeMouseHandler = (event, edge) => {
    if (!design || !onSelect || edge.type !== 'cable') return;
    const pick: Pick = { kind: 'wire', id: edge.id };
    const picks = event.ctrlKey ? togglePick(design.picks, pick) : [pick];
    onSelect(selectionForPicks(picks, null, shownDoc.graph), picks);
  };
  const onPaneClick = () => {
    if (suppressPaneClick.current) { suppressPaneClick.current = false; return; }
    onSelect?.(null, design ? [] : undefined);
  };
```
`ReactFlow` props: pass `edges={marked.edges}`, `nodes={shown}`, `onNodeClick={onSelect ? onNodeClick : undefined}`, `onEdgeClick={design ? onEdgeClick : undefined}`, `onPaneClick={onSelect ? onPaneClick : undefined}`, and in design mode also `multiSelectionKeyCode={null}`, `selectionKeyCode={null}`, `disableKeyboardA11y`. Wrap the canvas div's children so the overlay sits inside `<ReactFlow>`: add `{design && <DesignOverlay band={band} />}` next to `<GridBackground />`. On the `.studio-canvas` div add `tabIndex={design ? 0 : undefined}` and `onPointerDownCapture={design ? (e) => { (e.currentTarget as HTMLElement).focus({ preventScroll: true }); onPointerDownCapture(e); } : undefined}`. Wrap the `<ReactFlow>` in `<DesignContext.Provider value={null}>` for now (Task 7 provides the gestures).

Imports to add: `useState`, `type EdgeMouseHandler`, `type NodeMouseHandler` from `@xyflow/react`; `applyDraft`, `Draft`, `DesignProps`, `DesignOverlay`, `useRubberBand`, `DesignContext`; `togglePick`, `Pick`; `withPicks`, `selectionForPicks`.

- [ ] **Step 12: Wire the panel and the page**

`src/app/DocumentPanel.tsx`: `onSelect` becomes `(selection: Selection | null, doc: Document, picks?: Pick[]) => void`. Pass the design props and the picks:
```tsx
        design={{
          draft: open.design.draft,
          picks: open.picks,
          onPick: (picks) => store.dispatch({ type: 'pick', workflowId, picks }),
          onCommit: (draft, o) => store.dispatch({ type: 'design', workflowId, draft, merge: o?.merge, picks: o?.picks }),
          onUndo: () => store.dispatch({ type: 'undo', workflowId }),
          onRedo: () => store.dispatch({ type: 'redo', workflowId }),
        }}
        onSelect={onSelect ? (selection, picks) => onSelect(selection, ownerDocument, picks) : (selection, picks) => {
          store.dispatch({ type: 'activate', workflowId });
          store.dispatch({ type: 'select', workflowId, selection, picks });
        }}
```
`src/App.tsx`, the `renderDocument` `onSelect`:
```tsx
            onSelect={(selection: Selection | null, doc: Document, picks?: Pick[]) => {
              store.dispatch({ type: 'activate', workflowId: id });
              const open = store.getState().docs.find((d) => d.workflowId === id);
              // the same entity: only the picks change, and the Inspector has nothing to ask
              if (open && selectionKey(open.selection) === selectionKey(selection)) {
                if (picks) store.dispatch({ type: 'pick', workflowId: id, picks });
                return;
              }
              actions.guard(id, () => store.dispatch({ type: 'select', workflowId: id, selection, picks }), doc);
            }}
```

- [ ] **Step 13: The Inspector's notes (`src/panels/Inspector.tsx`)**

Before `if (target === null) …` add:
```tsx
  if (active.picks.length > 1) return <PaneNote pane="inspector">{`${active.picks.length} items selected`}</PaneNote>;
  const onlyWire = active.picks.length === 1 && active.picks[0]!.kind === 'wire' ? active.picks[0]!.id : null;
  if (onlyWire !== null) return <PaneNote pane="inspector">{wireNote(active.status.doc.graph, onlyWire)}</PaneNote>;
```
and below the component:
```tsx
/** "Wire: {source} → {target}" by unique names (spec §3.3): a wire has no entity of its own to edit. */
function wireNote(graph: Graph, id: string): string {
  const { source, target } = wireEnds(id);
  const name = (stepId: string) => {
    if (stepId === WORKFLOW_SOURCE) return entityName(graph.workflow.name, graph.workflow.version, graph.workflow.id);
    const s = graph.steps.get(stepId);
    return s ? entityName(s.name, s.version, s.id) : stepId;
  };
  return `Wire: ${name(source)} → ${name(target)}`;
}
```
(imports: `wireEnds` from `'../design/draft'`, `WORKFLOW_SOURCE` from `'../layout/ports'`, `Graph` type.)

- [ ] **Step 14: Write the canvas, Inspector and page tests**

Append to `src/canvas/WorkflowCanvas.test.tsx`:
```tsx
  describe('design mode (plan 4)', () => {
    const designOf = (over: Partial<DesignProps> = {}): DesignProps => ({ draft: EMPTY_DRAFT, picks: [], onPick: vi.fn(), onCommit: vi.fn(), onUndo: vi.fn(), onRedo: vi.fn(), ...over });
    const two = () => loadedDocument(graphDto({ steps: [stepDto('s1', { name: 'fetch', nextStepIds: ['s2'] }), stepDto('s2', { name: 'store' })] }));

    it('draws the draft over the saved document', async () => {
      const doc = await two();
      const s2 = doc.placement.steps.get('s2')!;
      const draft = { ...EMPTY_DRAFT, steps: { s2: { x: s2.x, y: s2.y + 320 } } };
      const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} design={designOf({ draft })} />);
      const node = container.querySelector('.react-flow__node[data-id="s2"]') as HTMLElement;
      expect(node.style.transform).toContain(`${s2.y + 320}px`);
    });

    it('a click picks one block, Ctrl+click adds, a wire click picks the wire, the pane clears', async () => {
      const doc = await two();
      const onSelect = vi.fn();
      const { container, rerender } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} design={designOf()} onSelect={onSelect} />);
      fireEvent.click(screen.getByText('fetch'));
      expect(onSelect).toHaveBeenLastCalledWith({ kind: 'step', stepId: 's1' }, [{ kind: 'node', id: 's1' }]);
      rerender(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} design={designOf({ picks: [{ kind: 'node', id: 's1' }] })} onSelect={onSelect} />);
      fireEvent.click(screen.getByText('store'), { ctrlKey: true });
      expect(onSelect).toHaveBeenLastCalledWith(null, [{ kind: 'node', id: 's1' }, { kind: 'node', id: 's2' }]);
      fireEvent.click(container.querySelector('.react-flow__edge[data-id="s1->s2"] .nx-hit')!);
      expect(onSelect).toHaveBeenLastCalledWith(null, [{ kind: 'wire', id: 's1->s2' }]);
      fireEvent.click(container.querySelector('.react-flow__pane')!);
      expect(onSelect).toHaveBeenLastCalledWith(null, []);
    });

    it('marks picked blocks and wires', async () => {
      const doc = await two();
      const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} design={designOf({ picks: [{ kind: 'node', id: 's2' }, { kind: 'wire', id: 's1->s2' }] })} />);
      expect(container.querySelector('.react-flow__node[data-id="s2"]')!.className).toContain('studio-pick');
      expect(container.querySelector('.react-flow__edge[data-id="s1->s2"] .wire')!.getAttribute('class')).toContain('picked');
    });
  });
```
(imports: `EMPTY_DRAFT`, `DesignProps`, `loadedDocument` from `'../app/fixtures'`, `screen`, `vi`.)

Append to `src/panels/panes.test.tsx` (inside the Inspector `describe`; `renderInspector` takes the open document's fields):
```tsx
  it('says how many items are picked, and names a picked wire (plan 4)', async () => {
    await renderInspector({ getEntity: vi.fn() }, { selection: null, picks: [{ kind: 'node', id: 's1' }, { kind: 'wire', id: 's1->s2' }] } as never);
    expect(await screen.findByText('2 items selected')).toBeInTheDocument();
  });
```
If `renderInspector` does not accept `picks`, extend `src/test/inspector.tsx` so the open document takes them from its options.

Append to `src/App.test.tsx` (inside the unsaved-edits `describe`, using its helpers for a document with Inspector edits):
```tsx
    it('a click with unsaved Inspector edits asks before the picks move (review focus 5)', async () => {
      render(<App api={withEntities({ getEntity: vi.fn().mockResolvedValue({ ok: true, value: stepDto('s1') }) })} storage={memoryStorage()} tabStorage={draftSession({ description: 'typed' })} />);
      expect(await screen.findByText('● unsaved changes')).toBeInTheDocument();
      fireEvent.click(await screen.findByText('WORKFLOW'));
      expect(await dialog()).toBeInTheDocument();
      expect(document.querySelector('.react-flow__node[data-id="wf"]')!.className).not.toContain('studio-pick');
    });
```

- [ ] **Step 15: Run the tests**

Run: `npx vitest run`
Expected: PASS. Fix any older canvas test that called `onSelect` with exactly one argument (`toHaveBeenCalledWith(sel)` now receives `(sel, undefined)` only in read-only mode, which is unchanged).

- [ ] **Step 16: Commit**

```bash
git add src/WorkflowStudio/src
git commit -m "feat(studio): design mode draws the draft; click, Ctrl+click and a rectangle pick blocks and wires; cursors (plan 4)"
```

---

### Task 6: Dragging blocks, alignment guides and nudges

**Files:**
- Create: `src/design/guides.ts`, `src/design/guides.test.ts`, `src/design/useBlockDrag.ts`, `src/design/useDesignKeys.ts`, `src/design/useDesignKeys.test.tsx`
- Modify: `src/design/DesignOverlay.tsx`, `src/canvas/WorkflowCanvas.tsx`, `src/canvas/canvas.css`

**Interfaces:**
- Consumes: `moveBlocks` (Task 1), `nodeBox`, `topLeftOf` (Task 5), `DesignProps`.
- Produces: `GuideBox`, `GuideLine`, `guideBoxes(doc)`, `snapToGuides(moving, others)`; `useBlockDrag(...)` returning React Flow handlers; `useDesignKeys(...)` returning `onKeyDown`; `DesignOverlayProps.guides: GuideLine[]`.

- [ ] **Step 1: Write the failing guide tests**

`src/design/guides.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { snapToGuides } from './guides';

const step = (id: string, x: number, y: number) => ({ id, x, y, w: 224, h: 160, mid: y + 96 });

describe('alignment guides', () => {
  it('snaps an edge lined up within one grid step, and draws the line', () => {
    const g = snapToGuides(step('a', 8, 400), [step('b', 0, 0)]);
    expect([g.dx, g.dy]).toEqual([-8, 0]);
    expect(g.lines).toContainEqual({ x1: 0, y1: 0, x2: 0, y2: 560 });
  });

  it('lines up processor middles, so a wire between them runs straight', () => {
    const g = snapToGuides(step('a', 400, 8), [step('b', 0, 0)]);
    expect(g.dy).toBe(-8);
    expect(g.lines).toContainEqual({ x1: 0, y1: 96, x2: 624, y2: 96 });
  });

  it('does nothing two grid steps away', () => {
    expect(snapToGuides(step('a', 16, 400), [step('b', 0, 0)])).toEqual({ dx: 0, dy: 0, lines: [] });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/design/guides.test.ts`
Expected: FAIL, no `./guides`.

- [ ] **Step 3: Write `src/design/guides.ts`**

```ts
import type { StudioDocument } from '../app/document';
import { GRID, PMID } from '../layout/geometry';
import { cacheNodeId, SPHERE_NODE_ID } from '../layout/nodeIds';
import { nodeBox } from './hit';

/** A block for the guides, by React Flow node id; `mid` is a step's processor middle (absolute). */
export interface GuideBox { id: string; x: number; y: number; w: number; h: number; mid?: number }
export interface GuideLine { x1: number; y1: number; x2: number; y2: number }

export function guideBoxes(doc: StudioDocument): GuideBox[] {
  const ids = [SPHERE_NODE_ID, ...doc.placement.steps.keys(), ...[...doc.placement.caches.keys()].map(cacheNodeId)];
  const out: GuideBox[] = [];
  for (const id of ids) {
    const b = nodeBox(doc, id);
    if (b) out.push({ id, ...b, ...(doc.placement.steps.has(id) ? { mid: b.y + PMID } : {}) });
  }
  return out;
}

const xsOf = (b: GuideBox) => [b.x, b.x + b.w / 2, b.x + b.w];
const ysOf = (b: GuideBox) => [b.y, b.y + b.h / 2, b.y + b.h, ...(b.mid !== undefined ? [b.mid] : [])];

/** The smallest offset (at most one grid step) that lines one of `mine` up with one of `theirs`. */
function best(mine: number[], theirs: number[]): number {
  let found: number | null = null;
  for (const m of mine) for (const t of theirs) {
    const d = t - m;
    if (Math.abs(d) <= GRID && (found === null || Math.abs(d) < Math.abs(found))) found = d;
  }
  return found ?? 0;
}

/**
 * Spec §3.4 (Visio's dynamic grid): the dragged block snaps when an edge, its centre or its processor
 * middle is within one grid step of another block's, and a line is drawn for every exact match. Every
 * line is a multiple of 8 on blocks that are, so a guide never takes a block off the grid.
 */
export function snapToGuides(moving: GuideBox, others: readonly GuideBox[]): { dx: number; dy: number; lines: GuideLine[] } {
  const dx = best(xsOf(moving), others.flatMap(xsOf));
  const dy = best(ysOf(moving), others.flatMap(ysOf));
  const m: GuideBox = { ...moving, x: moving.x + dx, y: moving.y + dy, ...(moving.mid !== undefined ? { mid: moving.mid + dy } : {}) };
  const lines: GuideLine[] = [];
  const seen = new Set<string>();
  const add = (l: GuideLine) => { const k = `${l.x1},${l.y1},${l.x2},${l.y2}`; if (!seen.has(k)) { seen.add(k); lines.push(l); } };
  for (const o of others) {
    const top = Math.min(m.y, o.y), bottom = Math.max(m.y + m.h, o.y + o.h);
    const left = Math.min(m.x, o.x), right = Math.max(m.x + m.w, o.x + o.w);
    for (const x of xsOf(m)) if (xsOf(o).includes(x)) add({ x1: x, y1: top, x2: x, y2: bottom });
    for (const y of ysOf(m)) if (ysOf(o).includes(y)) add({ x1: left, y1: y, x2: right, y2: y });
  }
  return { dx, dy, lines };
}
```

- [ ] **Step 4: Run them**

Run: `npx vitest run src/design/guides.test.ts`
Expected: PASS.

- [ ] **Step 5: Write `src/design/useBlockDrag.ts`**

```ts
import { useRef, type MutableRefObject } from 'react';
import type { NodeChange, OnNodeDrag, OnNodesChange } from '@xyflow/react';
import type { StudioDocument } from '../app/document';
import { snap, type Point } from '../layout/geometry';
import type { Selection } from '../store/selection';
import type { Pick } from '../store/picks';
import { selectionFromClick } from '../canvas/selection';
import type { DesignProps } from './designProps';
import { moveBlocks, type Draft } from './draft';
import { guideBoxes, snapToGuides, type GuideLine } from './guides';
import { nodeBox, topLeftOf } from './hit';

interface Drag {
  primary: string;
  ids: string[];
  start: Map<string, Point>;
  base: Draft;
  preview: Draft | null;
  cancelled: boolean;
  /** Set when the drag picked a block that was not picked: the Inspector follows after the drop. */
  selectAfter: Selection | null | undefined;
  stopEscape: () => void;
}

/**
 * Block dragging through React Flow (spec §3.4). The picked blocks move together, snapped to 8 px and
 * onto alignment guides; wires re-route live from the preview draft. A block that was not picked moves
 * alone. Escape cancels; the drop is one history step.
 */
export function useBlockDrag(
  saved: StudioDocument,
  shown: MutableRefObject<StudioDocument>,
  design: DesignProps | undefined,
  setPreview: (d: Draft | null) => void,
  setGuides: (lines: GuideLine[]) => void,
  onSelect: ((selection: Selection | null, picks?: Pick[]) => void) | undefined,
  suppressNodeClick: MutableRefObject<boolean>,
): { onNodeDragStart?: OnNodeDrag; onNodesChange?: OnNodesChange; onNodeDragStop?: OnNodeDrag } {
  const drag = useRef<Drag | null>(null);
  if (!design) return {};

  const end = () => {
    const d = drag.current;
    drag.current = null;
    d?.stopEscape();
    setGuides([]);
    setPreview(null);
    return d;
  };

  const onNodeDragStart: OnNodeDrag = (event, node) => {
    const picked = design.picks.some((p) => p.kind === 'node' && p.id === node.id);
    const ids = picked ? design.picks.filter((p) => p.kind === 'node').map((p) => p.id) : [node.id];
    if (!picked) design.onPick([{ kind: 'node', id: node.id }]);
    const doc = (event.target as Element | null)?.ownerDocument ?? document;
    const escape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !drag.current) return;
      e.preventDefault();
      e.stopPropagation(); // the dock's Escape must not also run
      drag.current.cancelled = true;
      setGuides([]);
      setPreview(null);
    };
    doc.addEventListener('keydown', escape, true);
    drag.current = {
      primary: node.id, ids,
      start: new Map(ids.map((id) => [id, topLeftOf(shown.current, id)])),
      base: design.draft, preview: null, cancelled: false,
      selectAfter: picked ? undefined : selectionFromClick(node, event.target as Element, shown.current.graph),
      stopEscape: () => doc.removeEventListener('keydown', escape, true),
    };
  };

  const onNodesChange: OnNodesChange = (changes: NodeChange[]) => {
    const d = drag.current;
    if (!d || d.cancelled) return;
    const change = changes.find((c) => c.type === 'position' && c.id === d.primary && c.position);
    if (!change || change.type !== 'position' || !change.position) return;
    const start = d.start.get(d.primary)!;
    let dx = snap(change.position.x) - start.x, dy = snap(change.position.y) - start.y;
    const box = nodeBox(shown.current, d.primary);
    if (box) {
      const others = guideBoxes(shown.current).filter((b) => !d.ids.includes(b.id));
      const moving = { id: d.primary, x: start.x + dx, y: start.y + dy, w: box.w, h: box.h, ...(saved.placement.steps.has(d.primary) ? { mid: start.y + dy + PMID } : {}) };
      const g = snapToGuides(moving, others);
      dx += g.dx; dy += g.dy;
      setGuides(g.lines);
    }
    const moved = new Map(d.ids.map((id) => { const s = d.start.get(id)!; return [id, { x: s.x + dx, y: s.y + dy }] as const; }));
    d.preview = moveBlocks(d.base, saved, moved);
    setPreview(d.preview);
  };

  const onNodeDragStop: OnNodeDrag = () => {
    const d = end();
    if (!d) return;
    suppressNodeClick.current = true; // the click that ends a drag must not re-pick
    setTimeout(() => { suppressNodeClick.current = false; }, 0);
    if (d.cancelled) return;
    if (d.preview) design.onCommit(d.preview);
    if (d.selectAfter !== undefined) onSelect?.(d.selectAfter, [{ kind: 'node', id: d.primary }]);
  };

  return { onNodeDragStart, onNodesChange, onNodeDragStop };
}
```
(`PMID` comes from `'../layout/geometry'`, next to `snap`.)

- [ ] **Step 6: Write the failing key test**

`src/design/useDesignKeys.test.tsx`:
```tsx
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { graphDto, stepDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { EMPTY_DRAFT } from './draft';
import type { DesignProps } from './designProps';
import { useDesignKeys } from './useDesignKeys';

function Probe({ design, saved }: { design: DesignProps; saved: Awaited<ReturnType<typeof loadedDocument>> }) {
  const onKeyDown = useDesignKeys(saved, { current: saved }, design);
  return <div data-testid="c" tabIndex={0} onKeyDown={onKeyDown} />;
}

const designOf = (over: Partial<DesignProps> = {}): DesignProps => ({ draft: EMPTY_DRAFT, picks: [], onPick: vi.fn(), onCommit: vi.fn(), onUndo: vi.fn(), onRedo: vi.fn(), ...over });

describe('design keys', () => {
  it('nudges picked blocks 8 px as one merged step', async () => {
    const saved = await loadedDocument(graphDto({ steps: [stepDto('s1')] }));
    const design = designOf({ picks: [{ kind: 'node', id: 's1' }] });
    const { getByTestId } = render(<Probe design={design} saved={saved} />);
    fireEvent.keyDown(getByTestId('c'), { key: 'ArrowRight' });
    const s1 = saved.placement.steps.get('s1')!;
    expect(design.onCommit).toHaveBeenCalledWith(expect.objectContaining({ steps: { s1: { x: s1.x + 8, y: s1.y } } }), { merge: 'nudge' });
  });

  it('Ctrl+Z undoes, Ctrl+Y and Ctrl+Shift+Z redo', async () => {
    const saved = await loadedDocument();
    const design = designOf();
    const { getByTestId } = render(<Probe design={design} saved={saved} />);
    fireEvent.keyDown(getByTestId('c'), { key: 'z', ctrlKey: true });
    fireEvent.keyDown(getByTestId('c'), { key: 'y', ctrlKey: true });
    fireEvent.keyDown(getByTestId('c'), { key: 'Z', ctrlKey: true, shiftKey: true });
    expect(design.onUndo).toHaveBeenCalledTimes(1);
    expect(design.onRedo).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 7: Write `src/design/useDesignKeys.ts`**

```ts
import type { KeyboardEvent as ReactKeyboardEvent, MutableRefObject } from 'react';
import type { StudioDocument } from '../app/document';
import { GRID } from '../layout/geometry';
import { nodePickIds, wirePickIds } from '../store/picks';
import type { DesignProps } from './designProps';
import { moveBlocks, removeWires } from './draft';
import { topLeftOf } from './hit';

const ARROWS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

/**
 * The canvas's own keys while it has focus (spec §3.4, §4.5, §5.3): arrows nudge the picked blocks 8 px
 * (a run of nudges is one step), Delete removes the picked wires, Ctrl+Z undoes, Ctrl+Y and Ctrl+Shift+Z
 * redo. Keys typed in an Inspector field never reach here: the Inspector is outside the canvas.
 */
export function useDesignKeys(saved: StudioDocument, shown: MutableRefObject<StudioDocument>, design: DesignProps | undefined) {
  return (e: ReactKeyboardEvent) => {
    if (!design) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && !e.altKey && key === 'z') { e.preventDefault(); if (e.shiftKey) design.onRedo(); else design.onUndo(); return; }
    if (mod && !e.altKey && key === 'y') { e.preventDefault(); design.onRedo(); return; }
    if (mod || e.altKey) return;
    const arrow = ARROWS[e.key];
    const nodes = nodePickIds(design.picks);
    if (arrow && nodes.length > 0) {
      e.preventDefault();
      const moved = new Map(nodes.map((id) => { const p = topLeftOf(shown.current, id); return [id, { x: p.x + arrow[0] * GRID, y: p.y + arrow[1] * GRID }] as const; }));
      design.onCommit(moveBlocks(design.draft, saved, moved), { merge: 'nudge' });
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      const wires = wirePickIds(design.picks);
      if (wires.length === 0) return; // blocks are never removed in the trial (spec §2)
      e.preventDefault();
      design.onCommit(removeWires(design.draft, saved, wires), { picks: design.picks.filter((p) => p.kind !== 'wire') });
    }
  };
}
```

- [ ] **Step 8: Draw the guides and hook up dragging**

`DesignOverlayProps` gains `guides: GuideLine[]`; inside the svg add:
```tsx
        {guides.map((l, i) => <line key={i} className="design-guide" x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} />)}
```
Append to `src/canvas/canvas.css`:
```css
.design-guide { stroke: #fff; stroke-width: 1; filter: drop-shadow(0 0 2px rgba(125, 211, 252, .9)); }
```
In `CanvasBody` (`WorkflowCanvas.tsx`): `const [guides, setGuides] = useState<GuideLine[]>([]);`, `const drag = useBlockDrag(doc, shownRef, design, setPreview, setGuides, onSelect, suppressNodeClick);`, `const onKeyDown = useDesignKeys(doc, shownRef, design);`. Pass to `ReactFlow` in design mode: `nodesDraggable`, `snapToGrid`, `snapGrid={[8, 8]}`, `nodeDragThreshold={2}`, `onNodeDragStart={drag.onNodeDragStart}`, `onNodesChange={drag.onNodesChange}`, `onNodeDragStop={drag.onNodeDragStop}` (read-only mode keeps `nodesDraggable={false}`). Put `onKeyDown={design ? onKeyDown : undefined}` on the `.studio-canvas` div and pass `guides={guides}` to `DesignOverlay`.

- [ ] **Step 9: Run the tests**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 10: Check dragging in a browser**

Start the dev server from PowerShell (`npx vite --port 5174`), open a workflow, drag a step: it moves on the 8 px grid, its wires follow, a white guide shows when edges or processor middles line up, Escape mid-drag puts it back, Ctrl+Z undoes a drop. Stop the server.

- [ ] **Step 11: Commit**

```bash
git add src/WorkflowStudio/src
git commit -m "feat(studio): blocks drag together on the grid with alignment guides; arrows nudge; undo keys (plan 4)"
```

---

### Task 7: Editing a wire: handles, segment drags, landing slides, Reset route and Delete

**Files:**
- Create: `src/design/useWireGestures.ts`, `src/design/useWireGestures.test.tsx`
- Modify: `src/design/DesignOverlay.tsx`, `src/canvas/WorkflowCanvas.tsx`, `src/canvas/canvas.css`, `src/design/useDesignKeys.test.tsx`

**Interfaces:**
- Consumes: `shapeFromPoints`, `dragSegment`, `normalize`, `segmentHandles`, `nearestSegment`, `endsOf` (Task 2); `setShape`, `resetRoute` (Task 1); `DesignContext` (Task 5); `Menu`, `anchorAt` (`src/dock/Menu.tsx`).
- Produces: `useWireGestures(...)` returning `{ gestures: DesignGestures; startSegment; startEnd; ghost; hint }` (Task 8 adds `startEnd`, `ghost`, `hint`); `DesignOverlayProps.wires: WireRoute[]` (picked wires), `onSegment(wire, k, e)`, `onEnd(wire, end, e)`.

- [ ] **Step 1: Write the failing tests**

`src/design/useWireGestures.test.tsx` drives a picked wire's segment handle in a real canvas:
```tsx
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { graphDto, stepDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { createTextFitter } from '../canvas/fitText';
import { WorkflowCanvas } from '../canvas/WorkflowCanvas';
import { EMPTY_DRAFT } from './draft';
import type { DesignProps } from './designProps';

const fitter = createTextFitter((t) => t.length * 7);
const designOf = (over: Partial<DesignProps> = {}): DesignProps => ({ draft: EMPTY_DRAFT, picks: [], onPick: vi.fn(), onCommit: vi.fn(), onUndo: vi.fn(), onRedo: vi.fn(), ...over });

describe('wire gestures', () => {
  it('a picked wire shows its end dots and run handles', async () => {
    const doc = await loadedDocument(graphDto({ steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')] }));
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} design={designOf({ picks: [{ kind: 'wire', id: 's1->s2' }] })} onSelect={vi.fn()} />);
    expect(container.querySelectorAll('.design-handle.end')).toHaveLength(2);
    expect(container.querySelectorAll('.design-handle.seg').length).toBeGreaterThan(0);
  });

  it('dragging a run makes the wire manual: one step, with its bends', async () => {
    const doc = await loadedDocument(graphDto({ steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')] }));
    const design = designOf({ picks: [{ kind: 'wire', id: 's1->s2' }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} design={design} onSelect={vi.fn()} />);
    const handle = container.querySelector('.design-handle.seg[data-k="0"]')!;
    fireEvent.pointerDown(handle, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(handle.ownerDocument, { clientX: 100, clientY: 164, pointerId: 1 });
    fireEvent.pointerUp(handle.ownerDocument, { clientX: 100, clientY: 164, pointerId: 1 });
    expect(design.onCommit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(design.onCommit).mock.calls[0]![0].routes['s1->s2']!.bends).not.toBeNull();
  });
});
```
Append to `src/design/useDesignKeys.test.tsx`:
```tsx
  it('Delete removes the picked wires and keeps the picked blocks', async () => {
    const saved = await loadedDocument(graphDto({ steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')] }));
    const design = designOf({ picks: [{ kind: 'wire', id: 's1->s2' }, { kind: 'node', id: 's2' }] });
    const { getByTestId } = render(<Probe design={design} saved={saved} />);
    fireEvent.keyDown(getByTestId('c'), { key: 'Delete' });
    expect(design.onCommit).toHaveBeenCalledWith(expect.objectContaining({ next: { s1: [] } }), { picks: [{ kind: 'node', id: 's2' }] });
  });

  it('Delete with no wire picked changes nothing (review focus 4)', async () => {
    const saved = await loadedDocument(graphDto({ steps: [stepDto('s1')] }));
    const design = designOf({ picks: [{ kind: 'node', id: 's1' }] });
    const { getByTestId } = render(<Probe design={design} saved={saved} />);
    fireEvent.keyDown(getByTestId('c'), { key: 'Delete' });
    expect(design.onCommit).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/design`
Expected: FAIL: no handles are drawn and `./useWireGestures` does not exist (the Delete tests already pass from Task 6: keep them as the guard).

- [ ] **Step 3: Write `src/design/useWireGestures.ts` (segment drags; Task 8 adds ends)**

```ts
import { useRef, useState, type MutableRefObject, type PointerEvent as ReactPointerEvent } from 'react';
import { useReactFlow } from '@xyflow/react';
import type { StudioDocument } from '../app/document';
import { clampLanding, type Point } from '../layout/geometry';
import { dragSegment, endsOf, nearestSegment, normalize, shapeFromPoints, type Bends } from '../layout/shape';
import type { WireRoute } from '../layout/wires';
import type { DesignGestures } from './DesignContext';
import type { DesignProps } from './designProps';
import { setShape, type Draft } from './draft';

/** Below this many screen pixels a press is a click, not a drag. */
const MOVE_START = 3;

/**
 * Runs one pointer gesture on the press's own document (a pop-out's included, spec §6.3): moves until
 * the button is released, Escape cancels. `onMove` gets flow coordinates; `onEnd(cancelled)` always runs.
 */
export function useGesture(setActive: (on: boolean) => void) {
  const { screenToFlowPosition } = useReactFlow();
  return (e: ReactPointerEvent, onMove: (p: Point) => void, onEnd: (cancelled: boolean, moved: boolean) => void) => {
    e.preventDefault();
    e.stopPropagation();
    const doc = (e.currentTarget as Element).ownerDocument;
    const start = { x: e.clientX, y: e.clientY };
    let moved = false;
    setActive(true);
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < MOVE_START) return;
      moved = true;
      onMove(screenToFlowPosition({ x: ev.clientX, y: ev.clientY }));
    };
    const finish = (cancelled: boolean) => {
      doc.removeEventListener('pointermove', move);
      doc.removeEventListener('pointerup', up);
      doc.removeEventListener('keydown', key, true);
      setActive(false);
      onEnd(cancelled, moved);
    };
    const up = () => finish(false);
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation(); // the dock's Escape must not also run
      finish(true);
    };
    doc.addEventListener('pointermove', move);
    doc.addEventListener('pointerup', up);
    doc.addEventListener('keydown', key, true);
  };
}

export function useWireGestures(
  shown: MutableRefObject<StudioDocument>,
  design: DesignProps | undefined,
  setPreview: (d: Draft | null) => void,
) {
  const [active, setActive] = useState(false);
  const run = useGesture(setActive);
  const designRef = useRef(design);
  designRef.current = design;

  /** Drags run k of a wire (spec §4.2): the first drag makes the wire manual; the last run slides the landing. */
  const startSegment = (wire: WireRoute, k: number, e: ReactPointerEvent) => {
    const d = designRef.current;
    if (!d || e.button !== 0) return;
    const base = d.draft;
    const existing = base.routes[wire.id];
    const ends = endsOf(wire.points);
    const bends: Bends = existing?.bends ?? shapeFromPoints(wire.points);
    const targetY = shown.current.placement.steps.get(wire.target)?.y ?? 0;
    let latest: { bends: Bends | null; landing: number | null } = { bends: existing?.bends ?? null, landing: existing?.landing ?? null };
    run(e, (p) => {
      const r = dragSegment(bends, k, p, ends);
      latest = 'landingY' in r
        ? { bends: bends.xs.length > 0 ? bends : null, landing: clampLanding(r.landingY - targetY) }
        : { bends: r.bends, landing: latest.landing };
      setPreview(setShape(base, wire.id, latest));
    }, (cancelled, moved) => {
      setPreview(null);
      if (cancelled || !moved) return;
      const ty = latest.landing !== null ? targetY + latest.landing : ends.ty;
      const tidy = latest.bends ? normalize({ ...ends, ty }, latest.bends) : null;
      d.onCommit(setShape(base, wire.id, { bends: tidy, landing: latest.landing }));
    });
  };

  const gestures: DesignGestures = {
    wirePointerDown(wireId, e) {
      const d = designRef.current;
      if (!d || e.button !== 0 || !d.picks.some((p) => p.kind === 'wire' && p.id === wireId)) return;
      const wire = shown.current.wires.find((w) => w.id === wireId);
      if (!wire) return;
      // dragging a picked wire's body drags its nearest run, and never detaches it (spec §4.2)
      const existing = d.draft.routes[wireId]?.bends ?? shapeFromPoints(wire.points);
      const point = flowPointOf(e);
      startSegment(wire, point ? nearestSegment(endsOf(wire.points), existing, point) : 0, e);
    },
    portPointerDown() { /* Task 8 */ },
  };

  /** The press point in flow coordinates, read from the wire's own SVG transform. */
  function flowPointOf(e: ReactPointerEvent): Point | null {
    const el = e.currentTarget as SVGGraphicsElement;
    const m = el.getScreenCTM?.();
    if (!m) return null;
    const inv = m.inverse();
    return { x: inv.a * e.clientX + inv.c * e.clientY + inv.e, y: inv.b * e.clientX + inv.d * e.clientY + inv.f };
  }

  return { gestures, startSegment, active };
}
```

- [ ] **Step 4: Draw a picked wire's handles (`src/design/DesignOverlay.tsx`)**

Props gain:
```ts
  /** The picked wires, as shown. */
  wires: WireRoute[];
  /** The draft's shape of a wire, if any (its handles are the manual bends). */
  bendsOf: (wire: WireRoute) => Bends;
  onSegment: (wire: WireRoute, k: number, e: ReactPointerEvent) => void;
  onEnd: (wire: WireRoute, end: 'source' | 'target', e: ReactPointerEvent) => void;
```
Inside the svg, after the guides:
```tsx
        {wires.map((w) => {
          const ends = endsOf(w.points);
          const inner = w.points.slice(1, -1);
          return (
            <g key={w.id} className="design-wire">
              {inner.map(([x, y], i) => <path key={`b${i}`} className="design-handle bend" d={`M${x} ${y - 4}L${x + 4} ${y}L${x} ${y + 4}L${x - 4} ${y}Z`} />)}
              {segmentHandles(ends, bendsOf(w)).map((h) => (
                <rect key={`s${h.k}`} className="design-handle seg" data-k={h.k} x={h.x - 4} y={h.y - 4} width={8} height={8}
                  onPointerDown={(e) => onSegment(w, h.k, e)} />
              ))}
              <circle className="design-handle end" data-end="source" cx={ends.sx} cy={ends.sy} r={5} onPointerDown={(e) => onEnd(w, 'source', e)} />
              <circle className="design-handle end" data-end="target" cx={ends.tx} cy={ends.ty} r={5} onPointerDown={(e) => onEnd(w, 'target', e)} />
            </g>
          );
        })}
```
Append to `src/canvas/canvas.css`:
```css
.design-handle { pointer-events: all; cursor: pointer; }
.design-handle.end { fill: #34D399; stroke: #04111F; stroke-width: 1.5; }
.design-handle.seg { fill: var(--panel); stroke: var(--accent); stroke-width: 1.5; }
.design-handle.bend { fill: var(--accent); pointer-events: none; }
```

- [ ] **Step 5: Hook it up in `CanvasBody`**

```tsx
  const wiring = useWireGestures(shownRef, design, setPreview);
  const pickedWires = design ? shownDoc.wires.filter((w) => design.picks.some((p) => p.kind === 'wire' && p.id === w.id)) : [];
  const [menu, setMenu] = useState<{ anchor: Anchor; wireId: string } | null>(null);
```
Provide `wiring.gestures` through `<DesignContext.Provider value={design ? wiring.gestures : null}>`. Add `active` to the canvas class: `className={wiring.active ? 'studio-canvas gesture' : 'studio-canvas'}`. Pass to `DesignOverlay`: `wires={pickedWires}`, `bendsOf={(w) => design!.draft.routes[w.id]?.bends ?? shapeFromPoints(w.points)}`, `onSegment={wiring.startSegment}`, `onEnd={() => {}}` (Task 8). Right-click → Reset route:
```tsx
              onEdgeContextMenu={design ? (event, edge) => {
                if (edge.type !== 'cable') return;
                event.preventDefault();
                onSelect?.(null, [{ kind: 'wire', id: edge.id }]);
                setMenu({ anchor: anchorAt(event), wireId: edge.id });
              } : undefined}
```
and after `</ReactFlow>`:
```tsx
            {menu && design && (
              <Menu label="Wire" anchor={menu.anchor} onClose={() => setMenu(null)} entries={[{
                id: 'reset', label: 'Reset route',
                disabled: !design.draft.routes[menu.wireId],
                tip: design.draft.routes[menu.wireId] ? 'Let the router shape this wire again' : 'Only a wire shaped by hand has a route to reset',
                onSelect: () => { setMenu(null); design.onCommit(resetRoute(design.draft, menu.wireId)); },
              }]} />
            )}
```
(imports: `Menu`, `anchorAt`, `Anchor` from `'../dock/Menu'`; `resetRoute`; `shapeFromPoints`; `useWireGestures`.)

- [ ] **Step 6: Run the tests**

Run: `npx vitest run`
Expected: PASS. If jsdom's `screenToFlowPosition` returns NaN (no layout), the segment-drag test still commits because `dragSegment` snaps NaN: in that case change the test's move to rely on the commit only (`toHaveBeenCalledTimes(1)`) and assert bends non-null, which the jog guarantees.

- [ ] **Step 7: Check in a browser**

Dev server as in Task 6. Click a wire: green end dots, run squares, bend diamonds. Drag a run: neighbours stretch and bends snap; line a run up with its neighbour: the bend goes. Drag the last run: the arrow slides along the processor band only. Right-click → Reset route restores the automatic shape. Delete removes the wire; a step left unreached shows PARKED.

- [ ] **Step 8: Commit**

```bash
git add src/WorkflowStudio/src
git commit -m "feat(studio): a picked wire shows Visio handles; runs drag, the landing slides, Reset route and Delete (plan 4)"
```

---

### Task 8: Rewiring: detaching an end, new wires, and the drop outline

**Files:**
- Modify: `src/design/useWireGestures.ts`, `src/design/DesignOverlay.tsx`, `src/canvas/selection.ts`, `src/canvas/WorkflowCanvas.tsx`, `src/canvas/nodes/StepNode.tsx`, `src/canvas/nodes/WorkflowNode.tsx`, `src/canvas/canvas.css`, `src/design/useWireGestures.test.tsx`, `src/canvas/selection.test.ts`

**Interfaces:**
- Consumes: `canWire` (Task 3), `reattach`, `addWire`, `wireId` (Task 1), `blockAt` (Task 5).
- Produces: `startEnd(wire, end, e)`, `ghost: { from: Point; to: Point } | null`, `hint: { id: string; ok: boolean } | null` from `useWireGestures`; `withHint(nodes, hint)` and `DROP_OK_CLASS`/`DROP_NO_CLASS` in `canvas/selection.ts`; `DesignOverlayProps.ghost`.

- [ ] **Step 1: Write the failing tests**

Append to `src/canvas/selection.test.ts`:
```ts
  it('outlines the block under a dragged wire end green or red (plan 4)', () => {
    const nodes = [{ id: 's1', type: 'step', position: { x: 0, y: 0 }, data: {} }] as never;
    expect(withHint(nodes, { id: 's1', ok: true })[0]!.className).toBe(DROP_OK_CLASS);
    expect(withHint(nodes, { id: 's1', ok: false })[0]!.className).toBe(DROP_NO_CLASS);
    expect(withHint(nodes, null)).toBe(nodes);
  });
```
Append to `src/design/useWireGestures.test.tsx`:
```tsx
  it('a step offers a connection point only in design mode', async () => {
    const doc = await loadedDocument(graphDto({ steps: [stepDto('s1')] }));
    const { container, rerender } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} />);
    expect(container.querySelector('.nx-port')).toBeNull();
    rerender(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} design={designOf()} onSelect={vi.fn()} />);
    expect(container.querySelectorAll('.nx-port').length).toBe(2); // the hub's and the step's
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/canvas/selection.test.ts src/design/useWireGestures.test.tsx`
Expected: FAIL: `withHint` and `.nx-port` do not exist.

- [ ] **Step 3: The drop outline (`src/canvas/selection.ts` and CSS)**

```ts
export const DROP_OK_CLASS = 'drop-ok';
export const DROP_NO_CLASS = 'drop-no';

/** The block under a dragged wire end, outlined green when the drop is allowed and red when not (spec §4.4). */
export function withHint(nodes: StudioNode[], hint: { id: string; ok: boolean } | null): StudioNode[] {
  if (hint === null) return nodes;
  const cls = hint.ok ? DROP_OK_CLASS : DROP_NO_CLASS;
  return nodes.map((n) => (n.id === hint.id ? { ...n, className: n.className ? `${n.className} ${cls}` : cls } : n));
}
```
Append to `src/canvas/canvas.css`:
```css
.studio-canvas .react-flow__node.drop-ok { outline: 2px solid #34D399; outline-offset: 4px; border-radius: 8px; }
.studio-canvas .react-flow__node.drop-no { outline: 2px solid #F87171; outline-offset: 4px; border-radius: 8px; }
.design-ghost { fill: none; stroke: var(--accent); stroke-width: 1.6; stroke-dasharray: 5 4; }
.nx-port { position: absolute; width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--accent); background: var(--panel); box-sizing: border-box; opacity: 0; cursor: pointer; transition: opacity .12s; }
.react-flow__node:hover .nx-port, .studio-canvas.gesture .nx-port { opacity: 1; }
```

- [ ] **Step 4: Connection points on steps and the hub**

`src/canvas/nodes/StepNode.tsx` (`StepNode` receives `id` from `NodeProps`):
```tsx
export function StepNode({ id, data }: NodeProps<StepNodeType>) {
  const { health } = useLiveArt();
  const gestures = useContext(DesignContext);
  return (
    <>
      …existing handles and svg…
      {gestures && <div className="nx-port nodrag nopan" style={{ left: W - 6, top: PMID - 6 }} onPointerDown={(e) => gestures.portPointerDown(id, e)} />}
    </>
  );
}
```
`src/canvas/nodes/WorkflowNode.tsx` (the hub's right side, at its centre height):
```tsx
      {gestures && <div className="nx-port nodrag nopan" style={{ left: 2 * SPHERE_R - 6, top: SPHERE_R - 6 }} onPointerDown={(e) => gestures.portPointerDown('wf', e)} />}
```
(import `useContext`, `DesignContext`, `SPHERE_R` as needed.)

- [ ] **Step 5: End drags and new wires (`src/design/useWireGestures.ts`)**

Add state and the two gestures:
```ts
  const [ghost, setGhost] = useState<{ from: Point; to: Point } | null>(null);
  const [hint, setHint] = useState<{ id: string; ok: boolean } | null>(null);

  /**
   * Drags a wire end to another block (spec §4.4, option "a"): the block under the pointer is outlined
   * green or red; dropped on an allowed block the wire is re-attached (and becomes automatic); anywhere
   * else, or refused, it snaps back.
   */
  const dropGesture = (e: ReactPointerEvent, from: Point, current: string | null, verdict: (over: string) => DropVerdict, done: (over: string) => void) => {
    let over: string | null = null;
    run(e, (p) => {
      setGhost({ from, to: p });
      over = blockAt(shown.current, p);
      setHint(over === null || over === current ? null : { id: over, ok: verdict(over) === 'ok' });
    }, (cancelled) => {
      setGhost(null);
      setHint(null);
      if (cancelled || over === null || over === current || verdict(over) !== 'ok') return;
      done(over);
    });
  };

  const startEnd = (wire: WireRoute, end: 'source' | 'target', e: ReactPointerEvent) => {
    const d = designRef.current;
    if (!d || e.button !== 0) return;
    const ends = endsOf(wire.points);
    const from = end === 'target' ? { x: ends.sx, y: ends.sy } : { x: ends.tx, y: ends.ty };
    const current = end === 'target' ? wire.target : wire.source;
    dropGesture(e, from, current,
      (over) => (end === 'target' ? canWire(shown.current, wire.source, over, wire.id) : canWire(shown.current, over, wire.target, wire.id)),
      (over) => {
        const id = end === 'target' ? wireId(wire.source, over) : wireId(over, wire.target);
        d.onCommit(reattach(d.draft, saved, wire.id, end, over), { picks: [{ kind: 'wire', id }] });
      });
  };
```
In `gestures.portPointerDown`:
```ts
    portPointerDown(source, e) {
      const d = designRef.current;
      if (!d || e.button !== 0) return;
      const doc = shown.current;
      const from = source === WORKFLOW_SOURCE
        ? { x: doc.placement.sphere.cx + SPHERE_R, y: doc.placement.sphere.cy }
        : { x: (doc.placement.steps.get(source)?.x ?? 0) + STEP_W, y: (doc.placement.steps.get(source)?.y ?? 0) + PMID };
      dropGesture(e, from, null, (over) => canWire(shown.current, source, over), (over) => {
        d.onCommit(addWire(d.draft, saved, source, over), { picks: [{ kind: 'wire', id: wireId(source, over) }] });
      });
    },
```
`useWireGestures` gains a `saved: StudioDocument` first parameter (the edits need it); return `{ gestures, startSegment, startEnd, ghost, hint, active }`. Imports: `canWire`, `DropVerdict`, `blockAt`, `addWire`, `reattach`, `wireId`, `WORKFLOW_SOURCE`, `SPHERE_R`, `STEP_W`, `PMID`.

- [ ] **Step 6: Draw the ghost and outline in `CanvasBody`**

`DesignOverlayProps` gains `ghost: { from: Point; to: Point } | null`; inside the svg:
```tsx
        {ghost && <path className="design-ghost" d={`M${ghost.from.x} ${ghost.from.y}L${ghost.to.x} ${ghost.to.y}`} />}
```
In `CanvasBody`: `const wiring = useWireGestures(doc, shownRef, design, setPreview);`, nodes become `withHint(withSelection(marked.nodes, selection), wiring.hint)`, pass `ghost={wiring.ghost}` and `onEnd={wiring.startEnd}` to the overlay.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 8: Check in a browser**

Dev server as before. Drag a picked wire's arrow head onto another step: green outline, the wire moves there and takes that step's colour. Drag it onto an upstream step: red outline, it snaps back. Drop on empty canvas: snaps back. Hover a step: the connection point appears on its right edge; drag from it to a downstream step: a new wire. Escape during any of these: nothing changes.

- [ ] **Step 9: Commit**

```bash
git add src/WorkflowStudio/src
git commit -m "feat(studio): wire ends detach and re-attach, new wires from connection points; refused drops outline red and snap back (plan 4)"
```

---

### Task 9: Undo / Redo buttons, the design draft mark, Discard design and the close question

**Files:**
- Modify: `src/app/CapsuleToolbar.tsx`, `src/app/DocumentPanel.tsx`, `src/app/studioActions.ts`, `src/App.tsx`, `src/test/inspector.tsx`, `src/App.test.tsx`, `src/app/DocumentPanel.test.tsx`

**Interfaces:**
- Consumes: `designDirty`, actions `undo`, `redo`, `discardDesign` (Task 4); `canUndo`, `canRedo` (Task 4).
- Produces: `CapsuleToolbar` prop `design?: { dirty: boolean; canUndo: boolean; canRedo: boolean; onUndo: () => void; onRedo: () => void; onDiscard: () => void }`; `StudioActions.confirmDiscardDesign(workflowId: Id, doc?: Document): void`.

- [ ] **Step 1: Write the failing tests**

Append to `src/App.test.tsx` (top level; `withEntities`, `memoryStorage`, `ALPHA` and a session builder exist there; build a session whose document has a design draft):
```tsx
describe('the design draft (plan 4)', () => {
  const designSession = () => {
    const s = memoryStorage();
    s.setItem('skp.studio.session', JSON.stringify({
      version: 1, activeId: ALPHA, showDetails: false, dock: null,
      docs: [{ workflowId: ALPHA, name: 'alpha', version: '1.0.0', selection: null, view: null, design: { steps: { s1: { x: 800, y: 800 } } } }],
    }));
    return s;
  };

  it('marks the document, and Undo is disabled after a refresh', async () => {
    render(<App api={withEntities({})} storage={memoryStorage()} tabStorage={designSession()} />);
    expect(await screen.findByText('● design draft')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '↶ Undo' })).toBeDisabled();
  });

  it('Discard design asks, then drops the draft', async () => {
    render(<App api={withEntities({})} storage={memoryStorage()} tabStorage={designSession()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Discard design' }));
    const box = await screen.findByRole('alertdialog', { name: 'Discard design' });
    fireEvent.click(within(box).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.queryByText('● design draft')).toBeNull());
  });

  it('closing a document with a design draft asks; Cancel keeps it open', async () => {
    render(<App api={withEntities({})} storage={memoryStorage()} tabStorage={designSession()} />);
    expect(await screen.findByText('● design draft')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close alpha' }));
    const box = await screen.findByRole('alertdialog', { name: 'Discard design changes?' });
    fireEvent.click(within(box).getByRole('button', { name: 'Cancel' }));
    expect(screen.getAllByText('alpha', { selector: '.doctab .nm' })).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/App.test.tsx`
Expected: FAIL: no "● design draft", no buttons.

- [ ] **Step 3: The capsule (`src/app/CapsuleToolbar.tsx`)**

Add the prop (see Interfaces) and render, after the `dirty` span:
```tsx
      {design?.dirty && <span className="cap-b dirtyl">● design draft</span>}
```
and at the start of `.docact`:
```tsx
        {design && (
          <>
            <button type="button" className="qb" disabled={!design.canUndo} onClick={design.onUndo} data-tip="Undo (Ctrl+Z)">↶ Undo</button>
            <button type="button" className="qb" disabled={!design.canRedo} onClick={design.onRedo} data-tip="Redo (Ctrl+Y)">↷ Redo</button>
            <button type="button" className="qb" disabled={!design.dirty} onClick={design.onDiscard} data-tip="Drop every design change in this workflow">Discard design</button>
            <span className="qsep" />
          </>
        )}
```
The Save button's tip stays "Save the Inspector's changes": it never saves the design (spec §5.4).

- [ ] **Step 4: The panel passes it (`src/app/DocumentPanel.tsx`)**

```tsx
  const { confirmDiscardDesign } = useStudioActions();
  …
        <CapsuleToolbar … design={{
          dirty: designDirty(open), canUndo: canUndo(open.design), canRedo: canRedo(open.design),
          onUndo: () => store.dispatch({ type: 'undo', workflowId }),
          onRedo: () => store.dispatch({ type: 'redo', workflowId }),
          onDiscard: () => confirmDiscardDesign(workflowId, ownerDocument),
        }} />
```
If DocumentPanel is rendered in tests without a `StudioActionsProvider`, read the actions with `useContext` and skip `design` when there are none (add `useStudioActionsOrNull()` to `studioActions.ts`: `return useContext(Context);`).

- [ ] **Step 5: The page's questions (`src/app/studioActions.ts`, `src/App.tsx`)**

`StudioActions` gains:
```ts
  /** Asks before dropping a document's design draft (spec §5.4), then drops it. */
  confirmDiscardDesign(workflowId: Id, doc?: Document): void;
```
`src/App.tsx`: `Prompt` gains
```ts
    | { kind: 'design'; workflowId: string; doc: Document }
    | { kind: 'closeDesign'; workflowId: string; doc: Document; proceed: () => void }
```
the actions object gains
```ts
    confirmDiscardDesign: (workflowId, doc = document) => {
      if (asking.current !== null) return;
      setPrompt({ kind: 'design', workflowId, doc });
    },
```
`onCloseDocument` becomes
```tsx
        onCloseDocument={(id, doc) => {
          const close = () => actions.guard(id, () => {
            views.current.delete(id);
            store.dispatch({ type: 'close', workflowId: id });
          }, doc);
          const open = store.getState().docs.find((d) => d.workflowId === id);
          if (open && designDirty(open) && asking.current === null) setPrompt({ kind: 'closeDesign', workflowId: id, doc, proceed: close });
          else close();
        }}
```
and the dialogs:
```tsx
      {prompt?.kind === 'design' && (
        <ConfirmDialog doc={prompt.doc} title="Discard design" onCancel={() => setPrompt(null)}
          message="Every design change in this workflow is dropped, and the canvas shows the saved workflow again."
          buttons={[{ label: 'Discard', primary: true, onClick: () => { setPrompt(null); store.dispatch({ type: 'discardDesign', workflowId: prompt.workflowId }); } }]} />
      )}
      {prompt?.kind === 'closeDesign' && (
        <ConfirmDialog doc={prompt.doc} title="Discard design changes?" onCancel={() => setPrompt(null)}
          message="This workflow has design changes that are not saved. The trial cannot save them."
          buttons={[{ label: 'Discard', primary: true, onClick: () => { setPrompt(null); store.dispatch({ type: 'discardDesign', workflowId: prompt.workflowId }); prompt.proceed(); } }]} />
      )}
```
The tab mark: in `identity` and `documents`, `dirty` becomes `hasEdits(d.inspector) || designDirty(d)`. Add `confirmDiscardDesign: vi.fn()` to the test provider in `src/test/inspector.tsx`.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/WorkflowStudio/src
git commit -m "feat(studio): Undo, Redo, Discard design and the design draft mark; closing a designed workflow asks (plan 4)"
```

---

### Task 10: The trial end to end, by hand, and the frame rate

**Files:**
- Create: `e2e/designer.spec.ts`

**Interfaces:**
- Consumes: `test`, `expect`, `openWorkflow`, `documentPanel`, `inspector`, `tab`, `workflowsWithSteps` (`e2e/studio.ts`; its `test` already fails on any write except validate).

- [ ] **Step 1: Write the e2e spec**

`e2e/designer.spec.ts`:
```ts
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { documentPanel, expect, inspector, openWorkflow, tab, test, workflowsWithSteps, type LiveWorkflow } from './studio';

// Plan 4: the designer is a trial; nothing it does may write (studio.ts's read-only guard checks every
// request). Each test starts from an empty session and works on a live workflow with a chain a -> b -> c
// where b has no other way in.

interface Chain { workflow: LiveWorkflow; a: string; b: string; c: string }

async function findChain(request: APIRequestContext): Promise<Chain | null> {
  for (const workflow of await workflowsWithSteps(request)) {
    const g = (await (await request.get(`/api/v1/workflows/${workflow.id}/graph`)).json()) as { workflow: { entryStepIds: string[] }; steps: { id: string; nextStepIds: string[] }[] };
    const into = (id: string) => g.steps.filter((s) => s.nextStepIds.includes(id)).length + (g.workflow.entryStepIds.includes(id) ? 1 : 0);
    for (const a of g.steps) for (const b of a.nextStepIds) {
      const sb = g.steps.find((s) => s.id === b);
      if (!sb || into(b) !== 1) continue;
      const c = sb.nextStepIds[0];
      if (c && c !== a.id) return { workflow, a: a.id, b, c };
    }
  }
  return null;
}

let chain: Chain | null;
test.beforeAll(async ({ request }) => { chain = await findChain(request); });
test.beforeEach(async ({ page }) => {
  test.skip(chain === null, 'BaseApi has no workflow with a chain a -> b -> c');
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
});

const node = (panel: Locator, id: string) => panel.locator(`.react-flow__node[data-id="${id}"]`);
const wire = (panel: Locator, id: string) => panel.locator(`.react-flow__edge[data-id="${id}"]`);
const pathOf = (panel: Locator, id: string) => wire(panel, id).locator('path.w').getAttribute('d');

/** A point on a wire, in page coordinates. */
async function pointOnWire(panel: Locator, id: string, f = 0.5): Promise<{ x: number; y: number }> {
  return wire(panel, id).locator('path.w').evaluate((el, at) => {
    const p = el as SVGPathElement;
    const pt = p.getPointAtLength(p.getTotalLength() * at);
    const m = p.getScreenCTM()!;
    return { x: pt.x * m.a + pt.y * m.c + m.e, y: pt.x * m.b + pt.y * m.d + m.f };
  }, f);
}

async function centreOf(l: Locator): Promise<{ x: number; y: number }> {
  const b = (await l.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
}

async function open(page: Page): Promise<Locator> {
  await openWorkflow(page, chain!.workflow);
  return documentPanel(page, chain!.workflow);
}

test('a moved step takes its wires with it; the draft is marked; a refresh keeps it; Discard drops it', async ({ page }) => {
  const panel = await open(page);
  const { a, b } = chain!;
  const before = await pathOf(panel, `${a}->${b}`);
  const at = await centreOf(node(panel, b).locator('.nx-sn'));
  await drag(page, at, { x: at.x, y: at.y + 120 });
  await expect.poll(() => pathOf(panel, `${a}->${b}`)).not.toBe(before);
  await expect(page.getByText('● design draft')).toBeVisible();
  await expect(tab(page, chain!.workflow.name)).toHaveClass(/\bdirty\b/);

  await page.reload();
  const again = documentPanel(page, chain!.workflow);
  await expect(page.getByText('● design draft')).toBeVisible();
  await expect.poll(() => pathOf(again, `${a}->${b}`)).not.toBe(before);

  await page.getByRole('button', { name: 'Discard design' }).click();
  await page.getByRole('alertdialog', { name: 'Discard design' }).getByRole('button', { name: 'Discard' }).click();
  await expect(page.getByText('● design draft')).toHaveCount(0);
  await expect.poll(() => pathOf(again, `${a}->${b}`)).toBe(before);
});

test('Ctrl+click and a rectangle pick several items; a wire click names the wire', async ({ page }) => {
  const panel = await open(page);
  const { a, b } = chain!;
  await node(panel, a).locator('.nx-sn').click();
  await node(panel, b).locator('.nx-sn').click({ modifiers: ['Control'] });
  await expect(inspector(page).getByText('2 items selected')).toBeVisible();

  const box = (await node(panel, a).boundingBox())!;
  await drag(page, { x: box.x - 12, y: box.y - 12 }, { x: box.x + box.width + 12, y: box.y + box.height + 12 });
  await expect(node(panel, a)).toHaveClass(/studio-pick/);

  const p = await pointOnWire(panel, `${a}->${b}`);
  await page.mouse.click(p.x, p.y);
  await expect(inspector(page).getByText(/^Wire: /)).toBeVisible();
});

test('a run drags and Reset route restores the automatic shape', async ({ page }) => {
  const panel = await open(page);
  const id = `${chain!.a}->${chain!.b}`;
  const before = await pathOf(panel, id);
  const p = await pointOnWire(panel, id);
  await page.mouse.click(p.x, p.y);
  const handle = panel.locator('.design-handle.seg').first();
  const at = await centreOf(handle);
  await drag(page, at, { x: at.x, y: at.y + 48 });
  await expect.poll(() => pathOf(panel, id)).not.toBe(before);
  const q = await pointOnWire(panel, id, 0.3);
  await page.mouse.click(q.x, q.y, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Reset route' }).click();
  await expect.poll(() => pathOf(panel, id)).toBe(before);
});

test('a wire end re-attaches; a cycle outlines red and snaps back', async ({ page }) => {
  const panel = await open(page);
  const { a, b, c } = chain!;
  const p = await pointOnWire(panel, `${b}->${c}`);
  await page.mouse.click(p.x, p.y);
  const head = await centreOf(panel.locator('.design-handle.end[data-end="target"]'));
  const target = await centreOf(node(panel, a).locator('.nx-sn'));
  await page.mouse.move(head.x, head.y);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 6 });
  await expect(node(panel, a)).toHaveClass(/drop-no/);
  await page.mouse.up();
  await expect(wire(panel, `${b}->${c}`)).toHaveCount(1);
  await expect(page.getByText('● design draft')).toHaveCount(0);
});

test('a new entry wire from the hub, Delete, and a step left unreached is parked; Undo and Redo', async ({ page }) => {
  const panel = await open(page);
  const { a, b, c } = chain!;
  await node(panel, 'wf').hover();
  const port = await centreOf(node(panel, 'wf').locator('.nx-port'));
  const target = await centreOf(node(panel, c).locator('.nx-sn'));
  await drag(page, port, target);
  await expect(wire(panel, `wf->${c}`)).toHaveCount(1);

  const p = await pointOnWire(panel, `${a}->${b}`);
  await page.mouse.click(p.x, p.y);
  await page.keyboard.press('Delete');
  await expect(wire(panel, `${a}->${b}`)).toHaveCount(0);
  await expect(node(panel, b).getByText('PARKED')).toBeVisible();

  await page.keyboard.press('Control+z');
  await expect(wire(panel, `${a}->${b}`)).toHaveCount(1);
  await page.getByRole('button', { name: '↷ Redo' }).click();
  await expect(wire(panel, `${a}->${b}`)).toHaveCount(0);
});

test('closing a designed workflow asks; Cancel keeps it', async ({ page }) => {
  const panel = await open(page);
  const at = await centreOf(node(panel, chain!.b).locator('.nx-sn'));
  await drag(page, at, { x: at.x + 64, y: at.y });
  await expect(page.getByText('● design draft')).toBeVisible();
  await tab(page, chain!.workflow.name).getByRole('button', { name: `Close ${chain!.workflow.name}` }).click();
  await page.getByRole('alertdialog', { name: 'Discard design changes?' }).getByRole('button', { name: 'Cancel' }).click();
  await expect(tab(page, chain!.workflow.name)).toHaveCount(1);
});
```

- [ ] **Step 2: Run the e2e spec**

Run (PowerShell, from `src/WorkflowStudio`, with the port-forward up): `npx playwright test e2e/designer.spec.ts`
Expected: 6 passed (or all skipped with the chain reason if BaseApi has no such workflow; then pick a workflow by hand for Step 4). Fix selectors against the live DOM if a locator misses (for example React Flow's `data-id` on edges); never weaken the read-only guard.

- [ ] **Step 3: Run every suite**

Run: `npx tsc -b`, `npx vitest run`, `npx playwright test`
Expected: no type errors; every unit test passes; e2e passes apart from data-dependent skips. Delete `tsconfig.tsbuildinfo` if `tsc -b` created it.

- [ ] **Step 4: Check the trial by hand**

Dev server (`npx vite --port 5174` from PowerShell). Go through the e2e list in a browser on the largest current workflow (`filefetcher-archiveexpander-chain`), plus: cursors (arrow on empty canvas and scroll-bar thumbs, hand on blocks and wires, closed hand while dragging); alignment guides; Escape during each gesture; a pop-out window (drag inside it). Record the frame rate while dragging a step with Chrome DevTools' performance panel: about 60 fps is the bar (spec §7). If it is well below, re-route only the wires touching moved blocks during a drag and measure again.

- [ ] **Step 5: Commit**

```bash
git add src/WorkflowStudio/e2e/designer.spec.ts
git commit -m "test(studio): the designer trial end to end on a live workflow, with no writes (plan 4)"
```

- [ ] **Step 6: Deploy for the trial (only with the user's go-ahead)**

From the repo root: `docker build -f src/WorkflowStudio/Dockerfile -t workflow-studio:local .`, `kind load docker-image workflow-studio:local --name desktop`, `kubectl -n skp rollout restart deploy/workflow-studio`, then restart the `workflow-studio` port-forward on 18081. Hand the trial to the user.
