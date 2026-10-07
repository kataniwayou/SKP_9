# SKP Studio plan 7: junctions (wire onto wire) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A wire's arrow can be dropped on another same-colour wire's line; it is then drawn ending on that line at a filled dot, shares the line, and splits off at the point nearest its own step — drawing only, the workflow's wiring never changes.

**Architecture:** A junction is part of a wire's shape in the design draft (`WireShape.contact = { host, at }`). `routeWires` routes plain wires first, then joined wires host-first, giving each a `Joint` (own line, contact, split, branch). The canvas still has one edge per wire; `CableEdge` draws the own line, the branch and the dots. The end-drag gesture learns lines as drop targets.

**Tech Stack:** React 19, @xyflow/react 12, TypeScript, Vitest + Testing Library (jsdom), Playwright (Chromium). App in `src/WorkflowStudio`.

**Spec:** `docs/superpowers/specs/2026-10-07-skp-studio-07-junctions-design.md` (read it first; it wins over this plan on behaviour).

## Global Constraints

- Drawing only: no junction gesture changes `draft.next` or `draft.entries`. No BaseApi writes (the e2e read-only guard in `e2e/studio.ts` must keep passing).
- Marks, one meaning each: hollow ring `.nx-src` = leaves a step; open arrow head `.nx-head` = enters a step; filled dot `.nx-joint` (radius 4.5, wire colour) = on a line. Contact and split use the same dot.
- Allowed join: same colour (`WireRoute.condition` equal), not the same wire, no loop through hosts.
- Labels (exact text): "join here", "other colour", "same wire", "would make a loop", "start stays on a block", "drop on a step", "starts here".
- One drop reach (user, 2026-10-07): a step, the hub and a wire line count as under a dragged end from `DROP_REACH = 8` screen px outside their border; every dragged end (head, tail, contact, arrow, new wire) gets the same feedback: green outline/halo + label when the drop is allowed, red + reason when not.
- Contact kept ≥ 16 px from the host's start and arrow tip (`CONTACT_MARGIN = 16`); `at` snapped to 8 px.
- Cursors: contact square `move` (four-way), kept while dragged; start and arrow squares `ew-resize`.
- Every user-visible behaviour is verified with Playwright using real mouse drags, on the dev server and on the deployed studio (user rule, memory `verify-studio-ui-with-playwright`).
- Run npm/npx from PowerShell in `src/WorkflowStudio`; delete `tsconfig.tsbuildinfo` after `npx tsc -b`.

## Review Focus

1. A host that is re-attached (its id changes `s->x` to `s->y`) must keep the wires joined onto it (they follow the new id); covered in Task 1 (`reattach` renames hosts).
2. A run drag on a joined wire's own line must keep its contact (the shape written must carry `contact`); covered in Task 7.
3. The split must never sit on the host's arrow tip inside the host's step (a branch would start inside a block); split clamped to `travelLen - 16`; covered in Task 3.
4. A drop preview must not hit the dragged wire itself (the moving wire is under the pointer); `wireAt` excludes the dragged wire; covered in Task 6.
5. A loop in stored contacts (A on B, B on A) must not hang routing and draws both plain; covered in Task 3.

---

## File structure

- `src/layout/shape.ts` — `Contact` type; `WireShape.contact?`.
- `src/layout/junctions.ts` (new) — pure polyline geometry: `lengthOf`, `pointAt`, `nearestOn`, `slice`, `ownEnds`, `inLoop`.
- `src/layout/wires.ts` — `Joint`, `WireRoute.joint?`, second routing pass `joinWires`.
- `src/design/draft.ts` — `setShape` keeps contact-only shapes; `parseDraft` reads `contact`; `reattach` renames hosts.
- `src/design/rules.ts` — `JoinVerdict`, `canJoin`, labels.
- `src/design/hit.ts` — `wireAt`.
- `src/canvas/toFlow.ts`, `src/canvas/edges/CableEdge.tsx`, `src/canvas/art.css`, `src/canvas/canvas.css` — drawing, halo, hit band for the branch.
- `src/design/DesignContext.ts` — `wirePointerDown(id, e, part)`.
- `src/design/useWireGestures.ts`, `src/design/DesignOverlay.tsx`, `src/canvas/WorkflowCanvas.tsx` — joining and the joined wire's handles.
- Tests next to each file; `e2e/designer.spec.ts`.

---

### Task 1: Store a contact in the draft

**Files:**
- Modify: `src/layout/shape.ts:15-21`
- Modify: `src/design/draft.ts` (`setShape`, `reattach`, `parseDraft`)
- Test: `src/design/draft.test.ts`

**Interfaces:**
- Produces: `export interface Contact { host: string; at: number }`; `WireShape.contact?: Contact | null`; `reattach(...)` rewrites `routes[k].contact.host` from the old wire id to the new one.

- [ ] **Step 1: Write the failing tests** (append to `src/design/draft.test.ts`; it already imports from `./draft` — add `parseDraft`, `reattach`, `setShape`, `EMPTY_DRAFT` to that import if missing, and `loadedDocument`/`graphDto`/`stepDto` as the file's other tests do)

```ts
describe('junction contacts in the draft', () => {
  it('keeps a shape that has only a contact, and drops one with nothing', () => {
    const d = setShape(EMPTY_DRAFT, 'a->b', { bends: null, landing: null, contact: { host: 'c->d', at: 40 } });
    expect(d.routes['a->b']).toEqual({ bends: null, landing: null, contact: { host: 'c->d', at: 40 } });
    expect(setShape(d, 'a->b', { bends: null, landing: null, contact: null }).routes['a->b']).toBeUndefined();
  });

  it('reads a contact back from the session and drops a malformed one', () => {
    const ok = parseDraft({ routes: { 'a->b': { bends: null, landing: null, contact: { host: 'c->d', at: 40 } } } })!;
    expect(ok.routes['a->b']!.contact).toEqual({ host: 'c->d', at: 40 });
    const bad = parseDraft({ routes: { 'a->b': { contact: { host: 7, at: 'x' } } } })!;
    expect(bad.routes['a->b']).toBeUndefined();
  });

  it('re-attaching a host moves the wires joined onto it to its new id', async () => {
    const doc = await loadedDocument(graphDto({ steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2'), stepDto('s3')] }));
    const joined = setShape(EMPTY_DRAFT, 'wf->s3', { bends: null, landing: null, contact: { host: 's1->s2', at: 40 } });
    const d = reattach(joined, doc, 's1->s2', 'target', 's3');
    expect(d.routes['wf->s3']!.contact).toEqual({ host: 's1->s3', at: 40 });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/design/draft.test.ts`
Expected: FAIL (type error / `contact` dropped / host not renamed).

- [ ] **Step 3: Implement**

`src/layout/shape.ts` — replace the `WireShape` interface:

```ts
/** A junction (plan 7): the wire ends on `host`'s line, `at` px along its drawn line from its start. */
export interface Contact {
  host: string;
  at: number;
}

/** What the user did to one wire's shape. */
export interface WireShape {
  /** A manual route; null: the router decides. For a joined wire: its own line's bends. */
  bends: Bends | null;
  /** Step-local landing height on the target, when slid; null: the landing rule decides. */
  landing: number | null;
  /** On another wire's line (plan 7); absent or null: a plain wire. */
  contact?: Contact | null;
}
```

`src/design/draft.ts` — `setShape`:

```ts
export function setShape(draft: Draft, id: string, shape: WireShape | null): Draft {
  const routes = copy(draft.routes);
  if (shape === null || (shape.bends === null && shape.landing === null && (shape.contact ?? null) === null)) delete routes[id];
  else routes[id] = shape;
  return { ...draft, routes };
}
```

`reattach` — replace its body:

```ts
/** Moves one end of a wire to another block; the wire becomes automatic (spec §4.4). Wires joined onto it follow its new id (plan 7). */
export function reattach(draft: Draft, saved: StudioDocument, id: string, end: 'source' | 'target', to: SourceId): Draft {
  const { source, target } = wireEnds(id);
  const d = removeWires(draft, saved, [id]);
  const moved = end === 'target' ? addWire(d, saved, source, to) : addWire(d, saved, to, target);
  return renameHost(moved, id, end === 'target' ? wireId(source, to) : wireId(to, target));
}

function renameHost(draft: Draft, from: string, to: string): Draft {
  if (from === to) return draft;
  const routes = copy(draft.routes);
  for (const [k, s] of Object.entries(routes)) if (s.contact?.host === from) routes[k] = { ...s, contact: { ...s.contact, host: to } };
  return { ...draft, routes };
}
```

`parseDraft` — replace the `routes` parse:

```ts
  const routes = records(value.routes, (raw) => {
    if (!isRecord(raw)) return null;
    const c = raw.contact;
    const contact = isRecord(c) && typeof c.host === 'string' && c.host !== '' && isNum(c.at) ? { host: c.host, at: c.at } : null;
    const shape: WireShape = { bends: toBends(raw.bends), landing: isNum(raw.landing) ? raw.landing : null, contact };
    return shape.bends === null && shape.landing === null && contact === null ? null : shape;
  });
```

Existing tests compare parsed shapes with `toEqual({ bends, landing })`; if one now fails only because of the added `contact: null`, update that expectation to include `contact: null`.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/design`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/WorkflowStudio/src/layout/shape.ts src/WorkflowStudio/src/design/draft.ts src/WorkflowStudio/src/design/draft.test.ts
git commit -m "feat(studio): a wire shape can hold a junction contact; re-attaching a host keeps its joined wires (plan 7)"
```

---

### Task 2: Polyline geometry for junctions

**Files:**
- Create: `src/layout/junctions.ts`
- Test: `src/layout/junctions.test.ts`

**Interfaces:**
- Produces (all pure, `Pt` from `./router`):
  - `CONTACT_MARGIN = 16`
  - `lengthOf(pieces: readonly (readonly Pt[])[]): number` — summed run lengths, no length between pieces
  - `pointAt(pieces, d: number): { p: Pt; vertical: boolean }` — clamped to [0, length]
  - `nearestOn(pieces, q: Pt, from?: number, to?: number): { p: Pt; at: number; gap: number }` — nearest point with its distance along, searched within [from, to]
  - `slice(line: readonly Pt[], d0: number, d1: number): Pt[]`
  - `ownEnds(sx: number, sy: number, contact: Pt, hostVertical: boolean): { ends: Ends; tail: Pt[] }`
  - `inLoop(id: string, hostOf: (id: string) => string | undefined): boolean`

- [ ] **Step 1: Write the failing tests** (`src/layout/junctions.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import { inLoop, lengthOf, nearestOn, ownEnds, pointAt, slice } from './junctions';
import type { Pt } from './router';

const L: Pt[] = [[0, 0], [100, 0], [100, 50]];

describe('polyline geometry', () => {
  it('measures pieces without the gap between them', () => {
    expect(lengthOf([L])).toBe(150);
    expect(lengthOf([L, [[200, 0], [240, 0]]])).toBe(190);
  });

  it('finds the point at a distance and whether its run is vertical', () => {
    expect(pointAt([L], 40)).toEqual({ p: [40, 0], vertical: false });
    expect(pointAt([L], 120)).toEqual({ p: [100, 20], vertical: true });
    expect(pointAt([L], 999).p).toEqual([100, 50]);
    expect(pointAt([L, [[200, 0], [240, 0]]], 160)).toEqual({ p: [210, 0], vertical: false });
  });

  it('finds the nearest point and its distance along, within a range', () => {
    expect(nearestOn([L], [60, 30])).toEqual({ p: [60, 0], at: 60, gap: 30 });
    expect(nearestOn([L], [130, 40])).toEqual({ p: [100, 40], at: 140, gap: 30 });
    // not before 120: the nearest allowed point to (60, 30) is (100, 20)
    expect(nearestOn([L], [60, 30], 120).at).toBe(120);
    expect(nearestOn([L], [130, 48], 0, 130).at).toBe(130);
  });

  it('slices a line between two distances', () => {
    expect(slice(L, 40, 120)).toEqual([[40, 0], [100, 0], [100, 20]]);
    expect(slice(L, 120, 999)).toEqual([[100, 20], [100, 50]]);
  });

  it('meets a horizontal host run square-on with a vertical last leg, a vertical one with a horizontal leg', () => {
    expect(ownEnds(0, 200, [96, 128], false)).toEqual({ ends: { sx: 0, sy: 200, tx: 96, ty: 144 }, tail: [[96, 128]] });
    expect(ownEnds(0, 40, [96, 128], false)).toEqual({ ends: { sx: 0, sy: 40, tx: 96, ty: 112 }, tail: [[96, 128]] });
    expect(ownEnds(0, 40, [96, 128], true)).toEqual({ ends: { sx: 0, sy: 40, tx: 96, ty: 128 }, tail: [] });
  });

  it('finds a loop through hosts', () => {
    const hosts: Record<string, string> = { a: 'b', b: 'a', c: 'a', d: 'e' };
    const hostOf = (id: string) => hosts[id];
    expect(inLoop('a', hostOf)).toBe(true);
    expect(inLoop('c', hostOf)).toBe(false);
    expect(inLoop('d', hostOf)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/layout/junctions.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** (`src/layout/junctions.ts`)

```ts
import { GRID, snap } from './geometry';
import type { Pt } from './router';
import { JOG, type Ends } from './shape';

/** A contact and a split stay this far from a line's start and arrow tip (spec §5.3). */
export const CONTACT_MARGIN = 16;

type Pieces = readonly (readonly Pt[])[];

const runLength = (a: Pt, b: Pt) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);

/** The summed length of every run; nothing is counted between two pieces. */
export function lengthOf(pieces: Pieces): number {
  let n = 0;
  for (const line of pieces) for (let i = 0; i < line.length - 1; i++) n += runLength(line[i]!, line[i + 1]!);
  return n;
}

/** The point `d` along the pieces (clamped), and whether the run it lies on is vertical. */
export function pointAt(pieces: Pieces, d: number): { p: Pt; vertical: boolean } {
  let left = Math.max(0, d);
  let last: { p: Pt; vertical: boolean } | null = null;
  for (const line of pieces) {
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i]!, b = line[i + 1]!, len = runLength(a, b);
      if (len === 0) continue;
      const vertical = a[0] === b[0];
      if (left <= len) {
        const t = left / len;
        return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], vertical };
      }
      left -= len;
      last = { p: b, vertical };
    }
  }
  return last ?? { p: pieces[0]?.[0] ?? [0, 0], vertical: false };
}

