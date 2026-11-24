# Workflow cron removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the workflow-level cron completely; a workflow is scheduled only by its entry steps' crons, which Acto edits as several crons per workflow.

**Architecture:** One migration copies each workflow cron onto its entry rows and drops the column. The contracts lose
`cron`, and `EntrySchedule` loses its fallback. BaseAPI, the orchestrator and the Analyst follow. Acto replaces the
workflow cron field with a per-entry Schedules section and a summary chip. The deploy re-projects running workflows
before the new orchestrator starts.

**Tech Stack:** .NET 8 (EF Core, Mapperly, FluentValidation, Quartz, Cronos), MTP runner; React + TypeScript (vitest,
Playwright headed).

**Spec:** `docs/superpowers/specs/2026-11-24-workflow-cron-removal-design.md` (builds on `2026-11-24-entry-step-cron-design.md`).

## Global Constraints

- Do not touch `src/WorkflowStudio`, `src/Valence`, `src/Processor.Analyst/Bit/RehearsalGraph.cs`, or the k8s yaml files
  the user has uncommitted edits in (`k8s/31`, `k8s/32`, `k8s/43`).
- Effective cron = the entry step's own cron, normalised (trim, whitespace runs collapsed). There is no fallback.
- An entry step without a cron is allowed and unscheduled. A workflow with no entry cron saves and starts, and never fires.
- Entry-cron validation is unchanged: 5 or 6 fields that parse; at most 120 characters; the key must be an entry step
  of the workflow. Messages are unchanged.
- No compatibility field: `Cron`/`cron` is removed from `WorkflowL1`, `WorkflowStoreProjection` and every DTO.
- Messaging.Contracts is a pinned NuGet 1.0.0. Repack, clear the cache, restore with `--force-evaluate`, and commit the
  lock files.
- Cron text is never logged.
- .NET tests run in `skp-test`. Acto: `npx vitest run`, `npm run typecheck`.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Stage explicit paths only. Do not push.

## Review Focus

1. **A migrated workflow keeps firing.** A workflow with cron `X` and entries A (no cron) and B (`Y`) ends up with
   A = `X` and B = `Y`. Pinned by Task 2 `MigrationCopiesTheWorkflowCronOntoEntriesWithoutOne`.
2. **A stored projection from before this change** (`cron` set, `entryCrons` null) deserializes without error and
   schedules nothing. Pinned by Task 1 `AStoreWithOnlyALegacyCronSchedulesNothing`.
3. **A design-path save that still sends `cronExpression`** (WorkflowStudio) is refused as an unknown field, not
   silently half-applied. Pinned by Task 2 `TheDesignPathRefusesCronExpressionAsUnknown`.
4. **The Acto chip with mixed crons:** two entries on one cron and one unscheduled shows that one cron, not
   "2 schedules". Pinned by Task 4 `chipShowsTheSharedCronWhenUnscheduledEntriesAreIgnored`.
5. **An old Acto draft in localStorage that still has `cronExpression`** loads without error, and the field is dropped
   on save. Pinned by Task 3 `aDraftWithALegacyCronExpressionLoadsAndSavesWithoutIt`.

---

### Task 1: Contracts and every C# reader drop the workflow cron

**Files:**
- Modify: `src/Messaging.Contracts/WorkflowL1.cs`, `src/Messaging.Contracts/Projections/WorkflowStoreProjection.cs`, `src/Messaging.Contracts/Projections/EntrySchedule.cs` (+ nupkg, lock files)
- Modify: `src/Orchestrator/L1/L2WorkflowReader.cs`, `src/Orchestrator/L1/WorkflowActivator.cs`, `src/Orchestrator/Scheduling/WorkflowFireJob.cs`, `src/Orchestrator/Scheduling/CronInterval.cs` (doc only)
- Modify: `src/Processor.Analyst/Graph/L2WorkflowGraphSource.cs`, `src/Processor.Analyst/Graph/GraphRenderer.cs`
- Modify: `src/BaseApi.Service/Features/Orchestration/OrchestrationService.cs:239`, `src/BaseApi.Service/Features/Orchestration/Projection/L2ProjectionWriter.cs:72`
- Test: `EntryScheduleTests`, `WorkflowActivatorTests`, `WorkflowFireJobTests`, `L2WorkflowReaderTests`, `HydrationServiceTests`, `ApplyHandlerTests`, `StartStopIdempotencyTests`, `StartDrivenProjectionTests`, `L2KeyLayoutTests`, `RunningGraphTests`, `GraphLayersTests`, `Support/L2Seed.cs`, and any other test that builds `WorkflowL1`/`WorkflowStoreProjection` with a cron

