# Handover 2026-10-08: SKP Studio plan 8 (virtual design, store + dry run + align)

Branch `feature/path-importer` (not pushed, not merged; the user has not chosen merge / PR / keep). Both plan 8
halves are deployed to the dev cluster (ns `skp`): BaseApi with the `AddWorkflowDesign` migration, and the studio
as `workflow-studio:local`, bundle `index-BC19MgmE.js`. Port forwards are supervised by
`./k8s/port-forward-realstack.ps1` (`-Status` to check, run it again to restart): studio `localhost:18081`,
BaseApi `localhost:18080`. Do not stop them by hand.

## Where we are

- **Plan 7 (junctions) is done and deployed** (`30996e5..a2a8c96`, handover `e38a2a3`). Spec
  `docs/superpowers/specs/2026-10-07-skp-studio-07-junctions-design.md`.
- **Output / Save log / Start-Stop (2026-10-09) is BUILT, NOT DEPLOYED** (section below the step read-out).
- **Live push over SignalR (2026-10-10) is BUILT, NOT DEPLOYED** (section after the Save spinner): BaseApi needs a
  redeploy and the studio (bundle and nginx.conf) too.
- **Copy, paste, delete and whole-selection drag (2026-10-10) are BUILT, NOT DEPLOYED** (section after the live push
  review): BaseApi first, then the studio.
- **Plan 8 (virtual design) is BUILT and DEPLOYED.** Spec
  `docs/superpowers/specs/2026-10-07-skp-studio-08-virtual-design-design.md`; plan
  `docs/superpowers/plans/2026-10-07-skp-studio-08-virtual-design.md`. Executed subagent-driven (16 tasks, each
  reviewed). The SDD ledger is `.superpowers/sdd/2026-10-07-skp-studio-08-virtual-design/progress.md` (git-ignored).

## Built: plan 8 virtual design

**Commits.** Docs (spec, plan, handovers) `876c56d..HEAD`; code `e7db275..HEAD`. The first code commit is `e7db275`,
the nullable jsonb `Design` column. The last is `2ce5b40`, the view-restore fix below.

**What it does.**
- The designer opens a workflow with GETs only. There is no `POST /validate` anywhere in the studio; the live
  polls stay.
- Every edit is virtual: canvas edits go to the draft, Inspector edits to the entity edits. Edits to assignments
  (create, update, delete) are virtual too, and so are schema copies (same name and version, re-pointed on Save).
- The session keeps unsaved edits across a refresh.
- **Save** is `PUT /workflows/{id}/design`. It always stores the design on the workflow row (`Design`; the layout
  goes to `Layout`). It then dry-runs seven stages in one transaction (schemas, processors, caches, steps, wires,
  assignments, workflow), collecting every error with one savepoint per entity.
  - No errors: it commits, which aligns the real entities, and empties the stored design.
  - Errors: it rolls back and returns them. Problems lists them and Output logs one line per answer.
  - After every answer the document reloads with GETs.
- Owned entities (workflow, steps, assignments) are checked for conflicts ("changed by someone else since you
  opened it"). Shared entities (processors, caches) are last write wins, with a retry on xmin.
- Wires drop anywhere. Cycles are allowed and self is refused. Anything else becomes a grey dashed **loose wire**
  with an open end: it is kept in the layout and re-attaches when its end is dropped on a step. The hub draws its
  own loose wires.
- The legend shows the loose wire and has neither "broken" nor "parked"; an unwired step looks like any other.
- Closing a dirty document asks Save / Discard / Cancel.

**BaseApi.** Migration `AddWorkflowDesign`; deployed with fix `4275f3c`. Root cause of that fix: an
`x ?? new Dictionary<,>()` in a deconstructing `foreach` header crashed the IDE0028 collection-initializer analyzer
(AD0001) in SDK 8.0.4xx. Only the docker Release build hit it; the fallback is now hoisted to a local.

**Studio.** Bundle `index-BC19MgmE.js`. Fix `2ce5b40` is a pre-plan-8 view-restore bug that the production timing
exposed:
- A restored canvas lays out 26 px taller for one frame before the dock settles. `FollowSize` measured from that
  frame, so after a refresh the view came back 13 px off.
- Each saved view now carries the canvas size it was taken at, and a restore starts from that size.
- `session.spec.ts:12` failed 6 of 8 runs on the old deployed bundle and passes 8 of 8 now.

**After plan 8 (user request, 2026-10-08):** `55f5209`, `35c57ea`: a picked loose wire shows and uses the same
squares as a connected wire. Open-end square = the open circle (attach / move, bends kept); start square moves the
start onto another step or the hub (anywhere else snaps back); mid squares drag runs and the shape is kept
(`LooseWire.bends`, in the layout and the session); right-click Reset route clears it. Vitest 753; Playwright 59 + 2
skips on dev and on the deployed studio.

**More user requests (2026-10-08):** `988581e` no circle on hover at a connection point (the grab spot stays,
invisible) and the hub's pill shows only its state (no cron); `2b30b76` the Inspector's Description opens sized to
its text (cap 40vh); `f38cc40` + `e5f9001` a wire's tail (entry wires from the hub too) can be detached: the wire is
loose at its start, keeps its colour while its head is on a step or a junction, leaves nextStepIds / entryStepIds
until re-attached; a head dropped on nothing when the tail is already open is refused ("needs one end"); joined wires
follow a host re-attached to a new source (`was`). Follow-ups: wires joined on a detached host are drawn plain while
it is detached; a start-loose wire joined on a renamed host is not renamed (renameHost only rewrites routes).
Vitest 775; Playwright 65 + 2 skips on dev and on the deployed studio.

**Both ends open (user request, 2026-10-08):** `dffc157` removes "needs one end" (and "cannot start here" /
"start stays on a block"): a wire may be detached at its tail, head or both. Colour follows what is connected: head
on a step = the step's colour; head joined at a junction = the line's colour (joins only between same colours, chains
agree); head not connected = grey; nothing connected = grey dashed with an open circle at each end, outside the
workflow, kept in the layout and session. A both-open wire's head over a line moves (no colour to join with). Review
minors left: `was` lost when a both-open wire's start connects first; `isLooseEnd` uses `!('open' in l)`; stale
comments (designer.spec "snaps back", CableEdge doc, Inspector loose text); startBothEnd path builder duplicated.
Vitest 785; Playwright 66 + 2 skips on dev and on the deployed studio.

**Plan 9: wires as a circuit — BUILT and DEPLOYED (2026-10-08).** Spec
`docs/superpowers/specs/2026-10-08-skp-studio-09-wire-circuit-design.md` (aaba7cd), plan
`docs/superpowers/plans/2026-10-08-skp-studio-09-wire-circuit.md` (503f194), code 493f6fc..492b5a9, studio bundle
`index-BC19MgmE.js`. The circuit model: current flows one way hub → steps; a step's left side is its input (heads
only), its right side its output (tails only), ends slide anywhere along their side (16..144); tails anywhere around
the hub ring; tail and head junctions (fan-out / fan-in), position along a wire matters; family per net (head on a
step decides; junctions inherit); joining two families is a short circuit, refused while dragging; an Inspector edit
that makes one is listed in Problems, and Save stores the design as drawn but leaves every held-back source's list
as BaseApi had it ("Saved and applied; N short circuit(s) not written; M link(s) held back until fixed"). Open ends
keep the arrow head / ring; grey dashed while the family is undecided; four-way cursor on end squares. Old plan 7/8
layouts and sessions load and settle against BaseApi (a disagreeing junction is drawn plain). Tests: Vitest 802;
Playwright 93 + 2 skips on the dev server and on the deployed studio, incl. circuit.spec (one real-mouse test per
rule 1-14 + the base circuit rule) and circuit-save.spec (fan-in, fan-out, hub entries, held-back short circuit,
clean after Save + reload). Rulings (cost if wrong in brackets): ends slide the whole side minus corners (routing
changes); detaching a host opens its joined ends (spec over plan); short-circuit refusal when a merged net gains a
family (none known); settle opens only junctions whose links disagree (small); a shorted design is sent, held-back
sources keep their lists, settle leaves their links alone (a partial apply while a short exists); no false "design
draft" when the circuit equals the saved wiring; unrepresentable and self-links kept in saved lists (a step's link
to itself can't be removed from the designer — use BaseApi CRUD). Follow-ups: art.spec's pulse selector
(`.wire:not(.dashed)`) not yet run against a live workflow; junction draw vs traced order on a shortened host (plan
7 behaviour); withCircuit per run-drag move not memoised; settle's non-convergence warning is dev-only; creating new
wires deferred (spec §2.1).

