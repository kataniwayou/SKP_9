# SKP Studio plan 8: design on virtual entities, save by dry run then write -- design

Date: 2026-10-07. Branch `feature/path-importer`. Builds on plans 3b (Inspector), 4 (designer) and 7 (junctions).
Where this document differs from the main spec (`2026-10-05-skp-studio-design.md`) §4 (graph save), §6.1 and §7.1
(Inspector writes), or the plan 4 spec §4.4-§4.6 (drop rules), this document wins.

## 1. Purpose

The designer works offline on virtual copies of every entity of the opened workflow. Nothing is written while
designing. **Save** always stores the design on the workflow entity, as the designer left it (partly wired or not
runnable); BaseApi then dry-runs it and, only when the dry run finds no errors, aligns the real entities in the
database with it in one transaction. In the user's words: like source code with syntax errors — the
compiler shows the errors, but the file can be saved at any time. Whether the workflow can start is not this
phase's question: BaseApi's start validators run when a workflow is started.

Decisions taken with the user (2026-10-07):

1. **Load with GETs only**, then work offline. No `POST /workflows/{id}/validate` (start checks are not this phase).
   The live-light polls (`GET /orchestration/live`, `GET /processors/liveness`) stay as they are (SignalR later).
   *(Superseded 2026-10-10: the liveness hub pushes both; the studio polls the GETs only as its fallback, studio spec §6.4.)*
2. **Every edit is virtual**: the workflow, steps (fields and wiring), assignments, processors, schemas and caches
   are edited as copies in the browser.
3. **Ownership.** Steps and assignments belong to one workflow and are never shared (the studio guarantees it by
   giving every new one a new id). Processors, schemas and caches are shared: **last write wins**.
4. **For now, update only** — except assignments, which are created, updated and deleted. No step, processor,
   cache or schema is created or deleted from the designer in this plan.
   *Superseded in part (2026-10-10, copy, paste and delete, §4.5): steps and caches are created by Ctrl+V and deleted
   by Delete; processors and schemas still never are.*
5. **A schema edit is a background copy.** Editing a processor's schema makes a virtual schema with a new id,
   copying the original's **name and version**, holding the edited definition; Save inserts it and re-points that
   processor's slot. The designer does not notice. Other processors keep the original.
6. **Save stores the design on the workflow entity regardless of validity**: the graph as drawn, the layout and the
   virtual entities' changes go to the workflow row (a new `Design` column next to `Layout`), committed on their
   own. Then BaseApi **dry-runs** the virtual entities through **ordered stages**, collecting every error and
   writing nothing. **No errors: BaseApi aligns the real entities with the design in one transaction. Errors: the
   real entities are not touched**, and the errors are shown in the Problems and Output panels (since 2026-10-09:
   pinned at the top of Output, the only message panel, §4.1). Errors are only
   ever the result of pressing Save: they are not stored anywhere, and opening a workflow shows none (it runs no
   dry run). The stored design is **last write wins** between two designers.
9. **The browser session keeps unsaved edits** made since the last Save, so a refresh never loses work.
8. **Opening a workflow creates virtual entities with the same ids** as the database rows (GETs only). The one id
   exception is the schema background copy (§1.5).
7. **Wires can be dropped anywhere.** A wire with no affinity is drawn **grey and dashed**, with an open end where
   it was dropped. The legend gains it; **"parked" is removed** (an unwired step is an ordinary step).

## 2. Scope

In: the virtual design (load, edit, session), the Inspector writing to it instead of BaseApi, assignment create /
update / delete on it, the schema background copy, free wire drops and the no-affinity wire, Save by dry run then one write
(a new BaseApi endpoint), Problems and Output for save results, the legend.

Out: creating or deleting steps, processors, caches or schemas; start checks; SignalR; the Toolbox; deleting a
workflow; several designers on one workflow at once beyond the per-entity conflict check (§6.3).
*(2026-10-10: steps and caches are now created and deleted, §4.5.)*

## 3. The virtual design

### 3.1 Load

