# Acto regression suite

Narrative end-to-end runs, each built through the UI (or seeded where building is not the point) and checked with
Playwright; the live ones also read the orchestrator's own records in Elasticsearch. Specs 1–7 predate 2026-11-24;
8–12 cover every change from 2026-11-24 to `dc41011f` (plan:
`docs/superpowers/plans/2026-11-25-acto-regression-since-11-24.md`).

## Running

From `src/Acto`, with BaseApi forwarded on `localhost:18080` and Elasticsearch on `localhost:19200`:

| What | Command |
|---|---|
| Headed and slowed (350 ms a step), not live | `npm run e2e:regression` |
| Headed, with the live runs (6 and 12 start and stop their own `e2e-` workflows) | PowerShell: `$env:ACTO_E2E_LIVE='1'; npm run e2e:regression` |
| Unslowed, headless | `npx playwright test e2e/regression` |
| One spec | `npm run e2e:regression -- 8-board-look` |

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