**Wire drag (user request, 2026-10-08):** `fa8c137`, `f7e468c`. Cursors: open hand over a wire's body where there
is no square, closed hand while the body is dragged, two-way arrow over run squares, four-way over end squares.
Dragging the body moves the whole wire rigidly (shape frozen, stored as bends) and detaches it from every contact
point (tail, head, its own junction ends); wires joined on it get their ends opened. A press that moves less than a
grid step only picks. Run squares unchanged. An end square dragged across its last run adds exactly one corner (an
L); dropped on a step / the hub / a wire it connects per the circuit rules. On an open drop the other automatic end
is held at its drawn height (`held`, stored in the layout) and goes automatic again when the end reconnects.
Moved wires and L legs are not routed around blocks (as asked). Vitest 821; Playwright 96 + 2 skips on dev and
deployed. Spec §6 of plan 9 and the older specs carry superseded notes.

**Wire rules A-D (user request, 2026-10-09) — BUILT, NOT DEPLOYED.** Code `d275f13`, `4cd3cd7`; tests `2e895eb`,
`71fb8c2`; docs in the commit that adds this paragraph. Spec: plan 9 §2.3 (new), superseded notes in plan 9 §2.1, §3, §5, §6 and in the plan 4
and studio specs. The deployed bundle is still `index-BC19MgmE.js` (without these rules).
- **A. Cursors** (already true): open hand on the body only, four-way on end squares, two-way on run squares, closed
  hand while the body is dragged. New e2e test.
- **B. Body drag** (`design/bodyDrop.ts` `landBody`): the wire moves rigidly, shape frozen, detached from everything,
  connected ends too. Each end is judged as an end-square drop (same `targetOf`/`judgeDrop`/reach), one label and
  outline per end (`hints: DropHint[]`). An end over a contact it may take shifts the wire exactly onto it (the end
  that got there first decides, kept across moves); released, every such end connects with the frozen shape as its
  bends, the others stay open. Back exactly where it was (net shift 0 after the snap): nothing is committed, the wire
  is as it was (the drag-away-and-back case). Rulings: the second end "fits" when the shifted shape meets its contact
  within a step side's line (x exact, y within 4 px: heights are snapped to 8), a line's 4 px, or the hub ring's
  12.5 px (half its 15 degree spacing); if not, and shifting onto the second end's contact instead meets both, that is
  used; otherwise the first end connects and the second is "move here". A hub contact stores the snapped angle, so a
  hub tail moved back a few px off its automatic place comes back as an angled tail.
