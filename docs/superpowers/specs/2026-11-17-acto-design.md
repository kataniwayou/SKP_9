# Acto — the board studio (design)

Date: 2026-11-17 · Status: draft for approval · Replaces: `src/WorkflowStudio`

- Main mock (approved look, layout and interactions): https://claude.ai/artifact/GFb1aE4KpEUxL3HdzKe7DL
- Wiring preview: https://claude.ai/artifact/TFD7XYLpE4Ki7XS5Pm7Nxj

Both are private to the owner and are hand-written HTML imitations: they show behaviour, not code. Several behaviours
below were checked in the mock with Playwright (resizing, toolbars, undo, copy/paste, multi-select, wiring).

Marks: **[user]** = decided by the user; **[call]** = my call where the user left it open (check these while reading).

## 1. Intent

WorkflowStudio opens one workflow at a time (Load…, Close, a dockview window layout) and its wiring is complex
(junctions, bends, short circuits). The user wants a **simple** studio where **every workflow is on one board at
once**, in the polished look of the reactflow.dev demos, so moving between workflows is panning or a minimap click.
Acto is that studio and **replaces WorkflowStudio** [user]: same BaseAPI, same workflows, same Kibana diagram.

**Simplicity is the main goal** [user]. Every action is taken from what WorkflowStudio already does ("analyze the
studio first") and gets **one** way to trigger it; nothing repeats what something else already does; no keyboard hints
are shown anywhere [user].

Success: an operator opens Acto, sees every workflow, which run and which have unsaved changes; designs any of them in
place; saves each on its own; Kibana keeps showing a correct diagram per workflow.

## 2. Goals, non-goals, anti-goals

Goals [user]
- One board, all workflows visible; no open/close/load.
- Each workflow is a **frame**, drawn in full, movable and resizable; navigation by panning and the minimap.
- Floating per-block toolbars instead of menus; plain resizable panels instead of dockview.
- Simple wiring: one coloured, arrow-headed wire per link.
- One Kibana SVG per workflow, published on each applied Save.

Non-goals
- No React Flow Pro subscription. No wires between workflows [call]. No real-time multi-user editing (concurrency stays
  the `updatedAt` stamps). No grouping of workflows into areas. No BaseAPI schema migration.

Anti-goals
- A save that writes workflows the user did not save.
- Losing a workflow's steps, positions or links when it first appears in Acto.
- WorkflowStudio breaking while both run side by side.
- A board that is slow or cluttered at the real size: about **50** workflows, no hard limit [user].

## 3. Constraints

- Location `src/Acto` [user]; name chosen over "Reflow" (clashes with React Flow and the browser term).
- Stack as WorkflowStudio: Vite, React 19, TypeScript, `@xyflow/react` 12.12, `@microsoft/signalr`, ajv; Vitest +
  Testing Library; Playwright e2e. **No** `dockview-react`, **no** elkjs routing of wires (7). React Flow 13 is out;
  upgrading is a separate decision [call].
- Served like WorkflowStudio: nginx same-origin with BaseAPI (`/api/`, `/api/hubs/` WebSocket, `/ai/*` chat proxy,
  `/healthz`), offline npm install, kind-loaded image, new manifest `k8s/3x-acto.yaml` [call].
- BaseAPI contracts used as they are (section 9). `Layout` is JSON ≤ 1 MB that the server does not interpret, except
  that it reads its `steps` and `parked` keys to know which steps the workflow owns (section 7).

## 4. The screen

```
┌─────────┬────────────────────────────────────┬─────────────┐
│ Toolbox │ Board (all workflow frames)        │ Inspector   │
│         │                         [minimap]  │ (follows    │
│         ├─────────────────┬──────────────────┤  selection) │
│         │ Output          │ Chat             │             │
└─────────┴─────────────────┴──────────────────┴─────────────┘
```

- Fills the window. Four splitters (toolbox|board, board|inspector, board/bottom, output|chat): drag to resize,
  double-click to reset; sizes kept per browser [user; persistence is a call]. Narrow screens stack (not a target).
- No menu bar. Board controls: zoom +/−/fit and the minimap.
- Look [user, from the mock]: dotted paper board; white rounded step cards with soft shadows and a coloured processor
  icon; dark floating toolbars; pink accent for selection. Light and dark page themes like WorkflowStudio [user: "all
  fine"].
- Reopening Acto returns to the same view and selection (per browser) [user: "all fine"].
- As WorkflowStudio [call, from the review]: a design BaseAPI has stored (a save that failed, from either studio) loads
  as that workflow's **unsaved** work; unsaved drafts and their undo histories survive a page refresh (WorkflowStudio's
  rule, 2026-10-20), kept per browser tab for the workflows that have them.

## 5. The board and its frames

- Each workflow is a React Flow parent node; its steps and caches are child nodes (`parentId`, `extent: 'parent'`).
- **Frame header**: name, version, cron, an orange **unsaved** tag, and the state badge — **Running** (green, pulsing
  dot) or **Stopped** (red), amber "Checking…" while unknown [call for amber] — with a matching stripe. **No buttons
  on the header** [user].
- The **whole frame body** is the drag handle [user]. Right edge, bottom edge and corner resize it; it never shrinks
  smaller than its content [user].
- **Placement**: a workflow with no board position goes into the first free slot of a left-to-right, top-to-bottom
  flow, ordered by creation time; written only when that workflow is saved [call].
- **Loading**: `GET /workflows`, then each `GET /workflows/{id}/graph` (plus parked-step reads, as today) with a small
  concurrency cap; frames appear as graphs arrive. Fine at ~50 workflows [user].
- **At every zoom** a frame draws its steps, wires and handles; there is no zoomed-out summary form [user, 2026-11-17].
- **Minimap**: frames outlined green (running) / red (stopped), selection in the accent colour, names shown; click to
  jump. **Fit** fits all frames.
- **New workflow**: drag **Workflow** from the toolbox onto empty board (not inside another frame). It starts as
  `new-workflow-N`, version v1, not scheduled, unsaved, and may be saved while empty [user: "all fine"].
- **Caches**: shown as chips along the bottom of the frame. Drag a cache from the toolbox's Caches section into a
  frame to link it. **Create › Cache** is also dragged into a frame: it creates the cache and links it in one move,
  written by that workflow's Save (BaseAPI creates caches only through a workflow's design) [call, from the review]. A cache's toolbar **Delete** unlinks it; caches are shared
  and never destroyed from here [user: "all fine"].

