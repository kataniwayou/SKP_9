# Acto — workflows as triangles over one shared graph (design)

Date: 2026-11-18 · Status: draft for the user's review
Supersedes, in `2026-11-17-acto-design.md`: §5 (frames), §7 rules about first/parked steps, §8b (the shared-entity
lock), §8c, §9 (saving, layout), and every place the old spec says a step or cache belongs to a workflow. Everything
else there (screen, panels, wiring look, themes, chat transport, health, Start/Stop, Output, testing style) still holds.

User clarification 2026-11-18: align with the DB rules **as BaseAPI enforces them**, and use **React Flow's own style
and wiring conventions** (handles, connections, edges, selection, minimap, controls) wherever React Flow provides them.

Tags: **[user]** = the user decided it in the 2026-11-18 conversation; **[call]** = the writer's call, open to change.

## 1. Intent

Acto drew every workflow as a frame that owned its steps. The database never worked that way, and the mismatch
forced extra rules (ownership, parked steps, derived first steps, a shared-step lock, rebasing) that caused bugs
and contradicted each other. The user wants Acto to **match the database exactly** and keep nothing else:

- **Steps, their wires and caches form one shared graph.** A step holds only its processor and entry condition; a
  wire (`StepNextSteps`) links step to step; nothing in either names a workflow.
- **A workflow is a pointer into that graph plus its own settings:** cron, name/version/description, its entry steps
  (`WorkflowEntrySteps`), its payloads (`WorkflowAssignments`; an assignment = step id + JSON payload) and its caches
  (`WorkflowCaches`). Two workflows may enter the same step and run the same graph with different payloads.

Acto is a **free-form designer**: design anything, save it, and the **dry run** (validate) is what matters before
running [user]. The designer is responsible for the effect of changing something shared [user].

## 2. Goals, non-goals, anti-goals

Goals
- One shared graph of steps, wires and caches on the board; each workflow is a **draggable triangle** whose tip
  points at its entry steps [user].
- Selecting a triangle loads that workflow's payloads onto the steps it reaches [user].
- **One board-wide Save** that writes every change at once, then dry-runs every affected workflow [user].
- Orphan steps (reached by no workflow) can be created, saved, and live on the board harmlessly [user].
- Every step, cache and workflow has **one stored location** [user].
- Per-workflow Kibana SVG showing only that workflow [user].

Non-goals
- No multi-select of triangles [user].
- No change to how workflows run, start, stop or snapshot their payloads.
- No change to WorkflowStudio; it keeps running side by side on its own endpoints and `Layout` column. **Acto is the
  source of truth for designers** [user]; WorkflowStudio is best-effort on data Acto creates (shared and orphan steps,
  stale layouts) and may refuse or misplace things there. No compatibility work for it.

Anti-goals (a failure even if it works)
- **Any Acto rule the database does not have** [user: "no redundant rule to avoid any bugs or contradictions"]. The one
  exception the user named is already BaseAPI's: a running workflow cannot be deleted (§8).
- Warnings or confirms that guard against legal states (an orphan step, a shared step edited, an unfinished workflow
  saved).
