# SKP Studio plan 9: wires as a circuit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The designer's wires follow one model, the electric circuit of the plan 9 spec: every wire has a tail and a head, each end is on a terminal (a step's output or input side, the hub's ring), on another wire (a junction), or open; colour is the family of the wire's net; Save derives `nextStepIds` / `entryStepIds` by tracing the current.

**Architecture:** A pure circuit layer (`src/circuit/`: the model, the tracer, the families) replaces the plan 7 junction routes and the plan 8 loose-wire records. The draft holds the whole circuit (`Draft.wires`), and its `next` / `entries` become lists derived from it. `layout/circuitRoute.ts` draws every wire from its ends (hub ring contacts, step side slides, junction contacts, open points) and gives it its family, solid/dashed state and end kinds. One end-drag gesture judges every drop with `design/drop.ts` (connect / join / move, or a red refusal), and `design/settle.ts` makes stored designs, plan 7/8 layouts and sessions agree with the workflow BaseApi loaded. Save writes the derived lists and the circuit in the layout (`v: 2`), and reports short circuits.

**Tech Stack:** React 19, @xyflow/react 12, TypeScript 5.9, Vitest + Testing Library (jsdom), Playwright (Chromium). Studio only, in `src/WorkflowStudio`.

**Spec:** `docs/superpowers/specs/2026-10-08-skp-studio-09-wire-circuit-design.md` (read it first; it wins over this plan on behaviour). Parents where it refers to them: `2026-10-07-skp-studio-04-canvas-designer-design.md` §4.2-§4.6, `2026-10-07-skp-studio-07-junctions-design.md` §5-§6, `2026-10-07-skp-studio-08-virtual-design-design.md` §5. Context: `docs/HANDOVER-2026-10-08-skp-studio-plan8.md`.

## Decisions made in this plan

The spec leaves these open; each is decided here and should be shown to the user.

1. **One model replaces the special cases.** `LooseEnd` / `LooseStart` / `LooseBoth`, `draft.loose`, `draft.routes` (shapes and plan 7 `contact`s), `Joint` (contact, split dot, branch), `routeLoose`, `canWire` / `canJoin` and the eight loose-wire draft operations are deleted. A wire is `{ tail: End, head: End, bends? }`; `End` is `{ on: 'step', step, y }` | `{ on: 'hub', angle }` | `{ on: 'wire', host, at }` | `{ on: 'open', x, y }`. Old sessions and stored layouts still read: `legacyCircuit` turns plan 7/8 records into wires (a shaped wire `s->t` keeps its id, bends, slid landing and head junction; a loose record `k` becomes wire `w:k`), and settling (decision 6) makes them whole.
2. **The draft keeps the whole circuit.** `Draft.wires: Circuit | null` (null: the saved workflow's own wires, automatic). `Draft.next` / `Draft.entries` stay, but every circuit commit derives them (`withCircuit`): the lists the current gives, kept only where they differ from the saved workflow's. Plan 8's Save, dirty mark, session and "stored design not applied" checks keep working on them.
3. **A wire keeps its id for life.** Wires from the workflow's lists are `source->target`; a drawn one is `w:{guid}`. Moving either end never renames a wire (plan 4/7 renamed a re-attached wire to its new `source->target` and re-pointed its joined wires; that is gone). The Inspector names a wire by what its ends are on, not by its id.
4. **Hub contacts.** A tail on the hub stores an angle in whole degrees, snapped to 15° (0 = right, 90 = down). Drawn from that point of the ring: on the right half it leaves sideways to the right; on the left half it leaves up (top) or down (bottom) out of the hub's square, then right. A tail with no angle (every entry wire read from BaseApi, a new wire drawn from the hub's port) is automatic: the right side, fanned 16 px apart as today.
5. **Step sides.** A drop over a step is on its input side when the pointer is in the step's left half, its output side in its right half. Both ends slide along their side, snapped to 8 px and clamped to the processor band (step-local 64..128, today's `clampLanding`), which is where the frame's traces meet the chip.
6. **Settling (load reconciliation).** On load (the stored design, or a session's design) and after every Save answer, `settleDraft` runs: wires with an end on a step that is not on the canvas go; an end on a wire that is gone opens where it is drawn; then the circuit is compared with the expected links (the saved workflow's lists with the design's own `next` / `entries` over them): a missing link is made by a plan 7 wire `s->t` whose head is on a junction (its head goes back into `t`), else by a new automatic wire `s->t`; an unexpected link has the junctions on its way drawn plain (a plan 7 head into its own step, any other end open where it is drawn), and a plain wire still making one goes. Links through a short-circuited net are ignored both ways (they are never written).
7. **A drop that would bring a second family into a net is refused, also into a net that is already short-circuited** (after an Inspector edit). Disconnecting is always allowed. Order of the drop checks: wrong side / hub head / same step / same wire, then a closed loop of wires ("short circuit"), then a step fed its own input through junctions ("same step"), then families ("short circuit").
8. **Equal positions on a host do not meet**: current poured in at `at` reaches only tail junctions strictly further along; a tail junction at `at` takes only what entered strictly before it.
9. **A host detached (its own ends moved) keeps the wires joined on it**: they stay on its line, which still exists, and are re-coloured by the net rules. Only a deleted host opens their ends (spec §2.2-6), where they were drawn, keeping their bends.
10. **Short circuits.** Every wire of a net whose families disagree is drawn in the family of the step its own head chain reaches (else the net's lowest family), dashed or solid by its ends, and its junction circles are red. One error per such net: `kind: 'step'`, `stage: 'wires'`, `field: null`, `id` = the first step (by id) of the net's highest family that a head in the net lands on, message `short circuit: <lowest family name> meets <highest family name>`. Problems lists these live (while they last), not only after a Save; the Save answer's copies are not listed twice. Save leaves the net's links out of the lists it sends; Output says `Saved and applied; N short circuit(s) not written` when BaseApi applied the rest.
11. **Reset route** drops the wire's bends and puts its ends on steps back to automatic heights; what it is connected to (a junction, a hub angle) stays.
12. **Drop labels and tones.** `connect here` (a step side or the hub) and `join here` (a wire) are green; `move here` is grey (the end is or stays open: empty canvas, a cache); refusals are red: `wrong side`, `same step`, `same wire`, `short circuit`, `only a tail on the workflow`. A dragged end's own line counts as a drop target ("same wire") except its run that touches the dragged end, where the drag starts.
13. **Open ends** keep their marks (spec §2.1): an open tail its small ring, an open head its arrow head, which points along the wire's last run. No open circles; an open end is dragged by its end square once the wire is picked (the always-draggable open circle of plan 8 is gone).
14. **Layout `v: 2`** writes `wires` (the whole circuit) instead of `routes` and `loose`; BaseApi stores it unread, as today.
15. **The circuit e2e specs use their own throwaway workflow** (`e2e-9-…`: steps a, b, c Completed and d Failed; wf → a, a → b, a → d, b → c), created and deleted through BaseApi's CRUD by the test runner. The design-only spec keeps the browser read-only (studio.ts's guard); the Save spec may write only that workflow's design (throwaway.ts's guard). Live data cannot be relied on for two families side by side.
16. **Tasks 7, 8 and 9 are one type-check unit**: they change `Draft`, `WireRoute` and `StudioDocument` together. Each runs its own test files; `npx tsc -b` and the whole Vitest suite are green again at the end of Task 9. Review Tasks 7-9 as one (plan 8 did the same with Tasks 11-12).

## Global Constraints

