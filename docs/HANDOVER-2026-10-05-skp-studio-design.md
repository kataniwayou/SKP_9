# Handover: SKP Studio design brainstorm (2026-10-05)

**SUPERSEDED (later the same day).** All five sections were approved, the spec is written and approved at `docs/superpowers/specs/2026-10-05-skp-studio-design.md`, and §5 was amended with Visio connector editing, positioned junctions and the lit two-tier grid (mockup v46). Plan 1 (backend) is at `docs/superpowers/plans/2026-10-05-skp-studio-01-backend-graph-save.md`. Next: the user picks how plan 1 is executed. The notes below are the original handover, kept for history.

## What this is

SKP Studio is a web UI for **building workflows visually** on a blueprint canvas. It talks **only to BaseApi over REST**. The brainstorm runs on the `superpowers:brainstorming` skill, **architectural path**: clarifying questions, approaches, design presented and approved section by section, a written spec, then writing-plans. Do not write product code until the spec is approved and a plan exists.

**How the user works:**
- Rules are refined one at a time.
- "**confirm**" means *verify against the code or the running mockup*, not "agree".
- The user answers in prose rather than picking options.
- They want honest reports: when something is not built or not tested, say so.

## Approval state

| Section | State |
|---|---|
| 1 Architecture & boundaries | approved |
| 2 Graph-save contract | approved (with the "parked" amendment) |
| 3 Visual system + dock + chrome | **locked** |
| 4 Inspector editors | approved |
| 5 Testing & build order | **next, not presented yet** |

## Decisions (each verified against the code where it touches BaseApi)

### Data model facts the design rests on
- **Steps belong to no workflow.** A workflow names only its entry steps. Its step set is whatever is reachable through `StepNextSteps`, and the same step can be shared by several workflows.
- **A wire is a `StepNextSteps` row on the source step.** Its **colour is the target step's entry condition**: 1 Completed, 2 Failed, 3 Cancelled, 4 Always, 5 Never. 0 is rejected by the validators. On an entry wire, only `Never` (the per-entry freeze) means anything.
- **Fan-in has no join.** The target runs once per matching predecessor (`Orchestrator/Dispatch/StepAdvancement.cs`).
- **Compatibility is `SchemaEdgeValidator`'s rule:** the parent processor's `OutputSchemaId` must equal the child's `InputSchemaId`, compared **by id**. A null on either side passes.
- **An assignment applies to one (workflow, step) pair.** `Assignment.StepId` names the step and `WorkflowAssignments` names the workflow. At start the orchestrator takes the first assignment per step, so the UI allows at most one. The payload is validated against the processor's config schema at start only.
- **A schema's `Definition` is frozen** once any processor references it (409, `SchemaService.UpdateAsync`).
- **Deleting is governed by the database.** Of the 13 FKs, 10 are `RESTRICT` (a delete returns 422 with SQLSTATE 23001). 3 `CASCADE`, all on the workflow side of the link tables.
- **Workflow create/update requires at least one entry step.** No CORS policy exists, so the UI is served same-origin.

### Section 1: architecture
- `src/WorkflowStudio`: Vite + React + TypeScript, **React Flow + elkjs**. Served by nginx, which proxies `/api/*` to BaseApi (same origin, no CORS). Types are generated from Swagger (`openapi-typescript`).
- Frontend units: `api/`, `model/` (pure graph logic that mirrors the backend validators), `layout/` (elkjs), `canvas/`, `panels/`, `store/` (draft, undo/redo).
- Backend additions: **`PUT /workflows/{id}/graph`** (atomic), and a **nullable jsonb `Layout` column** on `WorkflowEntity` with `GET`/`PUT /workflows/{id}/layout`, plus one migration.

### Section 2: graph save
- `PUT /workflows/{id}/graph` **creates or replaces** the workflow in one transaction. The client generates ids for a new workflow and new steps.
- The request carries the workflow fields with `updatedAt`, `entryStepIds`, `cacheIds`, **only the new or changed steps** (each with `updatedAt`), assignment intents (`stepId` + payload or null), processor schema edits, and the layout.
- The server, in order:
  1. Reuses the **existing validators and junction sync** (no duplicated rules).
  2. Checks concurrency: 409 if the workflow or any changed step has a newer `updatedAt`.
  3. Applies schema edits: a new schema row, then re-points the processor slot.
  4. Writes steps in two passes (rows, then wires).
  5. Resolves assignments by the hidden rules: update in place if only this workflow uses the row; copy and re-link if it is shared; create if absent; unlink, then delete if orphaned.
  6. Writes `Layout`, then one commit. An FK violation returns 422 and rolls back the whole save.
  - It returns the graph re-read through `WorkflowGraphLoader`.
