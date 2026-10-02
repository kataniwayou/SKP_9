# Handover — 2026-10-02 (evening)

Branch `feature/path-importer`, last commit `e2f8246`, nothing pushed (the user chose to keep the
branch as-is). Supersedes `docs/HANDOVER-2026-10-02.md`. Read this, then
`docs/superpowers/specs/2026-10-02-step-role-edges-design.md`.

## What happened today

`RunPosition` was replaced by `StepRole` in two rounds:

1. **Graph-role model** (`0688b06..d0487fa`, now superseded): BaseApi wrote per-workflow role keys,
   a framework resolver read them, three values (`entry`/`intermediate`/`terminal`) on every
   outcome record, a two-ring funnel pie. Deployed to dev, then reworked at the user's request.
2. **Edges model** (`c105f8a..e2f8246`, current): `StepRole` marks only a run's two edges.
   - `entry` is hardcoded by `WorkflowFireJob` on each "dispatched an entry step" record, after a
     successful send. One per entry step per fire.
   - `terminal` is stamped by `StepOutcomeHandler` on the branch-ends record of a step whose
     `StepL1.NextStepIds` is empty (null-safe) in the L1 entry of the outcome's workflow, any result.
   - No other record carries it. No role keys, no `StepRoleResolver`, no `intermediate`.
   - Kibana: the "Run edges — entry dispatches and terminal outcomes" pie (object id still
     `skp-runposition-pie`). Analyst: `run-boundaries` reads the two edges plus `recordsImported`;
     prompt **v12**.

Both rounds ran subagent-driven with a review per task and a whole-branch review; all reviews closed.
Full suite: 1,801 tests, 0 failed, 45 skipped (all in `Live/`).

## The one thing to understand about the edges model

On `filefetcher-archiveexpander-chain`, **`terminal` counts failed items only.** `export-outcome` is
the only step with no successors and is reached only through `record-outcome` (Failed). Good items
end at `split-exporter`, which has a Failed-only successor, so it is not terminal. A healthy window
with no failures shows `entry` and **no** `terminal`; that is not a stall. Every text (panel, primer,
v12, Kibana description, docs, spec) says so. The user was told; changing `terminal` to "the branch
ended and no successor accepted the result" would be a design change they have not asked for.

Records written before ~17:52Z on 2026-10-02 carry the superseded model's values (entry on the
importer's outcome records, `intermediate` elsewhere). A time range spanning the rollout mixes them.

## What is deployed on dev

- baseapi, orchestrator (3 replicas) and the Analyst (2 pods) run the edges build.
- Analyst SourceHash `5b49f302…` (row `analyst`), `Analyst__Bit__Mode=StructureOnly` (also in
  `k8s/43-processor-analyst.yaml`), prompt v12 in `analyst-monitor-cfg`.
- No `skp:wf:*:step:*` keys remain in Redis (the ten old role keys were deleted).
- Kibana export imported (7 objects overwritten); the Workflow control is pinned to the chain.
- `skp:live` holds only `1a56b3ca…` (filefetcher-archiveexpander-chain). Feed simulators stopped.
- **`analyst-monitor` (`208cba76-d635-4721-9aff-a7f22ee09224`) is STOPPED.** It was started at
  18:43Z and stopped at 18:44Z by the user, before its first fire. Its cron is still
  `0 9,39 * * * *` (twice an hour).
- Verified on dev: the `endless-feed-edges` window (17:58:45–18:13:45Z) has 15 fires, 125 items
  imported, `entry` 15 at split-importer, `terminal` 75 at export-outcome, and no role on any other
  record. Captured as the replay baseline.

## Money

Moonshot balance was **$18.93** this morning; nothing has been spent since (no replay, no fire).
About **$0.70 per investigation**; a 5×4 replay round ≈ $14. The current cron (48 fires/day)
would cost about $34/day — **lower the frequency before starting `analyst-monitor` again**
(stop → GET the workflow → PUT it back with every field and only the cron changed → start).

## Open items, in rough order