- **Studio only.** BaseApi is not changed; the request of `PUT /workflows/{id}/design` keeps its shape (spec §7). The layout is opaque to BaseApi (`WorkflowLayout.Validate` checks only "a JSON object, at most 1 MB").
- **Commands** (PowerShell, in `src/WorkflowStudio`): `npx vitest run <path>`, `npx tsc -b` (then delete `tsconfig.tsbuildinfo`), `npx playwright test <spec>`. Run npm scripts from PowerShell: Git Bash `npm run` prints nothing.
- **Every user-visible behaviour is verified with Playwright using a real mouse and keyboard** (`page.mouse`, `page.keyboard`), on the dev server and on the deployed studio (memory `verify-studio-ui-with-playwright`).
- **Designer e2e is read-only** (`e2e/studio.ts`'s guard fails any browser request that is not a GET); **Save e2e writes only to a throwaway workflow** created and deleted through BaseApi's CRUD (`e2e/throwaway.ts`'s guard aborts any other write).
- **A refresh keeps everything** (memory `studio-refresh-keeps-everything`): documents, dock, the drawing (every wire, junction and open end) and unsaved drafts.
- **Labels, exactly:** `connect here`, `join here`, `move here`, `wrong side`, `same step`, `same wire`, `short circuit`, `only a tail on the workflow`. Save error: `kind: 'step'`, `stage: 'wires'`, message `short circuit: <family A> meets <family B>` (family names from `conditionInfo`: Completed, Failed, Cancelled, Always, Never).
- **Colours:** families as the legend (`conditionInfo(c).colour`); undecided `#8A97A8`; a short circuit's junction `#F87171`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Source files mix CRLF and LF: after every edit check `git diff` shows only the intended lines (a replacement that silently missed shows as no change).
- Never stage `.playwright-mcp/`, `.wf-restore.json` or `tools/simulate-*.py` (untracked, not ours). Stage files by name, never `git add -A` / `git add .`.
- Deploying the studio restarts it on the shared dev cluster (`desktop`, ns `skp`); the user approved studio deploys (Task 12). Port forwards are supervised by `./k8s/port-forward-realstack.ps1` (`-Status`); do not stop them by hand.

## Review Focus

Failure modes the spec implies but none of its listed tests catch; each is pinned by a test in the owning task.

1. **An old design opened after the deploy.** A stored plan 8 layout (a loose wire, a plan 7 junction whose host leads into another step) must open with the loose wire kept and the workflow's links unchanged: the junction drawn plain into its own step. Pinned in Task 6 (`a plan 7 junction whose host leads elsewhere goes back into its own step`) and Task 7 (`a stored plan 7 junction whose meaning differs from the loaded graph is drawn plain on load`).
2. **A short circuit made by an Inspector edit, saved, then reopened.** Save leaves the net's links out; on the next load the expected lists lack them, and settling must not "repair" the junction away. Pinned in Task 6 (`links through a short-circuited net are neither expected nor repaired`).
3. **Duplicate paths.** Two ways from s into t (a plain wire and a junction chain) write the link once, and removing one keeps it. Pinned in Task 2 (`two ways into one step write the link once`) and Task 10 (`a link made twice is sent once`).
4. **Deleting a host that is itself joined on another wire** (a chain): only the deleted wire's dependants open, at the points they were drawn, keeping their bends; the chain's other junctions stay. Pinned in Task 1 (`a deleted host opens only the ends on it, where they were drawn`).
5. **Starting an end drag on the wire's own line.** The press is on the end square, on the wire's own last run: the first moves must not read "same wire". Pinned in Task 9 (`a dragged end over its own end run is not "same wire"`) through `wireAt`'s own-run exclusion (Task 9, `hit.test.ts`).

---

## File structure

**New: the circuit** (`src/WorkflowStudio/src/circuit/`, pure, no React)
- `circuit.ts` — `End`, `CircuitWire`, `Circuit`, `Side`, ids (`plainWireId`, `NEW_WIRE_PREFIX`), `snapAngle`, `plainCircuit`, `sameEnd`, `setEnd`, `setBends`, `addCircuitWire`, `removeCircuitWires`, `shapedByHand`, `parseCircuit`, `legacyCircuit`.
- `trace.ts` — the point graph, `trace` (links, loop), `linkKeys`, `wiresBetween`.
- `families.ts` — `Net`, `netsOf`, `shortedWires`, `circuitTrace`.

**New: studio parts**
- `src/layout/circuitRoute.ts` — `WireRoute` (new shape), `EndKind`, `RouteContext`, `routeCircuit`, `routeWires` (moved here from `wires.ts`), `contactOn`, `hubLead`.
- `src/design/drop.ts` — `DropTarget`, `Refusal`, `Verdict`, `endOf`, `judgeDrop`, `dropLabel`, `toneOf`, `targetOf`, `pointOfTarget`.
- `src/design/settle.ts` — `expectedLinks`, `reconcile`, `settleDraft`, `settleDesign`.
- `src/design/shortCircuits.ts` — `SHORT_CIRCUIT`, `shortCircuitErrors`, `isShortCircuitError`.

**Changed**
- `src/layout/ports.ts` — `Arrival`, `landingsOf`; `computeLandings` uses it.
- `src/layout/shape.ts` — `parseBends` (moved from `draft.ts`).
- `src/layout/wires.ts` — keeps `WiringInput`, box ids, `collectWires`, `portOf`, `blockBoxes`, `tetherPoints`; loses the old `WireRoute`, `Joint`, loose types, `routeWires`, `routeWiring`, `routeLoose`, `drawnLine`.
- `src/design/draft.ts` — `Draft.wires`; `circuitOf`, `listsOf`, `withCircuit`, `removeWires`, `setShape`, `resetShape`, `parseDraft`; the loose and re-attach operations go.
- `src/design/apply.ts`, `src/design/design.ts` (`storedDesignOf`), `src/design/layoutDesign.ts` (`v: 2`), `src/app/document.ts`, `src/app/loadDocument.ts`, `src/store/studioState.ts`.
- Drawing: `src/canvas/toFlow.ts`, `src/canvas/edges/CableEdge.tsx`, `src/canvas/Legend.tsx`, `src/canvas/art.css`.
- Editing: `src/design/useWireGestures.ts`, `src/design/DesignOverlay.tsx`, `src/design/DesignContext.ts`, `src/design/hit.ts`, `src/design/useDesignKeys.ts`, `src/canvas/WorkflowCanvas.tsx`, `src/canvas/selection.ts`, `src/canvas/canvas.css`, `src/panels/Inspector.tsx`. Deleted: `src/design/rules.ts`, `src/design/rules.test.ts`.
- Save: `src/app/saveDesign.ts`, `src/panels/Problems.tsx`, `src/store/studioState.ts` (Output text).
- e2e: `e2e/throwaway.ts`, `e2e/circuit.spec.ts` (new), `e2e/circuit-save.spec.ts` (new), `e2e/save.spec.ts`, `e2e/designer.spec.ts`.
- `docs/HANDOVER-2026-10-08-skp-studio-plan8.md` (Task 12).

---
### Task 1: The circuit model

**Files:**
- Create: `src/WorkflowStudio/src/circuit/circuit.ts`
- Modify: `src/WorkflowStudio/src/layout/shape.ts` (add `parseBends` at the end)
- Test: `src/WorkflowStudio/src/circuit/circuit.test.ts`

**Interfaces:**
- Consumes: `Bends` (`layout/shape.ts`), `Point` (`layout/geometry.ts`), `WORKFLOW_SOURCE`, `SourceId` (`layout/ports.ts`), `Id`, `Step` (`model/graph.ts`).
- Produces (later tasks rely on these exact names):
  - `type End = { on: 'step'; step: Id; y: number | null } | { on: 'hub'; angle: number | null } | { on: 'wire'; host: string; at: number } | { on: 'open'; x: number; y: number }`
  - `type Side = 'tail' | 'head'`; `interface CircuitWire { tail: End; head: End; bends?: Bends }`; `type Circuit = Record<string, CircuitWire>`
  - `plainWireId(source: SourceId, target: Id): string` (`source->target`); `NEW_WIRE_PREFIX = 'w:'`; `HUB_ANGLE_STEP = 15`; `snapAngle(deg: number): number` (0..345)
  - `plainCircuit(entryStepIds: readonly Id[], steps: ReadonlyMap<Id, Step>, onCanvas: (id: Id) => boolean): Circuit`
  - `sameEnd(a: End, b: End): boolean`
  - `setEnd(c: Readonly<Circuit>, id: string, side: Side, end: End): Circuit`
  - `setBends(c: Readonly<Circuit>, id: string, bends: Bends | null): Circuit`
  - `addCircuitWire(c: Readonly<Circuit>, id: string, w: CircuitWire): Circuit`
  - `removeCircuitWires(c: Readonly<Circuit>, ids: readonly string[], pointOf: (id: string, side: Side) => Point | null): Circuit`
  - `shapedByHand(w: CircuitWire): boolean`
  - `parseCircuit(v: unknown): Circuit | null`; `legacyCircuit(routes: unknown, loose: unknown): Circuit | null`
  - `layout/shape.ts`: `parseBends(v: unknown): Bends | null`

- [ ] **Step 1: Write the failing test**

Create `src/WorkflowStudio/src/circuit/circuit.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Step } from '../model/graph';
import {
  addCircuitWire, legacyCircuit, parseCircuit, plainCircuit, removeCircuitWires, sameEnd, setBends, setEnd, shapedByHand, snapAngle,
  type Circuit, type CircuitWire, type Side,
} from './circuit';

const step = (next: string[] = []) => ({ nextStepIds: next }) as unknown as Step;
const plain = (s: string, t: string): CircuitWire => ({ tail: { on: 'step', step: s, y: null }, head: { on: 'step', step: t, y: null } });
const bends = { xs: [400], ys: [] };

describe('plainCircuit', () => {
  it('makes an automatic wire per entry step and per next step whose two ends are on the canvas', () => {
    const steps = new Map([['s1', step(['s2', 'gone'])], ['s2', step()], ['s3', step(['s1'])]]);
    const c = plainCircuit(['s1', 's1'], steps, (id) => id !== 's3');
    expect(Object.keys(c)).toEqual(['wf->s1', 's1->s2']);
    expect(c['wf->s1']).toEqual({ tail: { on: 'hub', angle: null }, head: { on: 'step', step: 's1', y: null } });
    expect(c['s1->s2']).toEqual(plain('s1', 's2'));
  });
});

describe('editing a circuit', () => {
  const c: Circuit = { w: { ...plain('s1', 's2'), bends } };

  it('keeps the bends while an end stays on what it was on, and drops them onto anything else', () => {
    expect(setEnd(c, 'w', 'head', { on: 'step', step: 's2', y: 72 }).w).toEqual({ tail: c.w!.tail, head: { on: 'step', step: 's2', y: 72 }, bends });
    expect(setEnd(c, 'w', 'head', { on: 'step', step: 's3', y: 72 }).w).toEqual({ tail: c.w!.tail, head: { on: 'step', step: 's3', y: 72 } });
    expect(setEnd(c, 'w', 'tail', { on: 'open', x: 8, y: 16 }).w!.bends).toBeUndefined();
    const open: Circuit = { o: { tail: { on: 'open', x: 0, y: 0 }, head: { on: 'open', x: 96, y: 0 }, bends } };
    expect(setEnd(open, 'o', 'head', { on: 'open', x: 96, y: 40 }).o).toEqual({ tail: open.o!.tail, head: { on: 'open', x: 96, y: 40 }, bends });
    expect(setEnd(c, 'gone', 'head', { on: 'open', x: 0, y: 0 })).toBe(c);
  });

  it('sets and clears a wire\'s bends, and adds a wire', () => {
    expect(setBends(c, 'w', null).w).toEqual(plain('s1', 's2'));
    expect(setBends(c, 'w', { xs: [], ys: [] }).w).toEqual(plain('s1', 's2'));
    expect(setBends(c, 'gone', null)).toBe(c);
    expect(Object.keys(addCircuitWire(c, 'w:1', plain('s2', 's3')))).toEqual(['w', 'w:1']);
  });

  it('a deleted host opens only the ends on it, where they were drawn, keeping their bends (Review Focus 4)', () => {
    const chain: Circuit = {
      h: plain('s1', 's2'),
      x: { tail: { on: 'step', step: 's3', y: null }, head: { on: 'wire', host: 'h', at: 40 }, bends },
      y: { tail: { on: 'wire', host: 'x', at: 24 }, head: { on: 'step', step: 's4', y: null } },
    };
    const drawn = (id: string, side: Side) => (id === 'x' && side === 'head' ? { x: 160, y: 80 } : null);
    const out = removeCircuitWires(chain, ['h'], drawn);
    expect(Object.keys(out)).toEqual(['x', 'y']);
    expect(out.x).toEqual({ tail: chain.x!.tail, head: { on: 'open', x: 160, y: 80 }, bends });
    expect(out.y).toBe(chain.y);
    expect(removeCircuitWires(chain, ['gone'], drawn)).toBe(chain);
  });

  it('compares ends, snaps hub angles to 15 degrees, and tells a shaped wire', () => {
    expect(sameEnd({ on: 'step', step: 's1', y: 64 }, { on: 'step', step: 's1', y: 64 })).toBe(true);
    expect(sameEnd({ on: 'step', step: 's1', y: 64 }, { on: 'step', step: 's1', y: null })).toBe(false);
    expect(sameEnd({ on: 'hub', angle: 90 }, { on: 'open', x: 0, y: 0 })).toBe(false);
    expect([snapAngle(-88), snapAngle(359), snapAngle(97)]).toEqual([270, 0, 90]);
    expect(shapedByHand(plain('s1', 's2'))).toBe(false);
    expect(shapedByHand({ ...plain('s1', 's2'), bends })).toBe(true);
    expect(shapedByHand({ tail: { on: 'step', step: 's1', y: 72 }, head: { on: 'open', x: 0, y: 0 } })).toBe(true);
  });
});

describe('reading a circuit back', () => {
  it('parses its own JSON and drops a wire it cannot read (a head on the hub, a junction with no host)', () => {
    const c: Circuit = { 'w:1': { tail: { on: 'hub', angle: 90 }, head: { on: 'wire', host: 's1->s2', at: 40 }, bends: { xs: [8, 16], ys: [40] } }, 's1->s2': plain('s1', 's2') };
    expect(parseCircuit(JSON.parse(JSON.stringify(c)))).toEqual(c);
    expect(parseCircuit({
      a: { tail: { on: 'step', step: 's1', y: null }, head: { on: 'hub', angle: 0 } },
      b: { tail: { on: 'open', x: 1, y: 2 }, head: { on: 'wire', at: 4 } },
      c: 5,
    })).toEqual({});
    expect(parseCircuit('nope')).toBeNull();
  });

  it('reads plan 7 shapes and plan 8 loose wires as wires (spec §8)', () => {
    const c = legacyCircuit(
      {
        's1->s2': { bends: { xs: [400], ys: [] }, landing: 72, contact: null },
        's3->s4': { bends: null, landing: null, contact: { host: 's1->s2', at: 40 } },
        bad: {},
      },
      {
        l1: { source: 's1', end: { x: 900, y: 64 } },
        l2: { open: 'start', target: 's2', start: { x: 8, y: 8 }, landing: null, contact: { host: 's1->s2', at: 24 }, was: 's9->s2' },
        l3: { open: 'both', start: { x: 0, y: 0 }, end: { x: 64, y: 0 }, bends: { xs: [32], ys: [] } },
        l4: { source: 'wf', end: 'nope' },
      },
    );
    expect(c).toEqual({
      's1->s2': { tail: { on: 'step', step: 's1', y: null }, head: { on: 'step', step: 's2', y: 72 }, bends: { xs: [400], ys: [] } },
      's3->s4': { tail: { on: 'step', step: 's3', y: null }, head: { on: 'wire', host: 's1->s2', at: 40 } },
      'w:l1': { tail: { on: 'step', step: 's1', y: null }, head: { on: 'open', x: 900, y: 64 } },
      'w:l2': { tail: { on: 'open', x: 8, y: 8 }, head: { on: 'wire', host: 's1->s2', at: 24 } },
      'w:l3': { tail: { on: 'open', x: 0, y: 0 }, head: { on: 'open', x: 64, y: 0 }, bends: { xs: [32], ys: [] } },
    });
    expect(legacyCircuit(undefined, {})).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/circuit/circuit.test.ts`
Expected: FAIL (`Failed to resolve import "./circuit"`).

- [ ] **Step 3: Write the implementation**

Append to `src/WorkflowStudio/src/layout/shape.ts`:

```ts

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Bends read back from a session or a stored layout; null when the value is not of their shape. */
export function parseBends(v: unknown): Bends | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (!Array.isArray(r.xs) || !Array.isArray(r.ys)) return null;
  if (!r.xs.every(isNum) || !r.ys.every(isNum) || r.xs.length === 0 || r.ys.length !== r.xs.length - 1) return null;
  return { xs: [...r.xs], ys: [...r.ys] };
}
```

Create `src/WorkflowStudio/src/circuit/circuit.ts`:

```ts
import type { Point } from '../layout/geometry';
import { WORKFLOW_SOURCE, type SourceId } from '../layout/ports';
import { parseBends, type Bends } from '../layout/shape';
import type { Id, Step } from '../model/graph';

/**
 * Where one end of a wire is (plan 9 §3). A tail on a step is on its right side (its output), a head on its left
 * side (its input); `y` is the step-local height along that side, null: automatic. The hub takes tails only, at
 * `angle` degrees round its ring (0 right, 90 down; null: automatic, its right side). On a wire: a junction `at` px
 * along the host's drawn line. Open: connected to nothing, at a flow point.
 */
export type End =
  | { on: 'step'; step: Id; y: number | null }
  | { on: 'hub'; angle: number | null }
  | { on: 'wire'; host: string; at: number }
  | { on: 'open'; x: number; y: number };

export type Side = 'tail' | 'head';

/** A one-way conductor from its tail to its head (plan 9 §3); `bends`: its own manual route (absent: automatic). */
export interface CircuitWire {
  tail: End;
  head: End;
  bends?: Bends;
}

/** Every wire on the canvas by its id; a wire keeps its id for its whole life. */
export type Circuit = Record<string, CircuitWire>;

/** A wire made from the workflow's own lists: `source->target`. */
export const plainWireId = (source: SourceId, target: Id): string => `${source}->${target}`;
/** A wire drawn in the designer: `w:{guid}`. */
export const NEW_WIRE_PREFIX = 'w:';

/** The hub's ring takes a tail every 15 degrees. */
export const HUB_ANGLE_STEP = 15;
export function snapAngle(deg: number): number {
  const a = Math.round(deg / HUB_ANGLE_STEP) * HUB_ANGLE_STEP;
  return ((a % 360) + 360) % 360;
}

/** A null-prototype copy, so an id such as `__proto__` is an ordinary key. */
const copy = (c: Readonly<Circuit>): Circuit => Object.assign(Object.create(null) as Circuit, c);
const has = (c: Readonly<Circuit>, id: string): boolean => Object.hasOwn(c, id);

/** The workflow's own wiring: an automatic wire per entry step and per next step, both ends on the canvas. */
export function plainCircuit(entryStepIds: readonly Id[], steps: ReadonlyMap<Id, Step>, onCanvas: (id: Id) => boolean): Circuit {
  const c = copy({});
  const placed = (id: Id) => steps.has(id) && onCanvas(id);
  for (const id of new Set(entryStepIds)) {
    if (placed(id)) c[plainWireId(WORKFLOW_SOURCE, id)] = { tail: { on: 'hub', angle: null }, head: { on: 'step', step: id, y: null } };
  }
  for (const [id, step] of steps) {
    if (!placed(id)) continue;
    for (const next of step.nextStepIds) {
      if (placed(next)) c[plainWireId(id, next)] = { tail: { on: 'step', step: id, y: null }, head: { on: 'step', step: next, y: null } };
    }
  }
  return c;
}

export function sameEnd(a: End, b: End): boolean {
  switch (a.on) {
    case 'step': return b.on === 'step' && a.step === b.step && a.y === b.y;
    case 'hub': return b.on === 'hub' && a.angle === b.angle;
    case 'wire': return b.on === 'wire' && a.host === b.host && a.at === b.at;
    case 'open': return b.on === 'open' && a.x === b.x && a.y === b.y;
  }
}

/** On the same thing: one step, the hub, one host wire, or open (anywhere). */
function sameFooting(a: End, b: End): boolean {
  if (a.on === 'step') return b.on === 'step' && a.step === b.step;
  if (a.on === 'wire') return b.on === 'wire' && a.host === b.host;
  return a.on === b.on;
}

const withBends = (tail: End, head: End, bends: Bends | null | undefined): CircuitWire =>
  (bends && bends.xs.length > 0 ? { tail, head, bends } : { tail, head });

/**
 * One end moved (plan 9 §6). The bends stay while the end stays on what it was on (slid along its side, round the
 * hub, along its host, or an open end moved); onto anything else the wire is automatic again (plan 4 §4.4).
 */
export function setEnd(c: Readonly<Circuit>, id: string, side: Side, end: End): Circuit {
  if (!has(c, id)) return c as Circuit;
  const w = c[id]!;
  const out = copy(c);
  const keep = sameFooting(w[side], end) ? w.bends : undefined;
  out[id] = side === 'tail' ? withBends(end, w.head, keep) : withBends(w.tail, end, keep);
  return out;
}

/** A wire's own route; null or none: the router draws it. */
export function setBends(c: Readonly<Circuit>, id: string, bends: Bends | null): Circuit {
  if (!has(c, id)) return c as Circuit;
  const w = c[id]!;
  const out = copy(c);
  out[id] = withBends(w.tail, w.head, bends);
  return out;
}

export function addCircuitWire(c: Readonly<Circuit>, id: string, w: CircuitWire): Circuit {
  const out = copy(c);
  out[id] = w;
  return out;
}

/**
 * Wires removed (Delete, plan 9 §2.2-6): a wire joined on a removed one keeps its place, that end open where it is
 * drawn (`pointOf`), its bends kept.
 */
export function removeCircuitWires(c: Readonly<Circuit>, ids: readonly string[], pointOf: (id: string, side: Side) => Point | null): Circuit {
  const gone = new Set(ids.filter((id) => has(c, id)));
  if (gone.size === 0) return c as Circuit;
  const out = copy({});
  for (const [id, w] of Object.entries(c)) {
    if (gone.has(id)) continue;
    const opened = (side: Side): End => {
      const e = w[side];
      if (e.on !== 'wire' || !gone.has(e.host)) return e;
      const p = pointOf(id, side) ?? { x: 0, y: 0 };
      return { on: 'open', x: p.x, y: p.y };
    };
    const tail = opened('tail'), head = opened('head');
    out[id] = tail === w.tail && head === w.head ? w : withBends(tail, head, w.bends);
  }
  return out;
}

/** Shaped by hand: its own bends, or an end slid along a step's side (Reset route has something to undo). */
export const shapedByHand = (w: CircuitWire): boolean =>
  (w.bends?.xs.length ?? 0) > 0 || (w.tail.on === 'step' && w.tail.y !== null) || (w.head.on === 'step' && w.head.y !== null);

// ---- reading back: a session's or a stored layout's circuit, or a plan 7 / plan 8 one; anything malformed is dropped ----

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isId = (v: unknown): v is string => typeof v === 'string' && v !== '';

function toEnd(v: unknown): End | null {
  if (!isRecord(v)) return null;
  switch (v.on) {
    case 'step': return isId(v.step) ? { on: 'step', step: v.step, y: isNum(v.y) ? v.y : null } : null;
    case 'hub': return { on: 'hub', angle: isNum(v.angle) ? snapAngle(v.angle) : null };
    case 'wire': return isId(v.host) && isNum(v.at) ? { on: 'wire', host: v.host, at: v.at } : null;
    case 'open': return isNum(v.x) && isNum(v.y) ? { on: 'open', x: v.x, y: v.y } : null;
    default: return null;
  }
}

/** A circuit as it serializes; null when the value is not a record at all. A head on the hub is no wire. */
export function parseCircuit(v: unknown): Circuit | null {
  if (!isRecord(v)) return null;
  const out = copy({});
  for (const [id, raw] of Object.entries(v)) {
    if (!isRecord(raw)) continue;
    const tail = toEnd(raw.tail), head = toEnd(raw.head);
    if (!tail || !head || head.on === 'hub') continue;
    out[id] = withBends(tail, head, parseBends(raw.bends));
  }
  return out;
}

const terminal = (source: SourceId): End => (source === WORKFLOW_SOURCE ? { on: 'hub', angle: null } : { on: 'step', step: source, y: null });
const contactOf = (v: unknown): End | null => (isRecord(v) && isId(v.host) && isNum(v.at) ? { on: 'wire', host: v.host, at: v.at } : null);
const pointOf = (v: unknown): End | null => (isRecord(v) && isNum(v.x) && isNum(v.y) ? { on: 'open', x: v.x, y: v.y } : null);

function legacyLoose(raw: Record<string, unknown>): CircuitWire | null {
  const bends = parseBends(raw.bends);
  if (raw.open === 'start') {
    const tail = pointOf(raw.start);
    if (!tail || !isId(raw.target)) return null;
    return withBends(tail, contactOf(raw.contact) ?? { on: 'step', step: raw.target, y: isNum(raw.landing) ? raw.landing : null }, bends);
  }
  if (raw.open === 'both') {
    const tail = pointOf(raw.start), head = pointOf(raw.end);
    return tail && head ? withBends(tail, head, bends) : null;
  }
  const head = pointOf(raw.end);
  return head && isId(raw.source) ? withBends(terminal(raw.source), head, bends) : null;
}

/**
 * A plan 7 / plan 8 draft's or layout's wires (spec §8): a shaped wire `s->t` keeps its id, its bends, its slid
 * landing (its head's height) and its junction (a head junction); loose wire `k` becomes `w:k`: its source a tail on
 * that terminal, an open end open, a start-loose wire's target or junction its head. Null when there is none.
 */
export function legacyCircuit(routes: unknown, loose: unknown): Circuit | null {
  const out = copy({});
  let any = false;
  if (isRecord(routes)) {
    for (const [id, raw] of Object.entries(routes)) {
      const at = id.indexOf('->');
      if (at <= 0 || at + 2 >= id.length || !isRecord(raw)) continue;
      const head = contactOf(raw.contact) ?? { on: 'step', step: id.slice(at + 2), y: isNum(raw.landing) ? raw.landing : null };
      out[id] = withBends(terminal(id.slice(0, at)), head, parseBends(raw.bends));
      any = true;
    }
  }
  if (isRecord(loose)) {
    for (const [k, raw] of Object.entries(loose)) {
      const w = isRecord(raw) ? legacyLoose(raw) : null;
      if (w) { out[`${NEW_WIRE_PREFIX}${k}`] = w; any = true; }
    }
  }
  return any ? out : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/circuit/circuit.test.ts src/layout/shape.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/WorkflowStudio/src/circuit/circuit.ts src/WorkflowStudio/src/circuit/circuit.test.ts src/WorkflowStudio/src/layout/shape.ts
git commit -m "feat(studio): the circuit model: wire ends on a terminal, a junction or open (plan 9)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The tracer

**Files:**
- Create: `src/WorkflowStudio/src/circuit/trace.ts`
- Test: `src/WorkflowStudio/src/circuit/trace.test.ts`

**Interfaces:**
- Consumes: Task 1 (`Circuit`, `CircuitWire`, `End`), `WORKFLOW_SOURCE`, `SourceId`.
- Produces:
  - `interface Trace { links: Map<SourceId, Id[]>; loop: boolean }`
  - `trace(circuit: Readonly<Circuit>, skip?: ReadonlySet<string>): Trace`
  - `linkKeys(links: ReadonlyMap<SourceId, readonly Id[]>): Set<string>` (`source->target`)
  - `wiresBetween(circuit: Readonly<Circuit>, source: SourceId, target: Id, skip?: ReadonlySet<string>): Set<string>`

- [ ] **Step 1: Write the failing test**

Create `src/WorkflowStudio/src/circuit/trace.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Circuit, CircuitWire, End } from './circuit';
import { linkKeys, trace, wiresBetween } from './trace';

const at = (step: string): End => ({ on: 'step', step, y: null });
const hub: End = { on: 'hub', angle: null };
const on = (host: string, d: number): End => ({ on: 'wire', host, at: d });
const open: End = { on: 'open', x: 0, y: 0 };
const w = (tail: End, head: End): CircuitWire => ({ tail, head });
const links = (c: Circuit) => [...linkKeys(trace(c).links)].sort();

describe('trace (plan 9 §7)', () => {
  it('a plain wire links its tail step or the hub to its head step; an open end links nothing', () => {
    expect(links({ a: w(hub, at('s1')), b: w(at('s1'), at('s2')), c: w(at('s2'), open), d: w(open, at('s3')) })).toEqual(['s1->s2', 'wf->s1']);
  });

  it('a tail junction fans out: it takes its host\'s current', () => {
    expect(links({ h: w(at('s1'), at('s2')), x: w(on('h', 40), at('s3')) })).toEqual(['s1->s2', 's1->s3']);
  });

  it('a head junction fans in: its current goes on into the host\'s head', () => {
    expect(links({ h: w(at('s1'), at('s2')), x: w(at('s3'), on('h', 40)) })).toEqual(['s1->s2', 's3->s2']);
  });

  it('a tail junction on an entry wire takes the hub\'s current: its head\'s step is an entry step', () => {
    expect(links({ e: w(hub, at('s1')), x: w(on('e', 24), at('s2')) })).toEqual(['wf->s1', 'wf->s2']);
  });

  it('position along the host decides: current poured in reaches only the tail junctions further along; equal points do not meet', () => {
    const c = (head: number): Circuit => ({ h: w(at('s1'), at('s2')), t: w(on('h', 64), at('s3')), x: w(at('s4'), on('h', head)) });
    expect(links(c(32))).toContain('s4->s3');
    expect(links(c(96))).not.toContain('s4->s3');
    expect(links(c(64))).not.toContain('s4->s3');
    expect(links(c(96))).toContain('s4->s2');
  });

  it('follows chains: a tail junction on a wire that is itself joined takes only that wire\'s current', () => {
    expect(links({ h: w(at('s1'), at('s2')), k: w(at('s3'), on('h', 64)), t: w(on('k', 16), at('s4')) })).toEqual(['s1->s2', 's3->s2', 's3->s4']);
  });

  it('two ways into one step write the link once, and removing one keeps it (Review Focus 3)', () => {
    const a = w(at('s1'), at('s2')), b = w(at('s1'), at('s2')), h = w(at('s1'), at('s3')), x = w(on('h', 40), at('s2'));
    expect(trace({ a, b, h, x }).links.get('s1')).toEqual(['s2', 's3']);
    expect(trace({ b, h, x }).links.get('s1')).toEqual(['s2', 's3']);
    expect(trace({ h, x }).links.get('s1')).toEqual(['s3', 's2']);
  });

  it('ignores a wire\'s end on itself, and leaves out the wires it is told to skip', () => {
    expect(trace({ a: w(at('s1'), on('a', 40)) }).links.size).toBe(0);
    expect([...linkKeys(trace({ a: w(at('s1'), at('s2')), b: w(at('s3'), at('s4')) }, new Set(['b'])).links)]).toEqual(['s1->s2']);
  });

  it('finds a closed loop of wires only (spec §2.2-3), never a loop through a step', () => {
    expect(trace({ h: w(at('s1'), on('x', 40)), x: w(at('s2'), on('h', 40)) }).loop).toBe(true);
    expect(trace({ a: w(at('s1'), at('s2')), b: w(at('s2'), at('s1')) }).loop).toBe(false);
  });

  it('names the wires current passes through from a source into a step', () => {
    const c = { h: w(at('s1'), at('s2')), x: w(on('h', 40), at('s3')), y: w(at('s4'), at('s3')) };
    expect([...wiresBetween(c, 's1', 's3')].sort()).toEqual(['h', 'x']);
    expect([...wiresBetween(c, 's4', 's3')]).toEqual(['y']);
    expect([...wiresBetween(c, 's4', 's2')]).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/circuit/trace.test.ts`
Expected: FAIL (`Failed to resolve import "./trace"`).

- [ ] **Step 3: Write the implementation**

Create `src/WorkflowStudio/src/circuit/trace.ts`:

```ts
import { WORKFLOW_SOURCE, type SourceId } from '../layout/ports';
import type { Id } from '../model/graph';
import type { Circuit } from './circuit';

/** What the current does (plan 9 §7): which step inputs each source reaches, and whether wires alone close a loop (§2.2-3). */
export interface Trace {
  /** By source (a step id or `wf`): the steps whose input its current reaches, each once, in the order first reached. */
  links: Map<SourceId, Id[]>;
  /** Current can come back into a wire it left without passing through a step. */
  loop: boolean;
}

type Graph = Map<string, string[]>;

/**
 * The circuit as points the current flows between: `src:{s}` (a step's output, `src:wf` the hub), `in:{t}` (a step's
 * input), and along each wire `p:{id}:{i}`: its tail (0), the junctions on it in order of `at`, its head (last).
 * A head junction pours into its host at its point; a tail junction leaves from its host's point. At equal `at`
 * a tail junction comes first, so they never meet (decision 8). An end on its own wire, or on a wire that is not in
 * the circuit, is no connection.
 */
function pointGraph(circuit: Readonly<Circuit>, skip: ReadonlySet<string>): Graph {
  const ids = Object.keys(circuit).filter((id) => !skip.has(id));
  const live = new Set(ids);
  const events = new Map<string, { at: number; order: 0 | 1; key: string }[]>(ids.map((id) => [id, []]));
  for (const id of ids) {
    const { tail, head } = circuit[id]!;
    if (tail.on === 'wire' && tail.host !== id && live.has(tail.host)) events.get(tail.host)!.push({ at: tail.at, order: 0, key: `t:${id}` });
    if (head.on === 'wire' && head.host !== id && live.has(head.host)) events.get(head.host)!.push({ at: head.at, order: 1, key: `h:${id}` });
  }
  const adj: Graph = new Map();
  const edge = (a: string, b: string) => { const l = adj.get(a); if (l) l.push(b); else adj.set(a, [b]); };
  const index = new Map<string, number>();
  const last = new Map<string, number>();
  for (const id of ids) {
    const list = events.get(id)!.sort((a, b) => a.at - b.at || a.order - b.order);
    for (let i = 0; i <= list.length; i++) edge(`p:${id}:${i}`, `p:${id}:${i + 1}`);
    list.forEach((e, k) => index.set(e.key, k + 1));
    last.set(id, list.length + 1);
  }
  for (const id of ids) {
    const { tail, head } = circuit[id]!;
    if (tail.on === 'step') edge(`src:${tail.step}`, `p:${id}:0`);
    else if (tail.on === 'hub') edge(`src:${WORKFLOW_SOURCE}`, `p:${id}:0`);
    else if (tail.on === 'wire' && index.has(`t:${id}`)) edge(`p:${tail.host}:${index.get(`t:${id}`)}`, `p:${id}:0`);
    const end = `p:${id}:${last.get(id)}`;
    if (head.on === 'step') edge(end, `in:${head.step}`);
    else if (head.on === 'wire' && index.has(`h:${id}`)) edge(end, `p:${head.host}:${index.get(`h:${id}`)}`);
  }
  return adj;
}

/** Every point reachable from `from`, in breadth-first order. */
function reach(adj: Graph, from: string): string[] {
  const seen = new Set([from]);
  const order: string[] = [];
  for (let i = 0, queue = [from]; i < queue.length; i++) {
    for (const m of adj.get(queue[i]!) ?? []) {
      if (seen.has(m)) continue;
      seen.add(m);
      order.push(m);
      if (!m.startsWith('in:')) queue.push(m);
    }
  }
  return order;
}

function hasCycle(adj: Graph): boolean {
  const state = new Map<string, 1 | 2>();
  for (const start of adj.keys()) {
    if (state.has(start)) continue;
    const stack: [string, number][] = [[start, 0]];
    state.set(start, 1);
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      const next = adj.get(top[0]) ?? [];
      if (top[1] < next.length) {
        const m = next[top[1]]!;
        top[1] += 1;
        const s = state.get(m);
        if (s === 1) return true;
        if (s === undefined) { state.set(m, 1); stack.push([m, 0]); }
      } else {
        state.set(top[0], 2);
        stack.pop();
      }
    }
  }
  return false;
}

/**
 * Follows the current (plan 9 §7): from a step's output or the hub along each wire to its head; a head junction
 * pours into its host at its point and reaches what lies further along (the host's head and the tail junctions past
 * that point); a tail junction takes what entered its host before its point. An open end carries nothing on.
 * `skip`: wires left out (a short-circuited net, spec §2.2-7).
 */
export function trace(circuit: Readonly<Circuit>, skip: ReadonlySet<string> = new Set()): Trace {
  const adj = pointGraph(circuit, skip);
  const links = new Map<SourceId, Id[]>();
  for (const from of adj.keys()) {
    if (!from.startsWith('src:')) continue;
    const reached = reach(adj, from).filter((n) => n.startsWith('in:')).map((n) => n.slice(3));
    if (reached.length > 0) links.set(from.slice(4), reached);
  }
  return { links, loop: hasCycle(adj) };
}

/** The links as `source->target` keys. */
export const linkKeys = (links: ReadonlyMap<SourceId, readonly Id[]>): Set<string> =>
  new Set([...links].flatMap(([s, ts]) => ts.map((t) => `${s}->${t}`)));

/** The wires current from `source` passes through on its way into `target`'s input. */
export function wiresBetween(circuit: Readonly<Circuit>, source: SourceId, target: Id, skip: ReadonlySet<string> = new Set()): Set<string> {
  const adj = pointGraph(circuit, skip);
  const back: Graph = new Map();
  for (const [a, bs] of adj) for (const b of bs) { const l = back.get(b); if (l) l.push(a); else back.set(b, [a]); }
  const into = new Set(reach(back, `in:${target}`));
  const out = new Set<string>();
  for (const n of reach(adj, `src:${source}`)) if (n.startsWith('p:') && into.has(n)) out.add(n.slice(2, n.lastIndexOf(':')));
  return out;
}
```

Note: `reach` stops at `in:` points only for the forward graph; on the reversed graph (`back`) the walk starts at `in:{target}` and never meets another `in:` point, so the same function serves both.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/circuit/trace.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/WorkflowStudio/src/circuit/trace.ts src/WorkflowStudio/src/circuit/trace.test.ts
git commit -m "feat(studio): trace the current through a circuit: fan-in, fan-out, position along a wire, loops (plan 9)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Families per net

**Files:**
- Create: `src/WorkflowStudio/src/circuit/families.ts`
- Test: `src/WorkflowStudio/src/circuit/families.test.ts`

**Interfaces:**
- Consumes: Task 1 (`Circuit`), Task 2 (`trace`, `Trace`).
- Produces:
  - `interface Net { wires: string[]; families: number[] }` (families ascending)
  - `netsOf(circuit: Readonly<Circuit>, conditionOf: (step: Id) => number | undefined): Net[]`
  - `shortedWires(nets: readonly Net[]): Set<string>`
  - `circuitTrace(circuit: Readonly<Circuit>, conditionOf: (step: Id) => number | undefined): Trace & { nets: Net[] }`

- [ ] **Step 1: Write the failing test**

Create `src/WorkflowStudio/src/circuit/families.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { CircuitWire, End } from './circuit';
import { circuitTrace, netsOf, shortedWires } from './families';
import { linkKeys } from './trace';

const at = (step: string): End => ({ on: 'step', step, y: null });
const on = (host: string, d: number): End => ({ on: 'wire', host, at: d });
const open: End = { on: 'open', x: 0, y: 0 };
const w = (tail: End, head: End): CircuitWire => ({ tail, head });
const cond = (m: Record<string, number>) => (id: string): number | undefined => m[id];

describe('families (plan 9 §4)', () => {
  it('a net is the wires joined through junctions; its families are the entry conditions of its heads on steps', () => {
    const c = { h: w(at('s1'), at('s2')), x: w(on('h', 40), open), y: w(at('s3'), at('s4')), z: w(at('s1'), open) };
    const nets = netsOf(c, cond({ s2: 1, s4: 2 }));
    expect(nets.map((n) => [[...n.wires].sort(), n.families])).toEqual([[['h', 'x'], [1]], [['y'], [2]], [['z'], []]]);
  });

  it('a tail on a step or the hub decides nothing (rule 7); the decider gone, the net is undecided again', () => {
    expect(netsOf({ a: w({ on: 'hub', angle: null }, open) }, cond({})).map((n) => n.families)).toEqual([[]]);
    expect(netsOf({ h: w(at('s1'), open), x: w(on('h', 40), open) }, cond({ s2: 1 })).map((n) => n.families)).toEqual([[]]);
  });

  it('a net with two families is a short circuit: its wires are left out of the trace', () => {
    const c = { h: w(at('s1'), at('s2')), x: w(on('h', 40), at('s3')), y: w(at('s5'), at('s6')) };
    const conditions = cond({ s2: 1, s3: 2, s6: 1 });
    const nets = netsOf(c, conditions);
    expect(nets[0]!.families).toEqual([1, 2]);
    expect([...shortedWires(nets)].sort()).toEqual(['h', 'x']);
    const t = circuitTrace(c, conditions);
    expect([...linkKeys(t.links)]).toEqual(['s5->s6']);
    expect(t.nets).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/circuit/families.test.ts`
Expected: FAIL (`Failed to resolve import "./families"`).

- [ ] **Step 3: Write the implementation**

Create `src/WorkflowStudio/src/circuit/families.ts`:

```ts
import type { Id } from '../model/graph';
import type { Circuit } from './circuit';
import { trace, type Trace } from './trace';

/** Wires joined through junctions (plan 9 §2.2-2), and the families (entry conditions) their heads on steps decide. */
export interface Net {
  wires: string[];
  /** Ascending. None: undecided (grey, rule 12); two or more: a short circuit (§2.2-7). */
  families: number[];
}

/** The nets of a circuit, in the order of their first wire. A tail decides nothing (rule 7); a head on a step decides (rule 9). */
export function netsOf(circuit: Readonly<Circuit>, conditionOf: (step: Id) => number | undefined): Net[] {
  const parent = new Map<string, string>(Object.keys(circuit).map((id) => [id, id]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    for (let y = x; parent.get(y) !== r; ) { const n = parent.get(y)!; parent.set(y, r); y = n; }
    return r;
  };
  const join = (a: string, b: string) => { if (parent.has(b)) parent.set(find(a), find(b)); };
  for (const [id, w] of Object.entries(circuit)) {
    if (w.tail.on === 'wire') join(id, w.tail.host);
    if (w.head.on === 'wire') join(id, w.head.host);
  }
  const byRoot = new Map<string, Net>();
  for (const [id, w] of Object.entries(circuit)) {
    const root = find(id);
    const net = byRoot.get(root) ?? { wires: [], families: [] };
    byRoot.set(root, net);
    net.wires.push(id);
    const f = w.head.on === 'step' ? conditionOf(w.head.step) : undefined;
    if (f !== undefined && !net.families.includes(f)) net.families.push(f);
  }
  const nets = [...byRoot.values()];
  for (const n of nets) n.families.sort((a, b) => a - b);
  return nets;
}

/** The wires of nets whose families disagree: their links are never written (plan 9 §7). */
export const shortedWires = (nets: readonly Net[]): Set<string> => new Set(nets.filter((n) => n.families.length > 1).flatMap((n) => n.wires));

/** The current as Save writes it (plan 9 §7): short-circuited nets left out. */
export function circuitTrace(circuit: Readonly<Circuit>, conditionOf: (step: Id) => number | undefined): Trace & { nets: Net[] } {
  const nets = netsOf(circuit, conditionOf);
  return { ...trace(circuit, shortedWires(nets)), nets };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/circuit`
Expected: PASS (circuit, trace and families tests).

- [ ] **Step 5: Commit**

```bash
git add src/WorkflowStudio/src/circuit/families.ts src/WorkflowStudio/src/circuit/families.test.ts
git commit -m "feat(studio): families per net, short circuits left out of the trace (plan 9)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 4: Drawing the circuit's wires (routing)

**Files:**
- Create: `src/WorkflowStudio/src/layout/circuitRoute.ts`
- Modify: `src/WorkflowStudio/src/layout/ports.ts` (add `Arrival`, `landingsOf`; `computeLandings` delegates to it)
- Test: `src/WorkflowStudio/src/layout/circuitRoute.test.ts`, `src/WorkflowStudio/src/layout/ports.test.ts` (one test appended)

**Interfaces:**
- Consumes: Task 1 (`Circuit`, `CircuitWire`, `End`, `plainCircuit`), Task 3 (`netsOf`), `WiringInput`, `blockBoxes`, `SPHERE_BOX_ID`, `stepBoxId` (`layout/wires.ts`, unchanged here), `ownEnds`, `pointAt`, `lengthOf`, `CONTACT_MARGIN` (`layout/junctions.ts`), `route`, `simplify` (`layout/router.ts`), `clearPath` (`layout/detour.ts`).
- Produces:
  - `type EndKind = 'terminal' | 'junction' | 'open'`
  - `interface WireRoute { id: string; source: SourceId | null; target: Id | null; points: Pt[]; core: { ends: Ends; points: Pt[] }; condition: number | null; solid: boolean; tailOn: EndKind; headOn: EndKind; short: boolean; broken: boolean }` (replaces `layout/wires.ts`'s `WireRoute` in Task 7)
  - `interface RouteContext { placement: Placement; steps: ReadonlyMap<Id, Step> }`
  - `routeCircuit(circuit: Readonly<Circuit>, ctx: RouteContext): WireRoute[]` (in the circuit's order)
  - `routeWires(input: WiringInput, placement: Placement): WireRoute[]` (the workflow's own lists; callers move here in Task 7)
  - `contactOn(points: readonly Pt[], at: number): { p: Pt; vertical: boolean }`
  - `hubLead(cx: number, cy: number, angle: number): { start: Point; lead: Pt[] }`
  - `ports.ts`: `interface Arrival { key: string; target: Id; y: number; x: number }`; `landingsOf(arrivals: readonly Arrival[], placement: Placement): Map<string, number>`

- [ ] **Step 1: Write the failing tests**

Create `src/WorkflowStudio/src/layout/circuitRoute.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { graphDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { plainCircuit, type Circuit, type CircuitWire, type End } from '../circuit/circuit';
import { SPHERE_R, STEP_W } from './geometry';
import { contactOn, routeCircuit, routeWires } from './circuitRoute';

const at = (step: string, y: number | null = null): End => ({ on: 'step', step, y });
const w = (tail: End, head: End): CircuitWire => ({ tail, head });

const four = () => loadedDocument(graphDto({
  workflow: workflowDto({ entryStepIds: ['s1', 's3'] }),
  steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2'), stepDto('s3', { nextStepIds: ['s4'] }), stepDto('s4', { entryCondition: 2 })],
}));
const ctxOf = (doc: Awaited<ReturnType<typeof four>>) => ({ placement: doc.placement, steps: doc.graph.steps });
const byId = (routes: ReturnType<typeof routeCircuit>) => new Map(routes.map((r) => [r.id, r]));

describe('routeCircuit (plan 9 §5)', () => {
  it('draws the workflow\'s own wires exactly as plan 2 did: the same points, colours and ends', async () => {
    const doc = await loadedDocument(graphDto({
      workflow: workflowDto({ entryStepIds: ['s1'] }),
      steps: [stepDto('s1', { nextStepIds: ['s2', 's3'] }), stepDto('s2', { nextStepIds: ['s3'] }), stepDto('s3', { entryCondition: 3 })],
    }));
    const routes = routeWires({ entryStepIds: ['s1'], steps: doc.graph.steps, brokenEdges: new Set() }, doc.placement);
    expect(routes.map((r) => [r.id, r.points, r.condition])).toEqual(doc.wires.map((x) => [x.id, x.points, x.condition]));
    expect(routes.every((r) => r.solid && r.tailOn === 'terminal' && r.headOn === 'terminal' && !r.short)).toBe(true);
    expect(routes.find((r) => r.id === 'wf->s1')).toMatchObject({ source: 'wf', target: 's1' });
  });

  it('a tail on the hub at an angle starts on its ring there and leaves the hub\'s square (rule 1)', async () => {
    const doc = await four();
    const { cx, cy } = doc.placement.sphere;
    const routes = byId(routeCircuit({ top: w({ on: 'hub', angle: 270 }, at('s1')), left: w({ on: 'hub', angle: 180 }, at('s3')) }, ctxOf(doc)));
    const top = routes.get('top')!.points, left = routes.get('left')!.points;
    expect(top[0]).toEqual([cx, cy - SPHERE_R]);
    expect(left[0]).toEqual([cx - SPHERE_R, cy]);
    expect(left[1]).toEqual([cx - SPHERE_R, cy + SPHERE_R + 16]);
    // after the ring point, nothing inside the hub
    for (const p of [...top.slice(1), ...left.slice(1)]) expect(Math.hypot(p[0] - cx, p[1] - cy)).toBeGreaterThanOrEqual(SPHERE_R - 0.5);
    expect(routes.get('top')).toMatchObject({ source: 'wf', tailOn: 'terminal' });
  });

  it('a tail and a head slid along their sides start and end where they were put (rule 5)', async () => {
    const doc = await four();
    const s1 = doc.placement.steps.get('s1')!, s2 = doc.placement.steps.get('s2')!;
    const r = routeCircuit({ x: w(at('s1', 72), at('s2', 120)) }, ctxOf(doc))[0]!;
    expect(r.points[0]).toEqual([s1.x + STEP_W, s1.y + 72]);
    expect(r.points.at(-1)).toEqual([s2.x, s2.y + 120]);
  });

  it('open ends are drawn where they are: grey (undecided) and dashed, on no terminal', async () => {
    const doc = await four();
    const r = routeCircuit({ x: w({ on: 'open', x: 40, y: 600 }, { on: 'open', x: 400, y: 640 }) }, ctxOf(doc))[0]!;
    expect([r.points[0], r.points.at(-1)]).toEqual([[40, 600], [400, 640]]);
    expect(r).toMatchObject({ source: null, target: null, tailOn: 'open', headOn: 'open', condition: null, solid: false, short: false });
  });

  it('a head junction ends on its host\'s line at its point; a tail junction leaves from it; hosts are routed first whatever the order', async () => {
    const doc = await four();
    const c: Circuit = {
      x: w(at('s3'), { on: 'wire', host: 's1->s2', at: 40 }),
      y: w({ on: 'wire', host: 's1->s2', at: 64 }, { on: 'open', x: 900, y: 700 }),
      ...plainCircuit(['s1', 's3'], doc.graph.steps, (id) => doc.placement.steps.has(id)),
    };
    const routes = byId(routeCircuit(c, ctxOf(doc)));
    const host = routes.get('s1->s2')!.points;
    expect(routes.get('x')!.points.at(-1)).toEqual(contactOn(host, 40).p);
    expect(routes.get('y')!.points[0]).toEqual(contactOn(host, 64).p);
    expect(routes.get('x')).toMatchObject({ headOn: 'junction', target: null, condition: 1, solid: true });
    expect(routes.get('y')).toMatchObject({ tailOn: 'junction', source: null, condition: 1, solid: false });
  });

  it('a short circuit: every wire of the net is marked, each in the family its own head reaches', async () => {
    const doc = await four();
    const c: Circuit = {
      ...plainCircuit(['s1', 's3'], doc.graph.steps, (id) => doc.placement.steps.has(id)),
      x: w({ on: 'wire', host: 's1->s2', at: 40 }, at('s4')),
    };
    const routes = byId(routeCircuit(c, ctxOf(doc)));
    expect(routes.get('s1->s2')).toMatchObject({ short: true, condition: 1 });
    expect(routes.get('x')).toMatchObject({ short: true, condition: 2 });
    expect(routes.get('s3->s4')).toMatchObject({ short: false, condition: 2 });
  });

  it('an end on a host that is gone, or on a step off the canvas, is drawn open beside its other end', async () => {
    const doc = await four();
    const routes = byId(routeCircuit({ x: w(at('s1'), { on: 'wire', host: 'gone', at: 8 }), y: w(at('nope'), { on: 'open', x: 500, y: 300 }) }, ctxOf(doc)));
    const x = routes.get('x')!;
    expect(x.headOn).toBe('open');
    expect(x.points.at(-1)).toEqual([x.points[0]![0] + 96, x.points[0]![1]]);
    expect(routes.get('y')).toMatchObject({ tailOn: 'open', source: null });
    expect(routes.get('y')!.points[0]).toEqual([404, 300]);
  });
});
```

Append to `src/WorkflowStudio/src/layout/ports.test.ts` (add `landingsOf` to its import from `./ports`):

```ts
describe('landingsOf (plan 9: arrivals by wire, so two wires from one source into one step both land)', () => {
  it('keeps two arrivals from the same place 16 apart', () => {
    const placement = { sphere: { cx: 0, cy: 0 }, steps: new Map([['t', { x: 600, y: 0 }]]), caches: new Map() };
    const landed = landingsOf([{ key: 'a', target: 't', y: 96, x: 224 }, { key: 'b', target: 't', y: 96, x: 224 }], placement);
    expect(Math.abs(landed.get('a')! - landed.get('b')!)).toBeGreaterThanOrEqual(16);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/layout/circuitRoute.test.ts src/layout/ports.test.ts`
Expected: FAIL (`Failed to resolve import "./circuitRoute"`; `landingsOf` is not exported).

- [ ] **Step 3: Write the implementation**

In `src/WorkflowStudio/src/layout/ports.ts` replace the whole `computeLandings` function (its doc comment stays above it) with:

```ts
export function computeLandings(
  wires: WireEnd[],
  placement: Placement,
  departures: Map<SourceId, Map<Id, number>>,
): Map<Id, Map<SourceId, number>> {
  const keyOf = (w: WireEnd) => `${w.source}->${w.target}`;
  const landed = landingsOf(wires.map((w) => ({ key: keyOf(w), target: w.target, y: departures.get(w.source)!.get(w.target)!, x: departureX(w.source, placement) })), placement);
  const result = new Map<Id, Map<SourceId, number>>();
  for (const w of wires) {
    const m = result.get(w.target) ?? new Map<SourceId, number>();
    m.set(w.source, landed.get(keyOf(w))!);
    result.set(w.target, m);
  }
  return result;
}

/** One wire arriving on a step's input (plan 9): by its own key, from where it leaves (`y`, and `x`: Infinity when it cannot run straight). */
export interface Arrival {
  key: string;
  target: Id;
  y: number;
  x: number;
}

/** The landing rule above (spec §5.2), arrival by arrival: two wires from one source into one step each land. */
export function landingsOf(arrivals: readonly Arrival[], placement: Placement): Map<string, number> {
  const byTarget = new Map<Id, Arrival[]>();
  for (const a of arrivals) byTarget.set(a.target, [...(byTarget.get(a.target) ?? []), a]);
  const result = new Map<string, number>();
  for (const [target, list] of byTarget) {
    const p = placement.steps.get(target)!;
    const top = p.y + BAND_TOP, bottom = p.y + BAND_BOTTOM, middle = p.y + PMID;
    const used: number[] = [];
    const free = (y: number) => !used.some((u) => Math.abs(u - y) < PORT_GAP);
    const landed = new Map<string, number>();
    for (const a of list) {
      if (a.y < top || a.y > bottom || a.x > p.x - STRAIGHT_MIN_GAP) continue;
      const y = nearestFreeInBand(a.y, top, bottom, free);
      if (y === null) continue;
      used.push(y);
      landed.set(a.key, y);
    }
    const lo = p.y + CAP_H, hi = p.y + STEP_H;
    const bent = list.filter((a) => !landed.has(a.key)).sort((a, b) => a.y - b.y);
    if (bent.length > 0) {
      const walkUsed = [...used];
      const walkFree = (y: number) => !walkUsed.some((u) => Math.abs(u - y) < PORT_GAP);
      const walked = new Map<string, number>();
      for (const a of bent) {
        const y = nearestFreeSlot(middle, a.y < middle ? -1 : 1, lo, hi, walkFree);
        walkUsed.push(y);
        walked.set(a.key, y);
      }
      let chosen = walked;
      if ([...walked.values()].some((y) => y < lo || y > hi)) {
        const packed = packSlots(lo, hi, used);
        if (packed.length >= bent.length) chosen = new Map(bent.map((a, i) => [a.key, packed[i]!]));
      }
      for (const [k, y] of chosen) { used.push(y); landed.set(k, y); }
    }
    for (const [k, y] of landed) result.set(k, y);
  }
  return result;
}
```

Create `src/WorkflowStudio/src/layout/circuitRoute.ts`:

```ts
import { plainCircuit, type Circuit, type CircuitWire, type End } from '../circuit/circuit';
import { netsOf } from '../circuit/families';
import type { Id, Step } from '../model/graph';
import { clearPath } from './detour';
import { GRID, PMID, PORT_GAP, SPHERE_R, STEP_W, clampLanding, offset, snap, type Point } from './geometry';
import { CONTACT_MARGIN, lengthOf, ownEnds, pointAt } from './junctions';
import type { Placement } from './placement';
import { landingsOf, WORKFLOW_SOURCE, type Arrival, type SourceId } from './ports';
import { route, simplify, type Pt } from './router';
import { JOG, pointsOfShape, type Ends } from './shape';
import { blockBoxes, SPHERE_BOX_ID, stepBoxId, type WiringInput } from './wires';

/** What one end of a drawn wire is on (plan 9 §5): a ring or an arrow head on a terminal or open, a filled circle on a junction. */
export type EndKind = 'terminal' | 'junction' | 'open';

/** One wire of the circuit as drawn (plan 9 §5). */
export interface WireRoute {
  id: string;
  /** Its tail's terminal: a step (its output) or `wf` (the hub); null on a wire or open. */
  source: SourceId | null;
  /** Its head's step (its input); null on a wire or open. */
  target: Id | null;
  /** From its tail to its head. */
  points: Pt[];
  /** The part its bends shape: between a lead-out (the hub's ring, a junction on a level run) and a lead-in (a junction). */
  core: { ends: Ends; points: Pt[] };
  /** Its net's family, an entry condition; null: undecided, grey (spec §4). */
  condition: number | null;
  /** Both own ends connected and the family decided (spec §5); otherwise dashed. */
  solid: boolean;
  tailOn: EndKind;
  headOn: EndKind;
  /** In a net whose families disagree (§2.2-7): its junctions are marked red. */
  short: boolean;
  /** Named broken by validate (plan 2); nothing sets it since plan 8. */
  broken: boolean;
}

export interface RouteContext {
  placement: Placement;
  /** Every step on the canvas: the family a head on it decides is its entry condition. */
  steps: ReadonlyMap<Id, Step>;
}

/** The point `at` px along a drawn line, kept clear of its ends (plan 7 §5.3), and whether the run there is vertical. */
export function contactOn(points: readonly Pt[], at: number): { p: Pt; vertical: boolean } {
  const total = lengthOf([points]);
  const d = total < 2 * CONTACT_MARGIN ? total / 2 : Math.min(Math.max(snap(at, GRID), CONTACT_MARGIN), total - CONTACT_MARGIN);
  return pointAt([points], d);
}

const tenth = (v: number) => Math.round(v * 10) / 10;

/**
 * A tail on the hub's ring at `angle` (decision 4): from that ring point, on the right half sideways to the right,
 * on the left half up (top) or down (bottom) out of the hub's square and then right; `start` is where its own
 * route begins, `lead` the points before it.
 */
export function hubLead(cx: number, cy: number, angle: number): { start: Point; lead: Pt[] } {
  const r = (angle * Math.PI) / 180;
  const ring: Pt = [tenth(cx + SPHERE_R * Math.cos(r)), tenth(cy + SPHERE_R * Math.sin(r))];
  const right = snap(cx + SPHERE_R + JOG);
  if (Math.cos(r) > -1e-9) return { start: { x: right, y: ring[1] }, lead: [ring] };
  const y = snap(Math.sin(r) < 0 ? cy - SPHERE_R - JOG : cy + SPHERE_R + JOG);
  return { start: { x: right, y }, lead: [ring, [ring[0], y]] };
}

/** One end as routed: where it is, the router box it is on ('' for none), the points before it, and a junction's contact. */
interface Placed { at: Point; box: string; lead: Pt[]; contact: Pt | null; vertical: boolean }
const placedAt = (at: Point, box = '', lead: Pt[] = []): Placed => ({ at, box, lead, contact: null, vertical: false });
const kindOf = (e: End): EndKind => (e.on === 'wire' ? 'junction' : e.on === 'open' ? 'open' : 'terminal');
/** How far beside its other end an end is drawn when what it is on is gone (decision 6). */
const BESIDE = 96;

/**
 * Every wire of the circuit, drawn (plan 9 §5). Automatic tails of one source leave 16 apart round its processor
 * middle (the hub's centre), ordered by where they head; automatic heads land by the landing rule (spec §5.2);
 * slid ends sit where they were put; hub tails start on the ring; junctions sit on their host's drawn line (hosts
 * are drawn first). A wire's own bends shape its core; without them the router draws it around the blocks. Each
 * wire gets its net's family (§4), solid when both its ends are connected and the family is decided.
 */
export function routeCircuit(circuit: Readonly<Circuit>, ctx: RouteContext): WireRoute[] {
  const { placement, steps } = ctx;
  const ids = Object.keys(circuit);
  const boxes = blockBoxes(placement);
  const stepAt = (id: Id) => (steps.has(id) ? placement.steps.get(id) : undefined);
  const wire = (id: string): CircuitWire => circuit[id]!;
  const hostOf = (e: End): string | undefined => (e.on === 'wire' && Object.hasOwn(circuit, e.host) ? e.host : undefined);

  // where a wire heads: the order its source's automatic tails leave in, so they never cross (spec §5.2)
  const aim = (id: string): Point => {
    const seen = new Set<string>();
    let w: string | undefined = id;
    while (w !== undefined && !seen.has(w)) {
      seen.add(w);
      const h: End = wire(w).head;
      if (h.on === 'step') { const p = stepAt(h.step); return p ? { x: p.x, y: p.y } : { x: 0, y: 0 }; }
      if (h.on === 'open') return { x: h.x, y: h.y };
      w = hostOf(h);
    }
    return { x: 0, y: 0 };
  };
  const groups = new Map<SourceId, string[]>();
  for (const id of ids) {
    const t = wire(id).tail;
    const s = t.on === 'step' && t.y === null && stepAt(t.step) ? t.step : t.on === 'hub' && t.angle === null ? WORKFLOW_SOURCE : null;
    if (s !== null) groups.set(s, [...(groups.get(s) ?? []), id]);
  }
  const departY = new Map<string, number>(), nudge = new Map<string, number>();
  for (const [s, members] of groups) {
    const ordered = [...members].sort((a, b) => { const p = aim(a), q = aim(b); return p.y - q.y || p.x - q.x; });
    const base = s === WORKFLOW_SOURCE ? placement.sphere.cy : placement.steps.get(s)!.y + PMID;
    ordered.forEach((id, k) => { const o = offset(k, ordered.length, PORT_GAP); departY.set(id, base + o); nudge.set(id, o); });
  }

  const { cx, cy } = placement.sphere;
  /** A tail that is not on a wire; null on a step off the canvas. */
  const tailOf = (id: string): Placed | null => {
    const t = wire(id).tail;
    if (t.on === 'step') {
      const p = stepAt(t.step);
      return p ? placedAt({ x: p.x + STEP_W, y: t.y === null ? departY.get(id)! : p.y + clampLanding(t.y) }, stepBoxId(t.step)) : null;
    }
    if (t.on === 'hub') {
      if (t.angle === null) return placedAt({ x: cx + SPHERE_R, y: departY.get(id)! }, SPHERE_BOX_ID);
      const h = hubLead(cx, cy, t.angle);
      return placedAt(h.start, '', h.lead);
    }
    return t.on === 'open' ? placedAt({ x: t.x, y: t.y }) : null;
  };

  // every head on a step is an arrival (a slid one too: it keeps its slot, as in plan 4); a tail on a wire is not
  // known before its host is drawn, so it arrives bent, from the step's middle
  const arrivals: Arrival[] = [];
  for (const id of ids) {
    const h = wire(id).head;
    const p = h.on === 'step' ? stepAt(h.step) : undefined;
    if (!p || h.on !== 'step') continue;
    const t = wire(id).tail.on === 'wire' ? null : tailOf(id);
    arrivals.push(t ? { key: id, target: h.step, y: t.at.y, x: t.at.x } : { key: id, target: h.step, y: p.y + PMID, x: Infinity });
  }
  const landed = landingsOf(arrivals, placement);

  const conditionOf = (id: Id) => steps.get(id)?.entryCondition;
  const families = new Map<string, number[]>();
  for (const n of netsOf(circuit, conditionOf)) for (const w of n.wires) families.set(w, n.families);
  /** The family of the step a wire's head chain goes into: what a wire of a shorted net is drawn in (decision 10). */
  const headFamily = (id: string): number | undefined => {
    const seen = new Set<string>();
    let w: string | undefined = id;
    while (w !== undefined && !seen.has(w)) {
      seen.add(w);
      const h: End = wire(w).head;
      if (h.on === 'step') return conditionOf(h.step);
      w = hostOf(h);
    }
    return undefined;
  };

  const out = new Map<string, WireRoute>();
  const busy = new Set<string>();
  const routeOne = (id: string): WireRoute | undefined => {
    const done = out.get(id);
    if (done || busy.has(id)) return done;
    busy.add(id);
    const w = wire(id);
    const onHost = (e: End): Placed | null => {
      const host = e.on === 'wire' && e.host !== id ? hostOf(e) : undefined;
      const drawn = host === undefined ? undefined : routeOne(host);
      if (!drawn || e.on !== 'wire') return null;
      const c = contactOn(drawn.points, e.at);
      return { at: { x: c.p[0], y: c.p[1] }, box: '', lead: [], contact: c.p, vertical: c.vertical };
    };
    const tail = w.tail.on === 'wire' ? onHost(w.tail) : tailOf(id);
    let head: Placed | null = null;
    const h = w.head;
    if (h.on === 'step') {
      const p = stepAt(h.step);
      if (p) head = placedAt({ x: p.x, y: h.y === null ? landed.get(id)! : p.y + clampLanding(h.y) }, stepBoxId(h.step));
    } else if (h.on === 'open') head = placedAt({ x: h.x, y: h.y });
    else head = onHost(h);
    // an end on nothing it can be drawn on (a host gone or looping back, a step off the canvas): open beside the other end
    const T: Placed = tail ?? placedAt(head ? { x: head.at.x - BESIDE, y: head.at.y } : { x: 0, y: 0 });
    const H: Placed = head ?? placedAt({ x: T.at.x + BESIDE, y: T.at.y });

    // a junction on a level run is left and reached square-on, one jog off the line (plan 7 §5.3)
    let sy = T.at.y, lead = T.lead;
    if (T.contact && !T.vertical) { lead = [T.contact]; sy = snap(T.contact[1] + (H.at.y >= T.contact[1] ? JOG : -JOG)); }
    const sx = T.at.x;
    let tx = H.at.x, ty = H.at.y, leadIn: Pt[] = [];
    if (H.contact) { const o = ownEnds(sx, sy, H.contact, H.vertical); tx = o.ends.tx; ty = o.ends.ty; leadIn = o.tail; }
    const ends: Ends = { sx, sy, tx, ty };
    const core = w.bends && w.bends.xs.length > 0
      ? simplify(pointsOfShape(ends, w.bends))
      : T.box !== '' && H.box !== ''
        ? route(sx, sy, tx, ty, T.box, H.box, nudge.get(id) ?? 0, boxes)
        : clearPath(route(sx, sy, tx, ty, T.box, H.box, 0, boxes), boxes);
    const points = lead.length === 0 && leadIn.length === 0 ? core : simplify([...lead, ...core, ...leadIn]);

    const fam = families.get(id) ?? [];
    const short = fam.length > 1;
    const condition = short ? headFamily(id) ?? fam[0]! : fam[0] ?? null;
    const tailOn: EndKind = tail === null ? 'open' : kindOf(w.tail);
    const headOn: EndKind = head === null ? 'open' : kindOf(w.head);
    const source = tailOn !== 'terminal' ? null : w.tail.on === 'hub' ? WORKFLOW_SOURCE : w.tail.on === 'step' ? w.tail.step : null;
    const r: WireRoute = {
      id, source, target: headOn === 'terminal' && w.head.on === 'step' ? w.head.step : null,
      points, core: { ends, points: core }, condition, solid: tailOn !== 'open' && headOn !== 'open' && condition !== null,
      tailOn, headOn, short, broken: false,
    };
    busy.delete(id);
    out.set(id, r);
    return r;
  };
  for (const id of ids) routeOne(id);
  return ids.map((id) => out.get(id)!);
}

/**
 * The workflow's own wiring, routed (plan 2 §5.2): an automatic wire per entry step and next step whose two ends are
 * on the canvas; `shapes` (plan 4) give a wire bends and a slid landing by its id; `brokenEdges` mark step wires.
 */
export function routeWires(input: WiringInput, placement: Placement): WireRoute[] {
  const c = plainCircuit(input.entryStepIds, input.steps, (id) => placement.steps.has(id));
  for (const [id, s] of Object.entries(input.shapes ?? {})) {
    const w = Object.hasOwn(c, id) ? c[id] : undefined;
    if (!w || w.head.on !== 'step') continue;
    c[id] = s.bends && s.bends.xs.length > 0 ? { tail: w.tail, head: { ...w.head, y: s.landing }, bends: s.bends } : { tail: w.tail, head: { ...w.head, y: s.landing } };
  }
  return routeCircuit(c, { placement, steps: input.steps })
    .map((r) => (r.source !== null && r.source !== WORKFLOW_SOURCE && input.brokenEdges.has(r.id) ? { ...r, broken: true } : r));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/layout`
Expected: PASS (the new file, `ports.test.ts` with its old `computeLandings` tests unchanged, and every other layout test: nothing else imports `circuitRoute.ts` yet).

- [ ] **Step 5: Commit**

```bash
git add src/WorkflowStudio/src/layout/circuitRoute.ts src/WorkflowStudio/src/layout/circuitRoute.test.ts src/WorkflowStudio/src/layout/ports.ts src/WorkflowStudio/src/layout/ports.test.ts
git commit -m "feat(studio): route a circuit: hub ring contacts, slid ends, junctions, open ends, family and dash per wire (plan 9)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Drop targets, verdicts and labels

**Files:**
- Create: `src/WorkflowStudio/src/design/drop.ts`
- Test: `src/WorkflowStudio/src/design/drop.test.ts`

**Interfaces:**
- Consumes: Task 1 (`setEnd`, `snapAngle`, `plainCircuit`, `Circuit`, `End`, `Side`), Task 2 (`trace`, `linkKeys`), Task 3 (`netsOf`), Task 4 (`contactOn`), `StudioDocument` (its `wires[].points` only, which both route shapes have), `blockAt`'s node ids (`SPHERE_NODE_ID`, `CACHE_NODE_PREFIX`).
- Produces:
  - `type DropTarget = { on: 'step'; step: Id; side: 'in' | 'out'; y: number } | { on: 'hub'; angle: number } | { on: 'wire'; host: string; at: number } | { on: 'open'; x: number; y: number }`
  - `type Refusal = 'wrongSide' | 'sameStep' | 'sameWire' | 'short' | 'hubTail'`; `type Verdict = 'connect' | 'join' | 'move' | Refusal`
  - `endOf(t: DropTarget): End`
  - `judgeDrop(shown: StudioDocument, circuit: Readonly<Circuit>, id: string, side: Side, t: DropTarget): Verdict`
  - `dropLabel(v: Verdict): string`; `toneOf(v: Verdict): 'ok' | 'move' | 'no'`
  - `targetOf(doc: StudioDocument, p: Point, over: string | null, line: { id: string; at: number } | null): DropTarget`
  - `pointOfTarget(doc: StudioDocument, t: DropTarget): Point`

- [ ] **Step 1: Write the failing test**

Create `src/WorkflowStudio/src/design/drop.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { cacheDto, graphDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { plainCircuit, setEnd, type Circuit } from '../circuit/circuit';
import { contactOn } from '../layout/circuitRoute';
import { SPHERE_R, STEP_W } from '../layout/geometry';
import { dropLabel, endOf, judgeDrop, pointOfTarget, targetOf, toneOf, type DropTarget, type Verdict } from './drop';

// s1 -> s2 -> s3 (Completed) and s4 -> s5 (Failed); entries s1, s4
const doc = () => loadedDocument(graphDto({
  workflow: workflowDto({ entryStepIds: ['s1', 's4'] }),
  steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2', { nextStepIds: ['s3'] }), stepDto('s3'), stepDto('s4', { nextStepIds: ['s5'] }), stepDto('s5', { entryCondition: 2 })],
  caches: [cacheDto('c1')],
}));
const circuitOfDoc = (d: Awaited<ReturnType<typeof doc>>): Circuit => plainCircuit(d.graph.workflow.entryStepIds, d.graph.steps, (id) => d.placement.steps.has(id));
const step = (id: string, side: 'in' | 'out'): DropTarget => ({ on: 'step', step: id, side, y: 96 });
const wire = (host: string): DropTarget => ({ on: 'wire', host, at: 40 });

describe('judgeDrop (plan 9 §3, §4, §6)', () => {
  it('connects a head to a step\'s input and a tail to a step\'s output or the hub; anywhere else the end is open', async () => {
    const d = await doc(), c = circuitOfDoc(d);
    expect(judgeDrop(d, c, 's1->s2', 'head', step('s3', 'in'))).toBe('connect');
    expect(judgeDrop(d, c, 's2->s3', 'tail', step('s1', 'out'))).toBe('connect');
    expect(judgeDrop(d, c, 's2->s3', 'tail', { on: 'hub', angle: 270 })).toBe('connect');
    expect(judgeDrop(d, c, 's1->s2', 'head', { on: 'open', x: 0, y: 0 })).toBe('move');
  });

  it('refuses the wrong side, a head on the hub, and both ends on one step', async () => {
    const d = await doc(), c = circuitOfDoc(d);
    expect(judgeDrop(d, c, 's1->s2', 'head', step('s3', 'out'))).toBe('wrongSide');
    expect(judgeDrop(d, c, 's2->s3', 'tail', step('s1', 'in'))).toBe('wrongSide');
    expect(judgeDrop(d, c, 's1->s2', 'head', { on: 'hub', angle: 0 })).toBe('hubTail');
    expect(judgeDrop(d, c, 's1->s2', 'head', step('s1', 'in'))).toBe('sameStep');
  });

  it('allows a cycle through steps', async () => {
    const d = await doc(), c = circuitOfDoc(d);
    expect(judgeDrop(d, c, 's2->s3', 'head', step('s1', 'in'))).toBe('connect');
  });

  it('joins a wire of the same family; refuses its own wire and both ends on one wire', async () => {
    const d = await doc(), c = circuitOfDoc(d);
    expect(judgeDrop(d, c, 'wf->s1', 'tail', wire('s1->s2'))).toBe('sameStep');
    const tapped = setEnd(c, 's2->s3', 'tail', { on: 'wire', host: 's1->s2', at: 40 });
    expect(judgeDrop(d, c, 's2->s3', 'tail', wire('s1->s2'))).toBe('join');
    expect(judgeDrop(d, c, 's1->s2', 'head', wire('s1->s2'))).toBe('sameWire');
    expect(judgeDrop(d, tapped, 's2->s3', 'head', wire('s1->s2'))).toBe('sameWire');
  });

  it('refuses a step fed its own input through junctions (a hidden self-loop) as "same step"', async () => {
    const d = await doc(), c = circuitOfDoc(d);
    expect(judgeDrop(d, c, 's2->s3', 'head', wire('s1->s2'))).toBe('sameStep');
  });

  it('refuses a junction that closes a loop of wires as a short circuit', async () => {
    const d = await doc();
    const c = setEnd(circuitOfDoc(d), 's4->s5', 'head', { on: 'wire', host: 's1->s2', at: 40 });
    expect(judgeDrop(d, c, 's1->s2', 'head', wire('s4->s5'))).toBe('short');
  });

  it('refuses bringing two families together: a head of a decided net onto a step of another family, a tail onto a wire of another family', async () => {
    const d = await doc();
    const c = circuitOfDoc(d);
    // s2 -> s3 taps s1 -> s2: one net that s2 and s3 (Completed) decide
    const net = setEnd(c, 's2->s3', 'tail', { on: 'wire', host: 's1->s2', at: 40 });
    expect(judgeDrop(d, net, 's1->s2', 'head', step('s5', 'in'))).toBe('short');
    expect(judgeDrop(d, c, 's2->s3', 'tail', wire('s4->s5'))).toBe('short');
    // a lone wire's own head is its only decider: it may move to a step of another family
    expect(judgeDrop(d, c, 's1->s2', 'head', step('s5', 'in'))).toBe('connect');
  });

  it('labels and tones every verdict', () => {
    const all: Verdict[] = ['connect', 'join', 'move', 'wrongSide', 'sameStep', 'sameWire', 'short', 'hubTail'];
    expect(all.map(dropLabel)).toEqual(['connect here', 'join here', 'move here', 'wrong side', 'same step', 'same wire', 'short circuit', 'only a tail on the workflow']);
    expect(all.map(toneOf)).toEqual(['ok', 'ok', 'move', 'no', 'no', 'no', 'no', 'no']);
  });
});

describe('drop targets', () => {
  it('a step\'s half decides its side; the hub gives the angle round its ring; a cache or nothing leaves the end open; a line gives how far along', async () => {
    const d = await doc();
    const s2 = d.placement.steps.get('s2')!;
    const { cx, cy } = d.placement.sphere;
    expect(targetOf(d, { x: s2.x + 20, y: s2.y + 4 }, 's2', null)).toEqual({ on: 'step', step: 's2', side: 'in', y: 64 });
    expect(targetOf(d, { x: s2.x + STEP_W - 20, y: s2.y + 150 }, 's2', null)).toEqual({ on: 'step', step: 's2', side: 'out', y: 128 });
    expect(targetOf(d, { x: cx - 3, y: cy - 60 }, 'wf', null)).toEqual({ on: 'hub', angle: 270 });
    expect(targetOf(d, { x: 13, y: 21 }, 'cache:c1', null)).toEqual({ on: 'open', x: 16, y: 24 });
    expect(targetOf(d, { x: 13, y: 21 }, null, { id: 's1->s2', at: 37 })).toEqual({ on: 'wire', host: 's1->s2', at: 40 });
    expect(targetOf(d, { x: 13, y: 21 }, null, null)).toEqual({ on: 'open', x: 16, y: 24 });
  });

  it('draws a dragged end on the step side, on the ring, on the line, or where it is', async () => {
    const d = await doc();
    const s2 = d.placement.steps.get('s2')!;
    const { cx, cy } = d.placement.sphere;
    expect(pointOfTarget(d, step('s2', 'in'))).toEqual({ x: s2.x, y: s2.y + 96 });
    expect(pointOfTarget(d, step('s2', 'out'))).toEqual({ x: s2.x + STEP_W, y: s2.y + 96 });
    const top = pointOfTarget(d, { on: 'hub', angle: 270 });
    expect([Math.round(top.x), Math.round(top.y)]).toEqual([cx, cy - SPHERE_R]);
    const p = contactOn(d.wires.find((w) => w.id === 's1->s2')!.points, 40).p;
    expect(pointOfTarget(d, wire('s1->s2'))).toEqual({ x: p[0], y: p[1] });
    expect(endOf({ on: 'open', x: 8, y: 16 })).toEqual({ on: 'open', x: 8, y: 16 });
    expect(endOf(step('s2', 'in'))).toEqual({ on: 'step', step: 's2', y: 96 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/design/drop.test.ts`
Expected: FAIL (`Failed to resolve import "./drop"`).

- [ ] **Step 3: Write the implementation**

Create `src/WorkflowStudio/src/design/drop.ts`:

```ts
import type { StudioDocument } from '../app/document';
import { setEnd, snapAngle, type Circuit, type End, type Side } from '../circuit/circuit';
import { netsOf } from '../circuit/families';
import { linkKeys, trace } from '../circuit/trace';
import { contactOn } from '../layout/circuitRoute';
import { clampLanding, snap, SPHERE_R, STEP_W, type Point } from '../layout/geometry';
import { CACHE_NODE_PREFIX, SPHERE_NODE_ID } from '../layout/nodeIds';
import type { Id } from '../model/graph';

/** What a dragged end is over (plan 9 §6): a step's input or output side, the hub's ring, a wire's line, or nothing. */
export type DropTarget =
  | { on: 'step'; step: Id; side: 'in' | 'out'; y: number }
  | { on: 'hub'; angle: number }
  | { on: 'wire'; host: string; at: number }
  | { on: 'open'; x: number; y: number };

export type Refusal = 'wrongSide' | 'sameStep' | 'sameWire' | 'short' | 'hubTail';
/** `connect`: onto a terminal; `join`: onto a wire; `move`: the end is or stays open there (decision 12). */
export type Verdict = 'connect' | 'join' | 'move' | Refusal;

/** The end a drop makes. */
export function endOf(t: DropTarget): End {
  switch (t.on) {
    case 'step': return { on: 'step', step: t.step, y: t.y };
    case 'hub': return { on: 'hub', angle: t.angle };
    case 'wire': return { on: 'wire', host: t.host, at: t.at };
    case 'open': return { on: 'open', x: t.x, y: t.y };
  }
}

/**
 * What dropping wire `id`'s `side` end on `t` does (plan 9 §3, §4, §6; decision 7). Open anywhere ('move'); a step
 * side or the hub ('connect'); a wire ('join'). Refused: a head on a step's output or a tail on its input
 * ('wrongSide'), a head on the hub ('hubTail'), both ends on one step ('sameStep'), an end on its own wire or both
 * ends on one wire ('sameWire'); then a junction closing a loop of wires ('short'), a step fed its own input through
 * junctions ('sameStep'), and a net that would hold two families ('short'). A loop or a self-feed already there
 * before the drop does not refuse it.
 */
export function judgeDrop(shown: StudioDocument, circuit: Readonly<Circuit>, id: string, side: Side, t: DropTarget): Verdict {
  if (!Object.hasOwn(circuit, id) || t.on === 'open') return 'move';
  const w = circuit[id]!;
  const other = side === 'tail' ? w.head : w.tail;
  if (t.on === 'hub') {
    if (side === 'head') return 'hubTail';
  } else if (t.on === 'step') {
    if ((side === 'head') !== (t.side === 'in')) return 'wrongSide';
    if (other.on === 'step' && other.step === t.step) return 'sameStep';
  } else {
    if (t.host === id || (other.on === 'wire' && other.host === t.host)) return 'sameWire';
    if (!Object.hasOwn(circuit, t.host)) return 'move';
  }
  const after = setEnd(circuit, id, side, endOf(t));
  const before = trace(circuit), next = trace(after);
  if (next.loop && !before.loop) return 'short';
  const was = linkKeys(before.links);
  for (const k of linkKeys(next.links)) {
    const at = k.indexOf('->');
    if (k.slice(0, at) === k.slice(at + 2) && !was.has(k)) return 'sameStep';
  }
  const net = netsOf(after, (s) => shown.graph.steps.get(s)?.entryCondition).find((n) => n.wires.includes(id));
  if (net && net.families.length > 1) return 'short';
  return t.on === 'wire' ? 'join' : 'connect';
}

/** The label next to the pointer while an end is dragged (plan 9 §6). */
export function dropLabel(v: Verdict): string {
  switch (v) {
    case 'connect': return 'connect here';
    case 'join': return 'join here';
    case 'move': return 'move here';
    case 'wrongSide': return 'wrong side';
    case 'sameStep': return 'same step';
    case 'sameWire': return 'same wire';
    case 'short': return 'short circuit';
    case 'hubTail': return 'only a tail on the workflow';
  }
}

/** Green when the drop connects or joins, grey when the end is or stays open, red when it snaps back. */
export const toneOf = (v: Verdict): 'ok' | 'move' | 'no' => (v === 'connect' || v === 'join' ? 'ok' : v === 'move' ? 'move' : 'no');

/**
 * What the pointer at `p` is over (decision 5): `over` is the block `blockAt` found (node id), `line` the wire `wireAt`
 * found when there is no block. A step's left half is its input side, its right half its output side, the height
 * along it clamped and snapped (spec §4.2); the hub gives the angle round its ring (snapped to 15°); a junction's
 * distance along its host is snapped to 8 px; a cache or nothing leaves the end open there, snapped.
 */
export function targetOf(doc: StudioDocument, p: Point, over: string | null, line: { id: string; at: number } | null): DropTarget {
  if (over === SPHERE_NODE_ID) {
    const { cx, cy } = doc.placement.sphere;
    return { on: 'hub', angle: snapAngle((Math.atan2(p.y - cy, p.x - cx) * 180) / Math.PI) };
  }
  const at = over !== null && !over.startsWith(CACHE_NODE_PREFIX) ? doc.placement.steps.get(over) : undefined;
  if (over !== null && at) return { on: 'step', step: over, side: p.x < at.x + STEP_W / 2 ? 'in' : 'out', y: clampLanding(p.y - at.y) };
  if (over === null && line) return { on: 'wire', host: line.id, at: snap(line.at) };
  return { on: 'open', x: snap(p.x), y: snap(p.y) };
}

/** Where a dragged end is drawn over its target: on the step's side, on the hub's ring, on the host's line, or where it is. */
export function pointOfTarget(doc: StudioDocument, t: DropTarget): Point {
  switch (t.on) {
    case 'step': {
      const at = doc.placement.steps.get(t.step);
      return at ? { x: t.side === 'in' ? at.x : at.x + STEP_W, y: at.y + t.y } : { x: 0, y: 0 };
    }
    case 'hub': {
      const r = (t.angle * Math.PI) / 180;
      const { cx, cy } = doc.placement.sphere;
      return { x: cx + SPHERE_R * Math.cos(r), y: cy + SPHERE_R * Math.sin(r) };
    }
    case 'wire': {
      const host = doc.wires.find((w) => w.id === t.host);
      if (!host) return { x: 0, y: 0 };
      const [x, y] = contactOn(host.points, t.at).p;
      return { x, y };
    }
    case 'open': return { x: t.x, y: t.y };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/design/drop.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/WorkflowStudio/src/design/drop.ts src/WorkflowStudio/src/design/drop.test.ts
git commit -m "feat(studio): drop targets and verdicts for wire ends: connect, join, move, and the circuit's refusals (plan 9)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Settling a circuit against the workflow

**Files:**
- Create: `src/WorkflowStudio/src/design/settle.ts`
- Test: `src/WorkflowStudio/src/design/settle.test.ts`

**Interfaces:**
- Consumes: Task 1 (`plainWireId`, `removeCircuitWires`, `setEnd`, `Circuit`, `End`, `Side`), Task 2 (`trace`, `linkKeys`, `wiresBetween`), Task 3 (`netsOf`, `shortedWires`), Task 4 (`routeCircuit`).
- Produces (Task 7 adds `settleDraft` and `settleDesign` to this file):
  - `expectedLinks(saved: StudioDocument, next: Readonly<Record<Id, Id[]>>, entries: readonly Id[] | null): Set<string>`
  - `reconcile(start: Readonly<Circuit>, expected: ReadonlySet<string>, saved: StudioDocument): Circuit`

- [ ] **Step 1: Write the failing test**

Create `src/WorkflowStudio/src/design/settle.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { graphDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { plainCircuit, type Circuit, type End } from '../circuit/circuit';
import { expectedLinks, reconcile } from './settle';

const at = (step: string): End => ({ on: 'step', step, y: null });
const on = (host: string, d: number): End => ({ on: 'wire', host, at: d });
const plainOf = (d: Awaited<ReturnType<typeof loadedDocument>>): Circuit => plainCircuit(d.graph.workflow.entryStepIds, d.graph.steps, (id) => d.placement.steps.has(id));

describe('expectedLinks (plan 9 §7)', () => {
  it('is the saved lists with the design\'s own over them, both ends on the canvas', async () => {
    const d = await loadedDocument(graphDto({ workflow: workflowDto({ entryStepIds: ['s1'] }), steps: [stepDto('s1', { nextStepIds: ['s2', 'gone'] }), stepDto('s2')] }));
    expect([...expectedLinks(d, {}, null)].sort()).toEqual(['s1->s2', 'wf->s1']);
    expect([...expectedLinks(d, { s1: [] }, ['s1', 's2'])].sort()).toEqual(['wf->s1', 'wf->s2']);
  });
});

describe('reconcile (plan 9 §7, §8; decision 6)', () => {
  it('leaves a circuit that makes exactly the expected links as it is, its junctions included', async () => {
    const d = await loadedDocument(graphDto({ workflow: workflowDto({ entryStepIds: ['s1'] }), steps: [stepDto('s1', { nextStepIds: ['s2', 's3'] }), stepDto('s2'), stepDto('s3')] }));
    const c: Circuit = { ...plainOf(d), 's1->s3': { tail: on('s1->s2', 40), head: at('s3') } };
    expect(reconcile(c, expectedLinks(d, {}, null), d)).toEqual(c);
  });

  it('a plan 7 junction whose host leads elsewhere goes back into its own step; a loose wire stays (Review Focus 1)', async () => {
    const d = await loadedDocument(graphDto({
      workflow: workflowDto({ entryStepIds: ['s1', 's3'] }),
      steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2'), stepDto('s3', { nextStepIds: ['s4'] }), stepDto('s4')],
    }));
    const loose = { tail: at('s1'), head: { on: 'open', x: 900, y: 64 } as End };
    const c: Circuit = { ...plainOf(d), 's3->s4': { tail: at('s3'), head: on('s1->s2', 40) }, 'w:l1': loose };
    const out = reconcile(c, expectedLinks(d, {}, null), d);
    expect(out['s3->s4']).toEqual({ tail: at('s3'), head: at('s4') });
    expect(out['w:l1']).toEqual(loose);
  });

  it('a missing link gets a new automatic wire; an unexpected plain wire goes', async () => {
    const d = await loadedDocument(graphDto({ workflow: workflowDto({ entryStepIds: ['s1'] }), steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')] }));
    const c: Circuit = { 'wf->s1': plainOf(d)['wf->s1']!, 'w:9': { tail: at('s2'), head: at('s1') } };
    const out = reconcile(c, expectedLinks(d, {}, null), d);
    expect(Object.keys(out)).toEqual(['wf->s1', 's1->s2']);
    expect(out['s1->s2']).toEqual({ tail: at('s1'), head: at('s2') });
  });

  it('an unexpected link through a junction opens that junction where it is drawn', async () => {
    const d = await loadedDocument(graphDto({ workflow: workflowDto({ entryStepIds: ['s1'] }), steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')], layout: { parked: ['s3'] } } as never), [stepDto('s3')]);
    const c: Circuit = { ...plainOf(d), 'w:x': { tail: on('s1->s2', 40), head: at('s3') } };
    const out = reconcile(c, expectedLinks(d, {}, null), d);
    expect(out['w:x']!.tail.on).toBe('open');
    expect(out['w:x']!.head).toEqual(at('s3'));
    expect(out['s1->s2']).toEqual(c['s1->s2']);
  });

  it('links through a short-circuited net are neither expected nor repaired (Review Focus 2)', async () => {
    const d = await loadedDocument(graphDto({
      workflow: workflowDto({ entryStepIds: ['s1'] }),
      steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')], layout: { parked: ['s3'] },
    } as never), [stepDto('s3', { entryCondition: 2 })]);
    const c: Circuit = { ...plainOf(d), 'w:x': { tail: on('s1->s2', 40), head: at('s3') } };
    // after a Save that left the shorted links out: s1 lists nothing
    expect(reconcile(c, expectedLinks(d, { s1: [] }, null), d)).toEqual(c);
    // a session derived before the short: s1 still lists s2 and s3
    expect(reconcile(c, expectedLinks(d, { s1: ['s2', 's3'] }, null), d)).toEqual(c);
  });

  it('a wire with an end on a step off the canvas goes; an end on a wire that is gone opens where it is drawn', async () => {
    const d = await loadedDocument(graphDto({ workflow: workflowDto({ entryStepIds: ['s1'] }), steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')] }));
    const c: Circuit = { ...plainOf(d), g: { tail: at('s1'), head: at('gone') }, y: { tail: on('nope', 10), head: at('s2') } };
    const out = reconcile(c, expectedLinks(d, {}, null), d);
    expect(Object.keys(out)).toEqual(['wf->s1', 's1->s2', 'y']);
    expect(out.y!.tail.on).toBe('open');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/design/settle.test.ts`
Expected: FAIL (`Failed to resolve import "./settle"`).

- [ ] **Step 3: Write the implementation**

Create `src/WorkflowStudio/src/design/settle.ts`:

```ts
import type { StudioDocument } from '../app/document';
import { plainWireId, removeCircuitWires, setEnd, type Circuit, type End, type Side } from '../circuit/circuit';
import { netsOf, shortedWires } from '../circuit/families';
import { linkKeys, trace, wiresBetween } from '../circuit/trace';
import { routeCircuit } from '../layout/circuitRoute';
import type { Point } from '../layout/geometry';
import { WORKFLOW_SOURCE } from '../layout/ports';
import type { Id } from '../model/graph';

const onCanvas = (saved: StudioDocument, id: Id) => saved.graph.steps.has(id) && saved.placement.steps.has(id);

/**
 * The links a design says the workflow has (plan 9 §7): the saved workflow's lists with the design's own over them
 * (`next` by step, `entries`; what a stored design or a session holds), both ends on the canvas, as `source->target`.
 */
export function expectedLinks(saved: StudioDocument, next: Readonly<Record<Id, Id[]>>, entries: readonly Id[] | null): Set<string> {
  const out = new Set<string>();
  for (const t of entries ?? saved.graph.workflow.entryStepIds) if (onCanvas(saved, t)) out.add(plainWireId(WORKFLOW_SOURCE, t));
  for (const [id, step] of saved.graph.steps) {
    if (!onCanvas(saved, id)) continue;
    for (const t of Object.hasOwn(next, id) ? next[id]! : step.nextStepIds) if (onCanvas(saved, t)) out.add(plainWireId(id, t));
  }
  return out;
}

/** Where each wire's ends are drawn, to open an end where it is. */
function drawnEnds(c: Readonly<Circuit>, saved: StudioDocument): (id: string, side: Side) => Point | null {
  const drawn = new Map(routeCircuit(c, { placement: saved.placement, steps: saved.graph.steps }).map((r) => [r.id, r.points]));
  return (id, side) => {
    const pts = drawn.get(id);
    const p = pts ? pts[side === 'tail' ? 0 : pts.length - 1] : undefined;
    return p ? { x: p[0], y: p[1] } : null;
  };
}

/** A plan 7 wire's own target: the step its id `s->t` names, when it is on the canvas. */
function ownTarget(id: string, saved: StudioDocument): Id | null {
  const at = id.indexOf('->');
  const t = at > 0 ? id.slice(at + 2) : '';
  return t !== '' && onCanvas(saved, t) ? t : null;
}

/** The chosen junction ends drawn plain: a plan 7 head back into its own step, any other end open where it is drawn. */
function plainEnds(c: Circuit, saved: StudioDocument, pick: (id: string, side: Side) => boolean): Circuit {
  const point = drawnEnds(c, saved);
  let out = c;
  for (const [id, w] of Object.entries(c)) {
    for (const side of ['tail', 'head'] as const) {
      if (w[side].on !== 'wire' || !pick(id, side)) continue;
      const own = side === 'head' ? ownTarget(id, saved) : null;
      const p = point(id, side) ?? { x: 0, y: 0 };
      out = setEnd(out, id, side, own !== null ? { on: 'step', step: own, y: null } : { on: 'open', x: p.x, y: p.y });
    }
  }
  return out;
}

/** A new automatic wire for each link (`source->target`), by that id when it is free. */
function addPlain(c: Circuit, links: readonly string[]): Circuit {
  const out = Object.assign(Object.create(null) as Circuit, c);
  for (const k of links) {
    const at = k.indexOf('->');
    const source = k.slice(0, at), target = k.slice(at + 2);
    let id = k;
    for (let n = 2; Object.hasOwn(out, id); n++) id = `${k}#${n}`;
    out[id] = { tail: source === WORKFLOW_SOURCE ? { on: 'hub', angle: null } : { on: 'step', step: source, y: null }, head: { on: 'step', step: target, y: null } };
  }
  return out;
}

/**
 * The circuit made to agree with `expected` (decision 6; spec §7 "on load", §8): wires with an end on a step that is
 * not on the canvas go and ends on a wire that is gone open where they are drawn; then, round by round, a missing
 * link is made by a plan 7 wire `s->t` with its head on a junction (back into `t`), an unexpected link has every
 * junction on its way drawn plain, a plain wire still making one goes, and what is still missing gets a new
 * automatic wire. Links through a short-circuited net count as made and are never unexpected.
 */
export function reconcile(start: Readonly<Circuit>, expected: ReadonlySet<string>, saved: StudioDocument): Circuit {
  const placed = (e: End) => e.on !== 'step' || onCanvas(saved, e.step);
  const kept = Object.assign(Object.create(null) as Circuit, Object.fromEntries(Object.entries(start).filter(([, w]) => placed(w.tail) && placed(w.head))));
  let c = plainEnds(kept, saved, (id, side) => { const e = kept[id]![side]; return e.on === 'wire' && !Object.hasOwn(kept, e.host); });
  const conditionOf = (id: Id) => saved.graph.steps.get(id)?.entryCondition;
  for (let round = 0; round < 16; round++) {
    const shorted = shortedWires(netsOf(c, conditionOf));
    const made = linkKeys(trace(c).links);
    const written = linkKeys(trace(c, shorted).links);
    const missing = [...expected].filter((k) => !made.has(k));
    const extra = [...written].filter((k) => !expected.has(k));
    if (missing.length === 0 && extra.length === 0) return c;
    const own = new Set(missing.filter((k) => Object.hasOwn(c, k) && c[k]!.head.on === 'wire'));
    if (own.size > 0) {
      c = plainEnds(c, saved, (id, side) => side === 'head' && own.has(id));
      continue;
    }
    if (extra.length > 0) {
      const onWay = new Set(extra.flatMap((k) => { const at = k.indexOf('->'); return [...wiresBetween(c, k.slice(0, at), k.slice(at + 2), shorted)]; }));
      const joined = new Set([...onWay].filter((id) => c[id]!.tail.on === 'wire' || c[id]!.head.on === 'wire'));
      c = joined.size > 0 ? plainEnds(c, saved, (id) => joined.has(id)) : removeCircuitWires(c, [...onWay], drawnEnds(c, saved));
      continue;
    }
    c = addPlain(c, missing);
  }
  return c;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/design/settle.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/WorkflowStudio/src/design/settle.ts src/WorkflowStudio/src/design/settle.test.ts
git commit -m "feat(studio): settle a circuit against the loaded workflow: plan 7 junctions drawn plain, missing links wired (plan 9)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 7: The draft and the document hold the circuit; designs settle on load

Tasks 7, 8 and 9 are one type-check unit (decision 16): run only this task's own test files here; `npx tsc -b` and the whole suite are run at the end of Task 9.

**Files:**
- Modify: `src/WorkflowStudio/src/design/draft.ts` (replace the whole file)
- Modify: `src/WorkflowStudio/src/design/apply.ts` (`applyDraft`, `applyEdits`'s router import)
- Modify: `src/WorkflowStudio/src/design/settle.ts` (append `settleDraft`, `settleDesign`)
- Modify: `src/WorkflowStudio/src/design/design.ts` (`storedDesignOf`)
- Modify: `src/WorkflowStudio/src/design/layoutDesign.ts` (replace the whole file)
- Modify: `src/WorkflowStudio/src/app/document.ts`, `src/WorkflowStudio/src/app/loadDocument.ts`
- Modify: `src/WorkflowStudio/src/layout/wires.ts` (drop what moved or went)
- Modify: `src/WorkflowStudio/src/store/studioState.ts` (`loaded`, `saveAnswered`'s stored design, `prunedPicks`)
- Test: `src/design/draft.test.ts` (replace), `src/design/apply.test.ts` (replace), `src/design/layoutDesign.test.ts` (replace), `src/design/design.test.ts`, `src/design/settle.test.ts`, `src/layout/wires.test.ts`, `src/app/loadDocument.test.ts`, `src/app/session.test.ts`, `src/app/saveDesign.test.ts`, `src/store/studioState.test.ts`

**Interfaces:**
- Consumes: Tasks 1-6.
- Produces:
  - `interface Draft { sphere: Point | null; steps: Record<Id, Point>; caches: Record<Id, Point>; next: Record<Id, Id[]>; entries: Id[] | null; wires: Circuit | null }`; `EMPTY_DRAFT`, `isEmptyDraft`, `moveBlocks`, `entriesOf`, `nextOf` (unchanged)
  - `circuitOf(saved: StudioDocument, draft: Draft): Circuit`
  - `listsOf(saved: StudioDocument, circuit: Readonly<Circuit>): { next: Map<Id, Id[]>; entries: Id[] }`
  - `withCircuit(draft: Draft, saved: StudioDocument, wires: Circuit): Draft`
  - `removeWires(draft: Draft, saved: StudioDocument, ids: readonly string[], pointOf: (id: string, side: Side) => Point | null): Draft`
  - `setShape(draft: Draft, saved: StudioDocument, id: string, shape: { bends: Bends | null; landing: number | null }): Draft`
  - `resetShape(draft: Draft, saved: StudioDocument, id: string): Draft`
  - `parseDraft(value: unknown): Draft | null`
  - Gone from `draft.ts`: `wireId`, `wireEnds`, `addWire`, `reattach`, `setShape(draft, id, shape)` (old signature), `resetRoute`, `LOOSE_PREFIX`, `addLoose`, `looseBothOf`, `looseStartOf`, `moveLoose`, `resourceLoose`, `shapeLoose`, `shapeLooseStart`, `storedBends`, `removeLoose`, `attachLoose`, `loosen`, `loosenStart`, `attachLooseStart`, `retargetLooseStart`, `loosenHead`, `loosenTail`, `connectHead`, `connectTail`, `WireShape` re-export.
  - `settle.ts`: `settleDraft(draft: Draft, saved: StudioDocument): Draft`; `settleDesign(design: Design, saved: StudioDocument): Design`
  - `layoutDesign.ts`: `interface SavedLayout { v: 2; sphere: Point; steps: Record<Id, Point>; caches: Record<Id, Point>; parked: Id[]; wires: Circuit }`; `layoutOf(shown: StudioDocument, draft: Draft): SavedLayout`
  - `StudioDocument { graph; parkedIds; placement; wires: WireRoute[] }` (no `loose`; `WireRoute` from `layout/circuitRoute.ts`)

- [ ] **Step 1: Write the failing tests**

Replace `src/WorkflowStudio/src/design/draft.test.ts` with:

```ts
import { describe, expect, it } from 'vitest';
import { graphDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { addCircuitWire, setEnd } from '../circuit/circuit';
import { circuitOf, EMPTY_DRAFT, isEmptyDraft, listsOf, moveBlocks, parseDraft, removeWires, resetShape, setShape, withCircuit } from './draft';

const chain = () => loadedDocument(graphDto({
  workflow: workflowDto({ entryStepIds: ['s1'] }),
  steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2', { nextStepIds: ['s3'] }), stepDto('s3')],
}));
const at = (step: string) => ({ on: 'step' as const, step, y: null });

describe('draft', () => {
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

  it('with no circuit of its own shows the saved workflow\'s wires, automatic', async () => {
    const saved = await chain();
    expect(Object.keys(circuitOf(saved, EMPTY_DRAFT))).toEqual(['wf->s1', 's1->s2', 's2->s3']);
    expect(listsOf(saved, circuitOf(saved, EMPTY_DRAFT)).entries).toEqual(['s1']);
  });

  it('derives the lists from the circuit, keeping only those that differ from the saved workflow (plan 9 §7)', async () => {
    const saved = await chain();
    // s2 -> s3 taps s1 -> s2: s1's current reaches s2 and s3; s2 feeds nothing
    const d = withCircuit(EMPTY_DRAFT, saved, setEnd(circuitOf(saved, EMPTY_DRAFT), 's2->s3', 'tail', { on: 'wire', host: 's1->s2', at: 40 }));
    expect(d.next).toEqual({ s1: ['s2', 's3'], s2: [] });
    expect(d.entries).toBeNull();
    const back = withCircuit(d, saved, circuitOf(saved, EMPTY_DRAFT));
    expect([back.next, back.entries]).toEqual([{}, null]);
  });

  it('an entry list follows a tail on the hub', async () => {
    const saved = await chain();
    const d = withCircuit(EMPTY_DRAFT, saved, setEnd(circuitOf(saved, EMPTY_DRAFT), 's2->s3', 'tail', { on: 'hub', angle: 90 }));
    expect(d.entries).toEqual(['s1', 's3']);
    expect(d.next).toEqual({ s2: [] });
  });

  it('removing a wire takes its links away; a wire joined on it keeps its place, open', async () => {
    const saved = await chain();
    const joined = withCircuit(EMPTY_DRAFT, saved, addCircuitWire(circuitOf(saved, EMPTY_DRAFT), 'w:1', { tail: at('s3'), head: { on: 'wire', host: 's1->s2', at: 40 } }));
    const d = removeWires(joined, saved, ['s1->s2'], () => ({ x: 400, y: 120 }));
    expect(d.next).toEqual({ s1: [] });
    expect(d.wires!['w:1']!.head).toEqual({ on: 'open', x: 400, y: 120 });
    expect(removeWires(EMPTY_DRAFT, saved, ['gone'], () => null)).toBe(EMPTY_DRAFT);
  });

  it('a shape sets a wire\'s bends and its head\'s height; Reset route makes it automatic, keeping what it is connected to', async () => {
    const saved = await chain();
    const d = setShape(EMPTY_DRAFT, saved, 's1->s2', { bends: { xs: [600], ys: [] }, landing: 80 });
    expect(d.wires!['s1->s2']).toEqual({ tail: at('s1'), head: { on: 'step', step: 's2', y: 80 }, bends: { xs: [600], ys: [] } });
    expect(d.next).toEqual({});
    expect(resetShape(d, saved, 's1->s2').wires!['s1->s2']).toEqual({ tail: at('s1'), head: at('s2') });
    expect(resetShape(EMPTY_DRAFT, saved, 's1->s2')).toBe(EMPTY_DRAFT);
    expect([isEmptyDraft(EMPTY_DRAFT), isEmptyDraft(d)]).toEqual([true, false]);
  });

  it('parses its own JSON and drops what is not its shape', async () => {
    const saved = await chain();
    const d = setShape(EMPTY_DRAFT, saved, 's1->s2', { bends: { xs: [8, 16], ys: [40] }, landing: null });
    expect(parseDraft(JSON.parse(JSON.stringify(d)))).toEqual(d);
    expect(parseDraft('nope')).toBeNull();
    expect(parseDraft({ sphere: { x: 'a' }, steps: { s1: { x: 1, y: 2 }, s2: 5 }, wires: null })).toEqual({ ...EMPTY_DRAFT, steps: { s1: { x: 1, y: 2 } } });
  });

  it('reads a plan 7 / plan 8 draft as a circuit; one that only rewired gets an empty circuit, settled on load (spec §8)', () => {
    const d = parseDraft({ next: { s1: ['s2'] }, routes: { 's1->s2': { bends: null, landing: 72, contact: null } }, loose: { l1: { source: 's1', end: { x: 8, y: 8 } } } })!;
    expect(d.wires).toEqual({ 's1->s2': { tail: at('s1'), head: { on: 'step', step: 's2', y: 72 } }, 'w:l1': { tail: at('s1'), head: { on: 'open', x: 8, y: 8 } } });
    expect(d.next).toEqual({ s1: ['s2'] });
    expect(parseDraft({ next: { s1: [] } })!.wires).toEqual({});
    expect(parseDraft({ steps: {} })!.wires).toBeNull();
  });
});
```

Replace `src/WorkflowStudio/src/design/apply.test.ts` with (its two `applyDesign` tests on entity edits are kept word for word):

```ts
import { describe, expect, it } from 'vitest';
import { assignmentDto, graphDto, processorDto, schemaDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { addCircuitWire, setEnd } from '../circuit/circuit';
import { PMID, STEP_W } from '../layout/geometry';
import { circuitOf, EMPTY_DRAFT, moveBlocks, removeWires, setShape, withCircuit, type Draft } from './draft';
import { applyDesign, applyDraft } from './apply';
import { createAssignment, EMPTY_EDITS, removeAssignment, setField } from './design';

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
    const shown = applyDraft(saved, removeWires(EMPTY_DRAFT, saved, ['s1->s2'], () => null));
    expect(shown.parkedIds).toEqual(['s2', 's3']);
    expect(shown.wires.map((w) => w.id)).toEqual(['wf->s1', 's2->s3']);
    expect(saved.parkedIds).toEqual([]);
  });

  it('rewires the shown graph from the circuit: a tail junction fans out, a tail on the hub makes an entry step (plan 9 §7)', async () => {
    const saved = await chain();
    let shown = applyDraft(saved, withCircuit(EMPTY_DRAFT, saved, setEnd(circuitOf(saved, EMPTY_DRAFT), 's2->s3', 'tail', { on: 'wire', host: 's1->s2', at: 40 })));
    expect(shown.graph.steps.get('s1')!.nextStepIds).toEqual(['s2', 's3']);
    expect(shown.graph.steps.get('s2')!.nextStepIds).toEqual([]);
    shown = applyDraft(saved, withCircuit(EMPTY_DRAFT, saved, setEnd(circuitOf(saved, EMPTY_DRAFT), 's2->s3', 'tail', { on: 'hub', angle: 180 })));
    expect(shown.graph.workflow.entryStepIds).toEqual(['s1', 's3']);
    expect(shown.wires.find((w) => w.id === 's2->s3')).toMatchObject({ source: 'wf', tailOn: 'terminal' });
  });

  it('ignores ids the saved document does not have (review focus 1)', async () => {
    const saved = await chain();
    const draft: Draft = {
      ...EMPTY_DRAFT,
      steps: { gone: { x: 0, y: 0 } },
      caches: { gone: { x: 0, y: 0 } },
      wires: { ...circuitOf(saved, EMPTY_DRAFT), 'gone->s1': { tail: { on: 'step', step: 'gone', y: null }, head: { on: 'step', step: 's1', y: null } } },
    };
    const shown = applyDraft(saved, draft);
    expect(shown.placement.steps.has('gone')).toBe(false);
    expect(shown.graph.steps.get('s1')!.nextStepIds).toEqual(['s2']);
    expect(shown.graph.workflow.entryStepIds).toEqual(['s1']);
    expect(shown.wires.find((w) => w.id === 'gone->s1')!.tailOn).toBe('open');
  });

  it('applies a manual shape by wire id', async () => {
    const saved = await chain();
    const w = saved.wires.find((x) => x.id === 's1->s2')!;
    const shown = applyDraft(saved, setShape(EMPTY_DRAFT, saved, 's1->s2', { bends: null, landing: 128 }));
    const p = shown.placement.steps.get('s2')!;
    expect(shown.wires.find((x) => x.id === 's1->s2')!.points.at(-1)).toEqual([w.points.at(-1)![0], p.y + 128]);
  });
});

describe('applyDesign (plan 8 §3.1: what the canvas, the Inspector and the panels show)', () => {
  it('lays the entity edits over the base: names, an entry condition and its wire colour, a schema copy, assignments', async () => {
    const base = await loadedDocument(graphDto({
      steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2', { entryCondition: 1 })],
      processors: [processorDto('p1', { configSchemaId: 'sc1' })],
      schemas: [schemaDto('sc1')],
      assignments: [assignmentDto('a1', { stepId: 's2' })],
    }));
    let edits = setField(EMPTY_EDITS, { kind: 'step', id: 's2' }, stepDto('s2'), 'entryCondition', 2, () => 'x');
    edits = setField(edits, { kind: 'workflow' }, workflowDto(), 'name', 'renamed', () => 'x');
    edits = setField(edits, { kind: 'schema', processorId: 'p1', slot: 'config' }, schemaDto('sc1'), 'definition', '{"type":"string"}', () => 'copy1');
    edits = createAssignment(removeAssignment(edits, 's2', { id: 'a1', updatedAt: '' }), 's1', 'step-s1', 'n1');

    const shown = applyDesign(base, EMPTY_DRAFT, edits);

    expect(shown.graph.workflow.name).toBe('renamed');
    expect(shown.graph.steps.get('s2')!.entryCondition).toBe(2);
    expect(shown.wires.find((w) => w.id === 's1->s2')!.condition).toBe(2);
    expect(shown.graph.processors.get('p1')!.configSchemaId).toBe('copy1');
    expect(shown.graph.schemas.get('copy1')!.name).toBe('schema-sc1');
    expect(shown.graph.assignments.map((a) => a.id)).toEqual(['n1']);
    expect(base.graph.workflow.name).toBe('orders'); // the base is untouched
  });

  it('gives back the base itself when nothing is designed', async () => {
    const base = await loadedDocument();
    expect(applyDesign(base, EMPTY_DRAFT, EMPTY_EDITS)).toBe(base);
  });

  it('draws a wire open at its head from its source\'s port to its open end, grey and dashed; it is never part of the wiring', async () => {
    const base = await loadedDocument(graphDto({ steps: [stepDto('s1')] }));
    const at = base.placement.steps.get('s1')!;
    const draft = withCircuit(EMPTY_DRAFT, base, addCircuitWire(circuitOf(base, EMPTY_DRAFT), 'w:l1', { tail: { on: 'step', step: 's1', y: null }, head: { on: 'open', x: at.x + 600, y: at.y + 240 } }));
    const shown = applyDesign(base, draft, EMPTY_EDITS);
    const l1 = shown.wires.find((w) => w.id === 'w:l1')!;
    expect(l1.points[0]).toEqual([at.x + STEP_W, at.y + PMID]);
    expect(l1.points.at(-1)).toEqual([at.x + 600, at.y + 240]);
    expect(l1).toMatchObject({ condition: null, solid: false, headOn: 'open' });
    expect(shown.graph.steps.get('s1')!.nextStepIds).toEqual([]);
  });
});
```

Replace `src/WorkflowStudio/src/design/layoutDesign.test.ts` with:

```ts
import { describe, expect, it } from 'vitest';
import { graphDto, stepDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { addCircuitWire } from '../circuit/circuit';
import { applyDraft } from './apply';
import { storedDesignOf } from './design';
import { circuitOf, EMPTY_DRAFT, setShape, withCircuit } from './draft';
import { layoutOf } from './layoutDesign';

const two = () => loadedDocument(graphDto({ steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')] }));

describe('layoutOf (plan 9 §7)', () => {
  it('writes every block where it is shown, every canvas step as parked, and the whole circuit (version 2)', async () => {
    const base = await two();
    const open = withCircuit(EMPTY_DRAFT, base, addCircuitWire(circuitOf(base, EMPTY_DRAFT), 'w:l1', { tail: { on: 'step', step: 's1', y: null }, head: { on: 'open', x: 900, y: 64 } }));
    const draft = setShape(open, base, 's1->s2', { bends: null, landing: 72 });
    const layout = layoutOf(applyDraft(base, draft), draft);
    expect(layout.v).toBe(2);
    expect([...layout.parked].sort()).toEqual(['s1', 's2']);
    expect(Object.keys(layout.wires)).toEqual(['wf->s1', 's1->s2', 'w:l1']);
    expect(layout.wires['s1->s2']!.head).toEqual({ on: 'step', step: 's2', y: 72 });
    expect(layout.wires['w:l1']).toEqual({ tail: { on: 'step', step: 's1', y: null }, head: { on: 'open', x: 900, y: 64 } });
  });

  it('writes the workflow\'s own wires when the draft has no circuit; the stored design reads them back', async () => {
    const base = await two();
    const layout = layoutOf(base, EMPTY_DRAFT);
    expect(Object.keys(layout.wires)).toEqual(['wf->s1', 's1->s2']);
    expect(storedDesignOf(null, JSON.parse(JSON.stringify(layout))).draft.wires).toEqual(layout.wires);
  });
});
```

In `src/WorkflowStudio/src/design/design.test.ts`, in `describe('the stored design (plan 8 §3.1)', …)`, replace the two lines

```ts
    expect(d.draft.routes['s1->s1']).toEqual({ bends: null, landing: 24, contact: null });
    expect(d.draft.loose['l1']).toEqual({ source: 's1', end: { x: 600, y: 80 } });
```

with

```ts
    // a plan 8 layout reads as a circuit (plan 9 §8): the shape keeps its id and landing, the loose wire is `w:l1`
    expect(d.draft.wires!['s1->s1']).toEqual({ tail: { on: 'step', step: 's1', y: null }, head: { on: 'step', step: 's1', y: 24 } });
    expect(d.draft.wires!['w:l1']).toEqual({ tail: { on: 'step', step: 's1', y: null }, head: { on: 'open', x: 600, y: 80 } });
```

and append inside the same `describe`:

```ts
  it('rewired with no circuit in its layout (plan 8), it holds an empty circuit for settling to make whole', () => {
    const d = storedDesignOf({ steps: [{ id: 's1', fields: {}, nextStepIds: [] }] }, null);
    expect(d.draft.next).toEqual({ s1: [] });
    expect(d.draft.wires).toEqual({});
  });
```

Append to `src/WorkflowStudio/src/design/settle.test.ts` (add `settleDesign`, `settleDraft` to the `./settle` import, and `import { EMPTY_DRAFT, withCircuit } from './draft';`, `import { EMPTY_EDITS, setField } from './design';`):

```ts
describe('settleDraft and settleDesign', () => {
  it('leave a draft with no circuit of its own alone, and settle one against its own lists', async () => {
    const d = await loadedDocument(graphDto({ workflow: workflowDto({ entryStepIds: ['s1'] }), steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')] }));
    expect(settleDraft(EMPTY_DRAFT, d)).toBe(EMPTY_DRAFT);
    // a plan 8 session that removed s1 -> s2 and shaped nothing: an empty circuit and its lists
    const settled = settleDraft({ ...EMPTY_DRAFT, next: { s1: [] }, wires: {} }, d);
    expect(Object.keys(settled.wires!)).toEqual(['wf->s1']);
    expect(settled.next).toEqual({ s1: [] });
  });

  it('settle a design with its own entry-condition edits, so its families are the edited ones', async () => {
    const d = await loadedDocument(graphDto({ workflow: workflowDto({ entryStepIds: ['s1'] }), steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')], layout: { parked: ['s3'] } } as never), [stepDto('s3')]);
    const c = { ...plainOf(d), 'w:x': { tail: on('s1->s2', 40), head: at('s3') } };
    const draft = withCircuit(EMPTY_DRAFT, d, c);
    const edits = setField(EMPTY_EDITS, { kind: 'step', id: 's3' }, stepDto('s3'), 'entryCondition', 2, () => 'x');
    // s3 Failed in the design: the net is shorted, its links are not expected, the junction stays
    const out = settleDesign({ draft: { ...draft, next: { s1: [] } }, edits }, d);
    expect(out.draft.wires!['w:x']!.tail).toEqual(on('s1->s2', 40));
  });
});
```

In `src/WorkflowStudio/src/layout/wires.test.ts`: replace the import line

```ts
import { drawnLine, portOf, routeLoose, routeWires, routeWiring, tetherPoints, type LooseStartRoute, type WiringInput } from './wires';
```

with

```ts
import { routeWires } from './circuitRoute';
import { portOf, tetherPoints, type WiringInput } from './wires';
```

and delete the whole `describe('junctions (plan 7)', …)` block and the three `describe('routeLoose …', …)` blocks (their behaviour is in `circuitRoute.test.ts`). The remaining tests (`routeWires`, fan-out of 5, `tetherPoints`, the manual shape, `portOf`) stay as they are.

In `src/WorkflowStudio/src/app/loadDocument.test.ts` delete the line `expect(result.ok && result.value.loose).toEqual([]);`.

In `src/WorkflowStudio/src/app/session.test.ts`, in the test `writes the design and the edits only while they differ from the stored design, and restores both (plan 8 §3.2)`, replace

```ts
    s = reduce(s, { type: 'design', workflowId: 'wf1', draft: { ...EMPTY_DRAFT, loose: { l1: { source: 's1', end: { x: 8, y: 8 } } } } });
```

with

```ts
    s = reduce(s, { type: 'design', workflowId: 'wf1', draft: { ...EMPTY_DRAFT, wires: { 'w:l1': { tail: { on: 'step', step: 's1', y: null }, head: { on: 'open', x: 8, y: 8 } } } } });
```

and `expect(back.design.draft.loose['l1']).toEqual({ source: 's1', end: { x: 8, y: 8 } });` with `expect(back.design.draft.wires!['w:l1']).toEqual({ tail: { on: 'step', step: 's1', y: null }, head: { on: 'open', x: 8, y: 8 } });`.

In `src/WorkflowStudio/src/app/saveDesign.test.ts` (Save still reads `draft.next` / `draft.entries` until Task 10; they are now derived): replace `import { EMPTY_DRAFT, loosen, loosenHead, loosenStart } from '../design/draft';` with `import { circuitOf, EMPTY_DRAFT, withCircuit } from '../design/draft';` plus `import { setEnd } from '../circuit/circuit';`, and replace the three tests `never sends a loose wire as a next step, …`, `never sends a wire loose at its start: …` and `never sends a wire open at both ends; …` with:

```ts
  it('never sends a wire open at its head as a next step, and keeps it in the layout (plan 8 Review Focus 5)', async () => {
    const base = await loadedDocument(graphDto({ steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')] }));
    const draft = withCircuit(EMPTY_DRAFT, base, setEnd(circuitOf(base, EMPTY_DRAFT), 's1->s2', 'head', { on: 'open', x: 904, y: 400 }));

    const body = buildDesignRequest(base, applyDesign(base, draft, EMPTY_EDITS), { draft, edits: EMPTY_EDITS });

    expect(body.steps).toEqual([{ id: 's1', updatedAt: expect.any(String), fields: {}, nextStepIds: [] }]);
    expect(body.workflow.entryStepIds).toBeNull();
    expect(body.layout.wires['s1->s2']).toEqual({ tail: { on: 'step', step: 's1', y: null }, head: { on: 'open', x: 904, y: 400 } });
  });

  it('never sends a wire open at its tail: its step loses it, an entry wire leaves the entry list; the layout keeps both', async () => {
    const base = await loadedDocument(graphDto({
      workflow: workflowDto({ entryStepIds: ['s1', 's3'] }),
      steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2'), stepDto('s3')],
    }));
    let c = setEnd(circuitOf(base, EMPTY_DRAFT), 's1->s2', 'tail', { on: 'open', x: 304, y: 600 });
    c = setEnd(c, 'wf->s3', 'tail', { on: 'open', x: 64, y: 704 });
    const draft = withCircuit(EMPTY_DRAFT, base, c);

    const body = buildDesignRequest(base, applyDesign(base, draft, EMPTY_EDITS), { draft, edits: EMPTY_EDITS });

    expect(body.steps).toEqual([{ id: 's1', updatedAt: expect.any(String), fields: {}, nextStepIds: [] }]);
    expect(body.workflow.entryStepIds).toEqual(['s1']);
    expect(body.layout.wires['s1->s2']!.tail).toEqual({ on: 'open', x: 304, y: 600 });
    expect(body.layout.wires['wf->s3']!.tail).toEqual({ on: 'open', x: 64, y: 704 });
  });
```

In `src/WorkflowStudio/src/store/studioState.test.ts`: replace the import `import { addWire, EMPTY_DRAFT, reattach } from '../design/draft';` with

```ts
import { addCircuitWire, setEnd } from '../circuit/circuit';
import { circuitOf, EMPTY_DRAFT, withCircuit } from '../design/draft';
import { workflowDto } from '../api/fixtures';
```

(merge `workflowDto` into the existing `../api/fixtures` import instead of a second line), and replace the three tests that used `addWire` / `reattach` in `describe('undo, redo and Discard design drop picks the document no longer has', …)` with:

```ts
  const withNew = (s: StudioState) => {
    const saved = savedOf(s);
    return withCircuit(EMPTY_DRAFT, saved, addCircuitWire(circuitOf(saved, EMPTY_DRAFT), 'w:n1', { tail: { on: 'step', step: 's2', y: null }, head: { on: 'step', step: 's3', y: null } }));
  };

  it('a new wire picked, then undone: its pick is gone; redo does not bring the pick back, the wire stays pickable', async () => {
    let s = await ready();
    s = reduce(s, { type: 'design', workflowId: 'wf1', draft: withNew(s), picks: [{ kind: 'wire', id: 'w:n1' }, { kind: 'node', id: 's1' }] });
    s = reduce(s, { type: 'undo', workflowId: 'wf1' });
    expect(s.docs[0]!.picks).toEqual([{ kind: 'node', id: 's1' }]);
    s = reduce(s, { type: 'redo', workflowId: 'wf1' });
    expect(s.docs[0]!.picks).toEqual([{ kind: 'node', id: 's1' }]);
  });

  it('a wire whose end moved keeps its pick through undo: a wire never changes its id (plan 9)', async () => {
    let s = await ready();
    const saved = savedOf(s);
    const draft = withCircuit(EMPTY_DRAFT, saved, setEnd(circuitOf(saved, EMPTY_DRAFT), 's1->s3', 'tail', { on: 'step', step: 's2', y: null }));
    s = reduce(s, { type: 'design', workflowId: 'wf1', draft, picks: [{ kind: 'wire', id: 's1->s3' }] });
    s = reduce(s, { type: 'undo', workflowId: 'wf1' });
    expect(s.docs[0]!.picks).toEqual([{ kind: 'wire', id: 's1->s3' }]);
  });

  it('Discard design keeps picks that still exist (saved wires, blocks, the hub)', async () => {
    let s = await ready();
    const picks = [{ kind: 'wire', id: 'wf->s1' }, { kind: 'wire', id: 's1->s2' }, { kind: 'node', id: 'wf' }, { kind: 'node', id: 's3' }] as const;
    s = reduce(s, { type: 'design', workflowId: 'wf1', draft: withNew(s), picks: [...picks, { kind: 'wire', id: 'w:n1' }] });
    s = reduce(s, { type: 'discardDesign', workflowId: 'wf1' });
    expect(s.docs[0]!.picks).toEqual(picks);
  });
```

and append at the end of the file:

```ts
describe('opening a design (plan 9 §8)', () => {
  it('a stored plan 7 junction whose meaning differs from the loaded graph is drawn plain on load, and the design is not dirty', async () => {
    const doc4 = await loadedDocument(graphDto({
      workflow: workflowDto({ entryStepIds: ['s1', 's3'] }),
      steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2'), stepDto('s3', { nextStepIds: ['s4'] }), stepDto('s4')],
      layout: { routes: { 's3->s4': { bends: null, landing: null, contact: { host: 's1->s2', at: 40 } } } },
    } as never));
    const s = run(open('wf1'), { type: 'loaded', workflowId: 'wf1', doc: doc4 });
    const d = s.docs[0]!;
    expect(d.design.draft.wires!['s3->s4']!.head).toEqual({ on: 'step', step: 's4', y: null });
    expect(designDirty(d)).toBe(false);
    expect(canSave(d)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/design/draft.test.ts src/design/apply.test.ts src/design/layoutDesign.test.ts src/design/design.test.ts src/design/settle.test.ts src/store/studioState.test.ts`
Expected: FAIL (`circuitOf`, `withCircuit`, `settleDraft` are not exported; `layout.v` is 1; the plan 7 junction is still on its host).

- [ ] **Step 3: Write the implementation**

Replace `src/WorkflowStudio/src/design/draft.ts` with:

```ts
import type { StudioDocument } from '../app/document';
import { legacyCircuit, parseCircuit, plainCircuit, removeCircuitWires, shapedByHand, type Circuit, type CircuitWire, type End, type Side } from '../circuit/circuit';
import { circuitTrace } from '../circuit/families';
import { SPHERE_R, type Point } from '../layout/geometry';
import { CACHE_NODE_PREFIX, SPHERE_NODE_ID } from '../layout/nodeIds';
import { WORKFLOW_SOURCE } from '../layout/ports';
import type { Bends } from '../layout/shape';
import type { Id } from '../model/graph';

export type { Bends } from '../layout/shape';

/**
 * What the user changed relative to the saved workflow (spec §5.1; plan 9 §3). Positions apart from the circuit;
 * the lists are what the circuit's current gives, kept where they differ from the saved workflow's. Never sent as is.
 */
export interface Draft {
  /** The hub's centre, when moved. */
  sphere: Point | null;
  /** Top-left corners of moved steps. */
  steps: Record<Id, Point>;
  /** Top-left corners of moved cache tags. */
  caches: Record<Id, Point>;
  /** A step's whole next-step list where the circuit gives another one than the saved workflow (derived, plan 9 §7). */
  next: Record<Id, Id[]>;
  /** The hub's entry list, when the circuit gives another one (derived). */
  entries: Id[] | null;
  /** The whole circuit by wire id (plan 9 §3); null: the saved workflow's own wires, automatic. */
  wires: Circuit | null;
}

export const EMPTY_DRAFT: Draft = { sphere: null, steps: {}, caches: {}, next: {}, entries: null, wires: null };

const empty = (r: Record<string, unknown>) => Object.keys(r).length === 0;

export function isEmptyDraft(d: Draft): boolean {
  return d.sphere === null && d.entries === null && d.wires === null && empty(d.steps) && empty(d.caches) && empty(d.next);
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

/** The circuit the canvas shows: the draft's own, else the saved workflow's wires (plan 9 decision 2). */
export function circuitOf(saved: StudioDocument, draft: Draft): Circuit {
  return draft.wires ?? plainCircuit(saved.graph.workflow.entryStepIds, saved.graph.steps, (id) => saved.placement.steps.has(id));
}

/** The saved list's order first, then what is new: an unchanged list compares equal. */
function ordered(saved: readonly Id[], derived: readonly Id[]): Id[] {
  const set = new Set(derived);
  return [...saved.filter((id) => set.has(id)), ...derived.filter((id) => !saved.includes(id))];
}

/**
 * The next-step lists and the entry list the circuit's current gives (plan 9 §7), for every step of the saved
 * workflow, in its order; links through a short-circuited net are left out (§2.2-7), and so is a step it does not have.
 */
export function listsOf(saved: StudioDocument, circuit: Readonly<Circuit>): { next: Map<Id, Id[]>; entries: Id[] } {
  const { links } = circuitTrace(circuit, (id) => saved.graph.steps.get(id)?.entryCondition);
  const known = (ids: readonly Id[]) => ids.filter((id) => saved.graph.steps.has(id));
  const next = new Map<Id, Id[]>();
  for (const [id, step] of saved.graph.steps) next.set(id, ordered(step.nextStepIds, known(links.get(id) ?? [])));
  return { next, entries: ordered(saved.graph.workflow.entryStepIds, known(links.get(WORKFLOW_SOURCE) ?? [])) };
}

/** The draft with this circuit, its lists derived again (decision 2): a list equal to the saved one is left out. */
export function withCircuit(draft: Draft, saved: StudioDocument, wires: Circuit): Draft {
  const lists = listsOf(saved, wires);
  const next = copy<Id[]>({});
  for (const [id, list] of lists.next) if (!sameList(list, saved.graph.steps.get(id)?.nextStepIds ?? [])) next[id] = list;
  return { ...draft, wires, next, entries: sameList(lists.entries, saved.graph.workflow.entryStepIds) ? null : lists.entries };
}

/** Wires removed (Delete, plan 9 §6): a wire joined on one keeps its place, that end open where it is drawn (§2.2-6). */
export function removeWires(draft: Draft, saved: StudioDocument, ids: readonly string[], pointOf: (id: string, side: Side) => Point | null): Draft {
  const c = circuitOf(saved, draft);
  const next = removeCircuitWires(c, ids, pointOf);
  return next === c ? draft : withCircuit(draft, saved, next);
}

/** A wire's own route and its head's height on its step (plan 4's shape); null bends: the router draws it. */
export function setShape(draft: Draft, saved: StudioDocument, id: string, shape: { bends: Bends | null; landing: number | null }): Draft {
  const c = circuitOf(saved, draft);
  if (!Object.hasOwn(c, id)) return draft;
  const w = c[id]!;
  const head: End = w.head.on === 'step' ? { on: 'step', step: w.head.step, y: shape.landing } : w.head;
  const out = copy<CircuitWire>(c);
  out[id] = shape.bends && shape.bends.xs.length > 0 ? { tail: w.tail, head, bends: shape.bends } : { tail: w.tail, head };
  return withCircuit(draft, saved, out);
}

/** Reset route (decision 11): its bends go and its ends on steps go back to automatic heights; what it is connected to stays. */
export function resetShape(draft: Draft, saved: StudioDocument, id: string): Draft {
  const c = circuitOf(saved, draft);
  if (!Object.hasOwn(c, id) || !shapedByHand(c[id]!)) return draft;
  const w = c[id]!;
  const auto = (e: End): End => (e.on === 'step' ? { on: 'step', step: e.step, y: null } : e);
  const out = copy<CircuitWire>(c);
  out[id] = { tail: auto(w.tail), head: auto(w.head) };
  return withCircuit(draft, saved, out);
}

// ---- session parsing: anything not of the draft's shape is dropped, never an error ----

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const toPoint = (v: unknown): Point | null => (isRecord(v) && isNum(v.x) && isNum(v.y) ? { x: v.x, y: v.y } : null);
const toIds = (v: unknown): Id[] | null => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : null);

function records<T>(v: unknown, parse: (x: unknown) => T | null): Record<string, T> {
  const out = copy<T>({});
  if (!isRecord(v)) return out;
  for (const [k, raw] of Object.entries(v)) {
    const value = parse(raw);
    if (value !== null) out[k] = value;
  }
  return out;
}

/**
 * The draft a session held, or null when it is not one at all. A plan 9 draft brings its circuit; a plan 7 / plan 8
 * one its shapes and loose wires as wires (spec §8), and one that rewired steps but shaped nothing an empty circuit:
 * settling makes either whole when the workflow loads (decision 6).
 */
export function parseDraft(value: unknown): Draft | null {
  if (!isRecord(value)) return null;
  const next = records(value.next, toIds);
  const entries = toIds(value.entries);
  const wires = Object.hasOwn(value, 'wires') ? parseCircuit(value.wires) : legacyCircuit(value.routes, value.loose);
  const rewired = Object.keys(next).length > 0 || entries !== null;
  return {
    sphere: toPoint(value.sphere),
    steps: records(value.steps, toPoint),
    caches: records(value.caches, toPoint),
    next,
    entries,
    wires: wires ?? (rewired ? copy<CircuitWire>({}) : null),
  };
}
```

In `src/WorkflowStudio/src/design/apply.ts`:
- replace the import `import { routeLoose, routeWires, routeWiring } from '../layout/wires';` with `import { routeCircuit, routeWires } from '../layout/circuitRoute';`
- replace `import { isEmptyDraft, type Draft } from './draft';` with `import { circuitOf, isEmptyDraft, listsOf, type Draft } from './draft';`
- replace the whole `applyDraft` function (doc comment included) with:

```ts
/**
 * What the canvas shows (spec §5.1; plan 9 §7): the saved workflow with the draft laid over it. The circuit's current
 * gives every step's next steps and the entry steps, and so reachability and the parked steps (§3.5); moved blocks sit
 * where the draft has them (the automatic layout is not run again); every wire of the circuit is drawn again. Parts
 * naming what the saved document does not have are ignored. Pure; an empty draft gives the saved document back unchanged.
 */
export function applyDraft(saved: StudioDocument, draft: Draft): StudioDocument {
  if (isEmptyDraft(draft)) return saved;
  const { graph } = saved;
  const circuit = circuitOf(saved, draft);
  const lists = listsOf(saved, circuit);
  const steps = new Map<Id, Step>(graph.steps);
  for (const [id, next] of lists.next) steps.set(id, { ...steps.get(id)!, nextStepIds: next });
  const entryStepIds = lists.entries;
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
  return { graph: shownGraph, parkedIds, placement, wires: routeCircuit(circuit, { placement, steps }) };
}
```

(`applyEdits` keeps its `routeWires({ entryStepIds: workflow.entryStepIds, steps, brokenEdges: new Set<string>() }, base.placement)` call, now from `circuitRoute.ts`.)

Append to `src/WorkflowStudio/src/design/settle.ts` (and add these imports at its top: `import { applyEdits } from './apply';`, `import type { Design } from './design';`, `import { withCircuit, type Draft } from './draft';`):

```ts
/**
 * A draft made to agree with the workflow (decision 6): its circuit settled against what its own lists say. A draft
 * with no circuit of its own is the workflow's wiring: nothing to settle.
 */
export function settleDraft(draft: Draft, saved: StudioDocument): Draft {
  if (draft.wires === null) return draft;
  return withCircuit(draft, saved, reconcile(draft.wires, expectedLinks(saved, draft.next, draft.entries), saved));
}

/** A design as it opens (the stored one, or a session's): its draft settled against the base with its own entity edits over it. */
export function settleDesign(design: Design, saved: StudioDocument): Design {
  if (design.draft.wires === null) return design;
  return { ...design, draft: settleDraft(design.draft, applyEdits(saved, design.edits)) };
}
```

In `src/WorkflowStudio/src/design/design.ts`, `storedDesignOf`: replace its first two lines

```ts
  const shapes = parseDraft(isRecord(layout) ? { routes: layout.routes, loose: layout.loose } : {})!;
  const draft: Draft = { ...EMPTY_DRAFT, routes: shapes.routes, loose: shapes.loose, next: copy({}) };
```

with

```ts
  // a plan 9 layout holds the circuit; a plan 7 / plan 8 one its shapes and loose wires (spec §8)
  const shapes = parseDraft(isRecord(layout) ? (Object.hasOwn(layout, 'wires') ? { wires: layout.wires } : { routes: layout.routes, loose: layout.loose }) : {})!;
  const draft: Draft = { ...EMPTY_DRAFT, wires: shapes.wires, next: copy({}) };
```

and replace its last line `return { draft, edits };` (the one after the assignments loop) with

```ts
  // a stored body that rewired steps but whose layout holds no circuit (plan 8): settling makes the circuit whole
  if (draft.wires === null && (Object.keys(draft.next).length > 0 || draft.entries !== null)) draft.wires = copy({});
  return { draft, edits };
```

Also update its doc comment's second sentence to: `…read back into a design, with the circuit (or a plan 8 layout's shapes and loose wires) of the stored layout.`

Replace `src/WorkflowStudio/src/design/layoutDesign.ts` with:

```ts
import type { StudioDocument } from '../app/document';
import type { Circuit } from '../circuit/circuit';
import type { Point } from '../layout/geometry';
import type { Id } from '../model/graph';
import { circuitOf, type Draft } from './draft';

/** The canvas layout Save writes (plan 8 §4.2; plan 9 §7, decision 14): positions, every canvas step, and the whole circuit. */
export interface SavedLayout {
  v: 2;
  /** The hub's centre. */
  sphere: Point;
  steps: Record<Id, Point>;
  caches: Record<Id, Point>;
  /**
   * Every step on the canvas. GET /graph returns only the steps the real entry steps reach; after a stored
   * design wired steps in or out, the loader still finds each one here (it skips the reachable ones).
   */
  parked: Id[];
  /** Every wire by id with its ends (a terminal point, a junction's host and point, or an open point) and its bends. */
  wires: Circuit;
}

/** The layout of what the canvas shows: the draft's circuit, or the workflow's own wires when it has none. */
export function layoutOf(shown: StudioDocument, draft: Draft): SavedLayout {
  const points = (m: ReadonlyMap<Id, Point>) => Object.fromEntries([...m].map(([id, p]) => [id, { x: p.x, y: p.y }]));
  return {
    v: 2,
    sphere: { x: shown.placement.sphere.cx, y: shown.placement.sphere.cy },
    steps: points(shown.placement.steps),
    caches: points(shown.placement.caches),
    parked: [...shown.placement.steps.keys()],
    wires: { ...circuitOf(shown, draft) },
  };
}
```

Replace `src/WorkflowStudio/src/app/document.ts` with:

```ts
import type { Id, Graph } from '../model/graph';
import type { Placement } from '../layout/placement';
import type { WireRoute } from '../layout/circuitRoute';

/**
 * One opened workflow, ready to draw: the graph (unwired steps included), where every block sits, and every wire
 * of its circuit as drawn (plan 9). Opening reads with GETs only: nothing is judged on load.
 */
export interface StudioDocument {
  graph: Graph;
  /** Steps on the canvas that the entry steps do not reach. They look like every other step (plan 8). */
  parkedIds: Id[];
  placement: Placement;
  wires: WireRoute[];
}
```

In `src/WorkflowStudio/src/app/loadDocument.ts`: replace `import { routeWires } from '../layout/wires';` with `import { routeWires } from '../layout/circuitRoute';`, and `return { ok: true, value: { graph, parkedIds, placement, wires, loose: [] } };` with `return { ok: true, value: { graph, parkedIds, placement, wires } };`.

In `src/WorkflowStudio/src/layout/wires.ts` delete: the `WireRoute` and `Joint` interfaces; `LooseEnd`, `LooseStart`, `LooseBoth`, `LooseWire`, `isLooseStart`, `isLooseBoth`, `isLooseEnd`, `LooseEndRoute`, `LooseStartRoute`, `LooseBothRoute`, `LooseRoute`; `boxIdOf`; `routeWires`, `Wiring`, `routeWiring`, `joinWires`, `drawnLine`, `joinOne`, `LooseContext`, `routeLoose`, `routeLooseStart`. Keep `WiringInput`, `SPHERE_BOX_ID`, `stepBoxId`, `cacheBoxId`, `collectWires`, `portOf`, `blockBoxes`, `tetherPoints`. Its imports become:

```ts
import type { Id, Step } from '../model/graph';
import { CACHE_H, CACHE_W, PMID, SPHERE_R, STEP_H, STEP_W, type Point } from './geometry';
import type { Placement, Sphere } from './placement';
import { WORKFLOW_SOURCE, type WireEnd } from './ports';
import type { Box, Pt } from './router';
import type { WireShape } from './shape';
```

In `src/WorkflowStudio/src/store/studioState.ts`:
- imports: replace `import { EMPTY_DRAFT, entriesOf, LOOSE_PREFIX, nextOf, wireEnds, type Draft } from '../design/draft';` with `import { circuitOf, EMPTY_DRAFT, type Draft } from '../design/draft';`, add `import { settleDesign } from '../design/settle';`, and delete `import { WORKFLOW_SOURCE } from '../layout/ports';`.
- in `prunedPicks`, replace the wire part (from `if (p.id.startsWith(LOOSE_PREFIX))` to the `return (source === WORKFLOW_SOURCE …` line) so that the function reads:

```ts
function prunedPicks(d: OpenDocument, draft: Draft): Pick[] {
  if (d.status.kind !== 'ready') return d.picks;
  const saved = d.status.doc;
  const wires = circuitOf(saved, draft);
  const exists = (p: Pick): boolean => {
    if (p.kind === 'node') {
      if (p.id === SPHERE_NODE_ID) return true;
      if (p.id.startsWith(CACHE_NODE_PREFIX)) return saved.placement.caches.has(p.id.slice(CACHE_NODE_PREFIX.length));
      return saved.placement.steps.has(p.id);
    }
    // a wire keeps its id for life (plan 9): its pick stays while the circuit has it
    return Object.hasOwn(wires, p.id);
  };
  const kept = d.picks.filter(exists);
  return kept.length === d.picks.length ? d.picks : kept;
}
```

  and its doc comment's second sentence becomes `A wire pick stays while the circuit has the wire.`
- `case 'loaded':` becomes:

```ts
    case 'loaded':
      return update(state, action.workflowId, (d) => {
        const stored = settleDesign(storedDesignOf(action.doc.graph.design, action.doc.graph.layout), action.doc);
        // a refresh's unsaved edits win over the stored design (spec §3.2); a plan 8 session's wires are settled too (plan 9 §8)
        const design = d.restored
          ? { design: historyOf(settleDesign({ draft: d.design.draft, edits: d.edits }, action.doc).draft) }
          : { design: historyOf(stored.draft), edits: stored.edits };
        return { ...d, ...design, name: action.doc.graph.workflow.name, version: action.doc.graph.workflow.version, status: { kind: 'ready', doc: action.doc }, stored, restored: false };
      });
```

- in `case 'saveAnswered':` replace `const stored = action.doc ? storedDesignOf(action.doc.graph.design, action.doc.graph.layout) : designOf(d);` with `const stored = action.doc ? settleDesign(storedDesignOf(action.doc.graph.design, action.doc.graph.layout), action.doc) : designOf(d);`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/circuit src/layout src/design/draft.test.ts src/design/apply.test.ts src/design/layoutDesign.test.ts src/design/design.test.ts src/design/settle.test.ts src/design/drop.test.ts src/app/loadDocument.test.ts src/app/session.test.ts src/app/saveDesign.test.ts src/store/studioState.test.ts`
Expected: PASS. (Other files still import removed names, e.g. `useWireGestures.ts`, `toFlow.ts`: they are fixed in Tasks 8 and 9; do not run the whole suite or `tsc` yet.) Check `git diff --stat` lists only this task's files and that each replaced block really changed.

- [ ] **Step 5: Commit**

```bash
git add src/WorkflowStudio/src/design/draft.ts src/WorkflowStudio/src/design/draft.test.ts src/WorkflowStudio/src/design/apply.ts src/WorkflowStudio/src/design/apply.test.ts src/WorkflowStudio/src/design/settle.ts src/WorkflowStudio/src/design/settle.test.ts src/WorkflowStudio/src/design/design.ts src/WorkflowStudio/src/design/design.test.ts src/WorkflowStudio/src/design/layoutDesign.ts src/WorkflowStudio/src/design/layoutDesign.test.ts src/WorkflowStudio/src/app/document.ts src/WorkflowStudio/src/app/loadDocument.ts src/WorkflowStudio/src/app/loadDocument.test.ts src/WorkflowStudio/src/app/session.test.ts src/WorkflowStudio/src/app/saveDesign.test.ts src/WorkflowStudio/src/layout/wires.ts src/WorkflowStudio/src/layout/wires.test.ts src/WorkflowStudio/src/store/studioState.ts src/WorkflowStudio/src/store/studioState.test.ts
git commit -m "feat(studio): the draft holds the circuit, lists derived from it; designs settle on load; layout v2 (plan 9, type-check unit with the next two)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 8: Drawing wires as the circuit: dashes, ends, families, the legend

Part of the Tasks 7-9 type-check unit (decision 16).

**Files:**
- Modify: `src/WorkflowStudio/src/canvas/toFlow.ts`
- Modify: `src/WorkflowStudio/src/canvas/edges/CableEdge.tsx` (replace the whole file)
- Modify: `src/WorkflowStudio/src/canvas/Legend.tsx` (replace the whole file)
- Modify: `src/WorkflowStudio/src/canvas/art.css`
- Test: `src/canvas/toFlow.test.ts`, `src/canvas/edges/CableEdge.test.tsx`, `src/canvas/Legend.test.tsx`

**Interfaces:**
- Consumes: Task 4 (`WireRoute`, `EndKind`), Task 7 (`StudioDocument.wires`, no `loose`).
- Produces:
  - `CableEdgeData = { points: Pt[]; colour: string; broken: boolean; delay: number; picked?: boolean; halo?: 'ok' | 'no'; dashed?: boolean; tailOn?: EndKind; headOn?: EndKind; short?: boolean }` (`branch`, `joints`, `loose`, `openStart`, `openBoth` gone)
  - `UNDECIDED_COLOUR = '#8A97A8'` (replaces `LOOSE_COLOUR`)
  - `arrowHead(prev: Pt, tip: Pt): string`
  - Every wire is one cable edge with the wire's id; a wire on no terminal hangs on the hub node (target handle `loose`, kept).
  - CSS classes: `.wire.dashed`, `circle.nx-joint.short`; legend `.lg-ring`, `.lg-undecided`, `.lg-arrow`, `.lg-line`, `.lg-short`.

- [ ] **Step 1: Write the failing tests**

In `src/WorkflowStudio/src/canvas/toFlow.test.ts`:
- add imports `import type { WireRoute } from '../layout/circuitRoute';` and `import { UNDECIDED_COLOUR } from './edges/CableEdge';`;
- in `doc()`, replace the `wires: [ … ], loose: [],` part with:

```ts
    wires: [
      { id: 'wf->a', source: 'wf', target: 'a', points: [[224, 128], [288, 128]], core: { ends: { sx: 224, sy: 128, tx: 288, ty: 128 }, points: [[224, 128], [288, 128]] }, condition: 1, solid: true, tailOn: 'terminal', headOn: 'terminal', short: false, broken: false },
      { id: 'a->b', source: 'a', target: 'b', points: [[512, 128], [576, 128]], core: { ends: { sx: 512, sy: 128, tx: 576, ty: 128 }, points: [[512, 128], [576, 128]] }, condition: 2, solid: true, tailOn: 'terminal', headOn: 'terminal', short: false, broken: true },
    ],
```

- in `turns wires into cable edges carrying their points, colour and broken flag`, replace the `expect(ab.data).toEqual(…)` line with

```ts
    expect(ab.data).toEqual({ points: [[512, 128], [576, 128]], colour: '#FF7A66', broken: true, delay: -0.41, dashed: false, tailOn: 'terminal', headOn: 'terminal', short: false });
```

- delete the three tests `draws each loose wire as a loose cable edge on its source node; the hub can hold one (plan 8 §5)`, `draws a wire loose at its start in its target colour, …` and `draws a wire open at both ends grey, on the hub, open at both ends`, and add in their place:

```ts
  it('draws every wire of the circuit as a cable edge with its family, dash and end kinds; a wire on no terminal hangs on the hub (plan 9 §5)', () => {
    const route = (over: Partial<WireRoute>): WireRoute => ({
      id: 'x', source: null, target: null, points: [[0, 0], [64, 0]], core: { ends: { sx: 0, sy: 0, tx: 64, ty: 0 }, points: [[0, 0], [64, 0]] },
      condition: null, solid: false, tailOn: 'open', headOn: 'open', short: false, broken: false, ...over,
    });
    const d: StudioDocument = { ...doc(), wires: [
      route({ id: 'w:1' }),
      route({ id: 'w:2', source: 'a', tailOn: 'terminal', headOn: 'junction', condition: 2, short: true }),
      route({ id: 'w:3', target: 'b', tailOn: 'junction', headOn: 'terminal', condition: 2, solid: true }),
    ] };
    const { edges } = toFlow(d, fitter);
    const e = (id: string) => edges.find((x) => x.id === id)!;
    expect([e('w:1').source, e('w:1').target, e('w:1').targetHandle]).toEqual([SPHERE_NODE_ID, SPHERE_NODE_ID, 'loose']);
    expect(e('w:1').data).toMatchObject({ colour: UNDECIDED_COLOUR, dashed: true, tailOn: 'open', headOn: 'open' });
    expect([e('w:2').source, e('w:2').target, e('w:2').targetHandle]).toEqual(['a', 'a', 'in']);
    expect(e('w:2').data).toMatchObject({ colour: '#FF7A66', short: true, headOn: 'junction', dashed: true });
    expect([e('w:3').source, e('w:3').target, e('w:3').targetHandle]).toEqual(['b', 'b', 'in']);
    expect(e('w:3').data).toMatchObject({ dashed: false, tailOn: 'junction' });
  });
```

In `src/WorkflowStudio/src/canvas/edges/CableEdge.test.tsx`: change the import to `import { arrowHead, CableEdgeView } from './CableEdge';` and replace the last test (`draws a loose wire grey and dashed, …`) with:

```tsx
  it('draws a junction end as a filled circle, no ring or arrow head there; a short circuit\'s red (plan 9 §5)', () => {
    const { container } = render(<svg><CableEdgeView points={[[0, 8], [64, 8], [64, 40]]} colour="#2DD4BF" broken={false} delay={0} flowing tailOn="junction" headOn="terminal" /></svg>);
    expect(container.querySelector('circle.nx-src')).toBeNull();
    const dot = container.querySelector('circle.nx-joint')!;
    expect([dot.getAttribute('cx'), dot.getAttribute('cy')]).toEqual(['0', '8']);
    expect(container.querySelector('.nx-head')).not.toBeNull();
    const head = render(<svg><CableEdgeView points={[[0, 8], [64, 8]]} colour="#2DD4BF" broken={false} delay={0} flowing={false} headOn="junction" short /></svg>);
    expect(head.container.querySelector('.nx-head')).toBeNull();
    expect(head.container.querySelector('circle.nx-joint.short')).not.toBeNull();
    expect(head.container.querySelector('circle.nx-src')).not.toBeNull();
  });

  it('dashes a wire that is not solid and never pulses it; open ends keep the ring and the arrow head, no open circle (plan 9 §5)', () => {
    const { container } = render(<svg><CableEdgeView points={[[0, 8], [64, 8]]} colour="#8A97A8" broken={false} delay={0} flowing dashed tailOn="open" headOn="open" /></svg>);
    expect(container.querySelector('.wire')!.classList.contains('dashed')).toBe(true);
    expect(container.querySelector('.nx-pulse')).toBeNull();
    expect(container.querySelector('circle.nx-src')).not.toBeNull();
    expect(container.querySelector('.nx-head')).not.toBeNull();
    expect(container.querySelector('circle.nx-open')).toBeNull();
  });

  it('points an arrow head along the last run, whichever way it runs', () => {
    expect(arrowHead([0, 8], [64, 8])).toBe('M55 2L64 8L55 14');
    expect(arrowHead([64, 0], [64, 40])).toBe('M70 31L64 40L58 31');
    expect(arrowHead([64, 8], [64, 8])).toBe('M55 2L64 8L55 14');
  });
```

In `src/WorkflowStudio/src/canvas/Legend.test.tsx`: in the first test change `toHaveLength(CONDITIONS.length + 1)` to `toHaveLength(CONDITIONS.length + 2)`, and replace the second test with:

```tsx
  it('shows the undecided wire (grey, dashed, a ring and an arrow head) and the short circuit; no loose wire, nothing broken or parked (plan 9 §5)', () => {
    const { getByText, queryByText, container } = render(<Legend />);
    const undecided = getByText('undecided').closest('.lg-item')!;
    expect(undecided.querySelector('.lg-undecided')).not.toBeNull();
    expect(undecided.querySelector('.lg-ring')).not.toBeNull();
    expect(undecided.querySelector('.lg-arrow')).not.toBeNull();
    expect(getByText('short circuit').closest('.lg-item')!.querySelector('.lg-short')).not.toBeNull();
    expect(container.querySelector('.lg-open')).toBeNull();
    expect(queryByText(/loose/)).toBeNull();
    expect(queryByText('broken')).toBeNull();
    expect(queryByText('parked')).toBeNull();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/canvas/toFlow.test.ts src/canvas/edges/CableEdge.test.tsx src/canvas/Legend.test.tsx`
Expected: FAIL (`arrowHead` is not exported; edge data has no `dashed`; the legend has no "undecided").

- [ ] **Step 3: Write the implementation**

In `src/WorkflowStudio/src/canvas/toFlow.ts`:
- imports: replace `import { tetherPoints, type Joint } from '../layout/wires';` with `import { tetherPoints } from '../layout/wires';`; delete `import { LOOSE_PREFIX } from '../design/draft';`; replace `import { LOOSE_COLOUR, type CableEdgeType } from './edges/CableEdge';` with `import { UNDECIDED_COLOUR, type CableEdgeType } from './edges/CableEdge';`.
- delete `samePt` and `jointMarks`.
- replace the `ins` / `outs` loop with:

```ts
  const ins = new Map<Id, number[]>(), outs = new Map<Id, number[]>();
  for (const w of wires) {
    const last = w.points[w.points.length - 1]!, first = w.points[0]!;
    const target = w.target === null ? undefined : placement.steps.get(w.target);
    if (target) ins.set(w.target!, [...(ins.get(w.target!) ?? []), last[1] - target.y]);
    const source = w.source === null || w.source === WORKFLOW_SOURCE ? undefined : placement.steps.get(w.source);
    if (source) outs.set(w.source!, [...(outs.get(w.source!) ?? []), first[1] - source.y]);
  }
```

- replace the `const edges: StudioEdge[] = wires.map(…)` statement with:

```ts
  // every wire of the circuit (plan 9 §5): React Flow needs a node at each end, so a wire hangs on its tail's
  // terminal, else its head's step, else the hub (whose `loose` target handle takes it)
  const edges: StudioEdge[] = wires.map((w, i) => {
    const tailNode = w.source === null ? null : w.source === WORKFLOW_SOURCE ? SPHERE_NODE_ID : w.source;
    const node = tailNode ?? w.target ?? SPHERE_NODE_ID;
    return {
      id: w.id, type: 'cable', source: node, target: w.target ?? node,
      sourceHandle: 'out', targetHandle: w.target === null && node === SPHERE_NODE_ID ? 'loose' : 'in', selectable: false, focusable: false,
      // the gallery staggers its pulses by 0.41 s a wire; `|| 0` keeps the first one at +0, not -0
      data: {
        points: w.points, colour: w.condition === null ? UNDECIDED_COLOUR : conditionInfo(w.condition).colour, broken: w.broken,
        delay: -Math.round(i * 41) / 100 || 0, dashed: !w.solid, tailOn: w.tailOn, headOn: w.headOn, short: w.short,
      },
    };
  });
```

- delete the whole `// loose wires (plan 8 §5) …` loop at the end of `toFlow`.
- in the hub node's handles, change the comment above `handle('loose', …)` to `// a wire on no terminal hangs on the hub: React Flow needs a target handle (plan 9)`.

Replace `src/WorkflowStudio/src/canvas/edges/CableEdge.tsx` with:

```tsx
import { useContext, useId, type CSSProperties } from 'react';
import type { Edge, EdgeProps } from '@xyflow/react';
import { DesignContext } from '../../design/DesignContext';
import type { EndKind } from '../../layout/circuitRoute';
import type { Pt } from '../../layout/router';
import { useLiveArt } from '../liveArt';
import { longestSegmentMiddle, pathOf } from '../svgPath';

export type CableEdgeData = {
  points: Pt[];
  colour: string;
  broken: boolean;
  /** The pulse's animation delay in seconds (≤ 0), so the wires do not pulse in step. */
  delay: number;
  /** Picked in design mode (plan 4): drawn with a halo. */
  picked?: boolean;
  /** The line under a dragged wire end (plan 7, plan 9 §6): green when the end may join it, red when refused. */
  halo?: 'ok' | 'no';
  /** Not solid (plan 9 §5): an end open, or the family undecided. */
  dashed?: boolean;
  /** What each end is on; absent: a terminal. */
  tailOn?: EndKind;
  headOn?: EndKind;
  /** In a short circuit (§2.2-7): its junction circles are red. */
  short?: boolean;
};
export type CableEdgeType = Edge<CableEdgeData, 'cable'>;

/** An undecided wire's colour: grey, of no entry condition (plan 9 rule 12). */
export const UNDECIDED_COLOUR = '#8A97A8';

/** An open chevron whose tip is `tip`, pointing along the run from `prev` (a run of no length points right). */
export function arrowHead(prev: Pt, tip: Pt): string {
  const dx = tip[0] - prev[0], dy = tip[1] - prev[1];
  const len = Math.hypot(dx, dy);
  const ux = len === 0 ? 1 : dx / len, uy = len === 0 ? 0 : dy / len;
  const bx = tip[0] - 9 * ux, by = tip[1] - 9 * uy;
  return `M${bx + 6 * uy} ${by - 6 * ux}L${tip[0]} ${tip[1]}L${bx - 6 * uy} ${by + 6 * ux}`;
}

/**
 * One wire as a circuit trace (spec §5.1; plan 9 §5): right-angled, in its family's colour (grey while undecided),
 * dashed unless both its ends are connected and its family decided. Its tail has a small ring and its head an open
 * chevron, on a terminal or open alike; an end on another wire is a filled circle instead (red in a short circuit).
 * Broken: dashed, with a soft gap cut at the middle of the longest segment and ⚠ in it. While `flowing` (the workflow
 * is started) a solid wire carries a pulse toward its head.
 */
export function CableEdgeView({ points, colour, broken, delay, picked, flowing, halo, dashed, tailOn = 'terminal', headOn = 'terminal', short }: CableEdgeData & { flowing: boolean }) {
  const gap = `nxgap${useId().replace(/[^\w-]/g, '')}`;
  const d = pathOf(points);
  const first = points[0]!, tip = points[points.length - 1]!;
  const mark = broken ? longestSegmentMiddle(points) : null;
  const dot = (p: Pt) => <circle className={short ? 'nx-joint short' : 'nx-joint'} cx={p[0]} cy={p[1]} r={4.5} />;

  const trace = (
    <>
      {tailOn !== 'junction' && <circle className="nx-src" cx={first[0]} cy={first[1]} r={2.6} />}
      <path className="w" d={d} stroke={colour} />
      {headOn !== 'junction' && <path className="nx-head" d={arrowHead(points[points.length - 2] ?? tip, tip)} stroke={colour} />}
      {tailOn === 'junction' && dot(first)}
      {headOn === 'junction' && dot(tip)}
    </>
  );

  return (
    <g className={`${broken ? 'wire broken' : 'wire'}${dashed ? ' dashed' : ''}${picked ? ' picked' : ''}${halo ? ` halo-${halo}` : ''}`} style={{ '--nc': colour } as CSSProperties}>
      {mark ? (
        <>
          <defs>
            <filter id={`${gap}s`} x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation={3} /></filter>
            <mask id={gap} maskUnits="userSpaceOnUse" x={-1e5} y={-1e5} width={2e5} height={2e5}>
              <rect x={-1e5} y={-1e5} width={2e5} height={2e5} fill="#fff" />
              <rect x={mark[0] - 10} y={mark[1] - 7} width={20} height={14} rx={5} fill="#000" filter={`url(#${gap}s)`} />
            </mask>
          </defs>
          <g mask={`url(#${gap})`}>{trace}</g>
          <text className="nx-warn" x={mark[0]} y={mark[1] + 5} textAnchor="middle">⚠</text>
        </>
      ) : trace}
      {flowing && !broken && !dashed && <path className="nx-pulse" d={d} style={{ animationDelay: `${delay}s` }} />}
    </g>
  );
}

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

Replace `src/WorkflowStudio/src/canvas/Legend.tsx` with:

```tsx
import { CONDITIONS } from '../model/entryConditions';
import { ConditionMark } from './ConditionMark';

/** The colour key (spec §5.1, §5.3; plan 9 §5): the families, the undecided wire and the short circuit. */
export function Legend() {
  return (
    <div className="legend">
      {CONDITIONS.map((c) => (
        <span key={c.value} className="lg-item">
          <ConditionMark info={c} />
          {c.name}
        </span>
      ))}
      <span className="lg-item" title={'Undecided: no head on a step decides this wire\'s family yet.\nGrey and dashed; it joins any wire, and takes the colour of the first that decides.'}>
        <svg width="30" height="14" viewBox="0 0 30 14" className="lg-icon" aria-hidden="true">
          <circle className="lg-ring" cx="3" cy="7" r="2.2" />
          <path className="lg-undecided" d="M5 7H26" />
          <path className="lg-arrow" d="M21 3L26 7L21 11" />
        </svg>
        undecided
      </span>
      <span className="lg-item" title={'Short circuit: wires of two families meet at a junction.\nIts links are not written on Save; change an entry condition or move the wire.'}>
        <svg width="30" height="14" viewBox="0 0 30 14" className="lg-icon" aria-hidden="true">
          <path className="lg-line" d="M1 7H29" />
          <circle className="lg-short" cx="15" cy="7" r="3.5" />
        </svg>
        short circuit
      </span>
    </div>
  );
}
```

In `src/WorkflowStudio/src/canvas/art.css`:
- replace the two lines `.legend .lg-loose { … }` and `.legend .lg-open { … }` with:

```css
.legend .lg-ring { fill: #060c17; stroke: #8A97A8; stroke-width: 1.2; }
.legend .lg-undecided { fill: none; stroke: #8A97A8; stroke-width: 1.4; stroke-dasharray: 4 3; }
.legend .lg-arrow { fill: none; stroke: #8A97A8; stroke-width: 1.4; stroke-linejoin: miter; }
.legend .lg-line { fill: none; stroke: #5A6B86; stroke-width: 1.4; }
.legend .lg-short { fill: #F87171; stroke: #060c17; stroke-width: 1; }
```

- replace the plan 8 block (the comment `/* plan 8: a loose wire, … */` and the four rules `.wire.loose path.w`, `.wire.loose .nx-open`, `.nx-open-hit`, `.wire.halo-loose path.w`) with:

```css
/* plan 9: a wire with an open end or an undecided family is dashed and never pulses; a short circuit's junction is red */
.wire.dashed path.w { stroke-dasharray: 6 4; filter: none; }
.wire .nx-joint.short { fill: #F87171; filter: drop-shadow(0 0 3px #F87171); }
```

- change the comment above `.wire .nx-joint` to `/* a filled circle where a wire's end is on another wire's line (plan 9: a junction); never at a step */`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/canvas/toFlow.test.ts src/canvas/edges/CableEdge.test.tsx src/canvas/Legend.test.tsx`
Expected: PASS. Check `git diff` shows each CSS rule replaced (CRLF/LF).

- [ ] **Step 5: Commit**

```bash
git add src/WorkflowStudio/src/canvas/toFlow.ts src/WorkflowStudio/src/canvas/toFlow.test.ts src/WorkflowStudio/src/canvas/edges/CableEdge.tsx src/WorkflowStudio/src/canvas/edges/CableEdge.test.tsx src/WorkflowStudio/src/canvas/Legend.tsx src/WorkflowStudio/src/canvas/Legend.test.tsx src/WorkflowStudio/src/canvas/art.css
git commit -m "feat(studio): draw wires as the circuit: family colour, dashed when open or undecided, ring, arrow head or junction circle; the legend (plan 9)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 9: Editing wires as the circuit: one end drag for every end, runs, new wires, Delete

Closes the Tasks 7-9 type-check unit (decision 16): this task ends with the whole Vitest suite and `npx tsc -b` green.

**Files:**
- Modify: `src/WorkflowStudio/src/design/useWireGestures.ts` (replace the whole file)
- Modify: `src/WorkflowStudio/src/design/DesignOverlay.tsx` (replace the whole file)
- Modify: `src/WorkflowStudio/src/design/DesignContext.ts`, `src/WorkflowStudio/src/design/hit.ts`, `src/WorkflowStudio/src/design/useDesignKeys.ts`
- Modify: `src/WorkflowStudio/src/canvas/WorkflowCanvas.tsx`, `src/WorkflowStudio/src/canvas/selection.ts`, `src/WorkflowStudio/src/canvas/canvas.css`
- Modify: `src/WorkflowStudio/src/panels/Inspector.tsx` (`wireNote`)
- Delete: `src/WorkflowStudio/src/design/rules.ts`, `src/WorkflowStudio/src/design/rules.test.ts` (replaced by `drop.ts`)
- Test: `src/design/useWireGestures.test.tsx`, `src/design/hit.test.ts`, `src/canvas/WorkflowCanvas.test.tsx`, `src/canvas/selection.test.ts`, `src/panels/panes.test.tsx`

**Interfaces:**
- Consumes: Task 1 (`addCircuitWire`, `sameEnd`, `setBends`, `setEnd`, `NEW_WIRE_PREFIX`, `shapedByHand`, `End`, `Side`, `Circuit`), Task 4 (`WireRoute`), Task 5 (`DropTarget`, `Verdict`, `endOf`, `judgeDrop`, `dropLabel`, `toneOf`, `targetOf`, `pointOfTarget`), Task 7 (`circuitOf`, `withCircuit`, `removeWires`, `resetShape`).
- Produces:
  - `DropHint { id: string | null; line: boolean; tone: 'ok' | 'move' | 'no'; why: Verdict; at: Point }`; `WireGhost { wire: string | null; points: Pt[] }`
  - `useWireGestures(...)` returns `{ gestures, startSegment(wire, k, e), startEnd(wire: WireRoute, side: Side, e), ghost, hint, active, running, resize }` (no `startArrow`, no `looseAsWire`, no `freeEnd`)
  - `DesignGestures { wirePointerDown(wireId: string, e): void; portPointerDown(source: SourceId, e): void }`
  - `DesignOverlayProps.onEnd: (wire: WireRoute, side: Side, e) => void`; end squares `rect.design-handle.end[data-end="tail" | "head"]`
  - `wireAt(doc, p, tolerance, own?: { id: string; side: Side } | null)`
  - `selection.ts`: `DROP_MOVE_CLASS = 'drop-move'` (replaces `DROP_LOOSE_CLASS`); `withHint(nodes, { id; tone: 'ok' | 'move' | 'no' } | null)`

- [ ] **Step 1: Write the failing tests**

`src/WorkflowStudio/src/design/useWireGestures.test.tsx`:
- replace the import line `import { EMPTY_DRAFT, addLoose, addWire, attachLoose, attachLooseStart, loosenStart, moveBlocks, reattach, resetRoute, resourceLoose, setShape } from './draft';` with `import { circuitOf, EMPTY_DRAFT, setShape, withCircuit } from './draft';`, add `import { setEnd } from '../circuit/circuit';` and `import { lengthOf, pointAt } from '../layout/junctions';`, and delete `import type { LooseEnd } from '../layout/wires';`;
- every `setShape(EMPTY_DRAFT, 's1->s2', {…})` in the tests that stay becomes `setShape(EMPTY_DRAFT, doc, 's1->s2', {…})` (the shape objects lose any `contact` key);
- `.routes['s1->s2']!.bends` becomes `.wires!['s1->s2']!.bends` (two places);
- in `a run square shows the way its run moves, …`, replace the end-drag part (from the comment `// an end drag shows the sideways double arrow …` to the end of the test) with:

```tsx
    // an end drag shows the four-way cursor (plan 9 rule 14), not a run's double arrow
    fireEvent.pointerDown(container.querySelector('.design-handle.end[data-end="head"]')!, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    expect(canvas.classList.contains('gesture-move')).toBe(true);
    expect(canvas.classList.contains('gesture-ns')).toBe(false);
    fireEvent.pointerUp(document, { clientX: 100, clientY: 100, pointerId: 1 });
    expect(canvas.classList.contains('gesture-move')).toBe(false);
  });
```

- delete the test `a press on the branch of a joined wire never drags a run; its own line still does (plan 7)`;
- in `right-click → Reset route makes a manual wire automatic again; …`, replace `expect(design.onCommit).toHaveBeenCalledWith(EMPTY_DRAFT);` with `expect(vi.mocked(design.onCommit).mock.calls[0]![0].wires!['s1->s2']).toEqual({ tail: { on: 'step', step: 's1', y: null }, head: { on: 'step', step: 's2', y: null } });`;
- delete every test from `dragging the arrow head onto another step re-targets the wire: …` to the end of `describe('wire gestures', …)` (the plan 4/7/8 end, join and loose-wire tests, including the nested `describe` blocks), keep the closing `});` of `describe('wire gestures', …)`, and append inside it, before that closing line:

```tsx
  // ---- plan 9: every end square drags its end; the drop is judged as a circuit ----
  const four = () => loadedDocument(graphDto({
    workflow: workflowDto({ entryStepIds: ['s1', 's3'] }),
    steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2'), stepDto('s3', { nextStepIds: ['s4'] }), stepDto('s4')],
  }));
  const commits = (design: DesignProps) => vi.mocked(design.onCommit).mock.calls;
  const inputOf = (doc: StudioDocument, id: string): Point => { const at = doc.placement.steps.get(id)!; return { x: at.x + 40, y: at.y + STEP_H / 2 }; };
  const outputOf = (doc: StudioDocument, id: string): Point => { const at = doc.placement.steps.get(id)!; return { x: at.x + STEP_W - 40, y: at.y + STEP_H / 2 }; };
  const onLine = (doc: StudioDocument, id: string, f = 0.5): Point => {
    const pts = doc.wires.find((w) => w.id === id)!.points;
    const [x, y] = pointAt([pts], lengthOf([pts]) * f).p;
    return { x, y };
  };
  const EMPTY_AT = { x: 1104, y: 704 };
  const canvasOf = (doc: StudioDocument, design: DesignProps) =>
    render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
  /** Presses a picked wire's end square, moves to `to`, reads the label there, releases. */
  const dragEnd = (container: HTMLElement, id: string, side: 'tail' | 'head', to: Point) => {
    fireEvent.pointerDown(container.querySelector(`.design-wire[data-wire="${id}"] .design-handle.end[data-end="${side}"]`)!, { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, to), pointerId: 1 });
    const label = container.querySelector('.design-drop-label');
    const read = { text: label?.textContent ?? null, tone: label?.getAttribute('class') ?? '' };
    fireEvent.pointerUp(document, { ...screenOf(container, to), pointerId: 1 });
    return read;
  };

  it('a picked wire has a square on each end with the four-way cursor, kept while dragged (rule 14)', async () => {
    const doc = await two();
    const { container } = canvasOf(doc, designOf({ picks: [{ kind: 'wire', id: 's1->s2' }] }));
    expect(container.querySelectorAll('.design-wire[data-wire="s1->s2"] .design-handle.end')).toHaveLength(2);
    const canvas = container.querySelector('.studio-canvas')!;
    fireEvent.pointerDown(container.querySelector('.design-handle.end[data-end="tail"]')!, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    expect(canvas.classList.contains('gesture-move')).toBe(true);
    fireEvent.pointerUp(document, { clientX: 100, clientY: 100, pointerId: 1 });
    expect(canvas.classList.contains('gesture-move')).toBe(false);
  });

  it('a head dropped on another step\'s input connects there: green "connect here", the same wire, one step', async () => {
    const doc = await three();
    const design = designOf({ picks: [{ kind: 'wire', id: 's1->s2' }] });
    const { container } = canvasOf(doc, design);
    const to = inputOf(doc, 's3');
    const read = dragEnd(container, 's1->s2', 'head', to);
    expect(read.text).toBe('connect here');
    expect(read.tone).toContain('ok');
    const [draft, options] = commits(design)[0]!;
    expect(draft.wires!['s1->s2']!.head).toEqual({ on: 'step', step: 's3', y: clampLanding(to.y - doc.placement.steps.get('s3')!.y) });
    expect(draft.next['s1']).toEqual(['s3']);
    expect(options).toEqual({ picks: [{ kind: 'wire', id: 's1->s2' }] });
  });

  it('a head moved along its own step\'s input slides there (rule 5)', async () => {
    const doc = await two();
    const s2 = doc.placement.steps.get('s2')!;
    const design = designOf({ picks: [{ kind: 'wire', id: 's1->s2' }] });
    const { container } = canvasOf(doc, design);
    expect(dragEnd(container, 's1->s2', 'head', { x: s2.x + 20, y: s2.y + 120 }).text).toBe('connect here');
    expect(commits(design)[0]![0].wires!['s1->s2']!.head).toEqual({ on: 'step', step: 's2', y: 120 });
  });

  it('a head on a step\'s output, a tail on an input, or a head over the hub is refused in red; nothing changes', async () => {
    const doc = await three();
    const design = designOf({ picks: [{ kind: 'wire', id: 's1->s2' }, { kind: 'wire', id: 's2->s3' }] });
    const { container } = canvasOf(doc, design);
    expect(dragEnd(container, 's1->s2', 'head', outputOf(doc, 's3')).text).toBe('wrong side');
    expect(dragEnd(container, 's2->s3', 'tail', inputOf(doc, 's1')).text).toBe('wrong side');
    const { cx, cy } = doc.placement.sphere;
    const hub = dragEnd(container, 's1->s2', 'head', { x: cx, y: cy - 40 });
    expect(hub.text).toBe('only a tail on the workflow');
    expect(hub.tone).toContain('no');
    expect(design.onCommit).not.toHaveBeenCalled();
  });

  it('a tail dropped on the hub starts there, at the angle it was dropped; its step becomes an entry step (rule 1)', async () => {
    const doc = await three();
    const design = designOf({ picks: [{ kind: 'wire', id: 's2->s3' }] });
    const { container } = canvasOf(doc, design);
    const { cx, cy } = doc.placement.sphere;
    expect(dragEnd(container, 's2->s3', 'tail', { x: cx - 2, y: cy - 60 }).text).toBe('connect here');
    const [draft] = commits(design)[0]!;
    expect(draft.wires!['s2->s3']!.tail).toEqual({ on: 'hub', angle: 270 });
    expect(draft.entries).toEqual(['s1', 's3']);
  });

  it('an end released on empty canvas is open there, grey "move here"; both ends may be open', async () => {
    const doc = await two();
    const design = designOf({ picks: [{ kind: 'wire', id: 's1->s2' }] });
    const view = canvasOf(doc, design);
    const read = dragEnd(view.container, 's1->s2', 'head', EMPTY_AT);
    expect(read.text).toBe('move here');
    expect(read.tone).toContain('move');
    const [open] = commits(design)[0]!;
    expect(open.wires!['s1->s2']!.head).toEqual({ on: 'open', x: 1104, y: 704 });
    expect(open.next['s1']).toEqual([]);
    view.unmount();
    const both = designOf({ draft: open, picks: [{ kind: 'wire', id: 's1->s2' }] });
    const again = canvasOf(doc, both);
    expect(dragEnd(again.container, 's1->s2', 'tail', { x: 1104, y: 504 }).text).toBe('move here');
    expect(commits(both)[0]![0].wires!['s1->s2']!.tail).toEqual({ on: 'open', x: 1104, y: 504 });
  });

  it('a head on a wire of the same family joins it: "join here", a green halo; its current goes on into the host\'s step', async () => {
    const doc = await four();
    const design = designOf({ picks: [{ kind: 'wire', id: 's3->s4' }] });
    const { container } = canvasOf(doc, design);
    const on = onLine(doc, 's1->s2');
    fireEvent.pointerDown(container.querySelector('.design-wire[data-wire="s3->s4"] .design-handle.end[data-end="head"]')!, { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, on), pointerId: 1 });
    expect(container.querySelector('.design-drop-label')!.textContent).toBe('join here');
    expect(container.querySelector('[data-testid="rf__edge-s1->s2"] g.wire')!.getAttribute('class')).toContain('halo-ok');
    fireEvent.pointerUp(document, { ...screenOf(container, on), pointerId: 1 });
    const [draft] = commits(design)[0]!;
    expect(draft.wires!['s3->s4']!.head).toMatchObject({ on: 'wire', host: 's1->s2' });
    expect(draft.next['s3']).toEqual(['s2']);
  });

  it('a tail on a wire of another family is a short circuit: refused', async () => {
    const doc = await loadedDocument(graphDto({
      workflow: workflowDto({ entryStepIds: ['s1', 's3'] }),
      steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2'), stepDto('s3', { nextStepIds: ['s4'] }), stepDto('s4', { entryCondition: 2 })],
    }));
    const design = designOf({ picks: [{ kind: 'wire', id: 's3->s4' }] });
    const { container } = canvasOf(doc, design);
    const read = dragEnd(container, 's3->s4', 'tail', onLine(doc, 's1->s2'));
    expect(read.text).toBe('short circuit');
    expect(read.tone).toContain('no');
    expect(design.onCommit).not.toHaveBeenCalled();
  });

  it('both ends on one wire are refused: "same wire"', async () => {
    const doc = await four();
    const draft = withCircuit(EMPTY_DRAFT, doc, setEnd(circuitOf(doc, EMPTY_DRAFT), 's3->s4', 'head', { on: 'wire', host: 's1->s2', at: 40 }));
    const design = designOf({ draft, picks: [{ kind: 'wire', id: 's3->s4' }] });
    const { container } = canvasOf(doc, design);
    expect(dragEnd(container, 's3->s4', 'tail', onLine(doc, 's1->s2', 0.7)).text).toBe('same wire');
    expect(design.onCommit).not.toHaveBeenCalled();
  });

  it('a head joined where its own step would feed itself is refused: "same step"', async () => {
    const doc = await three();
    const design = designOf({ picks: [{ kind: 'wire', id: 's2->s3' }] });
    const { container } = canvasOf(doc, design);
    expect(dragEnd(container, 's2->s3', 'head', onLine(doc, 's1->s2')).text).toBe('same step');
    expect(design.onCommit).not.toHaveBeenCalled();
  });

  it('a junction that closes a loop of wires is refused: "short circuit"', async () => {
    const doc = await four();
    const draft = withCircuit(EMPTY_DRAFT, doc, setEnd(circuitOf(doc, EMPTY_DRAFT), 's3->s4', 'head', { on: 'wire', host: 's1->s2', at: 40 }));
    const design = designOf({ draft, picks: [{ kind: 'wire', id: 's1->s2' }] });
    const { container } = canvasOf(doc, design);
    expect(dragEnd(container, 's1->s2', 'head', onLine(applyDraft(doc, draft), 's3->s4', 0.4)).text).toBe('short circuit');
    expect(design.onCommit).not.toHaveBeenCalled();
  });

  it('a dragged end over its own end run is not "same wire" (Review Focus 5)', async () => {
    const doc = await two();
    const { container } = canvasOf(doc, designOf({ picks: [{ kind: 'wire', id: 's1->s2' }] }));
    const pts = doc.wires.find((x) => x.id === 's1->s2')!.points;
    const [a, b] = [pts.at(-2)!, pts.at(-1)!];
    expect(dragEnd(container, 's1->s2', 'head', { x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2 }).text).not.toBe('same wire');
  });

  it('Delete on a host leaves the wire joined on it open where it was drawn (spec §2.2-6)', async () => {
    const doc = await four();
    const draft = withCircuit(EMPTY_DRAFT, doc, setEnd(circuitOf(doc, EMPTY_DRAFT), 's3->s4', 'head', { on: 'wire', host: 's1->s2', at: 40 }));
    const design = designOf({ draft, picks: [{ kind: 'wire', id: 's1->s2' }] });
    const { container } = canvasOf(doc, design);
    const contact = applyDraft(doc, draft).wires.find((w) => w.id === 's3->s4')!.points.at(-1)!;
    fireEvent.keyDown(container.querySelector('.studio-canvas')!, { key: 'Delete' });
    const [next] = commits(design)[0]!;
    expect(Object.hasOwn(next.wires!, 's1->s2')).toBe(false);
    expect(next.wires!['s3->s4']!.head).toEqual({ on: 'open', x: contact[0], y: contact[1] });
  });

  it('a new wire from a step\'s port released on empty canvas is a grey wire open at its head, picked', async () => {
    const doc = await two();
    const design = designOf();
    const { container } = canvasOf(doc, design);
    fireEvent.pointerDown(container.querySelector('.react-flow__node[data-id="s2"] .nx-port')!, { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, EMPTY_AT), pointerId: 1 });
    expect(container.querySelector('.design-drop-label')!.textContent).toBe('move here');
    fireEvent.pointerUp(document, { ...screenOf(container, EMPTY_AT), pointerId: 1 });
    const [draft, options] = commits(design)[0]!;
    const id = Object.keys(draft.wires!).find((k) => k.startsWith('w:'))!;
    expect(draft.wires![id]).toEqual({ tail: { on: 'step', step: 's2', y: null }, head: { on: 'open', x: 1104, y: 704 } });
    expect(options).toEqual({ picks: [{ kind: 'wire', id }] });
  });
```

After these edits, delete every import of this file that `npx tsc -b` (Step 4) reports unused (for example `cacheDto`, `CACHE_H`, `CACHE_W`, `LANDING_MAX`, `LANDING_MIN`, `PMID`, `simplify`, `pointsOfShape`, `moveBlocks`), and nothing else.

`src/WorkflowStudio/src/design/hit.test.ts`: replace `expect(wireAt(doc, mid, 6, 's1->s2')).toBeNull();` with `expect(wireAt(doc, mid, 6, { id: 's1->s2', side: 'head' })).toBeNull(); // a straight wire is all its end run`, add `import { applyDraft } from './apply';` and `import { EMPTY_DRAFT, setShape } from './draft';`, and append inside `describe('wireAt (plan 7)', …)`:

```ts
  it('counts a dragged end\'s own wire, except its run at that end (plan 9; Review Focus 5)', async () => {
    const doc = await loadedDocument(graphDto({ workflow: workflowDto({ entryStepIds: ['s1'] }), steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')] }));
    const s2 = doc.placement.steps.get('s2')!;
    const shown = applyDraft(doc, setShape(EMPTY_DRAFT, doc, 's1->s2', { bends: { xs: [s2.x - 32], ys: [] }, landing: 128 }));
    const pts = shown.wires.find((w) => w.id === 's1->s2')!.points;
    const mid = (i: number) => ({ x: (pts[i]![0] + pts[i + 1]![0]) / 2, y: (pts[i]![1] + pts[i + 1]![1]) / 2 });
    const last = pts.length - 2;
    expect(wireAt(shown, mid(last), 2, { id: 's1->s2', side: 'head' })).toBeNull();
    expect(wireAt(shown, mid(0), 2, { id: 's1->s2', side: 'head' })?.id).toBe('s1->s2');
    expect(wireAt(shown, mid(0), 2, { id: 's1->s2', side: 'tail' })).toBeNull();
  });
```

`src/WorkflowStudio/src/canvas/WorkflowCanvas.test.tsx`: delete the two plan 7 tests `draws one dot when the split falls on the contact (a target behind it, plan 7)` and `draws a joined wire as its own line to a dot, a split dot and a branch with the only arrow head (plan 7)`, add `import { setEnd } from '../circuit/circuit';` and `circuitOf, withCircuit` to its `../design/draft` import (remove `setShape` / `moveBlocks` from it if tsc reports them unused), and append inside `describe('WorkflowCanvas', …)`:

```tsx
  it('draws a junction as a filled circle with no arrow head at that end; the host keeps its own (plan 9 §5)', async () => {
    const doc = await loadedDocument(graphDto({
      workflow: workflowDto({ entryStepIds: ['s1', 's3'] }),
      steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2'), stepDto('s3', { nextStepIds: ['s4'] }), stepDto('s4')],
    }));
    const draft = withCircuit(EMPTY_DRAFT, doc, setEnd(circuitOf(doc, EMPTY_DRAFT), 's3->s4', 'head', { on: 'wire', host: 's1->s2', at: 40 }));
    const design: DesignProps = { draft, picks: [], onPick: vi.fn(), onCommit: vi.fn(), onUndo: vi.fn(), onRedo: vi.fn() };
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} design={design} onSelect={vi.fn()} />);
    const edge = container.querySelector('[data-testid="rf__edge-s3->s4"]')!;
    expect(edge.querySelectorAll('circle.nx-joint')).toHaveLength(1);
    expect(edge.querySelectorAll('.nx-head')).toHaveLength(0);
    expect(edge.querySelectorAll('circle.nx-src')).toHaveLength(1);
    const host = container.querySelector('[data-testid="rf__edge-s1->s2"]')!;
    expect(host.querySelectorAll('.nx-head')).toHaveLength(1);
    expect(host.querySelectorAll('circle.nx-joint')).toHaveLength(0);
  });
```

`src/WorkflowStudio/src/canvas/selection.test.ts`: import `DROP_MOVE_CLASS` instead of `DROP_LOOSE_CLASS`; the two `tone: 'loose'` become `tone: 'move'` and `DROP_LOOSE_CLASS` becomes `DROP_MOVE_CLASS`.

`src/WorkflowStudio/src/panels/panes.test.tsx`, in `says how many items are picked, and names a picked wire (plan 4)`: replace `expect(screen.getByText('Wire: fetch_1.0.0-s1 → store_1.0.0-s2')).toBeInTheDocument();` with `expect(screen.getByText(/^Wire: fetch_1\.0\.0-s1 → store_1\.0\.0-s2 · /)).toBeInTheDocument();` (the `gone → s9` line stays).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/design/useWireGestures.test.tsx src/design/hit.test.ts src/canvas/WorkflowCanvas.test.tsx src/canvas/selection.test.ts src/panels/panes.test.tsx`
Expected: FAIL (the old gestures import names Task 7 removed; `data-end="head"` squares do not exist; `DROP_MOVE_CLASS` is not exported).

- [ ] **Step 3: Write the implementation**

Rewrite `src/WorkflowStudio/src/design/useWireGestures.ts` as below. Everything in the file is replaced except `useGesture` and its doc comment, which stay word for word at the marked place:

```ts
import { useEffect, useMemo, useRef, useState, type MutableRefObject, type PointerEvent as ReactPointerEvent } from 'react';
import { useReactFlow } from '@xyflow/react';
import type { StudioDocument } from '../app/document';
import { addCircuitWire, NEW_WIRE_PREFIX, sameEnd, setBends, setEnd, type Circuit, type End, type Side } from '../circuit/circuit';
import type { WireRoute } from '../layout/circuitRoute';
import { clearBends, clearPath, clearRun } from '../layout/detour';
import { clampLanding, PMID, STEP_W, type Point } from '../layout/geometry';
import { WORKFLOW_SOURCE, type SourceId } from '../layout/ports';
import { route, type Box, type Pt } from '../layout/router';
import { dragSegment, nearestSegment, normalize, shapeFromPoints, type Bends } from '../layout/shape';
import { blockBoxes, portOf } from '../layout/wires';
import type { DesignGestures } from './DesignContext';
import type { DesignProps } from './designProps';
import { circuitOf, withCircuit, type Draft } from './draft';
import { endOf, judgeDrop, pointOfTarget, targetOf, toneOf, type DropTarget, type Verdict } from './drop';
import { blockAt, wireAt } from './hit';
import { newId } from './ids';

/** What a dragged wire end is over (plan 9 §6): the block outlined or the line haloed (tone), the verdict, and where the pointer is, for the label. */
export interface DropHint {
  /** The block (node id) or, when `line`, the wire under the pointer; null over empty canvas. */
  id: string | null;
  /** Over a wire's line, not a block. */
  line: boolean;
  /** Green: the end connects or joins; grey: it is or stays open; red: it snaps back. */
  tone: 'ok' | 'move' | 'no';
  why: Verdict;
  /** The pointer, in flow coordinates. */
  at: Point;
}

/** A dragged end's wire, from the end that stays to the pointer; `wire` null: a new wire being drawn. */
export interface WireGhost {
  wire: string | null;
  points: Pt[];
}

/** Which run of the dragged shape is the one under the pointer (`dragSegment`'s run k of a shape with n verticals). */
function draggedRun(n: number, k: number): { vertical: boolean; index: number } {
  if (n === 0 || k === 0) return { vertical: false, index: 0 };
  return k % 2 === 1 ? { vertical: true, index: (k - 1) / 2 } : { vertical: false, index: k / 2 - 1 };
}

/** A dragged end's wire, right-angled around the blocks from the end that stays (`from`) to where the moving end is drawn. */
function ghostPath(from: Point, to: Point, side: Side, boxes: Box[]): Pt[] {
  const [a, b] = side === 'head' ? [from, to] : [to, from];
  return clearPath(route(a.x, a.y, b.x, b.y, '', '', 0, boxes), boxes);
}

/** Below this many screen pixels a press is a click, not a drag. */
const MOVE_START = 3;

/** How far outside a block's border or a line (screen px) a dragged end already counts as over it. */
const DROP_REACH = 8;

export interface Gesture {
  run: (e: ReactPointerEvent, onMove: (p: Point) => void, onEnd: (cancelled: boolean, moved: boolean) => void) => void;
  /** Drops the running gesture, if any: its listeners go and `onEnd` never runs. */
  abort: () => void;
  /** A gesture is running (read at once, not on the next render). */
  running: () => boolean;
}

// <- here stays the existing `useGesture` function with its doc comment, exactly as it is in the file today (from `export function useGesture(setActive: (on: boolean) => void): Gesture {` to its closing brace); nothing in it changes

/**
 * Editing wires (spec §4.2-§4.5; plan 9 §6): dragging a picked wire's run square, or its body, moves that run (the
 * first drag makes the wire manual, the last run slides its head); dragging either end square moves that end onto a
 * step side, the hub, another wire or nothing, as the circuit allows; dragging from a block's connection point draws
 * a new wire. Each finished drag is one history step; Escape cancels it (spec §5.3).
 */
export function useWireGestures(
  saved: StudioDocument,
  shown: MutableRefObject<StudioDocument>,
  design: DesignProps | undefined,
  setPreview: (d: Draft | null) => void,
) {
  const [active, setActive] = useState(false);
  const { run, abort, running } = useGesture(setActive);
  const { screenToFlowPosition, getZoom } = useReactFlow();
  const [ghost, setGhost] = useState<WireGhost | null>(null);
  const [hint, setHint] = useState<DropHint | null>(null);
  // the drag's cursor: a horizontal run (even k) moves up and down, a vertical one sideways; an end square any way (rule 14)
  const [resize, setResize] = useState<'ns' | 'ew' | 'move' | null>(null);
  const designRef = useRef(design);
  designRef.current = design;

  // design mode ending mid-drag drops the drag and its preview
  const designOff = design === undefined;
  useEffect(() => {
    if (designOff) { abort(); setPreview(null); setGhost(null); setHint(null); }
  }, [designOff]); // abort and setPreview read refs and React state setters: no need to re-run for them

  /** A wire's shape as its run squares see it: its own bends, else the router's shape of its core. */
  const bendsOf = (draft: Draft, wire: WireRoute): Bends => circuitOf(saved, draft)[wire.id]?.bends ?? shapeFromPoints(wire.core.points);

  /**
   * Drags run k of a wire (spec §4.2): the first drag makes the wire manual. The last run slides its head: along its
   * step's input side (clamped, spec §4.2), or an open head up and down; a head on a junction has no last run to drag.
   */
  const startSegment = (wire: WireRoute, k: number, e: ReactPointerEvent) => {
    const d = designRef.current;
    if (!d || e.button !== 0) return;
    const base = d.draft;
    const circuit = circuitOf(saved, base);
    if (!Object.hasOwn(circuit, wire.id)) return;
    const rec = circuit[wire.id]!;
    const ends = wire.core.ends;
    const bends = rec.bends ?? shapeFromPoints(wire.core.points);
    if (rec.head.on === 'wire' && k === 2 * bends.xs.length) return;
    const step = rec.head.on === 'step' ? shown.current.placement.steps.get(rec.head.step) : undefined;
    const headAt = (y: number): End => (rec.head.on === 'step' ? { on: 'step', step: rec.head.step, y } : rec.head.on === 'open' ? { on: 'open', x: rec.head.x, y } : rec.head);
    // a dragged wire goes around the blocks, never through one (spec §4.2)
    const boxes = blockBoxes(shown.current.placement);
    let latest: { bends: Bends | null; headY: number | null } = { bends: rec.bends ?? null, headY: null };
    const shaped = (s: { bends: Bends | null; headY: number | null }): Draft => {
      const moved = s.headY === null ? circuit : setEnd(circuit, wire.id, 'head', headAt(s.headY));
      return withCircuit(base, saved, setBends(moved, wire.id, s.bends));
    };
    setResize(k % 2 === 0 ? 'ns' : 'ew');
    run(e, (p) => {
      const r = dragSegment(bends, k, p, ends);
      if ('landingY' in r) {
        const headY = step ? clampLanding(r.landingY - step.y) : r.landingY;
        const ty = step ? step.y + headY : headY;
        latest = { bends: bends.xs.length > 0 ? clearBends({ ...ends, ty }, bends, boxes) : null, headY };
      } else {
        // the run under the pointer is pushed off any block it would lie on; the rest detours around blocks
        const moved = clearRun(r.bends, ends, draggedRun(bends.xs.length, k), boxes);
        latest = { bends: clearBends(ends, moved, boxes), headY: latest.headY };
      }
      setPreview(shaped(latest));
    }, (cancelled, moved) => {
      setPreview(null);
      if (cancelled || !moved) return;
      const ty = latest.headY === null ? ends.ty : step ? step.y + latest.headY : latest.headY;
      const tidy = latest.bends ? normalize({ ...ends, ty }, latest.bends) : null;
      const next = shaped({ bends: tidy, headY: latest.headY });
      // dragged back where it was: no step
      if (JSON.stringify(next.wires?.[wire.id]) === JSON.stringify(rec)) return;
      d.onCommit(next);
    });
  };

  /**
   * Drags one end of wire `id` (plan 9 §6). Each move finds what the pointer is over (a block within the drop reach
   * wins over a line; the dragged wire's own line counts except its run at the dragged end), judges the drop on
   * `circuit`, and draws the wire there (`path`). Released: `done` with an allowed target; a refused one snaps back.
   */
  const dropGesture = (e: ReactPointerEvent, o: { id: string; ghost: string | null; side: Side; circuit: Circuit; path: (t: DropTarget) => Pt[]; done: (t: DropTarget) => void }) => {
    let target: DropTarget | null = null;
    let verdict: Verdict = 'move';
    run(e, (p) => {
      const reach = DROP_REACH / getZoom();
      const over = blockAt(shown.current, p, reach);
      const line = over === null ? wireAt(shown.current, p, reach, { id: o.id, side: o.side }) : null;
      target = targetOf(shown.current, p, over, line);
      verdict = judgeDrop(shown.current, o.circuit, o.id, o.side, target);
      setHint({ id: line ? line.id : over, line: line !== null, tone: toneOf(verdict), why: verdict, at: p });
      setGhost({ wire: o.ghost, points: o.path(target) });
    }, (cancelled) => {
      setGhost(null);
      setHint(null);
      if (cancelled || target === null || toneOf(verdict) === 'no') return;
      o.done(target);
    });
  };

  /**
   * Drags a picked wire's end square (plan 9 §6): its tail or its head, connected or open, with the four-way cursor.
   * Released where the circuit allows, the end is there (a drop where it already is changes nothing); refused, it
   * snaps back. The wire keeps its id and stays picked.
   */
  const startEnd = (wire: WireRoute, side: Side, e: ReactPointerEvent) => {
    const d = designRef.current;
    if (!d || e.button !== 0) return;
    const base = d.draft;
    const circuit = circuitOf(saved, base);
    if (!Object.hasOwn(circuit, wire.id)) return;
    const was = circuit[wire.id]![side];
    const [sx, sy] = side === 'head' ? wire.points[0]! : wire.points[wire.points.length - 1]!;
    const boxes = blockBoxes(shown.current.placement);
    setResize('move');
    dropGesture(e, {
      id: wire.id, ghost: wire.id, side, circuit,
      path: (t) => ghostPath({ x: sx, y: sy }, pointOfTarget(shown.current, t), side, boxes),
      done: (t) => {
        const end = endOf(t);
        if (sameEnd(was, end)) return;
        d.onCommit(withCircuit(base, saved, setEnd(circuit, wire.id, side, end)), { picks: [{ kind: 'wire', id: wire.id }] });
      },
    });
  };

  /**
   * Draws a new wire from a step's output or the hub (spec §4.5): automatic at its tail, its head judged as any head
   * (plan 9 §6); released on nothing it is a grey wire open at its head. It becomes the pick.
   */
  const startNew = (source: SourceId, e: ReactPointerEvent) => {
    const d = designRef.current;
    if (!d || e.button !== 0) return;
    const base = d.draft;
    const { placement } = shown.current;
    const from = portOf(placement, source) ?? { x: STEP_W, y: PMID };
    const id = `${NEW_WIRE_PREFIX}${newId()}`;
    const tail: End = source === WORKFLOW_SOURCE ? { on: 'hub', angle: null } : { on: 'step', step: source, y: null };
    const circuit = addCircuitWire(circuitOf(saved, base), id, { tail, head: { on: 'open', x: from.x, y: from.y } });
    const boxes = blockBoxes(placement);
    setResize(null);
    dropGesture(e, {
      id, ghost: null, side: 'head', circuit,
      path: (t) => ghostPath(from, pointOfTarget(shown.current, t), 'head', boxes),
      done: (t) => d.onCommit(withCircuit(base, saved, setEnd(circuit, id, 'head', endOf(t))), { picks: [{ kind: 'wire', id }] }),
    });
  };

  /** The press point in flow coordinates (React Flow's own transform, so a pop-out's window works too). */
  const flowPointOf = (e: ReactPointerEvent): Point => screenToFlowPosition({ x: e.clientX, y: e.clientY }, { snapToGrid: false });
  const latestRef = useRef({ startSegment, startNew, flowPointOf, bendsOf });
  latestRef.current = { startSegment, startNew, flowPointOf, bendsOf };

  // stable, so every wire does not re-render with each canvas render
  const gestures = useMemo<DesignGestures>(() => ({
    wirePointerDown(wireId, e) {
      const d = designRef.current;
      if (!d || e.button !== 0 || !d.picks.some((p) => p.kind === 'wire' && p.id === wireId)) return;
      const wire = shown.current.wires.find((w) => w.id === wireId);
      if (!wire) return;
      // dragging a picked wire's body drags its nearest run, and never detaches it (spec §4.2)
      const { startSegment: start, flowPointOf: at, bendsOf: shape } = latestRef.current;
      start(wire, nearestSegment(wire.core.ends, shape(d.draft, wire), at(e)), e);
    },
    portPointerDown(source, e) {
      latestRef.current.startNew(source, e);
    },
  }), [shown]);

  // a run or end drag's cursor only while that drag runs; a new wire keeps the closed hand
  return { gestures, startSegment, startEnd, ghost, hint, active, running, resize: active ? resize : null };
}
```

Replace `src/WorkflowStudio/src/design/DesignOverlay.tsx` with:

```tsx
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useStore, ViewportPortal } from '@xyflow/react';
import type { Side } from '../circuit/circuit';
import type { WireRoute } from '../layout/circuitRoute';
import { endsOf, segmentHandles, type Bends, type Ends } from '../layout/shape';
import type { Pt } from '../layout/router';
import { pathOf } from '../canvas/svgPath';
import { dropLabel } from './drop';
import type { GuideLine } from './guides';
import type { FlowRect } from './hit';
import type { DropHint } from './useWireGestures';

export interface DesignOverlayProps {
  band: FlowRect | null;
  /** Alignment guides while blocks are dragged (spec §3.4). */
  guides: GuideLine[];
  /** The picked wires, as shown. */
  wires: WireRoute[];
  /** A wire's shape as bends (its own manual bends, else the router's): its run squares follow it. */
  bendsOf: (wire: WireRoute) => Bends;
  onSegment: (wire: WireRoute, k: number, e: ReactPointerEvent) => void;
  /** An end square pressed: the wire's tail or head, whatever it is on (plan 9 §6). */
  onEnd: (wire: WireRoute, side: Side, e: ReactPointerEvent) => void;
  /** A new wire's path, right-angled from its source to the pointer (spec §4.5); a dragged end moves its own wire. */
  ghost: Pt[] | null;
  /** What is under a dragged end: the label next to the pointer says what the drop does, or why it is refused. */
  hint?: DropHint | null;
}

/** On-screen sizes (px) that do not shrink with the zoom: at the fitted zoom a 2 px line would vanish. */
const SQUARE = 9, LINE = 1.5, GHOST = 1.6, LABEL_H = 18, LABEL_PAD = 6, LABEL_FONT = 11.5;

/**
 * A run square is drawn only where an end square does not cover it: on a run too short on screen, the end
 * square (drawn above) would take every press meant for it. That run is still dragged through the wire's body.
 */
function clearOfEnds(h: { x: number; y: number }, ends: Ends, k: number): boolean {
  const room = (SQUARE + 1) * k;
  return Math.hypot(h.x - ends.sx, h.y - ends.sy) >= room && Math.hypot(h.x - ends.tx, h.y - ends.ty) >= room;
}

/**
 * Drawn above the blocks in flow coordinates: the rubber band (spec §3.2), the alignment guides (§3.4), and a picked
 * wire's squares (§4.2, Visio; plan 9 rule 14): one on each end (tail and head, on whatever they are), one in the
 * middle of each run of its core (no mark on a bend); and the ghost of a new wire while it is drawn (§4.5).
 */
export function DesignOverlay({ band, guides, wires, bendsOf, onSegment, onEnd, ghost, hint = null }: DesignOverlayProps) {
  // one screen pixel in flow units
  const k = 1 / useStore((s) => s.transform[2]);
  const label = hint ? dropLabel(hint.why) : null;
  return (
    <ViewportPortal>
      <svg className="design-overlay" width={1} height={1}>
        {band && <rect className="design-band" x={band.x0} y={band.y0} width={band.x1 - band.x0} height={band.y1 - band.y0} strokeWidth={k} strokeDasharray={`${4 * k} ${3 * k}`} />}
        {guides.map((l, i) => <line key={i} className="design-guide" x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} strokeWidth={k} />)}
        {wires.map((w) => {
          const ends = endsOf(w.points);
          const bends = bendsOf(w);
          // a head on a junction: its last run ends on its host's line, so that run has no square (plan 7 §6.2)
          const last = 2 * bends.xs.length;
          const sq = (x: number, y: number) => ({ x: x - (SQUARE / 2) * k, y: y - (SQUARE / 2) * k, width: SQUARE * k, height: SQUARE * k, strokeWidth: LINE * k });
          return (
            <g key={w.id} className="design-wire" data-wire={w.id}>
              {segmentHandles(w.core.ends, bends).filter((h) => !(w.headOn === 'junction' && h.k === last) && clearOfEnds(h, ends, k)).map((h) => (
                <rect key={`s${h.k}`} className={h.vertical ? 'design-handle seg v' : 'design-handle seg h'} data-k={h.k} {...sq(h.x, h.y)}
                  onPointerDown={(e) => onSegment(w, h.k, e)} />
              ))}
              <rect className="design-handle end" data-end="tail" {...sq(ends.sx, ends.sy)} onPointerDown={(e) => onEnd(w, 'tail', e)} />
              <rect className="design-handle end" data-end="head" {...sq(ends.tx, ends.ty)} onPointerDown={(e) => onEnd(w, 'head', e)} />
            </g>
          );
        })}
        {ghost && <path className="design-ghost" d={pathOf(ghost)} strokeWidth={GHOST * k} />}
        {hint && label && (
          // drawn in screen pixels: the group undoes the zoom, offset below-right of the pointer
          <g className={`design-drop-label ${hint.tone}`} transform={`translate(${hint.at.x + 14 * k} ${hint.at.y + 14 * k}) scale(${k})`}>
            <rect x={0} y={0} rx={4} height={LABEL_H} width={label.length * LABEL_FONT * 0.56 + 2 * LABEL_PAD} />
            <text x={LABEL_PAD} y={LABEL_H / 2 + LABEL_FONT * 0.36} fontSize={LABEL_FONT}>{label}</text>
          </g>
        )}
      </svg>
    </ViewportPortal>
  );
}
```

In `src/WorkflowStudio/src/design/DesignContext.ts` replace the interface with:

```ts
/** Where wires and blocks hand a press to the designer's gestures. Null: read-only canvas. */
export interface DesignGestures {
  /** A press on a wire's hit band; a picked wire's body drags its nearest run (spec §4.2). */
  wirePointerDown(wireId: string, e: ReactPointerEvent): void;
  /** A press on a block's connection point starts a new wire (spec §4.5). */
  portPointerDown(source: SourceId, e: ReactPointerEvent): void;
}
```

In `src/WorkflowStudio/src/design/hit.ts`: replace `import { nearestOn } from '../layout/junctions';` and `import { drawnLine } from '../layout/wires';` with `import { lengthOf, nearestOn } from '../layout/junctions';` and `import type { Side } from '../circuit/circuit';`, and replace `wireAt` (with its doc comment) by:

```ts
/**
 * The wire line nearest `p` within `tolerance` (flow units), and how far along it (plan 7). The wire whose end `own`
 * is dragged counts too (an end on its own wire is refused out loud, plan 9 §3), except its run at that end, where
 * the drag starts (Review Focus 5); a wire of one run is all that run.
 */
export function wireAt(doc: StudioDocument, p: Point, tolerance: number, own: { id: string; side: Side } | null = null): { id: string; at: number } | null {
  let best: { id: string; at: number; gap: number } | null = null;
  for (const w of doc.wires) {
    let from = 0, to = Infinity;
    if (own && w.id === own.id) {
      if (w.points.length < 3) continue;
      if (own.side === 'head') to = lengthOf([w.points]) - lengthOf([w.points.slice(-2)]);
      else from = lengthOf([w.points.slice(0, 2)]);
    }
    const n = nearestOn([w.points], [p.x, p.y], from, to);
    if (n.gap <= tolerance && (best === null || n.gap < best.gap)) best = { id: w.id, at: n.at, gap: n.gap };
  }
  return best && { id: best.id, at: best.at };
}
```

In `src/WorkflowStudio/src/design/useDesignKeys.ts`: replace `import { LOOSE_PREFIX, moveBlocks, removeLoose, removeWires } from './draft';` with `import { circuitOf, moveBlocks, removeWires } from './draft';`, add `import type { Side } from '../circuit/circuit';`, change the doc comment's "Delete removes the picked wires (loose ones too)" to "Delete removes the picked wires (a wire joined on one keeps its place, open)", and replace the whole `if (e.key === 'Delete' || e.key === 'Backspace') { … }` block with:

```ts
    if (e.key === 'Delete' || e.key === 'Backspace') {
      // every picked wire the circuit has (one gone after an undo is skipped); blocks are never removed (spec §2)
      const circuit = circuitOf(saved, design.draft);
      const ids = wirePickIds(design.picks).filter((id) => Object.hasOwn(circuit, id));
      if (ids.length === 0) return;
      e.preventDefault();
      // a wire joined on a removed one keeps its place: its end opens where it is drawn (plan 9 §2.2-6)
      const drawn = new Map(shown.current.wires.map((w) => [w.id, w.points]));
      const pointOf = (id: string, side: Side) => {
        const pts = drawn.get(id);
        const p = pts ? pts[side === 'tail' ? 0 : pts.length - 1] : undefined;
        return p ? { x: p[0], y: p[1] } : null;
      };
      design.onCommit(removeWires(design.draft, saved, ids, pointOf), { picks: design.picks.filter((p) => p.kind !== 'wire') });
    }
```

In `src/WorkflowStudio/src/canvas/selection.ts` replace the three `DROP_*` constants and `withHint` with:

```ts
/** The block under a dragged wire end: outlined green when the drop connects, grey when the end is open there (a cache), red when it snaps back (plan 9 §6). */
export const DROP_OK_CLASS = 'drop-ok';
export const DROP_MOVE_CLASS = 'drop-move';
export const DROP_NO_CLASS = 'drop-no';

/** The nodes with the drop outline on the block under a dragged wire end. Pure; with no hint (or none over a block) the same array comes back. */
export function withHint(nodes: StudioNode[], hint: { id: string | null; tone: 'ok' | 'move' | 'no' } | null): StudioNode[] {
  if (hint === null || hint.id === null) return nodes;
  const cls = hint.tone === 'ok' ? DROP_OK_CLASS : hint.tone === 'move' ? DROP_MOVE_CLASS : DROP_NO_CLASS;
  return nodes.map((n) => (n.id === hint.id ? { ...n, className: withClass(n.className, cls) } : n));
}
```

In `src/WorkflowStudio/src/canvas/canvas.css`:
- `.design-handle.end { fill: var(--accent); stroke: #04111F; cursor: ew-resize; }` → `.design-handle.end { fill: var(--accent); stroke: #04111F; cursor: move; }`
- the comment above `.design-handle.seg.h` ends with `an end square moves its end any way (plan 9 rule 14)` instead of `an end square leaves its block sideways`;
- delete `/* plan 7: a joined wire's contact square moves its contact along any same-colour line (four-way arrow) */` and `.design-handle.end.contact { cursor: move; }`;
- `/* plan 8: released here the wire becomes loose (grey) */` and the `.drop-loose` rule become `/* plan 9: released here the end is open (grey) */` and `.studio-canvas .react-flow__node.drop-move { outline: calc(3px * var(--inv, 1)) solid #9AA7B8; outline-offset: calc(4px * var(--inv, 1)); border-radius: 8px; }`;
- `.design-drop-label.loose rect` becomes `.design-drop-label.move rect`.

In `src/WorkflowStudio/src/canvas/WorkflowCanvas.tsx`:
- imports: `import { EMPTY_DRAFT, LOOSE_PREFIX, resetShape, storedBends, type Draft } from '../design/draft';` → `import { circuitOf, EMPTY_DRAFT, resetShape, type Draft } from '../design/draft';`; `import { looseAsWire, useWireGestures } from '../design/useWireGestures';` → `import { useWireGestures } from '../design/useWireGestures';`; `import { shapeFromPoints } from '../layout/shape';` → `import { endsOf, shapeFromPoints } from '../layout/shape';`; `import type { WireRoute } from '../layout/wires';` → `import type { WireRoute } from '../layout/circuitRoute';`; add `import { shapedByHand } from '../circuit/circuit';`.
- replace the `shapedByHand` const (and its doc comment) above `PRO_OPTIONS` with:

```ts
/** Has the wire a shape of its own to reset: bends, or an end slid along a step's side (plan 9 decision 11)? */
const resettable = (doc: StudioDocument, draft: Draft, wireId: string): boolean => {
  const c = circuitOf(doc, draft);
  return Object.hasOwn(c, wireId) && shapedByHand(c[wireId]!);
};
```

- replace the lines from `// a wire whose end is dragged follows the pointer: …` down to the end of `const bendsOf = …;` with:

```ts
  // a wire whose end is dragged follows the pointer: the wire, its handles and its runs (spec §4.4)
  const dragged = wiring.ghost?.wire ? { id: wiring.ghost.wire, points: wiring.ghost.points } : null;
  const edges = useMemo(() => marked.edges.map((e) => {
    if (e.type !== 'cable' || !e.data) return e;
    let data = e.data;
    if (dragged && e.id === dragged.id) data = { ...data, points: dragged.points };
    // the line under a dragged end: green when the end may join it, red when refused (plan 7 §6.1, plan 9 §6)
    if (wiring.hint?.line && e.id === wiring.hint.id && wiring.hint.tone !== 'move') data = { ...data, halo: wiring.hint.tone };
    return data === e.data ? e : { ...e, data };
  }), [marked.edges, wiring.ghost, wiring.hint]);
  // picks naming wires that are gone (after an undo) draw nothing
  const pickedWires = useMemo(
    () => (design
      ? shownDoc.wires.filter((w) => design.picks.some((p) => p.kind === 'wire' && p.id === w.id))
        .map((w) => (dragged && w.id === dragged.id ? { ...w, points: dragged.points, core: { ends: endsOf(dragged.points), points: dragged.points } } : w))
      : []),
    [shownDoc, design?.picks, wiring.ghost],
  );
  // the run squares follow a drag's preview, not only the committed draft
  const bendsOf = (w: WireRoute) => (dragged && w.id === dragged.id
    ? shapeFromPoints(w.points)
    : circuitOf(doc, preview ?? design?.draft ?? EMPTY_DRAFT)[w.id]?.bends ?? shapeFromPoints(w.core.points));
```

- in `onEdgeContextMenu`, the comment becomes `// every wire has the menu: Reset route clears its shape (plan 9 decision 11)`.
- the `DesignOverlay` element's `onEnd={(w, end, e) => (end === 'arrow' ? wiring.startArrow(w, e) : wiring.startEnd(w, end, e))}` becomes `onEnd={wiring.startEnd}`.
- in the menu entry: `disabled: !resettable(doc, design.draft, menu.wireId)`, `tip: resettable(doc, design.draft, menu.wireId) ? 'Let the router shape this wire again' : 'Only a wire shaped by hand has a route to reset'`, `onSelect: () => design.onCommit(resetShape(design.draft, doc, menu.wireId))`.

In `src/WorkflowStudio/src/panels/Inspector.tsx`:
- imports: `import { applyEdits } from '../design/apply';` → `import { applyDesign, applyEdits } from '../design/apply';`; delete `import { LOOSE_PREFIX, wireEnds } from '../design/draft';`; add `import { conditionInfo } from '../model/entryConditions';`; replace `import type { Graph } from '../model/graph';` by nothing if tsc reports `Graph` unused after this change.
- in `Inspector()`, right after `const ready = active?.status.kind === 'ready';`, add:

```ts
  // a picked wire is named as the canvas draws it: the design over the base (plan 9)
  const shownDoc = useMemo(
    () => (active?.status.kind === 'ready' ? applyDesign(active.status.doc, active.design.draft, active.edits) : null),
    [active?.status, active?.design.draft, active?.edits],
  );
```

- `if (onlyWire !== null) return <PaneNote pane="inspector">{wireNote(active.status.doc.graph, onlyWire)}</PaneNote>;` becomes `if (onlyWire !== null) return <PaneNote pane="inspector">{wireNote(shownDoc, onlyWire)}</PaneNote>;`
- replace `wireNote` (with its doc comment) by:

```ts
/**
 * "Wire: {from} → {to} · {family}" (plan 9): a terminal by its unique name, a junction or an open end by what it is,
 * then the wire's family ("undecided", or "short circuit"). A pick naming a wire the design no longer has (after an
 * undo) is read from its id.
 */
function wireNote(shown: StudioDocument | null, id: string): string {
  const graph = shown?.graph;
  const name = (stepId: string) => {
    if (stepId === WORKFLOW_SOURCE) return graph ? entityName(graph.workflow.name, graph.workflow.version, graph.workflow.id) : stepId;
    const s = graph?.steps.get(stepId);
    return s ? entityName(s.name, s.version, s.id) : stepId;
  };
  const w = shown?.wires.find((x) => x.id === id);
  if (!w) {
    const at = id.indexOf('->');
    return at > 0 ? `Wire: ${name(id.slice(0, at))} → ${name(id.slice(at + 2))}` : 'Wire';
  }
  const from = w.source !== null ? name(w.source) : w.tailOn === 'junction' ? 'a junction' : 'an open end';
  const to = w.target !== null ? name(w.target) : w.headOn === 'junction' ? 'a junction' : 'an open end';
  const family = w.short ? 'short circuit' : w.condition === null ? 'undecided' : conditionInfo(w.condition).name;
  return `Wire: ${from} → ${to} · ${family}`;
}
```

Delete the old rules:

```bash
git rm src/WorkflowStudio/src/design/rules.ts src/WorkflowStudio/src/design/rules.test.ts
```

- [ ] **Step 4: Run the whole suite and the type check**

Run: `npx vitest run src/design/useWireGestures.test.tsx src/design/hit.test.ts src/canvas/WorkflowCanvas.test.tsx src/canvas/selection.test.ts src/panels/panes.test.tsx src/design/useDesignKeys.test.tsx`
Expected: PASS.

Run: `npx tsc -b`, then delete `tsconfig.tsbuildinfo`.
Expected: no errors. Fix every report by removing what it names unused (imports in the edited test files) or by a name this plan defines; `rg -n "LOOSE_PREFIX|looseAsWire|startArrow|routeLoose|wireEnds|canJoin|canWire|draft\.loose|draft\.routes|\.joint\b" src` must print nothing.

Run: `npx vitest run`
Expected: every file passes (the e2e specs are not part of Vitest).

- [ ] **Step 5: Verify on the dev server with a real mouse**

Start the dev server (PowerShell, `src/WorkflowStudio`): `npx vite --port 5179 --strictPort` (background), open a live workflow in Playwright (MCP browser or a scratch script with `page.mouse`), switch to design, pick a wire, and drag: its head onto another step's left side ("connect here"), onto a step's right side ("wrong side", snaps back), onto empty canvas ("move here", dashed, the arrow head kept), its tail onto the hub's top ("connect here", the wire starts at the top of the ring). Screenshot each into the scratchpad. Stop the server. (The committed Playwright tests come in Task 11.)

- [ ] **Step 6: Commit**

```bash
git add src/WorkflowStudio/src/design/useWireGestures.ts src/WorkflowStudio/src/design/useWireGestures.test.tsx src/WorkflowStudio/src/design/DesignOverlay.tsx src/WorkflowStudio/src/design/DesignContext.ts src/WorkflowStudio/src/design/hit.ts src/WorkflowStudio/src/design/hit.test.ts src/WorkflowStudio/src/design/useDesignKeys.ts src/WorkflowStudio/src/canvas/WorkflowCanvas.tsx src/WorkflowStudio/src/canvas/WorkflowCanvas.test.tsx src/WorkflowStudio/src/canvas/selection.ts src/WorkflowStudio/src/canvas/selection.test.ts src/WorkflowStudio/src/canvas/canvas.css src/WorkflowStudio/src/panels/Inspector.tsx src/WorkflowStudio/src/panels/panes.test.tsx
git commit -m "feat(studio): one end drag for every wire end, judged as a circuit; Delete opens joined ends; four-way end cursor (plan 9)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(The `git rm` above is part of this commit.)

---
### Task 10: Save from the circuit; short circuits in Problems, the Save answer and Output

**Files:**
- Create: `src/WorkflowStudio/src/design/shortCircuits.ts`
- Modify: `src/WorkflowStudio/src/app/saveDesign.ts`, `src/WorkflowStudio/src/panels/Problems.tsx`, `src/WorkflowStudio/src/store/studioState.ts` (`saveAnswered`)
- Test: `src/WorkflowStudio/src/design/shortCircuits.test.ts`, `src/app/saveDesign.test.ts`, `src/panels/panes.test.tsx`

**Interfaces:**
- Consumes: Task 3 (`netsOf`), Task 7 (`circuitOf`, `Draft`), `conditionInfo`, `DesignError`.
- Produces:
  - `SHORT_CIRCUIT = 'short circuit:'`
  - `shortCircuitErrors(shown: StudioDocument, draft: Draft): DesignError[]`
  - `isShortCircuitError(e: DesignError): boolean`
  - `buildDesignRequest(base, shown, design)` (same signature) now sends the shown lists; `saveDesign` adds the short-circuit errors to the answer's.
  - `saveAnswered` Output text: `Saved and applied` | `Saved and applied; N short circuit(s) not written` | `Saved; not applied: N error(s)`; `errors` null only when there is none.

- [ ] **Step 1: Write the failing tests**

Create `src/WorkflowStudio/src/design/shortCircuits.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { graphDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { setEnd } from '../circuit/circuit';
import { applyDesign } from './apply';
import { EMPTY_EDITS } from './design';
import { circuitOf, EMPTY_DRAFT, withCircuit } from './draft';
import { isShortCircuitError, shortCircuitErrors } from './shortCircuits';

describe('shortCircuitErrors (plan 9 §2.2-7, §7)', () => {
  it('reports each net whose families disagree once, on a step of its last family', async () => {
    const base = await loadedDocument(graphDto({
      workflow: workflowDto({ entryStepIds: ['s1'] }),
      steps: [stepDto('s1', { nextStepIds: ['s2', 's3'] }), stepDto('s2'), stepDto('s3', { entryCondition: 2 })],
    }));
    // s1 -> s3 taps s1 -> s2: one net that s2 (Completed) and s3 (Failed) decide
    const draft = withCircuit(EMPTY_DRAFT, base, setEnd(circuitOf(base, EMPTY_DRAFT), 's1->s3', 'tail', { on: 'wire', host: 's1->s2', at: 40 }));
    const errors = shortCircuitErrors(applyDesign(base, draft, EMPTY_EDITS), draft);
    expect(errors).toEqual([{ kind: 'step', id: 's3', stage: 'wires', field: null, message: 'short circuit: Completed meets Failed' }]);
    expect(isShortCircuitError(errors[0]!)).toBe(true);
    expect(isShortCircuitError({ kind: 'step', id: 's1', stage: 'steps', field: 'version', message: 'bad' })).toBe(false);
    expect(shortCircuitErrors(base, EMPTY_DRAFT)).toEqual([]);
  });
});
```

In `src/WorkflowStudio/src/app/saveDesign.test.ts`:
- imports: add `addCircuitWire` to the `../circuit/circuit` import, `removeWires` to the `../design/draft` import, `import { applyEdits } from '../design/apply';` (merge with the existing `applyDesign` import) and `type DesignRequest` to the `./saveDesign` import;
- in `sends only the changes: …`, replace `const draft = { ...EMPTY_DRAFT, next: { s1: [] } };` with `const draft = removeWires(EMPTY_DRAFT, applyEdits(base, edits), ['s1->s2'], () => null);` (the expectations stay);
- append inside `describe('buildDesignRequest (plan 8 §4.2)', …)`:

```ts
  it('sends the lists the circuit\'s current gives: a tail junction fans out; a link made twice is sent once (Review Focus 3)', async () => {
    const base = await loadedDocument(graphDto({
      workflow: workflowDto({ entryStepIds: ['s1'] }),
      steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2', { nextStepIds: ['s3'] }), stepDto('s3')],
    }));
    let c = setEnd(circuitOf(base, EMPTY_DRAFT), 's2->s3', 'tail', { on: 'wire', host: 's1->s2', at: 40 });
    c = addCircuitWire(c, 'w:d', { tail: { on: 'step', step: 's1', y: null }, head: { on: 'step', step: 's3', y: null } });
    const draft = withCircuit(EMPTY_DRAFT, base, c);

    const body = buildDesignRequest(base, applyDesign(base, draft, EMPTY_EDITS), { draft, edits: EMPTY_EDITS });

    expect(body.steps.map((s) => [s.id, s.nextStepIds])).toEqual([['s1', ['s2', 's3']], ['s2', []]]);
    expect(body.workflow.entryStepIds).toBeNull();
  });
```

- append inside `describe('saveDesign (plan 8 §4.1)', …)`:

```ts
  it('leaves a short-circuited net\'s links out and reports it with the answer: Problems and Output say so (plan 9 §7)', async () => {
    const graph = graphDto({
      workflow: workflowDto({ entryStepIds: ['s1'] }),
      steps: [stepDto('s1', { nextStepIds: ['s2', 's3'] }), stepDto('s2'), stepDto('s3', { entryCondition: 2 })],
    });
    const base = await loadedDocument(graph);
    const store = createStudioStore();
    store.dispatch({ type: 'open', workflowId: 'wf1', name: 'orders', version: '1.0.0' });
    store.dispatch({ type: 'loaded', workflowId: 'wf1', doc: base });
    const draft = withCircuit(EMPTY_DRAFT, base, setEnd(circuitOf(base, EMPTY_DRAFT), 's1->s3', 'tail', { on: 'wire', host: 's1->s2', at: 40 }));
    store.dispatch({ type: 'design', workflowId: 'wf1', draft });
    const api = apiWith({ ok: true, value: { applied: true, errors: [] } }, graph);

    await saveDesign(api, store, 'wf1', NOW);

    const sent = vi.mocked(api.saveDesign).mock.calls[0]![1] as unknown as DesignRequest;
    expect(sent.steps.find((s) => s.id === 's1')!.nextStepIds).toEqual([]);
    expect(store.getState().docs[0]!.errors).toEqual([{ kind: 'step', id: 's3', stage: 'wires', field: null, message: 'short circuit: Completed meets Failed' }]);
    expect(store.getState().output.at(-1)!.text).toBe('Saved and applied; 1 short circuit not written');
  });
```

In `src/WorkflowStudio/src/panels/panes.test.tsx` add `import { setEnd } from '../circuit/circuit';` and `import { circuitOf, EMPTY_DRAFT, withCircuit } from '../design/draft';`, and append inside `describe('Problems (plan 8 §4.1: the last Save\'s errors)', …)`:

```tsx
  it('lists a short circuit of the design while it lasts, not only after a Save; its row selects the step (plan 9 §2.2-7)', async () => {
    const base = await loadedDocument(graphDto({
      workflow: workflowDto({ entryStepIds: ['s1'] }),
      steps: [stepDto('s1', { nextStepIds: ['s2', 's3'] }), stepDto('s2'), stepDto('s3', { entryCondition: 2 })],
    }));
    const store = createStudioStore();
    store.dispatch({ type: 'open', workflowId: 'wf1', name: 'orders', version: '1.0.0' });
    store.dispatch({ type: 'loaded', workflowId: 'wf1', doc: base });
    store.dispatch({ type: 'design', workflowId: 'wf1', draft: withCircuit(EMPTY_DRAFT, base, setEnd(circuitOf(base, EMPTY_DRAFT), 's1->s3', 'tail', { on: 'wire', host: 's1->s2', at: 40 })) });
    wrap(store, <Problems />);
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('short circuit: Completed meets Failed');
    fireEvent.click(rows[0]!);
    expect(store.getState().docs[0]!.selection).toEqual({ kind: 'step', stepId: 's3' });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/design/shortCircuits.test.ts src/app/saveDesign.test.ts src/panels/panes.test.tsx`
Expected: FAIL (`./shortCircuits` does not exist; the request still reads `draft.next`; no short circuit is reported; Output says `Saved and applied`).

- [ ] **Step 3: Write the implementation**

Create `src/WorkflowStudio/src/design/shortCircuits.ts`:

```ts
import type { StudioDocument } from '../app/document';
import { netsOf } from '../circuit/families';
import { conditionInfo } from '../model/entryConditions';
import type { DesignError, Id } from '../model/graph';
import { circuitOf, type Draft } from './draft';

/** How a short circuit's message starts (plan 9 §7). */
export const SHORT_CIRCUIT = 'short circuit:';

/**
 * One error per net whose families disagree (plan 9 §2.2-7, §7; decision 10): kind `step`, stage `wires`, on the
 * first step (by id) of the net's last family that a head of the net lands on; "short circuit: <first> meets <last>".
 */
export function shortCircuitErrors(shown: StudioDocument, draft: Draft): DesignError[] {
  const circuit = circuitOf(shown, draft);
  const conditionOf = (id: Id) => shown.graph.steps.get(id)?.entryCondition;
  return netsOf(circuit, conditionOf).filter((n) => n.families.length > 1).map((n) => {
    const first = n.families[0]!, last = n.families[n.families.length - 1]!;
    const steps = n.wires.flatMap((w) => { const h = circuit[w]!.head; return h.on === 'step' && conditionOf(h.step) === last ? [h.step] : []; }).sort();
    return { kind: 'step', id: steps[0]!, stage: 'wires', field: null, message: `${SHORT_CIRCUIT} ${conditionInfo(first).name} meets ${conditionInfo(last).name}` };
  });
}

/** A short circuit's error (the live list in Problems supersedes the copy a Save answer carries). */
export const isShortCircuitError = (e: DesignError): boolean => e.stage === 'wires' && e.message.startsWith(SHORT_CIRCUIT);
```

In `src/WorkflowStudio/src/app/saveDesign.ts`:
- add `import { shortCircuitErrors } from '../design/shortCircuits';`
- add above `buildDesignRequest`:

```ts
const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
```

- replace `buildDesignRequest`'s doc comment and its first lines down to and including the `stepIds` line with:

```ts
/**
 * The design's changes relative to the base (spec §4.2; plan 9 §7). The lists are the shown ones, which the
 * circuit's current gives with short-circuited nets left out: a step whose list differs from the base's sends it,
 * and so does the entry list. The workflow always carries its stamp (the workflow stage needs it when assignment
 * links change); a step carries the stamp the design kept, else the base's. A wire with an open end makes no link:
 * it lives only in the layout. Entities the base no longer has are left out.
 */
export function buildDesignRequest(base: StudioDocument, shown: StudioDocument, { draft, edits }: Design): DesignRequest {
  const g = base.graph;
  const has = (id: Id) => g.steps.has(id);
  const nextOf = (id: Id) => shown.graph.steps.get(id)?.nextStepIds ?? g.steps.get(id)!.nextStepIds;
  const rewired = new Set([...g.steps.keys()].filter((id) => !sameList(nextOf(id), g.steps.get(id)!.nextStepIds)));
  const stepIds = [...new Set([...Object.keys(edits.steps), ...rewired])].filter(has).sort();
  const entries = shown.graph.workflow.entryStepIds;
```

- in the returned object, `entryStepIds: draft.entries === null ? null : draft.entries.filter(has), cacheIds: null,` becomes `entryStepIds: sameList(entries, g.workflow.entryStepIds) ? null : entries.filter(has), cacheIds: null,` and `nextStepIds: Object.hasOwn(draft.next, id) ? draft.next[id]!.filter(has) : null,` becomes `nextStepIds: rewired.has(id) ? nextOf(id).filter(has) : null,`.
- in `saveDesign`, replace

```ts
  const body = buildDesignRequest(base, applyDesign(base, design.draft, design.edits), design);
```

with

```ts
  const shown = applyDesign(base, design.draft, design.edits);
  const body = buildDesignRequest(base, shown, design);
  // a short circuit is an error of the design's wiring: its links are not sent, and it is reported with the answer (plan 9 §7)
  const shorts = shortCircuitErrors(shown, design.draft);
```

  and `errors: designErrorsFromDto(answer.value), doc: reread.ok ? reread.value : null,` with `errors: [...shorts, ...designErrorsFromDto(answer.value)], doc: reread.ok ? reread.value : null,`.

In `src/WorkflowStudio/src/store/studioState.ts`, `case 'saveAnswered':` replace

```ts
      const text = action.applied ? 'Saved and applied' : `Saved; not applied: ${n} error${n === 1 ? '' : 's'}`;
```

with

```ts
      // applied by BaseApi, the only errors left are the design's short circuits (plan 9 §7), whose links were not sent
      const text = !action.applied ? `Saved; not applied: ${n} error${n === 1 ? '' : 's'}`
        : n === 0 ? 'Saved and applied' : `Saved and applied; ${n} short circuit${n === 1 ? '' : 's'} not written`;
```

and `errors: action.applied ? null : action.errors,` with `errors: n === 0 ? null : action.errors,`.

In `src/WorkflowStudio/src/panels/Problems.tsx`:
- add imports `import { useMemo } from 'react';`, `import { applyDesign } from '../design/apply';`, `import { isShortCircuitError, shortCircuitErrors } from '../design/shortCircuits';`
- the doc comment becomes: `Problems (plan 8 §4.1; plan 9 §2.2-7): the design's short circuits while they last, then the errors of the active document's last Save, one row each: the entity, the field and the message. Clicking a row selects its entity.`
- right after `const guard = useGuard();` add:

```ts
  // short circuits are the design's own (plan 9 §2.2-7): listed while they last, not only after a Save
  const live = useMemo(
    () => (active?.status.kind === 'ready' ? shortCircuitErrors(applyDesign(active.status.doc, active.design.draft, active.edits), active.design.draft) : []),
    [active?.status, active?.design.draft, active?.edits],
  );
```

- `const errors = active.errors ?? [];` becomes `const errors = [...live, ...(active.errors ?? []).filter((e) => !isShortCircuitError(e))];`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run`
Expected: PASS (whole suite).
Run: `npx tsc -b`, then delete `tsconfig.tsbuildinfo`.
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/WorkflowStudio/src/design/shortCircuits.ts src/WorkflowStudio/src/design/shortCircuits.test.ts src/WorkflowStudio/src/app/saveDesign.ts src/WorkflowStudio/src/app/saveDesign.test.ts src/WorkflowStudio/src/panels/Problems.tsx src/WorkflowStudio/src/panels/panes.test.tsx src/WorkflowStudio/src/store/studioState.ts
git commit -m "feat(studio): Save writes the lists the circuit's current gives; short circuits listed in Problems, reported on Save, not written (plan 9)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 11: Playwright with a real mouse: one test per rule, the extras, Save of fan-in and fan-out

**Files:**
- Modify: `src/WorkflowStudio/e2e/throwaway.ts` (`createCircuitThrowaway`, extra steps in `created` and in `removeThrowaway`)
- Create: `src/WorkflowStudio/e2e/circuit.spec.ts` (design only, read-only browser)
- Create: `src/WorkflowStudio/e2e/circuit-save.spec.ts` (Save on the circuit throwaway)
- Modify: `src/WorkflowStudio/e2e/save.spec.ts`, `src/WorkflowStudio/e2e/designer.spec.ts` (plan 8 wire behaviour that changed)

**Interfaces:**
- Consumes: everything above; `e2e/studio.ts` (`box`, `centreOf`, `documentPanel`, `expect`, `inspector`, `openWorkflow`, `pointOnWire`, `tab`, `test` with the read-only guard); `e2e/throwaway.ts` (`test` with the write guard, `expect`, `removeThrowaway`).
- Produces: `interface CircuitThrowaway { workflow: LiveWorkflow; tag: string; a: string; b: string; c: string; d: string }`; `createCircuitThrowaway(request: APIRequestContext): Promise<CircuitThrowaway>`; `created.extraStepIds?: string[]`.

- [ ] **Step 1: The circuit throwaway**

In `src/WorkflowStudio/e2e/throwaway.ts`:
- add `extraStepIds?: string[];` to the type of `created` (after `stepBId?: string;`);
- add after `createThrowaway`:

```ts
/** The circuit specs' workflow (plan 9 decision 15): steps a, b, c (Completed) and d (Failed); wf -> a, a -> b, a -> d, b -> c. */
export interface CircuitThrowaway { workflow: LiveWorkflow; tag: string; a: string; b: string; c: string; d: string }

/** Creates the circuit throwaway through BaseApi's CRUD (`e2e-9-…`): a schema, a processor, four steps and the workflow; no assignment, no cache. */
export async function createCircuitThrowaway(request: APIRequestContext): Promise<CircuitThrowaway> {
  const tag = `e2e-9-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`;
  created.tag = tag;
  created.schemaId = await post(request, 'schemas', { name: `${tag}-config`, version: '1.0.0', description: null, definition: '{"type":"object"}' });
  created.processorId = await post(request, 'processors', {
    name: `${tag}-proc`, version: '1.0.0', description: null, sourceHash: randomBytes(32).toString('hex'), instanceId: null,
    inputSchemaId: null, outputSchemaId: null, configSchemaId: created.schemaId,
  });
  const step = async (name: string, nextStepIds: string[], entryCondition: number): Promise<string> => {
    const id = await post(request, 'steps', { name: `${tag}-${name}`, version: '1.0.0', description: null, processorId: created.processorId, nextStepIds, entryCondition });
    created.extraStepIds = [...(created.extraStepIds ?? []), id];
    return id;
  };
  const c = await step('c', [], 1);
  const d = await step('d', [], 2);
  const b = await step('b', [c], 1);
  const a = await step('a', [b, d], 1);
  created.workflowId = await post(request, 'workflows', {
    name: tag, version: '1.0.0', description: null, entryStepIds: [a], assignmentIds: [], cacheIds: [], cronExpression: null,
  });
  return { workflow: { id: created.workflowId, name: tag, version: '1.0.0', label: label(tag, '1.0.0', created.workflowId) }, tag, a, b, c, d };
}
```

- in `removeThrowaway`: `const { workflowId, stepId, stepBId, processorId, schemaId, cacheId, tag } = created;` → `const { workflowId, stepId, stepBId, extraStepIds, processorId, schemaId, cacheId, tag } = created;` and `const steps = [stepId, stepBId].filter((id): id is string => id !== undefined);` → `const steps = [stepId, stepBId, ...(extraStepIds ?? [])].filter((id): id is string => id !== undefined);` (every step is unwired before any is deleted, as now); in its doc comment, "A and B" becomes "every step this run made".

- [ ] **Step 2: The design spec, one test per rule (spec §10)**

Create `src/WorkflowStudio/e2e/circuit.spec.ts`:

```ts
import type { Locator, Page } from '@playwright/test';
import { box, centreOf, documentPanel, expect, inspector, openWorkflow, pointOnWire, tab, test } from './studio';
import { createCircuitThrowaway, removeThrowaway, type CircuitThrowaway } from './throwaway';

// Plan 9: the ground rules of wires as a circuit, one test each, with the real mouse and keyboard. The workflow is a
// throwaway (e2e/throwaway.ts, `e2e-9-…`): steps a, b, c (Completed) and d (Failed), wired wf -> a, a -> b, a -> d,
// b -> c, made and deleted through BaseApi's CRUD by the test runner. The browser only reads (studio.ts's guard):
// nothing here is saved, and every test starts from an empty session.
test.describe.configure({ mode: 'serial', retries: 0 });
let t: CircuitThrowaway;
test.beforeAll(async ({ request }) => { t = await createCircuitThrowaway(request); });
test.afterAll(async ({ request }) => { await removeThrowaway(request); });
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
});

const TEAL = '#2DD4BF', RED = '#FF7A66', GREY = '#8A97A8';
const node = (panel: Locator, id: string) => panel.locator(`.react-flow__node[data-id="${id}"]`);
const edge = (panel: Locator, id: string) => panel.locator(`.react-flow__edge[data-id="${id}"]`);
const drawn = (panel: Locator, id: string) => edge(panel, id).locator('path.w').first();
const endSquare = (panel: Locator, id: string, side: 'tail' | 'head') => panel.locator(`.design-wire[data-wire="${id}"] .design-handle.end[data-end="${side}"]`);
const newWires = (panel: Locator) => panel.locator('.react-flow__edge[data-id^="w:"]');
const colourOf = (panel: Locator, id: string) => drawn(panel, id).getAttribute('stroke');
const dashOf = (panel: Locator, id: string) => drawn(panel, id).evaluate((el) => getComputedStyle(el).strokeDasharray);
const cursorAt = (page: Page, q: { x: number; y: number }) => page.evaluate(({ x, y }) => getComputedStyle(document.elementFromPoint(x, y)!).cursor, q);

async function open(page: Page): Promise<Locator> {
  await openWorkflow(page, t.workflow);
  return documentPanel(page, t.workflow);
}

/** A wire's points in flow coordinates, read from its drawn path. */
async function pointsOf(panel: Locator, id: string): Promise<[number, number][]> {
  const d = (await drawn(panel, id).getAttribute('d')) ?? '';
  return [...d.matchAll(/[ML]([-\d.e]+) ([-\d.e]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
}

/** A block's top-left corner and size in flow coordinates (React Flow's transform on the node, and its size). */
async function flowBox(panel: Locator, id: string): Promise<{ x: number; y: number; w: number; h: number }> {
  return node(panel, id).evaluate((el) => {
    const e = el as HTMLElement;
    const m = /translate\(([-\d.e]+)px, ?([-\d.e]+)px\)/.exec(e.style.transform)!;
    return { x: Number(m[1]), y: Number(m[2]), w: e.offsetWidth, h: e.offsetHeight };
  });
}

/** A page point inside a step: in its input half (near its left side) or its output half, `f` of the way down. */
async function onSide(panel: Locator, id: string, side: 'in' | 'out', f = 0.5): Promise<{ x: number; y: number }> {
  const b = await box(node(panel, id));
  return { x: side === 'in' ? b.x + b.width * 0.15 : b.x + b.width * 0.85, y: b.y + b.height * f };
}

/** A page point inside the hub's disc at `deg` round its centre (0 right, 90 down). */
async function onHub(panel: Locator, deg: number): Promise<{ x: number; y: number }> {
  const b = await box(node(panel, 'wf'));
  const r = (deg * Math.PI) / 180, R = b.width / 2;
  return { x: b.x + R + 0.8 * R * Math.cos(r), y: b.y + R + 0.8 * R * Math.sin(r) };
}

/** A point on the canvas's empty pane, nothing within 40 px, away from `avoid`; null when none is found. */
async function emptySpot(panel: Locator, avoid: { x: number; y: number }[] = []): Promise<{ x: number; y: number }> {
  const found = await panel.locator('.react-flow').evaluate((el, far) => {
    const r = el.getBoundingClientRect();
    for (let fy = 0.15; fy < 0.9; fy += 0.07) for (let fx = 0.9; fx > 0.1; fx -= 0.07) {
      const x = r.left + r.width * fx, y = r.top + r.height * fy;
      if (far.some((p) => Math.hypot(p.x - x, p.y - y) < 120)) continue;
      const clear = [[0, 0], [40, 0], [-40, 0], [0, 40], [0, -40]].every(([dx, dy]) => {
        const hit = el.ownerDocument.elementFromPoint(x + dx!, y + dy!);
        return hit !== null && hit.classList.contains('react-flow__pane');
      });
      if (clear) return { x, y };
    }
    return null;
  }, avoid);
  if (!found) throw new Error('no empty spot on the canvas');
  return found;
}

/** Picks a wire with a click on its line; its squares show. */
async function pick(page: Page, panel: Locator, id: string): Promise<void> {
  const p = await pointOnWire(panel, id);
  await page.mouse.click(p.x, p.y);
  await expect(endSquare(panel, id, 'head')).toBeVisible();
}

/** Presses `from`, moves to `to` with the real mouse, reads the drop label there, releases. */
async function dragReading(page: Page, panel: Locator, from: { x: number; y: number }, to: { x: number; y: number }): Promise<string | null> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 5 });
  await page.mouse.move(to.x, to.y, { steps: 5 });
  const label = panel.locator('.design-drop-label');
  const text = (await label.count()) > 0 ? await label.textContent() : null;
  await page.mouse.up();
  return text;
}

/** Picks wire `id` and drags its `side` end square to `to`: the label read there. */
async function dragEnd(page: Page, panel: Locator, id: string, side: 'tail' | 'head', to: { x: number; y: number }): Promise<string | null> {
  await pick(page, panel, id);
  return dragReading(page, panel, await centreOf(endSquare(panel, id, side)), to);
}

/** Draws a new wire from step `from`'s connection point to `to`; its id (`w:…`). */
async function newWire(page: Page, panel: Locator, from: string, to: { x: number; y: number }): Promise<string> {
  const before = await newWires(panel).count();
  await node(panel, from).hover();
  await dragReading(page, panel, await centreOf(node(panel, from).locator('.nx-port')), to);
  await expect(newWires(panel)).toHaveCount(before + 1);
  return (await newWires(panel).last().getAttribute('data-id'))!;
}

test('rule 1: tails dropped at the hub\'s top, left and bottom start there, several at once', async ({ page }) => {
  const panel = await open(page);
  const moves: [string, number][] = [[`wf->${t.a}`, 270], [`${t.b}->${t.c}`, 180], [`${t.a}->${t.d}`, 90]];
  for (const [id, deg] of moves) expect(await dragEnd(page, panel, id, 'tail', await onHub(panel, deg))).toBe('connect here');
  const hub = await flowBox(panel, 'wf');
  const cx = hub.x + hub.w / 2, cy = hub.y + hub.h / 2, R = hub.w / 2;
  for (const [id, deg] of moves) {
    const [x, y] = (await pointsOf(panel, id))[0]!;
    const r = (deg * Math.PI) / 180;
    expect(Math.abs(x - (cx + R * Math.cos(r)))).toBeLessThan(1);
    expect(Math.abs(y - (cy + R * Math.sin(r)))).toBeLessThan(1);
  }
});

test('rule 2: a step takes ends on its left and right sides only: a head dropped high on b lands on its left side, a tail low on b leaves its right side', async ({ page }) => {
  const panel = await open(page);
  const b = await flowBox(panel, t.b);
  expect(await dragEnd(page, panel, `${t.a}->${t.b}`, 'head', await onSide(panel, t.b, 'in', 0.05))).toBe('connect here');
  expect((await pointsOf(panel, `${t.a}->${t.b}`)).at(-1)).toEqual([b.x, b.y + 64]);
  expect(await dragEnd(page, panel, `${t.b}->${t.c}`, 'tail', await onSide(panel, t.b, 'out', 0.95))).toBe('connect here');
  expect((await pointsOf(panel, `${t.b}->${t.c}`))[0]).toEqual([b.x + b.w, b.y + 128]);
});

test('rule 3: a wire is drawn with a ring at its tail and an arrow head at its head', async ({ page }) => {
  const panel = await open(page);
  const e = edge(panel, `${t.a}->${t.b}`);
  await expect(e.locator('circle.nx-src')).toHaveCount(1);
  await expect(e.locator('path.nx-head')).toHaveCount(1);
  await expect(e.locator('circle.nx-joint')).toHaveCount(0);
  await expect(panel.locator('circle.nx-open')).toHaveCount(0);
});

test('rule 4: a head and a tail each join another wire at a chosen point, a filled circle and no arrow head there; itself and both ends on one wire are refused', async ({ page }) => {
  const panel = await open(page);
  const ab = `${t.a}->${t.b}`, bc = `${t.b}->${t.c}`, ad = `${t.a}->${t.d}`;
  // its head on wf -> a: b's current goes on into a (a loop through steps is allowed)
  expect(await dragEnd(page, panel, bc, 'head', await pointOnWire(panel, `wf->${t.a}`, 0.5, 12))).toBe('join here');
  await expect(edge(panel, bc).locator('circle.nx-joint')).toHaveCount(1);
  await expect(edge(panel, bc).locator('path.nx-head')).toHaveCount(0);
  await page.keyboard.press('Control+z');
  await expect(edge(panel, bc).locator('circle.nx-joint')).toHaveCount(0);
  // its tail on a -> b: it takes a's current
  expect(await dragEnd(page, panel, bc, 'tail', await pointOnWire(panel, ab, 0.5, 12))).toBe('join here');
  await expect(edge(panel, bc).locator('circle.nx-joint')).toHaveCount(1);
  await expect(edge(panel, bc).locator('circle.nx-src')).toHaveCount(0);
  await expect(edge(panel, bc).locator('path.nx-head')).toHaveCount(1);
  // both ends on a -> b: refused, nothing changes
  expect(await dragEnd(page, panel, bc, 'head', await pointOnWire(panel, ab, 0.85, 12))).toBe('same wire');
  await expect(edge(panel, bc).locator('path.nx-head')).toHaveCount(1);
  // on itself: a run of a -> d other than the one at its head
  if ((await pointsOf(panel, ad)).length >= 3) expect(await dragEnd(page, panel, ad, 'head', await pointOnWire(panel, ad, 0.1, 12))).toBe('same wire');
});

test('rule 5: a head on a step\'s right side and a tail on its left side are refused ("wrong side"); each slides along its own side', async ({ page }) => {
  const panel = await open(page);
  const ab = `${t.a}->${t.b}`, bc = `${t.b}->${t.c}`;
  const before = await pointsOf(panel, ab);
  expect(await dragEnd(page, panel, ab, 'head', await onSide(panel, t.b, 'out'))).toBe('wrong side');
  expect(await pointsOf(panel, ab)).toEqual(before);
  expect(await dragEnd(page, panel, bc, 'tail', await onSide(panel, t.b, 'in'))).toBe('wrong side');
  const b = await flowBox(panel, t.b);
  expect(await dragEnd(page, panel, ab, 'head', await onSide(panel, t.b, 'in', 0.75))).toBe('connect here');
  expect((await pointsOf(panel, ab)).at(-1)).toEqual([b.x, b.y + 120]);
  expect(await dragEnd(page, panel, bc, 'tail', await onSide(panel, t.b, 'out', 0.45))).toBe('connect here');
  expect((await pointsOf(panel, bc))[0]).toEqual([b.x + b.w, b.y + 72]);
});

test('rule 6: a head over the hub is refused: "only a tail on the workflow"', async ({ page }) => {
  const panel = await open(page);
  const ab = `${t.a}->${t.b}`;
  const before = await pointsOf(panel, ab);
  expect(await dragEnd(page, panel, ab, 'head', await onHub(panel, 0))).toBe('only a tail on the workflow');
  expect(await pointsOf(panel, ab)).toEqual(before);
});

test('rule 7: a wire with only its tail on a step is grey and dashed', async ({ page }) => {
  const panel = await open(page);
  const id = await newWire(page, panel, t.a, await emptySpot(panel));
  expect(await colourOf(panel, id)).toBe(GREY);
  expect(await dashOf(panel, id)).not.toBe('none');
  await expect(edge(panel, id).locator('circle.nx-src')).toHaveCount(1);
  await expect(edge(panel, id).locator('path.nx-head')).toHaveCount(1);
});

test('rule 8: a tail joined to a teal wire turns its wire teal', async ({ page }) => {
  const panel = await open(page);
  const id = await newWire(page, panel, t.a, await emptySpot(panel));
  expect(await dragEnd(page, panel, id, 'tail', await pointOnWire(panel, `${t.a}->${t.b}`, 0.5, 12))).toBe('join here');
  expect(await colourOf(panel, id)).toBe(TEAL);
  expect(await dashOf(panel, id)).not.toBe('none'); // its head is still open
});

test('rule 9: a head on a step takes the step\'s colour', async ({ page }) => {
  const panel = await open(page);
  const id = await newWire(page, panel, t.a, await emptySpot(panel));
  expect(await dragEnd(page, panel, id, 'head', await onSide(panel, t.d, 'in'))).toBe('connect here');
  expect(await colourOf(panel, id)).toBe(RED);
  expect(await dashOf(panel, id)).toBe('none');
});

test('rule 10: a head joined to a wire takes its colour', async ({ page }) => {
  const panel = await open(page);
  const id = await newWire(page, panel, t.d, await emptySpot(panel));
  expect(await colourOf(panel, id)).toBe(GREY);
  expect(await dragEnd(page, panel, id, 'head', await pointOnWire(panel, `${t.a}->${t.b}`, 0.5, 12))).toBe('join here');
  expect(await colourOf(panel, id)).toBe(TEAL);
  expect(await dashOf(panel, id)).toBe('none');
});

test('rule 11: a short circuit is refused: a tail onto a wire of another family, a head of a teal net onto a red step', async ({ page }) => {
  const panel = await open(page);
  const ab = `${t.a}->${t.b}`, bc = `${t.b}->${t.c}`, ad = `${t.a}->${t.d}`;
  expect(await dragEnd(page, panel, bc, 'tail', await pointOnWire(panel, ad, 0.5, 12))).toBe('short circuit');
  await expect(edge(panel, bc).locator('circle.nx-joint')).toHaveCount(0);
  // b -> c taps a -> b: one teal net that b and c decide
  expect(await dragEnd(page, panel, bc, 'tail', await pointOnWire(panel, ab, 0.5, 12))).toBe('join here');
  const before = await pointsOf(panel, ab);
  expect(await dragEnd(page, panel, ab, 'head', await onSide(panel, t.d, 'in'))).toBe('short circuit');
  expect(await pointsOf(panel, ab)).toEqual(before);
});

test('rule 12: an undecided wire is grey and dashed; open at both ends it keeps its ring and its arrow head', async ({ page }) => {
  const panel = await open(page);
  const spot = await emptySpot(panel);
  const id = await newWire(page, panel, t.a, spot);
  expect(await dragEnd(page, panel, id, 'tail', await emptySpot(panel, [spot]))).toBe('move here');
  expect(await colourOf(panel, id)).toBe(GREY);
  expect(await dashOf(panel, id)).not.toBe('none');
  await expect(edge(panel, id).locator('circle.nx-src')).toHaveCount(1);
  await expect(edge(panel, id).locator('path.nx-head')).toHaveCount(1);
  await expect(edge(panel, id).locator('circle.nx-open')).toHaveCount(0);
});

test('rule 13: a wire with one end open is dashed in its family\'s colour; with both ends connected, solid', async ({ page }) => {
  const panel = await open(page);
  const ab = `${t.a}->${t.b}`;
  expect(await dashOf(panel, ab)).toBe('none');
  expect(await dragEnd(page, panel, ab, 'tail', await emptySpot(panel))).toBe('move here');
  expect(await colourOf(panel, ab)).toBe(TEAL);
  expect(await dashOf(panel, ab)).not.toBe('none');
  expect(await dragEnd(page, panel, ab, 'tail', await onSide(panel, t.a, 'out'))).toBe('connect here');
  expect(await dashOf(panel, ab)).toBe('none');
});

test('rule 14: a picked wire shows its squares; its end squares show the four-way cursor, also while dragged', async ({ page }) => {
  const panel = await open(page);
  const ab = `${t.a}->${t.b}`;
  await pick(page, panel, ab);
  await expect(panel.locator(`.design-wire[data-wire="${ab}"] .design-handle.end`)).toHaveCount(2);
  expect(await panel.locator(`.design-wire[data-wire="${ab}"] .design-handle.seg`).count()).toBeGreaterThanOrEqual(1);
  for (const side of ['tail', 'head'] as const) {
    const at = await centreOf(endSquare(panel, ab, side));
    await page.mouse.move(at.x, at.y);
    expect(await cursorAt(page, at)).toBe('move');
  }
  const at = await centreOf(endSquare(panel, ab, 'head'));
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + 40, at.y + 40, { steps: 4 });
  await expect(panel.locator('.studio-canvas')).toHaveClass(/gesture-move/);
  expect(await cursorAt(page, { x: at.x + 40, y: at.y + 40 })).toBe('move');
  await page.keyboard.press('Escape');
  await page.mouse.up();
});

test('a wire loop and a hidden self-loop are refused', async ({ page }) => {
  const panel = await open(page);
  const ab = `${t.a}->${t.b}`;
  // b -> c's head on a -> b would feed b its own input
  expect(await dragEnd(page, panel, `${t.b}->${t.c}`, 'head', await pointOnWire(panel, ab, 0.5, 12))).toBe('same step');
  // a new wire from d joined on a -> b, then a -> b's head on that wire: current would come back round wires alone
  const id = await newWire(page, panel, t.d, await pointOnWire(panel, ab, 0.5, 12));
  await expect(edge(panel, id).locator('circle.nx-joint')).toHaveCount(1);
  expect(await dragEnd(page, panel, ab, 'head', await pointOnWire(panel, id, 0.5, 12))).toBe('short circuit');
});

test('deleting a host leaves the wire joined on it open where it was, dashed', async ({ page }) => {
  const panel = await open(page);
  const ab = `${t.a}->${t.b}`, bc = `${t.b}->${t.c}`;
  expect(await dragEnd(page, panel, bc, 'tail', await pointOnWire(panel, ab, 0.5, 12))).toBe('join here');
  const joinedAt = (await pointsOf(panel, bc))[0]!;
  await pick(page, panel, ab);
  await page.keyboard.press('Delete');
  await expect(edge(panel, ab)).toHaveCount(0);
  await expect(edge(panel, bc).locator('circle.nx-joint')).toHaveCount(0);
  await expect(edge(panel, bc).locator('circle.nx-src')).toHaveCount(1);
  expect((await pointsOf(panel, bc))[0]).toEqual(joinedAt);
  expect(await dashOf(panel, bc)).not.toBe('none');
});

test('a junction: Undo removes it, Redo brings it back, and a refresh keeps it', async ({ page }) => {
  const panel = await open(page);
  const bc = `${t.b}->${t.c}`;
  expect(await dragEnd(page, panel, bc, 'tail', await pointOnWire(panel, `${t.a}->${t.b}`, 0.5, 12))).toBe('join here');
  await expect(edge(panel, bc).locator('circle.nx-joint')).toHaveCount(1);
  await page.keyboard.press('Control+z');
  await expect(edge(panel, bc).locator('circle.nx-joint')).toHaveCount(0);
  await page.keyboard.press('Control+y');
  await expect(edge(panel, bc).locator('circle.nx-joint')).toHaveCount(1);
  await page.reload();
  const again = documentPanel(page, t.workflow);
  await expect(edge(again, bc).locator('circle.nx-joint')).toHaveCount(1);
  await expect(page.getByText('● design draft')).toBeVisible();
});

test('an entry-condition edit that makes a short circuit marks the junction red and lists it in Problems', async ({ page }) => {
  const panel = await open(page);
  expect(await dragEnd(page, panel, `${t.b}->${t.c}`, 'tail', await pointOnWire(panel, `${t.a}->${t.b}`, 0.5, 12))).toBe('join here');
  await node(panel, t.c).click({ position: { x: 20, y: 12 } });
  await expect(inspector(page).locator('.kindpill')).toHaveText('STEP');
  await inspector(page).getByLabel('Entry condition', { exact: true }).click();
  await inspector(page).getByRole('option', { name: /Failed/ }).click();
  await expect(edge(panel, `${t.b}->${t.c}`).locator('circle.nx-joint.short')).toHaveCount(1);
  await tab(page, 'Problems').click();
  await expect(page.locator('[data-pane="problems"]')).toContainText('short circuit: Completed meets Failed');
});
```

- [ ] **Step 3: The Save spec on the circuit throwaway**

Create `src/WorkflowStudio/e2e/circuit-save.spec.ts`:

```ts
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { centreOf, documentPanel, inspector, openWorkflow, pointOnWire, tab } from './studio';
import { createCircuitThrowaway, expect, removeThrowaway, test, type CircuitThrowaway } from './throwaway';

// Plan 9 §7: Save derives nextStepIds and entryStepIds by tracing the current. These tests save only their own throwaway
// workflow (`e2e-9-…`: a, b, c Completed, d Failed; wf -> a, a -> b, a -> d, b -> c), made and deleted through BaseApi's
// CRUD; throwaway.ts's guard aborts any other write. They build on each other's state, so they run in order.
test.describe.configure({ mode: 'serial', retries: 0 });
let t: CircuitThrowaway;
test.beforeAll(async ({ request }) => { t = await createCircuitThrowaway(request); });
test.afterAll(async ({ request }) => { await removeThrowaway(request); });
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
});

const node = (panel: Locator, id: string) => panel.locator(`.react-flow__node[data-id="${id}"]`);
const edge = (panel: Locator, id: string) => panel.locator(`.react-flow__edge[data-id="${id}"]`);
const endSquare = (panel: Locator, id: string, side: 'tail' | 'head') => panel.locator(`.design-wire[data-wire="${id}"] .design-handle.end[data-end="${side}"]`);
const newWires = (panel: Locator) => panel.locator('.react-flow__edge[data-id^="w:"]');
const sorted = (ids: readonly string[]) => [...ids].sort();

async function get<T>(request: APIRequestContext, path: string): Promise<T> {
  const r = await request.get(`/api/v1/${path}`);
  expect(r.ok(), `GET ${path}`).toBe(true);
  return (await r.json()) as T;
}
const nextOf = async (request: APIRequestContext, id: string) => (await get<{ nextStepIds: string[] }>(request, `steps/${id}`)).nextStepIds;

async function open(page: Page): Promise<Locator> {
  await openWorkflow(page, t.workflow);
  return documentPanel(page, t.workflow);
}

/** The capsule's Save, then wait for the answer (the button leaves "Saving…"). */
async function save(page: Page): Promise<void> {
  await page.getByRole('button', { name: '⤓ Save' }).click();
  await expect(page.getByRole('button', { name: '⤓ Saving…' })).toHaveCount(0, { timeout: 20_000 });
}

async function pane(page: Page, name: 'Problems' | 'Output'): Promise<Locator> {
  await tab(page, name).click();
  return page.locator(`[data-pane="${name.toLowerCase()}"]`);
}

async function setEntryCondition(page: Page, panel: Locator, id: string, name: RegExp): Promise<void> {
  await node(panel, id).click({ position: { x: 20, y: 12 } });
  await expect(inspector(page).locator('.kindpill')).toHaveText('STEP');
  await inspector(page).getByLabel('Entry condition', { exact: true }).click();
  await inspector(page).getByRole('option', { name }).click();
}

async function dragReading(page: Page, panel: Locator, from: { x: number; y: number }, to: { x: number; y: number }): Promise<string | null> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 5 });
  await page.mouse.move(to.x, to.y, { steps: 5 });
  const label = panel.locator('.design-drop-label');
  const text = (await label.count()) > 0 ? await label.textContent() : null;
  await page.mouse.up();
  return text;
}

async function dragEnd(page: Page, panel: Locator, id: string, side: 'tail' | 'head', to: { x: number; y: number }): Promise<string | null> {
  const p = await pointOnWire(panel, id);
  await page.mouse.click(p.x, p.y);
  await expect(endSquare(panel, id, side)).toBeVisible();
  return dragReading(page, panel, await centreOf(endSquare(panel, id, side)), to);
}

test('a tail joined on a wire fans out: Save writes the tapped step\'s current into both steps; a fresh read draws the junction again', async ({ page, request }) => {
  const panel = await open(page);
  expect(await dragEnd(page, panel, `${t.b}->${t.c}`, 'tail', await pointOnWire(panel, `${t.a}->${t.b}`, 0.5, 12))).toBe('join here');
  await save(page);
  await expect(await pane(page, 'Output')).toContainText('Saved and applied');
  expect(sorted(await nextOf(request, t.a))).toEqual(sorted([t.b, t.c, t.d]));
  expect(await nextOf(request, t.b)).toEqual([]);
  await page.reload();
  await expect(edge(documentPanel(page, t.workflow), `${t.b}->${t.c}`).locator('circle.nx-joint')).toHaveCount(1);
});

test('a head joined on a wire fans in; where it joins decides what its current reaches', async ({ page, request }) => {
  const panel = await open(page);
  const ab = `${t.a}->${t.b}`;
  // before b -> c's tap (at a -> b's middle): d's current reaches b and c
  await node(panel, t.d).hover();
  const label = await dragReading(page, panel, await centreOf(node(panel, t.d).locator('.nx-port')), await pointOnWire(panel, ab, 0.15, 12));
  expect(label).toBe('join here');
  await expect(newWires(panel)).toHaveCount(1);
  const id = (await newWires(panel).first().getAttribute('data-id'))!;
  await save(page);
  expect(sorted(await nextOf(request, t.d))).toEqual(sorted([t.b, t.c]));
  // after the tap: d's current reaches b only
  expect(await dragEnd(page, panel, id, 'head', await pointOnWire(panel, ab, 0.85, 12))).toBe('join here');
  await save(page);
  expect(await nextOf(request, t.d)).toEqual([t.b]);
});

test('an entry-condition edit that makes a short circuit: listed in Problems; Save writes none of its links and says so; a fresh read keeps it marked', async ({ page, request }) => {
  const panel = await open(page);
  await setEntryCondition(page, panel, t.c, /Failed/);
  await expect(panel.locator('circle.nx-joint.short').first()).toBeVisible();
  await expect(await pane(page, 'Problems')).toContainText('short circuit: Completed meets Failed');
  await save(page);
  await expect(await pane(page, 'Output')).toContainText('Saved and applied; 1 short circuit not written');
  await expect(await pane(page, 'Problems')).toContainText('short circuit: Completed meets Failed');
  expect((await get<{ entryCondition: number }>(request, `steps/${t.c}`)).entryCondition).toBe(2);
  expect(await nextOf(request, t.a)).toEqual([t.d]);
  await page.reload();
  await expect(documentPanel(page, t.workflow).locator('circle.nx-joint.short').first()).toBeVisible();
});

test('a tail joined on an entry wire makes the steps its current reaches entry steps', async ({ page, request }) => {
  const panel = await open(page);
  await setEntryCondition(page, panel, t.c, /Completed/);
  await expect(panel.locator('circle.nx-joint.short')).toHaveCount(0);
  expect(await dragEnd(page, panel, `${t.a}->${t.b}`, 'tail', await pointOnWire(panel, `wf->${t.a}`, 0.5, 10))).toBe('join here');
  await save(page);
  await expect(await pane(page, 'Output')).toContainText('Saved and applied');
  expect(sorted((await get<{ entryStepIds: string[] }>(request, `workflows/${t.workflow.id}`)).entryStepIds)).toEqual(sorted([t.a, t.b, t.c]));
  expect(await nextOf(request, t.a)).toEqual([t.d]);
  expect(await nextOf(request, t.d)).toEqual([t.b]);
});
```

- [ ] **Step 4: Bring the plan 8 specs to the circuit**

In `src/WorkflowStudio/e2e/save.spec.ts`:
- `const looseWires = (panel: Locator): Locator => panel.locator('.react-flow__edge[data-id^="loose:"]');` → `const newWires = (panel: Locator): Locator => panel.locator('.react-flow__edge[data-id^="w:"]');`, and every `looseWires(` → `newWires(`;
- in the first test: the comment `// on the canvas: a new wire from B's port, released on empty canvas, is a loose wire` → `// on the canvas: a new wire from B's port, released on empty canvas, is a grey wire open at its head (plan 9)`, and `toHaveText('loose wire')` → `toHaveText('move here')`;
- the second test's title ends `…, the new wire stays in the layout` instead of `…, the loose wire stays in the layout`;
- replace the last test (`an entry wire whose tail was dragged off the hub is never sent as an entry: …`) with:

```ts
test('an entry wire whose tail was dragged off the hub is never sent as an entry: Save sends an empty entry list, and the layout keeps the wire open at its tail', async ({ page }) => {
  await openWorkflow(page, t.workflow);
  const panel = documentPanel(page, t.workflow);
  const wireId = `wf->${t.stepId}`;
  const p = await pointOnWire(panel, wireId);
  await page.mouse.click(p.x, p.y);
  const tail = await centreOf(panel.locator(`.design-wire[data-wire="${wireId}"] .design-handle.end[data-end="tail"]`));
  const area = (await panel.locator('.studio-canvas').boundingBox())!;
  const empty = { x: area.x + area.width - 80, y: area.y + area.height - 120 };
  await page.mouse.move(tail.x, tail.y);
  await page.mouse.down();
  await page.mouse.move(empty.x, empty.y, { steps: 12 });
  await expect(panel.locator('.design-drop-label')).toHaveText('move here');
  await page.mouse.up();
  await expect(panel.locator(`.react-flow__edge[data-id="${wireId}"] circle.nx-src`)).toHaveCount(1);

  const sent = page.waitForRequest((r) => r.method() === 'PUT' && r.url().endsWith(`/workflows/${t.workflow.id}/design`));
  await save(page);
  const body = (await sent).postDataJSON() as { workflow: { entryStepIds: string[] | null }; steps: { nextStepIds: string[] | null }[]; layout: { v: number; wires: Record<string, { tail: { on: string } }> } };
  expect(body.workflow.entryStepIds).toEqual([]);
  expect(body.steps.flatMap((s) => s.nextStepIds ?? [])).not.toContain(t.stepId);
  expect(body.layout.v).toBe(2);
  expect(body.layout.wires[wireId]!.tail.on).toBe('open');

  // a fresh read keeps the wire: open at its tail, its arrow head on its step, in its step's colour, dashed
  await page.reload();
  const again = documentPanel(page, t.workflow);
  await expect(again.locator(`.react-flow__edge[data-id="${wireId}"] .nx-head`)).toHaveCount(1);
  await expect(again.locator(`.react-flow__edge[data-id="${wireId}"] path.w`)).toHaveAttribute('stroke', '#2DD4BF');
});
```

In `src/WorkflowStudio/e2e/designer.spec.ts`:
- replace the test `a wire end dropped where it closes a loop is allowed: green, "re-attach here", and the loop is drawn (plan 8 §5)` with:

```ts
test('a wire end dropped where it closes a loop is allowed: green, "connect here", and the wire keeps its id (plan 8 §5, plan 9)', async ({ page }) => {
  const { a, b, c } = chain!;
  const panel = await open(page);
  const id = `${b}->${c}`;
  const p = await pointOnWire(panel, id);
  await page.mouse.click(p.x, p.y);
  const head = await centreOf(panel.locator(`.design-wire[data-wire="${id}"] .design-handle.end[data-end="head"]`));
  const target = await centreOf(node(panel, a).locator('.nx-sn'));
  await page.mouse.move(head.x, head.y);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 6 });
  await expect(node(panel, a)).toHaveClass(/drop-ok/);
  await expect(panel.locator('.design-drop-label')).toHaveText('connect here');
  await page.mouse.up();
  await expect(wire(panel, id)).toHaveCount(1);
  await expect(page.getByText('● design draft')).toBeVisible();
});
```

- in `a new entry wire from the hub, Delete, and a step left unreached looks like any step; Undo and Redo`: `await expect(wire(panel, \`wf->${c}\`)).toHaveCount(1);` → `await expect(panel.locator('.react-flow__edge[data-id^="w:"]')).toHaveCount(1);`
- replace `the arrow head of a picked wire dropped on an allowed step re-attaches it there` with:

```ts
test('the arrow head of a picked wire dropped on another step connects it there; the wire keeps its id (plan 9)', async ({ page }) => {
  const panel = await open(page);
  const { a, b, c } = chain!;
  const id = `${a}->${b}`;
  const before = await arrowEndOf(panel, id);
  const p = await pointOnWire(panel, id);
  await page.mouse.click(p.x, p.y);
  const head = await centreOf(panel.locator(`.design-wire[data-wire="${id}"] .design-handle.end[data-end="head"]`));
  const target = await centreOf(node(panel, c).locator('.nx-sn'));
  await page.mouse.move(head.x, head.y);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 6 });
  await expect(node(panel, c)).toHaveClass(/drop-ok/);
  await page.mouse.up();
  await expect(wire(panel, id)).toHaveCount(1);
  await expect.poll(() => arrowEndOf(panel, id)).not.toBe(before);
  await expect(page.getByText('● design draft')).toBeVisible();
});
```

- replace `the legend shows the loose wire, and nothing broken or parked (plan 8 §5)` with:

```ts
test('the legend shows the undecided wire and the short circuit; no loose wire, nothing broken or parked (plan 9 §5)', async ({ page }) => {
  const panel = await open(page);
  const items = panel.locator('.legend .lg-item');
  await expect(items.filter({ hasText: /^undecided$/ })).toHaveCount(1);
  await expect(items.filter({ hasText: /^short circuit$/ })).toHaveCount(1);
  await expect(items.filter({ hasText: /loose|broken|parked/i })).toHaveCount(0);
});
```

- delete these tests (their behaviour is plan 7/8's and is replaced by `circuit.spec.ts`): `a dragged wire end lands on a step's border, never inside; on its own step it moves its contact point; on empty canvas it becomes a loose wire`; `a dragged tail over its own step is told "starts here"; a head 5 px short of a step border is already over it`; `a wire's arrow dropped on a same-colour line joins it: …`; `a wire's arrow over a line of another colour is a loose-wire drop: …`; `a joined wire's contact square has the four-way move cursor, …`; `a wire's arrow dragged over a cache tag is a loose-wire drop: …`; `a new wire dropped on empty canvas is a loose wire: …`; `a loose wire from the hub: its open end dropped back on the hub …`; `a picked loose wire has the squares of a wire: …`; `a wire's tail released on empty canvas leaves it loose at its start: …`; `an entry wire's tail dragged off the hub is loose at its start, …`; `a joined wire's tail detached keeps its junction and its host's colour`; `a host wire detached at its tail and re-attached to a new source keeps the wires joined on it joined (on its new id)`; `a wire detached at its tail and then its head is open at both ends: …`.
- run `npx tsc -b` (then delete `tsconfig.tsbuildinfo`) and delete every helper of `designer.spec.ts` it reports unused (`findJoin`, `LiveWire`, `mayJoin`, `otherColour`, `nearestPair`, `dragArrowOnto`, `cursorAt`, `findCache`, `emptySpot`, `dragReading`, `tailSquare`, `blocksCrossed` only if unused, …) and nothing else.

- [ ] **Step 5: Run the e2e suite on the dev server**

Run (PowerShell, `src/WorkflowStudio`, port forwards up: `./k8s/port-forward-realstack.ps1 -Status`): `npx playwright test e2e/circuit.spec.ts e2e/circuit-save.spec.ts e2e/save.spec.ts e2e/designer.spec.ts`
Expected: all pass. Then the whole suite: `npx playwright test`
Expected: all pass except the two known `art.spec.ts` skips. Afterwards BaseApi lists no `e2e-8-…` or `e2e-9-…` workflow or step:
`(Invoke-RestMethod http://localhost:18080/api/v1/workflows) | Where-Object { $_.name -like 'e2e-*' }` and the same for `steps` print nothing.

A test that fails on a timing or a point that is not clear on screen is fixed in the test (wait on the state, or choose `pointOnWire`'s fraction or `clear`), never by changing studio behaviour; a test that shows a real bug sends you back to the task that owns the code.

- [ ] **Step 6: Commit**

```bash
git add src/WorkflowStudio/e2e/throwaway.ts src/WorkflowStudio/e2e/circuit.spec.ts src/WorkflowStudio/e2e/circuit-save.spec.ts src/WorkflowStudio/e2e/save.spec.ts src/WorkflowStudio/e2e/designer.spec.ts
git commit -m "test(studio): Playwright with a real mouse: one test per circuit rule, loops, delete, refresh, short circuit; Save of fan-in, fan-out and hub entries (plan 9)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Deploy the studio, verify on the deployed studio, update the handover

**Files:**
- Modify: `docs/HANDOVER-2026-10-08-skp-studio-plan8.md`
- Temporary, never committed: `src/WorkflowStudio/playwright.deployed.config.ts`

**Interfaces:**
- Consumes: Tasks 1-11 (all committed, Vitest, `tsc` and Playwright green on the dev server).
- Produces: the deployed studio bundle; the handover's plan 9 section.

- [ ] **Step 1: Everything green before the deploy**

Run (PowerShell, `src/WorkflowStudio`): `npx vitest run`, `npx tsc -b` (then delete `tsconfig.tsbuildinfo`), `npx playwright test`.
Expected: Vitest all pass; no type errors; Playwright all pass except the two `art.spec.ts` skips. Write down the three counts.

- [ ] **Step 2: Build and roll out the studio** (approved by the user; it restarts only `workflow-studio`)

Run from the repo root (PowerShell):

```powershell
docker build -f src/WorkflowStudio/Dockerfile -t workflow-studio:local .
kind load docker-image workflow-studio:local --name desktop
kubectl -n skp rollout restart deploy/workflow-studio
kubectl -n skp rollout status deploy/workflow-studio --timeout=180s
./k8s/port-forward-realstack.ps1 -Status
```

Expected: the rollout completes; the forwards report studio `localhost:18081` and BaseApi `localhost:18080` up (if not, run `./k8s/port-forward-realstack.ps1` again). Record the bundle name:

```powershell
((Invoke-WebRequest http://localhost:18081/).Content | Select-String -Pattern 'index-[\w-]+\.js').Matches[0].Value
```

- [ ] **Step 3: The e2e suite against the deployed studio**

Create `src/WorkflowStudio/playwright.deployed.config.ts` (never committed):

```ts
import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// the deployed studio through the supervised port forward: no dev server
export default defineConfig({ ...base, use: { ...base.use, baseURL: 'http://localhost:18081' }, webServer: undefined });
```

Run: `npx playwright test --config playwright.deployed.config.ts`
Expected: the same result as on the dev server (all pass, the two `art.spec.ts` skips). Then delete `playwright.deployed.config.ts` and check BaseApi lists no `e2e-…` workflow or step (as in Task 11 Step 5). `git status` must not show the config.

- [ ] **Step 4: Update the handover**

In `docs/HANDOVER-2026-10-08-skp-studio-plan8.md`, after the first paragraph, insert this section with the bundle name and the counts from Steps 1-3 written in:

```markdown
## Plan 9: wires as a circuit (built and deployed)

Spec `docs/superpowers/specs/2026-10-08-skp-studio-09-wire-circuit-design.md`; plan
`docs/superpowers/plans/2026-10-08-skp-studio-09-wire-circuit.md`. Studio only; BaseApi unchanged. Deployed bundle
`index-….js` (the name recorded in Task 12 Step 2).

- **One model.** A wire is `{ tail, head, bends? }`; each end is on a step side, the hub's ring, another wire (a
  junction) or open (`src/circuit/`). Loose-wire records, plan 7 contacts and the joint/branch drawing are gone; old
  sessions and layouts read as circuits and are settled on load (`design/settle.ts`).
- **Save** derives `nextStepIds` / `entryStepIds` by tracing the current (fan-in, fan-out, position along a wire, hub
  taps, duplicates once); the layout is `v: 2` with the whole circuit. A short-circuited net is marked red, listed in
  Problems live, reported on Save and not written.
- **Drops** say `connect here` / `join here` / `move here` or refuse in red: `wrong side`, `same step`, `same wire`,
  `short circuit`, `only a tail on the workflow`. End squares have the four-way cursor; a wire keeps its id for life.
- **Decisions** the user may still override: plan 9's "Decisions made in this plan" (hub angles snap to 15°; slides
  stay in the processor band 64..128; equal points on a host do not meet; a drop into an already shorted net is
  refused; a shorted net's error sits on a step of its highest family).
- **Tests.** Vitest: <count> passed. Playwright on the dev server: <count> passed, 2 skipped. On the deployed studio:
  <count> passed, 2 skipped. `e2e/circuit.spec.ts` (one test per rule, read-only) and `e2e/circuit-save.spec.ts`
  (Save) use their own `e2e-9-…` throwaway workflow made and deleted through BaseApi's CRUD.
- **Follow-ups:** creating new wires other than from a block's connection point (deferred by the spec); the flow
  pulse is still per wire (no animation through junctions); spec gaps listed at the end of the plan 9 plan.
```

Replace each `<count>` with the measured number and `index-….js` with the recorded bundle name before saving the file. Also update the "Where we are" bullet list with one line: `- **Plan 9 (wires as a circuit) is BUILT and DEPLOYED** (see the section above).`

- [ ] **Step 5: Commit**

```bash
git add docs/HANDOVER-2026-10-08-skp-studio-plan8.md
git commit -m "docs(studio): handover records plan 9 (wires as a circuit) and the deployed bundle" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Self-review

**Spec coverage.**

| Spec | Where |
|---|---|
| §1 one model, the circuit | Tasks 1-3 (model, tracer, families), decision 1 |
| §2 rule 1 hub ring, several tails | Task 4 (`hubLead`, automatic fan), Task 5 (`targetOf` angle), Task 9 test, Task 11 rule 1 |
| §2 rule 2 two sides; §2.1 wrong side refused, both ends slide | Task 5 (`judgeDrop` wrongSide), Task 4 (slid `y`), Task 9 tests, Task 11 rules 2, 5 |
| §2 rule 3 arrow with tail and head; §2.1 open ends keep ring and arrow | Task 8 (`CableEdgeView`, `arrowHead`), Task 11 rules 3, 12 |
| §2 rule 4 junctions at any point; not itself; not both ends on one wire; filled circle | Tasks 1, 4, 5, 8, 9; Task 11 rule 4 |
| §2 rule 5 head left / tail right | Task 5, Task 11 rule 5 |
| §2 rule 6 tails only on the hub | Task 5 (`hubTail`), Task 11 rule 6 |
| §2 rules 7-11, §2.2-2 families per net, first decides | Task 3, Task 4 (colour), Task 5 (`short`), Task 11 rules 7-11 |
| §2 rule 12 grey dashed; §2.2-5 solid/dashed | Task 4 (`solid`), Task 8 (`dashed`), Task 11 rules 12, 13 |
| §2 rule 14 squares, four-way cursor | Task 9 (overlay, `gesture-move`, CSS), Task 11 rule 14 |
| §2.2-1 position on a wire | Task 2, Task 11 Save test 2 |
| §2.2-3 loops refused; §2.2-4 hidden self-loops refused | Task 2 (`loop`), Task 5, Task 9 tests, Task 11 extra |
| §2.2-6 host deleted → joined ends open | Task 1 (`removeCircuitWires`), Task 9 (`useDesignKeys`), Task 11 extra; detached: decision 9 |
| §2.2-7 later contradiction marked, in Problems, on Save | Task 4 (`short`), Task 8 (red), Task 10, Task 11 extra and Save test 3 |
| §2.2-8 duplicates once; hub tap → entry; stored junction disagreeing drawn plain | Task 2, Task 6, Task 7 (`settleDesign` on load), Task 11 Save test 4 |
| §3 terminals, wires, junctions | Tasks 1, 4, 5 |
| §5 drawing table, ends, squares, legend | Tasks 4, 8, 9 |
| §6 gestures, labels, open anywhere, runs, Reset route, Delete, Undo | Tasks 5, 7 (`resetShape`), 9 |
| §7 Save by tracing; layout keeps every wire; request shape unchanged; on load BaseApi is the truth | Tasks 6, 7 (layout v2, settle), 10 |
| §8 plan 7 / plan 8 records parse | Task 1 (`legacyCircuit`), Task 7 (`parseDraft`, `storedDesignOf`), Task 6 |
| §9 out of scope | not built (new-wire creation unchanged, Task 9 `startNew`) |
| §10 Vitest list; Playwright one per rule plus extras; dev server and deployed | Tasks 1-10 tests; Task 11; Task 12 |

**Placeholder scan.** No "TBD" / "similar to Task N"; every code step has its code. The handover text in Task 12 holds two kinds of values only known when it runs (the bundle name and the test counts), marked to be filled with the measured values.

**Type consistency.** `End`, `Side`, `CircuitWire`, `Circuit` (Task 1) are used with the same names in Tasks 2-10; `WireRoute` is the Task 4 shape everywhere from Task 7 on (`source`/`target` nullable, `core`, `tailOn`/`headOn`, `solid`, `short`); `withCircuit(draft, saved, wires)`, `circuitOf(saved, draft)`, `removeWires(draft, saved, ids, pointOf)`, `setShape(draft, saved, id, shape)`, `resetShape(draft, saved, id)` keep one signature from Task 7 to Task 11; `DropTarget` / `Verdict` / `toneOf` ('ok' | 'move' | 'no') match `DropHint.tone` and `withHint`; `CableEdgeData.halo` is 'ok' | 'no' and the canvas never passes 'move'.

**Review Focus.** Five pinned (header list): legacy layouts (Tasks 6, 7), shorts surviving reload (Task 6), duplicate paths (Tasks 2, 10), chained host deletion (Task 1), own end run (Task 9).

## Spec gaps found

1. **"A host wire deleted or detached"** (§2.2-6): only deletion removes the line the joined ends sit on; a detached host's line is still drawn. Decided: joined wires stay on a detached host (decision 9).
2. **The short-circuit Save error sits "on the junction's wire" with kind `step`** (§7): a wire is not a step and has no entity. Decided: on a step of the net's highest family (decision 10).
3. **Which colour a short-circuited net's wires are drawn in** (§5 table "the family"): a shorted net has two. Decided: each wire the family its own head chain reaches (decision 10).
4. **The span a slid end may use** (§3 "inside the side's span"): decided the processor band 64..128 the frame traces reach (decision 5); the user may want the whole side (0..160).
5. **Hub contact granularity** (§2.1 "each where it was dropped"): decided 15° steps (decision 4).
6. **Equal positions on a host** (§2.2-1 "further along"): decided strict, equal points do not meet (decision 8).
7. **A drop into a net that is already short-circuited**: the spec only refuses drops that bring two families together; decided refused while the net stays shorted (decision 7).
8. **Labels for a closed loop and a hidden self-loop**: §6 lists "short circuit" and "same step"; the spec does not say which each gets. Decided loop → "short circuit" (§2.2-3 calls it one), self-feed → "same step".
9. **Rule 14 "touching a wire"** vs §5 "picked (clicked) wires show squares": the plan follows §5 (a click picks, hover shows nothing), as today.
10. **The per-rule Playwright tests need two families side by side** (rules 9-11): live data cannot be relied on; decided a throwaway workflow for the design-only spec too (decision 15).
11. **Plan 8's `was` field** (a start-loose wire's old id) has no meaning in the new model (ids never change) and is dropped when an old session or layout is read.
