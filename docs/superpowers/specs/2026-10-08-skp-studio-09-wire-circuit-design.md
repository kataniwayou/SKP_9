# SKP Studio plan 9: wires as a circuit -- design

Date: 2026-10-08. Branch `feature/path-importer`. Builds on plan 4 (designer), plan 7 (junctions) and plan 8
(virtual design, loose wires, wires open at either or both ends). Where this document differs from the plan 4 spec
(§4.2-§4.6 drop rules), the plan 7 spec (junctions) or the plan 8 spec (§5 wires dropped anywhere, loose wires), this
document wins.

## 1. Purpose

Replace the accumulated wire rules with one simple model the user stated: **the canvas is an electric circuit**.
Current flows in one direction only, from the workflow to the terminal steps. Every step has an input and an output,
which fix the direction. Wires can share their way into a step's input (junctions, fan-in) and share their way out of
a step's output (junctions, fan-out). Wires that meet must be of the same **family** (colour, the entry condition);
otherwise they make a **short circuit**, which is refused.

Decisions taken with the user (2026-10-08): the 13 ground rules (§2) with the circuit reading, the answers to the
questions (§2.1) and the recommendations accepted for every gap (§2.2).

## 2. The ground rules (the user's, numbered as given)

1. The workflow (hub) is a circle: contact points all around it, not only one.
2. A step is a rectangle: only two sides have contact points.
3. A wire by default is an arrow with a tail and a head.
4. A tail and a head can connect to a wire at any point, but not to itself, and not both (tail and head) to the same
   wire. A junction point is a filled circle on the wire (no arrow head there).
