# Acto — workflows as triangles over one shared graph (design)

Date: 2026-11-18 · Status: draft for the user's review
Supersedes, in `2026-11-17-acto-design.md`: §5 (frames), §7 rules about first/parked steps, §8b (the shared-entity
lock), §8c, §9 (saving, layout), and every place the old spec says a step or cache belongs to a workflow. Everything
else there (screen, panels, wiring look, themes, chat transport, health, Start/Stop, Output, testing style) still holds.

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
- Assignment: non-empty JSON, at most 1 MB; **one payload per step per workflow**; a payload row linked by another
  workflow is copied, never edited in place (today's `GraphAssignmentResolver` behaviour).
- Delete restrictions (foreign keys): a step cannot be deleted while any workflow enters it, any step wires into it,
  or any assignment points at it; a cache cannot be deleted while any workflow lists it — **unless the same Save also
  removes those references** (one transaction).
- Concurrency: every row carries Postgres `xmin`; a Save whose loaded stamp is older than the stored row is refused
  as "changed elsewhere — reload". Link rows (`StepNextSteps`, `WorkflowEntrySteps`, `WorkflowCaches`,
  `WorkflowAssignments`) have no stamp: a wire change is guarded by its source step's stamp, an entry-arrow,
  cache-link or payload change by its workflow's stamp, and the save bumps that owner row so the next stale save is
  caught [call: as `WorkflowGraphSaver` forces it today]. Building `PUT /board` on the existing all-or-nothing runner
  `POST /model/apply` is allowed if it switches to `xmin` [left to the builder].

Dry run (`POST /workflows/{id}/validate`, unchanged): cycles and missing steps, payload vs. config schema, schema
equality on each wire, processor liveness. It **reports**; it never blocks or undoes a save. **Start** runs the same
gates and refuses a failing workflow (unchanged).

Running workflows: a running workflow runs the snapshot taken at Start; a saved change reaches it only at its next
Start (unchanged). Acto shows nothing extra for this.

## 4. BaseAPI changes

### 4a. Locations [user]
- Add nullable location columns to `Step`, `Cache` and `Workflow`: `BoardX`, `BoardY` (double) [call: names/types].
  Null = never placed; Acto places it (§5) and the next Save writes it.
- One EF migration. A **one-time fill** sets locations from existing data [call: algorithm]: for each step/cache,
  the position from the most recently updated workflow layout that places it, translated into one board space by
  that workflow's old Acto `board` offset when present; triangles go left of their entry steps. Anything not found
  stays null.
- `Workflow.Layout` is **left untouched** for WorkflowStudio; Acto stops reading and writing it [user].
- Locations travel on the CRUD read DTOs and in the board save (4b); CRUD create/update may ignore them [call].

### 4b. Board save — new endpoint [user: one board-wide Save]
`PUT /board` [call: route] takes one request with everything that changed since the board was loaded:
creates/updates/deletes of steps (name, processor, entry condition, next steps, location), caches (fields, location),
workflows (name, version, description, cron, entry steps, cache ids, location), per-workflow payloads
(workflow id + step id → payload or removal), and processor/schema-slot edits as today's design save accepts them.
Each updated or deleted row carries the `xmin` stamp Acto loaded.

- One transaction, all or nothing: any field-rule failure, FK refusal or stale stamp → rollback, and the response lists
  every failure (entity kind, id, field, message) so Acto can point at it.
- Payload handling reuses the per-(workflow, step) resolver, including copy-on-write of shared rows and deleting rows
  nobody links any more.
- Response on success: the new stamps and ids (for created rows) and the list of **affected workflows** — every
  workflow whose own fields/payloads/caches changed or that reaches (from its entry steps, over wires after the
  save) any step that was created, changed or deleted, or whose reach changed.
- No ownership checks of any kind (the old design save's "not a step of this workflow" and the old delete's "used by
  another workflow" do not apply here).

### 4c. Workflow delete — new semantics for Acto [user: steps are shared; running cannot be deleted]
`POST /board/workflows/{id}/delete` [call: route], immediate (not part of Save), with a dry-run mode for the confirm:
- Refused while the workflow runs or its deletion runs (today's `IWorkflowRunGuard`) [user].
- Removes the workflow row, its entry-step, cache and assignment links, and its assignment rows that no other
  workflow links. **Steps, wires and caches stay** (possibly as orphans).
- WorkflowStudio's `POST /workflows/{id}/delete` and `PUT /workflows/{id}/design` stay as they are for WorkflowStudio.

### 4d. Board read
Acto loads: workflows (with entry steps, assignment ids, cache ids, location, stamp), all steps (with next steps,
location, stamp), all caches, all assignments linked by any workflow, processors and schemas. Existing CRUD lists may
serve; a single `GET /board` is allowed if the builder prefers [left to the builder]. Orphan steps come with
`GET /steps`; all of them are drawn [call].

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
1. `PUT /board` with the whole diff. On refusal: nothing saved; failures go to Output and mark the items they name;
   the board stays unsaved. A stale-stamp refusal ("changed elsewhere") names the conflicting items; the designer
   either undoes their changes to those items and saves again, or reloads and loses the unsaved board. No automatic
   merge [user: accepted].
2. On success: adopt new stamps/ids; for **each affected workflow**: `POST /workflows/{id}/validate` → problems go to
   Output and mark the triangle (cleared by its next clean dry run); render its Kibana SVG and
   `PUT /workflows/{id}/diagram`.
3. A new triangle with no entry arrow fails the field rule "at least one entry step", so that Save saves nothing until
   the arrow is drawn or the triangle removed — this is BaseAPI's rule, not a new one.

**Kibana SVG** [user]: only that workflow — its triangle, entry arrows, the steps and wires it reaches, its caches and
dashed lines — at their shared locations, in Acto's look on white, no live state, legend below (unchanged style).
Other triangles, steps only they reach and orphans are left out.

**Delete a triangle**: toolbar Delete → dry run lists what goes (workflow, its links, its unshared payloads) → confirm
→ `POST /board/workflows/{id}/delete`. Refused while running: "running: stop it first" [user]. Immediate, not part of
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

- BaseAPI: tests for the migration fill, `PUT /board` (all-or-nothing, FK refusals lifted by same-save removals, stale
  stamps, copy-on-write payloads, affected-workflow list) and the new delete (running refusal, shared steps kept).
- Acto unit tests rewritten for the new model; the headed Playwright suite (`src/Acto/e2e`) rewritten to cover every
  feature above, still against throwaway data only, never pressing Start/Stop on real workflows.

## 12. Left to the builder

Endpoint names and DTO shapes; whether the board read is one endpoint or CRUD lists; React Flow node types for
triangle/cache; exact triangle size and styling within the mock's look; placement algorithm details; how the
migration fill handles conflicting positions (any consistent choice).