/** The point of the pieces nearest `q`, searched between `from` and `to` along them: where, how far along, how far off. */
export function nearestOn(pieces: Pieces, q: Pt, from = 0, to = Infinity): { p: Pt; at: number; gap: number } {
  let best = { p: pieces[0]?.[0] ?? q, at: 0, gap: Infinity };
  let run = 0;
  for (const line of pieces) {
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i]!, b = line[i + 1]!, len = runLength(a, b);
      if (len === 0) continue;
      const lo = Math.max(0, (from - run) / len), hi = Math.min(1, (to - run) / len);
      if (lo <= hi) {
        const raw = ((q[0] - a[0]) * (b[0] - a[0]) + (q[1] - a[1]) * (b[1] - a[1])) / (len * len);
        const t = Math.min(Math.max(raw, lo), hi);
        const p: Pt = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        const gap = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (gap < best.gap) best = { p, at: run + t * len, gap };
      }
      run += len;
    }
  }
  return best;
}

/** The part of a line between distances d0 and d1 along it. */
export function slice(line: readonly Pt[], d0: number, d1: number): Pt[] {
  const total = lengthOf([line]);
  const a = Math.max(0, Math.min(d0, total)), b = Math.max(a, Math.min(d1, total));
  const out: Pt[] = [pointAt([line], a).p];
  let run = 0;
  for (let i = 0; i < line.length - 1; i++) {
    run += runLength(line[i]!, line[i + 1]!);
    if (run > a && run < b) out.push(line[i + 1]!);
  }
  out.push(pointAt([line], b).p);
  return out.filter((p, i) => i === 0 || p[0] !== out[i - 1]![0] || p[1] !== out[i - 1]![1]);
}

/**
 * Where a joined wire's own line ends so it meets its host square-on (spec §5.3): onto a vertical run it
 * arrives heading right at the contact; onto a horizontal run it arrives heading right one jog off the
 * line, on its source's side, and a vertical `tail` takes it onto the contact.
 */
export function ownEnds(sx: number, sy: number, contact: Pt, hostVertical: boolean): { ends: Ends; tail: Pt[] } {
  const [cx, cy] = contact;
  if (hostVertical) return { ends: { sx, sy, tx: cx, ty: cy }, tail: [] };
  const ty = snap(sy <= cy ? cy - JOG : cy + JOG, GRID);
  return { ends: { sx, sy, tx: cx, ty }, tail: [contact] };
}