Opening a workflow reads, with GETs only: `GET /workflows/{id}/graph` (the workflow, reachable steps, their
processors and schemas, the workflow's assignments and caches, the layout), then `GET /steps/{id}` for the unwired
steps the layout lists and `GET /processors/{id}` / `GET /schemas/{id}` for what they name (as today). The validate
call is removed; nothing is marked broken on load.

The graph answer also carries the workflow's **stored design** (§4.2), if any. These DTOs are the **base**; the
**design** is the base with the stored design, then the session's unsaved edits, laid over it. So an unfinished
design comes back exactly as left, on any machine.

### 3.2 What the design holds

The plan 4 draft grows into the design. Besides what it holds today (block positions, `next`, `entries`, wire
shapes, junction contacts), it holds:

- **Entity edits**: per kind (`workflow`, `step`, `processor`, `cache`, `assignment`) and id, the changed fields
  (only fields that differ from the base).
- **Assignment operations**: per step of this workflow, *create* (payload), *update* (payload) or *delete*.
- **Schema copies**: per processor slot (`input` / `output` / `config`), a virtual schema `{ id, name, version,
  description, definition }` — id new, name / version / description copied from the slot's current schema
  (`<processor>-<slot>` and `1.0.0` when the slot was empty).
- **Loose wires** (§5): wires with no affinity, with their source and the point where they were dropped.

What the canvas, the Inspector and the panels show is always the design. The session keeps the edits made since
the last Save (the existing per-tab session, spec §6.1), so a refresh never loses them. **Discard design** drops
the unsaved edits and returns to the last saved design.

### 3.3 The Inspector

The Inspector edits the design, never BaseApi:

- Editing a field of the workflow, a step, a processor, a cache or an assignment changes the design.
- **Create** / **Remove** assignment on a step change the design (Remove no longer checks other workflows:
  assignments are not shared).
- Editing a schema (from its processor) makes or updates the slot's schema copy (§1.5); the Inspector shows the
  copy as the schema, with the same name and version.
- The per-entity save, re-GET and write tokens of plan 3b are removed. The dirty mark, the close guard and Discard
  cover every kind of change.

## 4. Save

### 4.1 The studio

**Save** (toolbar, enabled when the design differs from the base) sends the design's changes in one request to
`PUT /workflows/{id}/design` (§4.2) and waits. Saving never asks whether the design is valid. While saving, the
design is read-only.

When the answer comes:

Either way the design is now stored on the workflow, and the session's unsaved edits are cleared.

- **Aligned** (the dry run found no errors): the real entities match the design; the studio reloads with GETs
  (§3.1); Output logs "Saved and applied" with the time.
- **Not aligned** (errors): the real entities are unchanged; the canvas still shows the stored design, and Save can
  be pressed again after fixing. Each error goes to **Problems** (one row: entity, field, message; clicking it
  selects the entity), and a summary line to **Output** ("Saved; not applied: N errors", time).
- Errors live only until the next Save, a Discard, or closing the workflow; they are never stored.

**Amended 2026-10-09 (user decisions): one message panel, and Save logs what really happens.**
- The **Problems panel is gone**; **Output** is the only message panel. The active document's current problems (the
  live short circuits of the drawing, then the errors of its last Save: exactly what Problems listed, same names, same
  click-to-pick, a wire row picking both wires of an overlap) are **pinned at the top of Output as red rows** (a list,
  each row focusable, Enter or Space picks); below them the log (`role=log`), oldest first, error lines red. A dock
  layout or session that still holds a Problems pane loads without it and with no empty place where it was (a group it
  leaves empty goes; the document area stays).
- **Save logs, in order:** "Save started: sending …" (what the request carries), BaseApi's own log line by line
  (`BaseApi · …`, §4.3), the verdict ("Saved and applied" / "Saved; not applied: N errors"), the re-read
  ("graph re-read: N steps, M links", or why it failed, red), then the alignment: short circuits held back
  ("1 short circuit held back: N links not written", red), how settling changed the drawing (compared as drawn: wires
  changed / added / removed, "agrees with BaseApi's links", or "the workflow's own wires, nothing to settle"), and what
  stays stored ("design stored on the workflow, not applied", red, or "nothing left stored"). A Save with no answer is
  "Not saved: …" in red. Every line has its time and workflow name. Output keeps the **last 500 lines** and is kept in
  the session (`output`, optional, version still 1), so a refresh keeps it. An older BaseApi without a log gives one
  line saying so and its errors as red lines.
- **Amended 2026-10-10 (user): a Save spinner.** While a Save runs (from the click through BaseApi's answer, the re-read
  and the alignment) the Save button shows a small CSS spinner in place of ⤓ ("Saving…", disabled, `aria-busy`), and
  the workflow's document tab shows one beside its name wherever the tab is. Once shown it stays at least 300 ms (the
  visual only). With reduced motion it pulses instead of turning. A polite live region says "Saving <name>…" and then
  "Saved <name>" or "Not saved <name>" (the details stay in Output).
- **Amended 2026-10-10 (user):** Output has a **Clear** button (accessible name "Clear output", tooltip "Clear the
  messages; current problems stay"; disabled while the log is empty), also at the top of the Output tab's menu. It
  empties the log of every workflow (the log is shared) and the session's copy, so a refresh keeps it empty; the pinned
  problems are live state and stay.
- **Amended 2026-10-10 (user ruling): the Inspector shows the design graph's entity**, saved or not: each field is the
  design's edit when there is one, else the entity as the loaded graph holds it (the graph the canvas and the read-outs
  draw from). It never shows a copy of its own that could lag: after an applied Save the edits are cleared and the graph
  read again, so it shows what BaseApi holds at once, with no re-pick; after a not-applied Save, a Discard or a Revert,
  the design as it then stands. The entity's own GET only fills what the graph does not carry (a schema's definition, an
  assignment's name, version and description) and is keyed to the document's read (`generation`): a read made before
  the workflow was read again is dropped, and the shown entity is read once more after each re-read. An edit is judged
  against the same base (whether it is typed back, and the `updatedAt` stamp Save sends): the graph's entity, the read
  only of the current generation; an entity the graph does not fully carry takes no edit, its fields disabled with
  "Reading what BaseApi holds now…", until that read lands. Clear during a Save keeps that Save's "Save started" line.