- Two stored copies of the same fact (e.g. a shared step's position in several workflow layouts).

## 3. The database rules Acto relies on (and nothing more)

Field rules (BaseAPI validators) — a Save that breaks any of these saves **nothing**:
- Workflow: name/version present (version strict SemVer, a new workflow uses `1.0.0`); **at least one entry step**;
  no duplicate entry steps, assignments or caches; cron valid (5 or 6 fields) or none.
- Step: a processor; no duplicate next steps; a valid entry condition (C/F/X/A/N, values 1–5).
- Assignment: non-empty JSON, at most 1 MB. A payload row linked by another workflow is copied, never edited in
  place (§4b).
- Delete restrictions (foreign keys): a step cannot be deleted while any workflow enters it, any step wires into it,
  or any assignment points at it; a cache cannot be deleted while any workflow lists it — **unless the same Save also
  removes those references** (one transaction).
- Concurrency: a Save that updates or deletes a row whose `updatedAt` changed since Acto read it is refused as
  "changed elsewhere" (BaseAPI's `/model/apply` check). Link rows have no stamp; they change only through their
  owner row's update, so the owner's `updatedAt` guards them (§4b).

Dry run (`POST /workflows/{id}/validate`, unchanged): cycles and missing steps, payload vs. config schema, schema
equality on each wire, processor liveness. It **reports**; it never blocks or undoes a save. **Start** runs the same
gates and refuses a failing workflow (unchanged).

Running workflows: a running workflow runs the snapshot taken at Start; a saved change reaches it only at its next
Start (unchanged). Acto shows nothing extra for this.

## 4. BaseAPI changes

### 4a. Locations [user]
- Add nullable location columns to `Step`, `Cache` and `Workflow`: `BoardX`, `BoardY` (double) [call: names/types].
  Null = never placed; Acto places it (§5) and the next Save writes it.
- One EF migration (nullable columns). A **fill** sets missing locations from existing data [call: algorithm]: for
  each step/cache whose location is null, the position from the most recently updated workflow layout that places it,
  translated into one board space by that workflow's old Acto `board` offset when present; a triangle goes left of its
  first entry step. Anything not found stays null. It runs at BaseAPI startup and only ever fills nulls, so it is
  effectively one-time and never overwrites a location Acto saved [call].
- `Workflow.Layout` is **left untouched** for WorkflowStudio; Acto stops reading and writing it [user].
- Locations travel on the CRUD create, update and read DTOs as optional trailing fields. On update, an absent (null)
  location keeps the stored one, so callers that do not know locations (WorkflowStudio's design save, Valence) never
  erase them [call]. Acto always sends them.

### 4b. Board save — BaseAPI's existing `POST /model/apply` [user: one board-wide Save; align with BaseAPI's DB rules]
No new save endpoint. BaseAPI already has an all-or-nothing change runner: `POST /api/v1/model/apply` takes
`{ changes: [{ op: create|update|delete, table, id, row, updatedAt }] }`, runs each change through the same service a
plain CRUD `POST`/`PUT`/`DELETE` uses (validators, foreign keys, unique indexes, the running-workflow delete guard),
inside one transaction, and commits only if every change passed. Created rows are named by client ids that later
changes may reference; the answer maps them to the ids BaseAPI gave. An update or delete carrying `updatedAt` is
refused (409) if the row changed since it was read. `POST /model/validate` is the same run, always rolled back.

So **Save = the diff between the loaded rows and the board's rows, as CRUD changes** — the exact DB rules, nothing
more:
- Rows are workflows (name, version, description, cron, entry step ids, assignment ids, cache ids, location), steps
  (name, version, description, processor, next step ids, entry condition, location), caches, assignments
  (step id, payload), processors and schemas (today's processor/schema-slot edits).
- Junction changes ride on their owner row's update (a wire on its source step, entry arrows/cache links/payload links
  on the workflow), so the owner's `updatedAt` guards them [call; replaces the link-stamp note in §3].
- Payloads: Acto edits a workflow's assignment in place when no other workflow links that row; otherwise it creates a
  new row and relinks this workflow to it (copy-on-write in the client, since the CRUD has no resolver). Removing a
  payload unlinks it, and deletes the row when no workflow links it any more [call].
- Change order inside one request, so every foreign key holds when each change runs: creates (schemas, caches, steps
  with only already-existing next steps, assignments, workflows) → updates (processors, steps incl. new steps' new
  next steps, caches, assignments, workflows) → deletes (assignments, steps, caches) [call].
- BaseAPI caps one request at 500 changes; a bigger Save is refused with its message (BaseAPI's rule).
- Affected workflows (for the dry run and Kibana, §8) are worked out by Acto from the diff: every workflow whose row
  changed, or that reaches (before or after the save) a step that was created, changed or deleted [call].

### 4c. Workflow delete — CRUD delete through the same runner [user: steps are shared; running cannot be deleted]
Immediate (not part of Save): `POST /model/validate` first for the confirm, then `POST /model/apply` with
`delete workflows/{id}` plus `delete assignments/{a}` for each of its assignments no other workflow links. The
runner applies BaseAPI's running/deleting guard, so a running workflow is refused [user]. The CRUD delete removes the
workflow's junction rows (cascade); **steps, wires and caches stay** (possibly as orphans). WorkflowStudio's
`POST /workflows/{id}/delete` and `PUT /workflows/{id}/design` stay as they are for WorkflowStudio.

### 4d. Board read
CRUD lists: `GET /workflows`, `/steps`, `/caches`, `/assignments`, `/processors`, `/schemas`. Every step is drawn,
orphans included [call].

## 5. The board

- **Steps**: cards as today (processor icon, name, processor, footer, health dot), one per step in the database, at
  their stored location. No FIRST/PARKED tabs.
- **Wires**: as today — one per link, colour/letter/arrowhead from the target step's entry condition.
- **Caches**: blocks on the board at their location [user] (no chips).
- **Workflows**: a triangle (tip pointing right by default), with the running dot (green/red/amber while unknown) and
  the name and state under it. **Solid arrows leave only from the tip**, one to each entry step [user]. Caches are
  joined by a **dashed line from the back of the triangle** to each of its caches [user].
- Dragging a triangle, step or cache moves only that item and changes only its location [user].
- **Placement** of anything with a null location: free slots near what it connects to (triangle left of its first
  entry step, cache below its first triangle, orphan steps in a column right of everything) [call].
- Minimap: triangles, steps and caches as small marks, viewport rectangle; click to jump. Fit fits everything.
- At every zoom everything draws (unchanged).

## 6. Selecting and the Inspector

- **Click a triangle**: it is selected; the steps, wires and caches it reaches/links light up and every other item
  dims [call: dim, shown in the mockup and liked]; each lit step's footer shows that workflow's payload summary.
  Toolbar: **Start/Stop · Delete** (no Save — Save is board-wide).
- **Click a step**:
  - with no triangle selected → Inspector shows the shared fields (name, processor, entry condition, processor and
    schema slots); no payload.
  - with a triangle selected → the same shared fields marked "shared", plus **Payload · <workflow>** [user: click the
    triangle first]. Clicking a step keeps the triangle selected [call]; clicking empty board clears both.
  - A step the selected workflow does not reach shows the shared fields only, with "not in <workflow>".
- **Triangle Inspector**: name, version, cron, description, its entry steps and caches (listed), location, and **its
  assignments** — every assignment the workflow links, each naming the step it references, editable and deletable.
  An assignment belongs to the workflow and references a step (`Assignment.StepId`); the step does not point at it.
  Showing it on the step card and in the step Inspector is a convenience view only [user]. An assignment whose step
  the workflow no longer reaches simply stays in this list — no cleanup rule [user: follows the database].
- **Multi-select**: Ctrl+click on steps, wires, caches (not triangles) [user]; bar = actions common to all
  (Copy · Delete for steps/caches; Delete for wires); numbered badges as today.
- **Toolbars**: triangle = Start/Stop · Delete; step = Copy · Delete; cache = Delete; wire = Delete; entry arrow =
  Delete; cache dashed line = Delete. Paste = Ctrl+V only. Delete key does nothing. No key hints (unchanged rules).

## 7. Editing

- **Toolbox**: Create › **Workflow** (drop anywhere → a triangle `new-workflow-N`, `1.0.0`, no cron, no arrows),
  Create › **Cache** (drop anywhere → a cache block), **Steps** (one per processor, drop anywhere → a step) [call:
  Cache stays in the toolbox because caches are blocks now].
- **Entry arrow**: drag from the triangle's tip onto a step [user]. **Cache link**: drag from the triangle's back onto
  a cache. **Wire**: drag from a step's right handle onto a step (unchanged).
- **Payload**: edited only with a triangle selected; it belongs to that workflow [user].
- **Delete a step**: removes the step, its wires, the entry arrows into it and every workflow's payload on it, in one
  edit — the designer's responsibility [user]. **Delete a cache**: removes it and every dashed line to it.
- **Copy/paste steps**: shared fields and wires among the copied steps; no payloads [call].
- **Undo/Redo**: **one history for the whole board** [call: per-workflow histories contradict a shared graph];
  Inspector header buttons and Ctrl+Z/Y; covers every edit including locations and payloads.
- **Unsaved**: every changed item carries the unsaved mark; the Save button shows the count [call]. The unsaved board
  survives a reload as one board draft (replacing per-workflow drafts) [call].

## 8. Save, dry run, Kibana, delete

**Save** — one button in the top bar [call: placement], disabled when nothing changed:
1. `POST /model/apply` with the whole diff (§4b). On refusal: nothing saved; failures go to Output and mark the items they name;
   the board stays unsaved. A stale-stamp refusal ("changed elsewhere") names the conflicting items (a 404, row gone, likewise);
   a **Take stored · N** button then appears beside Save: it re-reads BaseAPI and takes the stored version of exactly
   those rows (base and present), dropping the designer's change to them as one undoable edit; the rest of the unsaved
   board stays. No automatic merge [user: accepted; Take stored: user, 2026-11-18 — undo history does not survive a
   reload, so undoing alone could not clear a conflict after one].
2. On success: adopt new stamps/ids; for **each affected workflow**: `POST /workflows/{id}/validate` → problems go to
   Output and mark the triangle (cleared by its next clean dry run); render its Kibana SVG and
   `PUT /workflows/{id}/diagram`.
3. A new triangle with no entry arrow fails the field rule "at least one entry step", so that Save saves nothing until
   the arrow is drawn or the triangle removed — this is BaseAPI's rule, not a new one.

**Kibana SVG** [user]: only that workflow — its triangle, entry arrows, the steps and wires it reaches, its caches and
dashed lines — at their shared locations, in Acto's look on white, no live state, legend below (unchanged style).
Other triangles, steps only they reach and orphans are left out.

**Delete a triangle**: toolbar Delete → dry run lists what goes (workflow, its links, its unshared payloads) → confirm
→ the CRUD delete through `POST /model/apply` (§4c). Refused while running: "running: stop it first" [user]. Immediate, not part of
Save and not undoable [call: like Start/Stop]. Unsaved edits **of that workflow's own** — its fields, location, entry
arrows, cache links and payloads — are dropped with it, and undo entries that touch only those are removed; unsaved
edits to steps, wires and caches stay, even if only it reached them [call: e.g. deleting step S that was W's only
entry, then deleting W, keeps the step delete].

## 9. Chat

Same transport and loop. Tools and prompt are rewritten to this model [user: "clean up all the redundant rules also
for the chat"]:
- Gone: anything about frames, parked/first steps, the shared lock, per-workflow save, frame move/resize.
- Read tools describe the graph, the triangles (entry steps, caches, cron, state) and payloads per workflow.
- Edit tools: add/delete step, wire, cache, workflow; set entry steps; link/unlink cache; **set payload (workflow,
  step)**; edit shared step fields; move items. Edits are board edits (one undo step each, as today).
- `save_board` saves the whole board (asks first, as destructive tools do today); `delete_workflow` keeps its
  ask-first behaviour; `start`/`stop` unchanged.

## 10. Removed from Acto

Frames (parent nodes, extent, move/resize, header band, frame minimum size), cache chips, FIRST/PARKED tabs and the
parked concept, derived first steps and the "stored entry steps differ" marking, the shared-entity lock
(`changedEntities`/`holders`/`lockedBy`), rebase after save, per-workflow Save, per-workflow histories and drafts,
reading/writing `Workflow.Layout`, the `board` field in layouts, workflow multi-select, and the matching chat tools
and prompt text.

## 11. Testing

- BaseAPI: tests for the location columns (round trip, null keeps the stored value) and the fill. `/model/apply`
  already has its own tests; Acto's change builder is unit-tested for order, copy-on-write and stamps, and the e2e
  suite saves through the real endpoint.
- Acto unit tests rewritten for the new model; the headed Playwright suite (`src/Acto/e2e`) rewritten to cover every
  feature above, still against throwaway data only, never pressing Start/Stop on real workflows.

## 12. Left to the builder

Endpoint names and DTO shapes; whether the board read is one endpoint or CRUD lists; React Flow node types for
triangle/cache; exact triangle size and styling within the mock's look; placement algorithm details; how the
migration fill handles conflicting positions (any consistent choice).