/** Following hosts from `id` comes back to `id`. */
export function inLoop(id: string, hostOf: (id: string) => string | undefined): boolean {
  const seen = new Set<string>();
  for (let h = hostOf(id); h !== undefined; h = hostOf(h)) {
    if (h === id) return true;
    if (seen.has(h)) return false;
    seen.add(h);
  }
  return false;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/layout/junctions.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/WorkflowStudio/src/layout/junctions.ts src/WorkflowStudio/src/layout/junctions.test.ts
git commit -m "feat(studio): polyline geometry for junctions (plan 7)"
```

---

### Task 3: Route joined wires

**Files:**
- Modify: `src/layout/wires.ts`
- Test: `src/layout/wires.test.ts` (extend `setup` with shapes)

**Interfaces:**
- Consumes: Task 1 `Contact`, Task 2 helpers, `clearPath` (`layout/detour.ts`), `route` (`layout/router.ts`).
- Produces:

```ts
export interface Joint {
  host: string;
  /** The filled dot on the host's line where the own line ends. */
  contact: Pt;
  /** The filled dot where the branch leaves the shared line; null when the wire goes into its host's step. */
  split: Pt | null;
  /** From the split to the wire's landing, ending in its arrow head; empty when `split` is null. */
  branch: Pt[];
  /** The own line without its tail: what the own line's bends are measured on. */
  own: Pt[];
  ownEnds: Ends;
}
// WireRoute gains:  joint?: Joint   — and for a joined wire `points` is its own line (source → contact).
```

- [ ] **Step 1: Write the failing tests** (in `src/layout/wires.test.ts`: change `setup` to take an optional 4th argument `shapes?: WiringInput['shapes']` and pass it into `input`; then append)

```ts
describe('junctions (plan 7)', () => {
  // s (288,32) -> b (864,32): a straight host along y 128; t (288,288) -> c (864,288); u (288,544) -> b
  const steps = () => [
    step('s', ['b']), step('t', ['c']), step('u', ['b']),
    step('b', [], { entryCondition: 2 }), step('c', [], { entryCondition: 2 }), step('x', [], { entryCondition: 1 }),
  ];
  const at = { s: [288, 32], t: [288, 288], u: [288, 544], b: [864, 32], c: [864, 288], x: [864, 544] } as Record<string, [number, number]>;
  const boxes = Object.values(at).map(([x, y]) => ({ x, y, w: 224, h: 160 }));
  const through = (pts: readonly (readonly [number, number])[]) => pts.some((a, i) => {
    const c = pts[i + 1];
    return c !== undefined && boxes.some((b) => Math.max(a[0], c[0]) > b.x && Math.min(a[0], c[0]) < b.x + b.w && Math.max(a[1], c[1]) > b.y && Math.min(a[1], c[1]) < b.y + b.h);
  });
  const square = (pts: readonly (readonly [number, number])[]) => pts.every((p, i) => i === 0 || p[0] === pts[i - 1]![0] || p[1] === pts[i - 1]![1]);
  const join = (id: string, host: string, d: number) => ({ [id]: { bends: null, landing: null, contact: { host, at: d } } });

  it('a wire on another goes to a dot on its line, square-on, and splits off to its own step', () => {
    const wires = setup(steps(), at, new Set<string>(), join('t->c', 's->b', 176));
    const host = wires.find((w) => w.id === 's->b')!, w = wires.find((x) => x.id === 't->c')!;
    expect(w.joint!.host).toBe('s->b');
    expect(w.joint!.contact).toEqual([688, 128]);
    // own line: last leg vertical onto the horizontal host run
    const n = w.points.length;
    expect(w.points[n - 1]).toEqual([688, 128]);
    expect(w.points[n - 2]![0]).toBe(688);
    // split on the host line, after the contact, short of the host's arrow tip
    expect(w.joint!.split![1]).toBe(128);
    expect(w.joint!.split![0]).toBeGreaterThan(688);
    expect(w.joint!.split![0]).toBeLessThanOrEqual(host.points[host.points.length - 1]![0] - 16);
    // the branch lands on c, heading right
    const br = w.joint!.branch;
    expect(br[0]).toEqual(w.joint!.split);
    expect(br[br.length - 1]![0]).toBe(864);
    expect(br[br.length - 2]![1]).toBe(br[br.length - 1]![1]);
    for (const line of [w.points, br]) { expect(square(line)).toBe(true); expect(through(line)).toBe(false); }
  });

  it('a wire into its host\'s step merges: no split, no branch', () => {
    const wires = setup(steps(), at, new Set<string>(), join('u->b', 's->b', 176));
    const w = wires.find((x) => x.id === 'u->b')!;
    expect(w.joint!.split).toBeNull();
    expect(w.joint!.branch).toEqual([]);
  });

  it('a chain routes host first: a wire may sit on a joined wire\'s own line', () => {
    const wires = setup(steps(), at, new Set<string>(), { ...join('u->b', 't->c', 40), ...join('t->c', 's->b', 176) });
    expect(wires.find((x) => x.id === 't->c')!.joint).toBeDefined();
    const u = wires.find((x) => x.id === 'u->b')!;
    expect(u.joint!.host).toBe('t->c');
    expect(u.joint!.split).not.toBeNull();
  });

  it('another colour, a missing host, itself or a loop: drawn plain', () => {
    const cases = [join('t->c', 'nope', 40), join('t->c', 't->c', 40), { ...join('t->c', 'u->b', 40), ...join('u->b', 't->c', 40) }];
    for (const shapes of cases) {
      const wires = setup(steps(), at, new Set<string>(), shapes);
      expect(wires.find((x) => x.id === 't->c')!.joint).toBeUndefined();
    }
    const other = setup([...steps(), step('v', ['x'])], { ...at, v: [288, 800] }, new Set<string>(), join('v->x', 's->b', 40));
    expect(other.find((x) => x.id === 'v->x')!.joint).toBeUndefined();
  });

  it('keeps the contact clear of the host\'s ends', () => {
    const wires = setup(steps(), at, new Set<string>(), join('t->c', 's->b', 0));
    expect(wires.find((x) => x.id === 't->c')!.joint!.contact).toEqual([528, 128]);
  });
});
```

The host `s->b` runs from (512,128) to (864,128): `at` 176 → (688,128); `at` 0 is clamped to 16 → (528,128). If the landing rule lands `s->b` at another height in this fixture, read the actual `host.points` once and adjust the literal y values (128) to it — the assertions' relations stay.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/layout/wires.test.ts`
Expected: FAIL (`joint` undefined).

- [ ] **Step 3: Implement** (`src/layout/wires.ts`)

Add imports:

```ts
import { clearPath } from './detour';
import { CONTACT_MARGIN, inLoop, lengthOf, nearestOn, ownEnds, pointAt, slice } from './junctions';
import { pointsOfShape, type Ends, type WireShape } from './shape';
import { GRID, snap } from './geometry';
```

(merge with the existing `./shape` and `./geometry` imports), add the `Joint` interface above and `joint?: Joint` to `WireRoute` with the doc line "Set when the wire ends on another wire's line (plan 7); `points` is then its own line.".

At the end of `routeWires`, replace `return wires.map(...)` by assigning the array to `const routed = wires.map(...)` and then `return joinWires(routed, input, boxes);`, where:

```ts
/** Second pass (spec §5.2): each joined wire after its host; a contact that is not valid leaves the wire plain. */
function joinWires(routed: WireRoute[], input: WiringInput, boxes: Box[]): WireRoute[] {
  const shapes = input.shapes;
  if (!shapes) return routed;
  const byId = new Map(routed.map((r) => [r.id, r]));
  const hostOf = (id: string) => (Object.hasOwn(shapes, id) ? shapes[id]!.contact?.host ?? undefined : undefined);
  const travel = new Map<string, Pt[]>();
  const done = new Set<string>();
  const resolve = (id: string): void => {
    if (done.has(id)) return;
    done.add(id);
    const r = byId.get(id)!;
    const c = Object.hasOwn(shapes, id) ? shapes[id]!.contact ?? null : null;
    const host = c ? byId.get(c.host) : undefined;
    if (c && host && host.id !== id && host.condition === r.condition && !inLoop(id, hostOf)) {
      resolve(host.id);
      const joined = joinOne(byId.get(id)!, byId.get(host.id)!, travel.get(host.id)!, c.at, shapes[id]!, boxes);
      if (joined) { byId.set(id, joined.route); travel.set(id, joined.travel); return; }
    }
    travel.set(id, r.points);
  };
  for (const r of routed) resolve(r.id);
  return routed.map((r) => byId.get(r.id)!);
}

/** A on host B (spec §5.3); null when B's line is too short to hold a contact. */
function joinOne(r: WireRoute, host: WireRoute, hostTravel: Pt[], at: number, shape: WireShape, boxes: Box[]): { route: WireRoute; travel: Pt[] } | null {
  const drawn = host.joint && host.joint.branch.length > 0 ? [host.points, host.joint.branch] : [host.points];
  const total = lengthOf(drawn);
  if (total < 2 * CONTACT_MARGIN) return null;
  const atC = Math.min(Math.max(snap(at, GRID), CONTACT_MARGIN), total - CONTACT_MARGIN);
  const { p: contact, vertical } = pointAt(drawn, atC);
  const [sx, sy] = r.points[0]!;
  const { ends, tail } = ownEnds(sx, sy, contact, vertical);
  const own = shape.bends && shape.bends.xs.length > 0
    ? simplify(pointsOfShape(ends, shape.bends))
    : clearPath(route(ends.sx, ends.sy, ends.tx, ends.ty, boxIdOf(r.source), '', 0, boxes), boxes);
  const points = simplify([...own, ...tail]);
  // the contact's place on the host's travelled line: on the host's own line it is the same distance; on its branch, from the end
  const ownLen = lengthOf([host.points]), travelLen = lengthOf([hostTravel]);
  const onTravel = !host.joint || atC <= ownLen ? atC : travelLen - lengthOf([host.joint.branch]) + (atC - ownLen);
  const landing = r.points[r.points.length - 1]!;
  if (r.target === host.target) {
    const joint: Joint = { host: host.id, contact, split: null, branch: [], own, ownEnds: ends };
    return { route: { ...r, points, joint }, travel: [...points, ...slice(hostTravel, onTravel, travelLen).slice(1)] };
  }
  const s = nearestOn([hostTravel], landing, onTravel, travelLen - CONTACT_MARGIN);
  const split: Pt = [snap(s.p[0], GRID), snap(s.p[1], GRID)];
  const branch = clearPath(route(split[0], split[1], landing[0], landing[1], '', stepBoxId(r.target), 0, boxes), boxes);
  const joint: Joint = { host: host.id, contact, split, branch, own, ownEnds: ends };
  return { route: { ...r, points, joint }, travel: [...points, ...slice(hostTravel, onTravel, s.at).slice(1), ...branch.slice(1)] };
}
```

`Box` is already imported from `./router` with `route` and `simplify`; add `Box` to the type import if it is not.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/layout`
Expected: PASS (existing wire tests unchanged: a draft without contacts returns `routed` as before).

- [ ] **Step 5: Commit**

```bash
git add src/WorkflowStudio/src/layout/wires.ts src/WorkflowStudio/src/layout/wires.test.ts
git commit -m "feat(studio): joined wires route onto their host's line and split off to their own step (plan 7)"
```

---

### Task 4: Draw joined wires

**Files:**
- Modify: `src/canvas/toFlow.ts:94-99` (edge data)
- Modify: `src/canvas/edges/CableEdge.tsx`
- Modify: `src/design/DesignContext.ts`
- Modify: `src/canvas/art.css` (after line 90)
- Test: `src/canvas/WorkflowCanvas.test.tsx` (or `src/canvas/toFlow.test.ts` for data)

**Interfaces:**
- Consumes: Task 3 `WireRoute.joint`.
- Produces: `CableEdgeData` gains `branch?: Pt[]`, `joints?: Pt[]` (contact first, then split), `halo?: 'ok' | 'no'`. `DesignGestures.wirePointerDown(wireId: string, e: ReactPointerEvent, part?: 'own' | 'branch'): void`. DOM: joined wire's `path.w` (own line) then a second `path.w.branch`; `circle.nx-joint` per dot; `.nx-head` only at the branch end; a `path.nx-hit.branch`.

- [ ] **Step 1: Write the failing test** (append to `src/canvas/WorkflowCanvas.test.tsx`; it renders `WorkflowCanvas` with `loadedDocument` — follow its existing render pattern and imports; add `designOf`-style props as `src/design/useWireGestures.test.tsx` does, with `design={{ draft, picks: [], onPick: vi.fn(), onCommit: vi.fn(), onUndo: vi.fn(), onRedo: vi.fn() }}`)

```ts
it('draws a joined wire as its own line to a dot, a split dot and a branch with the only arrow head (plan 7)', async () => {
  const doc = await loadedDocument(graphDto({
    workflow: workflowDto({ entryStepIds: ['s1', 's3'] }),
    steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2', { entryCondition: 2 }), stepDto('s3', { nextStepIds: ['s4'] }), stepDto('s4', { entryCondition: 2 })],
  }));
  const draft = setShape(EMPTY_DRAFT, 's3->s4', { bends: null, landing: null, contact: { host: 's1->s2', at: 40 } });
  const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} design={{ draft, picks: [], onPick: vi.fn(), onCommit: vi.fn(), onUndo: vi.fn(), onRedo: vi.fn() }} onSelect={vi.fn()} />);
  const edge = container.querySelector('[data-testid="rf__edge-s3->s4"]')!;
  expect(edge.querySelectorAll('circle.nx-joint').length).toBeGreaterThanOrEqual(1);
  expect(edge.querySelectorAll('.nx-head')).toHaveLength(edge.querySelector('path.w.branch') ? 1 : 0);
  expect(edge.querySelectorAll('circle.nx-src')).toHaveLength(1);
  // a plain wire keeps its ring and its arrow head, and no dot
  const plain = container.querySelector('[data-testid="rf__edge-s1->s2"]')!;
  expect(plain.querySelectorAll('circle.nx-joint')).toHaveLength(0);
  expect(plain.querySelectorAll('.nx-head')).toHaveLength(1);
});
```

(Import `setShape`, `EMPTY_DRAFT` from `../design/draft`; `workflowDto` from `../api/fixtures`. If `s1->s2` is too short in this layout to hold a contact the wire is drawn plain and the test fails on the first `nx-joint` expectation: then use `at: 24`.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/canvas/WorkflowCanvas.test.tsx`
Expected: FAIL (no `nx-joint`).

