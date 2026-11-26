# Acto regression suite

Narrative end-to-end runs, each built through the UI (or seeded where building is not the point) and checked with
Playwright; the live ones also read the orchestrator's own records in Elasticsearch. Specs 1–7 predate 2026-11-24;
8–12 cover every change from 2026-11-24 to `dc41011f` (plan:
`docs/superpowers/plans/2026-11-25-acto-regression-since-11-24.md`); 13–14 cover Schemas mode (plan:
`docs/superpowers/plans/2026-11-26-acto-schemas-mode-regression.md`).

## Running

From `src/Acto`, with BaseApi forwarded on `localhost:18080` and Elasticsearch on `localhost:19200`:

| What | Command |
|---|---|
| Headed and slowed (350 ms a step), not live | `npm run e2e:regression` |
| Headed, with the live runs (6, 12 and 14 start and stop their own `e2e-` workflows; 5 and 14 need a real workflow the cluster already runs) | PowerShell: `$env:ACTO_E2E_LIVE='1'; npm run e2e:regression` |
| Unslowed, headless | `npx playwright test e2e/regression` |
| One spec, headed | `npm run e2e:watch -- e2e/regression/8-board-look.spec.ts` (not `e2e:regression -- <name>`: Playwright ORs the two filters and runs the whole folder) |

The write guard in `e2e/fixtures.ts` holds as everywhere: only `e2e-` rows, Start/Stop only in the live run and only of
a workflow the run made, and the teardown fails the run if a real row changed beyond its location.

## Coverage, 2026-11-24 → 2026-11-25

| # | Theme (commits) | Pinned by |
|---|---|---|
| A | Restore brings a step's ghost wires (`aa35f43e`) | 9 · restore brings its wires |
| B | Entry-step crons end to end, workflow cron removed (`a3a8c0db`…`1ccf9af5`, 41 commits) | 6-cron-live (ES), 7-cron-validation |
| C | Ghosts drag and keep their place; the right-click box picks ghosts (`4a0de8dd`, `d2840634`) | 9 · ghosts drag, box-pick and restore |
| D | Cache items are `[{key,value}]` rows; per-entry limits; bad items refused (`cde15e7d`, `233a74da`, `5b369e9e`) | 11 · cache items cross as pairs |
| E | Valence/Studio and their endpoints removed (`3b421fbd`, `6a6c2b1a`) | 11 · removed endpoints are gone |
| F | A stop tears down every entry-cron job; a restart runs only the new activation (`2d2e10fe`) | 12 (ES) |
| G | An entry arrow moves only when it fires; frozen and unscheduled arrows say why (`6ea3960e`, `5eab52c1`) | 8 · idle entry arrows; 12 (ES) |
| H | Discard (`a0138573`) | 9 · Discard |
| I | Health hearts, beating when live (`f075a50f`, `6cd845bf`) | 8 · health hearts |
| J | Only a delete makes a ghost (`ec5277a5`) | 9 · only a delete makes a ghost |
| K | Wires wear the condition colour, no letter; into Never faded (`e9906db4`, `da70de57`) | 8 · wires; 12 (ES) |
| L | The Kibana diagram draws as the board (`cb3c729a`) | 8 · the published diagram |
| M | A dragged item is on top, "under" in amber, a drop slides aside, ghosts too (`a9067aed`) | 10 · drag |
| N | Toolbox drops slide aside; nudges stop (`dc41011f`) | 10 · toolbox drop and nudge |
| — | Analyst graph wording for entry crons (`ac36bc64`, `5c28a20a`, `14265340`) | not UI: the C# `Processor.Analyst` tests, not this suite |

## Coverage, Schemas mode, 2026-11-26

| # | Change (commit) | Pinned by |
|---|---|---|
| O | BaseAPI stores boardX/boardY on schemas and processors (`490c41b8`) | 13 · moves save; 14 (API read-back) |
| P | Rows carry the place; Save sends it; a move affects no workflow, so no dry run (`a4bf0704`) | 13 · moves save (no `/workflows/*/validate` call for a move alone) |
| Q | Wired / held / orphan, stepless processors, reference wires (`a69e8109`) | 13 · cards and wires |
| R | Card sizes, obstacles only while on, placement, settle on turn-on outside history (`6036c62e`, `c5e219ae`) | 13 · drag, nudge and settle |
| S | Picks, toolbar, bar, box select, schema ghosts; Delete only on orphans (`ecaa8e77`) | 13 · toolbar and bar; 13 · delete, ghost, restore, save |
| T | Toggle, cards, wires, hover, minimap, drag/nudge, light and dark tokens (`929dc667`, `0b62983e`) | 13 · toggle; 13 · cards and wires; 13 · look in both themes |
| U | Inspector read-only forms, chips, Undo/Redo locked (`2ed57a3e`) | 13 · Inspector |
| W | A dragged card stays lifted and a dragged schema's wires stay thick: hover is not followed mid-drag, and a board derived anew mid-drag keeps the drag (2026-11-26) | 13 · a dragged card stays lifted |
| V | Real workflows keep running after real schema and processor locations are saved | 14 (ES, live) |

## Last full run — 2026-11-26

| Run | Result |
|---|---|
| `$env:ACTO_E2E_LIVE='1'; npm run e2e:regression` (headed, slowed, live, specs 1–14) | 48 passed (27.2 min) |
| `npx playwright test e2e/regression` (headless, one spec per process; the single process was stopped for memory after 26 passes) | 44 passed, 4 skipped (live-only: 6, 12, 14 and one in 7). Spec 5 first failed 4 of 6 after a machine reboot left no real workflow running ("the cluster runs at least one workflow"); with `filefetcher-archiveexpander-chain` restarted, 6/6 |
| 14 again, headed and live, after the reboot | 1 passed: the real workflow dispatched at 16:10, 16:11 and 16:12 after the moves, every correlation finished; the `e2e-` run dispatched and completed 4×, then stopped |
| The rest of the e2e folder (headless, three batches) | 24 passed + 21 skipped (live-only), 38 passed, 55 passed |
| 13 alone (with 9 · a dragged card stays lifted), `--repeat-each 5` | 45 passed, none flaky |
| `npm run typecheck`; `npm test` | clean; 902 passed |
| Teardown, every run | `e2e- rows left: 0; real rows changed beyond location: 0` |

Evidence from the live runs: `src/Acto/test-results/cron-live-evidence.json` (6), `src/Acto/test-results/regression-12-evidence.json` (12), and `src/Acto/test-results/regression-14-evidence.json` (14): per-tick
dispatch stamps, step ids and correlation ids from Elasticsearch.
