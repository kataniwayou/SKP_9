# SKP Valence — spec and handover (2026-10-15)

A new member of the SKP tool family: it shows **every SKP entity row as a molecule** (rows are atoms, foreign keys
are arrows) and lets the user **create, read, update and delete** them there. It does **not** replace SKP Studio
(the workflow designer, `src/WorkflowStudio`); it sits beside it with the **same theme and the same dock panel**, so
the family looks and behaves alike. Name approved by the user: **SKP Valence** (an atom's combining power — how many
bonds it can form).

This file is self-contained: a new session can continue from it alone.

---

## 1. Where things are

| What | Where |
|---|---|
| Worktree (all Valence work) | `C:\Users\UserL\source\repos\SK_P10-molecule-studio` |
| Branch | `feature/molecule-studio`, from `2a781de` (last commit of `feature/in-process-post`); local only, never pushed |
| App | `src/Valence` (beside `src/WorkflowStudio`) |
| This spec | `docs/valence/valence-spec.md` |
| Molecule mock (the approved 3D diagram, three.js r128, one HTML file) | `docs/valence/molecule-mock.html`; published copy https://claude.ai/artifact/A2vBhYESoirRLmRMJbX5iD |
| Main repo folder | `C:\Users\UserL\source\repos\SK_P10` on `feature/in-process-post` with the user's own uncommitted work — **never touch it from Valence work** |
| Earlier design doc | https://claude.ai/artifact/6AVHwL74RnbVunMr9CRP7q — **outdated**: it describes hard-coding the rules in the frontend; the user reversed that (see §4) |

Commits on the branch so far: `137b5e1` — BaseApi `GET /model/relations` and `GET /workflows/{id}/molecule` with 13
tests (a cherry-pick of `f7309c9`, which was reverted on an earlier, now deleted branch). Everything else in the
worktree is uncommitted or in the commit that carries this file.

---

## 2. Approved decisions

1. **Own app** at `src/Valence`, own image (`valence:local`) and own k8s manifest — not a mode inside SKP Studio.
2. **Same look and dock as SKP Studio.** The theme is SKP Studio's existing dark "blueprint" theme (tokens in
   `canvas/tokens.css`; ground `#0A1220`); the dock is SKP Studio's `src/dock` (dockview-react 8.4.1), copied.
3. **One document, always open: the whole project.** Every row of all six entity tables is drawn. There is **no Load**
   (no Workspace › Load…, no Ctrl+O, no picker).
4. **Workflows are highlighted, not loaded:** a **multi-select dropdown** picks which workflows are highlighted in the
   whole-project molecule.
5. **Rules come from BaseApi**, "for consistency" with SKP Studio's REST-first design: `GET /model/relations` (exists
   on the branch) and `GET /model/fields` (built and deployed 2026-10-16, uncommitted; §4). The same-day alternative of hard-coding them was **reversed**.
6. **Stage 1:** clone the shell — dock panel, menu strips, toolbox, inspector, the document, output — **empty of
   business**; then review the parts **one by one with the user, who approves each** before the next.
7. **Stage 2:** the molecule diagram on the document's canvas (whole project, selected workflows highlighted).
8. **"All loaded entities from db are virtual entities"** (the user, 2026-10-15): an edit changes Valence's copy only;
   **writes stay virtual until an apply step** (confirmed by the user the same day; where apply lives is open).

The user prefers questions in prose (not multiple choice); "confirm" means: verify against the code and report
before building.

---

## 3. Stage 1 — the empty shell (in progress)

### Done (uncommitted until this spec's commit)
- `src/Valence/package.json` — name `valence`; dependencies trimmed to `react`, `react-dom`, `dockview-react`,
  the two IBM Plex fonts; dev: vite 8.3.2, vitest 5.0.3, typescript 5.9.3, testing-library, jsdom. Dropped from
  SKP Studio's: `@xyflow/react`, `elkjs`, `@microsoft/signalr`, `openapi-typescript`, `@playwright/test`.
  `package-lock.json` regenerated; `.npmrc` (`legacy-peer-deps=true`) and `tsconfig.json` copied (include: `src`,
  `vite.config.ts`). `node_modules` installed (git-ignored).
- Copied unchanged from `src/WorkflowStudio/src`: `dock/*` (with its tests), `canvas/tokens.css`, `app.css`,
  `app/document.css`, `app/Spinner.tsx`, `panels/panels.css`, `panels/PaneNote.tsx`, `test/setup.ts`,
  `test/memoryStorage.ts`.
- **Changed in the copied dock** (the only edits to copied files):
  - `DockShell` prop `workflows` is now optional. Absent ⇒ nothing to load: no Workspace › Load…, Ctrl+O ignored,
    no picker, no "+ Load workflow" button on the document group, no Load button in the empty document area
    (`ShellApi.canLoad`).
  - `DockDocument.pinned`: a pinned document has no tab ×, ignores middle-click and Alt+W, has Workspace › Close
    disabled ("This document is always open"), and no "Close document" in its window menu.

### Done in the second session (2026-10-15, uncommitted)
- `index.html` (title SKP Valence), `vite.config.ts` (dev port **5174**, `/api` → `SKP_API` or `localhost:18080`,
  vitest jsdom), `src/main.tsx`.
- `src/App.tsx`: `DockShell` with one pinned document (`project`, "Project"), no `workflows`, no New/Delete/Run (their
  entries show disabled). Session: `app/session.ts`, key **`skp.valence.session`** (dock + highlighted workflow ids,
  sessionStorage mirrored to localStorage, as SKP Studio's). The highlighted ids live in `app/highlights.ts` (a small
  external store), because the dock renders the document through its own host, which a page re-render never reaches.
- Window layout key changed to **`skp.valence.layout`** (`dock/layoutPersistence.ts`); the strip's brand reads
  **SKP Valence** (`dock/DockShell.tsx`). These and the two edits above are the only changes to copied files.