- **The editor never blocks a design.** Cycles, broken wires, invalid payloads and liveness are start checks, shown as warnings, and saving still works. The one save precondition is an entry step, which the backend already enforces. There are **no backend validator changes**.
- **`Layout` holds positions only, never graph facts.** That is the sphere, steps, caches, **parked** blocks (placed but unwired, never part of the workflow) and junctions. On load the tables decide what exists, and stale ids are ignored.
- **Shared steps:** rewiring one warns and lists the other workflows that reach it.
- **Processor schema edits** create a new schema version and re-point the slot. Each workflow re-checks its own wires when loaded. Running replicas keep the old schema until they restart.
- **Two levels of delete.**
  - **From the graph:** unlink only. Removing a mid-chain step offers "Reconnect A→C?".
  - **From the toolbox:** a plain DELETE, decided by the Postgres restrict FKs. A 422 is shown together with who still references the entity.

### Section 3: visual system (locked)
- **Theme and product:** dark blueprint, an 8 px mesh grid with snapping, IBM Plex fonts. The product name is **SKP Studio**.
- **Workflow:** a **lit sphere** (gradient depth, specular highlight, rim light, contact shadow) showing only "WORKFLOW" and its name. It has no orbit ring, version or cron. It starts centred and can be moved.
- **Step:** a "**sphere-glass cap**" block. A glossy blue title cap holds the name, `STEP vX`, the entry-condition letter pill and the assignment keys, over a dark body. The **processor is drawn inside as a "die on substrate"**: glossy die, SMD parts, and edge contacts with bond traces wherever wires land.
- **Cache:** the same glass cap, with a stack of lit discs.
- **Wires:**
  - **Lit cables** (shadow, halo, line, specular core), straight or right-angled only.
  - **Straight wherever possible:** a wire may land anywhere within the target processor's band. **A wire that must bend lands at the processor's middle.** Every port is anchored on the **processor middle** (`PMID=86`), not the step's middle.
  - **Fan-out** leaves as an evenly spaced group centred on the source processor's middle.
- **Junctions** (drawing only, stored in `Layout`): **only an arrow touches a processor; only a contact point touches a line.** A step with ≥4 incoming wires gets one arrow plus lines on contact points. It merges only wires into the same step, so they share its colour.
- **Colours:**
  - **Entry conditions:** Completed teal, Failed coral, Cancelled amber, Always violet, **Never pink `#F472B6`**. Each also has a letter pill.
  - **Neutral in the legend:** **junction** (a plus with a centre circle), **broken** (dashed with a ⚠ gap) and **parked** (dashed block outline). On the canvas a **junction and a broken wire take the forward step's colour**. A broken wire is dashed, with a "!" marker.
- **Interaction (Visio-like):** connectors stay glued and reroute live as blocks move. The router picks the cheapest of straight, Z and U shapes. Multi-select by Shift/Ctrl+click or rubber band. Snap to 8 px. Arrow keys nudge. Space+drag or the middle button pans. Ctrl+wheel zooms at the pointer. Scrollbars appear only when needed. **Long labels are shortened with a tooltip** (measured with the real fonts).
- **Chrome:**
  - A menu strip with **File · Edit · View · Window**. **There is no Run menu**; ▶ Start and ■ Stop are on each document's toolbar, and F5 / Shift+F5 still work.
  - A **Visual Studio-style dock on dockview-core 8.4 (free)**. Workflows are **document tabs**, opened from a searchable dropdown. Closing an unsaved one asks **Save / Discard / Cancel**.
  - **Shared tool panes:** Inspector, Toolbox, Problems, Output.
  - Each document has a capsule toolbar: name, cron, status, Save/Start/Stop, its own zoom and Fit.
  - Clicking anything fills the Inspector, whether it is shown or hidden.
- **VS docking items 1–6, all built:**
  1. A ▾ window-position menu, also on a tab's right-click: Float, Dock, Dock as tabbed document, Auto hide, Close. **Ctrl+double-click** toggles float and dock.
  2. Window menu: Save, Apply and Reset window layout, kept in localStorage per user, **never in the DB**.
  3. **Exact re-dock memory:** a pane returns to the neighbour, side and size it had.
  4. **Documents can only be dropped into or beside the document area.** Wired, **not yet tested with a real mouse drag**.
  5. **Auto-hide built in-house:** left, right and bottom rails, sliding out on hover or click, Dock to pin back. A hidden Inspector's tab glows when its content changes.
  6. **Ctrl+E** is the switcher (the browser reserves Ctrl+Tab). Double-click a tab to maximize, middle-click to close. **Alt+W closes a document** (the browser reserves Ctrl+W).