- **C. End square** (`layout/wireMove.ts` `startLegs`/`moveLegs`/`legsPath`): an L to the pointer; a 90 degree turn
  (16 px of travel at least 2:1 along the anchor's axis while the L's other leg is at least 16 px) fixes the corner
  where the pointer turned; back at or past a fixed corner removes it. Rulings: only corners fixed in this drag can
  be removed (the wire's own corners stay; removing them walked a dragged tail back to its head in the old tests); a
  slanting drag turns no corner; on a contact the drawn corners are kept and the last leg goes in (a vertical last
  leg goes on to the contact's height and square in, so the user's corner stays; otherwise routed from the anchor);
  an automatic wire with no corner fixed in the drag is still routed by the router (so a plain re-target stays
  automatic). `endMoved`/`movedEndShape` are gone.
- **D. Direction-less wires** (`isFree`, `reverseWire`, `roleOf`, `applyDrop`, verdict `needsStep`): derived from the
  ends (no new stored field), so Save, reload and refresh keep it as the circuit does. No ring and no arrow head
  (`WireRoute.free` → `CableEdgeData.free`). The first end on a step or the hub decides (input → head; output or hub
  → tail), the wire turned round when needed (same id, bends reversed, `held` swapped). Judged on the wire turned that
  way, so short circuit / same step / family still refuse. A moved wire (rule B) is direction-less while moved.
  Joined on one line, another line is "needs a step first". Writes nothing (no terminal, no current).
- Tests: Vitest 838 (75 files); tsc clean; Playwright on the dev server 107 passed + 2 skipped (the usual art.spec skips). New e2e (real mouse, circuit.spec):
  cursors; drag away and back (exact, and 16 lower, shape exact); one-end-connected moves whole; two ends over one
  input ("wrong side"); 3 corners in one drag; corners kept on connect; first output/input decides; join then
  output/input; "needs a step first"; refresh keeps direction-less wires; circuit-save: a direction-less wire writes
  nothing and survives Save + a fresh read. Each new test was checked to fail with its behaviour broken (seven
  source mutations). Older tests that asserted a ring/arrow on wires with no step end, or moved a body onto a step by
  accident, were updated (circuit rules 11, 12, the body-drag test; designer tests at 820 and 882; two jsdom gesture
  tests).
- Follow-ups: a hub tail as the *second* end of a
  body drag connects at the nearest 15 degrees (a few px off the frozen shape, the ring lead absorbs it); not yet run
  against the deployed studio (no deploy asked).

**Review of the wire rules (2026-10-09):** `19d2711` (fixes), `20a9582` + the Save-test commit after it (e2e).
- A wire is judged as lifted: when the dragged end is its only step/hub end it is direction-less while dragged (a
  step side decides afresh, a second line is "needs a step first"). Before, a wire with its tail on a step and its
  head joined could be joined on a second line and Save wrote a link through it.
- `trace` leaves direction-less wires out: no current through them or their junctions (nothing joined on one reaches
  BaseApi; they make no wire loop). Old trace tests that let a host open at both ends conduct were rewritten.
- `reverseWire(c, id, length)` keeps joined ends in place (`at` -> `length - at`); a turned drop is judged against the
  circuit as it was. Exact when the host keeps its shape; an automatic host re-routed after the turn still moves its
  junctions (as any re-route does, plan 7 follow-up).
- `hubStart`: a hub tail with its own bends starts at its ring point snapped to the grid after a short lead (an
  automatic tail, or a left-half tail whose shape heads right, keeps `hubLead`); a body drag lands on it by a grid
  shift. This also redraws existing manual hub-angle wires on the right half from the ring (at most a 4 px jog).
- settle never re-heads a junction end onto its `s->t` target when the wire's tail is on t.
- Re-review: `applyDrop` now takes `Placing` (drawn routes + route context, required) and places every end joined
  on the dropped wire as far from the end that did not move as before, on the wire as drawn after the drop (turned
  or not; `reverseWire`'s length is required). Fixes the junction drift when a stored head is dropped on the hub or
  an output. If the re-drawn wire is shorter than that distance the junction is clamped to the wire's start.
- Investigation (read-only GETs, deployed BaseApi, 2026-10-09): 7 workflows, every one with `layout` and `design`
  null: no stored circuit anywhere, so no saved design has a direction-less wire with wires joined on it (the
  `trace` change cannot alter any stored design on the cluster today). Script:
  scratchpad `scan_designs.py` (reads plan 9 `wires` and plan 7/8 `routes`/`loose`).
- Tests after the review: Vitest 847; tsc clean; Playwright on dev 110 + 2 skips. New e2e (real mouse): lifted
  direction and "needs a step first", a junction stays put when its host is turned, an entry wire moved onto the hub
  and its step, Save with a wire poured into a direction-less wire; each fails with its fix reverted.

**Cut rule (user request, 2026-10-09) — BUILT, NOT DEPLOYED.** `11a6781` (feature), `d0814ce` (e2e). Spec: plan 9
§2.3 E and §6. End-square drag only: released on one of its own wire's run squares the wire is cut there (the part
from the square to the dragged end goes, the wire open there, its shape up to there kept, its other end held where
drawn); on its other end square the wire is deleted (as Delete). `design/cut.ts`: `squaresOf` (shared with the
overlay), `squareAt` (within a square's own screen size), `cutPaths` (preview: kept / gone), `cutWire`,
`holdDrawn`. During an end drag the picked wire's squares no longer follow the ghost: they stay where they were
when the drag began (they are the targets). Labels "cut here" / "delete wire" (green tone); the part that goes is
drawn as a faded red path (`.design-gone`), a deleted wire faded (`.wire.faded`). Judgement calls: the tone is green
(the release does something); a cut keeps a straight remainder as a one-run shape; the stationary automatic end is
held where it is drawn (as an open drop does), so cutting does not re-route it; a junction kept on a tail-cut
wire keeps its point (its `at` shifted back by the cut distance). Tests: Vitest 855 (859 after the review fixes); Playwright on dev 118 + 2 (119 after)
skips. New e2e (real mouse): cut at a run square (corners before kept, after gone, end open, hover label and
faded part, squares stay put, Ctrl+Z), moving off and Escape, the other end square deletes (Ctrl+Z), joined on the
part that goes opens / on the part kept stays, run-square and body drags onto own squares never cut, and in
circuit-save: Save writes the cut link gone and a fresh read draws it cut. Each fails with its behaviour broken.
Review fixes (2026-10-09): a held automatic hub tail (a cut, or an entry wire's head dropped open) keeps its drawn
height (`{ on: 'hub', angle: null, dy }`, out of the fan-out, dropped when the other end connects; it used to snap to
15 degrees and move the kept part by up to a grid step); run squares and cut points sit on the 8 px grid along their
run. Left as is (pre-existing): a junction on a very short kept part can slide by contactOn's 16 px end margin.
Re-review: a run one grid step long has no grid point inside it, so its square stays at its middle for run drags and
is no cut target (`Square.cuts`, `cutTargets`); a cut never leaves a wire of no length. Reset route also clears a
hub tail held at its height (back to plain automatic, nothing held) and is offered for that alone (`shapedByHand`).

**Grey direction-less wires and overlap short circuits (user request, 2026-10-09) — BUILT, NOT DEPLOYED.** Code
`7e0211f` (model, drawing, Problems, Save hold-back, router), `5da1a00` (drags), `522983c` (junction jog side), `2099fab`
(never through a block to keep off a wire; the routed leg of an end drag keeps off wires; cheaper counting); tests
`eb18fdc` (new e2e), `14b6e9b` (older e2e drags); docs in the commit that adds this paragraph. Spec: plan 9 §2.3 F and
G, notes in §3-§7 and §10.
- **Rule 1** (`netsOf`): a direction-less wire is in no live net, so it is always grey and dashed and nothing takes a
  family through it. Two families joined only through one are no short circuit (nothing flows through it, as `trace`
  already had it); the drop that gives it a direction is judged turned, so that one is refused.
- **Rule 2** (`layout/overlaps.ts`: `LineIndex` keyed by the line a run lies on, `overlapsOf`, `mayShare`): two
  different wires sharing more than a point of line are a short circuit unless both are directed and in one net. Both
  nets are short-circuited (`shortedWires(nets, overlapping)`): red stretches on each wire (`WireRoute.overlaps`, drawn
  as `path.nx-overlap`), `shortWith` partners, junctions red, Problems "short circuit: <wire> overlaps <wire>" (kind
  `wire`, named by `design/wireName.ts`, shared with the Inspector), shown lists leave their links out, Save holds the
  sources back (`heldSources(circuit, shorted)` from the drawn `short` flags), settle routes the circuit (with the
  draft's block moves, `placementOf`) to know them.
- **Router**: hand-shaped wires are drawn first; an automatic wire on another net's wire tries spreads (elbows and U
  levels a grid step at a time, up to 6 each way) and the other jog side at a level junction, scored by short circuits
  then blocks crossed (`hitsOf`), so it never goes through a block to dodge one when a track around exists.
- **Drags** (`design/overlapJudge.ts`): end square (kept shape or open) and run square refuse ("short circuit", snap
  back); body drag moves anyway, ends that would connect stay open where the pointer put them (`landBody` takes the
  judge). Only when the path lies on an automatic wire is the circuit after the drop routed (that wire may step aside).
  Pairs already short before the gesture do not refuse it.
- Rulings (cost if wrong in brackets): exemption is "one net through junctions", so two plain wires out of one step,
  or two heads slid to one point of a step's input, are a short circuit when they share a line (small: a rule tweak in
  `mayShare`); two direction-less wires on each other are a short circuit (literal reading of "not in any live net";
  nothing is held back, only listed); a whole net is held back, not only the wires on the stretch (as family shorts);
  the overlap error names the pair in drawing order; the shortcut for "already a short before" is per pair of wires;
  the end-square judge skips drops the router will draw again (it steps aside by itself); the pen's legs (rule C) are
  not routed, so a leg drawn along a row's middle line through steps lies on the wires there and is refused (several
  older e2e tests drew such legs by accident and now pick clear spots).
- Visible on existing workflows: automatic wires that the old router laid on each other (long back edges on one U
  level, a junction jog on another wire) now take adjacent tracks, e.g. a U one grid step higher (dock.spec saw a point
  at y -8; the grid check now accepts -0).
- Performance (`applyDesign`, median of 5 fresh-process medians, before -> after): live 18-wire chain 0.245 -> 0.458 ms
  (one wire shaped) and 0.244 -> 0.608 ms (a both-open wire on an automatic wire); synthetic 118 wires 5.25 -> 6.33 ms
  and 5.08 -> 5.77 ms. On the live chain five automatic wires now search for a free track (their old ones lay on other
  nets' wires). Drag moves cost one index lookup per path; the circuit is routed only when the path lies on an
  automatic wire.
- Tests: Vitest 896 (78 files); tsc clean; Playwright on the dev server 126 passed + 2 skipped (the usual
  art.spec skips). New: unit tests for the index, overlap shorts, same-net exemption, crossings, grey direction-less
  wires, nets through free wires, hold-back, Problems row, settle, router spreads/jog/blocks, the judge, body landing,
  `legPath`; e2e overlap.spec (6) and overlap-save.spec (1). Each new test was checked to fail with its behaviour broken
  (source mutations: free-wire nets, overlap marks, run judge, end judge, crossings counted, same-net exemption ignored,
  hold-back family-only, settle blind, body judge (unit), router block search). Older tests updated: families /
  circuitRoute fixtures (a wire joined only on a line is direction-less now), circuit rule 8, designer joined-tail
  colour, and the drags listed above.
- Incident: removing my temporary baseline worktree (it had a junction to `node_modules`) with `git worktree remove
  --force` deleted part of `src/WorkflowStudio/node_modules` through the junction. Restored with `npm install` from the
  unchanged lockfile (every non-optional package present at its locked version, package files untouched); a running
  node process held `@rolldown/binding-win32-x64-msvc`, so npm left a renamed copy `.binding-win32-x64-msvc-*` beside
  it (harmless; goes on the next install once that process ends). `git worktree prune` also dropped the stale entries
  of the two prunable SK_P9 worktrees (their folders were already gone; branches untouched).
- Follow-ups: not deployed (and not run against the deployed studio); a run drag judges the core only (a hub or
  junction lead does not move, so any overlap there was already there); Problems' wire rows select nothing (there is
  no wire selection kind); an automatic host routed early (because a hand-shaped wire is joined on it) avoids only what
  was drawn before it.

**Sibling bus (user ruling, 2026-10-09) — BUILT, NOT DEPLOYED.** Wires with their tails on the same step's output
(or both on the hub) and of the same colour (one family each and the same, or both undecided) may share a line: no
red, nothing in Problems, Save writes their links. Different colours out of one step stay a short circuit. One change in
`mayShare` (`layout/overlaps.ts`), which the drawing, Problems, the drag judge, Save's hold-back, settle and the router
all use; the router may now let such siblings share a track but routes them as before otherwise. Judgement call: two
undecided (grey) siblings count as the same colour; a wire of a short-circuited net has no one colour. Tests: unit
(`mayShare` siblings, drawing + Problems + hold-back for one and two colours) and e2e `overlap-siblings.spec.ts` (a
new a -> c run onto a -> b's upright: allowed, no red, "No problems", Save writes b, c, d; a -> d's run onto it is
"short circuit"); both fail with the sibling clause disabled.

**Review of the overlap work (2026-10-09) and the coordinator's ruling — BUILT, NOT DEPLOYED.** Repros in the
scratchpad `vt2\` (old router copy in `old\`).
- CRITICAL fixed: Save could drop links. With no circuit of its own (blocks moved only) the held sources were rebuilt
  from the shown lists, which already leave a shorted net's links out, so nothing was held and the lists went out
  without them. `heldSourcesOf` now reads the drawn short wires' own sources; `heldLinkCount` traces the circuit built
  from the base. New property test `app/saveInvariant.test.ts` (120 random workflows: blocks moved, wires shaped by
  hand, a both-open wire laid on a wire): Save never removes a loaded link; it failed before the fix (trial 42).
- Ruling: two fully automatic wires on each other are never a short circuit (`isAutomatic`, `mayShare`); the router
  still keeps off other nets' wires (`sharesNet`). Priorities: blocks first (overlap cost capped under one block hit;
  search scored blocks then overlaps), its own source and target blocks never run through (`hitsOf`: the end segments
  may touch their own block's border, not go inside), then elbows / U levels / junction side, then its own heights
  (one end, or both together). Routing in id order (hand-shaped first): reversing the circuit gives the same drawing.
  A hand-shaped wire's junction side follows its own runs, so a run drag keeps the side the router drew. Problems
  overlap rows pick both wires (`DesignError.other`, `errorPicks`). Overlap keys rounded to 0.01 px.
- Random plain workflows (the review's generator, 300): 0 open with a short circuit (was 10); 0 wires cross more
  blocks than under the abf2aec router, 8 cross fewer (they ran through their own target); reversed order: identical.
  Committed as tests in `circuitRoute.test.ts` (300 plain, 60 with hand shapes).
- Routing medians, abf2aec router -> now (same process): live chain plain 0.17 -> 0.35 ms, one wire shaped 0.16 ->
  0.32 ms, a both-open wire laid on an automatic wire 0.17 -> 0.69 ms; synthetic 118 wires 2.7 -> 2.9-3.1 ms. A wire
  whose start or landing stub is covered skips the track search and goes to its heights.
- Older tests changed: fixtures that laid a wire on an automatic straight wire now pin that wire by hand (automatic,
  it now moves a track over); the overlaps unit tests of the net / sibling rules use `sharesNet`.
- Tests: Vitest 909; e2e overlap.spec 7 (new: the Problems row picks both wires; a junction wire drawn from the far
  side keeps it when a run square shapes it); each new check fails with its fix reverted.

**Re-review (2026-10-09) — BUILT, NOT DEPLOYED.**
- Order (finding 5): hand-shaped wires on no other wire are recorded before any hand-shaped wire joined on an automatic
  host is drawn (which draws that host); then the automatic wires. The review's case (m and child in either order): no
  short circuit, same drawing.
- Automatic wires left on each other: rip-up (each drawn again against everything else, kept only when it lies on
  fewer wires, 3 rounds); every mix of a U's parts moved tried in a second, dearer search phase; candidates compared
  strictly blocks > overlaps > length. 300 untouched workflows: seed 4242 (the review's touch generator) 0 left (was 8);
  seed 12345: 1 graph left, drawn twice (trials 150 and 233): four wires funnel into s16 through its 64 px gap and every
  local alternative for one of them lies on a third (s12 -> s16, s2 -> s16, ...); only a global re-plan of landing slots
  would part them. Committed as tests (0 and at most 2).
- Safety net: `overlapJudge` refuses only stretches the gesture newly makes (a stretch the two wires already shared as
  drawn never refuses). jsdom test: a run drag on s8 -> s16 in that crowded graph commits, and the drawing after it
  has no short circuit (the automatic partner moved around the now hand-shaped wire); unit test with the partner pinned.
- Routing medians, abf2aec -> now (same process): live chain 0.17 -> 0.37 ms (one wire shaped 0.16 -> 0.36, a both-open
  wire on an automatic wire 0.18 -> 0.79); synthetic 118 wires 2.7 -> 3.9-4.1 ms (its long skip links on shared U levels
  are now searched apart instead of left on each other).
- Each new check fails with its fix reverted (pass order, judge stretch filter, rip-up + mixes).
- Final check (2026-10-09): an old stretch is excused by the drag judge only when the pair was already a short circuit
  or allowed only because both were automatic, not because they were one net or a bus (a bus wire's head dragged onto a
  step of another colour, or a tap's junction end detached, while the shared stretch stays: refused, as before
  97bbfa7); `overlapJudge` takes the circuit before the drag. A rip-up track is kept only when strictly better by
  (blocks crossed, short circuits under the rules, other overlaps, length) (`ripUpBetter`). Unit tests for both cases
  and the comparator; the two judge tests fail with the old excuse rule.

**Inspector read-outs (user request, 2026-10-09) — BUILT, NOT DEPLOYED.** Spec: plan 9 §2.4 (new), a superseded note
in the plan 4 spec. User decisions: show the drawing only (design over base), no diff against BaseApi, no saved view, no
read-out for steps, names as plain text.
- A picked wire gets a WIRE pane (replacing "Wire: {from} → {to} · {family}"): From (tail) / To (head) (One end / Other
  end when direction-less), Direction, Condition (with the short-circuit reasons), Carries (links through it, each
  marked written / "kept as BaseApi has it" / "held back" / "not written: feeds itself"), Shape, Joined on it.
- The workflow gets a **Graph** section under its fields: entry steps with conditions, a Step / Entry / Next steps table
  (by unique name; Save's lists, then drawn links held back), and the problems (steps with no wires, open wires,
  direction-less wires, short circuits) or none.
- One source of truth: `panels/readout.ts` (`readoutModel`, `wireReadout`, `graphReadout`) reads `applyDesign`,
  `circuitOf`, the drawn routes, `netsOf`, `trace` / `wiresBetween`, `shortCircuitErrors` and the new `writtenLists`
  (`design/shortCircuits.ts`), which `buildDesignRequest` now uses too. `contactDistance` was split out of `contactOn`
  so a junction's "N px along it" is the drawn distance. UI `panels/Readouts.tsx` (dl / table with headers), styles in
  `panels.css` (`.readout`, `.rtable`). It is memoised on the document, draft and edits, and built only while it is
  shown. Nothing is computed during a drag (previews never reach the store).
- Judgement calls: steps sorted by unique name (stable under block moves); a held source's list is BaseApi's, and links
  drawn but not written are appended as "(held back)"; a link through a shorted wire that BaseApi already has reads
  "kept as BaseApi has it" rather than "held back"; corners count the drawn path's turns (leads included); slid ends
  show in From/To, Shape says "by hand" only for wires with bends; open/direction-less wires are named as Problems names
  them, so two "an open end → an open end" wires read alike.
- Tests: Vitest 937 (80 files; +17 `readout.test.ts`, panes tests for the WIRE pane and the Graph section); tsc clean;
  Playwright on the dev server 131 passed + 2 skipped. New e2e `readout.spec.ts` (real mouse, throwaway `e2e-9-…`): a
  wire's rows, its head dragged open and the rows updated, Undo; Graph rows equal BaseApi's nextStepIds and entry steps
  before a change and after Save; a short circuit (an entry-condition edit) in both read-outs. Two designer.spec checks
  moved from "Wire: " to the read-out. Mutations checked: 11 unit (status, draft ignored, hold-back ignored, carries
  unfiltered, held items, reasons, junction distance, corners, joined, direction, unwired steps) and 3 e2e (draft
  ignored, base lists shown, no reasons): each fails.

**Step read-out (user request, 2026-10-09: "do it to step too") — BUILT, NOT DEPLOYED** (the wire/workflow read-outs
are deployed as 35fa1bc, bundle `index-BX8byXMC.js`; full Playwright on it 131 + 2 skips). A picked step's Inspector
shows a Graph section under its fields: Entry condition, In (the workflow and/or source steps, held-back links marked),
Out (Save's list, then held-back links, with the held note), Wires on it (count, plus open / direction-less / short
circuit wires by name, or none). `stepReadout` in `panels/readout.ts` builds In and Out from the workflow Graph's own
`linksOf`, so they cannot disagree; `StepGraphSection` in `Readouts.tsx`, same memoising. Judgement calls: "Wires on
it" counts only ends on the step's sides (a wire joined on a wire into it is not counted); sources in In are ordered
the workflow first, then by unique name. Tests: 7 unit (hub entry, no wires, fan-in, fan-out, short circuit / held,
open wire, and a 60-trial random-design invariant: In/Out equal the workflow table), a panes test, e2e
`readout.spec.ts` test 4 (pick c and a, drag a -> d's head open, Out/In/flags update, Save, Out equals BaseApi).
Totals: Vitest 945 (80 files), tsc clean, Playwright on dev 132 + 2 skips. Five
unit mutations and one e2e mutation each fail.

**Output, the Save log, Start and Stop (user decisions, 2026-10-09) — BUILT, NOT DEPLOYED.** Commits `074f2cc`
(BaseApi + regenerated client), `d7241d3` (studio), `ad8f7df` (e2e + a settle-report fix), and the docs commit that
adds this paragraph. Specs: plan 8 spec §4.1 and §4.3 (amended), studio spec §6.1, §7.3, §8 (amended / superseded).
- **One panel.** Problems is gone (dock, View/Window menus, `ToolId`, default layout: Output alone below the
  documents). `panels/Output.tsx` pins the active document's live short circuits and last Save errors as red rows at
  the top (`role=list` "Problems", focusable, Enter/Space, same names and click-to-pick as Problems had, a wire row
  picking both wires), then the log (`role=log`), errors red (`--error: #F87171`, the canvas's short-circuit red).
  `parseLayout` drops a retired pane (`RETIRED_TOOL_IDS`) from any stored layout or session: its tabs and panel go, a
  group it leaves empty goes (grid, rail, floating, pop-out; the document area stays), homes beside it and its
  snapshot boxes go. Apply never sees it, so an old session no longer trips "a tool pane the dock does not know".
- **Save log.** BaseApi: `DesignOutcomeDto.Log` (optional `DesignLogDto(Stage, Level, Kind, Id?, Message)`), written
  by `DesignRun` (`BeginStage`/`Changed`/`Unchanged`/`EndStage`, `Fail` also logs, `Label` names entities) and
  `DesignLogText` (field diffs, link diffs "a→e added, a→c removed"); the syncer adds the store, "dry run started"
  and the outcome lines. Studio: "Save started: sending …", then `BaseApi · …` lines, the verdict, "graph re-read",
  held-back short circuits, settling (compared as drawn, `settleReport`), what stays stored; "Not saved: …" red.
  `store/output.ts` keeps the last 500 lines; the session keeps them (`Session.output`, optional, version 1).
- **Start / Stop.** `api.startWorkflow/stopWorkflow` (`POST /orchestration/start|stop`, body the id, 202 read as no
  body). `OpenDocument.live` (dispatched by DocumentPanel from its poll) and `run` (`store/run.ts`, `runBlocked`);
  `app/runWorkflow.ts` logs request / accepted / refused (red, `describeError`, e.g. "422: …"); the reducer's `live`
  action finishes a waiting press when the live set agrees ("running" / "stopped"), `runTimeout` (30 s) ends it red
  (the parked-start gap). Start's note: "Started the saved workflow; your unsaved design is not part of this run"
  (dirty), or a like note for a stored design not applied. F5 / Shift+F5 run it for the active document.
- Judgement calls: an empty stage is one line ("schemas: nothing to do") rather than start + finish; an entity a stage
  looked at but left as it was is counted "unchanged" with no line (a wiring-only step in `steps`, an assignment
  already gone); values over 40 characters read "<field> changed"; the stage counts line is `error` when any entity
  was refused; "dry run passed: N changes" counts the change lines; "Start requested … for the workflow BaseApi
  holds" logs before the note-free press too; held-back short circuits are red lines though the save applied;
  nothing is pinned when there are no problems (no "No problems" text; e2e checks zero rows); a stored-but-not-applied
  design also gets a Start note; the pinned list takes at most 60 % of Output's height and scrolls.
- Tests: BaseApi hermetic 2024 passed + 70 skipped (new `DesignLogTests` 3: full applied order, refusal order and
  levels, names of shared entities / assignments / links); Release `--no-incremental` build clean (no AD0001). Vitest
  968 (82 files; new `runWorkflow.test.ts`, `saveLog.test.ts`, session output, layout migration (unit and on a real
  dockview), Output pinned/log, toolbar Start/Stop states); tsc clean. Playwright on the dev server **against this
  branch's BaseApi run locally**: 137 passed + 2 skipped (new `output.spec.ts` 4, `run.spec.ts` 1). Against the
  deployed BaseApi: 135 passed + 2 skipped, `output.spec` "a Save with a change" fails (no `log` in the old answer;
  the test after it then does not run) until BaseApi is deployed. Mutations checked: 2 BaseApi, 9 Vitest, 5 e2e, plus
  the layout migration (unit + dockview); each fails.
- Running the branch's BaseApi locally (no deploy): `kubectl -n skp port-forward svc/postgres 15432:5432`, then the
  scratchpad `local-baseapi.ps1` (Release dll on :18090, the cluster's Postgres/Redis/RabbitMQ forwards, secrets read
  from `skp-dev-secrets`), then `$env:SKP_API='http://localhost:18090'; npx playwright test` (vite's proxy reads
  `SKP_API`). It joins the cluster's queues as a second BaseApi consumer while it runs; stop it afterwards.
- `run.spec` starts and stops only its own `e2e-run-…` workflow (one step on a live processor with no schemas, e.g.
  outcome-recorder, no cron so it never fires); the write guard allows `POST /orchestration/start|stop` only with
  this run's `e2e-` id as the body; `afterAll` stops it through BaseApi and waits for the live set before deleting.
- Deploys needed: **BaseApi** (the log; no migration) and **the studio** (bundle). Either order works: the studio
  reads a missing log as "an older BaseApi", and an old studio ignores `log`.
- Follow-ups: the Inspector keeps its read DTO after an applied Save (a field Save changed shows its old value until
  the entity is picked again; seen in the e2e screenshot, pre-existing, not touched); live `WorkflowDesignLiveTests`
  assert only `applied`/`errors`, so the log on Postgres (rollback order) is proven by the hermetic tests and the e2e
  run against the local BaseApi, not by a live test; a press's timeout is not kept across a refresh (a refresh mid-start
  shows the live status, nothing pending).