**Interfaces:**
- Produces:
  - `WorkflowL1(Guid WorkflowId, List<Guid> EntryStepIds, List<StepL1> Steps, List<CacheL1> Caches, Dictionary<Guid,string>? Names = null, Dictionary<Guid,string>? EntryCrons = null)`
  - `WorkflowStoreProjection(List<Guid> EntryStepIds, List<StepL1> Steps, Dictionary<Guid,string>? EntryCrons = null)`. JSON names `entryStepIds`, `steps`, `entryCrons`.
  - `EntrySchedule.EffectiveCron(Guid stepId, IReadOnlyDictionary<Guid,string>? entryCrons) -> string?`
  - `EntrySchedule.Groups(IReadOnlyList<Guid> entryStepIds, IReadOnlyDictionary<Guid,string>? entryCrons) -> IReadOnlyList<EntryGroup>`
  - `RunningGraph` keeps its `Cron` parameter; `L2WorkflowGraphSource` passes `null`.
  - `GraphRenderer` replaces the `Schedule: cron "…"` line with `Schedule: each entry step runs on its own cron (six fields, seconds first).`
    followed by one line per entry step, in `EntryStepIds` order: `Entry {Ref(step)} runs on cron "{cron}".` or
    `Entry {Ref(step)} has no schedule.` This replaces the previous own-cron lines.

- [ ] **Step 1: Write the failing tests.**
  - `EntryScheduleTests`: rewrite for the new signatures. Add `AStepWithoutAnEntryCronIsUnscheduled`.
  - `L2WorkflowReaderTests.AStoreWithOnlyALegacyCronSchedulesNothing`: store JSON `{"entryStepIds":[A],"cron":"*/30 * * * * *","steps":[…]}`.
    Expect it to read without error and `EntryCrons` null. The activator test given that definition expects zero `ScheduleAsync` calls.
  - `RunningGraphTests.EveryEntryStepHasAScheduleLine`: one entry with a cron and one without; expect both lines.
- [ ] **Step 2: Run them and see them fail.** Run the classes in `skp-test`. Expected: build errors on the removed parameters.
- [ ] **Step 3: Implement.** Repack Messaging.Contracts. Remove the workflow-cron arguments everywhere above.
  `OrchestrationService` stops passing `Cron:`. Task 2 removes the DTO field, so here it simply isn't read.
- [ ] **Step 4: Run them and see them pass.** Run the `BaseApi.Tests.Orchestrator`, `BaseApi.Tests.Orchestration` and
  `BaseApi.Tests.Analyst` namespaces, the `Projection` classes, then the full BaseApi.Tests.
- [ ] **Step 5: Commit** `feat(contracts)!: a workflow has no cron; entry steps carry the whole schedule`.

### Task 2: BaseAPI drops the workflow cron column and field