5. Only a head connects to the left side of a step; only a tail connects to the right side of a step.
6. Only a tail connects to the outer ring of the workflow.
7. A tail connected to a step does not determine the colour.
8. A tail connected to a junction inherits the colour.
9. A head connected to a step inherits the colour.
10. A head connected to a junction inherits the colour.
11. Contradicting colours between tail and head are not allowed; the first that connected determines.
12. No colour determined: grey, dashed.
13. If only one of the wire's sides (tail or head) is connected, the wire is dashed, coloured as above.
14. (the user's second "13") Touching a wire produces squares over it; the cursor over the end squares is the
    four-way move cursor.

### 2.1 Answers to the questions

- **A junction** is a meeting of a wire with a wire, by its tail or by its head.
- **Colour** is decided by a head on a step or by either end on a wire; the other end may then connect only where the
  colour agrees (a wire of the same colour, or a step of the same entry condition).
- **Hub:** many entry steps, so many tails around the ring, each where it was dropped.
- **Wrong side is refused** (a head on a step's right side, a tail on its left side). Both ends slide anywhere along
  their own side.
- **Both ends on the same step** stay refused, as today.
- **Cursor:** the four-way move cursor on every end square, as today on the contact square; run squares keep theirs.
- **Open ends** (studio's call): an unconnected head keeps its arrow head, an unconnected tail keeps its small ring —
  a wire always reads as an arrow. No open circles.
  *Superseded (2026-10-09, rule D, §2.3): a wire with no end on a step or the hub has no direction and draws neither
  the ring nor the arrow head; an open end of a wire that has a direction still keeps them.*
- **Creating new wires** is deferred (today's drag from the hidden spot on a step's right side or the hub stays).

### 2.2 Gaps closed (recommendations the user accepted)

1. **Position on a wire matters.** Current that enters a wire at a point (a head junction) reaches everything
   downstream of that point: every tail junction further along and the wire's own head. Current a tail junction draws
   comes from everything upstream of its point.
2. **Family belongs to the net.** All wires connected through junctions form one **net** with one family. It is set
   by the first decisive connection (a head on a step, or joining a net that already has a family); every member must
   agree. When the deciding connection goes, the net is grey again unless another connection still decides it.
3. **Closed loops of wires only are refused** (a short circuit): a junction that would let current return into the
   wire it came from without passing through a step.
4. **Hidden self-loops are refused:** a connection that would make a step feed its own input through junctions.
5. **Solid** when both of the wire's own ends are connected (to a step side, the hub or a wire) and its net has a
   family; **dashed** otherwise; grey while the family is undecided.
6. **A host wire deleted or detached:** wires joined to it keep their place, those ends become open; each is re-drawn
   (dashed, re-coloured) by the rules.
7. **A family changed afterwards** (a step's entry condition edited in the Inspector) that makes a net contradict
   itself: the edit is allowed; the clashing junction is marked red as a **short circuit** and listed in Problems; Save
   reports it (it is an error of that design's wiring; the stored design keeps it, nothing is silently dropped).
8. Defaults: two paths that make the same step-to-step link write it once; a tail on a wire whose current comes from
   the hub makes the head's step an entry step; a stored junction that disagrees with the workflow loaded from BaseApi
   is drawn as a plain wire on load (BaseApi is the truth for the graph).

### 2.3 The user's drag rules of 2026-10-09 (A-D)

Agreed with the user on 2026-10-09; they supersede the 2026-10-08 notes in §6 where they differ.

- **A. Cursors.** The open hand only over a wire's body, never over a square; end squares the four-way arrow; run
  squares the two-way arrow; the closed hand while the body is dragged.
- **B. Body drag.** The closed hand always moves the whole wire rigidly, its shape frozen, detached from every contact
  point, also when an end is connected: it never stretches or shrinks a leg (stretching is the end square's). While
  dragged, each end is judged over what is under it exactly as an end square's drag is (the same reach, outline and
  label). An end over a contact it may take (a step side, as a vertical line of contact points whose height is the
  end's height clamped to the landing range; the hub's ring; a wire's line) shifts the whole wire by the small offset
  that puts that end exactly on it; the end that got there first decides the shift. Released, every end over a
  contact it may take connects; the others stay open. When the frozen shape cannot meet both contacts, the first end
  connects and the other stays open. A refused end moves with the wire and stays open. Dragged away and dropped back
  where it was, both ends connect again. Ends joined on the moved wire open where they are drawn; a sub-grid wobble
  is a click.
- **C. End square.** The end draws its wire like a pen: each 90 degree turn of the pointer fixes the current leg and
  starts a new one (a right-angle corner); back along the current leg shortens it; back past a corner fixed in the
  drag removes it. Over a contact, the drawn corners are kept and only the last leg goes into the contact point.
  Released it connects, or stays open over nothing, or snaps back when refused.
- **D. Direction-less wires.** A wire with no end on a step or the hub has no head or tail: no arrow head, no tail
  ring (also when its only connection is a join on a wire's line). The first end that lands on a step or the hub
  decides: a step's input makes it the head, a step's output or the hub the tail; the other end takes the other role
  (the wire is turned round, same id). Its first connection is therefore never "wrong side" or "only a tail on the
  workflow"; the checks that need a direction (short circuit, same step, family) are made on the wire turned that
  way. Both ends arriving at once (a body drag) decide together: two inputs or two outputs make the second "wrong
  side". Joined on one line, its other end onto another line is refused: "needs a step first". It writes nothing to
  BaseApi, and stays as it is through Save, reload and refresh. Once it has a direction, drops are judged as before.
  *Review (2026-10-09):* a wire is judged as lifted: when the end dragged is its only end on a step or the hub, it
  is direction-less while dragged, so a step side decides afresh and a second line is "needs a step first". A
  direction-less wire carries no current at all: nothing flows through it or through the junctions on it (a wire
  joined on one may be drawn, it just reaches nothing until the host has a direction). Turned round, the ends joined
  on it keep their place (`at` measured from its new tail). A hub tail with a shape of its own starts at its ring
  point snapped to the grid after a short lead, so a body drag lands on the hub by a grid shift and stays exact.

- **E. Cut (the user's rule, 2026-10-09; the end-square drag only, never a run square or the body).** While an end
  square is dragged, its wire's squares stay where they were when the drag began; they are targets, hit within a
  square's own size on screen. Released on a run square ("cut here", the part that goes drawn faded meanwhile) the
  wire is cut there: everything from that square to the dragged end goes, corners included, and the wire ends there
  open, its shape up to there kept (its other end held where it is drawn). Released on the other end square
  ("delete wire", the wire faded) the whole wire is deleted, as Delete does. Ends joined on the part that goes open
  where they are drawn; those on the part kept stay put. A wire left with no step or hub end has no direction (D).
  Released on its own line off a square: "same wire" as before. Moving off a square is an ordinary end drag again;
  Escape cancels; one undo step; saved and reloaded like any draft change.

## 3. The model

**Terminals.**
- **Hub:** a source. Its outer ring is all output: tails only (rule 6), anywhere around the circle (rule 1), several
  at once. A head over the hub is refused.
- **Step:** its left side is its input (heads only), its right side its output (tails only) (rules 2, 5). An end
  slides anywhere along its side (snapped to the 8 px grid, inside the side's span); an end on the wrong side is
  refused with a red label and snaps back.

**Wires.** A wire is a one-way conductor from its tail to its head (rule 3). Each end is in one of these states:
- on a **terminal** (a step side or the hub ring), at a point along it;
- on a **junction**: at a point along another wire (rule 4) — a filled circle, no arrow head at that end;
- **open**: not connected — a head keeps its arrow head, a tail its small ring (§2.1).
  *Superseded in part (2026-10-09, rule D): a wire with neither end on a step or the hub has no direction, so neither
  ring nor arrow head; its ends are only stored as `tail` and `head` until one lands on a step or the hub.*

**Junctions.**
- A **head junction** on wire W at point p (fan-in): the wire's current joins W at p and flows on downstream.
- A **tail junction** on wire W at point p (fan-out): the wire takes W's current at p.
- Refused: a wire's end on itself; both ends of one wire on the same wire (rule 4); a junction that closes a loop of
  wires (§2.2-3); a junction whose families disagree (§4).

## 4. Families (colour)

- The **family** of a net is an entry condition (Completed, Failed, Cancelled, Always, Never: the legend's colours).
- What decides it: a head on a step (that step's entry condition, rule 9); joining a net that has one (rules 8, 10).
  A tail on a step or on the hub decides nothing (rule 7).
- **Agreement:** a connection that would bring two different families together is a **short circuit** and is refused
  while dragging (red label "short circuit", the end snaps back) (rule 11). Examples: a head dropped on a step whose
  entry condition differs from its net's family; a tail or head dropped on a wire of another family; a tail on a
  teal wire whose head is already on a red step.
- **First decides** (rule 11): once a net has a family, further connections must agree; the order is only the order
  the user connected them in.
- **Undecided:** grey (rule 12).
- **Later contradiction** from an Inspector edit: §2.2-7.

## 5. Drawing

| Wire | Line | Colour |
|---|---|---|
| both own ends connected, family decided | solid | the family |
| either own end open, family decided | dashed | the family |
| family undecided (whatever its ends) | dashed | grey |
| in a short circuit (§2.2-7 only) | as above, the junction marked red | the family |

- Ends: an arrow head at a head on a step or open; a filled circle at a junction end; the small ring at a tail on a
  terminal or open. *A direction-less wire (rule D, §2.3) has no arrow head and no ring, only its junction circle.*
- Picked (clicked) wires show squares: one on each end, one in the middle of each run (rule 14). End squares show the
  four-way move cursor, also while dragged. Squares keep their fixed screen size at any zoom.
- The legend shows the families, the grey dashed undecided wire and the short-circuit mark; no "loose wire" item
  with open circles.

## 6. Gestures

- **Any end square** (tail or head, connected or open) drags that end. While dragging, the label says what the drop
  would do: "connect here" / "join here" (green), "move here" (grey: the end becomes or stays open there), or a red
  refusal: "wrong side", "same step", "same wire", "short circuit", "only a tail on the workflow", "needs a step
  first" (rule D, 2026-10-09). Released: the drop is applied or the end snaps back. A direction-less wire's end takes
  the role the side or the hub gives it (rule D, §2.3).
- Dropped on empty canvas, a cache, or anywhere it attaches to nothing: the end becomes open there (allowed for
  either end and for both; no "needs one end").
- **Run squares** drag runs; the shape is kept (stored bends), as today. Right-click Reset route; Delete removes the
  wire; Undo/Redo cover every change.
- A head or tail moved along its own side slides its contact point.
- **End square over nothing** (the user's rule, 2026-10-08): the end follows the pointer with exactly one corner (an
  L). The run at that end keeps its axis up to the pointer's coordinate on that axis, then one perpendicular run goes
  to the pointer; dragged along the run's own axis it only lengthens or shortens. Released there the end is open and
  the wire keeps that shape (its bends). An automatic other end on a step or the hub is held where it is drawn
  (`held`; the hub at the nearest 15°) and goes back to automatic when the open end connects again. Over a step side,
  the hub or a wire the drop is judged as above and the router draws the way in.
  *Superseded (2026-10-09, rule C, §2.3): the end draws around corners, one per 90 degree turn of the pointer (back
  past a corner fixed in the drag removes it); over a contact the drawn corners are kept and only the last leg goes
  in (a vertical last leg goes on to the contact's height, then square in). A wire that was automatic, with no corner
  fixed in the drag, is still routed in by the router.*
- **Wire body** (the user's rule, 2026-10-08; supersedes "a body drag drags the nearest run and never detaches"): in
  design mode the body shows the open hand; pressed and dragged (the closed hand), any wire, picked or not, moves
  whole. Its drawn path is frozen and shifted by the pointer's movement snapped to 8 px; both its ends open there
  (its own junction ends break too), its shape is kept as its bends (a straight wire as a one-run shape), and the
  ends joined on it open where they are drawn (§2.2-6). A press that moves less than a grid step only picks it, as a
  click (Ctrl toggles). One Undo step.
  *Superseded in part (2026-10-09, rule B, §2.3): each end is judged as it moves, with its own label and outline; an
  end over a contact it may take shifts the wire exactly onto it, and on release every such end connects (the moved
  wire has no direction: the sides decide it, rule D). Dropped back where it was, it is as it was. Judgement calls:
  the second end meets its contact when the shape fits it to within a step side's line (x exact, y within 4 px), a
  line's 4 px, or the hub ring's 12.5 px (half its 15 degree spacing); otherwise it stays open ("move here").*
- **Cut** (the user's rule, 2026-10-09, §2.3 E): an end square released on one of its own wire's squares cuts the
  wire at a run square ("cut here") or deletes it on the other end square ("delete wire").
- New wires: unchanged (deferred, §2.1).

## 7. Save: from the circuit to the workflow

The workflow BaseApi stores is still steps with `nextStepIds` and the workflow's `entryStepIds`. On Save the studio
derives them from the circuit:

- **Trace the current.** For each wire, follow its tail upstream through tail junctions (to the wire it taps, from
  the tapped point back upstream) until a step's output or the hub; follow its head downstream through head junctions
  (into the host wire at that point, then downstream to everything after the point) until steps' inputs.
- For every source step S (or the hub) whose current reaches a step T's input, write **S → T** (S's `nextStepIds`
  contains T; the hub's means T is an entry step). Duplicate paths write one link (§2.2-8).
- A path that does not reach a step or the hub at both ends writes nothing; it stays in the layout only.
- A short-circuited net (§2.2-7) is reported as a Save error on the junction's wire (kind `step`, stage `wires`,
  message "short circuit: <family A> meets <family B>"), and its links are not written; the design is stored as drawn.
- The layout keeps every wire with its ends (terminal point, junction host + point, or open point) and its bends.
  BaseApi stores the layout as it does today; BaseApi's request shape (`PUT /workflows/{id}/design`) does not change.
- **On load**, a stored junction whose traced links disagree with the workflow loaded from BaseApi is drawn as a
  plain wire (§2.2-8); the loaded `nextStepIds` / `entryStepIds` are the truth.
- Cycles between steps stay allowed (a step's output can lead, through other steps, back to its own input); only a
  step feeding its own input directly or through junctions alone is refused (§2.2-4).

## 8. Compatibility

- Plan 8's loose-wire records (`{source, end}`, open start, open both) and plan 7's head junctions parse into the new
  model: open ends stay open, head junctions stay head junctions. Old sessions and stored designs keep working.
- Plan 7 drew a joined head while the wire kept its own target; under this model a head junction leads into the
  host's target. A stored plan 7 junction whose meaning differs from the loaded graph is drawn plain (§7, on load).

## 9. Out of scope

Creating new wires (deferred); deleting or creating steps; start checks (BaseApi's validators run on Start); live
current animation along junctions (today's flow pulse stays per wire).

## 10. Testing

**Vitest:** the tracer (fan-in, fan-out, position along a wire, chains, duplicate paths, hub entries, open paths
write nothing); family per net (decide, agree, refuse, undo the decider → grey); loop and hidden self-loop refusal;
drawing states per §5; drop verdicts and labels per §6; parse of plan 7 / plan 8 records; Save request derived from
the circuit; short circuit from an Inspector edit reported, not dropped.

**Playwright, with a real mouse and keyboard, on the dev server and the deployed studio (design only; Save tests on a
throwaway workflow created and deleted through BaseApi's CRUD), one test per rule:**
1. Tails dropped at the hub's top, left and bottom start there; several at once.
2. A step accepts ends on its left and right sides only.
3. A wire is drawn with a ring at its tail and an arrow head at its head.
4. A head and a tail each join another wire at a chosen point (filled circle, no arrow head there); joining itself
   and both ends on one wire are refused.
5. A head on a step's right side and a tail on its left side are refused ("wrong side"); both slide along their side.
6. A head over the hub is refused.
7. A wire with only its tail on a step is grey, dashed.
8. A tail joined to a teal wire turns teal.
9. A head on a step takes the step's colour.
10. A head joined to a wire takes its colour.
11. A short circuit is refused: a head of a teal net onto a red step; a tail onto a wire of another family.
12. An undecided wire is grey, dashed.
13. A wire with one end open is dashed in its family's colour; with both ends connected, solid.
14. A picked wire shows its squares; the end squares show the four-way cursor, also while dragged.
Plus: fan-in and fan-out saved as the right `nextStepIds` / `entryStepIds` (throwaway workflow); position along a wire
changes what is reached; a wire loop and a hidden self-loop are refused; deleting a host leaves its joined wires open;
an Inspector entry-condition edit that makes a short circuit is marked and listed in Problems; everything survives a
refresh and Undo.
