# SKP Studio plan 4: the canvas designer (trial) -- design

Status: agreed with the user on 2026-10-07, section by section, before this file was written.
Parent spec: `2026-10-05-skp-studio-design.md` (the "main spec"). This file decides plan 4. Where it
differs from the main spec's §5.4, §5.5 and §10 item 4, this file wins.

## 1. Purpose and the trial gate

Plan 4 adds **graph designing** to the canvas of an open workflow: selecting, moving blocks, and
editing wires the way Visio edits connectors.

It is a **trial**. The user tries the designer on the current workflows, and plans 5 to 7 start only
once they approve it. Some rules (§4.4) were chosen to be tried first and may change after the trial.

## 2. Scope

**In:**
- Selecting blocks and wires: click, Ctrl+click, and a rectangle drawn on empty canvas.
- Moving steps, the workflow hub and cache tags, with 8 px snap, arrow-key nudges and alignment guides.
- Wire editing (Visio-style): segment drags, sliding a landing, manual and automatic routes, Reset route.
- Wiring changes: detaching and re-attaching a wire end, drawing a new wire, deleting wires.
- Parked steps derived from the edited wiring.
- A design draft per document that survives a refresh; undo/redo; Discard design.

**Out:**
- **Saving anything.** The designer makes no BaseApi writes: no POST, PUT or DELETE (§6). Save comes
  after the trial.
- **Entity business logic.** No creating, deleting or editing entities, and no Inspector changes
  beyond the multi-selection note (§3.3).
- **The Toolbox.** Nothing is added to or removed from the canvas; Delete on a block does nothing.
  *Superseded (2026-10-10, plan 8 spec §4.5): Delete removes picked steps and caches; Ctrl+V pastes copies.*
- **Validating the draft.** Problems and the broken-wire marks stay those of the saved workflow.
- **Cache links.** A cache tag can be moved; which caches the workflow uses cannot be changed.
- **Junctions** (main spec §5.2, plan 7).

## 3. Blocks, selection and cursors

### 3.1 Cursors

- **Arrow:** empty canvas; the scroll bars, their thumbs included (today the thumb shows a grab hand);
  the legend; the zoom buttons.
- **Hand:** over any block (step, processor die, hub, cache tag) or wire, and during every drag,
  panning included.

### 3.2 Selection

- **Click** selects one block or one wire, replacing the selection. Clicking a step's processor die
  selects the processor, as today.
- **Ctrl+click** adds an item to the selection, or takes it out.
- **Dragging a rectangle on empty canvas** selects every block and wire lying wholly inside it.
  Ctrl+rectangle adds to the selection.
- **Click on empty canvas** clears the selection. Escape clears it too, as today (main spec §6.1),
  except during a drag (§5.3).
- Selection never changes the draft.

### 3.3 The Inspector with a selection

- One block selected: the Inspector shows it, as today.
- One wire selected: the Inspector shows "Wire: {source} → {target}" read-only. Its source and target
  are entities, but a wire has no entity of its own to edit.
  *Superseded (2026-10-09): the Inspector reads a picked wire as text (its ends, direction, condition, the links it
  carries, shape, wires joined on it), plan 9 spec §2.4.*
- More than one item selected: the Inspector shows "N items selected" and no form.

### 3.4 Moving

- Dragging a block that is part of the selection moves the whole selection. Dragging a block that is
  not selected selects it alone first, then moves it.
- Every block's top-left corner snaps to the **8 px** grid.
- **Arrow keys** nudge the selection 8 px while the canvas has focus.
- **Alignment guides** (main spec §5.4): while blocks are dragged, a solid white line with a halo
  appears when the dragged block's edge, centre or processor middle lines up with another block's,
  and the block snaps onto it from up to one grid step (8 px) away. Guides never take a block off the
  grid.