### Section 4: inspector editors (approved)
- **Step:** semver version; an entry-condition dropdown (never 0; `Never` noted for entry steps); a processor swap that previews which wires would break; wired from/to lists; "also reached by" (shared).
- **Assignment:** `vanilla-jsoneditor` in tree/table plus raw mode, with **Ajv draft 2020-12 validation against the processor's config schema**. Missing `required` keys get "add" hints, `enum` values become dropdowns, `default` values are offered. Limit 1 MB. Invalid raw text keeps the last valid value.
- **Processor:** read-only identity. **In, Out and Config slots are editable**: a JSON-Schema editor validated against the meta-schema, and "remove" sets a slot to ∅. An impact panel shows usage and the wires that would break; replicas need a restart.
- **Workflow:** cron with a plain-English reading and the next 3 fire times. Entry steps are read-only (they come from the wires). Linked caches can be unlinked.
- **Cache:** root and keys may not contain `:`, and the root must be unique. Items use a TanStack table. **It saves independently** (`PUT /caches/{id}`, with "Apply"), not through the document save, because caches are shared. New caches are created from the toolbox.
- **Wire, junction, multi-select views.** **Problems** has two severities: **start blockers** (cycle, broken wire, invalid payload, dangling step) and **notes** (fan-in, shared, parked, frozen). Processor liveness reads Redis, so the editor cannot check it; it surfaces as the start's 422 in Output.

## Open decisions to carry into the spec
- **DECIDED: stay on dockview-core, compass deferred.** Web research (2026-10-05) confirmed the compass and auto-hide are enterprise-only (licence per dev per year, price not public). Rejected: Infragistics Dock Manager (only full VS copy, but a web component, ~$1,399/dev/yr, pop-out only under Electron), FlexLayout (no compass), rc-dock (poorly maintained, React 19 issues), Lumino (not React, no floating), Golden Layout (stale). Spec must say: workflow documents use `renderer:'always'` (the default drops inactive tabs and loses the React Flow viewport); a pop-out window must use the element's `ownerDocument` (React Flow's d3 zoom/drag is untested in pop-outs).
- **Processor liveness** in the editor would need a new read endpoint. It is deferred.
- **Skills to install before implementation:** `framara/react-flow-skill` (`npx skills add framara/react-flow-skill -g`) and `tanstack-table` (`/plugin marketplace add tanstack-skills/tanstack-skills` then `/plugin install tanstack-table@tanstack-skills`). The user has **not** approved installing them yet.

## Section 5: to present next
Testing and build order. The obvious content:
- **Testing:** `model/` unit tests that mirror the backend validator tests (cycle, schema edge, landing and routing rules). Backend integration tests for `PUT /graph` (atomicity, 409 concurrency, the assignment copy/orphan rules, schema re-point). Playwright end-to-end tests on the dock and canvas: drag reroute, the unsaved-close prompt, dock and undock, and the document-area drop rule.
- **Build order (vertical slices):** backend `Layout` and `PUT /graph` → read-only canvas (load, render, route) → editing and draft save → inspectors → dock chrome → toolbox drag-and-drop → junctions and polish.

Present it, get approval, then write the spec to `docs/superpowers/specs/2026-10-05-skp-studio-design.md`, self-review it, ask the user to review it, then **writing-plans**.

## The mockup (reference implementation of section 3)
- **Live page:** `.superpowers/brainstorm/385-1791189446/content/skp-studio-dock-v40.html`. It is self-contained (data embedded, dockview from the jsDelivr CDN). `.superpowers/` is gitignored.
- **Editable source:** `.superpowers/brainstorm/385-1791189446/source/skp-studio-mockup.template.html`, with the `__DATA__` placeholder and `allwf.json`, which holds all 7 live workflows read from BaseApi on :18080. Rebuild with `python build.py v41`.
- **Companion server:**
  - Restart it with `bash ~/.claude/plugins/cache/claude-plugins-official/superpowers/6.4.1/skills/brainstorming/scripts/start-server.sh --project-dir C:/Users/UserL/source/repos/SK_P10 --open`. Run it in the background on Windows.
  - Its helper rewrites any element with class `.status`, so do not use that class.
  - The newest file in `content/` is what gets served.
- **Mocked in the mockup:** Save, Start and Stop only log the request they would send. Only the active document's canvas is live; a split shows a still image. Pop-out windows were not tested headless.
