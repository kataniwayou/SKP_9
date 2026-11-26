# Acto Schemas mode — headed browser regression and live ES verification

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Pin every change from the Schemas-mode plan with headed Playwright regression specs. Then show, from
Elasticsearch, that real workflows keep running after schema and processor cards are moved and saved.

**Replaces:** Task 8 of `docs/superpowers/plans/2026-11-26-acto-schemas-mode.md` (user, 2026-11-26: "plan ui in head e2e
regression tests that include all the modifications. verify by es logs for real workflows and playwright").

**Spec:** `docs/superpowers/specs/2026-11-26-acto-schemas-mode-design.md`

## Global Constraints

- **Running:**
  - From `src/Acto`, with BaseAPI on `localhost:18080`, Acto on `localhost:18083` and Elasticsearch on `localhost:19200` (see `e2e/regression/README.md`).
  - Headed and slowed: `npm run e2e:regression`. The live run: PowerShell `$env:ACTO_E2E_LIVE='1'; npm run e2e:regression`.
- **Write guard and teardown:**
  - They stay strict for every other table.
  - They now also cover `schemas` and `processors`. Teardown must still report `e2e- rows left: 0; real rows changed beyond location: 0`, and now checks those two tables as well.
- **What a run may change:**
  - Schemas: `e2e-` throwaway schemas may be created and deleted. A real schema may only change its location.
  - Processors: Acto never creates or deletes one. A real processor may only change its location.
  - Seeds may create `e2e-` processors **through the API only**, never through the page. Teardown deletes them before their schemas.
- **Start/Stop:** only in the live run, and only of an `e2e-` workflow the run made (unchanged).
- **Evidence:** `src/Acto/test-results/regression-14-evidence.json` (ES counts, correlation ids, before and after rows), plus light and dark screenshots under `test-results/`.

## Coverage

| # | Change (commit) | Pinned by |
|---|---|---|
| O | BaseAPI stores boardX/boardY on schemas and processors (`490c41b8`) | 13 · moves save; 14 (API read-back) |
| P | Rows carry the place; Save sends it; a move affects no workflow, so no dry run (`a4bf0704`) | 13 · moves save (no `/workflows/*/validate` call for a move alone) |
| Q | Wired / held / orphan, stepless processors, reference wires (`a69e8109`) | 13 · cards and wires |
| R | Card sizes, obstacles only while on, placement, settle on turn-on outside history (`6036c62e`) | 13 · drag, nudge and settle |
| S | Picks, toolbar, bar, box select, schema ghosts; Delete only on orphans (`ecaa8e77`) | 13 · toolbar and bar; 13 · delete, ghost, restore, save |
| T | Toggle, cards, wires, hover, minimap, drag/nudge, light and dark tokens (`929dc667`) | 13 · toggle; 13 · cards and wires; 13 · look in both themes |
| U | Inspector read-only forms, chips, Undo/Redo locked (`2ed57a3e`+fix) | 13 · Inspector |
| V | Real workflows keep running after real schema and processor locations are saved | 14 (ES, live) |

---

### Task A: Guard, teardown and seeds learn schemas and processors

**Files:** `src/Acto/e2e/stack.ts`, `src/Acto/e2e/fixtures.ts`, `src/Acto/e2e/seed.ts`; test: `src/Acto/e2e/stack.test.ts` (or a vitest beside the existing guard tests, if any).

- **`stack.ts`:**
  - `TableName` and `TABLES` gain `'schemas' | 'processors'`, so the snapshot and `realDifferences` cover them.
  - `deleteE2eRows` deletes `e2e-` processors before `e2e-` schemas.
- **`refusal()` in `fixtures.ts`:**
  - `schemas`: create only `e2e-`; delete only rows the run made; update a real row only in `boardX`/`boardY` (the definition must be byte-identical or canonically equal).
  - `processors`: no create, no delete; update a real row only in `boardX`/`boardY`.
- **`seed.ts`:**
  - `SchemaSeed { key; name; definition?; at? }`.
  - `ProcessorSeed { key; name; sourceHash; input?; output?; config? }`. The slots are schema keys. These are created through `apply()`, never through the page.
  - `StepSeed.processor` may name a seeded processor key.

- [ ] Unit-test `refusal`:
  - a location-only update of a real schema or processor passes;
  - a name change of a real schema is refused;
  - a processor create or delete is refused;
  - a create of a schema not named `e2e-` is refused.
- [ ] Run `npx vitest run e2e` (or wherever these live) and `npm run typecheck`. Commit.

### Task B: Spec 13 — `e2e/regression/13-schemas.spec.ts` (headed, not live)

**Seed** (one `beforeAll`, all named `e2e-`):
- processor `e2e-proc-a`: Input `e2e-in`, Config `e2e-cfg`;
- steps `e2e-s1` and `e2e-s2` on `e2e-proc-a`, wired `e2e-s1 → e2e-s2`, in workflow `e2e-wf`;
- stepless processor `e2e-proc-b`: Config `e2e-held`;
- orphans `e2e-orph-1`, `e2e-orph-2`, `e2e-orph-3`.

Every test starts from a cleared `localStorage`.

1. **toggle:**
   - Off by default, and no schema card exists.
   - The red count is ≥ 3.
   - Click: `aria-pressed=true`, and the cards appear.
   - Reload: still on.
   - Click: the cards and `.react-flow__edge-schemaRef` edges are gone.
   - Button order: Schemas comes before Board only.
2. **cards and wires:**
   - `e2e-in` and `e2e-cfg` show no tag.
   - Edges from `e2e-s1` and `e2e-s2`: two to `e2e-in` with pill `I`, two to `e2e-cfg` with pill `C`.
   - `e2e-held` is tagged `held` and has one `C` wire from the `e2e-proc-b` card, which reads `PROCESSOR`, `no step`.
   - The three orphans are tagged `orphan` and have no edge.
   - Hover over `e2e-in`: its edges have stroke-width 2.6, the others 1.8.
   - Edges cannot be picked: clicking a wire picks nothing.
3. **look in both themes:**
   - Light, checked with computed styles:
     - schema card background `rgb(230, 238, 251)` and border colour `rgb(0, 89, 220)`, radius `3px`;
     - processor card background `rgb(30, 30, 30)`;
     - wire stroke `rgb(0, 89, 220)` with dasharray `1 4`.
   - Dark (theme switch): schema border `rgb(61, 124, 240)`, wire `rgb(122, 167, 255)`, processor `rgb(43, 43, 43)`.
   - Save screenshots `test-results/13-schemas-light.png` and `-dark.png`.
4. **toolbar and bar:**
   - An orphan's toolbar is exactly `[Delete]`, with no Copy.
   - A wired schema, a held schema and a processor card show no toolbar.
   - Ctrl+click two orphans: the bar reads `Delete 2`.
   - Orphan plus wired: `no action in common`. Orphan plus step: `no action in common`.
   - A right-click box over two orphans and the processor card picks all three, and the bar reads `no action in common`.
   - The Delete key on a picked orphan does nothing.
5. **delete, ghost, restore, save:**
   - Delete `e2e-orph-1`: it becomes a ghost, and the count drops by 1. Its toolbar is `Restore · Remove`.
   - Drag the ghost 120px. Restore: the card is back at the dragged place.
   - Delete again, then Ctrl+Z: no ghost, and Save says `Nothing to save`.
   - Delete again, then Save: `/model/apply` carries `{op:'delete', table:'schemas'}` for it.
   - Reload: it is gone, with no ghost (it was saved).
6. **drag, nudge and settle:**
   - Drag `e2e-orph-2` onto `e2e-s1`: after the drop their rects do not overlap and keep ≥ 16px clear.
   - Nudge `e2e-orph-3` toward `e2e-s2` until blocked: the last nudge is refused (position unchanged).
   - Mode off. Drag `e2e-s2` onto `e2e-orph-3`'s stored place. Mode on: `e2e-orph-3` was pushed aside.
   - Ctrl+Z: `e2e-s2` goes back, and `e2e-orph-3` stays where it was settled.
   - Save: the changes carry `schemas/<orph-3>` boardX/boardY only.
7. **Inspector:**
   - Orphan:
     - kind line `schema · orphan`;
     - note `Orphan: no processor references this schema.`;
     - every input and textarea is disabled;
     - Undo and Redo are disabled, even after a board move made undo possible.
   - Wired `e2e-in`: kind line `schema · I of e2e-proc-a` (once). The Used by chips name `e2e-s1` and `e2e-s2`. Clicking `e2e-s1` picks the step, and the Inspector shows the Step tab with Undo enabled.
   - Held: `Held by e2e-proc-b <version>, a processor no step uses.` Clicking the chip picks the processor card.
   - Processor card: kind line `processor · no step`; Source hash and Instance id are disabled; its Config schema child tab is read-only.
8. **moves save** (O, P):
   - Drag a **real** wired schema card and a real stepless processor card (skip the processor half if the stack has none). Save.
   - The guard passes them as location-only.
   - No `POST /workflows/*/validate` was sent for this Save (a move affects no workflow).
   - GET `/schemas/<id>` reads back the new boardX/boardY.
   - Teardown shows real rows changed beyond location: 0.

- [ ] Write the spec. Run it headed: `npm run e2e:watch -- e2e/regression/13-schemas.spec.ts`. All tests must pass.
- [ ] Run it headless (`npx playwright test e2e/regression/13-schemas.spec.ts`), then 3× repeated (`--repeat-each 3`) to catch flakes. Commit.

### Task C: Spec 14 — `e2e/regression/14-schemas-live.spec.ts` (live, ES)

Runs only with `ACTO_E2E_LIVE=1`, otherwise it skips.

1. **Before:**
   - Record `t0`.
   - For every real workflow that is running (the orchestrator status endpoint, as in spec 12), count its ES records for `ENTRY_DISPATCHED` in the 5 minutes before `t0`.
   - Read every real processor and schema row.
2. **Move real cards and save:**
   - In the UI: mode on, drag the input schema of a processor that a **running** real workflow uses, and a stepless real processor card if there is one. Save.
   - The guard allows location-only.
   - Record `t1`.
3. **Real rows unchanged:** apart from boardX, boardY and updatedAt, every real processor and schema field is identical to before.
4. **Real workflows keep running:**
   - Each running real workflow logs `ENTRY_DISPATCHED`, and `ENTRY_COMPLETED` or `HANDED_OFF`, after `t1`. Wait with `settledLogs`, up to the workflow's cron period plus 60s.
   - If no real workflow is running, the test fails with a clear message naming that precondition. It does not skip silently: verifying real workflows is the point.
5. **A fresh run on the moved schema:**
   - Build an `e2e-` workflow through the UI from the real processor whose schema was moved, as spec 6 does.
   - Start it.
   - ES shows `ENTRY_DISPATCHED` and `ENTRY_COMPLETED` with its workflow id after the start.
   - Stop it, and its records stop.
6. **Evidence:** write `test-results/regression-14-evidence.json` with the counts, correlation ids, and the before and after rows of the moved real schema and processor.

- [ ] Write the spec. Run it headed and live: PowerShell `$env:ACTO_E2E_LIVE='1'; npm run e2e:watch -- e2e/regression/14-schemas-live.spec.ts`. It must pass.
- [ ] Commit, with the evidence file kept out of git (`test-results/` is ignored).

### Task D: Deploy, the full suite, docs

- [ ] **Deploy BaseAPI.** Build the image, import it into the node, `rollout restart`. The migration runs at start. Check that `GET /api/v1/schemas` rows carry `boardX`.
- [ ] **Deploy Acto** the same way. Re-open `port-forward svc/acto 18083:8080`. Check that the served `index.html` links Inter Tight.
- [ ] **Run the full suites:**
  - `$env:ACTO_E2E_LIVE='1'; npm run e2e:regression` (headed, slowed, live): all pass, or each failure is explained.
  - `npx playwright test` (the whole e2e folder, headless): all pass, except the skipped live-only tests.
- [ ] **Update `e2e/regression/README.md`:** coverage rows O–V and the "Last full run" table with today's numbers and the teardown line. Commit.