## 6. Toolbars and keys

One dark toolbar above the selected thing, with a **little arrow** pointing down at it (React Flow `NodeToolbar`; for a
wire, `EdgeLabelRenderer`); the same size at any zoom [user].

| Selected | Toolbar |
|---|---|
| Workflow | **▶ Start** (green) or **■ Stop** (red), whichever applies · **Save** (highlighted when unsaved) · **Delete** |
| Step | **Copy** · **Delete** |
| Wire | **Delete** |
| Cache | **Delete** (unlink) |

[user for all rows]

- **Save** saves that workflow only; there is no global Save.
- **Delete** on a workflow runs BaseAPI's delete dry run and shows its counts in the toolbar ("5 steps, 3 assignments
  go. Delete X?" — the dry run reports steps, assignments, caches and processors, not wires) before deleting; refusals
  (running, shared) go to Output.
- **Delete** on a step or wire is the toolbar button only; the Delete key does nothing. Afterwards the workflow is
  selected [call].
- **Copy** takes the step(s) and every wire between copied steps. **Paste is the paste key only** (Ctrl+V): it goes
  into the selected workflow (or the workflow of the selected step/wire), next to the selected step if any, keeps the
  copied layout and wires, leaves the pasted steps picked, and marks that workflow unsaved; ignored while typing in a
  field; with nothing selected, Output says to select a workflow. Pasting into another workflow is allowed.
- Not offered, because something else does it [user]: Edit / Assign (the Inspector), Swap (drop a Steps item on the
  step), Focus (minimap), Discard / Revert (Undo), Reset route (no hand shapes), AutoConnect arrows (drag from the
  toolbox) [user: "all fine"].
- Keys that work, never shown: Ctrl+V, Ctrl+Z / Ctrl+Y, arrow-key nudges, Esc to cancel a drag. Dropped from
  WorkflowStudio: Delete key, F5 / Shift+F5, Ctrl+N / Ctrl+O, Alt+W, Ctrl+E.

### 6a. Selecting several things [user; verified in the mock]

