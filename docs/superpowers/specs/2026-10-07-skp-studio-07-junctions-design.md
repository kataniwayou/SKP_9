# SKP Studio plan 7: junctions (wire onto wire) -- design

Date: 2026-10-07. Branch `feature/path-importer`. Builds on plan 4, the canvas designer trial
(`2026-10-07-skp-studio-04-canvas-designer-design.md`), which the user approved on 2026-10-07 by starting this plan.
Where this document differs from the main spec (`2026-10-05-skp-studio-design.md`) §5.2 and §5.5 on junctions,
this document wins.

## 1. Purpose

A wire's arrow may end on another wire's line instead of running all the way to its step. This is **drawing
only**: which step follows which never changes. The user's words: "contact to wire body instead of contact all
the way to the same step doesn't actually change anything, it is just more elegant drawing."

Decisions taken with the user (2026-10-07):

- **Rule.** Wire A may end on wire B's line when both have the **same colour** (the same entry condition: a
  wire's colour is its target step's entry condition, `layout/wires.ts`) and B is not A. Whatever step they come
  from and whichever step they go into.
- **Option (a): A keeps its own target.** A runs along B's line from the contact point and, when its step is not
  B's step, leaves B's line again at the point **nearest A's target** and continues to its own step.
- **Chains are allowed** (A on B while B is on C), with a **loop check**.
- **Hand-made only.** A junction exists only where the user drops a wire on another. The old automatic junction
  for steps with four or more incoming wires (main spec §5.2: bus, trunk, junction node) is not built.

## 2. Scope

In: the junction drawing, its storage in the design draft (and so the session), joining by dragging a wire's
arrow end onto a line, the contact handle, removing a junction, and the drop labels.

Out: saving junctions (comes with Save after the trial; the layout stores them then), the automatic bus/trunk
junction, dragging the split point, joining a wire's start onto a line, junctions on the read-only canvas.

## 3. The marks: one meaning each

A wire's ends and meeting points use three marks, and each mark means one thing only (the user asked that wires
into a step, wires from a step and wires onto a junction be consistent and never confusing):

| Mark | Means | Appears |
|---|---|---|
| hollow ring (`.nx-src`, unchanged) | the wire leaves a step | only at a step's output or the hub |
| open arrow head (`.nx-head`, unchanged) | the wire enters a step | only on a step's input side |
| **filled dot**, wire colour (new, `.nx-joint`) | the wire is on a line | only where a wire meets another wire's line |

