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
   on the branch) and `GET /model/fields` (to build). The same-day alternative of hard-coding them was **reversed**.
6. **Stage 1:** clone the shell — dock panel, menu strips, toolbox, inspector, the document, output — **empty of
   business**; then review the parts **one by one with the user, who approves each** before the next.
7. **Stage 2:** the molecule diagram on the document's canvas (whole project, selected workflows highlighted).

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

### Still to do for stage 1
1. `index.html` (title **SKP Valence**), `vite.config.ts` (dev port, e.g. 5174; proxy `/api` → `SKP_API` or
   `http://localhost:18080`, as SKP Studio's; vitest jsdom + `src/test/setup.ts`), `src/main.tsx` (fonts,
   `dockview-react/dist/styles/dockview.css`, the copied CSS).
2. `src/App.tsx`: `DockShell` with **one pinned document** (id e.g. `project`, name "Project"), no `workflows` prop,
   `renderTool` → the three empty panes, `onNewWorkflow`/`onDeleteWorkflow`/`onRunCommand` absent (their menu entries
   show disabled), the session/dock layout persisted like SKP Studio's (`restore`, `onLayoutChange`, `storage`) — use
   Valence's own storage keys so the two apps' saved layouts never mix.
3. Empty panes with SKP Studio's frames: Toolbox, Inspector, Output — `PaneNote`-style empty states, no logic.
4. The document: SKP Studio's `.docpanel` with its capsule `.docbar` (styles in `app/document.css`) holding only
   the **workflow multi-select dropdown** (empty list in stage 1), and an empty canvas.
5. Run the copied dock tests (`npm test`) and fix what the two dock changes broke (they assume `workflows` and
   closable documents).
6. Verify in a real browser with Playwright (menus, docking, float, auto-hide, layout reset, no close on the
   document, no console errors) — the user requires real interactions before reporting.
7. `nginx.conf` (only `/api/` → `baseapi-service:8080`, `/healthz`, assets, SPA fallback; no AI, no hubs),
   `Dockerfile` (SKP Studio's, paths `src/Valence/`, no AI env), and `k8s/3x-valence.yaml` (a copy of
   `31-workflow-studio.yaml`; next free port-forward, e.g. 18082).
8. **Then the one-by-one review** with the user: dock panel, menu strips, toolbox, inspector, document, output.

---

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

### `GET /model/fields` — to build
From the update validators' FluentValidation descriptors plus the EF model. Probed: declarative rules come with their
values (`NotEmpty`, `MaximumLength` 200 / 1 048 576, `Matches` `^[a-f0-9]{64}$`, `NotEqual(Guid.Empty)`,
`IsInEnum`); `Must`/`Custom` rules appear as bare `PredicateValidator` — only their messages are readable; the shared
Name/Version/Description rules sit behind an included child validator (recurse into it); unique indexes and not-null
come from the EF model. **Not describable:** the schema-definition freeze (code in `SchemaService.UpdateAsync`).

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

### Code-level BaseApi rules the diagram cannot see
- **Schema definition frozen** while any processor references the schema: `PUT /schemas/{id}` with a changed
  definition → 409 (`SchemaDefinitionFrozenException`); name/version/description still update. A new definition is a
  new schema version that the processor slot is re-pointed to (SKP Studio's `GraphSchemaEditor`).
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
| Schema | Definition | no | valid JSON + valid JSON Schema (2020-12); frozen while referenced (409) |
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
5. How a loop of next-step arrows is broken (the delete rule alone never can).
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