- `panels/Panes.tsx`: Toolbox, Inspector and Output as `PaneNote` empty states.
- `app/ProjectDocument.tsx`: `.docpanel` with the capsule `.docbar` (a "Project" crumb and the multi-select) over an
  empty `.vcanvas` (ground + SKP Studio's vignette). `app/WorkflowSelect.tsx`: a pill ("Workflows · none
  highlighted ▾") that opens a checked list (search, Clear, Esc/press outside closes; "No workflows yet." when empty).
  Its styles are in `app/valence.css`.
- Tests: 207 pass (dock 191 + 4 new for the pinned document and no Load; session, multi-select and App). In jsdom
  dockview leaves the document panel hidden, where names are not computed: App tests find it by selector.
- Playwright on the dev server: menus, Ctrl+O/Alt+W/middle-click do nothing to Project, its window menu has no Close,
  multi-select opens/closes, Toolbox float + dock back, Output auto-hide + flyout, a real tab drag onto the document,
  refresh keeps the layout, Reset window layout; no console errors or warnings.
- `nginx.conf`, `Dockerfile`, `k8s/32-valence.yaml` (in `kustomization.yaml`), port-forward **18082** in
  `k8s/port-forward-realstack.ps1`. The image `valence:local` builds; run locally it serves `/healthz`, the page and the
  SPA fallback, and proxies `/api/`. **Not loaded into kind, not applied.** `src/Valence/dist/` is git-ignored.

### Still to do for stage 1
1. **The one-by-one review** with the user: dock panel (**approved 2026-10-15**, unchanged), menu strip (changed as below, **awaiting approval**), toolbox, inspector, document, output.
   - **Menu strip (the user, 2026-10-15):** no Workspace and no Edit menu — "this studio shows all workflows, you
     don't create new or delete by menu". The strip is the brand, **View** and **Window**. Removed from the copied dock
     with them: the props `onNewWorkflow`, `onDeleteWorkflow`, `deleteBlocked`, and Ctrl+N (`keys.ts`). The Load picker's
     code stays, unused (Valence passes no `workflows`); its empty-area hint reads "Load one with Ctrl+O".
   - **No pop-out (the user, 2026-10-16):** no group, docked or floating, has "Pop out to its own window". Docked
     groups keep Float and Maximize / restore; a **floating group gets Maximize / restore** (▢, and double-click on a
     tab): it fills the dock area and restore puts back its box (a centred 60% box after a reload). Moving or
     resizing a maximized float counts as restored. `windowActions.toggleFloatMaximize` reads dockview's float
     through the group api's `accessor` (no public API). The pop-out plumbing in `DockShell` stays, unreachable.
   - **The Canvas has the tool panes' buttons (the user, 2026-10-16, "for consistency"):** docked ▾ Window position,
     ⇥ Auto-hide, ⧉ Float, ▢ Maximize / restore; floating ▾, ⤓ Dock, ▢. Its ▾ menu: Float/Dock, Maximize (docked),
     Auto hide (no Close: pinned). **Auto-hide of a document:** its whole group hides (a floating one docks back
     first; one sharing a group with a tool pane is not hidden, documents never leave the dock); its rail tab is on
     the edge it was nearest (the Canvas: bottom) and its flyout covers 70% of the dock (`.fly.doc`) with a second
     render of the document (same workspace store). The session keeps it hidden across a refresh; a saved window
     layout drops hidden documents (Apply shows them docked). Hidden ids are `PaneId` (tool id or `doc:…`).
   - **The document's name is "Canvas"** (the user, 2026-10-15; "Workspace" before that): its tab and its capsule label. The id stays `project`.
2. Deploy when the user asks (`kind load docker-image valence:local --name desktop`, `kubectl apply -f k8s/32-valence.yaml`).

---

## 3b. Stage 2 — the molecule on the canvas (started 2026-10-15, at the user's request, before the review finished)

The user: "load the diagram by baseapi to canvas same as mock but darkmode". Built (uncommitted):
- `api/project.ts`: reads the six list endpoints (open question §8.1 answered for now: **built in the client**, no new
  endpoint, so it works against the deployed BaseApi). `molecule/model.ts`: one atom per row, one arrow per key value,
  the mock's colours, radii, bond classes; `reachOf` = what a workflow reaches (highlighting). `molecule/layout.ts`: the
  mock's layout generalised — a band per workflow (hop columns, fan-out lanes, a hand-off row for a PreviousFailed /
  PreviousCancelled step reached from several steps), a band for steps no workflow reaches, a grid band for unused
  rows, bands packed in rows; then the mock's springs and arrow clearance. ~0.4 s for the live data.
- `molecule/MoleculeView.tsx` (three 0.186.1, lazy-loaded chunk): the mock's scene — fixed-axis turning with coast,
  wheel zoom, right-drag pan, Ctrl+drag an atom (open hand), **Ctrl+drag on empty canvas slides the picture along the screen's
  x and y** (the user, 2026-10-15) — a lens shift (`camera.setViewOffset`), not a camera move, so every atom moves exactly
  with the pointer (Playwright: 200 px drag = 200 px for every atom, also after a turn and zoomed in).
  **The wheel and a pinch zoom toward the canvas centre** (the user, 2026-10-16). Our own zoom (`zoomBy`; the trackball's
  `noZoom`): the camera moves along the line from it through the canvas centre, so an atom put at the centre stays there at
  any depth (the trackball moved along the camera's axis, which a slide puts off-centre: atoms at the centre drifted
  127–225 px in 6 notches). The view direction and the slide do not change; the target (turning pivot) stays on the camera's
  axis, moving sideways with it. Same feel as the trackball: a 100 px notch eases to ×0.78 of the distance (5 notches
  268.5 → 76.9), the same limits; a pinch scales the distance by the fingers' spread at once. Playwright: atoms slid to the
  centre stay within 2 px through 6 notches; turn, right-drag pan, an exact Ctrl+drag slide and a real touch pinch all work.
  **Lens 15°** (the mock's was 48°; the user, 2026-10-15: "the atom isn't accurate ball"): a wide lens stretches spheres
  away from the centre of the view into ovals, and the slide puts most of the picture off-centre; at 15° atoms stay round
  (to a few percent) anywhere on screen; the camera stands further back for the same framing.
  **Arrowheads always show** (the user asked to check the arrows' perspective, 2026-10-15): an arrow whose tip the camera
  sees behind its target ball ends at the ball's outline instead, recomputed when the camera moves. Playwright (dev-only
  hook `el.__molecule`): every arrow on the line between its atoms' centres (0 px), heads hidden behind their ball 0 of
  ~210 (were 12 at home, 30 after a turn).
- **Arrowheads up close** (the user, 2026-10-16: "not elegant and accurate"): each head is a slim lathe-turned dart
  (`headOf`: flanks curving in to a sharp point, length 3.4 × base width, 40 sides, a low dome closing the base), its
  point placed on the target ball's surface — exactly, also for a side-by-side arrow (the offset line meets the ball at
  √(r² − off²)); the 0.04 gap is gone. Shafts are closed, 24-sided rods starting inside the source ball, so no hollow end
  shows. Playwright: 118 of 219 tips on the surface to 0.001; the other 101 are the ones hidden behind their own ball,
  pulled back to its outline (2026-10-15 rule).
- **Off the canvas (the user, 2026-10-15):** the capsule toolbar ("Canvas" label + workflow multi-select) and the hover
  card are removed. Hover still focuses an atom's neighbours; the colour legend stays — since 2026-10-16 (the user)
  a small one-row strip in the canvas's bottom-left corner, without the "Atoms · one per row" title. With the multi-select gone nothing
  is highlighted; `WorkflowSelect`, `highlights.ts` and the session's `highlighted` stay for when the user chooses its new
  place (open). **Cursors** (the user's table, 2026-10-15): slide the canvas = open hand ready, closed
  hand while dragging; move an atom = four-way arrow, ready and while dragging; turn = normal arrow at rest, a circular
  arrow (own SVG, `app/valence.css`) while dragging, hover = one-hop focus + the card under the legend. Dark: SKP Studio's
  ground (#0A1220) and vignette behind a transparent renderer; fog scaled to the camera's fit distance.
- **Deviation from the mock:** labels show by size on screen (a workflow's always, a hovered atom's neighbours always),
  because 137 labels at the full view were unreadable. No delete mode yet.
- Highlighting (open question §8.2 answered for now): the chosen workflows' atoms stay, the rest dim (atoms 0.14,
  arrows 0.05, labels 0.12). Hover focus takes over while the pointer is on an atom.
- **The workflow filter is on the main menu strip** (the user, 2026-10-16), at its right (`DockShell` `status` slot):
  `app/WorkflowFilter.tsx` around `WorkflowSelect` — "Workflows · n highlighted ▾", a checked list (by name, an edited
  name too; search, Clear; Esc or a press outside closes; it opens right-aligned). Ids are workflow atom keys (`wf:<id>`),
  kept in the session. **The filter sets the molecule's base state:** what the picked workflows reach (`reachOf`, joined;
  `ProjectDocument.litOf`) stays, the rest fades like hover's fade — nothing is removed; an arrow stays when both ends do.
  **Hover and pin are unchanged on top:** a hovered atom's neighbourhood, else the pinned atom's, else the filter.
  Playwright: filefetcher chain = 40 atoms / 67 arrows bright; + simple-abc = 52 / 83; hover and pin show their
  neighbourhood and the filter returns after; a refresh keeps the picks; Clear brings everything back.