- [ ] **Step 3: Implement**

`toFlow.ts` edge data:

```ts
    data: {
      points: w.points, colour: conditionInfo(w.condition).colour, broken: w.broken, delay: -Math.round(i * 41) / 100 || 0,
      ...(w.joint ? { branch: w.joint.branch, joints: w.joint.split ? [w.joint.contact, w.joint.split] : [w.joint.contact] } : {}),
    },
```

`DesignContext.ts`:

```ts
  /** A press on a wire's hit band; a picked wire's body drags its nearest run (spec §4.2). `part`: which band (plan 7). */
  wirePointerDown(wireId: string, e: ReactPointerEvent, part?: 'own' | 'branch'): void;
```

`CableEdge.tsx` — `CableEdgeData` gains:

```ts
  /** A joined wire's branch, from its split to its landing (plan 7). */
  branch?: Pt[];
  /** A joined wire's filled dots: its contact, then its split. */
  joints?: Pt[];
  /** The line under a dragged wire end: green when it may be joined, red when not (plan 7). */
  halo?: 'ok' | 'no';
```

`CableEdgeView` — replace the destructuring and `trace`:

```tsx
export function CableEdgeView({ points, colour, broken, delay, picked, flowing, branch, joints, halo }: CableEdgeData & { flowing: boolean }) {
  const gap = `nxgap${useId().replace(/[^\w-]/g, '')}`;
  const d = pathOf(points);
  const [sx, sy] = points[0]!;
  // the arrow head goes on the line that enters a step: a plain wire's end, or a joined wire's branch end (spec §3)
  const into = joints ? (branch && branch.length > 1 ? branch : null) : points;
  const tip = into ? into[into.length - 1]! : null;
  const mark = broken ? longestSegmentMiddle(points) : null;

  const trace = (
    <>
      <circle className="nx-src" cx={sx} cy={sy} r={2.6} />
      <path className="w" d={d} stroke={colour} />
      {branch && branch.length > 1 && <path className="w branch" d={pathOf(branch)} stroke={colour} />}
      {tip && <path className="nx-head" d={`M${tip[0] - 9} ${tip[1] - 6}L${tip[0]} ${tip[1]}L${tip[0] - 9} ${tip[1] + 6}`} stroke={colour} />}
      {joints?.map(([x, y], i) => <circle key={i} className="nx-joint" cx={x} cy={y} r={4.5} />)}
    </>
  );
```

and the outer `<g>` class: `` className={`${broken ? 'wire broken' : 'wire'}${picked ? ' picked' : ''}${halo ? ` halo-${halo}` : ''}`} ``. Add a pulse for the branch next to the existing one: `{flowing && !broken && branch && branch.length > 1 && <path className="nx-pulse" d={pathOf(branch)} style={{ animationDelay: `${delay}s` }} />}`.

`CableEdge` — add the branch hit band:

```tsx
      <path className="nx-hit" d={pathOf(data.points)} onPointerDown={gestures ? (e) => gestures.wirePointerDown(id, e, 'own') : undefined} />
      {data.branch && data.branch.length > 1 && (
        <path className="nx-hit branch" d={pathOf(data.branch)} onPointerDown={gestures ? (e) => gestures.wirePointerDown(id, e, 'branch') : undefined} />
      )}
```

`art.css` after `.wire .nx-src`:

```css
/* plan 7: a filled dot where a wire meets another wire's line (its contact, and its split); never at a step */
.wire .nx-joint { fill: var(--nc); stroke: #060c17; stroke-width: 1; filter: drop-shadow(0 0 3px var(--nc)); pointer-events: none; }
/* the line under a dragged wire end: may be joined (green) or not (red) */
.wire.halo-ok path.w { stroke-width: 3; filter: drop-shadow(0 0 4px #34D399) drop-shadow(0 0 8px #34D399); }
.wire.halo-no path.w { stroke-width: 3; filter: drop-shadow(0 0 4px #F87171) drop-shadow(0 0 8px #F87171); }
```

In `useWireGestures.ts`, `wirePointerDown(wireId, e)` becomes `wirePointerDown(wireId, e, part = 'own')` and returns at once when `part === 'branch'` (the branch is automatic: it has no runs to drag).

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/canvas src/design`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/WorkflowStudio/src/canvas src/WorkflowStudio/src/design/DesignContext.ts src/WorkflowStudio/src/design/useWireGestures.ts
git commit -m "feat(studio): draw a joined wire: own line to a filled dot, split dot, branch with the only arrow head (plan 7)"
```

---

### Task 5: The join rule and finding a line under the pointer

**Files:**
- Modify: `src/design/rules.ts`
- Modify: `src/design/hit.ts`
- Test: `src/design/rules.test.ts`, `src/design/hit.test.ts`

**Interfaces:**
- Produces:
  - `export type JoinVerdict = 'ok' | 'colour' | 'sameWire' | 'loop'`
  - `canJoin(shown: StudioDocument, wire: string, host: string): JoinVerdict`
  - `export type Refusal = 'start' | 'needStep'`
  - `dropLabel(verdict: DropVerdict | 'move' | JoinVerdict | Refusal, newWire: boolean, line?: boolean): string` — `line && verdict === 'ok'` → "join here"; 'colour' → "other colour"; 'sameWire' → "same wire"; 'loop' → "would make a loop"; 'start' → "start stays on a block"; 'needStep' → "drop on a step"; existing labels unchanged.
  - `wireAt(doc: StudioDocument, p: Point, tolerance: number, exclude?: string | null): { id: string; at: number } | null` — nearest wire line (own line or branch; `at` along its drawn line) within `tolerance` flow units.

- [ ] **Step 1: Write the failing tests**

`src/design/rules.test.ts` (append; add `applyDraft` from `./apply`, `setShape`/`EMPTY_DRAFT` from `./draft`, `canJoin` to the `./rules` import):

```ts
describe('canJoin (plan 7)', () => {
  const four = () => loadedDocument(graphDto({
    workflow: workflowDto({ entryStepIds: ['s1', 's3'] }),
    steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2', { entryCondition: 2 }), stepDto('s3', { nextStepIds: ['s4', 's5'] }), stepDto('s4', { entryCondition: 2 }), stepDto('s5', { entryCondition: 1 })],
  }));

  it('allows the same colour, refuses another colour and the wire itself', async () => {
    const doc = await four();
    expect(canJoin(doc, 's3->s4', 's1->s2')).toBe('ok');
    expect(canJoin(doc, 's3->s5', 's1->s2')).toBe('colour');
    expect(canJoin(doc, 's1->s2', 's1->s2')).toBe('sameWire');
  });

  it('refuses a join that would loop back through hosts', async () => {
    const saved = await four();
    const doc = applyDraft(saved, setShape(EMPTY_DRAFT, 's1->s2', { bends: null, landing: null, contact: { host: 's3->s4', at: 24 } }));
    expect(canJoin(doc, 's3->s4', 's1->s2')).toBe('loop');
  });

  it('labels each verdict', () => {
    expect(dropLabel('ok', false, true)).toBe('join here');
    expect(dropLabel('colour', false, true)).toBe('other colour');
    expect(dropLabel('sameWire', false, true)).toBe('same wire');
    expect(dropLabel('loop', false, true)).toBe('would make a loop');
    expect(dropLabel('start', false, true)).toBe('start stays on a block');
    expect(dropLabel('needStep', true, true)).toBe('drop on a step');
    expect(dropLabel('ok', false)).toBe('re-attach here');
  });
});
```

`src/design/hit.test.ts` (append; import `wireAt` from `./hit`):

```ts
describe('wireAt (plan 7)', () => {
  it('finds the wire line under a point within the tolerance, with the distance along it', async () => {
    const doc = await loadedDocument(graphDto({ steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')] }));
    const w = doc.wires.find((x) => x.id === 's1->s2')!;
    const [ax, ay] = w.points[0]!;
    const [bx] = w.points[1]!;
    const mid = { x: (ax + bx) / 2, y: ay + 3 };
    expect(wireAt(doc, mid, 6)).toEqual({ id: 's1->s2', at: (bx - ax) / 2 });
    expect(wireAt(doc, { x: mid.x, y: ay + 40 }, 6)).toBeNull();
    expect(wireAt(doc, mid, 6, 's1->s2')).toBeNull();
  });
});
```

