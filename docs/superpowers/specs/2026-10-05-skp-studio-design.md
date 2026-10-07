# SKP Studio -- design

Date: 2026-10-05. Status: approved. §5 amended the same day (connector editing, lit grid, grid sizes) and approved. Amended again the same day from the user's mockup review (v49, approved): the grid's bright 32 px dashes removed (§5.1), toolbox create and remove (§4.3), Inspector shortening and entity details (§7). Amended again the same day: start rules are no longer duplicated in the frontend; BaseApi gains a dry-run validate, a live-workflow list and a processor-liveness read (§3.1, §3.2, §4.4, §6.1, §7, §9, §10, §11). Amended 2026-10-06: the Inspector shows the unique entity name and the picker uses it (§7); slices reordered to dock (3a) and Inspector editing (3b) before canvas editing (§10); the Inspector edits each entity's DTO metadata with GET/PUT, shared entities are the operator's responsibility, Start/Stop stay disabled (§6.1, §7.1, §8, §9). Amended 2026-10-06 again: locked node art (gallery + v50), cache 160 × 160, live health and started states, slice 3c (§5.1, §10). Branch: `feature/path-importer`.

## 1. Purpose

SKP Studio is a web UI for **building workflows visually** on a blueprint canvas: placing steps,
wiring them, assigning processor configuration, editing processor schemas and caches, and starting
or stopping a workflow. It talks **only to BaseApi over REST**.

Success means an operator can open any existing workflow, see its graph laid out exactly as it was
last saved, change it, and save it in one atomic request -- without the editor ever refusing a
design, and with every rule the orchestrator enforces at start shown as a warning beforehand.

The reference implementation of the visual system and the dock is the brainstorm mockup
(`.superpowers/brainstorm/385-1791189446/content/skp-studio-dock-v49.html`, gitignored; source and
`build.py` in `../source/`). Where this spec and the mockup disagree, this spec wins.

## 2. Data model facts the design rests on

Each was verified against the code.

- **Steps belong to no workflow.** A workflow names only its entry steps. Its step set is whatever is
  reachable through `StepNextSteps`, and the same step can be shared by several workflows.
- **A wire is a `StepNextSteps` row on the source step.** Its colour is the **target step's entry
  condition**: 1 Completed, 2 Failed, 3 Cancelled, 4 Always, 5 Never. 0 is rejected by the
  validators. On an entry wire only `Never` (the per-entry freeze) means anything.
- **Fan-in has no join.** The target runs once per matching predecessor
  (`Orchestrator/Dispatch/StepAdvancement.cs`).
- **Compatibility is `SchemaEdgeValidator`'s rule:** the parent processor's `OutputSchemaId` must equal
  the child's `InputSchemaId`, compared **by id**. A null on either side passes.
- **An assignment applies to one (workflow, step) pair.** `Assignment.StepId` names the step and
  `WorkflowAssignments` names the workflow. At start the orchestrator takes the first assignment per
  step, so the UI allows at most one. The payload is validated against the processor's config schema
  at start only.
- **A schema's `Definition` is frozen** once any processor references it (409,
  `SchemaService.UpdateAsync`).
- **Deleting is governed by the database.** Of the 13 FKs, 10 are `RESTRICT` (a delete returns 422 with
  SQLSTATE 23001); 3 are `CASCADE`, all on the workflow side of the link tables.
- **Workflow create/update requires at least one entry step.**
- **BaseApi has no CORS policy**, so the UI must be served same-origin.

## 3. Architecture and boundaries

### 3.1 Frontend: `src/WorkflowStudio`

Vite + React + TypeScript, **React Flow** for the canvas and **elkjs** for first-time layout.
Served by **nginx**, which proxies `/api/*` to BaseApi (same origin, no CORS change). API types are
generated from BaseApi's Swagger with `openapi-typescript`.

| Unit | Does | Depends on |
|---|---|---|
| `api/` | Typed REST client; maps HTTP errors (409, 422) to typed results | generated types |
| `model/` | Pure graph logic for drawing: reachability, parked blocks, entry-condition presentation, choosing the one assignment per step. **No start rule is re-implemented:** problems come from BaseApi's dry-run validate (§4.4) | nothing (no React) |
| `layout/` | elkjs placement for blocks with no stored position; wire routing (straight / Z / U), landing bands, fan-out spacing, junctions | `model/` |
| `canvas/` | React Flow nodes and edges drawn in the section 5 visual system; selection, drag, snap, pan, zoom | `model/`, `layout/`, `store/` |
| `panels/` | Inspector editors, Toolbox, Problems, Output | `model/`, `store/`, `api/` |
| `dock/` | dockview-core shell, menus, auto-hide rails, window-position menu, layout persistence | dockview-core |
| `store/` | Per-document draft, dirty state, undo/redo, the save request builder | `model/`, `api/` |