- Checked live (Playwright, swiftshader WebGL): 137 atoms; filefetcher chain highlighted = 40 atoms (as the mock);
  hover card; turn; zoom; Ctrl+drag; refresh keeps the highlight; no console errors. Tests 224 pass (fixture
  `src/test/fixtures/project.json` = the cluster's rows of 2026-10-15, without payloads or definitions).

## 3c. The Inspector (in discussion, 2026-10-15)

The user: hovering an atom updates the Inspector with all the entity's properties. Decided (the user, 2026-10-15):
1. **Shown open: every writable field that is not an arrow** — all six: Name, Version, Description; Workflow:
   CronExpression; Step: EntryCondition; Processor: **SourceHash, InstanceId (writable)**; Schema: Definition (BaseApi
   refuses a changed definition with 409 while a processor references it); Assignment: Payload; Cache: Root, Items.
2. **One read-only show/hide section, "Read-only"** (layout approved by the user, 2026-10-15): first the details —
   table, Id, CreatedAt/By, UpdatedAt/By, "pointed at by" — then, after a thin "arrows" divider, the arrows: Workflow:
   EntryStepIds, AssignmentIds, CacheIds; Step: ProcessorId, NextStepIds; Processor: Input/Output/ConfigSchemaId;
   Assignment: StepId (each as `label → target name`). Starts closed; its open/closed state survives a refresh.
3. Above it, always open: the kind, then the writable fields of item 1.
Decided next (the user, 2026-10-15): **hover previews, a click pins** (a click on empty canvas unpins); **writes stay
virtual until an apply step** (decision 8; no apply step exists yet); the **schema Definition sits in the writable list,
locked by BaseApi's freeze** (the user, 2026-10-16: "build the rule-driven unlock" — see "Code-level BaseApi rules"
below). Large JSON: a multi-line monospace box with BaseApi's check shown while typing (default).

Built (uncommitted): `molecule/fields.ts` (the field lists with BaseApi's rules, details, arrows), `app/workspace.ts`
(project, hovered, pinned, edits — shared by the canvas and the panes), `panels/Inspector.tsx`. A preview is read-only
("Preview · click the atom to pin it"); the pinned atom glows on the canvas and is edited while nothing is hovered. An
edit marks its label, the "Changed in Valence only, not applied" note (with Revert) and the Canvas tab; an edited name
shows on the canvas label. The session keeps the pin and the edits; the section's open state is kept in localStorage.
Checked live with Playwright (no console errors); tests 240 pass.

## 4. BaseApi

### On the branch (commit `137b5e1`), tested, **not deployed**
- `GET /api/v1/model/relations` — every table and foreign key from `GetRelationalModel()`: `{ tables: [{table, kind
  (entity|link), label}], relations: [{constraint, owner, column, target, onDelete, nullable, bond, linkSide}] }`,
  strong ETag, 304 on If-None-Match. A table is a link when its primary key is exactly its foreign keys; bond 1 =
  NOT NULL key column, 2 = nullable, 3 = link table, 4 = link table with a CASCADE side.
- `GET /api/v1/workflows/{id}/molecule` — one workflow's rows (WorkflowGraphLoader's scope) and bonds keyed by
  constraint. **Valence needs the whole project**, so either add a whole-project read or build the molecule from the
  six list endpoints (open question §8).
- Code: `src/BaseApi.Service/Features/Molecule/*`, registered in `Composition/AppFeatures.cs`
  (`AddMoleculeFeature`); tests `src/tests/BaseApi.Tests/Molecule/*` (13). The relational model exists only on a
  relational provider: tests build `AppDbContext` with `UseNpgsql("Host=unused;Database=unused")` (no connection);
  the in-memory provider names tables after the classes (`step_entity`).

### `GET /model/fields` — built 2026-10-16 (uncommitted), tested, **deployed 2026-10-16**
The user, 2026-10-16: "build it, start with GET /model/fields" (part 1 of: the rules come from BaseApi, so Valence stops
keeping its own copy; part 2 is a dry-run validate of the whole pending change set).
- **BaseApi** `src/BaseApi.Service/Features/Molecule/ModelFields.cs` + `ModelFieldsController.cs` (DTOs in
  `MoleculeDtos.cs`, registered in `AddMoleculeFeature`). Body `{ entities: [{ table, fields: [{ field, column, type,
  nullable, storeType, rules: [{ kind, value, message, conditional }], values }], unique: [{ index, fields, filter }] }] }`,
  strong ETag, 304 on If-None-Match. Nothing is named in the code: each table's entity is paired with its update DTO
  through the `BaseService<,,,>` subclass serving it; the DTO's properties are the fields (JSON names, nullability from
  the record); the registered update validator's descriptor gives the rules, an `Include` read through (FluentValidation
  12 hides the included validator: read from the adaptor's `_validator` field, pinned by the tests); a rule inside
  `When(x => x.P.HasValue)` (written against `P.Value`) is `conditional` on P; rule kinds `required`, `notNull`,
  `maxLength`, `minLength`, `length`, `pattern`, `enum`, `notEqual`, `equal`, else `code` (a `Must`/`Custom`) with its own
  message or null; enum values listed with names, compared values as numbers; store types and unique indexes (with
  filters) from the EF model. Tests `src/tests/BaseApi.Tests/Molecule/ModelFieldsTests.cs` (12) and `ValenceFieldsSnapshotTests.cs` (1) — whole suite 2162 pass, 75 skipped as before.
- **Generated snapshot:** `src/Valence/src/api/model-fields.snapshot.json`, written and checked by
  `ValenceFieldsSnapshotTests` (fails when a validator or index changes; regenerate with `VALENCE_FIELDS_SNAPSHOT=write`).