Plain click picks one; **Ctrl+click adds or removes** (as WorkflowStudio's `togglePick`). Picks may span workflows.
Several picks look different from one [user]: no toolbar with an arrow; instead a **selection bar pinned to the top
centre of the board** (light, accent border, a pink "n SELECTED" pill first) that stays put while panning, and a pink
**numbered badge** (pick order) on every picked frame, step and wire. The bar shows only actions every picked kind has:

| Picks | Toolbar |
|---|---|
| Steps and/or wires (any workflows) | **Copy** (steps + wires between them) · **Delete** |
| Workflows | **▶ Start n** (the stopped ones) · **■ Stop n** (the running ones) · **Save n** (the unsaved ones) · **Delete** (one dry run per workflow, one confirm with the summed counts) |
| Workflows mixed with steps/wires | no action ("no action in common") [call] |

- One action gives **one undo step per workflow it touched**.
- The Inspector lists the picks; Undo/Redo act on the workflow of the last thing clicked.
- Dragging one of several picked steps keeps the picks. No rubber-band selection: dragging empty board pans [call].

## 7. Wiring: one wire per link [user]

What BaseAPI stores: each step's `nextStepIds`, the workflow's `entryStepIds`, one entry condition per step. All of
WorkflowStudio's wiring complexity is drawing only. Acto draws the data:

1. **One wire = one link**: A→B means B ∈ A.`nextStepIds`.
2. **No Start circle**; the frame holds the workflow [user]. Each step is shown as one of:
   - **first** — no incoming wire, at least one outgoing → in `entryStepIds`;
   - **parked** — no wires at all → stays in the frame but does **not** take part; faded with a dashed border [user];
   - reached — has an incoming wire.
   - Exception: the **only step of a workflow** runs as its first step, wired or not [user].
   Tags (FIRST / PARKED) follow the wiring live.
3. **Colour and letter = the target step's entry condition**, WorkflowStudio's five: C Completed teal, F Failed red,
   X Cancelled amber, A Always purple, N Never pink. Every wire into a step has the same colour.
4. **Arrowhead** at the target in the wire's colour, with the letter in a small pill just before it [user].
5. The colour is changed in **one place**: the target step's entry condition in the Inspector; all its incoming wires
   recolour. Short circuits cannot exist.
6. **Drawing**: drag from a step's right-side handle onto a step of the same workflow. Refused with a line in Output:
   empty board ("A wire must end on a step"), to itself, duplicate A→B.
7. **Smooth curves** [user]; out of the right side, into the left side; no routing around other steps (a wire may pass
   over a step).
8. **Landing: spread and sorted** [call]: several wires on one side get evenly spaced spots ordered by the other ends'
   vertical positions, so fan-in/fan-out wires don't cross; one wire uses the middle.
9. Moving dashes while the workflow runs; solid when stopped.
10. Invalid wired steps are not judged by the drawing. BaseAPI's design save does not validate (its dry run runs only
    field rules; cycles, schema edges, payloads and liveness are start checks). So [user accepted]: **Save always
    saves**, then calls `POST /workflows/{id}/validate` and reports any problems in Output with a **warning mark on
    the frame header** until they are fixed; **Start** keeps refusing an invalid workflow with the gate's reason, as
    today.

**Gone from WorkflowStudio**: junctions, nets, short circuits, open and direction-less wires, hand bends, Reset route,
the toolbox Wire tile, the hub/sphere, the "Problems" list of wiring faults.