`model/` and `layout/` hold no React and no I/O, so they are unit-testable on their own.

### 3.2 Backend additions (BaseApi)

- **`PUT /workflows/{id}/graph`** -- atomic graph save (section 4).
- **A nullable jsonb `Layout` column** on `WorkflowEntity`, with **`GET` / `PUT /workflows/{id}/layout`**,
  and one EF migration.
- **No validator changes.** The graph save reuses the existing validators and junction sync.
- **`POST /workflows/{id}/validate`, `GET /orchestration/live`, `GET /processors/liveness`** (§4.4). The
  browser never reaches Redis or Postgres: BaseApi is its only coupling, and nginx only passes `/api/` through.

## 4. Graph-save contract

### 4.1 Request

`PUT /workflows/{id}/graph` **creates or replaces** the workflow in one transaction. The client
generates ids for a new workflow and new steps. The body carries:

- the workflow fields with `updatedAt`, `entryStepIds`, `cacheIds`;
- **only the new or changed steps**, each with `updatedAt`;
- assignment intents: `stepId` + payload, or `stepId` + null to remove;
- processor schema edits (slot + new definition, or null to clear the slot);
- the layout.

### 4.2 Server order

1. Run the **existing validators and junction sync** (no duplicated rules).
2. Concurrency: **409** if the workflow or any changed step has a newer `updatedAt`.
3. Apply schema edits: insert a new schema row, then re-point the processor slot.
4. Write steps in two passes: rows, then wires.
5. Resolve assignments:
   - only this workflow uses the row → update in place;
   - the row is shared → copy it and re-link this workflow to the copy;
   - absent → create;
   - null intent → unlink, then delete the row if it is now orphaned.
6. Write `Layout`, then commit once. An FK violation returns **422** and rolls back the whole save.

The response is the graph re-read through `WorkflowGraphLoader`.

### 4.3 Rules

- **The editor never blocks a design.** Cycles, broken wires, invalid payloads and liveness are start
  checks, shown as warnings; saving still works. The only save precondition is an entry step, which
  the backend already enforces.
- **`Layout` holds positions only, never graph facts:** the workflow sphere, steps, caches, **parked**
  blocks (placed but unwired, never part of the workflow) and junctions. On load the tables decide
  what exists; stale ids in `Layout` are ignored.
- **Shared steps:** rewiring one warns and lists the other workflows that reach it.
- **Processor schema edits** create a new schema version and re-point the slot. Each workflow re-checks
  its own wires when loaded. Running replicas keep the old schema until they restart.
- **Two levels of delete.**
  - *From the graph:* unlink only. Removing a mid-chain step offers "Reconnect A→C?".
  - *From the toolbox:* a plain `DELETE`, decided by the Postgres restrict FKs. A 422 is shown together
    with who still references the entity. Each toolbox item has a ✕ for this.
- **Creating from the toolbox.** The Steps, Processors and Caches tabs each have **+ New**, which opens a
  small form:
  - *Step:* name, version, and its processor, picked from a dropdown that names every processor with
    BaseApi's entity-name convention (`Messaging.Contracts.EntityNames.Format`):
    `{name}_{version}-{last two groups of the id}`, e.g. `kafka-importer_2.2.0-ad95-fca1af2631b2`. Name
    and version alone are not unique (no constraint); the suffix is. The new step lands **parked**.
  - *Processor:* name, version, source hash. Its schemas are set afterwards in the Processor inspector.
  - *Cache:* name, version, root. It is created **unlinked**; dragging it onto the workflow links it.

### 4.4 Validation and status reads

- **`POST /workflows/{id}/validate`** runs **every** workflow-start gate (cycle and missing step, schema
  edge, payload against config schema, processor liveness) and returns **all** problems, each as
  `{ gate, title, detail, offending }`, the same description a start's 422 gives. The body is an optional
  draft in the shape of `PUT /graph`; without one the stored workflow is checked. It never saves and never
  starts: the draft is applied by the real graph saver inside a transaction that is always rolled back.
  Gate problems are a 200 with `valid: false`; a draft the save would reject keeps the save's status.
- The gates gain a collect mode beside their throw-first mode, so there is **one implementation of each
  rule** and the start path is unchanged.