- **Valence** `api/fields.ts` reads the endpoint; `molecule/rules.ts` builds every kind's field list (the update DTO's
  non-link fields, in order), labels (`sourceHash` → "Source hash"), editors (`jsonb` → JSON box, enum → choice without
  refused values, maxLength ≥ 1000 → multi-line) and checks (each rule in order, BaseApi's own message when it has one).
  The workspace holds the rules in use; the Output pane says where they came from. A BaseApi without the endpoint (the
  cluster today) or no BaseApi: the snapshot, and the line says why. `fields.ts` holds no rule any more.
- **What Valence still does itself:** stand-ins for the `code` rules BaseApi reports (definition JSON + JSON Schema,
  payload JSON, cache root ":", items, cron field count) — only while BaseApi's dry run is not available (below), only
  where BaseApi lists a code rule, with BaseApi's message when it has one; and the definition freeze lock (a service
  rule, judged on the virtual entities; the dry run confirms it).
- Verified with Playwright: live → "Rules: the bundled snapshot … (this BaseApi has no GET /model/fields yet)", checks
  with BaseApi's messages, entry condition without PreviousProcessing; the endpoint served (route interception) with the
  generated description and processor names capped at 10 → "Rules: from BaseApi", the cap enforced with its message, step
  names unaffected; GET only. Messages are now BaseApi's (e.g. "Version does not match ^(0|[1-9]\d*)…$", since
  `BaseDtoValidator` gives the version pattern no message of its own).


### `POST /model/validate` — the dry run, built 2026-10-16 (uncommitted), tested on a local stack, **deployed 2026-10-16**
The user, 2026-10-16: "complete these parts" (part 2). Body `{ changes: [{ op: update|delete, table, id, row? }] }` (≤ 500);
answer `{ ok, results: [{ index, op, table, id, ok, status, problem }] }`, always 200 when the request can be read.
- `ModelChanges.cs` (`ModelChangeRunner`): one transaction, **always rolled back**; a savepoint per change (a failed one
  rolls back to it, the next change runs on what the passing ones left). Each change goes through the entity's own
  `BaseService` (`UpdateAsync` / `DeleteAsync`, found by `ModelEntities`, shared with `/model/fields`), so validators,
  junction syncing, the schema freeze, keys and unique indexes all judge it; a workflow delete runs the delete guard's
  read-only Redis checks first. A failure's `problem` is written by BaseApi's own registered exception handlers into a
  private response — the exact ProblemDetails the real call answers. An unknown table/op or a missing row is a 400 of
  its own. The services touch only the database (checked: no publish, no Redis writes), so the rollback undoes all.