### 4.2 BaseApi: `PUT /workflows/{id}/design`

A new endpoint; `PUT /workflows/{id}/graph` (atomic) stays as it is. The workflow entity gains a nullable jsonb
**`Design`** column (one migration), returned by `GET /workflows/{id}/graph` with the layout. The body is the
whole stored design, every change of the virtual entities relative to the real ones:

- `workflow`: changed fields with the loaded `updatedAt`; its entry step ids, cache ids (as lists, when changed);
- `steps`: changed steps (fields and/or next step ids) with their loaded `updatedAt`;
- `processors`: changed fields, and slot re-points to schema copies;
- `caches`: changed fields;
- `schemas`: the schema copies (new rows: id, name, version, description, definition);
- `assignments`: per step, create / update (payload) or delete;
- `layout`: the canvas layout, including loose wires.
- *(2026-10-10, §4.5, all optional, so older studios and older stored designs read as before)* `newSteps` (id from the
  studio, `copyOf`, `processorId`, `fields`, `nextStepIds`), `newCaches` (id, `copyOf`, `fields`), `deletedSteps` (id,
  the loaded `updatedAt`), `deletedCaches` (id); an assignment `create` may carry `copyOf`.

### 4.3 Store, dry run, then align

**First**, BaseApi stores the body on the workflow row (`Design`, and the layout in `Layout`) and commits, with no
conflict check (last write wins) and no validation beyond the body's shape. This always happens.

**Then** BaseApi opens one transaction and runs the stages below in order, applying every entity it can and **collecting
every error** (a failing entity is skipped, its dependants are skipped with their own error, and the stages go
on). At the end: **any error → roll back** (the real entities are untouched; the stored design stays) and answer
the errors; **no error → commit**, and the stored design is emptied (the real entities now hold it). One
transaction, so the real entities never hold part of a design.

The stages:

1. **Schemas**: insert each copy (field rules of the schema CRUD, definition a valid draft 2020-12 schema).
2. **Processors**: update fields; re-point a slot to its copy. A re-point to a copy that failed in stage 1 is
   skipped, with its own failure.
3. **Caches**: update fields.
4. **Steps**: update fields.
5. **Wires**: replace each changed step's next step ids.
6. **Assignments**: create (new row, linked to this workflow), update in place, delete (unlink, then delete the
   row).
7. **Workflow**: fields, entry step ids, cache ids and the assignment links stage 6 produced.
8. **Deletes** *(2026-10-10, §4.5)*: the steps and caches the design deletes, last.
(The layout was already stored in the first step.)
*2026-10-10:* stage 3 first creates `newCaches`, stage 4 first creates `newSteps`, stage 5 also writes the new steps'
next steps (every step exists by then), stage 6 creates a pasted step's assignment (its fields over its `copyOf`
row's), stage 7 links new caches through the cache list the studio sends.

Rules for every stage:

- **Only the field rules the CRUD endpoints already enforce** decide a failure (and the workflow's "at least one
  entry step"). No cycle, schema-edge, payload or liveness check.
- **Owned entities** (the workflow, its steps, its assignments) keep the conflict check: an entity whose stored
  `updatedAt` is newer than the loaded one fails with "changed by someone else since you opened it".
- **Shared entities** (processors, caches) have **no conflict check**: last write wins.
- A database error on one entity (a foreign key, a constraint) is caught at that entity (a savepoint), recorded
  as its error, and the stages go on, so one save reports every error at once.
- The answer is `200` `{ applied: boolean, errors: [{ kind, id, stage, field, message }] }` (`applied` is true
  exactly when `errors` is empty; the design is stored either way). Only a malformed body (not a design at all) is a `400`; a workflow that does not
  exist is a `404`.
- **Amended 2026-10-09:** the answer also carries `log: [{ stage, level, kind, id, message }]` (optional, so older
  studios ignore it), in the order things happened: the store ("design stored on the workflow …", stage `store`), "dry
  run started", then for each stage one line when it starts ("steps: 2 steps to check", or "schemas: nothing to do"),
  one per entity it changed with what changed ("step 'a': name 'a' → 'a2'; entryCondition PreviousCompleted →
  PreviousFailed", "step 'a': next steps a2→e added, a2→c removed", "workflow 'wf': entry steps e added", "assignment
  'x' on step 's1': created …"), one per refused entity (level `error`, its field and message), and one with its counts
  ("steps: 1 updated, 1 unchanged, 1 refused"; `error` when any was refused); then the outcome (`outcome`): "dry run
  passed: N changes, no errors" and "committed: the entities hold the design; the stored design is emptied", or "dry
  run failed: N errors on M entities" and "rolled back: no entity was changed; the design stays stored on the
  workflow" (both `error`). Only what a stage actually wrote is described: an entity it looked at and left as it was
  (a wiring-only step in the steps stage, an assignment already gone) is counted as unchanged, with no line. Long
  values (a description over 40 characters, a payload) read "description changed"; ids the log cannot name show
  their first 8 characters. `kind` is the entity kind, `stage` for a stage's lines, `outcome` for the verdict; `id` is
  null on those.

### 4.5 Copy, paste and delete (the user's decisions, 2026-10-10)

All on the design graph only, virtual until Save, and part of the canvas draft (`Draft.blocks`), so undo, redo, the
session and the stored design cover them like any drawing.

- **Keys**, only while the canvas has focus (never from the Inspector or any text field): **Ctrl+C** copies, **Ctrl+V**
  pastes, **Delete** deletes (Cmd on a Mac). **Backspace no longer deletes anything.** No menu entries or buttons.
- **What is copied**: a single pick or a multi-select. The workflow (hub) is never copied, pasted or deleted: in the
  selection it is skipped silently and the rest proceeds. Steps are copied with the fields the design shows and their
  assignment (its fields, payload included); caches with their fields. Wires: every wire running between copied items
  (each end on a copied step or joined on a copied wire, none on anything left out; junctions among them keep their
  `at`; an open end stays open) comes along, picked or not; a picked wire with no end on a copied item is copied as a
  **free wire**: both ends open where it is drawn, its drawn shape kept (direction-less and grey when pasted, rule D;
  laid on another wire it is an overlap short circuit like any hand-placed wire). A picked wire with one end on a copied
  item and one on something left out is left out (judgement call).
- **Paste** gives every replica a **new id**: a step is a new step entity on the **same processor** (processors are never
  copied), its assignment a new assignment entity with the original's fields (BaseApi starts it from the original's row,
  `copyOf`, so name, version and description come along), a cache a new cache entity, a wire a new design wire
  (`w:{guid}`). Names and versions stay the same (unique names differ by id). The pasted items become the selection.
- **Where it lands** (the user's rule as amended the same day): the group's offset from the originals is first
  +32 / +32 (4 grid steps), then +64 / +64 for the next paste of the same clipboard, and so on (the cascade). When any
  pasted block, grown by one grid step, would overlap a block already on the canvas (steps, caches, the hub) or, pasted
  into the workflow it was copied in, the area of its originals, the group moves as one rigid unit to the nearest free
  offset from there on the 32 px grid: rings of growing size, nearest first, then right and down before left and up
  (deterministic), through a box index over the blocks. In the workflow it was copied in, +32 / +32 always lies on the
  originals, so the copies land beside or below them. Copied wires keep their shapes moved by the same offset.
- **The clipboard** is the studio's own (one for every open workflow: copy in one document, paste in another) and is
  kept in the session, so a refresh keeps it. A step pasted into a workflow whose graph does not carry its processor
  brings that processor (and its schemas) along for drawing only.
- **Delete** removes the picked steps and caches from the design with every wire that has an end on a deleted step;
  picked wires go as before; a wire joined on a wire that goes opens where it is drawn. A pasted block deleted again is
  simply gone. **Save** then deletes the entity (a step's assignments of this workflow with it), but **refuses** with an
  error (red in Output, pinned and logged) while anything still uses it: another workflow's entry steps, any step's next
  steps, another workflow's assignment for the step, or (a cache) any workflow's cache list. Like every other refusal,
  the whole Save rolls back. A step is owned: a stale stamp conflicts. Undo restores.
- **Group drag** (and arrow nudge): picked wires move with the picked blocks as one unit: their bends, open ends and held
  ends shift by the same amount; a fully automatic wire keeps being routed as before; a wire not picked keeps today's
  behaviour.
- **Save** sends `newSteps` (fields as copied with the Inspector's edits over them, next steps from the circuit),
  `newCaches` (and the workflow's cache list with them), the pasted assignments as creates with `copyOf`,
  `deletedSteps` (with the loaded stamps) and `deletedCaches`; deleted steps leave every list sent. The layout places
  the pasted blocks (its `parked` lists them), so a reload draws them where they were pasted; a stored design that was
  not applied reads its blocks back (positions from its layout), and the loader reads the processors its pasted steps
  run.
- **BaseApi** (backward compatible): new ids are refused when taken by a different row ("Not created: a different step
  with this id already exists."), a pasted step needs its processor, the CRUD's create rules judge the fields; a pasted
  step that was not created fails its wires and its assignment.
- **Review rulings (2026-10-10):**
  - A cache's root is unique (`uq_cache_root`, its L2 address): a **pasted cache gets a new root** at paste time,
    `<root>-copy`, then `-copy-2`, `-copy-3`, … unique against every root the studio knows (the open workflows'
    loaded caches, their pasted caches and Inspector edits, the clipboard). The root stays editable. BaseApi checks it
    in the caches stage, on create and on a root change: "Root 'r' is already used by cache 'x'." (field `root`).
  - A deleted step keeps the `updatedAt` it was loaded with (`Blocks.stamps`, `deletedSteps[].updatedAt` in the stored
    design) through a refused Save, a reopen of the stored design and a refresh; Save never sends a later re-read's
    stamp, so a change someone made meanwhile is "changed by someone else since you opened it".
  - The clipboard carries a step's assignment's own name, version, description and payload (the graph read carries
    them); `copyOf` is for the log and fills only what is not sent, so a cut (copy, delete, Save) then paste in another
    workflow saves.
  - A design deletes only its workflow's own steps (its entry steps reach them, its stored layout places them, or its
    stored design already deletes them) and caches (its cache list, or its stored design's deletes): "Not deleted: not a
    step of this workflow." Ids of all zeros (new ids, `copyOf`) are a 400. A create whose row already exists exactly
    as this save would create it (a Save sent again after its answer was lost) counts as unchanged. A wire joined on a
    free picked wire is copied with it. Log lines "step 'x' created (copy of 'y')", "cache 'z' created (copy of
  'c')", "step 'x' deleted" (", with its assignment 'a'"), "cache 'z' deleted"; refusals "step 'b': Not deleted: still
  used by workflow 'w' (an entry step there)" as error lines. A request naming one id in two of create / change /
  delete is malformed (400).

#### 4.5.1 Removing a processor from a step (the user's rules, 2026-10-10)

- A click on a step's processor picture picks the processor (`{ kind: 'processor', id: stepId }`, Ctrl toggles; the
  die is marked, the block is not picked); the rubber band still picks blocks. Copy, paste, arrows and group drag
  ignore a processor pick.
- Delete with processors picked removes each from its step: the step points at no processor (`Step.processorId`
  null) and stays with its wires, next steps, assignment and entry condition; the step becomes the pick. The
  processor entity is never deleted (orphans: to discuss). Mixed picks: steps, caches and wires are deleted as before;
  a picked processor whose step is deleted too is moot.
- Kept in the draft (`Blocks.unassigned` for the workflow's steps; a pasted step's own `processorId: null`), so undo,
  redo, refresh, a refused Save (the stored design's step change `processorId: null`) and copy/paste carry it.
- No limit: a step may stay without a processor. It is drawn with an empty slot, a dashed amber (`--warn`) outline with
  a ⚠ and a transparent background (nothing behind the glyph), tip "No processor: drag one from the toolbox. Save will
  fail until this step has one." The Inspector's Processor row and the step read-out say "none". No processor picker
  anywhere: the future toolbox drags one onto a step.
- Save is not blocked in the studio: it sends the step (`steps[].fields.processorId: null`, or a pasted step's
  `processorId: null`) and BaseApi's steps stage refuses it on `processorId`: "No processor: drag one from the
  toolbox." The dry run fails, everything rolls back, the line is red in Output. A step's `processorId` field naming
  another processor must name one that exists ("Its processor no longer exists."). The database rule is unchanged: a
  stored step always has a processor, so Start never meets one without.

#### 4.5.2 Deleting a workflow (the user's rules, 2026-10-10)

- The menu strip's File is **Workspace**; Open workflow… is **Load workflow…** (Ctrl+O), in the menu, the picker's
  title, the document area's + and the empty-area hint.
- The canvas's Delete never deletes the workflow, picked alone or with steps and wires (the hub stays, and stays
  picked). A workflow is deleted only by **Workspace › Delete workflow…**, on the active document.
- The workflow is special (its id is how a running copy is stopped): it is never deleted while it runs, and a start
  never races its deletion. The order:
  1. A fresh liveness reading: `GET /orchestration/live` asked after the request (the status the studio shows never
     counts). Running: refused in red ("Stop it first: deleted while running, it could never be stopped"); no reading
     within 5 s: refused ("could not confirm it is stopped").
  2. BaseApi's dry run, `POST /workflows/{id}/delete?dryRun=true`: it reads `skp:live` itself, then does the whole
     deletion in one transaction and rolls it back. Its lines go to Output; any error stops here, in red.
  3. Only then the warning: what goes (the workflow, N steps, M assignments: the dry run's counts), what stays (its
     caches, only unlinked; its processors, untouched), that the id is gone forever, and that an unsaved draft of it
     is dropped. Exactly two buttons, **Cancel** (the default: primary and focused; Escape too) and **Continue**.
     Cancel sends nothing (Output: "Delete cancelled").
  4. Continue: `POST /workflows/{id}/delete`. BaseApi sets `skp:deleting:{id}` (TTL 2 min) before it reads `skp:live`
     again, deletes and commits, then sets the tombstone `skp:deleted:{id}` (TTL 7 days), removes what the workflow
     projected (`skp:wf:{id}`, its cache dictionaries `skp:wf:{id}:cache:*`, its deleted steps' `skp:step:{id}`) and
     drops the marker. A start is refused (422, gate `workflowDeleting`) while either key exists, and a start message
     queued earlier is acknowledged without projecting.
  5. Deleted: the document closes (its draft dropped, no save question), and the workflow leaves the picker, the
     liveness state and the session; Output keeps the lines under its name; the clipboard keeps what was copied.
- What goes with it: its own steps (those its entry steps reach and its layout places, as the design save's ownership
  rule), their next-step links, its assignments (linked to it, or of its steps), its entry-step and cache links. Caches
  and processors are never deleted. Refused, nothing deleted, when another workflow uses one of its steps or
  assignments (its entry steps, its layout, a step of it listing it as a next step, its assignment link): the
  designer never shares them, old data might.
- The plain CRUD `DELETE /workflows/{id}` is refused (422, gate `workflowRunning`) while the workflow runs, and while
  a deletion of it runs; it deletes the row only, as before.

#### 4.5.3 A new workflow (the user's rules, 2026-10-10)

- **Workspace › New workflow** (Ctrl+N where the browser lets the page have it; Chrome keeps Ctrl+N for a new window,
  so there the menu is the way) opens a blank document: only the workflow hub, at its usual spot on the left, shown at
  100 % at the canvas's left (not a Fit, which would centre it). Its id is made by the studio; the workflow exists only
  in the studio (a virtual workflow) until its first Save.
- Its name starts as `untitled` (or `untitled-2`, … when a listed or open workflow has the name), its version 1.0.0;
  both are edited in the Inspector like any workflow's fields. The Load picker does not list it.
- Until the first Save that BaseApi applies: Start, Stop (F5, Shift+F5) and Workspace › Delete workflow… are
  disabled ("Not saved yet: BaseApi has no such workflow"); it is always unsaved (the tab's dot; closing asks Save or
  Discard, and Discard drops it entirely); a refresh keeps it (the session marks it `virtual` and the document is built
  again locally, its design with it). Steps come into it by paste (and later the toolbox).
- Save sends `newWorkflow: { fields: { name, version, description, cronExpression } }` with no workflow stamp. BaseApi
  creates the workflow with the route's id in a first stage, **create**, inside the dry run's transaction, with the
  design's layout; its fields are judged by the workflow CRUD's rules (its entry steps are the workflow stage's), and
  its name must be no other workflow's ("Not created: a workflow named '…' already exists."). The workflow stage then
  always runs for it, so the CRUD's own rule applies: at least one entry step. Any error rolls the creation back with
  everything else, and nothing is stored (there is no row to store a design on); the studio keeps the design, unsaved,
  and reads nothing back. A workflow with the id that already holds exactly these fields is this creation's retry (an
  ordinary save from there, no stamp checked); one with other fields is refused before anything is stored.
- Applied: the document is read again from BaseApi and is an ordinary workflow from then on (Start, Delete, the
  picker's list).

#### 4.5.4 A cache's items as a table (the user's decision, 2026-10-10)

A cache's `items` reaches L2 as a string-to-string dictionary (`skp:wf:{id}:cache:{root}:{key}`), so the Inspector edits it
as a key/value table (field kind `dict`, `panels/DictEditor.tsx`, `store/dict.ts`), not as raw JSON:
- One row per entry in stored order; a click edits a cell, Enter or leaving it commits, Escape puts the cell back;
  `+ Add item` adds a row with its key focused; × deletes a row; the header counts the items. Tab: key, value, next key.
- BaseApi's rules (CacheDtoValidator): a key empty, containing ':' or written twice marks its row red with the reason and
  is not committed until fixed (the other rows still are; the red row stays as last committed); text over 1 MB is not
  committed. Values are free strings.
- Each commit writes the field as a compact JSON object: an ordinary Inspector field edit (design graph, refresh, Save).
  Inspector field edits are not in the design's Undo history (as for every field); Revert drops them.
- The JSON toggle shows the same dictionary as pretty text; a valid edit commits on leaving the box.
- Stored text that is no string dictionary (bad JSON, not an object, a non-string value, an empty or colon key, a key
  twice) is shown as text with the reason; the table toggle is off until it is one.
- Postgres keeps `items` as jsonb: after a Save the keys come back in jsonb's own order.

#### 4.5.5 The Toolbox (the user's decisions, 2026-10-11)

A dock pane, docked left by default (`panels/Toolbox.tsx`): what can be dragged onto a workflow's canvas. With the Toolbox on
the left and the Inspector on the right, each is a column of the dock's whole height beside the document area (which
shares its own column with Output): floated or popped out and docked back, such a pane returns at the layout's edge
(`Home.edge`, `spansEdge`), not beside the document area, where it would land inside that column. Each tile is
drawn with the canvas's own art. Lists come from BaseApi (`GET /processors`, `/caches`, `/schemas`), read when the pane
opens and after every Save that was answered; a search box filters processors and caches by name (caches by root too).
- **Blocks:** an empty step and an undecided wire. **Processors:** every processor, drawn as a step draws it, with its
  liveness ring in its health colour (the SignalR liveness store, live). **Caches:** an empty cache and every cache.
- **The drag** is the pointer's (`design/toolDrag.ts`, not the browser's drag and drop): a ghost follows it; over a
  workflow's canvas (every open one, a new unsaved workflow too) a dashed box shows where a block lands (centred on the
  pointer, on the 8 px grid), a dashed line where a wire lands; release there drops, release elsewhere or Escape cancels.
  A canvas refuses drops while its Save runs ("saving: wait for the answer"). A drag cannot cross browser windows: a
  canvas in a pop-out window takes drops from a Toolbox in that same window only.
- **New or empty is a new virtual entity** (`design/toolDrop.ts`, as a paste makes; one history step; it becomes the pick):
  - an empty step: name `step` (`step-2`, … when taken), version 1.0.0, no processor (the amber ⚠ slot; Save's dry run
    refuses it until it has one), sent in `newSteps`;
  - an empty cache: name `cache` (numbered when taken), version 1.0.0, a root no known cache has (`cache`, `cache-2`, …;
    every cache BaseApi listed and every open workflow's), items `{}`, sent in `newCaches`;
  - a wire: a free wire, open at both ends, 96 px horizontal from the pointer.
- **An existing processor or cache is the same entity, never a copy:**
  - a processor drops only on a step: over one the step lights green, "assign processor" ("replace processor" when it
    has one); anywhere else "drop on a step", red, and the release does nothing. A new step keeps it as its own
    `processorId`; a workflow step is marked in the blocks' `assigned` (step to processor; dropping the processor it was
    loaded with clears the mark; a removed processor's `unassigned` mark goes). Save sends the step's `processorId` field.
  - a cache is linked: the blocks' `linked` holds its snapshot and place, the workflow's cache list gains its id (Save's
    `cacheIds`), no cache row is created; its Inspector edits are sent as any cache's. One already in the workflow is
    refused, "already in this workflow", and that cache lights red. Delete of a linked cache drops only the link.
- The processor and schemas a drop needs are kept in the blocks' `refs`. A Save BaseApi refused keeps them: the stored
  layout carries `linked` (the caches' snapshots) and `refs`; the stored body's step change names the assigned processor.

- **A click on a tile (2026-10-11)** — a press let go before it moved 4 px — is not a drag. An existing processor or cache
  is picked for the Inspector, read-only (the Toolbox only drags; dropped on a canvas the Inspector edits it there): one
  tile at a time, highlighted in the selection's blue; the same tile again keeps it; a template (empty step, wire, empty
  cache) picks nothing. A hidden Inspector stays hidden but what it shows switches. A click on a canvas (a selection or a
  pick there) or a drop takes the Inspector back. Not kept in the session (a refresh starts with no Toolbox pick).
- **The active design shows through (2026-10-11):** a processor or cache the active document's design changed (name,
  version, description; a cache's root and items too) is drawn on its tile, and shown in the Inspector when picked, as
  that design has it, with the "unsaved changes" orange mark; after a Save the lists are read again and BaseApi's values
  show. Items that differ only in spacing or key order are no change.
- **An empty cache (2026-10-11)** — no items, on the Toolbox's tile and on any canvas — is drawn with the empty step's
  dashed rectangle, in the muted grey and with no ⚠ (it saves fine), in place of the honeycomb and the root plate; with
  an item it is drawn as usual.

#### 4.5.6 AI drawing (the user's design, 2026-10-11)

A toolbar button, **✦ AI drawing**, asks a model (Kimi K3, `kimi-k3`, at Moonshot) to redraw the document's design by the
drawing rules (17, in priority order: correctness — the meaning, no short circuits, nothing through a block; readability —
don't cross, straight lines, centred inputs with equal gaps, outputs placed by the forward inputs, one trunk per fan-in or
fan-out, clean T junctions, no staircases; layout; finish). The flow:

1. The studio snapshots the relations: every step's next steps and the entry steps as Save writes them (`writtenLists`),
   the caches, and the nets with their families (`relationsOf`).
2. It sends the rules, the answer schema and the graph (blocks with boxes, step sides, centres and landing ranges; wires
   with ends, families, drawn points and bends) to `POST /ai/chat/completions`, the studio's own nginx route: nginx adds
   the key from the `skp-ai` Secret, so it never reaches the browser. BaseApi is not involved.
3. The answer (JSON only: `blocks` top-left corners; per wire `tail`/`head` as `{y}` on its step, `{auto:true}` or a
   `{junction:{host,x,y}}` on a host's drawn line; `bends` or `null`) is checked (known ids, finite numbers, an end
   stays on its own step, a junction only for an end already on a wire) and applied to a candidate draft.
4. Applied as one history step only when the candidate's relations equal the snapshot and no short circuit is added;
   otherwise a red Output line says why and the draft is unchanged. Never partially. Output reports blocks moved, wires
   reshaped, crossings and short circuits. A design changed while the model was drawing is not overwritten.

No key: the route answers 503 and the studio says "AI drawing is not configured". Cancel aborts; 180 s at most.

### 4.4 The schema copy's version

Plan 1's atomic save bumps the copied version's patch (`1.2.3` → `1.2.4`); the design save copies it unchanged
(§1.5). Schemas have no unique rule on name + version; copies are told apart by id (lists already show BaseApi's
entity-name format with part of the id).

## 5. Wires dropped anywhere

- A wire end (head, tail, contact, arrow of a joined wire) or a new wire may be released anywhere. Released on a
  place a wire can join (a step for a head; a step or the hub for a tail; a same-colour line for a junction), it
  attaches as today and takes its target's colour.
- **Cycles are allowed** (a design may be anything; starting is when cycles are judged). The "would make a loop"
  refusal is removed.
- A wire **still cannot attach to itself** (a step to itself, a line to itself): that drop snaps back.
- Released anywhere else — empty canvas, a cache, the hub as a target, a step it already goes to — the wire becomes
  a **loose wire**: grey, dashed, with its tail on its source and an **open end** (a small open circle) where it
  was dropped. It is kept in the design and the layout; it is not a next step, so the database never sees it. Its
  end can be dragged again onto a place it can attach to, which makes it an ordinary wire.
- While a wire end is dragged, every place still gets the plan 7 §6.1a feedback: green with what the drop does,
  or grey "loose wire" where it would become one.
- The legend gains the loose wire (grey dashed, open end) and loses "parked". Unwired steps look like every other
  step (no dashed outline).

## 6. Edge cases

1. **A save with errors** stores the design but leaves the real entities as they were: never part of a design.
2. **Someone else changed a step** since it was opened: that step fails with the conflict message; the designer
   can Discard design (reload) or keep it.
3. **Two designers** on one workflow: the stored design is last write wins; when aligning, owned entities are
   still protected per entity (§4.3) and shared ones are last write wins, as decided.
4. **A loose wire** is never sent as a next step; reopening shows it from the stored layout.
8. **Reopening a workflow with a stored design** (on any machine) shows the design as left, with no errors until
   the next Save.
5. **A schema copy whose insert fails**: an error; its processor's re-point is skipped with its own error; nothing
   is written.
6. **No entry step**: the workflow stage reports "at least one entry step"; nothing is written.
7. **Not startable but valid** (loops, unwired steps, loose wires, broken schema edges): no error; the design is
   written. Starting is when those are judged.

## 7. Structure

- BaseApi: the `Design` column and migration; `Features/Workflow/Design/` — request and outcome DTOs,
  `WorkflowDesignSyncer` (store, then the stages), the endpoint; `GET /graph` returns `Design`; reuses the CRUD
  validators and mappers.
- Studio: `design/` grows the design model (entity edits, assignment operations, schema copies, loose wires) and
  `applyDesign`; `app/loadDocument.ts` drops validate; `app/inspectorService.ts` becomes design edits;
  `app/saveDesign.ts` builds the request and folds the outcomes back; Problems / Output show save results;
  `canvas/Legend.tsx`, `canvas/edges/CableEdge.tsx` draw the loose wire.

## 8. Testing

- **BaseApi**: unit tests for each stage; integration tests (Postgres) for: a design with one invalid step is
  stored, leaves the real entities untouched, and reports every error (not only the first); the stored design is
  returned by `GET /graph` and is last write wins; a valid design aligns the real entities in full and empties the stored design; the per-entity conflict;
  last write wins on a processor; the schema copy with the same name and version and the re-point; assignment
  create / update / delete; a failed schema copy skips its re-point; a database error on one entity is reported
  and the others still report theirs; a not-startable design (a loop, unwired steps) is written.
- **Studio, Vitest**: the design model and `applyDesign` (base + stored design + session edits); the Inspector
  writing to the design; the save request built from a design; an applied answer reloads; an error answer keeps
  the design and fills Problems / Output; opening a workflow makes no write call; loose wires.
- **Playwright, real mouse and keyboard, on the dev server and the deployed studio**: the e2e tests stop being
  read-only for Save only. Each save test works on a **throwaway workflow** it creates through BaseApi's CRUD in
  its setup (steps, processor reuse, assignments) and deletes in its teardown, so live workflows are never written.
  It edits on the canvas and in the Inspector, saves an invalid design (checks Problems / Output, that the
  real entities are unchanged, and that reopening in a fresh page shows the stored design), fixes it, saves again,
  reopens the workflow and checks everything was applied. Loose wires: dropped on empty canvas, grey dashed with an open end, kept over a refresh.