So a line never ends in an arrow head or a ring, and a step never touches a dot. The **contact** (where A joins
B's line) and the **split** (where A leaves the shared line) are the same mark. The dot is filled and clearly
larger than the ring (radius 4.5 against 2.6), so the two cannot be mistaken.

## 4. Storage

A wire's shape in the draft (`WireShape`, `layout/shape.ts`) gains an optional field:

```ts
contact: { host: string; at: number } | null
```

- `host`: the id (`source->target`) of the wire whose line A sits on.
- `at`: the distance along the host's **drawn line** (§5.1) from the host's start, snapped to 8 px.

A shape without a contact is a plain wire, as today. The draft's wiring (`next`, `entries`) is untouched by every
junction gesture. The session stores `contact` like the other shape fields; a malformed contact (not an object,
`host` not a string, `at` not a finite number) is dropped silently, like other malformed draft parts.
`setShape` drops an entry whose `bends`, `landing` and `contact` are all null.

## 5. Routing and drawing

### 5.1 Words

- A wire's **own line**: from its source to its contact point (a joined wire), or its whole route (a plain wire).
- A wire's **branch**: from its split point to its landing on its own step (a joined wire only; may be empty).
- A wire's **drawn line**: its own line followed by its branch. A contact's `at` is measured along this.
- A wire's **travelled line**: the way it really goes: its own line, then its host's travelled line from the
  contact up to the split, then its branch. For a plain wire it is its route.

### 5.2 Order and validity

`routeWires` routes in two passes. First every plain wire, as today. Then joined wires, each after its host
(hosts first, so chains resolve in order). A contact is **ignored** (the wire is routed plain, the draft entry is
kept so undo still works) when: the host is not on the canvas; the host's colour differs; the host is the wire
itself; or following hosts from the wire comes back to it (a loop).

### 5.3 A joined wire's route (A on host B)

- **Contact point**: the point at distance `at` along B's drawn line, clamped to stay at least 16 px from B's
  start and from B's arrow tip.
- **A's own line**: from A's source port to the contact point, right-angled, kept clear of every block with the
  detour router (`layout/detour.ts`). It meets B's line **square-on**: its last run is vertical onto a horizontal
  run of B and horizontal onto a vertical run of B. A's manual bends (run drags) apply to this part.
- **Shared part**: B's travelled line from the contact point onward, down to B's arrow. It is drawn once, by B.
- **Split point**: the point on the shared part nearest A's landing (straight-line distance), snapped to 8 px.
- **A's branch**: from the split point to A's landing on its own step, right-angled, clear of blocks, ending in
  A's arrow head. Always automatic. A's landing follows the usual landing rule (or A's slid landing).
- **Same step as B**: the split is B's arrow tip and the branch is empty: A draws no branch and no arrow head of
  its own; B's arrow carries both.

### 5.4 Drawing

A joined wire is still **one edge** on the canvas (one id, one selection, one delete). It draws: its tail ring at
the source; its own line ending in a filled dot on B's line; when its branch is not empty, a filled dot at the
split point and the branch ending in its arrow head. Clicking A's own line or A's branch selects A; clicking the
shared part selects its owner (B, or B's host along a chain). A broken (dashed) wire's dashes and ⚠ mark apply to
its own line and branch.

## 6. Gestures

### 6.1 Joining

Drag a picked wire's **arrow end square** (or a joined wire's contact square, §6.2) over another wire's line.

- **What the pointer is over**: a block under the pointer wins (the end drag rules of plan 4 apply). Otherwise a
  wire line within 6 screen px is the drop target; the nearest line wins.
- **While dragging**: the line under the pointer gets a halo, green when the drop is allowed and red when not, and
  the label next to the pointer says "join here", or why not: "other colour", "same wire", "would make a loop".
  The dragged wire previews live: its own line to a dot on the line, the split dot and its branch.
- **On release** over an allowed line: the wire's shape becomes `{ bends: null, landing: kept, contact: { host,
  at } }` (its own line automatic). One history step. Elsewhere the plan 4 end-drag rules apply unchanged
  (another step re-attaches; its own step moves the landing; empty canvas snaps back).
- **Only an arrow end joins.** A start square over a line shows "start stays on a block" in red and snaps back.
- **A new wire** drawn from a connection point must still end on a step; over a line its label says "drop on a
  step" (red). It can be joined afterwards by dragging its arrow end.

### 6.2 Handles of a picked joined wire

- **Start square** at the source: as today (↔ cursor; re-sources the wire).
- **Contact square** on the contact dot, with the **four-way cursor** (`move`), kept while dragged. Dropped on any
  allowed line (the same host slides the contact; another wire re-hosts); on a step: the wire becomes plain
  (contact removed) and attaches there (its own step: plain again; another step: re-attached as in plan 4); on
  empty canvas or a refused line: snaps back.
- **Arrow square** at the branch's arrow (absent when the branch is empty): ↔ cursor; dragging it re-attaches the
  wire to another step as in plan 4. The contact is kept; it is ignored (§5.2) if the new step's colour differs.
- **Run squares** on the own line only. The branch and the split dot have no handles.

### 6.3 Removing a junction

Right-click → **Reset route** removes bends, landing and contact: the wire is plain and automatic again. Dragging
the contact square onto the wire's own step does the same for the contact. **Delete** removes the wire as today.
A wire whose host is deleted, re-attached to another colour, or now in a loop is drawn plain (§5.2) until undo.

## 7. Edge cases

- The host moves or reroutes: the contact keeps its `at`, clamped (§5.3).
- Several wires on one host, at the same point: allowed; their dots overlap.
- Entry wires from the hub can join and host. Broken wires can join and host.
- A host that is itself joined: the joined wire's contact can be on the host's own line or its branch; the
  shared part follows the host's travelled line.
- Undo/redo, Discard design and refresh behave as for every other draft part (plan 4 §5).
- No BaseApi writes: the read-only guard of the e2e tests still holds.

## 8. Structure

- `layout/junctions.ts` (new): measuring along a line, the contact point, the square-on own line, the split
  point, the branch; ordering hosts first; validity (§5.2). Pure.
- `layout/wires.ts`: `WireRoute` gains optional `joint` data (`own` points, `branch` points, `contact`, `split`);
  `routeWires` runs the second pass.
- `layout/shape.ts`: `WireShape.contact`.
- `design/draft.ts`: `setShape` and session parsing know `contact`.
- `design/rules.ts`: `canJoin(shown, wire, host)` → `'ok' | 'colour' | 'self' | 'loop'`; labels.
- `design/hit.ts`: `wireAt(doc, p, tolerance)` → the nearest line and the distance along it.
- `design/useWireGestures.ts`: joining in the end drag; the contact square's drag.
- `design/DesignOverlay.tsx`: the contact square; the line halo.
- `canvas/edges/CableEdge.tsx` + `canvas/art.css`: own line, branch, `.nx-joint` dots.

## 9. Testing

- **Unit** (`layout/junctions.test.ts`): own line meets the host square-on (both run directions); split nearest
  the target; same step merges with an empty branch; a chain of three routes in order; a loop, a missing host and
  another colour fall back to plain; no part of a joined wire passes through a block; `at` clamped on a shortened
  host. `design/draft.test.ts`: session parsing of `contact`. `design/rules.test.ts`: `canJoin`.
- **jsdom gestures** (`design/useWireGestures.test.tsx`): join (one history step, the shape written); each refusal
  label; contact square slide, re-host, back to its own step; Reset route; a start square over a line refused.
- **Playwright, real mouse drags**, on the dev server and again on the deployed studio, on the live workflow
  `filefetcher-archiveexpander-chain` (many red Failed wires): join one red wire onto another and check the
  contact dot lies on the host's line, the branch's arrow lands on the joined wire's own step, and no part of
  either wire is inside a block (`blocksCrossed`); a red wire over a teal line is refused with "other colour";
  the contact square dragged to its own step makes the wire plain; a refresh keeps the junction; undo removes it.