1. **Decide the monitor's schedule**, then fire it once against a live fault (Redis `CLIENT PAUSE`,
   or scale a processor to 0) to see the edges panel in a real investigation.
2. **Replay round** against `endless-feed-edges` (≈ $14 for 5×4) — balance permitting. The
   scenarios skip unless `SKP_ANALYST_REPLAY=1`.
3. **Two stale comments**, fix at the next Analyst rebuild (editing them moves the SourceHash):
   `src/Messaging.Contracts/OutcomeTemplates.cs` doc comment (says these records carry StepRole and
   feed a funnel), and `src/Processor.Analyst/Panels/ElasticPanelSource.cs` ~414 (calls
   entry-with-no-terminal "a stall").
4. Remaining Analyst gaps from before: graph drift check (L2 vs BaseApi); computed per-path
   expectations in code.
5. Re-enable the BIT before any cron: rewrite the exam and `RehearsalPanels` for v12 and a fixture
   graph; switch `Analyst__Bit__Mode` back to Full.
6. **Offline drop:** this checkout has no `ship/` baseline, so `tools/ship-delta.ps1` cannot diff.
   When it is available, follow `docs/offline-steprole-drop.md` (edges model, deploy order, the
   one-time role-key cleanup, the Analyst SourceHash repoint, StructureOnly apply).
7. Design question left with the user: whether successful completions should be an exit edge.

## How to run things

- **Test runner:** rebuild first (`cd src && dotnet build tests/BaseApi.Tests/BaseApi.Tests.csproj
  --no-restore -v q`), then run `src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe`
  (`--filter-class`, `--filter-method`, `--filter-namespace`). `dotnet test` hides names.
- **After editing Messaging.Contracts / BaseConsole.Core / BaseProcessor.Core:** `bash scripts/pack-all.sh`.
- **Replay:** `cd src/tests/BaseApi.Tests && SKP_ANALYST_REPLAY=1 SKP_ANALYST_REPLAY_RUNS=5
  ./bin/Debug/net8.0/BaseApi.Tests.exe --filter-method "*AnalystReplayScenarios.<Scenario>"`
  (default prompt v12, window `endless-feed-edges`).
- **Capture a window:** `SKP_ANALYST_CAPTURE=1 SKP_CAPTURE_NAME=… SKP_CAPTURE_FROM=… SKP_CAPTURE_TO=…`
  with `--filter-method "*CaptureAWindow"`; write the answer key into `window.json` by hand,
  separating what was predicted before reading from what was corroborated after.
- **Feed:** `python -u tools/simulate-endless-feed.py --start-serial 262 --cycles 30` from PowerShell
  (serials 202–261 are used; 30 cycles ≈ 15 min).
- **Kibana checker:** `python tools/verify-kibana-dashboard.py kibana/kibana-export.ndjson` (offline
  checks 11 and 14); without the argument it runs the live checks. Live checks 4/7 fail on empty
  importer polls and 9/13 need a second running workflow — both predate this work.
- **Deploy loop:** `docker build` → `kind load docker-image <img>:local --name desktop` (the cluster
  is kind whatever the kube context says) → repoint the Analyst SourceHash from a local build
  (pwsh) → `kubectl -n skp rollout restart`.

## Gotchas met today

- **A stale test binary faked a failure:** after a RED check against old code, the files were
  restored but not rebuilt, and the full suite ran the old binary. Always rebuild before running.
- **ES|QL reserves `last`** as a word; a column named `last` is a parse error.
- **The importer writes one outcome per item imported**, plus one per empty poll — so anything
  counting the entry step's outcomes counts items, not fires.
- **Dropped fire on a StatefulSet roll:** one fire can log "the projection store is unusable; this
  fire dispatches nothing" during an orchestrator rollout. A rollout artifact, not a fault.
- Kibana import does not need a data-view refresh for StepRole any more (the field is indexed).

## Untracked files (left alone deliberately)

`.playwright-mcp/`, `.wf-restore.json`, `tools/simulate-approved-feed.py` — not this work's; ask the
user before committing or deleting.
