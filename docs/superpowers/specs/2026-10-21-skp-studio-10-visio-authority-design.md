# SKP Studio plan 10: Visio is the authority for drawing blocks and wires — design

Date: 2026-10-21. Status: the user's decisions are in (§9); next is the implementation plan, phase 1 first.

## 1. Intent

The user's ruling (2026-10-21): "the visio is the source of true, is the autority of the flowcharts diagram, you can
perform revolution on the studio code … the studio will not embrace all capabilities, only the components and wiring
drawing and designing." Named first: **the equal-gap guide lines between steps and other components**, **the alignment
of wires**, and **spacing**.

Why: side by side, Visio's routes are short, calm and evenly spaced. Studio's become long U-turns, run 8 px apart as
"double lines", and cross without jumps once blocks are placed away from the automatic layout (evidence: `shots/studio-behind.png`,
`shots/studio-picked.png`). Visio's dynamic grid also makes a tidy diagram easy (aligned, equal gaps). Studio has
alignment only, with no equal gaps.

Success: a user who knows Visio feels at home dragging blocks and wires in Studio. The same scene drawn in both looks
alike in route shape, spacing, guides and feedback, except where Studio deliberately keeps its own meaning (§3).

## 2. The evidence

Everything here was measured on Visio Professional 16.0 (build 20430), Basic Flowchart template, US units in mm. It was
measured two ways:
- **Automation:** 18 pages driven through COM.
- **Real mouse and keyboard:** a visible Visio, with screenshots and the actual cursor read from Windows at each point.

The scripts, logs and screenshots are in `docs/superpowers/specs/visio-reference/` (`scripts/`, `automation-findings*.txt`,
`mouse-findings.txt`, `shots/`). Rerun a script to check a rule again.

Scale used to carry Visio's sizes over: a Visio Process is 25 × 15 mm, a Studio step 224 × 160 flow px. **Lengths are
carried by width: 1 mm = 8.96 flow px, then snapped to Studio's 8 px grid.** Pointer distances (glue and snap reach) are
screen pixels in Visio, independent of zoom, so they stay screen pixels here.

## 3. Scope

**In:** how steps, the hub and caches are moved, aligned and spaced, and how wires are routed, drawn, picked, dragged and
glued, with the feedback while doing it. That covers cursors, squares, previews, guides, routes, spacing, line jumps,
glue reach, and splitting a wire by dropping a block on it.

**Out (non-goals):** Visio features beyond blocks and wiring:
- free-text labels on wires (Studio wires carry no text in BaseApi);
- themes, styles, swimlanes, Check Diagram;
- AutoConnect arrows and Quick Shapes (listed in §6 as a possible later phase only);
- page layout commands.