(`hit.test.ts` may not yet import `loadedDocument`/`graphDto`/`stepDto`; add them as `rules.test.ts` does. If `s1->s2`'s first run is vertical in this layout, take the first horizontal run instead — the test needs a horizontal run of the wire.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/design/rules.test.ts src/design/hit.test.ts`
Expected: FAIL (not exported).

- [ ] **Step 3: Implement**

`rules.ts` (append; widen `dropLabel`):

```ts
export type JoinVerdict = 'ok' | 'colour' | 'sameWire' | 'loop';
/** Drops a line never takes: a wire's start, and a new wire (it must reach a step first). */
export type Refusal = 'start' | 'needStep';

/** May wire `wire`'s arrow end on `host`'s line (plan 7 §1)? The same colour, not itself, no loop through hosts. */
export function canJoin(shown: StudioDocument, wire: string, host: string): JoinVerdict {
  if (wire === host) return 'sameWire';
  const byId = new Map(shown.wires.map((w) => [w.id, w]));
  const w = byId.get(wire), h = byId.get(host);
  if (!w || !h || w.condition !== h.condition) return 'colour';
  const seen = new Set<string>();
  for (let x = h; x?.joint; x = byId.get(x.joint.host)) {
    if (x.joint.host === wire) return 'loop';
    if (seen.has(x.id)) break;
    seen.add(x.id);
  }
  return 'ok';
}
```

```ts
export function dropLabel(verdict: DropVerdict | 'move' | JoinVerdict | Refusal, newWire: boolean, line = false): string {
  switch (verdict) {
    case 'ok': return line ? 'join here' : newWire ? 'connect here' : 're-attach here';
    case 'move': return 'move contact here';
    case 'cycle': return 'would make a loop';
    case 'loop': return 'would make a loop';
    case 'duplicate': return 'already wired';
    case 'self': return 'same step';
    case 'notStep': return 'not a step';
    case 'colour': return 'other colour';
    case 'sameWire': return 'same wire';
    case 'start': return 'start stays on a block';
    case 'needStep': return 'drop on a step';
  }
}
```

`hit.ts` (append; import `nearestOn` from `../layout/junctions`):

```ts
/** The wire line nearest `p` within `tolerance` (flow units), and how far along its drawn line (own line, then branch); plan 7. */
export function wireAt(doc: StudioDocument, p: Point, tolerance: number, exclude: string | null = null): { id: string; at: number } | null {
  let best: { id: string; at: number; gap: number } | null = null;
  for (const w of doc.wires) {
    if (w.id === exclude) continue;
    const drawn = w.joint && w.joint.branch.length > 1 ? [w.points, w.joint.branch] : [w.points];
    const n = nearestOn(drawn, [p.x, p.y]);
    if (n.gap <= tolerance && (best === null || n.gap < best.gap)) best = { id: w.id, at: n.at, gap: n.gap };
  }
  return best && { id: best.id, at: best.at };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/design`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/WorkflowStudio/src/design/rules.ts src/WorkflowStudio/src/design/rules.test.ts src/WorkflowStudio/src/design/hit.ts src/WorkflowStudio/src/design/hit.test.ts
git commit -m "feat(studio): the join rule and the wire line under the pointer (plan 7)"
```

---

### Task 6: Join by dropping a wire's arrow on a line

**Files:**
- Modify: `src/design/useWireGestures.ts` (`DropHint`, `dropGesture`, `startEnd`, `startNew`)
- Modify: `src/design/DesignOverlay.tsx` (label from the hint)
- Modify: `src/canvas/WorkflowCanvas.tsx` (line halo; node outline only for blocks)
- Test: `src/design/useWireGestures.test.tsx`

**Interfaces:**
- Consumes: Task 5 `canJoin`, `dropLabel`, `wireAt`; Task 1 `setShape` with contact.
- Produces: `DropHint` gains `line: boolean` and `why: DropVerdict | 'move' | JoinVerdict | Refusal`; the overlay's label is `dropLabel(hint.why, hint.newWire, hint.line)`; the canvas sets `halo` on the edge `hint.id` when `hint.line`, and outlines a node only when `!hint.line`.

- [ ] **Step 1: Write the failing tests** (append inside `describe('wire gestures', ...)`; add `workflowDto` to the fixtures import)

```ts
  const joinable = () => loadedDocument(graphDto({
    workflow: workflowDto({ entryStepIds: ['s1', 's3'] }),
    steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2', { entryCondition: 2 }), stepDto('s3', { nextStepIds: ['s4', 's5'] }), stepDto('s4', { entryCondition: 2 }), stepDto('s5', { entryCondition: 1 })],
  }));
  /** A point on a wire's first long horizontal run, in flow coordinates. */
  const onLine = (doc: StudioDocument, id: string): Point => {
    const pts = doc.wires.find((w) => w.id === id)!.points;
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i]!, [bx, by] = pts[i + 1]!;
      if (ay === by && Math.abs(bx - ax) >= 48) return { x: (ax + bx) / 2, y: ay };
    }
    throw new Error(`no horizontal run on ${id}`);
  };

  it('dropping an arrow on a same-colour line joins it: green halo, "join here", one step, the contact written', async () => {
    const doc = await joinable();
    const design = designOf({ picks: [{ kind: 'wire', id: 's3->s4' }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
    const target = onLine(doc, 's1->s2');
    fireEvent.pointerDown(container.querySelector('.design-wire[data-wire="s3->s4"] .design-handle.end[data-end="target"]')!, { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, target), pointerId: 1 });
    expect(container.querySelector('.design-drop-label')!.textContent).toBe('join here');
    expect(container.querySelector('[data-testid="rf__edge-s1->s2"] .wire')!.getAttribute('class')).toContain('halo-ok');
    fireEvent.pointerUp(document, { ...screenOf(container, target), pointerId: 1 });
    expect(design.onCommit).toHaveBeenCalledTimes(1);
    const shape = vi.mocked(design.onCommit).mock.calls[0]![0].routes['s3->s4']!;
    expect(shape.contact!.host).toBe('s1->s2');
    expect(shape.bends).toBeNull();
    // drawing only: the wiring is untouched
    expect(vi.mocked(design.onCommit).mock.calls[0]![0].next).toEqual({});
  });

  it('another colour is refused with a red halo and snaps back', async () => {
    const doc = await joinable();
    const design = designOf({ picks: [{ kind: 'wire', id: 's3->s5' }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
    const target = onLine(doc, 's1->s2');
    fireEvent.pointerDown(container.querySelector('.design-wire[data-wire="s3->s5"] .design-handle.end[data-end="target"]')!, { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, target), pointerId: 1 });
    expect(container.querySelector('.design-drop-label')!.textContent).toBe('other colour');
    expect(container.querySelector('[data-testid="rf__edge-s1->s2"] .wire')!.getAttribute('class')).toContain('halo-no');
    fireEvent.pointerUp(document, { ...screenOf(container, target), pointerId: 1 });
    expect(design.onCommit).not.toHaveBeenCalled();
  });

  it('a start square over a line says "start stays on a block"; a new wire says "drop on a step"', async () => {
    const doc = await joinable();
    const design = designOf({ picks: [{ kind: 'wire', id: 's3->s4' }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
    const target = onLine(doc, 's1->s2');
    fireEvent.pointerDown(container.querySelector('.design-wire[data-wire="s3->s4"] .design-handle.end[data-end="source"]')!, { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, target), pointerId: 1 });
    expect(container.querySelector('.design-drop-label')!.textContent).toBe('start stays on a block');
    fireEvent.pointerUp(document, { ...screenOf(container, target), pointerId: 1 });
    fireEvent.pointerDown(container.querySelector('.react-flow__node[data-id="s3"] .nx-port')!, { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, target), pointerId: 1 });
    expect(container.querySelector('.design-drop-label')!.textContent).toBe('drop on a step');
    fireEvent.pointerUp(document, { ...screenOf(container, target), pointerId: 1 });
    expect(design.onCommit).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/design/useWireGestures.test.tsx`
Expected: the three new tests FAIL (no label over a line).

- [ ] **Step 3: Implement**

`useWireGestures.ts`:
1. Add `const DROP_REACH = 8;` next to `MOVE_START`, doc line: "How far outside a block's border or a line (screen px) a dragged end already counts as over it." Imports: `canJoin, type JoinVerdict, type Refusal` from `./rules`; `wireAt` from `./hit`; `getZoom` from the existing `useReactFlow()` call (`const { screenToFlowPosition, getZoom } = useReactFlow();`).
2. `DropHint`:

```ts
export interface DropHint {
  /** The block (node id) or, when `line`, the wire under the pointer. */
  id: string;
  /** Over a wire's line, not a block (plan 7). */
  line: boolean;
  ok: boolean;
  /** 'move': a wire end back on its own step slides its contact point there. */
  why: DropVerdict | 'move' | JoinVerdict | Refusal;
  /** A new wire, not a re-attached end: an allowed drop says "connect here". */
  newWire: boolean;
  /** The pointer, in flow coordinates. */
  at: Point;
}
```

Every existing `setHint({ ... })` call gains `line: false`.

3. `dropGesture` gets an options object (replace its signature and body):

```ts
  interface LineDrop {
    /** May the wire join this host? */
    verdict: (host: string) => JoinVerdict;
    /** The draft while hovering an allowed line: the wire drawn joined there. */
    preview: (host: string, at: number) => Draft;
    done: (host: string, at: number) => void;
  }

  const dropGesture = (e: ReactPointerEvent, o: {
    wire: string | null; path: (p: Point) => Pt[]; current: string | null; verdict: (over: string) => DropVerdict;
    done: (over: string, p: Point) => void; onSelf?: (p: Point) => void;
    /** What a line under the pointer does: joins (`LineDrop`) or refuses with a reason. */
    line: LineDrop | Refusal;
  }) => {
    let over: string | null = null;
    let onLine: { id: string; at: number } | null = null;
    let at: Point = { x: 0, y: 0 };
    const newWire = o.wire === null;
    const ghost = (p: Point) => setGhost({ wire: o.wire, points: o.path({ x: snap(p.x), y: snap(p.y) }) });
    run(e, (p) => {
      at = p;
      over = blockAt(shown.current, p);
      onLine = over === null ? wireAt(shown.current, p, DROP_REACH / getZoom(), o.wire) : null;
      if (onLine && typeof o.line !== 'string') {
        const why = o.line.verdict(onLine.id);
        setHint({ id: onLine.id, line: true, ok: why === 'ok', why, newWire, at: p });
        if (why === 'ok') { setGhost(null); setPreview(o.line.preview(onLine.id, onLine.at)); return; }
      } else if (onLine) setHint({ id: onLine.id, line: true, ok: false, why: o.line as Refusal, newWire, at: p });
      else if (over === null || (over === o.current && !o.onSelf)) setHint(null);
      else if (over === o.current) setHint({ id: over, line: false, ok: true, why: 'move', newWire, at: p });
      else { const why = o.verdict(over); setHint({ id: over, line: false, ok: why === 'ok', why, newWire, at: p }); }
      setPreview(null);
      ghost(p);
    }, (cancelled) => {
      setGhost(null);
      setHint(null);
      setPreview(null);
      if (cancelled) return;
      if (onLine && typeof o.line !== 'string') { if (o.line.verdict(onLine.id) === 'ok') o.line.done(onLine.id, onLine.at); return; }
      if (over === null) return;
      if (over === o.current) { o.onSelf?.(at); return; }
      if (o.verdict(over) !== 'ok') return;
      o.done(over, at);
    });
  };
```

`wireAt` is called on `shown.current` excluding the dragged wire (`o.wire`), so the moving wire itself is never the drop target (Review Focus 4). While an allowed line is hovered, `shown.current` is the preview: `wireAt` still finds the host because only the dragged wire changed.

4. `startEnd` passes the options object. Keep its existing `path`, `landingAt`, verdict, done and onSelf, and add for the target end:

```ts
      line: end === 'target' ? {
        verdict: (host) => canJoin(shown.current, wire.id, host),
        preview: (host, at) => setShape(base, wire.id, { bends: null, landing: base.routes[wire.id]?.landing ?? null, contact: { host, at: snap(at) } }),
        done: (host, at) => d.onCommit(setShape(base, wire.id, { bends: null, landing: base.routes[wire.id]?.landing ?? null, contact: { host, at: snap(at) } }), { picks: [{ kind: 'wire', id: wire.id }] }),
      } : 'start',
```

with `const base = d.draft;` captured at the start of `startEnd`. `startNew` passes `line: 'needStep'`.

`DesignOverlay.tsx`: `const label = hint ? dropLabel(hint.why, hint.newWire, hint.line) : null;`

`WorkflowCanvas.tsx`:
- `const shown = useMemo(() => withHint(selected, wiring.hint && !wiring.hint.line ? wiring.hint : null), [selected, wiring.hint]);`
- in the `edges` memo, after the dragged-wire override, set the halo:

```ts
  const edges = useMemo(() => marked.edges.map((e) => {
    if (e.type !== 'cable' || !e.data) return e;
    let data = e.data;
    if (dragged && e.id === dragged.id) data = { ...data, points: dragged.points };
    if (wiring.hint?.line && e.id === wiring.hint.id) data = { ...data, halo: wiring.hint.ok ? 'ok' : 'no' };
    return data === e.data ? e : { ...e, data };
  }), [marked.edges, wiring.ghost, wiring.hint]);
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/design src/canvas`
Expected: PASS (all earlier gesture tests too).

- [ ] **Step 5: Commit**

```bash
git add src/WorkflowStudio/src/design src/WorkflowStudio/src/canvas/WorkflowCanvas.tsx
git commit -m "feat(studio): drop a wire's arrow on a same-colour line to join it; refusals say why (plan 7)"
```

---

### Task 6b: The same drop feedback for head, tail and junction (user, 2026-10-07)

The user: "when the dragged wire reaches a potential contact point, from the head or tail direction, to a step it
should notify, so the designer knows he can drop. This happens only to the head; it should be consistent for
tail, head and junction." A Playwright probe on the deployed studio (2026-10-07) showed: the tail over its own
source step gets no outline and no label (the head over its own step gets green "move contact here"); and a
block counts only once the pointer is inside its rectangle, while a line counts from a few px away.

**Files:**
- Modify: `src/design/hit.ts` (`blockAt` reach)
- Modify: `src/design/useWireGestures.ts` (`freeEnd` reach, `dropGesture` self label, `startEnd` source)
- Modify: `src/design/rules.ts` (label "starts here")
- Modify: `e2e/designer.spec.ts` (one Playwright test, run in Task 8)
- Test: `src/design/hit.test.ts`, `src/design/useWireGestures.test.tsx`, `src/design/rules.test.ts`

**Interfaces:**
- Consumes: Task 6 `dropGesture(e, options)`, `DROP_REACH`.
- Produces: `blockAt(doc, p, reach = 0)` (each step box grown by `reach` on every side; the hub's radius + `reach`); `freeEnd(p, end, boxes, reach = 0)`; `dropGesture` option `selfWhy?: 'move' | 'here'` (default 'move'); `DropHint.why` gains `'here'`; `dropLabel('here', ...)` returns "starts here".

- [ ] **Step 1: Write the failing tests**

`src/design/hit.test.ts` (append; import `SPHERE_R` from `../layout/geometry` and the fixtures if missing):

```ts
describe('blockAt reach (plan 7, one drop reach)', () => {
  it('counts a point just outside a step or the hub only with a reach', async () => {
    const doc = await loadedDocument(graphDto({ steps: [stepDto('s1'), stepDto('s2')] }));
    const s1 = doc.placement.steps.get('s1')!;
    const left = { x: s1.x - 5, y: s1.y + 40 };
    expect(blockAt(doc, left)).toBeNull();
    expect(blockAt(doc, left, 8)).toBe('s1');
    const { cx, cy } = doc.placement.sphere;
    expect(blockAt(doc, { x: cx + SPHERE_R + 5, y: cy })).toBeNull();
    expect(blockAt(doc, { x: cx + SPHERE_R + 5, y: cy }, 8)).toBe('wf');
  });
});
```

`src/design/rules.test.ts` (append inside `describe('canJoin (plan 7)', ...)`):

```ts
  it('labels the tail on its own step', () => expect(dropLabel('here', false)).toBe('starts here'));
```

`src/design/useWireGestures.test.tsx` (append inside `describe('wire gestures', ...)`):

```ts
  it('the tail over its own step says "starts here" in green, and dropping there changes nothing', async () => {
    const doc = await three();
    const design = designOf({ picks: [{ kind: 'wire', id: 's1->s2' }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
    fireEvent.pointerDown(container.querySelector('.design-handle.end[data-end="source"]')!, { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, middleOf(doc, 's1')), pointerId: 1 });
    expect(container.querySelector('.design-drop-label')!.textContent).toBe('starts here');
    expect(nodeClass(container, 's1')).toContain('drop-ok');
    fireEvent.pointerUp(document, { ...screenOf(container, middleOf(doc, 's1')), pointerId: 1 });
    expect(design.onCommit).not.toHaveBeenCalled();
  });

  it('an end reaching a step border from outside is already over it: the head 5 px left of a step re-attaches there', async () => {
    const doc = await three();
    const design = designOf({ picks: [{ kind: 'wire', id: 's1->s2' }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
    const s3 = doc.placement.steps.get('s3')!;
    const near = { x: s3.x - 5, y: s3.y + 96 };
    fireEvent.pointerDown(container.querySelector('.design-handle.end[data-end="target"]')!, { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, near), pointerId: 1 });
    expect(container.querySelector('.design-drop-label')!.textContent).toBe('re-attach here');
    expect(nodeClass(container, 's3')).toContain('drop-ok');
    fireEvent.pointerUp(document, { ...screenOf(container, near), pointerId: 1 });
    expect(vi.mocked(design.onCommit).mock.calls[0]![1]).toEqual({ picks: [{ kind: 'wire', id: 's1->s3' }] });
  });
```

`e2e/designer.spec.ts` (append; it runs in Task 8):

```ts
test('a dragged tail over its own step is told "starts here"; a head 5 px short of a step border is already over it', async ({ page }) => {
  const panel = await open(page);
  const { a, b, c } = chain!;
  const id = `${a}->${b}`;
  await zoomInOn(page, panel, id);
  let p = await pointOnWire(panel, id);
  await page.mouse.click(p.x, p.y);
  const tail = await centreOf(panel.locator(`.design-wire[data-wire="${id}"] .design-handle.end[data-end="source"]`));
  const own = await centreOf(node(panel, a).locator('.nx-sn'));
  await page.mouse.move(tail.x, tail.y);
  await page.mouse.down();
  await page.mouse.move(own.x, own.y, { steps: 8 });
  await expect(panel.locator('.design-drop-label')).toHaveText('starts here');
  await expect(node(panel, a)).toHaveClass(/drop-ok/);
  await page.mouse.up();
  await expect(page.getByText('● design draft')).toHaveCount(0);
  p = await pointOnWire(panel, id);
  await page.mouse.click(p.x, p.y);
  const head = await centreOf(panel.locator(`.design-wire[data-wire="${id}"] .design-handle.end[data-end="target"]`));
  const cb = (await node(panel, c).boundingBox())!;
  await page.mouse.move(head.x, head.y);
  await page.mouse.down();
  await page.mouse.move(cb.x - 5, cb.y + cb.height / 2, { steps: 8 });
  await expect(node(panel, c)).toHaveClass(/drop-(ok|no)/);
  await expect(panel.locator('.design-drop-label')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await page.mouse.up();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/design`
Expected: the four new unit tests FAIL.

- [ ] **Step 3: Implement**

`hit.ts`, `blockAt`:

```ts
/** The step or the hub under a point (a wire end may be dropped on them), or null; `reach` grows each block on every side. */
export function blockAt(doc: StudioDocument, p: Point, reach = 0): string | null {
  for (const [id, at] of doc.placement.steps) {
    if (p.x >= at.x - reach && p.x <= at.x + STEP_W + reach && p.y >= at.y - reach && p.y <= at.y + STEP_H + reach) return id;
  }
  const { cx, cy } = doc.placement.sphere;
  return Math.hypot(p.x - cx, p.y - cy) <= SPHERE_R + reach ? SPHERE_NODE_ID : null;
}
```

`useWireGestures.ts`:
- `freeEnd(p, end, boxes, reach = 0)`: its box test becomes `p.x >= x.x - reach && p.x <= x.x + x.w + reach && p.y >= x.y - reach && p.y <= x.y + x.h + reach`.
- In `dropGesture`: `over = blockAt(shown.current, p, DROP_REACH / getZoom());`. Every `path` given by `startEnd`, `startNew` (and in Task 7 `startArrow`) calls `freeEnd(p, ..., boxes, DROP_REACH / getZoom())`.
- `dropGesture` option `selfWhy?: 'move' | 'here'`; the own-block hint becomes `setHint({ id: over, line: false, ok: true, why: o.selfWhy ?? 'move', newWire, at: p })`.
- `startEnd` for the source end passes `onSelf: () => {}` and `selfWhy: 'here'` (the start is fixed to its step's output port, so dropping it back changes nothing).

`rules.ts`: `dropLabel` accepts `'here'` (`case 'here': return 'starts here';`); its parameter type and `DropHint.why` become `DropVerdict | 'move' | 'here' | JoinVerdict | Refusal`.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/design src/canvas`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/WorkflowStudio/src/design src/WorkflowStudio/e2e/designer.spec.ts
git commit -m "feat(studio): every dragged end is told where it may drop, from 8 px out; the tail on its own step says starts here (plan 7)"
```

---

### Task 7: The joined wire's handles

**Files:**
- Modify: `src/design/DesignOverlay.tsx`
- Modify: `src/design/useWireGestures.ts` (`startSegment`, `startEnd`, new `startArrow`, `wirePointerDown`)
- Modify: `src/canvas/WorkflowCanvas.tsx` (`bendsOf`, ghost on the branch, `onEnd`)
- Modify: `src/canvas/canvas.css`
- Test: `src/design/useWireGestures.test.tsx`

**Interfaces:**
- Consumes: Task 3 `Joint` (`own`, `ownEnds`, `branch`, `contact`), Task 6 `dropGesture` options.
- Produces: overlay handles for a joined wire: `.design-handle.end[data-end="source"]`, `.design-handle.end.contact[data-end="target"]` (on the contact dot), `.design-handle.end[data-end="arrow"]` (branch end, only with a branch), run squares of the own line except its last run. `onEnd(wire, end: 'source' | 'target' | 'arrow', e)`. `WireGhost.part?: 'branch'`. Gesture cursor `resize: 'ns' | 'ew' | 'move' | null`.

- [ ] **Step 1: Write the failing tests** (append inside `describe('wire gestures', ...)`, reusing `joinable` and `onLine` from Task 6)

```ts
  const joined = () => setShape(EMPTY_DRAFT, 's3->s4', { bends: null, landing: null, contact: { host: 's1->s2', at: 40 } });

  it('a picked joined wire shows a start square, a contact square with the four-way cursor, an arrow square, and no square on its last run', async () => {
    const doc = await joinable();
    const design = designOf({ draft: joined(), picks: [{ kind: 'wire', id: 's3->s4' }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
    const g = container.querySelector('.design-wire[data-wire="s3->s4"]')!;
    expect(g.querySelector('.design-handle.end[data-end="source"]')).not.toBeNull();
    expect(g.querySelector('.design-handle.end.contact[data-end="target"]')).not.toBeNull();
    expect(g.querySelector('.design-handle.end[data-end="arrow"]')).not.toBeNull();
    fireEvent.pointerDown(g.querySelector('.design-handle.contact')!, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
    expect(container.querySelector('.studio-canvas')!.classList.contains('gesture-move')).toBe(true);
    fireEvent.pointerUp(document, { clientX: 0, clientY: 0, pointerId: 1 });
  });

  it('the contact square slides along its host, and dropped on its own step makes the wire plain', async () => {
    const doc = await joinable();
    const design = designOf({ draft: joined(), picks: [{ kind: 'wire', id: 's3->s4' }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
    const contact = () => container.querySelector('.design-wire[data-wire="s3->s4"] .design-handle.contact')!;
    const along = onLine(doc, 's1->s2');
    fireEvent.pointerDown(contact(), { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, along), pointerId: 1 });
    fireEvent.pointerUp(document, { ...screenOf(container, along), pointerId: 1 });
    const slid = vi.mocked(design.onCommit).mock.calls[0]![0].routes['s3->s4']!;
    expect(slid.contact!.host).toBe('s1->s2');
    expect(slid.contact!.at).not.toBe(40);
    fireEvent.pointerDown(contact(), { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, middleOf(doc, 's4')), pointerId: 1 });
    fireEvent.pointerUp(document, { ...screenOf(container, middleOf(doc, 's4')), pointerId: 1 });
    const plain = vi.mocked(design.onCommit).mock.calls[1]![0].routes['s3->s4'];
    expect(plain?.contact ?? null).toBeNull();
  });

  it('a run drag on a joined wire\'s own line keeps its contact', async () => {
    const doc = await joinable();
    const design = designOf({ draft: joined(), picks: [{ kind: 'wire', id: 's3->s4' }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
    const run = container.querySelector('.design-wire[data-wire="s3->s4"] .design-handle.seg')!;
    fireEvent.pointerDown(run, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(document, { clientX: 140, clientY: 140, pointerId: 1 });
    fireEvent.pointerUp(document, { clientX: 140, clientY: 140, pointerId: 1 });
    expect(vi.mocked(design.onCommit).mock.calls[0]![0].routes['s3->s4']!.contact).toEqual({ host: 's1->s2', at: 40 });
  });

  it('Reset route removes the junction', async () => {
    const doc = await joinable();
    const design = designOf({ draft: joined(), picks: [{ kind: 'wire', id: 's3->s4' }] });
    render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
    expect(resetRoute(joined(), 's3->s4').routes['s3->s4']).toBeUndefined();
  });
```

(Add `resetRoute` to the `./draft` import. If `s3->s4`'s own line in this layout is too short to show a run square, give the draft shape `bends` that make one: `{ xs: [s3.x + STEP_W + 16, s3.x + STEP_W + 48], ys: [s3.y + STEP_H + 48] }` with `s3 = doc.placement.steps.get('s3')!`.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/design/useWireGestures.test.tsx`
Expected: FAIL (no contact/arrow squares).

- [ ] **Step 3: Implement**

`DesignOverlay.tsx` — props: `onEnd: (wire: WireRoute, end: 'source' | 'target' | 'arrow', e: ReactPointerEvent) => void;`. In the wire map:

```tsx
          const ends = endsOf(w.points);
          const shapeEnds = w.joint?.ownEnds ?? ends;
          const bends = bendsOf(w);
          // a joined wire's last own run ends on its host: its height is the contact's, so it has no square
          const last = 2 * bends.xs.length;
          const arrow = w.joint && w.joint.branch.length > 1 ? w.joint.branch[w.joint.branch.length - 1]! : null;
          const sq = (x: number, y: number) => ({ x: x - (SQUARE / 2) * k, y: y - (SQUARE / 2) * k, width: SQUARE * k, height: SQUARE * k, strokeWidth: LINE * k });
          return (
            <g key={w.id} className="design-wire" data-wire={w.id}>
              {segmentHandles(shapeEnds, bends).filter((h) => !(w.joint && h.k === last) && clearOfEnds(h, ends, k)).map((h) => (
                <rect key={`s${h.k}`} className={h.vertical ? 'design-handle seg v' : 'design-handle seg h'} data-k={h.k} {...sq(h.x, h.y)}
                  onPointerDown={(e) => onSegment(w, h.k, e)} />
              ))}
              <rect className="design-handle end" data-end="source" {...sq(ends.sx, ends.sy)} onPointerDown={(e) => onEnd(w, 'source', e)} />
              <rect className={w.joint ? 'design-handle end contact' : 'design-handle end'} data-end="target" {...sq(ends.tx, ends.ty)} onPointerDown={(e) => onEnd(w, 'target', e)} />
              {arrow && <rect className="design-handle end" data-end="arrow" {...sq(arrow[0], arrow[1])} onPointerDown={(e) => onEnd(w, 'arrow', e)} />}
            </g>
          );
```

`canvas.css`:

```css
/* plan 7: a joined wire's contact square moves its contact along any same-colour line (four-way arrow) */
.design-handle.end.contact { cursor: move; }
.studio-canvas.gesture.gesture-move, .studio-canvas.gesture.gesture-move * { cursor: move !important; }
```

`useWireGestures.ts`:
- `resize` state type `'ns' | 'ew' | 'move' | null`.
- `WireGhost` gains `part?: 'branch'` ("the dragged arrow of a joined wire moves its branch, not its own line").
- `startSegment`: use the joined wire's own line:

```ts
    const ends = wire.joint?.ownEnds ?? endsOf(wire.points);
    const bends: Bends = existing?.bends ?? shapeFromPoints(wire.joint?.own ?? wire.points);
    // a joined wire's last own run ends on its host: it does not slide a landing
    if (wire.joint && k === 2 * bends.xs.length) return;
    const contact = existing?.contact ?? null;
```

and every `latest = { bends, landing }` / `setShape(base, wire.id, latest)` / commit includes `contact`: `latest = { ..., contact }` (declare `let latest: WireShape = { bends: existing?.bends ?? null, landing: existing?.landing ?? null, contact }`; the commit line becomes `const next = setShape(base, wire.id, { bends: tidy, landing: latest.landing, contact });`). Import `WireShape` from `../layout/shape`.
- `wirePointerDown`: `const bends = d.draft.routes[wireId]?.bends ?? shapeFromPoints(wire.joint?.own ?? wire.points);` and `nearestSegment(wire.joint?.ownEnds ?? endsOf(wire.points), bends, flowPointOf(e))`.
- `startEnd`: `setResize(wire.joint && end === 'target' ? 'move' : 'ew');`. For a joined wire's target end (the contact square), `onSelf` makes it plain: replace the `onSelf` body's commit with

```ts
        if (wire.joint) { d.onCommit(setShape(base, wire.id, { bends: null, landing, contact: null }), { picks: [{ kind: 'wire', id: wire.id }] }); return; }
```

placed before the "same height" check.
- New `startArrow` (the branch's arrow square), exported through the hook's return and wired as `onEnd(w, 'arrow', e)`:

```ts
  /** Drags a joined wire's arrow (its branch end) to another step: re-attached, its contact kept (plan 7 §6.2). */
  const startArrow = (wire: WireRoute, e: ReactPointerEvent) => {
    const d = designRef.current;
    if (!d || e.button !== 0 || !wire.joint?.split) return;
    const base = d.draft;
    const shape = base.routes[wire.id];
    const [sx, sy] = wire.joint.split;
    const boxes = blockBoxes(shown.current.placement);
    const landingAt = (step: string, p: Point) => clampLanding(p.y - (shown.current.placement.steps.get(step)?.y ?? 0));
    setResize('ew');
    dropGesture(e, {
      wire: wire.id,
      path: (p) => { const f = freeEnd(p, 'target', boxes); return clearPath(route(sx, sy, f.x, f.y, '', f.box, 0, boxes), boxes); },
      current: wire.target,
      verdict: (over) => canWire(shown.current, wire.source, over, wire.id),
      done: (over, p) => {
        const id = wireId(wire.source, over);
        const next = reattach(base, saved, wire.id, 'target', over);
        d.onCommit(setShape(next, id, { bends: shape?.bends ?? null, landing: landingAt(over, p), contact: shape?.contact ?? null }), { picks: [{ kind: 'wire', id }] });
      },
      onSelf: (p) => d.onCommit(setShape(base, wire.id, { bends: shape?.bends ?? null, landing: landingAt(wire.target, p), contact: shape?.contact ?? null }), { picks: [{ kind: 'wire', id: wire.id }] }),
      line: 'needStep',
      part: 'branch',
    });
  };
```

`dropGesture`'s options gain `part?: 'branch'`, copied into its ghost: `setGhost({ wire: o.wire, part: o.part, points: ... })`.

`WorkflowCanvas.tsx`:
- `onEnd={(w, end, e) => (end === 'arrow' ? wiring.startArrow(w, e) : wiring.startEnd(w, end, e))}`.
- `dragged` keeps `part`: `const dragged = wiring.ghost?.wire ? { id: wiring.ghost.wire, part: wiring.ghost.part, points: wiring.ghost.points } : null;` and the edge override writes `branch` when `dragged.part === 'branch'`, else `points`. In `pickedWires`, override `joint.branch` for the branch part, `points` otherwise.
- `bendsOf`: `(preview ?? design?.draft)?.routes[w.id]?.bends ?? shapeFromPoints(w.joint?.own ?? w.points)` (the dragged-wire case unchanged).

- [ ] **Step 4: Run to verify they pass**

Run: `npx tsc -b; npx vitest run` (from PowerShell in `src/WorkflowStudio`; then delete `tsconfig.tsbuildinfo`)
Expected: type check clean; all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/WorkflowStudio/src/design src/WorkflowStudio/src/canvas
git commit -m "feat(studio): a joined wire's contact square (four-way), arrow square and own-line runs (plan 7)"
```

---

### Task 8: Playwright with real drags, deploy, verify on the deployed studio

**Files:**
- Modify: `e2e/designer.spec.ts`

**Interfaces:**
- Consumes: everything above; e2e helpers already in `designer.spec.ts` (`pointOnWire`, `centreOf`, `blocksCrossed`, `node`, `wire`, `pathOf`, `zoomInOn`).

- [ ] **Step 1: Write the e2e tests** (append to `e2e/designer.spec.ts`)

```ts
/** Two wires whose targets share an entry condition (A, B: A may join B) and one of another colour (C), on one live workflow. */
async function findJoin(request: APIRequestContext): Promise<{ workflow: LiveWorkflow; a: string; b: string; c: string | null } | null> {
  for (const workflow of await workflowsWithSteps(request)) {
    const g = (await (await request.get(`/api/v1/workflows/${workflow.id}/graph`)).json()) as { steps: { id: string; nextStepIds: string[]; entryCondition: number }[] };
    const cond = new Map(g.steps.map((s) => [s.id, s.entryCondition]));
    const wires = g.steps.flatMap((s) => s.nextStepIds.filter((t) => cond.has(t)).map((t) => ({ id: `${s.id}->${t}`, target: t, colour: cond.get(t)! })));
    for (const a of wires) for (const b of wires) {
      if (a.id === b.id || a.colour !== b.colour || a.target === b.target) continue;
      const c = wires.find((w) => w.colour !== a.colour)?.id ?? null;
      return { workflow, a: a.id, b: b.id, c };
    }
  }
  return null;
}

test('a wire\'s arrow dropped on a same-colour line joins it: a dot on the line, its branch lands on its own step, nothing inside a block; refresh keeps it; undo removes it', async ({ page, request }) => {
  const j = await findJoin(request);
  test.skip(j === null, 'no two same-colour wires into different steps');
  await openWorkflow(page, j!.workflow);
  const panel = documentPanel(page, j!.workflow);
  await zoomInOn(page, panel, j!.b);
  const p = await pointOnWire(panel, j!.a);
  await page.mouse.click(p.x, p.y);
  const head = await centreOf(panel.locator(`.design-wire[data-wire="${j!.a}"] .design-handle.end[data-end="target"]`));
  const on = await pointOnWire(panel, j!.b);
  await page.mouse.move(head.x, head.y);
  await page.mouse.down();
  await page.mouse.move(on.x, on.y, { steps: 10 });
  await expect(panel.locator('.design-drop-label')).toHaveText('join here');
  await page.mouse.up();
  const edge = wire(panel, j!.a);
  await expect(edge.locator('circle.nx-joint').first()).toBeVisible();
  // the contact dot lies on the host's line
  const dot = await centreOf(edge.locator('circle.nx-joint').first());
  const near = await wire(panel, j!.b).locator('path.w').first().evaluate((el, q) => {
    const path = el as SVGPathElement; const m = path.getScreenCTM()!; const len = path.getTotalLength();
    let best = Infinity;
    for (let s = 0; s <= len; s += 1) { const pt = path.getPointAtLength(s); best = Math.min(best, Math.hypot(pt.x * m.a + pt.y * m.c + m.e - q.x, pt.x * m.b + pt.y * m.d + m.f - q.y)); }
    return best;
  }, dot);
  expect(near).toBeLessThan(3);
  // its arrow head lands on its own step's left side
  const target = j!.a.split('->')[1]!;
  const tb = (await node(panel, target).boundingBox())!;
  const tip = await edge.locator('.nx-head').boundingBox();
  expect(tip).not.toBeNull();
  expect(Math.abs(tip!.x + tip!.width - tb.x)).toBeLessThan(6);
  expect(await blocksCrossed(panel, j!.a)).toEqual([]);
  await expect(page.getByText('● design draft')).toBeVisible();
  await page.reload();
  const again = documentPanel(page, j!.workflow);
  await expect(wire(again, j!.a).locator('circle.nx-joint').first()).toBeVisible();
  await again.locator('.studio-canvas').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+z');
  await expect(wire(again, j!.a).locator('circle.nx-joint')).toHaveCount(0);
});

test('a wire\'s arrow over a line of another colour is refused and snaps back', async ({ page, request }) => {
  const j = await findJoin(request);
  test.skip(j === null || j.c === null, 'no wire of another colour');
  await openWorkflow(page, j!.workflow);
  const panel = documentPanel(page, j!.workflow);
  const before = await pathOf(panel, j!.c!);
  const p = await pointOnWire(panel, j!.c!);
  await page.mouse.click(p.x, p.y);
  const head = await centreOf(panel.locator(`.design-wire[data-wire="${j!.c}"] .design-handle.end[data-end="target"]`));
  const on = await pointOnWire(panel, j!.b);
  await page.mouse.move(head.x, head.y);
  await page.mouse.down();
  await page.mouse.move(on.x, on.y, { steps: 10 });
  await expect(panel.locator('.design-drop-label')).toHaveText('other colour');
  await page.mouse.up();
  expect(await pathOf(panel, j!.c!)).toBe(before);
  await expect(wire(panel, j!.c!).locator('circle.nx-joint')).toHaveCount(0);
});
```

Add `openWorkflow`, `workflowsWithSteps`, `type LiveWorkflow` to the `./studio` import if missing (they are imported already by this file's chain helper). If `pointOnWire(panel, b)` lands within 16 px of either end of B, the contact is clamped (still on B's line): the assertions hold.

- [ ] **Step 2: Run on the dev server**

Run (PowerShell, `src/WorkflowStudio`; BaseApi port-forward `localhost:18080` must be up): `npx playwright test e2e/designer.spec.ts`
Expected: all designer tests PASS (14).

- [ ] **Step 3: Fix any failure at its root (systematic-debugging), then run the whole suite**

Run: `npx tsc -b; npx vitest run; npx playwright test`
Expected: clean; all unit tests PASS; Playwright all passed plus the 2 expected `art.spec.ts` skips.

- [ ] **Step 4: Commit, deploy, verify on the deployed studio**

```bash
git add src/WorkflowStudio/e2e/designer.spec.ts
git commit -m "test(studio): Playwright joins a wire onto a same-colour line and refuses another colour (plan 7)"
```

Deploy (PowerShell, repo root):

```powershell
docker build -f src/WorkflowStudio/Dockerfile -t workflow-studio:local .
kind load docker-image workflow-studio:local --name desktop
kubectl -n skp rollout restart deploy/workflow-studio
kubectl -n skp rollout status deploy/workflow-studio --timeout=180s
```

Restart the studio port-forward (`kubectl port-forward -n skp svc/workflow-studio 18081:8080`, detached), then run the designer tests against the deployed studio with a temporary config (not committed) whose `use.baseURL` is `http://localhost:18081` and which has no `webServer`:

Run: `npx playwright test --config playwright.deployed.tmp.config.ts e2e/designer.spec.ts`
Expected: all PASS. Delete the temporary config afterwards.

- [ ] **Step 5: Update the handover**

Add a "Built: plan 7 junctions" section to `docs/HANDOVER-2026-10-07-skp-studio-plan4-trial.md` with the commit range, the bundle name and the test counts; commit it.