- Tests: controller (2) in `ModelFieldsTests.cs`; BaseApi suite 2164 pass. The runner itself needs Postgres (savepoints),
  which the test project has no harness for: it was verified on a **local stack** — this branch's BaseApi on port 18090
  against throwaway containers (`postgres:18-alpine`, `redis:7.4.9-alpine`, `rabbitmq:4.1.8-management-alpine`, the
  cluster's images) — 12/12 HTTP checks: frozen definition → the real 409; slot clear then definition → 200, 200; the
  reverse → 409, 200; rolled back (re-read unchanged); validator errors → 400 by field; duplicate cache root → 409;
  used schema delete → 422 FK; free schema and workflow deletes → 204 and still there; processor delete refused alone,
  passing after its workflow and step; unknown table/op/missing row → 400; missing row → 404.
- **Valence:** `molecule/plan.ts` turns the virtual state into the ordered change set — every surviving row with edits or
  deleted arrows is one update (the whole PUT body: the stored row, typed edits, the arrows still there), in the order
  workflows, steps, assignments, processors, caches, schemas (a slot clears before its schema's definition changes); then
  deletes, workflows → assignments → steps → processors → caches → schemas, a deleted step's own next-step rows cleared
  first (RESTRICT); a ghost's edits are not sent. `api/validate.ts` calls the dry run; `molecule/verdict.ts` maps the
  answers onto atoms and fields (validator errors by property → field; a key error's column → field; the rest per atom).
  The document runs it 600 ms after the virtual state settles (aborting a stale one) and once at load with no changes
  (does this BaseApi have it?). While it answers, the code-rule stand-ins are off (`rules.bare`): the code rules are
  BaseApi's alone. A refused atom is unfinished (no update ghost). Inspector: a red "BaseApi refuses it" / green "✓ BaseApi's
  dry run passes this change (nothing was written)" box, "BaseApi: …" under the field, "◐ Unfinished edit: BaseApi's dry
  run refuses it". Output pane: one line per new answer ("Dry run by BaseApi: 5 changes, all pass (nothing was written)"
  / "… 1 of 1 refused — free-x — Definition: …"). A BaseApi without it (the cluster today): said once at load, never asked
  again until reload; the stand-ins stay on.
- Verified with Playwright on Valence → the local stack (a copy of the cluster's 137 rows, GET-only from the cluster):
  11/11 — rules from BaseApi; an invalid JSON Schema shown only by BaseApi's message (no local copy), unfinished, no halo;
  fixed → passes, amber halo; file-envelope's 4 slot clears + definition → "5 changes, all pass"; duplicate cache root →
  the unique index's 409 under Root; a free schema's delete passes; every table read back unchanged; the only non-GET
  request the dry run; no console errors. On the cluster (no endpoints): fields 9/9, unlock 16/16, deletion rules 26/0
  (1 skip) — one earlier run of the last two had misses that did not recur in three later runs.
- **Deployed 2026-10-16** (the user: "deploy"), from the worktree, which starts at `feature/in-process-post`'s head
  `2a781de` (nothing rolled back): `baseapi-service:local` rebuilt, the previous image kept as
  `baseapi-service:before-model-fields`, loaded into kind `desktop`, `rollout restart`; Valence deployed for the first time
  (`k8s/32-valence.yaml`, `valence:local`, port-forward 18082). Checked live: `/model/fields` 200 with the snapshot's ETag;
  dry run of an empty set / unknown table / missing row → 200 / 400 / 404; the dry-run suite on the dev server against the
  cluster 10/10 (6 tables read back unchanged); the deployed nginx build renders, takes its rules from BaseApi and passes the
  dry-run probe (the production build has no `__molecule` hook, so atom-level checks run on the dev server); every pod
  Running, no BaseApi errors. Rollback: `docker tag baseapi-service:before-model-fields baseapi-service:local`, `kind load`,
  `rollout restart`.
- **Version message:** a friendlier `WithMessage` for the version pattern lives in `BaseApi.Core`'s `BaseDtoValidator`,
  which BaseApi.Service consumes as the local NuGet package `BaseApi.Core 1.0.0`; changing it means repacking that
  package into the shared NuGet cache, which the main checkout's builds use too — not done.
### Cluster state
The cluster's BaseApi currently runs **without** these endpoints (deployed, then rolled back the same day).
Deploy (from the worktree root):
`docker build -f src/BaseApi.Service/Dockerfile -t baseapi-service:local .` →
`kind load docker-image baseapi-service:local --name desktop` →
`kubectl -n skp rollout restart deploy/baseapi-service` → `kubectl -n skp rollout status deploy/baseapi-service`.
Manifests use `imagePullPolicy: IfNotPresent` on `:local`, so the restart is what picks up new bits. Before
replacing an image, tag the running one on the node for rollback:
`docker exec desktop-control-plane ctr -n k8s.io images tag docker.io/library/baseapi-service:local docker.io/library/baseapi-service:<name>`.

---

## 5. The schema (verified against the live `pg_constraint` catalog, migration `20261008045446_AddWorkflowDesign`)

Six entity tables (atoms, labelled by `name`): `workflows`, `steps`, `processors`, `schemas`, `assignments`,
`caches`. Four link tables (arrows): `step_next_steps`, `workflow_entry_steps`, `workflow_assignments`,
`workflow_caches`. **13 foreign keys** (5 key columns + 2 per link table):

| Constraint | Column → target | On delete | Nullable | Bond |
|---|---|---|---|---|
| fk_step_processor_id | steps.processor_id → processors | RESTRICT | no | 1 |
| fk_assignment_step_id | assignments.step_id → steps | RESTRICT | no | 1 |
| fk_processor_input_schema_id | processors.input_schema_id → schemas | RESTRICT | yes | 2 |
| fk_processor_output_schema_id | processors.output_schema_id → schemas | RESTRICT | yes | 2 |
| fk_processor_config_schema_id | processors.config_schema_id → schemas | RESTRICT | yes | 2 |
| fk_step_next_steps_step_id | step_next_steps.step_id → steps (from) | RESTRICT | no | 3 |
| fk_step_next_steps_next_step_id | step_next_steps.next_step_id → steps (to) | RESTRICT | no | 3 |
| fk_workflow_entry_steps_workflow_id | workflow_entry_steps.workflow_id → workflows (from) | CASCADE | no | 4 |
| fk_workflow_entry_steps_step_id | workflow_entry_steps.step_id → steps (to) | RESTRICT | no | 4 |
| fk_workflow_assignments_workflow_id | workflow_assignments.workflow_id → workflows (from) | CASCADE | no | 4 |
| fk_workflow_assignments_assignment_id | workflow_assignments.assignment_id → assignments (to) | RESTRICT | no | 4 |
| fk_workflow_caches_workflow_id | workflow_caches.workflow_id → workflows (from) | CASCADE | no | 4 |
| fk_workflow_caches_cache_id | workflow_caches.cache_id → caches (to) | RESTRICT | no | 4 |

**Whole-project data from existing endpoints:** `GET /api/v1/{workflows|steps|processors|schemas|assignments|caches}`
return every row with its arrows as DTO fields — `WorkflowReadDto.EntryStepIds / AssignmentIds / CacheIds`,
`StepReadDto.NextStepIds / ProcessorId`, `AssignmentReadDto.StepId`,
`ProcessorReadDto.Input|Output|ConfigSchemaId`. Checked on the cluster: 137 rows, 219 arrows (104 link rows +
115 key columns), exactly the database. The live data has rows in no workflow (3 steps, 1 processor, 11 schemas);
the 3 stray steps point at processor `sample-proc-v9`, which workflow steps also use — so "the whole project" must
mean every row, not what workflows reach.

---

## 6. Diagram rules (the user's, judged from the drawing only)

### 6a. Atom deletion — the user's rule #1

- **Delete:** an atom can be deleted only when **no arrow points to it**; deleting it **removes the arrows that
  leave it** (a stage of the delete, not a separate rule).
- With the whole project drawn the rule is **hermetic**: verdicts come from the drawing alone, no delete leaves an
  arrow hanging, and the order of deletes does not change what ends up deletable. Atoms in a loop of next-step
  arrows are always refused (the rule working). Checked with Playwright on the mock: filefetcher-archiveexpander-chain
  (40 atoms, 67 arrows) empties in 14 rounds, nothing stuck.
- **Where the database differs** (only matters when a diagram delete is sent to BaseApi): Postgres also holds a step
  by the next-step arrows leaving it (`fk_step_next_steps_step_id` RESTRICT at the tail), so remove a step's
  `nextStepIds` (PUT) before its DELETE. Checked live: a stray step X → B is refused with 422 until unwired.
- Other arrows never hold their tail: key columns live in the deleted row, and the workflow's link rows CASCADE.

### 6b. Arrow deletion (analysed 2026-10-16 against BaseApi, the orchestrator and the processors)

An arrow belongs to its **tail**: a key column in the tail's row, or a link row the tail's update rewrites. Deleting an
arrow is a `PUT` of the tail's whole row without it (§7), virtual until the apply step (decision 8). **RESTRICT never
refuses an arrow's removal**: it guards only the target's deletion. So with rule #1, removing an arrow can make its
target deletable (when it was the last arrow pointing at it) and never makes anything undeletable.

**Cannot be deleted — a NOT NULL key column: re-point only.**

| Arrow | Why |
|---|---|
| step → processor (`fk_step_processor_id`) | `steps.processor_id` NOT NULL; BaseApi requires `ProcessorId` |
| assignment → step (`fk_assignment_step_id`) | `assignments.step_id` NOT NULL; BaseApi requires `StepId` |

A processor used by steps is freed only by re-pointing those steps or deleting them (rule #1: nothing may point at the
step — next-step, entry or assignment arrows).

**Deletable — a nullable key column (`PUT /processors/{id}` with the slot null).**

| Arrow | What changes |
|---|---|
| processor → input / output schema | The start's schema-edge gate treats null as "passes" (`SchemaEdgeValidator`): that step pair's output = input check is gone. |
| processor → config schema | The start's payload gate skips the processor (`PayloadConfigSchemaValidator`): its steps' payloads are no longer checked. |
| all three | Running processor pods keep enforcing the schema they resolved at boot until they restart (`ProcessorStartupOrchestrator`); `SchemaDriftProbe` warns at every check meanwhile, and a restart never restores the arrow. A schema left with no processor becomes deletable and its definition unfreezes. |

Checked live for one case (2026-10-16): processor `archive-expander` may drop its config arrow to
`archive-expander-config` while steps `split-archiveexpander` / `sc-split-archiveexpander` use it — the steps point at the
processor, not the schema, and the processor update has no in-use check.

**Deletable — link rows.**

| Arrow | Rule | What changes |
|---|---|---|
| step → next step | always | Steps no entry step reaches any more drop out of the run (`WorkflowGraphLoader` walks from the entry steps); their assignments are ignored; that pair's schema-edge check goes. A removal never creates a cycle. |
| workflow → entry step | **not the last one** (`EntryStepIds` ≥ 1, else 400) | That step, and what only it reached, drops out of the workflow's run. |
| workflow → assignment | always | ⚠ **The step still runs, with an empty payload**: the payload is looked up only among the workflow's own assignments (`OrchestrationService.ToDefinition`), and the payload gate walks only existing assignments, so no start gate notices. A step whose processor needs its config runs without it. The assignment becomes deletable. |
| workflow → cache | always | The cache's entries are not projected into Redis at the next start; processors reading that root find nothing. The cache becomes deletable when no other workflow uses it. |

**For every arrow deletion.**
- **A running workflow keeps its graph until its next start**: a start projects the snapshot into Redis
  (`L2ProjectionWriter`) and the orchestrator runs from it; no BaseApi update checks the running state. (Processor
  schema slots: the pods' restart, above.)
- **Two edits of a row do not detect each other**: the apply step must send the row as it is now, plus the change.
- **Breaking a loop** (§8 #5, answered): rule #1 always refuses atoms in a loop of next-step arrows, so deleting one
  next-step arrow is the way to open it; the loop's steps then become deletable one by one under rule #1.
- **Pinning an arrow** (proposed, not designed): the canvas already picks arrows under the pointer (`MoleculeView`
  `pick`); a click would pin one as it pins an atom, and the Inspector would show its two ends, whether it can be
  deleted ("re-point only" for the two NOT NULL arrows, "the workflow's only entry" for the last entry step) and the
  consequence above.

### 6c. Deleting in Valence — built 2026-10-16 (the user: relaxed rule, ghosts, shared history, kept on refresh)

- **Why the virtual entities obey the rules:** apply turns the virtual changes into `PUT`/`DELETE` calls with no
  transaction across them; a virtual state the database cannot hold would fail apply halfway. Under the rules every
  virtual state is a real one, and apply can replay the changes in order.
- **Rule #1, relaxed** (`molecule/deletion.ts`): an atom can be deleted when every arrow pointing at it is deletable;
  those arrows go with it, as do the arrows leaving it. Refused: an incoming step → processor or assignment → step
  arrow (re-point only), or being a workflow's only entry step. An arrow alone (§6b): refused for the two NOT NULL kinds
  and a workflow's last entry. An arrow touching a deleted atom is gone (`goneArrows`).
- **Keys, while the canvas has focus** (SKP Studio's `useDesignKeys`): **Delete** deletes the pinned atom or arrow;
  **Ctrl+Z** undoes; **Ctrl+Y** and **Ctrl+Shift+Z** redo. A press on the canvas gives it focus; keys typed in an
  Inspector field never reach it.
- **Arrows are pinned like atoms:** hovering an arrow previews it, a click pins it (`arrowKey` = `kind|from|to`). The
  Inspector shows its kind, ends, where it is held, its bond, the verdict and "If deleted" (§6b).
- **The pinned atom's verdict** is in the Inspector ("Delete ✓ allowed — the N arrows pointing at it go with it" or
  "✗ <reason>"); a refused Delete writes the reason to the **Output pane**, which logs deletions, refusals, undo and redo.
- **Ghosts:** a deleted atom keeps its place, its colour pulled to red, faint (0.32 in focus, 0.1 otherwise), its label
  struck through in red; its arrows and those deleted alone turn red and faint. A ghost atom is read-only in the
  Inspector ("● Deleted in Valence only, not applied") until undone. The Canvas tab is dirty while anything is deleted.
- **Update ghosts** (the user, 2026-10-16): an atom whose edits are all **finished** — every edited field passes its
  rule — is an update ghost: its colour pulled to the edit amber (#fbbf24), half-faint (0.6 in focus), its label amber
  and italic, showing the edited name. An edit that breaks a rule is **unfinished**: no ghost, the Inspector says
  "◐ Unfinished edit: fix the marked field — not a change, and apply waits, until then" (dashed amber), and the apply
  step must refuse while any edit is unfinished. A deleted atom shows the red delete ghost even when edited
  (`fields.editStates`; the rules now come from `GET /model/fields`, §4).
- **Breathing halos** (the user, 2026-10-16, option B of the ghost-styles mock
  https://claude.ai/artifact/VKMQtt8GpXtrKUZXpHcmEy — "the ghost is not prominent enough"): a glow behind the atom,
  breathing about every 1.6 s (still with reduced motion), never smaller than ~34 px on screen so it marks the atom at the
  whole-project view, and strong while the rest is faded. **Red** for a deleted atom, **amber** for finished edits — both
  drawn alike (aligned 2026-10-16): the body pulled 25% to the ghost colour, faint (0.45 / 0.3 faded), so the halo glows
  through it — and **the atom's own colour for the pinned atom**; a pinned ghost
  keeps its red or amber. Deleted arrows: red, 0.6 (0.3 faded). This replaces the faint tints of the two ghost bullets
  above; the labels keep their red strike-through and amber italic. **Drawn by a shader on a camera-facing disc**
  (2026-10-16, "the halo isn't circle like the atom"): its bright inner edge lies on the atom's outline on screen (the
  sphere's silhouette in the disc's plane, r·d/√(d²−r²)) at any zoom and size, nothing is drawn inside the atom, and it
  glows outward from there; the earlier texture's ring sat inside the see-through body, which the light covered into a
  lopsided crescent. **Blended as a see-through layer and drawn first** (2026-10-16, "the edit halo is malformed" at
  maximum zoom): added light saturated amber to yellow-white and turned the arrows crossing it white-hot; now the halo
  keeps its true colour (with three's colour-space conversion, so amber is #fbbf24, not orange) and arrows pass crisply
  over it. Playwright at maximum zoom: the edited processor (5 arrows through its halo) and the deleted cache look alike;
  ring 50.5–54.5 px around a 50.7–51 px outline, centred, slid off-centre and turned.
- **Atoms are exact spheres** (2026-10-16, the user: "not all atoms has spheres accurate shape, it distortioned when I
  zoom in … all atoms and halo must be perfect sphere and verify it by the zoom in max"). The tessellated
  `SphereGeometry(r, 40, 28)` was a polygon whose flats grew with the zoom, and perspective draws a near, off-centre ball
  as an ellipse. Each atom is now a **sphere impostor** (`MoleculeView.tsx`, `asImpostor`): a quad facing the camera as
  the image plane does (so it projects to a true circle anywhere on screen), sized every frame to the outline
  r·d/√(d²−r²) — the halo's formula, so they stay concentric; the fragment shader cuts the circle (antialiased edge),
  casts the view ray into the real sphere for the surface point, normal, lighting (three's own standard material via
  `onBeforeCompile`: the normal and the lights' view position replaced) and `gl_FragDepth`, so arrows still pierce the
  ball and hide behind it; picking meets the analytic sphere (`ballRaycast`). Playwright (`sphereverify`), every kind at
  the maximum zoom, centred and off-centre, the body painted flat for the measurement: every edge point within
  **0.03–0.04 px** of a fitted circle whose radius is the exact one (old spheres: 0.35–0.72 px, growing with size); at the
  true maximum the workflow is a 531 px ball and its visible arc is the exact circle within 0.03 px; halos (pinned, red
  deleted) circles within 1% of their radius (the measurement's limit on a soft 8-bit glow), centred on the ball within
  1 px. Also: a change now clears the last dry-run answer at once ("checking"), not when the next one arrives.
- **Arrowheads meet the ball** (2026-10-17, the user: "the tip of the arrow doesn't touch the atom … also the shape of
  the arrow distorted"). The tips were already on the true surface (0 off); what showed was the head: flanks curving in as
  (1−s)^1.25 left the last 2–3.6 px of the point thinner than a pixel, so the drawn head ended short of the ball; and the
  see-through arrows (0.7–0.9) showed the shaft's stub (8% inside the head) and the domed base through the head as a
  lighter ring. Now (`headOf`): a straight-flanked cone (still 3.4 : 1) ending in a rounded nose (radius 0.1 of the base),
  a flat base with a sharp crease; the shaft ends exactly at the base, open there (the base closes it) and capped where it
  starts inside the source ball. An arrow from behind, whose tip is pulled back to the ball's outline, goes on by the
  nose's radius so the nose tucks behind the ball and the head overlaps the rim; and the impostor's antialiased rim takes
  the far depth, so what lies behind the ball still draws there (it had left a 1 px hairline of background). Playwright at
  the maximum zoom (`headtouch`: one arrow and its ball alone, flat colours, sampled along the arrow's screen axis): 17/17
  arrows into five atoms with **no background pixel between head and ball**; heads meeting the ball's face end within 1 px
  of the true tip (before: 2–3.6 px short, up to 1.25 px of background); every shaft's start inside its ball hidden (18/18).
- **One history** (`app/workspace.ts`): field edits, Revert and deletions are steps in one undo / redo list (100 kept);
  typing in one field is one step; a new change drops what could be redone. The session keeps the deletions and the
  history across a refresh (`removed`, `history`, optional, version 1).
- Checked with Playwright on the live data: archive-expander refused (two steps run on it); archive-expander-config
  deleted with its config arrow; a next-step arrow clicked, pinned and deleted; Delete typed in an Inspector field did
  nothing; Ctrl+Z walked back the edit, the arrow, the schema; Ctrl+Y redid; a refresh kept the ghost and the history.

### Code-level BaseApi rules the diagram cannot see
- **Schema definition frozen** while any processor references the schema: `PUT /schemas/{id}` with a changed
  definition → 409 (`SchemaDefinitionFrozenException`); name/version/description still update. A new definition is a
  new schema version that the processor slot is re-pointed to (SKP Studio's `GraphSchemaEditor`).
  **In Valence (built 2026-10-16, uncommitted): the rule-driven unlock.** `fields.definitionLock` judges the freeze on
  the virtual entities: the Definition box is read-only, with an amber "Frozen: used by p (input), …" line naming every
  processor slot that holds the schema, until each of those arrows is gone — deleted on its own, or with its processor —
  then it opens with a green "Open: no processor uses this schema in Valence" line. An undo that brings an arrow back
  freezes it again; a definition edit left behind by that (or by a refresh that finds a new processor using the schema)
  is unfinished — "frozen again", no update ghost — until reverted or the arrow is deleted again. Name, version and
  description never freeze. The edit is checked as BaseApi's validator does: required, valid JSON, then a valid draft
  2020-12 JSON Schema (`molecule/jsonSchema.ts`: every keyword the draft defines holds a value of its kind, down every
  subschema; formats are annotations, as in JsonSchema.Net, so `pattern` is not parsed). All 24 live definitions pass.
  **Apply order:** BaseApi checks the database, so the processors' slot-clearing `PUT`s go before the schema's `PUT`.
  Verified with Playwright on file-envelope (4 processor arrows): frozen naming all 4, still frozen after 3 deletes,
  open after the 4th; a bad schema marked and no ghost, a good one an amber update ghost; a refresh kept it; undo froze
  it again; GET only.
- **Workflow delete guard:** `DELETE /workflows/{id}` → 422 while running (Redis `skp:live`) or while its deletion runs
  (`WorkflowDeleteGuardFilter`). `POST /workflows/{id}/delete` (SKP Studio's) also deletes its steps and assignments.
- No other service overrides delete; no update checks running state; two edits of a row do not detect each other.

---

## 7. Updatable fields (`PUT /api/v1/{entity}/{id}`, whole row)

All six: Name (required, ≤ 200), Version (required, `x.y.z`), Description (≤ 2000).

| Entity | Field | Arrow | Rule |
|---|---|---|---|
| Workflow | EntryStepIds | yes | ≥ 1, unique, no empty ids |
| Workflow | AssignmentIds, CacheIds | yes | unique, no empty ids |
| Workflow | CronExpression | no | valid 5- or 6-field cron when given |
| Step | ProcessorId | yes | required, not empty |
| Step | NextStepIds | yes | unique, no empty ids |
| Step | EntryCondition | no | defined value except the reserved one |
| Processor | SourceHash | no | 64-char lowercase SHA-256 hex; unique with InstanceId |
| Processor | InstanceId | no | ≤ 200 |
| Processor | Input/Output/ConfigSchemaId | yes | null clears; not empty when given |
| Schema | Definition | no | valid JSON + valid JSON Schema (2020-12); frozen while referenced (409) — both checked in Valence |
| Assignment | StepId | yes | required, not empty |
| Assignment | Payload | no | required valid JSON, ≤ ~1 MB |
| Cache | Root | no | required, ≤ 200, no `:`, unique |
| Cache | Items | no | JSON object, non-empty keys without `:`, string values, ≤ ~1 MB |

Server-set, never sent: Id, CreatedAt/By, UpdatedAt/By, `xmin`.

---

## 8. Open questions (for the user)

1. Whole-project data: build the molecule client-side from the six list endpoints, or add a whole-project read to
   BaseApi (e.g. `GET /model/molecule`)? And keep or drop `GET /workflows/{id}/molecule`?
2. Where the workflow multi-select dropdown sits (the document's capsule toolbar is the current plan) and what
   "highlighted" looks like (the rest dimmed?).
3. Does a diagram delete reach BaseApi immediately, or is there a draft/apply step like SKP Studio's design save?
4. Which fields are editable from Valence (SourceHash/InstanceId identify a processor's running build).
5. ~~How a loop of next-step arrows is broken~~ — answered 2026-10-16: delete one next-step arrow (§6b).
6. The mock's 3D camera and interaction decisions (fixed-axis turning, Ctrl-drag of atoms, steps by hop with fan-out
   lanes, hover = one-hop focus) — carried into stage 2 as they are, or reviewed again?

---

## 9. Working notes

- **Tests (BaseApi):** xunit v3 on Microsoft.Testing.Platform. Build `dotnet build src/tests/BaseApi.Tests`, then run
  `src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe` (all) or with `--filter-class <FullName>` /
  `--filter-namespace BaseApi.Tests.Molecule`. Baseline with the branch's endpoints: 2224 total, 0 failed, 75 skipped
  (Live). `dotnet test --filter` does not filter here.
- **Tests (Valence):** `npm test` (vitest) in `src/Valence`.
- **Browser checks:** the Playwright MCP does not connect in this environment; drive Playwright from Node with
  `require('C:/Users/UserL/source/repos/SK_P10/src/WorkflowStudio/node_modules/playwright')` in a `.cjs` script.
- **Cluster:** kind cluster `desktop`, namespace `skp`; Postgres `postgres-0` (db `stepsdb`, user `postgres`); BaseApi
  `svc/baseapi-service:8080`; SKP Studio's dev proxy expects BaseApi at `localhost:18080`. Use your own port-forward
  ports for checks and close them afterwards. Live-data checks must only touch rows the check itself creates.
- Build warnings are errors in BaseApi (missing XML `<param>` tags fail the build).

## Toolbox (approved 2026-10-17, built, uncommitted, BaseApi part not deployed)
The user's decisions (2026-10-17): only existing processors behind a Step, but the lone Processor tile stays; no
composite tiles; no start-time warnings on drop; tiles = the atoms with only their mandatory arrow plus the deletable
arrows (spec §6b) to draw again; arrows dropped tail first, then the head clicked; green for the create ghost; no lists
of existing atoms; the dragged object is the size it will have on the canvas (tile size while still over the Toolbox).
- **Tiles** (`panels/Toolbox.tsx`): Schema, Cache, Processor (drop anywhere); Step (on a processor), Assignment (on a
  step), Workflow (on a step, its entry). Arrows: entry step, next step, workflow → assignment, workflow → cache, input /
  output / config schema. Step → processor and assignment → step are not tiles (mandatory; re-point only).
- **Drag**: SKP Studio's (4 px to start, Escape cancels). Valid targets lit, the rest dimmed (`spotlight`). Over the
  canvas the ghost is a disc of the exact on-screen radius the atom will have where it lands — beside its target at the
  target's depth, or on the plane through the view's centre — and an arrow tile's ghost a bond of its real thickness;
  the canvas exposes this through `molecule/bridge.ts` (`CanvasApi`: contains, atomAt, landing, bondPx, spotlight, aim,
  onClick). An arrow tile dropped on a valid tail aims: a real 3D arrow follows the pointer from the tail, ending on a
  valid head's surface; a click there draws it, elsewhere (or Escape) cancels.
- **Virtual** (`app/virtual.ts`, `app/workspace.ts`): `created` atoms (client UUID, default row with the mandatory link,
  position) and `added` arrows (`kind|from|to`), in the one history (`created`/`uncreated`, `added`/`unadded`, `restored`
  for a deleted arrow drawn again) and the session. The workspace's `data`/`molecule` are the virtual project
  (`virtualData`: rows + made rows + drawn links written into their tail rows); `base` is BaseApi's. Refusals (Output):
  wrong target kind, an arrow onto itself (next step), a duplicate, a taken processor slot ("delete that arrow first").
  Delete takes back a made atom with the drawn arrows touching it, or a drawn arrow. Unnamed made atoms are called
  "new step" etc. A made atom is pinned; the Inspector says "New in Valence, unfinished: fill in …" until its fields pass,
  then "New in Valence only, not applied"; drawn green (halo once finished).
- **Canvas**: a rebuild (made or taken back) keeps the camera and where atoms stand.
- **Plan**: creates first (schema, cache, processor, step, assignment, workflow), then updates (drawn arrows update their
  tail row), then deletes. **BaseApi dry run**: `create` runs `CreateAsync`; later changes naming a made row's client id
  (in their id or row) are rewritten to the id BaseApi gave it.
- Verified: local stack (this branch's BaseApi + throwaway containers, a copy of the project) — HTTP 5/5 (chained creates
  201 ×3, an update naming a made row, 400 by field, 422 FK, nothing kept) + the earlier 12/12; Playwright `toolbox` 16/16
  (tiles; ghost tile-size over the Toolbox, then 3.74 px = the made schema's 3.74 px, 5.49 px = the made step's beside
  its processor; camera unchanged; unfinished → named → dry run passes → green halo; a Step on empty canvas refused; a
  next-step arrow aimed and drawn; refresh keeps made + drawn; Ctrl+Z; Delete takes back; no writes; no console errors).
  Unit tests 292; BaseApi 2164. Cluster suites: unlock 16/0, spheres 28/0, deletion rules 26/0 (one earlier run had the
  known session-timing flake). The cluster's BaseApi needs a redeploy for creates in the dry run.

**Halos after a drop (the user, 2026-10-17: "when you drop toolbox component in the right place it should be in update mode meaning haloing").**
A made atom breathes the green create halo from the moment it lands, finished or not; the Inspector note still says
"unfinished: fill in …" until its fields pass. A drawn arrow updates its tail's row, so an existing tail breathes the amber
update halo, like an atom edited in the Inspector; undo or Delete of the arrow takes the halo back. The atom dropped onto
(a step's processor) has no halo: its row does not change. A tail BaseApi's dry run refuses loses its halo, except when the
only refusal is the missing foreign key of an arrow to a made atom that does not pass yet: that is the head's fault, shown
on the head.

**A drop keeps the view (the user, 2026-10-17: "when I drop the new component it lost the center and all canvas moved").**
A drop rebuilds the scene; the camera, its target and the atoms were kept, but the pan (Ctrl+drag, a slide of the picture
by the lens shift, not a camera move) was not, so the whole picture jumped back by the pan. The pan is kept now too.

**Copy/paste (the user, 2026-10-17: "do the same as toolbox atoms section does but with the copied fields values").**
Ctrl+C on the canvas copies the pinned atom; Ctrl+V puts its copy on the pointer, ghosted and sized exactly as its Toolbox
tile's, and a click drops it under the tile's rules (a step on a processor, an assignment on a step, a workflow on a step;
the rest anywhere). Escape cancels; one copy pastes any number of times; undo takes a paste back in one step. The copy is
kept in Valence, not on the system clipboard, and not across a refresh. The keys answer wherever the focus is (the canvas,
the Project list, the Toolbox, Output), except in a text field or over selected text, and under any keyboard layout (the
physical C and V keys: a Hebrew layout types ב and ה).
- Copied: the atom's own values (name, version, description, definition, items, instance id, entry condition, payload,
  cron expression), and a made atom's typed texts, which the paste carries as its own edits.
- Not copied: arrows. A paste gets only its mandatory arrow, from where it lands; next steps, schemas, assignments and
  caches start empty. An arrow itself cannot be copied.
- Pasted empty: a cache's root and a processor's source hash, unique in the database (uq_cache_root,
  uq_processor_source_hash), so the paste lands "unfinished: fill in …".
- Cannot be copied (the user, 2026-10-17): a deleted atom, or an updated one — edited in the Inspector, or whose row a drawn
  or deleted arrow changes (its amber halo). A made atom can be copied.

**Found by the full browser suite (2026-10-17: every tile, every key, enriched workflows, virtual only).**
- A new atom dropped on another lands on the first free place around it, starting on the pointer's side, turning round it
  in the screen's plane, then a ring further out. Before, a second step on the same processor went exactly on top of the
  first, the two impossible to tell apart or to click.
- A new step whose next steps are new too is created without them, and an update after every create adds them. Before,
  the create named rows not created yet, a foreign key BaseApi refused (and the workflow entering the step with it).
- A rebuilt canvas clears the hover the old one left. Before, after a drop on a processor the Inspector kept showing the
  processor's preview over the new pinned atom, until another atom was hovered.
- BaseApi refuses a cache whose items have values that are not strings ({"seed":1}); {"seed":"1"} passes.

**Shortcuts menu (the user, 2026-10-17: "add on main menu strip to show all the key stroke shortcuts").**
The menu strip is View, Window, Shortcuts. Shortcuts lists every key stroke and mouse gesture Valence answers, by group:
the canvas's keys (Delete, Ctrl+Z, Ctrl+Y, Ctrl+Shift+Z), copy and paste (Ctrl+C, Ctrl+V), the Toolbox (drag a tile, drop
then click, Escape), the canvas's mouse (click, drag, Ctrl+drag an atom, Ctrl+drag, wheel) and the windows' (Ctrl+E,
Ctrl+Shift+E, double-click and Ctrl+double-click a tab, Escape). It is to read: choosing an entry only closes the menu.
The list is src/app/shortcuts.ts, beside the handlers; F5, Ctrl+O and Alt+W do nothing in Valence and are not listed.