**Studio keeps its own meaning.** These are not Visio's to overrule, and none of them is drawing:
- a step's input and output, on fixed sides, and the hub's ring (§4.3, the user's ruling);
- junctions (wire on wire; Visio has none);
- families and colours;
- short-circuit refusals (Visio refuses nothing);
- direction-less wires (rule D);
- rule B, where a dragged wire's ends reconnect;
- cut and delete-wire on squares;
- Undo surviving a refresh.

**Anti-goals: Visio's weaknesses, measured, not to copy:**
- a route through a solid wall of blocks (`shots/11-overtaking.png`, middle row);
- two wires lying exactly on top of each other;
- different-source wires merging into one trunk;
- a hand-shaped wire leaving its end off the shape after a move (`shots/ui-segment-then-B-moved-up-right.png`).

Studio must stay at least as good as it is today on these.

## 4. Rules: Visio measured, Studio today, Studio after

### 4.1 Dynamic grid: alignment and equal gaps (the user's priority)

| | Visio (measured) | Studio today | Studio after |
|---|---|---|---|
| Alignment snap | edges and centres; snapped at 3, 6 and 10 px off, not at 16 | edges, centres, processor middle; reach 8 **flow** px (4 screen px at the 49% fit zoom) | edges, centres **and processor middle** (kept: it makes wires straight). **Reach 12 screen px**, at any zoom, results kept on the 8 px grid |
| Equal gaps | snaps when a gap to a neighbour equals an existing gap; at 3, 6 and 10 px, not 16; also stays aligned | none | **new**, §4.1.1 |
| Guide look | green dashed lines through every matching edge or centre, from the dragged block to the nearest block it matches (`shots/ui5-align-held-6px.png`) | a line per exact match (`.design-guide`) | Visio's: green dashed, 1 screen px, through every match, dragged block to nearest matching block |
| Equal-gap look | a green dimension arrow with end ticks under **each** of the equal gaps (`shots/ui5-gap-held-6px.png`) | none | Visio's: arrows with ticks under every gap of that size in the row or column |
| Centring between two | no snap | none | none (Visio doesn't) |
| Applies to | any shape dragged, including from the stencil | blocks dragged on the canvas | **every component**: steps, the workflow hub and caches, dragged on the canvas **or in from the Toolbox**. Every component is both a guide source and a guide target, so a cache aligns and spaces with steps and the hub, and they with it. A cache is never wired, but it gets the spacing guide lines like any component (the user's ruling, 2026-10-21). |

#### 4.1.1 Equal gaps, precisely

- **Row neighbours:** while block X is dragged, its row neighbours are the blocks whose vertical span overlaps X's.
  Its column neighbours are the blocks whose horizontal span overlaps.
- **Gaps that count:** the gaps between each pair of adjacent blocks in a row (edge to edge, bounding boxes, the hub's
  box being its square), and the same in columns.
- **Snap:** if X's gap to its nearest left or right row neighbour is within reach of one of those gaps, X snaps so it
  is equal (nearest wins; ties go to the smaller move). The same applies to columns. One horizontal and one vertical
  snap may combine, and they combine with alignment (Visio landed D both level and equally spaced).
- **Arrows:** drawn under every gap in that row (or column) equal to the snapped one, X's own included.
- **Precedence:** if alignment and an equal gap would move X differently on one axis, the smaller move wins. *My call;
  Visio's precedence was not measured.*

### 4.2 Routing: alignment and spacing of wires

| | Visio (measured) | Studio today | Studio after |
|---|---|---|---|
| Shape of a route | always right angles | right angles | right angles |
| Stub out of or into a block | 7.5 mm (half the 15 mm avenue) | 24 px (`CLEARANCE`) | **64 px** (7.5 mm ≈ 67, snapped) |
| Clearance from a block it passes | 7.5 mm, on the **nearer** side | 24 px, from a fixed menu of shapes | **64 px, nearer side**, from a real search (§4.2.1) |
| Through a block | sometimes (a wall of three) | never | **never** (anti-goal) |
| Narrow gap | goes through a 7.9 mm gap, narrower than the avenue | n/a | goes through a gap if it can keep half the clearance on both sides; otherwise around. *My call.* |
| Neighbouring wires | overlap exactly | 8–16 px apart | **32 px apart** as parallel tracks (Visio's LineToLine 3.175 mm ≈ 28, snapped up) |
| Fan-out from one output | wires leave one point and share a trunk | tails 16 px apart (`PORT_GAP`) | wires of one net, or same-output same-colour siblings (rule G bus), **share one trunk** and split where they part. Others get their own track. |
| Fan-in into one input | merge into one point | landing slots 16 px apart | **landing slots 32 px apart**. Different nets never merge (that's a short circuit in Studio). |
| Crossings | an arc jump, 2.2 mm wide, on the horizontal wire | plain crossing | **an arc jump on the horizontal wire, 16 px wide**, drawn on the later wire in route order; none at junctions or at a wire's own ends |
| Gap between blocks when added | 15 mm (DropConnected, AutoConnect) | automatic layout column gap 64 px | automatic layout gap **128 px** (15 mm ≈ 134, snapped), so wires have room for their stubs and tracks |
| Zoom | routes identical at every zoom | the same | the same |
| Moving a block | reroutes on release, not while held | reroutes live while held | **on release** (Visio). While held, the block's faded copy moves (§4.5). |

#### 4.2.1 The router

This replaces today's fixed menu of shapes (`src/layout/router.ts` `route()`: straight, Z at 30/50/70%, two near-end
Zs, U levels) with an **orthogonal path search**:
- **Graph:** every block is inflated by the clearance (64 px). The graph is built from the 8 px grid lines through every
  inflated box edge, every port stub end and every existing track.
- **Search:** A* over that graph. Cost = length + a bend penalty (several grid steps per bend), plus a penalty for
  running beside or on another net's wire closer than the track spacing.
- **Hard rules:** never inside a block; never on another net's wire (rule G stays a hard rule).
- **Ports:** each end leaves or enters its block square-on through a 64 px stub, then searches.
- **Order:** wires are routed in a stable order (as today, by id). Tracks are taken first come, first served, and later
  wires keep 32 px off taken tracks where they can.
- **Kept:** hand-shaped wires (stored bends) keep their runs as today; the search is used only between their bends and
  their ends, if at all.
- **Performance:** a whole workflow of ~30 steps and ~40 wires must route in under 50 ms in the browser. The search is
  bounded to the box around both ends grown by a few avenues, and widened only if nothing is found.

What's left to the builder: the exact bend penalty, the bound, and the data structure, as long as the measured scenes
in §7 come out right.

### 4.3 Which side a wire uses: fixed (the user's decision, 2026-10-21)

Visio, with whole-shape glue, picks the facing sides each time a shape moves. So a target behind or below its source
gets a short L or a straight line (`shots/11-overtaking.png`, bottom). Studio fixes the sides: out of a step's
**right**, into its **left**. Hub tails start on its ring, wherever they were dropped, as today.

**The user's ruling (2026-10-21): "step's sides stay fixed, and workflow too."** No top or bottom entry, and no change to
where wires leave the hub. A target behind its source still gets a U-turn.

**The U-turn is drawn Visio's way (the user's clarification, 2026-10-21).** These are Visio's U-turns with point glue
(the same fixed sides as Studio), measured in `automation-findings.txt`, pages "glue and moves" and "overtaking"; mm on
the page:
- **Target behind, at the same height** (A3 right → B3 left, B3 left of A3): out of the source 7.5 mm, up to 7.5 mm
  above the shapes' tops, straight back across, down 7.5 mm before the target, into its left side:
  `(139.5,55.9) → (147,55.9) → (147,70.9) → (30.8,70.9) → (30.8,55.9) → (38.3,55.9)`.
- **Target behind and below:** out 7.5 mm, down to 7.5 mm above the target's top, which is the free band between the
  two shapes, back across to 7.5 mm before the target, down to its middle, into it:
  `(88.7,152.4) → (96.2,152.4) → (96.2,91.2) → (56.2,91.2) → (56.2,76.2) → (63.7,76.2)`.
- **Target behind, overlapping in height:** over the top of both, 7.5 mm above the higher top, then down and in.

The rule, for Studio's router (§4.2.1), every distance being the stub or clearance (64 px):
- leave square out of the output by the stub;
- go up or down;
- run back across;
- come down or up to the input's height the stub before the input;
- go in square.

The return run lies **in the free band between the two blocks** when they don't overlap in height: one clearance off
the block it passes nearer, on the target's side as Visio did. Otherwise it goes **over the top of both**, one clearance
above the higher top. On a tie it goes up, as Visio did. Never round the whole canvas, never further out than that
clearance unless a block is in the way, and then the nearer side round it. Two U-turns side by side take tracks 32 px
apart.

### 4.4 Wires: squares, ends and glue feedback

| | Visio (measured) | Studio today | Studio after |
|---|---|---|---|
| A glued end, wire picked | a green dot in a white ring (`shots/ui-sel-near-A.png`) | a 9 px light-blue filled square, the same for every end | **a green dot in a ring** when connected (step side, hub or junction) |
| An open end, wire picked | a hollow white circle with a grey ring (`shots/ui-free-end-zoom.png`) | the same square | **a hollow white circle with a grey ring** |
| Middle of each run | a small dot on **every** run, stubs included | an outlined 9 px square on main runs only | **a small dot on every run**, stubs included; still the target for cut (rule E) and run drags |
| Bends | a small dot at every bend | none | **a small dot at every bend** (not draggable: Visio's aren't either; a run drag moves them) |
| Size | about 8 screen px, any zoom | 9 screen px | **8 screen px**, any zoom |
| Dragging an end over a block's body | thick green outline on the block; its contact points shown | step lit (`drop-ok`), label "connect here" | **Visio's green outline**; the step's input or output side highlighted where the end would land; label kept |
| Over a contact point | a green square frame on the point, tooltip "Glue to Connection Point" | the same label | the landing point marked with Visio's **green square frame**; label kept |
| Refusals | none | red label, the end snaps back | **kept** (Studio meaning), red outline instead of green |
| Glue reach | point ~12 px, shape ~10 px, screen px; points appear at ~14 px | 8 screen px (`DROP_REACH`) | **10 screen px** for a side or the hub, **12** for a line (junction) |
| While dragging an end | the old wire stays; a **dashed preview** of the new route; crosshair cursor | the wire itself is redrawn live | **the old wire stays, faded; a dashed preview** shows the new route; Escape cancels (as both do) |
| Dragging a run | across itself only; dashed preview; a **grey dashed alignment guide** through the handle | across itself only; the wire redrawn live; no guide | across itself only; **dashed preview and alignment guide**. The run **snaps** to line up with another run, a block edge or centre, or a contact, within 12 screen px. *My call: Visio's snap targets for a run were not measured.* |
| Dragging a wire by its line | moves whole, **unglues** both ends | moves whole; ends reconnect over contacts (rule B) | **rule B kept** (Studio is better here); the dashed-preview look added |
| A shape dropped on a wire | **splits** it into two through the shape; while held, the wire's ends show filled green squares (`shots/ui-stencil-shape-over-wire-held.png`) | not supported | **new**, §4.6 |

### 4.5 Blocks: moving, resizing, previews

| | Visio (measured) | Studio today | Studio after |
|---|---|---|---|
| Dragging a block | a faded copy with a light-blue dashed outline follows; the block stays; wires reroute **on release** | the block moves live; wires reroute live | **Visio's**: faded outlined copy, guides and equal gaps on the copy, reroute on release |
| Arrow-key nudge | 2.5 mm per press, wires follow | 8 px per press (today's nudge) | unchanged: 8 px is one grid step, about Visio's 2.5 mm × 8.96 = 22 px at Visio's scale. *My call: keep the grid step.* |
| Resize | glued ends slide to the middle of the new side | steps have a fixed size | out of scope: Studio steps don't resize |

### 4.6 Splitting a wire by dropping a block on it (new)

- **Which blocks:** a step with no wires, dropped from the Toolbox or dragged on the canvas, whose body covers a wire's
  run.
- **While held:** the wire is marked for a split, its two ends drawn as Visio's filled green squares. The label reads
  "insert here", in green, or the refusal, in red.
- **Released:** the wire becomes two. The old tail goes to the new step's input, and a new wire runs from the new
  step's output to the old head. Both keep the old wire's other ends, junctions and family rules. The new wire is
  judged like any connection, so a family clash refuses the drop.
- **Not split:** a junction wire's middle (the split would need a step on a junction: refused), and a direction-less
  wire (no direction to insert into: refused).
- **Undo:** one Undo step.

*My call:* only steps split wires. A cache doesn't, because caches have no wires.

### 4.7 Cursors

| Where | Visio (measured) | Studio today | Studio after |
|---|---|---|---|
| A block | arrow with a 4-way move sign | hand (`pointer`) | **`move`** |
| Dragging a block | 4-way move | `grabbing` | **`move`** |
| A wire's line | arrow with a 4-way move sign | open hand (rule A) | **`move`**. This overrides the user's rule A of 2026-10-09 because Visio is now the authority. *Flagged.* |
| An end square | 4-way move | 4-way move | unchanged |
| Placing an end: end drag, a new wire, the Wire tile | thin crosshair, unchanged over targets | 4-way move or grabbing | **`crosshair`** for the whole drag |
| A step's contact before pressing | crosshair with a connector mark (Connector tool) | hand | **`crosshair`** |
| A run square | two-way arrow | two-way, across the run | unchanged (Studio's shows the direction of the move, which is clearer) |
| Ctrl+drag | arrow with "+" | none | **`copy`**, if Ctrl+drag duplicate is ever added (not in this plan) |

## 5. What stays exactly as it is

These keep their rules and get only the new look and the new router:
- the meaning of sides;
- junctions;
- families and colours;
- short circuits (rule G), including the same-output bus;
- direction-less wires (rules D and F);
- cut and delete-wire (rule E);
- copy and paste (a wire alone pastes free; Visio agrees);
- Delete taking a step's wires with it (Visio agrees);
- Undo and Redo, including across a refresh;
- saving to BaseApi;
- the Wire tile judged at its tip or tail ring.

## 6. Phases (each shippable, each verified before the next)

1. **Dynamic grid:** equal gaps, screen-pixel reach, Visio's guide and arrow look, Toolbox drops included (§4.1). The
   user's priority.
2. **Wire looks and feedback:**
   - glued and open ends, dots on runs and bends, 8 px size;
   - green outline and point square;
   - reach;
   - dashed previews and the run-drag guide and snap;
   - cursors (§4.4, §4.7).
3. **The router:** stub, clearance, tracks, the shared fan-out trunk, landing spacing, line jumps, the layout gap
   (§4.2). The largest piece.
4. **Block drag model:** faded outlined copy, reroute on release (§4.5).
5. **Split on drop** (§4.6).
6. *(Possible later, not planned)* AutoConnect arrows.

## 7. Verifying against Visio

- **Reference scenes:** each rule gets a scene drawn **in both**. In Visio by a script added to
  `visio-reference/scripts/`, the way they were measured. In Studio by a real-mouse Playwright test on a throwaway
  workflow, never a real one.
- **Scenes:**
  - the obstacle (`03`, `11`);
  - fan-out and fan-in (`02`);
  - a target behind and below its source;
  - a crossing (`16-jumps`);
  - alignment and equal gaps (`ui5`);
  - a run drag;
  - an end drag over a body and over a point.
- **What a test checks:** routes as point lists (right angles, distances in §4.2 within one grid step), guides and
  arrows drawn, where a block lands, cursors read from the computed style.
- **Unit tests:** for every rule in §4.
- **Before reporting a phase:** screenshots of the scene in both, put side by side.

## 8. Settled here as my calls (the user may overrule)

- Lengths carried over by width (1 mm = 8.96 px) and snapped: stub and clearance 64, track spacing 32, jump 16, layout
  gap 128.
- Snap reach 12 screen px (Visio snapped at 10, not at 16).
- When alignment and equal gaps disagree on an axis, the smaller move wins.
- A narrow gap is used if half the clearance fits on both sides.
- A run drag snaps to runs, block edges and centres, and contacts.
- Arrow-key nudge stays 8 px.
- Only empty steps split wires; junction and direction-less wires refuse a split.
- Rule A's open hand gives way to Visio's move cursor.

## 9. The user's decisions (2026-10-21)

- **Fixed sides:** a step's sides stay fixed (input left, output right), and the workflow hub's ring keeps its rules
  (§4.3).
- **The U-turn is Visio's:** a wire whose target is behind its source turns the way Visio's does, tight to the blocks
  at clearance distance through the free band or over the top (§4.3).
- **Guides for every component:** steps, the hub and caches all get the alignment and equal-gap guide lines, as dragged
  blocks and as references. Caches are never wired (§4.1).