**Files:**
- Modify: `src/BaseApi.Service/Features/Workflow/WorkflowEntity.cs`, `Persistence/Configurations/WorkflowEntityConfiguration.cs`
- Create: `src/BaseApi.Service/Persistence/Migrations/20261124180000_RemoveWorkflowCron.cs` + `.Designer.cs`. Hand-write them; update `AppDbContextModelSnapshot.cs`.
- Modify: `WorkflowDtos.cs` (Create/Update/Read lose `CronExpression`), `WorkflowEntityMapper.cs`, `WorkflowDtoValidator.cs` (drop the workflow-cron rule; keep `BeValidStandardCron` for entry crons)
- Modify (WorkflowStudio paths in BaseAPI): `Workflow/Graph/WorkflowGraphDtos.cs` (`GraphWorkflowDto` loses `CronExpression`), `Graph/WorkflowGraphSaver.cs`, `Design/DesignFields.cs` (`cronExpression` case removed, so it hits the unknown-field branch), `Design/CreateWorkflowStage.cs`, `Design/OwnedStages.cs`, `Design/WorkflowDesignSyncer.cs`
- Modify: `WorkflowEntrySteps.cs` doc (no fallback)
- Test: a new `src/tests/BaseApi.Tests/Persistence/RemoveWorkflowCronMigrationTests.cs`, plus `EntryCronValidationTests`, `WorkflowReadEnrichmentTests`, `ModelFieldsTests`, `DesignFieldsTests`, `DesignNewWorkflowTests`, `DesignOwnedStagesTests`, `WorkflowGraph*` tests and every test constructing these DTOs (`BoardLocationTests`, `WorkflowCacheJunctionTests`, `NullCollectionCascadeTests`, Live tests' DTO builders)

**Interfaces:**
- Produces:
  - `WorkflowCreateDto(Name, Version, Description, EntryStepIds, AssignmentIds, CacheIds, BoardX = null, BoardY = null, EntryCrons = null)`, with `CronExpression` removed and the other parameters in their existing order. `WorkflowUpdateDto` and `WorkflowReadDto` follow the same pattern.
  - Migration Up SQL, the exact intent:
    `UPDATE workflow_entry_steps e SET cron_expression = w.cron_expression FROM workflows w WHERE e.workflow_id = w.id AND e.cron_expression IS NULL AND w.cron_expression IS NOT NULL;`
    then drop the column. Down re-adds it as nullable `varchar(120)`. Use the real snake_case table and column names from the snapshot.

- [ ] **Step 1: Write the failing tests.**
  - `RemoveWorkflowCronMigrationTests.MigrationCopiesTheWorkflowCronOntoEntriesWithoutOne`: assert on the SQL the
    migration emits, or run it against the test DB provider if migrations are executable there. Pick the approach
    existing migration tests use; if none exist, assert the generated SQL contains the UPDATE…FROM and the drop, in that order.
  - `DesignFieldsTests.TheDesignPathRefusesCronExpressionAsUnknown`
  - `ModelFieldsTests`: the workflows table lists no `cronExpression`.
  - `EntryCronValidationTests`: still green. Add `AWorkflowWithNoEntryCronsIsValid`.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and see them pass.** Run the listed classes, then the full BaseApi.Tests (known failures:
  4 Ffmpeg, QueueDepth, EnvelopeContract, ValenceFieldsSnapshot, intermittent StartupPreflight).
- [ ] **Step 5: Commit** `feat(baseapi)!: the workflow cron moves onto its entry steps and the column is dropped`.

### Task 3: Acto model, save and chat drop `cronExpression`

**Files:**
- Modify: `src/Acto/src/api/schema.d.ts`, `src/Acto/openapi/baseapi.v1.json` (remove `cronExpression` from the workflow DTOs; regenerate with `npm run gen:api` if App Control allows, otherwise hand-edit)
- Modify: `src/Acto/src/design/board.ts`, `api/toModel.ts`, `design/changes.ts`, `design/edits.ts`, `design/boardStore.ts` (`readDraft` drops a legacy `cronExpression` key), `design/diagramSvg.ts`, `operate/clipboard.ts`, `model/graph.ts`, `api/fixtures.ts`, `design/boardFixtures.ts`, `App.tsx`, `inspector/tabs/GhostTab.tsx`
- Modify: `chat/tools/fields.ts` (workflow fields: name, version, description), `chat/tools/read.ts`, `chat/tools/workflows.ts` (new_workflow text), `chat/prompt.ts`
- Test: affected vitest files, `boardStore.test.ts`

**Interfaces:**
- Produces: `WorkflowRow` without `cronExpression`. `setWorkflowField` no longer accepts it.

- [ ] **Step 1: Write the failing tests.**
  - `boardStore.test.ts aDraftWithALegacyCronExpressionLoadsAndSavesWithoutIt`
  - `tools.test.ts`: `set_field` refuses `cronExpression` on a workflow.
  - `read_board` shows no workflow cron.
- [ ] **Step 2: Run them and see them fail.** Run `npx vitest run`.
- [ ] **Step 3: Implement.** Leave `inspector/tabs/WorkflowTab.tsx`, `LinkTab.tsx` and the toolbar/triangle for Task 4.
  Make them compile by removing references only.
- [ ] **Step 4: Run them and see them pass.** Run `npx vitest run` and `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(acto)!: workflows have no cron of their own`.

### Task 4: Acto edits several crons per workflow

**Files:**
- Modify: `src/Acto/src/inspector/tabs/WorkflowTab.tsx`. Replace the cron field with a **Schedules** section, one row per entry step in `entryStepIds` order. Each row holds:
  - the step name
  - a `CronField` (with presets, placeholder `not scheduled`)
  - the `cronText` reading below it

  Edits go through `edit((b) => setEntryCron(b, wf, step, v), \`entryCron:${wf}:${step}\`)`. If there are no entry
  steps, show `No entry steps — draw an entry arrow to schedule this workflow.`
- Modify: `src/Acto/src/inspector/tabs/LinkTab.tsx`. The placeholder is always `not scheduled`.
- Modify: the toolbar cron chip (`app/…` or wherever `cronExpression` was shown on the capsule/toolbar) and the triangle label.
  - Create `src/Acto/src/model/scheduleSummary.ts` with `scheduleSummary(w: WorkflowRow): string`.
  - It returns `⏱ <cron>` when every entry that has a cron shares one normalised cron.
  - It returns `⏱ <n> schedules` when they differ (n = distinct crons).
  - It returns `⏱ not scheduled` when none has a cron.
- Test: `model/scheduleSummary.test.ts`, `inspector/tabs/WorkflowTab.test.tsx`, `LinkTab.test.tsx`

- [ ] **Step 1: Write the failing tests.**
  - `scheduleSummary`:
    - one cron → `⏱ */10 * * * * *`
    - two different → `⏱ 2 schedules`
    - none → `⏱ not scheduled`
    - `chipShowsTheSharedCronWhenUnscheduledEntriesAreIgnored`
    - whitespace variants count as one cron
  - `WorkflowTab`:
    - `theSchedulesSectionEditsEachEntrysCron`: two entries; set B; expect the state and one undo step.
    - `anEditInTheLinkTabShowsInTheSchedulesSection`, sharing the merge key.
    - `aWorkflowWithoutEntriesExplainsHowToSchedule`
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and see them pass.** Run `npx vitest run` and `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(acto): a workflow's schedules are its entry arrows' crons, edited together on the workflow`.

### Task 5: Acto e2e — existing suite updated, multi-cron specs added

**Files:**
- Modify: `src/Acto/e2e/seed.ts` (seed entry crons instead of a workflow cron), `e2e/copy-items.spec.ts`,
  `e2e/regression/1-build.spec.ts`, `e2e/entry-cron.spec.ts`, and any spec that reads or sets the workflow cron
- Create: `src/Acto/e2e/multi-cron.spec.ts`. In a throwaway workflow with entry arrows A and B:
  1. Set A to `*/30 * * * * *` and B to `*/10 * * * * *` from the Workflow tab's Schedules section.
  2. The chip reads `⏱ 2 schedules`. Save and reload; both crons are kept.
  3. Edit B in the Link tab; the Schedules section shows it.
  4. Undo and redo.
  5. Clear B; the chip shows A's cron.
  6. Clear A; the chip reads `⏱ not scheduled`.
  7. Delete the entry arrow of a step that has a cron, save, and confirm BaseAPI accepted the save.
  8. Clean up. Never Start or Stop.

- [ ] **Step 1: Update the specs** that used the workflow cron, and write `multi-cron.spec.ts`.
- [ ] **Step 2: Type-check them** (`npx playwright test --list`).
- [ ] **Step 3: Commit** `test(acto): e2e for several crons per workflow; suite follows the cron removal`. The specs run after deploy, in Task 6.

### Task 6: Deploy, re-project running workflows, verify headed and in ES

- [ ] **Step 1: Baseline.** From Elasticsearch, record the last 10 minutes of `dispatched an entry step` per running
  workflow (chain `8cfdbcdb…`, napole-splitchain `2975f4b3…`): count per step and the interval.
- [ ] **Step 2: Deploy BaseAPI.** Build, import to `desktop-control-plane`, roll out. Verify the migration is in
  `__EFMigrationsHistory`, `workflows.cron_expression` is gone, and the running workflows' entry rows carry their former cron.
- [ ] **Step 3: Re-issue Start** for both running workflows through BaseAPI's start endpoint. Verify their L2 store field
  has `entryCrons` and no `cron`.
- [ ] **Step 4: Deploy the orchestrator.** Verify the logs show "activated workflow … in N schedule groups" with N ≥ 1 for both.
- [ ] **Step 5: Deploy Acto** and restart the 18083 port-forward. Verify the served bundle changed.
- [ ] **Step 6: ES after the deploy.** Over 10 minutes, both running workflows dispatch at the same cadence as the baseline.
- [ ] **Step 7: Live tests.** Update `EntryCronLiveTests` (no workflow cron; A and B entry crons) and run it. Add and run
  `AWorkflowWithNoEntryCronStartsAndDispatchesNothing` (start, wait 30 s, ES shows zero dispatches, stop, delete).
- [ ] **Step 8: Headed Playwright** against the deployed Acto (or the e2e Vite server against the deployed BaseAPI, as
  the suite is configured): run the whole Acto e2e suite, including `e2e/regression`, with `--headed`. Record pass/fail
  per spec. Fix spec bugs; report app bugs with evidence.
- [ ] **Step 9: Commit** the live-test changes `test(live): the workflow cron is gone — entry crons alone schedule, and none means none`.