**Review of Output / Save log / Start-Stop (2026-10-09) — BUILT, NOT DEPLOYED.** `f176d89`. Plain F5 / Shift+F5
only (Ctrl/Meta/Alt+F5 are the browser's) and never while a dialog is open; a pending Start/Stop keeps polling while
its tab is hidden; Start/Stop blocked while saving; `DesignLogDto.RolledBack` marks a rolled-back save's change lines
("(rolled back)" in Output); a refused entity is counted once (refused); the workflow stage names links the assignment
stage removed and counts its stamp-only write as updated; per-Save bound (first 60 + last 120 lines, "… N lines of this
Save omitted"), lines cut at 400 chars, payload / items / definition never echoed; `keepSession` rewrites a refused
session with the log trimmed, then without it; wire stage batches its reads. Tests: hermetic 2026 + 70 skipped (+2),
Release no-incremental clean; Vitest 975 (83 files); tsc clean; Playwright on dev against the branch BaseApi 137 + 2
skips (run.spec now also presses Ctrl+F5, F5 in the picker and Shift+F5). Mutations: 3 BaseApi, 8 Vitest, 2 e2e.

**Inspector after Save, and Output's Clear (user, 2026-10-10) — BUILT, NOT DEPLOYED** (the deployed studio is
2945e6d, bundle `index-BNs41JWd.js`). Spec: plan 8 spec §4.1 (amended).
- Cause: the Inspector's form showed its own per-entity GET (`inspector.saved`), read once per picked entity
  (`service.read` skipped when the key was already read) and never invalidated when a Save re-read the graph, so it
  kept the values from before until re-picked. Fix (the user's ruling): the form's base is the design graph's entity
  (`inspectorBaseOf` in `panels/inspectorView.ts`: the loaded graph's values, the read only for what the graph does
  not carry), edits over it as before; `OpenDocument.generation` counts the workflow's reads ('loaded', a Save's
  re-read), the read is keyed to it (an older read is dropped, the shown entity is read again once per generation, no
  storm), and a failed read beside a graph-backed form shows its note with Retry. Other entities' edits are untouched.
- Output's Clear: `OutputBar` (button "Clear output", tip, disabled while empty), `clearOutput` action, the session's
  log emptied with it; DockShell `toolMenu` puts "Clear output" at the top of Output's tab menu.
- Tests: Vitest 979 (83 files; graph-backed Inspector: edit shown at once, Save shows BaseApi's value with no re-pick
  and one GET, Discard shows the base, workflow and processor, stale read dropped; Clear; tab menu entry); tsc clean.
  Playwright on dev against the deployed BaseApi: 140 passed + 2 skips (new `inspector-save.spec.ts` 2: step, then
  workflow and processor, Discard, refresh; `output.spec` Clear: log empty, pinned short circuit stays, refresh keeps it
  empty, tab-menu Clear). Mutations: 5 Vitest, 2 e2e (the old Inspector behaviour; Clear doing nothing), each fails.

**Review of the Inspector fix (2026-10-10) — BUILT, NOT DEPLOYED.** An Inspector edit was still judged against the
entity's own read (`setField` base: "typed back" and the `updatedAt` stamp) while the form showed the graph: after a Save
with a stale or failed re-read, the next edit carried the pre-Save stamp (the next Save refused "changed by someone
else") and typing the old value back was dropped; with no read yet, a step's keystrokes were lost. Now `editField` uses
`editBaseOf` (`store/inspectorBase.ts`, shared with the Inspector): the graph's entity, its stamp included, with the read
only of the current generation; an assignment or schema (not fully in the graph) takes no edit, and its form shows
"Reading what BaseApi holds now…" with its fields disabled, until that read lands. Clear during a Save keeps that Save's
"Save started" line. Tests: Vitest 985; tsc clean; Playwright on dev (deployed BaseApi) 141 + 2 skips; new e2e: rename a
step, Save, rename it straight back with its re-read failing (page route), Save: both applied, no conflict. Mutations: 4
Vitest (one survivor fixed with a graph-wins test), 1 e2e.

**Save spinner (user, 2026-10-10) — BUILT, NOT DEPLOYED** (deployed studio is 9fbb8a5, `index-CAfPNaTe.js`). For the
whole Save (`open.saving`: click through answer, re-read, alignment) the Save button shows a CSS spinner in place of ⤓
("Saving…", disabled, `aria-busy`), and the workflow's tab shows one beside its name (`DockDocument.saving`, also behind
another tab, floating or popped out). Once shown it stays 300 ms (`useMinShown`, the visual only; the Save button stays
"Saving…" for that tail). Reduced motion: a pulse (`.spin.reduced` from `useReducedMotion`, and the CSS media query).
`SaveAnnouncer` (`role=status`, polite, "Save status"): "Saving <name>…", then "Saved <name>" / "Not saved <name>".
Tests: Vitest 989 (84 files; min 300 ms, reduced class, announcer, tab spinner, busy button); tsc clean; Playwright on
dev (deployed BaseApi) 143 + 2 skips; new `spinner.spec.ts` (PUT held 1.5 s by page.route: button and tab spinner,
another tab in front, gone after alignment, announcements; reduced motion via emulateMedia). Mutations: 4 Vitest, 2
e2e.

**Live push of workflow and processor liveness over SignalR (user-approved design, 2026-10-10) — BUILT, NOT DEPLOYED.**
Commits `0807a03` (BaseApi hub + monitor + hermetic tests), `85def3e` (BaseApi live test), `73a292d` (studio, nginx,
vite), `6441d67` (e2e), and the docs commit that adds this paragraph. Spec: studio spec §6.4 (new) with superseded notes
in §4.4, §5.1, §6.1; notes in the plan 8 spec and in plans 01b, 03c and 08.
- **BaseApi** (`Features/Liveness/`): `LivenessHub` at `/api/hubs/liveness` (under `/api/` so both proxies pass it
  unchanged); `LivenessMonitor` (hosted) reads `skp:live` and probes every processor row with the gate's
  `ProcessorLivenessProbe` every 2 s (`Liveness:IntervalSeconds`, 16 probes at a time), `LivenessState` diffs and hands
  out sequence numbers, `HubLivenessPublisher` broadcasts `workflowLive`, `processorLiveness` (with `removed`) and
  `monitorStatus`. `Snapshot()` = whole state + the sequence it includes (waits up to 5 s for the first reading after a
  start). Failed reads are logged (1st, then 1 in 30) and retried; 2 in a row = `monitorStatus known: false`. GETs
  unchanged. **One replica, no backplane:** scaling out needs a SignalR backplane (Redis) and a single monitor/sequence.
- **Studio** (`src/live/`): `liveState.ts` (pure reducer, defensive GET parsing moved here from `api/liveStatus.ts` /
  `api/liveness.ts`, whose old parsers and tests are gone), `liveClient.ts` (connection, snapshot/gap/held changes,
  fallback poll, retries), `signalrHub.ts`, `LiveContext.tsx`. `OpenDocument.live` and the `live` action are gone;
  `liveChanged` logs "running"/"stopped" for any workflow and ends a waiting press; `runAnswered` carries the status
  at answer time; `runBlocked(doc, live, op)`; `runWorkflow(..., liveOf)`. DocumentPanel no longer polls (and no longer
  takes `api`); `usePanelVisible`/`useLiveStatus`/`useLiveness` removed. `LiveMark` in DockShell's new `status` slot,
  picker `running` dot, Inspector Liveness row. `App` prop `hub` (default: SignalR, or none when a test injects `api`).
- **Proxies:** nginx `location /api/hubs/` with `proxy_http_version 1.1`, Upgrade/Connection, 3600 s read/send
  timeouts, no buffering; everything else unchanged. Vite `/api` proxy `ws: true`.
- **Judgement calls:** hub path `/api/hubs/liveness` on BaseApi itself (no rewrite in either proxy); WebSockets only
  with `skipNegotiation` (no POST negotiate, so the read-only e2e guard holds and no sticky sessions are needed; a proxy
  without WebSockets means fallback polling); a third broadcast `monitorStatus` so a Redis outage shows "unknown" as
  the old failed poll did instead of stale data (client re-snapshots on known again); `removed` on processor events for
  deleted rows; the first answer after a load is the baseline (no Output lines), an unknown spell keeps the baseline;
  the press confirmation line is now just "running"/"stopped" (when it beats the 202 the accepted line is "Start
  accepted by BaseApi (202)" and the press is done); no mark while connecting at start (only reconnecting/offline);
  names in Output from the open document, else the workflow list, else the id (and the list is re-read); the live
  test speaks the SignalR JSON protocol over a bare `ClientWebSocket` (no client package for the offline feed); the
  e2e writes heartbeats with a hand-rolled RESP helper (`e2e/redis.ts`) to `localhost:6380` for its own throwaway
  processor only.
- **Tests:** BaseApi hermetic 2042 passed + 71 skipped (+16: `LivenessStateTests` 7, `LivenessMonitorTests` 5,
  `LivenessHubTests` 2, `RedisLivenessSourceTests` 2); live `LivenessHubLiveTests` 1/1 against this branch's BaseApi
  on :18090 (and again through a temporary nginx container with the new conf), fails against the deployed BaseApi
  (404, no hub); Release `--no-incremental` clean. Vitest 991 (85 files; new `liveState.test.ts`,
  `liveClient.test.ts`, `App.live.test.tsx`, Inspector liveness; DocumentPanel and runWorkflow tests rewritten for
  the store); tsc clean. Playwright on the dev server against the local BaseApi: 146 passed + 2 skipped (new
  `live.spec.ts` 2, `live-processor.spec.ts` 1); the production bundle behind the new nginx.conf (temporary container
  proxying to :18090): live, live-processor and run specs 4/4. Mutations: BaseApi 4 (processor diff, unknown
  threshold, monitor rethrow, plus a sequence one), Vitest 12, e2e 4 (no health from the store, no fallback poll, hub
  events ignored, status only while shown); each fails.
- **Deploy steps:** BaseApi image (no migration; new optional config section `Liveness`), then the studio image (the
  bundle *and* nginx.conf ship in it). Either order: an old studio ignores the hub; a new studio against an old
  BaseApi gets a 404 on the socket and stays on the 5 s fallback poll with the "live updates reconnecting" mark.
- **Follow-ups:** backplane before a second BaseApi replica; the monitor reads every processor row each tick (fine at
  today's counts; cache the id list if it grows); bundle grew ~100 kB (signalr); Output's "running"/"stopped" for a
  workflow nobody watches can be noisy if many workflows start at once (no grouping).

**Review of live push (2026-10-10) — BUILT, NOT DEPLOYED.** Fixes for the coordinator's findings 1, 2, 3 and 6
(4 and 5 stay as documented above):
- (1) Each fallback poll loop owns a token (`pollToken`, bumped on start and stop): a loop whose token is stale stops at
  its next step, so a drop while a poll is in flight no longer starts a second loop; and a poll asked before the latest
  hub snapshot (`hubEpoch`) never overwrites it (a second guard; the token alone already drops those answers).
- (2) A snapshot that fails or cannot be read is asked for again with the connection backoff (1, 2, 5 s …) while
  connected; held changes are bounded (`MAX_HELD` 1000: on overflow they are dropped and a fresh snapshot covers them).
- (3) The monitor sends `livenessSequence { sequence }` every 10 s (`Liveness:SequenceEverySeconds`; no number of its
  own): a client whose last applied sequence differs (a lost last broadcast) takes a snapshot.
- (6) Hub `KeepAliveInterval` 15 s, `ClientTimeoutInterval` 3 min; the studio pings every 15 s and gives the server
  60 s (`withKeepAliveInterval` / `withServerTimeout`), so a background tab whose timers Chrome throttles to once a
  minute stays connected. The "live updates reconnecting" mark shows only after 4 s down (`LIVE_MARK_DELAY_MS`), so a
  quick reconnect shows nothing.
- Tests: hermetic 2043 + 71 skipped (+1: a lost last broadcast is revealed by the next sequence message; publisher
  routes it); Release `--no-incremental` clean; Vitest 996 (+5: the flap repro, unreadable snapshot retry, held bound,
  sequence gap, mark debounce with fake timers); tsc clean; against the branch BaseApi on :18090: live test 1/1,
  live/live-processor/run specs 4/4, full Playwright 146 + 2 skips. Mutations: the poll tokens, snapshot retry, held
  bound, sequence check and mark delay each fail a test (the epoch guard alone is masked by the tokens).

**Copy, paste, delete and whole-selection drag (user decisions, 2026-10-10) — BUILT, NOT DEPLOYED.** Commits `433efc7`
(BaseApi + regenerated client), `c181c18` (studio model, keys, Save), `60cf59d` (e2e, Output naming, settle report), and
the docs commit that adds this paragraph. Spec: plan 8 spec §4.5 (new) with notes in §1, §2, §4.2, §4.3; notes in the
plan 9 spec §6, §9 and the plan 4 spec.
- **Studio.** `design/blocks.ts`: `Draft.blocks` (pasted steps and caches with new ids, removed ones, processor/schema
  refs for a paste from another workflow); `applyEdits(base, edits, blocks)` lays them over the base first
  (`applyBlocks`, memoised), so everything downstream treats a pasted step as the workflow's own; undo/redo, the
  session and the stored design carry them. `design/clipboard.ts`: `copyClip` (hub skipped; wires between copied items
  with their junctions; a wire picked alone copied free), `pasteClip` (new ids; offset +32/+32 per paste as a cascade,
  else `freeOffset`: the nearest free spot on the 32 px grid for the group as one rigid unit, rings nearest first, right
  and down first, a 256 px bucket index; obstacles every block plus, in the workflow copied in, the originals' area),
  `deletePicked`. Store actions `copy` / `paste` / `deletePicks`, `StudioState.clipboard` (in the session). Keys on the
  focused canvas only: Ctrl/Cmd+C, Ctrl/Cmd+V, Delete; Backspace does nothing; nothing from input/textarea/select.
  `moveGroup` / `shiftWires`: block drag and nudge shift picked wires' bends, open and held ends. Save sends `newSteps`,
  `newCaches` (+ the workflow's cache list), pasted assignments as creates with `copyOf`, `deletedSteps` (stamps),
  `deletedCaches`; `storedDesignOf` reads them back (positions from the layout); the loader GETs processors of stored
  pasted steps; the Inspector reads a pasted assignment through its original row.
- **BaseApi.** Optional `NewSteps`, `NewCaches`, `DeletedSteps`, `DeletedCaches`, `DesignAssignmentDto.CopyOf`. Creates
  in the caches and steps stages (id taken → "Not created: a step with this id already exists."; processor missing;
  CRUD create rules), new steps' next steps in the wires stage, a pasted step's assignment from its `copyOf` row; a new
  last stage `deletes` (step: stamp, refused while any workflow lists it as an entry step, any step lists it as a next
  step (steps deleted together excepted), or another workflow has an assignment for it; else its assignments of this
  workflow go with it; cache: refused while any workflow lists it). Log: "step 'x' created (copy of 'y')", "cache 'z'
  created (copy of 'c')", "step 'x' deleted[, with its assignment 'a']", "cache 'z' deleted", refusals as error lines,
  "deletes: nothing to do" on every save (output.spec updated). Shape: an id in two of create / change / delete is 400.
- **Judgement calls** (cost if wrong in brackets): the free-space rule avoids the originals' area only in the workflow
  copied in, so a paste into another workflow lands at +32/+32 when free (small: one condition in `pasteClip`); in the
  workflow copied in +32/+32 always lies on the originals, so the group lands beside or below them; unpicked wires
  between copied items come along, a picked wire with one end on a copied item and one outside is left out (small); a
  copied assignment's name/version/description come from its original row in BaseApi (`copyOf`), the studio sends its
  payload and any Inspector edits; deleting a step deletes its assignments of this workflow server-side (the studio sends
  no assignment op for it); a step used by a step of the same workflow that Save does not rewire (a held-back short
  circuit) is refused like an outside use; the `deletes` stage line appears on every Save; pasted processors from
  another workflow are kept only as drawing refs (pruned when their last pasted step is deleted); Inspector edits of a
  pasted step stay outside the undo history, so a pasted step deleted and brought back by Undo keeps them.
- **Tests.** BaseApi hermetic 2056 passed + 73 skipped (+13 `DesignCreateDeleteTests`), Release `--no-incremental`
  clean; live `WorkflowDesignLiveTests` 15/15 against this branch's BaseApi on :18090 (+2: paste + delete applied
  through the real foreign keys; a refused delete rolls the pasted step back). Vitest 1027 (86 files; +28
  `clipboard.test.ts`, +3 keys tests); tsc clean. Playwright on the dev server against the local BaseApi: 152 passed + 2
  skipped (new `copypaste.spec.ts` 6). Mutations: BaseApi 4, Vitest 12 (one survivor: the defensive filter of deleted
  ids out of a held-back source's list in `buildDesignRequest`, only reachable with a short circuit on that source), e2e
  4 (Backspace deleting, no free-space search, wires not moved with the group, deleted step named by id); each other
  fails. Screenshots: scratchpad `copypaste\`.
- **Deploy steps:** BaseApi image (no migration; the request additions are optional), then the studio image. Order:
  BaseApi first — an old BaseApi ignores the new lists (System.Text.Json skips unknown members), so a paste or delete
  saved against it would be "applied" without creating or deleting anything.
- **Follow-ups:** wire-only nudge (no block picked) still does nothing; the pasted assignment's Inspector name shows the
  original's only once its read lands; a paste does not route pasted automatic wires around blocks beyond what the
  router does; large clipboards are kept whole in the session (quota trimming drops Output first, not the clipboard).

**Review of copy/paste/delete (2026-10-10) — BUILT, NOT DEPLOYED.** Findings fixed (plan 8 spec §4.5 "Review rulings"):
pasted caches get a unique root (`uniqueRoot`: `<root>-copy`, `-copy-2`, … against every root the open workflows and the
clipboard hold) and BaseApi refuses a taken root clearly on create and on a root change (the in-memory suite never
showed `uq_cache_root`; the old hermetic tests passed with a duplicate root); deleted steps keep their loaded stamps
(`Blocks.stamps`, stored `deletedSteps[].updatedAt`) through refused saves, reopen and refresh; the clipboard carries an
assignment's own name/version/description/payload (`Assignment.name/version/description` from the graph read);
deletes limited to the workflow's own steps/caches (`DesignOwnership`: entry-reachable, stored layout, stored design's
deletes, cache list); all-zero `copyOf` refused; a create that finds exactly its own row is unchanged (retry after a
lost answer); `DesignRun.CreatedSteps` removed; wires joined on a free picked wire are copied. Tests: hermetic 2060 + 74
skipped (+4), live `WorkflowDesignLiveTests` 16/16 on Postgres via the branch BaseApi (+1: a pasted cache with its own
root, a taken root refused clearly), Release `--no-incremental` clean; Vitest 1032 (+5); copypaste.spec 9 (+3: cache
paste and Save, cut and paste across workflows, a kept delete's stamp conflicting after B's change). Mutations: BaseApi
3, Vitest 1, e2e 3, each fails.
Final review tightening: a create counts as "already created" only when nothing took the row up since: the step has no
incoming next-step link from a step outside this workflow (this workflow's steps and this design's new steps may lead to
it, as the first, committed save wired them) and no other workflow lists it as an entry step; the assignment is linked to
no other workflow. Otherwise "Not created: a different … with this id already exists." (hermetic test, mutation fails it).
Known gap left as is (coordinator's ruling): delete ownership trusts the workflow's own stored layout and stored design,
which a crafted client writes itself, so a crafted client can delete any step or cache no workflow uses; that is no more
than the CRUD DELETE already allows.

**Final whole-branch review fixes** (redeployed BaseApi and studio after them; deployed e2e 58 passed + 2 skips,
live 13/6/5 green):
- `c970732`: Revert and the Inspector's unsaved mark follow any edit entry, so a stale stamp with no changed
  fields (a wiring-only step, the workflow, a field typed back) can be cleared. Reverses the Task 8 ruling that
  stamp-only edits do not matter. Side effect: after a not-applied Save the workflow and wiring-only stored steps
  show "● unsaved changes" with Revert enabled (wording is a UX follow-up). A stored assignment delete with a stale
  stamp can only be cleared via ＋ Create → Revert → Remove (follow-up).
- `0aa4641`: a null element in a design's lists is a 400 naming list and index, not a 500 (nested nulls such as a
  null slot value are not yet guarded: follow-up).

**Tests.**
- BaseApi hermetic: 2017/2017.
- BaseApi live, on the deployed BaseApi: `WorkflowDesignLiveTests` 13/13, `WorkflowGraphLiveTests` 6/6,
  `WorkflowValidationLiveTests` 5/5.
- Vitest: 742 passed.
- Playwright on the dev server: 58 passed, 2 skipped (the expected `art.spec.ts` skips).
- Playwright on the deployed studio (`index-BC19MgmE.js`):
  - save + inspector + designer: 26/26.
  - whole suite: 58 passed, 2 skipped.
  - `session.spec.ts:12 --repeat-each=8`: 8/8.
- `e2e/save.spec.ts` writes only to a throwaway `e2e-8-…` workflow that it creates and deletes through BaseApi's
  CRUD. After every run, BaseApi lists no `e2e-8-…` entities.
- Every other spec fails on any request that is not a GET.

### Rulings made along the way

User:
- Subagent-driven execution.
- The legend loses "broken" (nothing is drawn broken without validate) as well as "parked".
- BaseApi and studio deploys approved.
- The plan's other rulings stand.

Controller (from the ledger):
- **F1:** the `Design` column test asserts `Relational:ColumnType` (InMemory throws on `GetColumnType()`).
- **F2-F5:** plan-mandated test updates to `inspectorTarget.test.ts` and `inspectorView.test.ts`. The DocumentPanel
  "● design draft" assertion was dropped (the App test covers it). The existing `SLOTS` is kept.
- **F6:** the legend test asserts "broken" and "parked" absent and the loose wire present.
- **F7-F9 (DRY):** one shared `portOf(placement, source)`, a `parseSlotKey` next to `slotKey`, and one
  `Describe(DesignOutcomeDto)` in `DesignBody`.
- **F10:** no-throw shape tests use `Assert.Null(Record.Exception(...))`.
- **F11:** this section is here, not in the plan 4 handover.
- **F12:** the dead client writes and the broken-wire plumbing stay (see follow-ups).
- Shared units (processors, caches) carry Postgres `xmin`. On a race they roll back to the savepoint and retry on a
  fresh load up to 3 times, then report "The database refused this change." If this is wrong, a shared save under
  heavy contention fails with a vague message.
- `isEmptyEdits` ignores stamp-only edits (they send nothing and cannot conflict).
- Tasks 11 and 12 were done as one commit and one review (Task 11 alone does not type-check). The Inspector
  coverage the plan dropped was added back.
- `canWire` checks `source === target` ("same step") before the not-a-step checks, so a hub wire or loose end
  dropped back on the hub snaps back.

### Follow-ups (deferred minors worth knowing)

- **F12, dead code:**
  - `putEntity`, `createAssignment` and `deleteAssignment` in `src/api/client.ts` are unused.
  - The broken-wire drawing plumbing is dead (`apply.ts` still copies `brokenEdges` from `saved.wires`).
- Commit `5bc0d63` has a "Claude Sonnet 5.5" co-author trailer instead of "Claude Opus 5.5". The branch is
  unpushed, so this can be fixed before merging, if wanted.
- BaseApi design save:
  - A wrong-typed non-nullable field (`"name": 7`) can give both the applier error and a second "required" error.
  - A JSON `null` element inside an entity list gives a 500 in `DesignShape` instead of a 400.
  - The exhausted-retry message is the same as the one for an unknown database failure.
  - `WireStage` re-validates all step fields, so a step whose stored fields are already invalid fails its wires.
  - Missing tests: a wiring-only step with a stale stamp; the `Apply` of processor and assignment updates; stale
    assignment and workflow stamps.
- Studio:
  - A schema edited back to its original value still makes a copy.
  - `apply.ts` repeats the `{ name, version, description }` spread per kind.
  - `applyEdits` re-routes on any edit.
  - The `body as unknown as DesignSaveRequest` cast in `saveDesign` can hide drift.
  - The close dialog's Save on a restored document that is not ready yet does nothing visible.
  - Sessions written before plan 8 lose their Inspector text on the first refresh after the deploy (one time only).
- e2e:
  - The hub snap-back check relies on a fixed 300 ms wait.
  - The "5 px short" test's loose branch depends on the live data.
- Plan 7 follow-ups (still not built):
  - Re-sourcing a joined wire drops its junction (should it survive?).
  - `canJoin` and routing disagree on ignored contacts.
  - Contacts on a deleted host revive if the id is redrawn.
  - A contact exactly on a host corner.
  - The preview re-routes on every pointer move.

### Open spec gaps (decided in the plan; the user may still override)

1. **A released tail cannot become a loose wire** (a loose wire needs its source). It snaps back with "cannot start
   here".
2. **A stale stamp in a stored design repeats its conflict.** Discard returns to the last saved design, which still
   has the old `updatedAt`, so every Save fails the same way. The user clears it with the Inspector's **Revert** on
   that entity.
3. **Broken-wire marks are gone.** They came from validate; the user ruled the legend item removed. The dead
   plumbing is a follow-up.
4. **"Save enabled when the design differs from the base"** is read as: unsaved edits, or a stored design not yet
   applied.
5. Cosmetic: the spec's decision numbers in §1 run 1-6, 9, 8, 7, and its edge cases in §6 run 1-4, 8, 5-7.

## Open question for the user

- Branch: merge to main / push + PR / keep.

## How we work (user rules, also in memory)

- Ask in prose, not multiple choice; "confirm" means verify against the code and cite it.
- **Every UI change is verified with Playwright using real mouse drags** (dev server and the deployed studio)
  before reporting; the user asked twice.
- A refresh must never lose work (documents, dock, drawing, drafts).
- GSD commands use hyphens (`/gsd-plan-phase`).

## Machine notes

- Run npm scripts from PowerShell (Git Bash `npm run` prints nothing); `npx vitest run`, `npx tsc -b`,
  `npx playwright test` work from `src/WorkflowStudio`; delete `tsconfig.tsbuildinfo` after `tsc -b`.
- Studio deploy: `docker build -f src/WorkflowStudio/Dockerfile -t workflow-studio:local .` →
  `kind load docker-image workflow-studio:local --name desktop` → `kubectl -n skp rollout restart deploy/workflow-studio`.
- E2E against the deployed studio: a temporary Playwright config (not committed) with `use.baseURL:
  'http://localhost:18081'` and no `webServer`. Timing bugs can show only there. To reproduce one without a
  redeploy, `vite build` plus `vite preview` on a free port (it proxies `/api` to 18080).
- The docker Release build compiles non-incrementally, so an analyzer crash (AD0001) that passes a local
  incremental build fails there. Check with `dotnet build -c Release --no-incremental` before deploying BaseApi.
- BaseApi tests: never `dotnet test`. Run the built `BaseApi.Tests.exe` with `--filter-class` (fully qualified).
  Live tests need `$env:SKP_REALSTACK='1'` and the forwards.
- Source files are a mix of CRLF and LF; subagents' text replacements silently missed once, so make them check
  `git diff`. Long bash heredocs with quotes broke several times: write Python edit scripts to the scratchpad
  instead.
- SDD workspaces live under `.superpowers/sdd/<plan>/` (git-ignored).
- Untracked, not ours: `.playwright-mcp/`, `.wf-restore.json`, `tools/simulate-*.py`.