**Existing first steps** [user accepted]: WorkflowStudio stores `entryStepIds` separately (the wires from its
sphere), so an old workflow's stored first steps can differ from what Acto derives from the wires (an entry step that
also has an incoming wire; an entry step with no wires in a multi-step workflow; a wired chain not tied to the sphere).
When Acto loads such a workflow it **marks the frame** and **lists the differences in Output** ("on Save: X stops being
a first step; Y starts running"). Nothing changes until that workflow is saved; Save then writes the derived first
steps.

**Old layouts**: step and cache positions are read as before; the stored `wires` circuit and the sphere are ignored.
The layout's `parked` list is **not** "the unwired steps": WorkflowStudio writes every step on its canvas there, and
BaseAPI reads `parked` and `steps` to decide which steps a workflow owns (and so may delete). Acto therefore writes
**every step in the frame** into `steps` and `parked`, as WorkflowStudio does; "parked" as a status is derived from the
wires only [call, from the review]. **On save** Acto writes `wires` as plain step-to-step wires plus sphere-to-first-step
wires, and keeps a `sphere` position (the old one, or a default left of the first steps), so WorkflowStudio still draws
Acto-saved workflows during the side-by-side period [call].

## 8. Model rules that need care

### 8a. One way back: Undo/Redo for everything [user]

WorkflowStudio has Undo/Redo for drawing and a separate Inspector **Revert** for field edits (a rename cannot be
undone, a move cannot be reverted). Acto has one rule:
- **One history per workflow** covering everything in it: steps, wires, caches, positions, frame move/resize,
  assignment create/remove, and **every Inspector field** (workflow, step, processor, schema slot, payload, cache).
  Typing in one field is one undo step (the history's `merge`, as for nudges today). Depth 100.
- **No Revert.** Undoing back to the last save clears the unsaved tag.
- **Undo · Redo in the Inspector header**, next to the name of the workflow they act on (the one holding the
  selection); greyed when empty. Ctrl+Z / Ctrl+Y do the same.

### 8b. Shared steps, processors, caches and schemas [user: "possible … no collision"; rule confirmed]

In BaseAPI a step belongs to no workflow: a workflow holds what its first steps reach, and next-step links are stored
**on the step** (`StepNextSteps`). A shared step is one entity, fields and outgoing wires alike.
- It appears in every frame that reaches it, tagged **shared · n**; the Inspector lists those workflows.
- **No collision** — for **every shared entity**: steps, **processors** (fields and schema slots), **caches** and
  **schemas** [user accepted; BaseAPI saves processors and caches last-write-wins]. Unsaved changes to a shared entity
  may exist in **one** workflow at a time; everywhere else it is read-only, shows the pending change and says "being
  changed in A", until A saves (all frames re-read it) or undoes.
- Before the first wiring change out of a shared step, Output names the workflows that will gain or lose steps.
  After A saves, a step newly reached in workflow B appears in B's frame next to its source, auto-placed, and is
  written into B's layout on B's next save [call].
- Deleting a shared step in one frame removes only what reaches it **in that workflow**: the wire from a non-shared
  source, or its place in `entryStepIds` if it is a first step there. If the only way to drop it from this workflow
  would change another workflow too, Acto refuses and says why [call].
- When A saves, other frames re-read only the shared entities A changed; their own unsaved work is kept, with the new
  stamps [call].

### 8c. Moving steps

A step cannot leave its frame (`extent: 'parent'`); moving it to another workflow is copy + paste [call].

## 9. Saving, layout, Kibana

**Save one workflow** (server flow unchanged):
1. `PUT /workflows/{id}/design` with that workflow's diff and layout.
2. If applied: run `POST /workflows/{id}/validate` and report problems (section 7, rule 10); render that workflow's diagram SVG in **Acto's look** on white, no live state, legend below [user: "all
   fine"], and `PUT /workflows/{id}/diagram`; Kibana reads `GET /workflows/{id}.svg`.
3. Errors and the save log go to Output; on failure the unsaved tag stays.

**Layout JSON** stays `v: 2` plus one optional field [call]:

```jsonc
{ "v": 2, "sphere": …, "steps": …, "caches": …, "parked": …, "wires": …, "linked": …, "refs": …,
  "board": { "x": 1200, "y": 480, "w": 960, "h": 420 } }   // the frame on the Acto board
```

Positions stay "inside this workflow", measured from the frame's content origin. No BaseAPI change.

**WorkflowStudio must keep `board`** [call]: its `layoutOf` rebuilds the layout on every save and would drop the frame
position and size. A small change in WorkflowStudio carries `board` through unchanged; it is the first task of the
plan.

## 10. Running state and processor health

- SignalR hub `/api/hubs/liveness` as WorkflowStudio: `Snapshot()` on connect; pushed `workflowLive`,
  `processorLiveness`, `monitorStatus` (re-take the snapshot when the monitor becomes known), `livenessSequence`;
  WebSockets only, auto-reconnect forever; poll `GET /orchestration/live` and `GET /processors/liveness` every 5 s
  only while disconnected [user: "in studio there is signalR on processor liveness"].
- **Workflow state** → the frame header badge, the minimap outline, and the moving dashes on its wires.
- **Processor health** (`live`, `healthy` of `replicas`, `reason`) is shown in three places:
  - on each **step card**: a dot — green healthy, red unhealthy, grey undetermined;
  - on each **Steps item in the toolbox**: the same dot plus WorkflowStudio's line, e.g. "live · 2 of 2 replicas
    healthy" or "not live · no healthy replica (1 checked: 1 stale)";
  - in the **Inspector** for a step, the same line.
- Start → `POST /orchestration/start`, Stop → `POST /orchestration/stop`. A 422 refusal names its gate (cycles, schema
  edges, payloads, processor liveness) in Output. Start runs the saved version; with unsaved changes Output says so
  [call].

## 11. Panels

- **Toolbox**: **Create** (Workflow, Cache), **Steps** (one item per processor, with icon and live health; dragging one
  into a frame creates the step *with* that processor — there is no empty step [user]; dropping one on an existing step
  swaps its processor [call]), **Caches** (existing ones, drag to link). No Schemas section [user: "all fine"]. Re-read
  after each Save.
- **Inspector**: follows the selection; nothing selected → board summary (workflows, running, unsaved). Header: Undo ·
  Redo. Editors ported from WorkflowStudio: workflow (name, version, description, cron, plus position/size read-out);
  step (name, version, entry condition — labelled "colours every wire into this step" — processor with its health line
  and schema slots, assignment payload as JSON with schema validation and "Remove assignment"); cache (root, items);
  wire (from, to, "runs when"). Typing changes the draft at once. No Revert.
- **Output**: save logs, start/stop transitions, refusals, errors. Header: **Clear all**, and **Newest last / Newest
  first** (remembered per browser; *Newest last* always scrolls to the end on a new message) [user].
- **Chat**: WorkflowStudio's pane and Kimi proxy; header **New chat**, plus **Stop** while answering. Tools follow
  Acto's rules: removed `open_workflow`, `close_workflow`, `activate` (every tool takes a workflow id; the board scrolls
  to what the chat changes) and `revert_entity`; `add_step` must name a processor; `undo`/`redo` cover field edits;
  `new_workflow` places a frame on free board; drawing tools for junctions, bends and wire shapes are removed; the rest
  stays. Chat and user share each workflow's history [user].

## 12. Code reuse [call]

Copied into `src/Acto` with their tests: `model/` (graph, reachability, assignments, entry conditions), the API client
and generated types, the live client and state, the Inspector editors, the chat pane and its non-drawing tools. The
draft/apply and history are adapted from links instead of a circuit. **Not** copied: `circuit/`, the routing and
junction parts of `layout/` and `design/`, `dock/`. WorkflowStudio is retired afterwards, so no shared package.

## 13. Transition

1. Change WorkflowStudio to carry `board` through its saves (9).
2. Run both side by side. Entity fields are guarded by `updatedAt` stamps, but **the layout is last-write-wins**:
   `PUT /design` stores the layout (and the stored design) first, with no stamp check, even when the save then fails.
   So moving or resizing in both studios at once can lose one side's positions. Mitigation: Acto re-reads a workflow's
   graph just before saving it and warns in Output if its layout changed since load; the team avoids editing the same
   workflow in both studios during the transition [call, from the review].
3. When Acto covers the same work, remove WorkflowStudio's manifest and archive its folder on a tag (as done for the
   FilePersister SMB code) [call].

## 14. Testing

- Unit: the copied modules' tests; new tests for first/parked/lone-step rules, wire colour from the target, landing
  order, layout `board` round-trip (and a v2 layout without it), per-workflow save isolation, one-history-per-workflow
  undo (fields included), multi-select toolbars, shared-step lock, splitters.
- Playwright e2e against the live BaseAPI: the board loads all workflows; create a workflow from the toolbox and save
  it; move/resize a frame and reload; Start/Stop from the toolbar; the Kibana SVG is published; a layout saved by Acto
  still opens in WorkflowStudio.

## 15. Left to the builder

Component and state structure, the exact card and frame art within the mock's look, the splitter implementation, the
free-slot algorithm, the loading concurrency cap, the order of porting the Inspector editors and chat tools.