- **Wires stay glued to their blocks.** An automatic route re-routes live while blocks move. A manual
  route keeps its bends and only its first and last segments follow their ends (Visio's "reroute as
  needed").

### 3.5 Parked steps

- A step is part of the workflow when it is reachable from the hub's entry wires. After any wiring
  change, the designer recomputes reachability on the draft's wiring.
- A step that is no longer reachable stays where it is and is drawn parked (dashed frame, main spec
  §5.3). Steps reached only through it become parked too.
- Wiring a parked step back in makes it part of the workflow again.
- The saved workflow's own parked steps stay on the canvas and can be wired in.

## 4. Wires

A wire runs from its **source** (a step's output side, or the hub) to its **arrow head** on the target
step's processor band. This section follows the main spec's §5.5, without junctions.

### 4.1 Selecting a wire

- One click anywhere on a wire selects the whole wire.
- Each wire has an invisible hit band about 8 px wide, so the hand cursor and clicks do not need pixel
  precision.
- A selected wire is drawn on top, so where wires cross its handles win the pointer.

### 4.2 Handles and segment drags

- A selected wire shows a **green dot** on each glued end, a **small square** at the middle of each
  segment and a **small diamond** on each bend (Visio).
- **Dragging a segment** moves it square to itself; its neighbours stretch. Lining it up with a
  parallel segment removes the bend between them. Bends snap to 8 px.
- The **first segment** leaves a fixed port, so dragging it inserts a jog first.
- The **last segment** slides the landing along the target's processor band (the landing offset).
- **Dragging the wire's body** anywhere counts as a segment drag and **never detaches** the wire.
  *Superseded (2026-10-08): dragging the body moves the whole wire and detaches it; an end square adds one corner
  (plan 9 spec §6). Superseded again (2026-10-09): the moved wire's ends connect where they land on a contact, and
  an end square draws around corners (plan 9 spec §2.3, rules B and C).*

### 4.3 Manual and automatic routes

- A wire starts **automatic**: the router picks its shape (main spec §5.4).
- The first segment drag or landing slide makes it **manual**: its bends are kept from then on.
- **Right-click → Reset route** makes a manual wire automatic again. Its landing offset is dropped too.

### 4.4 Detaching and re-attaching an end (option "a", to be revisited after the trial)

- Drag the **arrow head** onto another step to re-target the wire.
- Drag the **start dot** onto another step, or onto the hub, to change the wire's source.
- While an end is dragged, the step or hub under the pointer outlines **green** when the drop is
  allowed and **red** when it is not (§4.6).
- Dropped anywhere else, or refused, the end **snaps back** and nothing changes.
- A re-targeted wire takes the new target's entry-condition colour. It is **not** checked for a
  schema mismatch: the broken mark comes from validate, which the trial does not run (§2).
- A re-attached wire becomes automatic.

### 4.5 New wires and deleting

- **Dragging from a step's output side, or from the hub,** draws a new wire. Dropped on an allowed step
  it is added; dropped anywhere else, or refused, nothing is added. A new wire is automatic.
- **Delete** removes every selected wire. Double-click on a wire does nothing.
  *2026-10-10 (plan 8 spec §4.5): and every selected step and cache with its wires; Backspace does nothing.*

### 4.6 What a drop may not create

A new or re-attached wire is refused (red outline, snap back) when it would make:
- a **self-loop** (a step wired to itself);
- a **duplicate** (the same source and target already wired);
- a **cycle** (the target already reaches the source). Decided 2026-10-07: the draft never holds a
  cycle, because BaseApi's cycle gate would refuse it at Save.

Wires from the hub are entry wires (`entryStepIds`); wires from a step are its `nextStepIds`.

## 5. The draft, history and Discard

### 5.1 The design draft

Each open document has at most one design draft: what the user changed relative to the saved
workflow. It holds:
- **positions:** moved steps, hub and cache tags (top-left corners; the hub's centre);
- **wiring:** for every step whose wires changed, its full next-step list, and the hub's entry list
  when it changed;
- **routes:** per wire id (`source->target`), its bend points when manual, and its landing offset when
  slid.

What the canvas shows is always **the saved workflow plus the draft**. A draft entry naming a step,
cache or wire that no longer exists (for example a step deleted elsewhere) is ignored, as the stored
layout is today. The positions and routes are kept apart from the wiring so that a later Save can
write the layout and the graph separately.

### 5.2 Session

The draft is saved in the browser session with its document (main spec §6.1), as an optional,
validated field next to the Inspector's draft. The session version is not bumped. A refresh brings it
back. A session write that fails shows a toast, as today.

### 5.3 Undo, redo and cancelling a drag

- **Ctrl+Z** undoes; **Ctrl+Y** and **Ctrl+Shift+Z** redo. They act on the active document while the
  canvas has focus. Inside an Inspector text field they remain the field's own undo.
- The capsule toolbar gets **↶ Undo** and **↷ Redo** buttons, disabled when there is nothing to undo or
  redo.
- Each finished gesture is one step: a drag of blocks, a segment drag, a landing slide, a re-attach,
  a new wire, a delete, a Reset route. A run of arrow-key nudges with no other action between them is
  one step.
- The history keeps the last **100** steps per document and is not kept across a refresh; the draft is.
- **Escape during a drag** (blocks, segment, end or new wire) cancels it and puts everything back. It
  makes no history step.

### 5.4 Marking, Discard and closing

- While a document has a design draft, its tab shows the unsaved mark and the capsule shows
  **● design draft**.
- The capsule's Save stays for the Inspector only; it never saves the design during the trial.
- **Discard design** on the capsule asks first, then drops the draft and the history; the canvas
  returns to the saved workflow.
- **Closing a document with a design draft** asks "Discard design changes?" with **Discard** and
  **Cancel** (no Save). Inspector edits keep their own Save / Discard / Cancel question.

### 5.5 Running workflows

A running workflow can be designed as well. The draft never reaches BaseApi, so it has no effect on
the run. The live states keep working: the hub and processor health as today, and the flowing pulses
on the wires as they are shown.

## 6. No writes

During the trial the browser sends no POST, PUT or DELETE because of the designer. Reads stay as they
are: loading the workflow, the live and liveness polls, validate for Problems on the saved workflow,
and the Inspector's own reads and writes (plan 3b) are unchanged.

## 7. Structure

**Pure core** (no React, no I/O; each unit tested alone), under `src/design/`:
- `draft.ts`: the draft's shape and the edits that return a new, immutable draft: move, nudge, set
  route, slide landing, add wire, remove wires, re-attach an end, reset route.
- `apply.ts`: saved document + draft → the shown document. It applies the wiring, recomputes
  reachability and the parked set (§3.5), lays the moved positions over the saved placement (the
  automatic layout is not run again) and routes the wires. This is the "split loading into fetch and
  derive" item parked since plan 2: `loadDocument` keeps the fetching; deriving becomes a function the
  canvas calls on every change.
- `rules.ts`: may this end be dropped here? Self-loop, duplicate and cycle (§4.6), reusing
  `model/reachability.ts`.
- `history.ts`: undo and redo stacks of drafts, 100 deep, with nudge-run merging.

**Router** (`layout/router.ts`, `layout/wires.ts`): manual routes (keep the bends, move only the end
segments), landing offsets, and the parked short-gap fix (a forward gap of 8-23 px with different
heights gets a Z with its elbow at source x + 8 once the gap is at least 16).

**Interaction** (React):
- React Flow is switched on for blocks: node dragging with an 8 px snap grid, Ctrl multi-select, and
  the rectangle selection. Wires keep being drawn by our edge components.
- `design/AlignmentGuides`: computes the guides and the snap while blocks are dragged.
- `design/WireEditor`: draws the selected wire's handles and runs one gesture handler for segment
  drags, landing slides, end drags and new wires, including the green and red outlines.
- Cursors in CSS (§3.1).

**State:** the store keeps each document's draft, history and multi-selection. The session writes and
reads the draft (§5.2). The capsule gets Undo, Redo, Discard design and "● design draft"; the close
guard asks about design drafts (§5.4).

**Performance:** a drag stays at about 60 fps on the largest current workflow. Re-routing only the
wires that touch moved blocks is allowed if routing everything per frame is too slow.

## 8. Testing

**Vitest:**
- every draft edit; `apply` (wiring, parked derivation, moved positions, ids that no longer exist);
- `rules` (self-loop, duplicate, cycle, hub entry wires);
- the router's manual routes, landing offsets and the short-gap Z;
- history (undo, redo, the 100 cap, nudge merging, a new edit clearing redo);
- the session round trip of a draft, and an invalid draft being dropped;
- cursors and selection behaviour in the canvas component.

**Playwright e2e** on the current workflows, read-only:
- move a block and see its wires follow; nudge with the arrow keys;
- Ctrl+click and rectangle selection; "N items selected";
- drag a segment, slide a landing, then Reset route;
- detach and re-attach an end; a refused cycle outlines red and snaps back;
- draw a new wire; delete a wire and see a step become parked;
- undo and redo; a refresh keeps the draft; Discard design; closing asks.
- **Every e2e test asserts the browser sent no POST, PUT or DELETE** (a strict write guard).

**By hand** before the trial is handed over: the e2e list in a browser, and the drag frame rate on the
largest current workflow.

## 9. After the trial

When the user has tried the designer they decide, among other things:
- whether option "a" (detach by dragging an end, snap back on empty canvas) stays (§4.4);
- Save: how the draft is written (`PUT /layout` for positions and routes, `PUT /graph` for wiring,
  main spec §4), and whether validate runs on the draft first.