- **`GET /orchestration/live`** lists the running workflow ids (the `skp:live` set). Start and stop are
  queued (202), so the studio polls it and shows "starting…" / "stopping…" until the set catches up.
- **`GET /processors/liveness`** reports each processor: live, and its replicas classified (healthy,
  absent, unhealthy, stale, malformed), judged exactly as the start gate judges.
- A Redis fault on any of them is a 500, never a "not live" answer.

## 5. Visual system

### 5.1 Theme and blocks

- **Theme:** dark blueprint, IBM Plex Sans / Mono.
- **Grid (the lit mesh):** soft, fine dashed **neutral grey** lines every **8 px** (one snap step), a
  barely visible solid line every **32 px** (a cell), and a small lit dot where 32 px lines cross. There is
  no bright dashed 32 px line (removed in the v49 review). Thin, so it stays behind the wires. Below 60 %
  zoom the 8 px tier drops out (Visio's variable grid), leaving the dots. The canvas origin is a whole
  cell, so block coordinates and drawn lines coincide.
- **Everything sits on the grid.** Blocks snap to 8 px. A step is **224 × 160 = 7 × 5 cells**; its
  processor middle is **96** (3 cells down), so ports and arrows run along a 32 px line. Ports are
  **16 px** apart, so even fan-outs (±8, ±24 …) land on 8 px lines. The hub's radius is 96, a cache is
  **160 × 160** (placed at hub x − 80, caches stacked 192 apart), columns are 288 apart. Wire bends,
  landings, the junction bus and contact points snap to 8 px.

**Node art (locked 2026-10-06; supersedes the v49 block drawings below).** The reference is
`.superpowers/brainstorm/385-1791189446/content/skp-studio-node-art-final.html` (the locked gallery)
and mockup **v50** (`skp-studio-dock-v50.html`), which puts it in the dock. Where they differ, **the
gallery wins**. v50's dock chrome is identical to v49's. Built in slice **3c** (§10).

- **Step:** a notched HUD frame (chamfered corners, notched top and bottom, side ticks) with the title
  cap (name, `STEP vX`, entry-condition pill, assignment keys) and the processor panel inside (die with
  its ring, name and version, in / out / cfg slots).
- **Processor health colours only the die and its ring:** **healthy** green, the orbit spinning;
  **unhealthy** red and still; **undetermined** grey and blinking slowly. Data: `GET
  /processors/liveness` (§4.4), polled with the document's live status (every 5 s, visible tab only);
  `live` → healthy, not live → unhealthy, no answer (poll failed, processor absent) → undetermined.
- **Workflow:** a hub dial with equal docking points all round. **Started** (its id is in `GET
  /orchestration/live`): the inside green, the segment ring turning. **Not started**: the inside grey,
  still and blinking slowly. The two outer rings are static and white. A failed live poll shows not
  started's look plus the capsule's *status unknown*.
- **Cache:** a square in the step border style: a hex mark, the name, `CACHE · vX`, and the root on a
  plate. Static.
- **Lines:** circuit traces with right-angle bends; an **open chevron head** where a line lands on a
  processor; colour is the target's entry condition. **Flowing** (workflow started, wire not broken):
  pulses run toward the target; otherwise still. **Broken:** dashed with a warning gap (the gallery's
  dash). A junction is a square via in the colour of the lines it merges.
- **Reduced motion:** no pulses, no spinning, no blinking; full opacity.
- **The mockup's "Colours" scheme switch is a comparison tool and does not ship;** the product keeps
  the "Current" colours (§5.3). The legend's icons match the canvas.

The original v49 drawings, kept for history:

- **Workflow:** a **lit sphere** (gradient depth, specular highlight, rim light, contact shadow) showing
  only "WORKFLOW" and its name. No orbit ring, version or cron. It starts centred and can be moved.
- **Step:** a **sphere-glass cap** block. A glossy blue title cap holds the name, `STEP vX`, the
  entry-condition letter pill and the assignment keys, over a dark body. The **processor is drawn
  inside as a die on a substrate**: glossy die, SMD parts, and edge contacts with bond traces wherever
  wires land.
- **Cache:** the same glass cap, with a stack of lit discs.

### 5.2 Wires and junctions

- **Lit cables** (shadow, halo, line, specular core), straight or right-angled only.
- **Straight wherever possible:** a wire may land anywhere within the target processor's band. **A wire
  that must bend lands at the processor's middle.** Every port is anchored on the **processor middle**
  (`PMID = 96`), not the step's middle. Arrows into one step keep 16 px apart.
- **Fan-out** leaves as an evenly spaced group centred on the source processor's middle.
- **Junctions** (drawing only, stored in `Layout`): **only an arrow touches a processor; only a contact
  point touches a line.** A step with ≥ 4 incoming wires gets a junction: each wire is a **line** ending
  on a horizontal **bus** at its own contact point, and one **trunk** leaves the bus at the **junction node**
  (⊕) and lands on the step as the single arrow. A junction merges only wires into the same step, so they
  share its colour.
- **A junction is positioned state, like a block.** Its node position (the bus height and the trunk's
  lane) is seeded once and stored in `Layout`; it never follows blocks. Moving a source step stretches
  **only that step's own line, up to its contact point**; the bus, the trunk and the other lines stay.

### 5.3 Colours

- **Entry conditions:** Completed teal, Failed coral, Cancelled amber, Always violet, Never pink
  `#F472B6`. Each also has a letter pill.
- **Neutral in the legend:** junction (a plus with a centre circle), broken (dashed with a ⚠ gap),
  parked (dashed block outline).
- **On the canvas** a junction and a broken wire take the forward step's colour. A broken wire is
  dashed, with a "!" marker.

### 5.4 Interaction (Visio-like)

- **Automatic routes** stay glued and reroute live as blocks move; the router picks the cheapest of
  straight, Z and U shapes. **Manual routes** (shaped by hand) keep their shape; only their end segments
  follow their ends (Visio's "reroute as needed").
- **Alignment guides** (Visio's dynamic grid): while a block is dragged, a solid white line with a halo
  appears when its edge, centre or processor middle lines up with another block's, and the block snaps
  onto it from up to one grid step away. Guides never pull a block off the grid.
- Multi-select by Shift/Ctrl+click or rubber band. Snap to 8 px. Arrow keys nudge.
- Space+drag or the middle button pans. Ctrl+wheel zooms at the pointer. Scrollbars appear only when
  needed.
- **Long labels are shortened with a tooltip**, measured with the real fonts.

### 5.5 Connector editing (Visio-like)

Each rule is marked *Visio* (Visio's documented behaviour) or *ours* (a deliberate adaptation).

- **Parts.** A plain wire runs from its source to its arrow head. With a junction there are three kinds of
  part: each **line** (source → its contact point), the **trunk** (the bus plus the arrow into the step),
  and the **junction node**. *Ours*: Visio has no built-in merge; its users drop a junction shape.
- **One click selects one whole part** (*Visio*). Shift/Ctrl+click adds; a rubber band selects a wire only
  when it lies wholly inside (*Visio*). The selected part is drawn on top, so where wires cross its handles
  win the pointer (*ours*).
- **Handles** (*Visio*): a green dot on each glued end, a square handle at the middle of each segment, a
  small diamond on each bend.
- **Segment drag** (*Visio*): a segment moves square to itself and its neighbours stretch; lining it up
  with a parallel segment removes the bend between them. The first segment leaves a fixed port, so
  dragging it inserts a jog first. The **last** segment of an arrow slides the landing within the
  processor band; of a line, slides its contact point along the bus (*ours*). Dragging the **bus** moves
  the junction up or down; dragging the trunk's first leg moves it sideways (*ours*).
- **Dragging the line body** behaves as a segment drag and **never detaches** the wire (*ours*: Visio
  detaches, which here would silently rewire the workflow).
- **End drag** (*Visio*): drop the arrow head (or a line's contact point) on another step to rewire the
  wire to it; drop the start dot on another step or the sphere to re-source it. The target outlines green
  when allowed, red when not (self-loop, duplicate). Dropped anywhere else it **snaps back** (*ours*: the
  data cannot hold a loose end). Dragging the trunk's arrow head moves every merged wire. Rewiring changes
  the graph, so the wire takes the new target's colour.
- **Junction node drag** moves the bus and the trunk together.
- **Right-click → Reset route** makes a manual route automatic again (*Visio's* Reset Connector).
- **Delete** removes the selected wire (unlink, §4.3). On a junction, Delete or "remove junction" draws
  its wires as separate arrows.
- **Double-click does nothing on a wire**: our wires carry no text, so Visio's connector label is not
  adopted.
- **What `Layout` stores for a wire** (positions only): its interior bend points when manual, a landing
  offset (relative to the target step) when dragged, a contact x on the bus; per junction its node
  position; and the set of targets whose junction the operator removed. The server treats all of it as
  opaque, so plan 1 needs no change.

## 6. Chrome and dock

### 6.1 Shell

- A menu strip: **File · Edit · View · Window**. There is **no Run menu**; ▶ Start and ■ Stop are on
  each document's toolbar, and F5 / Shift+F5 still work.
- A **Visual Studio-style dock on dockview-core 8.4** (MIT). Workflows are **document tabs**, opened
  from a searchable dropdown. Closing an unsaved one asks **Save / Discard / Cancel**.
- **Shared tool panes:** Inspector, Toolbox, Problems, Output.
- Each document has a capsule toolbar: name, cron, status, Save / Start / Stop, its own zoom and Fit.
  The status comes from `GET /orchestration/live` (§4.4), polled every 5 s while the tab is visible;
  a failed poll shows *status unknown*. **Start and Stop stay disabled** ("Not available yet") until a
  later slice enables them (user decision, 2026-10-06): the studio writes nothing to orchestration yet.
- Clicking anything fills the Inspector, whether it is shown or hidden. Selectable: a step (parked
  included), a processor die, a cache and the sphere. Esc or an empty-canvas click clears the
  selection; selecting never moves or wires anything.
- The open dropdown lists workflows by their unique name (§7). Opening a workflow that is already open
  focuses its tab. **A refresh keeps the page as it was** (user decision 2026-10-06): the open documents (fetched again), the active tab, each document's selection and view (zoom and scroll; a view still following Fit is fitted again), the dock with floating and auto-hidden panes, and the Inspector's show-all. Pop-out windows come back docked. It is a per-tab session in `sessionStorage` (`skp.studio.session`: it survives a refresh and is not shared between tabs), mirrored on every write to `localStorage` under the same key, which seeds a tab that has none (a new tab, a browser restart); never the database. **Unsaved work is never lost to a refresh:** from slice 3b on, every edit not yet saved is kept in the session as its document's draft (written on every change and on `pagehide`) and comes back on reload, marked unsaved, until it is saved or discarded. Constraints for 3b: the draft is an optional, validated field of each session document, and the session version is **not** bumped for it (a bump drops every open session once); a session write that fails shows a toast; a document whose graph fails to load keeps its draft; a large draft may get its own key per document.

### 6.2 Docking behaviour (all built on the free core)

1. A ▾ **window-position menu**, also on a tab's right-click: Float, Dock, Dock as tabbed document,
   Auto hide, Close. **Ctrl+double-click** toggles float and dock.
2. Window menu: **Save, Apply and Reset window layout**, kept in `localStorage` per user, **never in
   the DB** (separate from the workflow's `Layout` column). At startup the session (§6.1) wins over the saved layout; Apply still brings the saved one back, keeping the open documents.
3. **Exact re-dock memory:** a pane returns to the neighbour, side and size it had.
4. **Documents can only be dropped into or beside the document area.**
5. **Auto-hide built in-house:** left, right and bottom rails, sliding out on hover or click; Dock pins
   back. A hidden Inspector's tab glows when its content changes.
6. **Ctrl+E** is the switcher (the browser reserves Ctrl+Tab). Double-click a tab to maximize,
   middle-click to close. **Alt+W** closes a document (the browser reserves Ctrl+W).

### 6.3 Rendering rules

- **Workflow documents use `renderer: 'always'`.** dockview's default (`onlyWhenVisible`) takes
  inactive panels out of the page, which would lose the React Flow viewport and measured size.
- **Pop-out windows:** code inside a panel uses the element's `ownerDocument`, never the global
  `document`. React Flow's d3 zoom/drag in a pop-out is a known risk and is covered by an end-to-end
  test (section 9).
- **Overlay layers.** dockview puts floating groups at z-index 999. Every overlay of ours sits above
  that, defined once as tokens: auto-hide flyout 1000, menus and pickers 1010, toast 1020, modal 1030,
  switcher 1040, tooltip 1050. (Found in the mockup: a document tab's menu opened under a floated
  group; fixed in v41.)

## 7. Inspector editors

Two rules hold for every view:

- **Read-only text is shortened, never wrapped.** A read-only label or value that does not fit is cut
  with an ellipsis, and its full text is a tooltip, shown only when something was cut. This covers every
  read-only value: the source hash (its full 64 characters, cut on screen), schema slots, ids, dates and
  name tags.
- **Unique entity name.** Selecting an entity shows, at the top of the Inspector, its unique name by
  the rule in `Messaging.Contracts.EntityNames.Format`: `{name}_{version}-{last two id groups}` (the
  studio's `model/entityNames.ts` mirrors it; the workflow picker uses the same name). It is the name
  the logs and processors use, so an operator can match what they selected to what they read in Output
  and the logs. The canvas does not show it: step caps keep the bare name and version (user decision,
  2026-10-06).
- **Entity details.** Every entity (step, parked step, processor, workflow, cache) always shows its name
  and version. Under them, **▸ show all** reveals the base-entity fields, read-only: **Id, Created at,
  Created by, Updated at, Updated by**; **▾ hide details** folds them away. It is one switch for all
  entities, so it stays as the operator left it while they click around.

### 7.1 What the Inspector edits (decided 2026-10-06; built in slice 3b)

**The Inspector edits an entity's own metadata, never the graph.** Structure (next steps, entry steps,
which assignments and caches a workflow holds, a step's processor, a processor's schemas, an
assignment's step) comes from the designer graph. Every save is `PUT /{entity}/{id}` with the entity's
update DTO built from its last `GET`, only the writable fields changed and **every structural field
sent back exactly as read** (a step `PUT` replaces `NextStepIds`; a workflow `PUT` replaces its three
lists; `null` clears them). Save re-reads the entity (`GET`) immediately before the `PUT`, so structural fields go back exactly
as the server holds them at that moment (decided 2026-10-06, plan 3b).

| Entity | Writable (free text unless noted) | Not editable here |
|---|---|---|
| Workflow | Name, Version, Description, CronExpression | EntryStepIds, CacheIds (from the graph); AssignmentIds (not shown) |
| Step (incl. parked) | Name, Version, Description, EntryCondition (dropdown C/F/X/A/N) | NextStepIds (graph); ProcessorId: **drill-down** to the Processor; the step's assignment: **drill-down** |
| Assignment (reached from its step) | Name, Version, Description, Payload (JSON) | StepId |
| Processor | Name, Version, Description, SourceHash, InstanceId | Input/Output/Config schema ids: one **drill-down** per slot to the Schema (∅ when empty) |
| Schema (reached from a slot) | Name, Version, Description, Definition (JSON) | none |
| Cache | Name, Version, Description, Root, Items (JSON object of strings) | none |

- **Server is the validator.** Free text means the Inspector does not re-check business rules: cron
  (blank, or a parsed 5/6-field expression), Version (semver `x.y.z`), Name (≤ 200), SourceHash (64
  lowercase hex, unique), InstanceId (≤ 200, unique), Root (no `:`, ≤ 200, unique), JSON sizes (≤ 1 MB),
  and the frozen schema definition are BaseApi's. A 400 shows its messages under their fields; 404,
  409 and 422 show as a banner with the server's text; a network failure shows "Not saved: BaseApi
  unreachable". The form always keeps what was typed. Exceptions that are not business rules: Name
  and Version may not be empty (Save is disabled; the placeholder shows the last saved value, or a
  generated one for a new assignment), and JSON text areas mark invalid JSON while typing.
- **One JSON Schema validator: BaseApi's.** Schema definitions and payload-against-config-schema
  checks use **JsonSchema.Net 9.2.1, draft 2020-12, external `$ref` fetching disabled**
  (`BaseApi.Service/Features/Schema/JsonSchemaConfig.cs`; mirrored in
  `BaseProcessor.Core/Validation/ProcessorJsonSchemaValidator.cs`). A Schema definition is judged by
  `PUT /schemas/{id}` (`SchemaDtoValidator`: valid JSON, then `MetaSchemas.Draft202012`); payload
  conformance by validate (§4.4). **The browser runs no JSON Schema validator of its own** (user
  decision, 2026-10-06), so the studio can never disagree with the server or the processors.
- **Save and Revert**, never autosave. Selecting another entity, drilling down, going back or closing
  the document with unsaved changes asks **Save / Discard / Cancel**. Drill-downs keep a breadcrumb
  (e.g. **Step › Processor › Config schema**) with a back button.
- A document holds at most one Inspector draft: the drill-down trail and the typed fields (§6.1). It is
  marked by "● unsaved changes", the tab's amber dot and an enabled capsule Save, which saves it. After
  any write every open document re-reads its graph and validate, and every Inspector re-reads its
  entity; a document that fails to re-read keeps its drawing and a toast says so.
- **After a save** the form takes the returned DTO as its baseline, and every open document re-reads
  its graph and re-runs validate (a shared entity may sit in several), so the canvas and Problems
  update.
- **Shared entities are the operator's responsibility** (user decision, 2026-10-06). A `PUT` to a
  shared processor, step, schema, assignment or cache changes it for every user; there is no warning,
  no copy and no stale check (last write wins). Validate surfaces the consequences afterwards.
- **Assignments, from the step's drill-down:** **Edit** is `PUT /assignments/{id}`. **Add** (only when
  the step has none in this workflow) is `POST /assignments` with the step's id (defaults: Name
  `{step name}-assignment`, Version `1.0.0`, Payload `{}`), then `PUT /workflows/{id}` adding it to
  `AssignmentIds`; the two calls are not atomic, and a failed second call is reported as "created but
  not linked". **Create** (formerly Add) and **Remove** sit on the step's Assignment row; Remove also
  sits in the assignment's own view. **Remove** (amended 2026-10-07; unlink-only was dropped because it
  left orphaned assignments) asks first, then lists the workflows: if any other workflow also lists
  the assignment it is refused and changes nothing, with the banner "Not removed: also used by {names}."
  Otherwise it is `PUT /workflows/{id}` without it, then `DELETE /assignments/{id}` (BaseApi refuses
  the delete while any workflow still lists it, hence the order; a 404 counts as done). A delete that
  fails after the PUT says "Taken off this workflow, but not deleted". Results show in the Inspector's
  banner only; Output does not log them yet.

### 7.2 Richer editors (later slices)

These build on §7.1 once canvas editing exists:

- **Step:** "also reached by" (shared); wired from/to lists.
- **Assignment:** `vanilla-jsoneditor` in tree/table plus raw mode. Conformance to the processor's
  config schema comes from BaseApi's validator (§7.1), not a browser one; hints derived from the config
  schema's own keywords (missing `required` keys, `enum` values as dropdowns, `default` values offered)
  are presentation, not validation. Limit 1 MB. Invalid raw text keeps the last valid value.
- **Processor / Schema:** an impact panel showing usage and the wires that would break, noting that
  replicas need a restart; creating a new schema version for a frozen definition.
- **Workflow:** cron with a plain-English reading and the next 3 fire times.
- **Cache:** Items in a TanStack table.
- **Wire, junction and multi-select** views.

### 7.3 Problems

From slice 3a, Problems lists the document's validate result (gate, title, detail), shows "Problems
unavailable." when validate fails and "No problems" when the list is empty, and a click selects the
entity a problem names, when it names one. The full pane (later) has two severities:

- **start blockers:** cycle, broken wire, invalid payload, dangling step;
- **notes:** fan-in, shared, parked, frozen.

Start blockers come from `POST /workflows/{id}/validate` (§4.4), called shortly after each edit pause
  and on demand, and include **processor liveness**, so a dead processor shows before Start. Notes are
  drawing facts the studio computes itself.

## 8. Error handling

| Situation | What the user sees |
|---|---|
| Save, 409 (stale workflow or step) | Output names the stale entity; the draft is kept; "Reload and re-apply" is offered |
| Save, 422 (FK violation) | Whole save rolled back; Output shows the constraint and who references the entity; draft kept |
| Toolbox delete, 422 | The entity stays; the referencing rows are listed. **Not supported by BaseApi yet** (found 2026-10-06): its 422 names one FK column, not the rows; slice 6 must add a usages read |
| Inspector save, 400 / 404 / 409 / 422 | §7.1: field messages under their fields; otherwise a banner with the server's text; the form keeps what was typed |
| Start, 422 (validation or liveness) | Output shows the orchestrator's reasons; Problems is not changed |
| Schema update on a referenced schema, 409 | Never sent: the UI always creates a new schema version instead |
| Stale ids in `Layout` | Ignored silently; new blocks get an elkjs position |
| Network failure | Draft kept; Save stays enabled; Output logs the failure |

## 9. Testing

- **`model/` and `layout/` with Vitest.** No start rule is tested here, because none is re-implemented
  (the backend's gate tests own them). They cover entry conditions (never 0), at most one assignment per
  (workflow, step), reachability and parked blocks, and wire routing (straight in
  the band, bent → processor middle, fan-out spacing). `layout/` also covers manual routes: keeping
  them orthogonal as their ends move, removing a bend when segments line up, the jog on a first-segment
  drag, and grid alignment of every computed point.
- **Backend, hermetic (EF InMemory, `BaseApi.Tests`).** Request building, the order of the concurrency
  checks, and choosing the assignment rule (update, copy, create, orphan).
- **Backend, RealStack (real Postgres, gated by `SKP_REALSTACK=1`).** InMemory has no transactions or
  foreign keys, so these run against Postgres: an FK violation rolls back the whole save; a stale
  workflow or step returns 409; copy-on-shared and delete-on-orphan; a schema edit adds a new row and
  re-points the slot; the `Layout` round trip ignores stale ids.
- **Playwright end-to-end** (nginx in front of the real BaseApi):
  - dragging a block reroutes its wires;
  - the Save / Discard / Cancel prompt on close;
  - float and re-dock to the exact spot;
  - documents drop only into or beside the document area, with a real mouse drag;
  - pop out a document, then drag a block and zoom in the new window;
  - switch document tabs and come back: the viewport and selection are kept;
  - menus, pickers and the tooltip open above a floating group;
  - moving a junction's source step stretches only its own line (the bus, trunk and other lines stay);
  - a segment drag makes a route manual, it survives a block move, and Reset route restores it;
  - dragging an arrow head onto a step rewires it; dropped on empty canvas it snaps back;
  - after layout, every step border lies on a 32 px line and every wire point on an 8 px line;
  - (3a) open a workflow, select an entity and see the Inspector fill; auto-hide a pane and pin it back;
  - (3b) edit and save each entity kind, see a 400 under its field and a 409/422 banner, and add, edit
    and remove a step's assignment.
- **The Inspector's DTO round trip (Vitest, 3b).** For every entity, a save sends exactly the DTO it
  read with only the writable fields changed; structural fields (`NextStepIds`, `EntryStepIds`,
  `AssignmentIds`, `CacheIds`, `StepId`, `ProcessorId`, schema ids) go back unchanged.
- **End-to-end tests never edit shared dev data.** Tests that save create their own throwaway
  entities through BaseApi in setup and remove them afterwards.

## 10. Build order (vertical slices)

1. **Backend:** `Layout` column and migration, `GET` / `PUT /layout`, then `PUT /graph` with its tests.
1b. **Backend reads:** the gates' collect mode, `POST /workflows/{id}/validate`, `GET /orchestration/live`,
   `GET /processors/liveness` (§4.4).
2. **Read-only canvas:** load, render and route with the section 5 visuals.
Reordered 2026-10-06 (user decision): the dock and the Inspector come before canvas editing, so
editing is built inside real panes.

3a. **Dock chrome** on dockview-core 8.4 (§6): `renderer: 'always'` for documents, `ownerDocument` in
   pop-outs, overlay layer tokens, window menus, in-house auto-hide, layout in `localStorage`; the
   capsule toolbar with status only (Start/Stop disabled); canvas selection; a **read-only** Inspector
   (unique name, DTO fields, show all); Problems from validate (§7.3); Output and Toolbox as empty panes.
3c. **Node art and live states** (§5.1, locked 2026-10-06; runs after 3a, before 3b): the gallery's
   step, processor, hub, cache and line drawings; processor health from `/processors/liveness`; the
   started hub and flowing pulses from `/orchestration/live`; reduced motion; the legend.
3b. **Inspector editing** (§7.1): `GET` / `PUT` per entity, drill-downs, assignment add / edit / remove
   from the step, server errors, refresh after save. The only `POST` is creating an assignment; no
   `DELETE`. Its unsaved edits are kept in the session as the document's draft and survive a refresh (§6.1).
4. **Canvas editing:** wiring, moving, connector editing (§5.5) and alignment guides, undo/redo, parked
   blocks, draft save through `/graph`. Its unsaved edits are kept in the session as the document's draft and survive a refresh (§6.1).
5. **Richer editors and the full Problems pane** (§7.2, §7.3).
6. **Toolbox:** drag-and-drop onto the canvas, **+ New** step / processor / cache, delete (✕) from the
   toolbox (§4.3).
7. **Junctions and polish:** positioned junctions (bus, trunk, node, contact points) and their drags.

## 11. Deferred and rejected

**Deferred:**
- The VS drag **compass** (`dndCompass`) -- dockview-enterprise only.

**Rejected dock libraries** (web research, 2026-10-05):

| Library | Why not |
|---|---|
| dockview-enterprise | Compass and native auto-hide are its only gains for us; per-developer yearly licence, price not public. Revisit if the compass becomes required |
| Infragistics Dock Manager | The only full VS copy, but a web component styled via `::part`, pop-out only under Electron, ~$1,399/dev/yr for the suite |
| FlexLayout | No compass |
| rc-dock | Poorly maintained; React 19 problems |
| Lumino DockPanel | Not React; no floating, no auto-hide |
| Golden Layout 2 | Stale; no official React binding |

## 12. Before implementation

- Install the coding-reference skills `framara/react-flow-skill` and `tanstack-table` (needs the
  user's approval; they are third-party).
