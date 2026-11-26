# Acto Schemas mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a **Schemas** toggle to the board. While it is on:
- schemas and stepless processors become stored, draggable cards;
- dotted reference wires join each schema to whatever uses it;
- each schema reads wired, `held` or `orphan`;
- only orphans can be deleted (ghost, then Save).

**Architecture:**
- BaseAPI stores `BoardX`/`BoardY` on Schema and Processor, the same way it already does for Step, Cache and Workflow.
- In Acto, a pure module `design/schemaStates.ts` derives the states, the holders and the reference wires from
  `BoardState`.
- The existing machinery learns two new kinds, `schema` and `processor`: item refs, occupied rectangles, picks, the
  toolbar and bar, ghosts, placement, and the Inspector tabs.
- `toFlow` adds the cards and wires only while `view.schemas` is true.

**Tech Stack:** ASP.NET Core 8 + EF Core (BaseAPI), xUnit v3; React 18 + TypeScript + @xyflow/react 12 + Vitest + Playwright (Acto).

**Spec:** `docs/superpowers/specs/2026-11-26-acto-schemas-mode-design.md` (mock: https://claude.ai/artifact/CPnMFvtSUX4ZEJHwY3eXJH)

## Global Constraints

- **Where to work:**
  - Branch `feature/acto`, in the main checkout.
  - Never stage the user's own uncommitted files: `k8s/43-processor-analyst.yaml`, `src/Processor.Analyst/Bit/RehearsalGraph.cs`, untracked docs and tools.
- **Processors:**
  - Acto never creates, copies or deletes a processor (`changes.ts` keeps skipping processor create/delete).
  - Schemas mode never edits processor fields. Its only processor change is the location.
- **Delete:**
  - Delete is only on orphan schemas. No Copy on schemas or processors.
  - Wired schemas, held schemas and processor cards have no toolbar. The Delete key still does nothing.
- **Exact strings:**
  - Toggle label `Schemas`. `localStorage` key `acto.schemas`, where `'1'` means on.
  - Tags: `orphan`, `held`, `no step`.
  - Kind lines: `schema · orphan`, `schema · held by <name> <version>`, `schema · <slot> of <processor name>` (comma-joined), `processor · no step`.
- **Colours** (CSS tokens, beside `--cache-*` in `tokens.css`):

  | Token | Light | Dark |
  |---|---|---|
  | `--schema-bg` | `#E6EEFB` | `#E6EEFB` |
  | `--schema-line` | `#0059DC` | `#3D7CF0` |
  | `--schema-ink` | `#0B3D91` | `#0B3D91` |
  | `--schema-ref` | `#0059DC` | `#7AA7FF` |
  | `--proc-bg` | `#1e1e1e` | `#2b2b2b` |
  | `--proc-line` | `#3c3c3c` | `#727272` |
  | `--proc-ink` | `#f8f8f8` | `#f8f8f8` |
  | `--proc-muted` | `#bebebe` | `#bebebe` |
  | `--held-bg` | `#E2E8F0` | `#E2E8F0` |
  | `--held-ink` | `#334155` | `#334155` |

- **Card sizes:**
  - `SCHEMA_W = 190`, `SCHEMA_H = 52`; `PROCESSOR_W = 210`, `PROCESSOR_H = 64`, both in `model/geometry.ts`.
  - Radius 3px.
- **Placement distances:** schema anchor 140px below its holder; unanchored column 320px right of everything; stack gap 40px.
- **BaseAPI tests:**
  - Windows App Control blocks the test DLLs, so run them in container `skp-test`: copy the repo with `bash $TEMP/skp-sync.sh`, then build and run inside the container (memory: dev-machine-quirks).
  - The runner is MTP: `dotnet src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.dll --filter-class <Ns.Class>`.
- **Acto checks:** from `src/Acto`, run `npm run typecheck && npm test`.
- **Deploy:**
  1. Build the images.
  2. Import each with `docker save <img> | docker exec -i desktop-control-plane ctr -n k8s.io images import -`.
  3. `kubectl -n skp rollout restart deploy/<baseapi|acto>`.
  4. Re-open `kubectl -n skp port-forward svc/acto 18083:8080`.

## Review Focus

1. **A referenced schema moved, then saved.** Expected: it saves (`200`). The frozen-definition guard must not fire, because the update carries the same definition. Test in Task 1.
2. **A schema used by two steps of the same processor.** Expected: one wire per step and slot. A step whose processor uses the same schema in two slots gets two wires. Test in Task 3.
3. **Deleting an orphan, then Undo.** Expected: the schema is back with its place, the ghost goes, and Save sends nothing. Test in Task 5.
4. **Mode off, a step dropped where a hidden schema sits, mode back on.** Expected: the schema is pushed aside, not an undo step (Undo does not move it back under the step), and the next Save sends the new place. Test in Task 4.
5. **A schema or processor move alone.** Expected: no workflow is marked affected, so there is no dry run for any workflow and Save pushes only the location. Test in Task 2.

---

### Task 1: BaseAPI — BoardX/BoardY on Schema and Processor

**Files:**
- Modify: `src/BaseApi.Service/Features/Schema/SchemaEntity.cs`, `SchemaDtos.cs`, `SchemaEntityMapper.cs`
- Modify: `src/BaseApi.Service/Features/Processor/ProcessorEntity.cs`, `ProcessorDtos.cs`, `ProcessorEntityMapper.cs`
- Create: `src/BaseApi.Service/Persistence/Migrations/20261126120000_AddSchemaProcessorLocations.cs` and `.Designer.cs`. Hand-written, modelled on `20261118120000_AddBoardLocations`. Update `AppDbContextModelSnapshot.cs` too.
- Test: `src/tests/BaseApi.Tests/Board/BoardLocationTests.cs`

**Interfaces:**
- Produces:
  - The entities gain `public double? BoardX { get; set; }` and `public double? BoardY { get; set; }`.
  - `SchemaCreateDto`, `SchemaUpdateDto`, `SchemaReadDto`, `ProcessorCreateDto`, `ProcessorUpdateDto` and `ProcessorReadDto` gain trailing `double? BoardX = null, double? BoardY = null`.
  - JSON names are `boardX` and `boardY`, the same as on steps.
  - Columns `board_x` and `board_y` (`double precision`, nullable) on `schemas` and `processors`.

- [ ] **Step 1: Write the failing tests** in `BoardLocationTests`, built like the existing step facts:
  - `SchemasAndProcessorsCarryLocationsTheSameWay`: create with `(10, 20)` reads back `(10, 20)`; an update without a location keeps it; an update with `BoardX = 5` only moves X.
  - `AReferencedSchemaMovedWithItsDefinitionSaves`: create a schema, then a processor whose `InputSchemaId` points at it. `UpdateAsync` with the same `Definition` re-serialised with different whitespace and `BoardX = 300, BoardY = 40` returns `BoardX == 300` and throws no `SchemaDefinitionFrozenException`.
  - `TheMigrationSnapshotMatchesTheModel` already exists and must keep passing.
- [ ] **Step 2: Run in the container and check they fail.**
  `bash $TEMP/skp-sync.sh && MSYS_NO_PATHCONV=1 docker exec skp-test bash -o pipefail -c 'cd /repo && dotnet build src/tests/BaseApi.Tests -v q && dotnet src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.dll --filter-class BaseApi.Tests.Board.BoardLocationTests'`
  Expected: compile errors or FAIL on `BoardX`.
- [ ] **Step 3: Implement** the entity properties, DTO parameters, migration and snapshot.
  - Split each mapper into a `[MapperIgnoreTarget]`/`[MapperIgnoreSource]` `UpdateFields`.
  - Add a public `Update` that writes `BoardX`/`BoardY` only when they are non-null (copy `StepEntityMapper.cs:42-57`).
- [ ] **Step 4: Run the same command.**
  Expected: every `BoardLocationTests` fact passes, including the snapshot test. Then run `--filter-class BaseApi.Tests.Features.Schema.SchemaServiceTests` (or whichever schema/processor suites exist) and confirm they pass unchanged.
- [ ] **Step 5: Commit** `feat(baseapi): schemas and processors keep a board location (BoardX/BoardY)`

### Task 2: Acto rows carry the location; Save sends it; moves affect no workflow

**Files:**
- Modify: `src/Acto/src/api/schema.d.ts` (regenerate it with `npm run gen:api` against the rebuilt BaseAPI, or hand-add `boardX?: number | null; boardY?: number | null` to the six schema and processor DTOs if no BaseAPI is reachable)
- Modify: `src/Acto/src/design/board.ts`, `src/Acto/src/api/toModel.ts`, `src/Acto/src/design/changes.ts`, `src/Acto/src/design/boardFixtures.ts` (fixtures get `at: null`)
- Test: `src/Acto/src/api/toModel.test.ts` (or the existing toModel tests), `src/Acto/src/design/changes.test.ts`

**Interfaces:**
- Produces:
  - `ProcessorRow extends Processor { updatedAt: string; at: Point | null }`
  - `SchemaRow extends Schema { updatedAt: string | null; at: Point | null }`
  - `processorRowFromDto` and `schemaRowFromDto` set `at: atOf(dto)`.
  - `schemaBody` and `processorBody` spread `loc(row.at)`.
  - `affectedWorkflows(base, cur)` ignores a processor or schema row whose only difference is `at`.

- [ ] **Step 1: Write the failing tests:**
  - `a schema read with boardX/boardY has at; without them at is null`, and the same for a processor.
  - `moving a schema sends update schemas/<id> with boardX, boardY, its definition and its stamp`.
  - `moving a processor sends update processors/<id> with boardX, boardY and its stored fields unchanged`.
  - `affectedWorkflows: a schema or processor move alone affects no workflow; a schema name change still affects the workflows using it`.
- [ ] **Step 2: Run** `npx vitest run src/design/changes.test.ts src/api` and check the new tests FAIL.
- [ ] **Step 3: Implement** as in Interfaces. In `affectedWorkflows`, compare schema and processor rows with `at` removed.
- [ ] **Step 4: Run** `npm run typecheck && npm test` and check everything PASSES. Fix fixtures and type errors by adding `at: null`.
- [ ] **Step 5: Commit** `feat(acto): schema and processor rows carry a board place; Save sends it; a move affects no workflow`

### Task 3: Derive states, holders and reference wires

**Files:**
- Create: `src/Acto/src/design/schemaStates.ts`
- Test: `src/Acto/src/design/schemaStates.test.ts`

**Interfaces:**
- Produces, all pure over `BoardState`:
  - `type SchemaState = 'wired' | 'held' | 'orphan'`
  - `schemaStates(b: BoardState): Record<Id, SchemaState>`
  - `steplessProcessors(b: BoardState): Id[]`: processors no step uses that reference at least one schema, sorted by id.
  - `interface SchemaRef { owner: { kind: 'step' | 'processor'; id: Id }; slot: Slot; schemaId: Id }`
  - `schemaRefs(b: BoardState): SchemaRef[]`:
    - one ref per step and filled slot of that step's processor;
    - one ref per stepless processor and filled slot;
    - ordered steps first, then processors, each by id, then slot I, O, C.
  - `orphanCount(b: BoardState): number`
  - `heldBy(b: BoardState, schemaId: Id): Id[]`: the ids of the stepless processors that reference it.

- [ ] **Step 1: Write the failing tests:**
  - `a schema used by a step's processor is wired`.
  - `a schema referenced only by a processor no step uses is held, and that processor is stepless`.
  - `a schema no processor references is an orphan; orphanCount counts it`.
  - `a processor no step uses and with no schema is not stepless`.
  - `two steps sharing a processor give one ref each; one processor using a schema in I and C gives two refs from the same step`.
  - `a slot naming a schema not on the board gives no ref`.
- [ ] **Step 2: Run** `npx vitest run src/design/schemaStates.test.ts` and check it FAILS (module missing).
- [ ] **Step 3: Implement** `schemaStates.ts`. `Slot` and `SLOT_FIELD` come from `design/board.ts`.
- [ ] **Step 4: Run** the same command and check it PASSES.
- [ ] **Step 5: Commit** `feat(acto): derive schema states, stepless processors and reference wires`

### Task 4: Two new block kinds — refs, rectangles, moves, placement, settling

**Files:**
- Modify: `src/Acto/src/model/geometry.ts` (the four size constants), `src/Acto/src/design/board.ts` (`ItemRef.kind` gains `'schema' | 'processor'`), `src/Acto/src/design/edits.ts` (`moveItems`), `src/Acto/src/board/occupied.ts`, `src/Acto/src/board/placement.ts`, `src/Acto/src/design/boardStore.ts`
- Test: `occupied.test.ts`, `placement.test.ts`, `design/edits.test.ts`, `design/boardStore.test.ts`

**Interfaces:**
- Consumes: `schemaStates`, `steplessProcessors`, `schemaRefs` from Task 3.
- Produces:
  - `SIZE` gains `schema` and `processor`. `rectAt` works for both.
  - `occupied(b, ghosts, except = new Set(), withSchemas = false): Rect[]`:
    - when `withSchemas`, it adds every placed schema (keys `schema:<id>`) and every stepless processor (keys `processor:<id>`);
    - otherwise its output is unchanged.
  - `moveItems` moves `schemas[id].at` and `processors[id].at`.
  - `placeSchemas(b: BoardState): BoardState` in `placement.ts` places every schema with `at === null`, plus every stepless processor with `at === null`, per the spec's Placing section, using `freeOffset`.
  - `settleSchemas(b: BoardState, ghosts: readonly GhostItem[]): BoardState` in `placement.ts`:
    1. runs `placeSchemas`;
    2. for each schema and stepless processor that overlaps another rectangle (`overlaps`), applies `pushAside([its rect], others)`, in the same order as `schemaRefs`;
    3. moves nothing else.
  - `BoardStore.place(fn: (b: BoardState) => BoardState): void` applies `fn` to `history.present` and to every `past` and `future` state, like `dropWorkflow` does. It is not an undo step, and it notifies subscribers.

- [ ] **Step 1: Write the failing tests:**
  - occupied: `withSchemas adds placed schemas and stepless processors; without it nothing changes`.
  - edits: `moveItems moves a schema and a processor`.
  - placement: `an unplaced wired schema lands 140px below its first step; an unplaced orphan lands in the column right of everything; a stepless processor lands below everything`.
  - placement: `settleSchemas pushes a schema that overlaps a step aside and leaves steps where they are`.
  - store: `place changes present and past alike: Undo after place does not bring the old schema position back; canUndo is unchanged`.
- [ ] **Step 2: Run** `npx vitest run src/board src/design` and check the new tests FAIL.
- [ ] **Step 3: Implement** as in Interfaces.
- [ ] **Step 4: Run** `npm run typecheck && npm test` and check everything PASSES.
- [ ] **Step 5: Commit** `feat(acto): schema and processor blocks — rectangles, moves, placement, settling outside history`

### Task 5: Picks, toolbar, bar, box select, ghosts and Delete for orphans

**Files:**
- Modify: `src/Acto/src/board/selection.ts` (`Pick` gains `{ kind: 'schema'; id }` and `{ kind: 'processor'; id }`), `board/picks.ts`, `board/selectionBar.ts`, `board/Toolbar.tsx`, `board/boxSelect.ts`, `design/ghosts.ts`, `inspector/InspectorPanel.tsx` (`pickName`)
- Test: `picks.test.ts`, `selectionBar.test.ts`, `Toolbar.test.tsx`, `boxSelect.test.ts`, `design/ghosts.test.ts`

**Interfaces:**
- Consumes: `schemaStates` from Task 3.
- Produces:
  - `pickKey`: `sc:<id>` and `pr:<id>`. `exists` is true when the row is on the board.
  - `deletePicks(b, picks)` removes each picked schema whose state is `'orphan'` and ignores every other schema or processor pick.
  - `barOf(picks, b)`. It now takes the board, and its callers pass `store.state()`:
    - all orphan schemas: `del` true;
    - all ghosts: `restore` and `remove` true, as today;
    - any other mix containing a schema or processor pick: all actions false ("no action in common").
  - `toolbarFor`:
    - an orphan schema gives `[Delete]`;
    - wired or held schemas and processors give `null`.
    - `ToolbarDeps` gains `schemaState(id): SchemaState`.
  - `boxPicks` includes `schema` and `processor` placed items, which only exist while the mode is on (`Placed` comes from the flow nodes).
  - `GhostItem` gains `{ kind: 'schema'; row: SchemaRow }`:
    - `itemsOf` keys it `schema:<id>`;
    - `remapItem`, `moveGhosts`, `placeIn` and `restoreGhosts` handle it, and restoring puts the row back at its ghost place;
    - `everSaved` is `row.updatedAt !== null`.

- [ ] **Step 1: Write the failing tests:**
  - picks: `deletePicks removes an orphan schema and leaves a wired schema, a held schema and a processor`.
  - bar: `two orphans give Delete 2; an orphan and a wired schema give no action; a schema and a step give no action`.
  - toolbar: `an orphan's toolbar is Delete; a held schema, a wired schema and a processor have none`.
  - ghosts: `deleting an orphan records a schema ghost; Restore puts it back at the ghost's place; Undo removes the ghost and Save then sends nothing` (Review Focus 3).
  - boxSelect: `a box over a schema card and a processor card picks both`.
- [ ] **Step 2: Run** `npx vitest run src/board src/design` and check the new tests FAIL.
- [ ] **Step 3: Implement** as in Interfaces. TypeScript's exhaustive switches show every other `Pick` and `GhostItem` switch that needs a case. Give those switches the plain name and no action.
- [ ] **Step 4: Run** `npm run typecheck && npm test` and check everything PASSES.
- [ ] **Step 5: Commit** `feat(acto): pick, box-select and ghost schema and processor cards; Delete only on orphans`

### Task 6: The toggle, the cards, the reference wires, drag and nudge

**Files:**
- Create: `src/Acto/src/board/nodes/SchemaCard.tsx`, `board/nodes/ProcessorCard.tsx`, `board/edges/SchemaRefEdge.tsx`, `shell/schemasMode.ts`
- Modify:
  - `src/Acto/src/tokens.css`: the tokens from Global Constraints, in both theme blocks.
  - `board/board.css`.
  - `board/toFlow.ts`: `BoardView` gains `schemas: boolean` and `hotSchema?: Id | null`.
  - `board/nodes/StepCard.tsx`: three hidden source handles `ref-I`, `ref-O`, `ref-C` at Bottom (left 30%, 50%, 70%).
  - `board/connect.ts`: `nodeId` gains `sc:` and `pr:`.
  - `board/Board.tsx`: `nodeTypes`, `edgeTypes`, `refOf`, `pickOfNode`, `dragStop` and hover.
  - `board/BoardMiniMap.tsx`.
  - `shell/Shell.tsx`: the Schemas button left of Board only.
  - `App.tsx`: mode state, the `settleSchemas` call on turn-on, `occupied(..., withSchemas)` in nudge and toolbox drop, and dropping picks on turn-off.
- Test: `toFlow.test.ts`, `Board.test.tsx`, `shell/Shell.test.tsx`, `shell/schemasMode.test.ts`, `App.test.tsx`

**Interfaces:**
- Consumes: Tasks 3–5.
- Produces:
  - `readSchemasMode(storage: Storage | null): boolean` and `writeSchemasMode(storage, on: boolean): void` in `shell/schemasMode.ts`. The key is `acto.schemas`; storage failures are swallowed.
  - `toFlow` with `view.schemas` adds:
    - node type `'schema'`, id `sc:<id>`, data `{ row, state, pick }`, size `SCHEMA_W×SCHEMA_H`, one target handle `ref` at Top;
    - node type `'processor'`, id `pr:<id>`, the same shape, with source handles `ref-I/O/C` at Bottom;
    - edge type `'schemaRef'`, id `sr:<ownerKind>:<ownerId>:<slot>:<schemaId>`, `selectable: false`, `deletable: false`, `data { slot, lit }`, from the owner's `ref-<slot>` to the schema's `ref`.
    - Schema ghosts become ghost nodes, as today. Without `view.schemas` the output is byte-identical to today.
  - **Shell:**
    - `ShellProps` gains `schemas: { on: boolean; orphans: number; toggle(): void }`.
    - The button has class `pbtn schemas-toggle` plus `on`, `aria-pressed`, title `Show schemas` or `Hide schemas`, and a red count badge when `orphans > 0`.
  - **Cards:**
    - `SchemaCard` shows the label `SCHEMA`, the tag, name, and version in mono. Picked, it wears the accent frame and the pick badge; a ghost uses the existing ghost class.
    - `ProcessorCard` shows `PROCESSOR`, the `no step` tag, the name, and `version · instanceId`.
  - `SchemaRefEdge` draws a smooth-step-free bezier with `strokeDasharray="1 4"`, round caps, `--schema-ref`, width 1.8 (2.6 when lit), an end dot of r 3.5, and a slot pill in the middle (r 8, card fill, letter in mono).

- [ ] **Step 1: Write the failing tests:**
  - schemasMode: `reads '1' as on, anything else off; blocked storage reads off and write does not throw`.
  - toFlow: `without schemas the nodes and edges equal today's`; `with schemas: one schema node per schema, one processor node per stepless processor, one schemaRef edge per ref with handles ref-<slot> → ref`; `hotSchema lights only its edges`.
  - Shell: `the Schemas button shows the orphan count when off, is pressed when on, sits before Board only`.
  - App: `turning the mode on settles a schema hidden under a step and adds no undo step`; `turning it off drops schema and processor picks`; `a nudge of a schema into a step is refused`; `dropping a schema card on a step pushes it aside` (Board dragStop with measured nodes).
- [ ] **Step 2: Run** `npx vitest run` and check the new tests FAIL.
- [ ] **Step 3: Implement** as in Interfaces. The mode lives in `App` state, initialised with `readSchemasMode(localStorage)`. On turn-on, call `store.place((b) => settleSchemas(b, ghosts.ghosts()))` before rendering.
- [ ] **Step 4: Run** `npm run typecheck && npm test` and check everything PASSES. Then run `npm run build`.
- [ ] **Step 5: Commit** `feat(acto): Schemas toggle — schema and processor cards with reference wires, step-like drag and nudge`

### Task 7: Inspector for schema and processor cards

**Files:**
- Create: `src/Acto/src/inspector/tabs/SchemaCardTab.tsx`, `inspector/tabs/ProcessorCardTab.tsx`
- Modify: `inspector/tabs.ts` (`TabId` gains `'schema' | 'stepless'`; `focusOf` and `tabsOf` handle the new picks), `inspector/InspectorPanel.tsx` (`TabBody` and the Header's `locked` prop), `inspector/tabs/shared.tsx` if `EntityBase` needs nothing new (it already has `disabled`)
- Test: `inspector/tabs.test.ts`, `inspector/tabs/SchemaCardTab.test.tsx`, `inspector/tabs/ProcessorCardTab.test.tsx`, `inspector/InspectorPanel.test.tsx`

**Interfaces:**
- Consumes: `schemaStates`, `schemaRefs`, `heldBy` from Task 3. `Go` from `tabs/shared.tsx` picks a chip's target.
- Produces:
  - `tabsOf`:
    - a schema focus gives `[{ id: 'schema', label: 'Schema' }]`;
    - a processor focus gives `[{ id: 'stepless', label: 'Processor' }]`, with child tabs `processorTabsOf(b, id)`;
    - the child tabs render the existing `SchemaTab`-style body read-only (reuse `SchemaTab` with `disabled`, or a thin read-only wrapper).
  - `SchemaCardTab({ state, id, go })`:
    - `EntityBase` with `disabled`, kind line per Global Constraints, and `JsonField` Definition (disabled);
    - the note `The definition is read-only: a change needs the processor restarted.`;
    - the state note: orphan `Orphan: no processor references this schema.` (problem style), held `Held by <name> <version>, a processor no step uses.`, wired `In use. Only orphans can be deleted.`;
    - `Sec` Related with Used by (`LinkChip` per step ref: name = step name, sub = `<Slot name> · <processor name>`, `onOpen` picks the step), Held by (`LinkChip` per holder, `onOpen` picks the processor card), and Location (`locationText(at)`).
  - `ProcessorCardTab({ state, id, go })`:
    - `EntityBase` with `disabled`, kind `processor · no step`, Source hash and Instance id as disabled `TextField`s;
    - the note `Read-only. Acto never changes, copies or deletes a processor.`;
    - Related with Steps `none`, Schemas (`LinkChip` per filled slot, sub = slot name, `onOpen` picks the schema), and Location.
  - `Header({ store, kind, locked })`: when `locked`, Undo and Redo are `disabled` whatever the history holds. `InspectorPanel` passes `locked` when the focus is a schema or processor.

- [ ] **Step 1: Write the failing tests:**
  - tabs: `a schema pick gives the Schema tab; a processor pick gives Processor with its slot child tabs`.
  - SchemaCardTab: `an orphan shows the orphan note and no Used by chips`; `a wired schema lists one chip per step and slot, and clicking one picks that step`; `a held schema lists its processor under Held by`; `every field is disabled`.
  - ProcessorCardTab: `shows Source hash and Instance id disabled; its schema chips pick the schema`.
  - InspectorPanel: `Undo and Redo are disabled while a schema is the focus even when the board can undo; enabled again for a step`.
- [ ] **Step 2: Run** `npx vitest run src/inspector` and check the new tests FAIL.
- [ ] **Step 3: Implement** as in Interfaces.
- [ ] **Step 4: Run** `npm run typecheck && npm test` and check everything PASSES.
- [ ] **Step 5: Commit** `feat(acto): Inspector for schema and processor cards — read-only entity form, Undo/Redo locked`

### Task 8: Browser regression, deploy, docs

**Files:**
- Create: `src/Acto/e2e/regression/13-schemas.spec.ts`
- Modify: `src/Acto/e2e/regression/README.md` (add 13), `docs/superpowers/specs/2026-11-18-acto-triangles-design.md` (one line under kinds: link to this spec)

**Interfaces:**
- Consumes: everything above. The write guard in `e2e/fixtures.ts` allows only `e2e-` rows, so the spec creates its own `e2e-schema-*` schemas and never touches others.

- [ ] **Step 1: Write the spec** (headed and headless). It covers:
  - the toggle persists across reload;
  - the orphan count matches;
  - an `e2e-` orphan is deleted, becomes a ghost, is restored, deleted again, saved, and is gone after reload;
  - a wired schema has no toolbar;
  - a schema dropped on a step is pushed aside;
  - Undo and Redo are disabled with a schema picked;
  - light and dark screenshots of the board with the mode on are saved under `test-results/`.
- [ ] **Step 2: Deploy** BaseAPI (the migration runs on start) and Acto per Global Constraints. Check that the served `index.html` links Inter Tight and that `GET /api/v1/schemas` returns `boardX`.
- [ ] **Step 3: Run** `npx playwright test e2e/regression/13-schemas.spec.ts --headed` and then headless. Both must PASS. Then run `npm run e2e:regression` and check nothing else regressed.
- [ ] **Step 4: Commit** `test(acto): regression 13 — schemas mode; docs`
