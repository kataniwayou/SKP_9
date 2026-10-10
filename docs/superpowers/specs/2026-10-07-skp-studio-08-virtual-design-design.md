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
(The layout was already stored in the first step.)

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
