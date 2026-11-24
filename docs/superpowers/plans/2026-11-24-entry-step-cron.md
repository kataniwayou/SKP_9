# Entry-step cron Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each entry step of one workflow fire on its own cron (A every 30 s, B every 10 s), edited from Acto.

**Architecture:** The cron is stored on the `WorkflowEntrySteps` junction row and travels to L2 as an optional
`entryCrons` map. The orchestrator groups entry steps by effective cron and runs one Quartz job per group, keyed
`(group: workflowId, name: "{activationId}/{index}")`. `L1Entry` stays unchanged, and stop/restart delete the whole
Quartz group. Acto edits the cron on the entry arrow.

**Tech Stack:** .NET 8 (EF Core, Mapperly, FluentValidation, Quartz, Cronos, StackExchange.Redis), MTP test runner;
React + TypeScript (Vite, vitest, Playwright) for Acto.

**Spec:** `docs/superpowers/specs/2026-11-24-entry-step-cron-design.md`

## Global Constraints

- Scope: BaseAPI, Messaging.Contracts, Orchestrator, Processor.Analyst, **Acto only**. Do not touch `src/WorkflowStudio`,
  `src/Valence`, `DesignWorkflowDto`, `GraphWorkflowDto`, or `Processor.Analyst/Bit/RehearsalGraph.cs` (user's uncommitted edits).
- Effective cron = the step's own cron, else the workflow's cron; neither means unscheduled.
- Groups compare crons after trimming and collapsing runs of whitespace to one space. No other normalisation.
- `EntryCrons` null on a create/update means "keep each surviving entry step's existing cron". A map means "exactly this".
- Cron text is never logged (user data).
- JSON property name: `entryCrons`. C# name: `EntryCrons`. TS name: `entryCrons`. Type: `Dictionary<Guid, string>?` /
  `Record<Id, string>`.
- Messaging.Contracts is consumed as a pinned NuGet 1.0.0: after changing it, run `dotnet pack src/Messaging.Contracts -c Release`,
  delete `~/.nuget/packages/messaging.contracts/1.0.0`, run `dotnet restore SK_P.sln --force-evaluate`, and commit the
  changed `packages.lock.json` files with the change.
- .NET tests run in the `skp-test` container (App Control blocks DLLs on the host). Use the MTP runner:
  `dotnet src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.dll --filter-class "<Namespace.Class>"`
  (`dotnet test --filter` is ignored).
- Acto unit tests: `cd src/Acto && npx vitest run <path>`.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Deploying to the cluster needs the
  user's go-ahead.

## Review Focus

1. **A client that doesn't know `entryCrons` removes B from the entry list.** B's cron must go with its row, and A's cron
   must survive. Pinned by Task 2 test `NullEntryCronsKeepsCronsOfSurvivingEntriesOnly`.
2. **Two crons that differ only in whitespace** (`"*/10 * * * * *"` vs `" */10  * * * * * "`) must be one group, not two
   jobs double-firing. Pinned by Task 1 test `WhitespaceOnlyDifferencesShareAGroup`.
3. **An entry cron equal to the workflow's cron** must give one job whose fire shares one correlation id across A and B,
   as today. Pinned by Task 5 test `AnEntryCronEqualToTheWorkflowCronMakesOneGroup`.
4. **An entry cron with no future occurrence** (`"0 0 30 2 *"`, Feb 30) must not stop the other groups from being
   scheduled. Pinned by Task 4 test `AGroupWithNoFutureFireDoesNotBlockItsSiblings`.
5. **A new step saved as an entry with a cron in the same Acto Save** must arrive under its real id, not the temporary
   one. Pinned by Task 8 test `saveRekeysEntryCronsToNewStepIds`.

---

### Task 1: Contracts — `entryCrons` and the shared grouping rule

**Files:**
- Modify: `src/Messaging.Contracts/WorkflowL1.cs` (record `WorkflowL1`)
- Modify: `src/Messaging.Contracts/Projections/WorkflowStoreProjection.cs`
- Create: `src/Messaging.Contracts/Projections/EntrySchedule.cs`
- Test: `src/tests/BaseApi.Tests/Projection/EntryScheduleTests.cs`
- Modify: every `packages.lock.json` the repack rewrites

**Interfaces:**
- Produces:
  - `WorkflowL1(..., Dictionary<Guid, string>? Names = null, Dictionary<Guid, string>? EntryCrons = null)` (new last parameter)
  - `WorkflowStoreProjection(EntryStepIds, Cron, Steps, [property: JsonPropertyName("entryCrons")] Dictionary<Guid, string>? EntryCrons = null)`
  - `public static class EntrySchedule` in namespace `Messaging.Contracts.Projections`:
    - `string Normalize(string cron)`: trims, collapses whitespace runs to one space
    - `string? EffectiveCron(Guid stepId, string? workflowCron, IReadOnlyDictionary<Guid, string>? entryCrons)`: normalized, or null
    - `IReadOnlyList<EntryGroup> Groups(IReadOnlyList<Guid> entryStepIds, string? workflowCron, IReadOnlyDictionary<Guid, string>? entryCrons)`:
      ordered by each cron's first appearance in `entryStepIds`. Steps with no effective cron are left out. Blank values are
      treated as absent.
  - `public sealed record EntryGroup(int Index, string Cron, IReadOnlyList<Guid> StepIds)`

- [ ] **Step 1: Write the failing tests** in `EntryScheduleTests` (namespace `BaseApi.Tests.Projection`):
  - `AStepWithoutItsOwnCronUsesTheWorkflowCron`: A has no entry, workflow `"*/30 * * * * *"`. Expect `EffectiveCron(A) == "*/30 * * * * *"`.
  - `AStepsOwnCronOverridesTheWorkflowCron`: B maps to `"*/10 * * * * *"`. Expect that.
  - `NoCronAnywhereMeansUnscheduled`: workflow null, no map. Expect `EffectiveCron == null` and `Groups` empty.
  - `WhitespaceOnlyDifferencesShareAGroup`: workflow `"*/10 * * * * *"`, B → `" */10  * * * * * "`. Expect one group with `[A, B]`.
  - `GroupsAreOrderedByFirstAppearanceWithStableIndexes`: entries `[A, B, C]`, workflow `*/30`, B → `*/10`, C null.
    Expect `[(0, "*/30 * * * * *", [A, C]), (1, "*/10 * * * * *", [B])]`.
  - `AnOldProjectionWithoutEntryCronsDeserializesAsNull`: deserialize `{"entryStepIds":[],"cron":null,"steps":[]}` with
    `MessagingJson.Options`, then assert `EntryCrons is null`.
- [ ] **Step 2: Run them and see them fail.** Run (in skp-test): `dotnet src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.dll --filter-class "BaseApi.Tests.Projection.EntryScheduleTests"`.
  Expected: build error, `EntrySchedule` not defined.
- [ ] **Step 3: Implement** the two record parameters and `EntrySchedule`/`EntryGroup` as in Interfaces.
- [ ] **Step 4: Repack Messaging.Contracts** as described in Global Constraints.
- [ ] **Step 5: Run the tests and see them pass.** Use the same command. Expected: 6 passed.
- [ ] **Step 6: Commit** `feat(contracts): entryCrons on the workflow projection and the entry-schedule grouping rule`, including the lock files.

### Task 2: BaseAPI — storage, DTOs, junction writer, validation, read

**Files:**
- Modify: `src/BaseApi.Service/Features/Workflow/WorkflowEntrySteps.cs` (add `public string? CronExpression { get; set; }`)
- Modify: `src/BaseApi.Service/Persistence/Configurations/WorkflowEntryStepsConfiguration.cs`. Same column type and length as
  `WorkflowEntity.CronExpression` in `WorkflowEntityConfiguration`.
- Create: `src/BaseApi.Service/Persistence/Migrations/20261124120000_AddEntryStepCron.cs` and `.Designer.cs`. Write them
  by hand, following `20261118120000_AddBoardLocations`, and update `AppDbContextModelSnapshot.cs`.
- Modify: `src/BaseApi.Service/Features/Workflow/WorkflowDtos.cs`. Add `Dictionary<Guid, string>? EntryCrons = null` as
  the last parameter of `WorkflowCreateDto`, `WorkflowUpdateDto` and `WorkflowReadDto`.
- Modify: `src/BaseApi.Service/Features/Workflow/WorkflowEntityMapper.cs`. Add `[MapperIgnoreSource(EntryCrons)]` on
  both write maps and an ignore-target on read, next to the existing `EntryStepIds` ignores. Read sets it to null.
- Modify: `src/BaseApi.Service/Features/Workflow/WorkflowJunctions.cs`
- Modify: `src/BaseApi.Service/Features/Workflow/WorkflowService.cs` (`SyncJunctionsAsync`, `EnrichReadAsync`)
- Modify: `src/BaseApi.Service/Features/Workflow/Graph/WorkflowGraphSaver.cs:171` and `Design/OwnedStages.cs:230`. Pass
  `entryCrons: null` (WorkflowStudio paths keep crons).
- Modify: `src/BaseApi.Service/Features/Workflow/WorkflowDtoValidator.cs`
- Test: `src/tests/BaseApi.Tests/WorkflowGraph/JunctionHelperTests.cs`, `src/tests/BaseApi.Tests/Orchestration/WorkflowReadEnrichmentTests.cs`,
  a new `src/tests/BaseApi.Tests/Validation/EntryCronValidationTests.cs`, and `src/tests/BaseApi.Tests/Molecule/ModelFieldsTests.cs`
  (update any expected field list).

**Interfaces:**
- Consumes: `CronFieldForm` (existing).
- Produces:
  - `WorkflowJunctions.SyncAsync(BaseDbContext db, Guid workflowId, IReadOnlyCollection<Guid> entryStepIds, IReadOnlyDictionary<Guid, string>? entryCrons, IReadOnlyCollection<Guid>? assignmentIds, IReadOnlyCollection<Guid>? cacheIds, bool replaceExisting, CancellationToken ct)`.
    When `entryCrons` is null, each new row takes the cron of the removed row with the same `StepId`, if any. When it is
    a map, each row takes `map.GetValueOrDefault(stepId)`.
  - `WorkflowReadDto.EntryCrons` is filled by `EnrichReadAsync` with rows whose cron is non-null. Never null after
    enrichment; empty when none.
  - The update/create body for `/model/apply` accepts `entryCrons` with no extra change, because `ModelChangeRunner`
    deserializes into the DTOs.

- [ ] **Step 1: Write the failing tests.**
  - `JunctionHelperTests.AGivenEntryCronsMapIsWrittenExactly`: entries `[A, B]`, map `{B: "*/10 * * * * *"}`. Expect A's
    row cron null and B's `"*/10 * * * * *"`.
  - `JunctionHelperTests.NullEntryCronsKeepsCronsOfSurvivingEntriesOnly`: stored A → `*/30`, B → `*/10`. Resync with
    entries `[A]`, `entryCrons: null`. Expect one row, A with `"*/30 * * * * *"`.
  - `JunctionHelperTests.AnEmptyMapClearsEveryCron`.
  - `WorkflowReadEnrichmentTests.EntryCronsAreReadBackAndEmptyWhenNone`.
  - `EntryCronValidationTests.AnUnparseableEntryCronIsRefused`: `{B: "every ten seconds"}`. Expect a failure on `EntryCrons`.
  - `EntryCronValidationTests.AnEntryCronOnAStepThatIsNotAnEntryIsRefused`: the message names the step id.
  - `EntryCronValidationTests.SixFieldAndFiveFieldEntryCronsAreAccepted`.
- [ ] **Step 2: Run them and see them fail.** Run the three `--filter-class` commands. Expected: build errors (`SyncAsync` arity, `EntryCrons` missing).
- [ ] **Step 3: Implement** the column, migration, DTOs, mapper ignores and junction rule. In `SyncJunctionsAsync`, pass
  `createDto?.EntryCrons ?? updateDto?.EntryCrons`. Validator: reuse `BeValidStandardCron` for each value, and require
  each key to be in `EntryStepIds`. Message: `"EntryCrons names step {id}, which is not an entry step."`
- [ ] **Step 4: Run them and see them pass.** Run the same three classes plus `BaseApi.Tests.Molecule.ModelFieldsTests`
  and `BaseApi.Tests.Validation.NullCollectionCascadeTests`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(baseapi): an entry step may carry its own cron`.

### Task 3: BaseAPI — the cron reaches L2

**Files:**
- Modify: `src/BaseApi.Service/Features/Orchestration/Loading/WorkflowGraphLoader.cs:67-127`. Fill `EntryCrons` on the
  snapshot's `WorkflowReadDto` from `entryRows`, as `EnrichReadAsync` does.
- Modify: `src/BaseApi.Service/Features/Orchestration/OrchestrationService.cs:236` (`EntryCrons: workflow.EntryCrons`)
- Modify: `src/BaseApi.Service/Features/Orchestration/Projection/L2ProjectionWriter.cs:72` (pass `workflow.EntryCrons`)
- Test: `src/tests/BaseApi.Tests/Orchestration/StartDrivenProjectionTests.cs`, `src/tests/BaseApi.Tests/Projection/L2KeyLayoutTests.cs`

**Interfaces:**
- Consumes: Task 1 `WorkflowL1.EntryCrons`, `WorkflowStoreProjection.EntryCrons`; Task 2 `WorkflowReadDto.EntryCrons`.
- Produces: the L2 store field JSON carries `"entryCrons":{"<stepId>":"*/10 * * * * *"}`, or null when no step has its own cron.

- [ ] **Step 1: Write the failing tests.**
  - `StartDrivenProjectionTests.AStartProjectsEntryCrons`: seed a workflow with B → `*/10`, start it, read the store
    field. Expect `entryCrons[B] == "*/10 * * * * *"`.
  - `StartDrivenProjectionTests.AWorkflowWithoutEntryCronsProjectsNoMap`: expect `entryCrons` null.
- [ ] **Step 2: Run them and see them fail.** Run `--filter-class "BaseApi.Tests.Orchestration.StartDrivenProjectionTests"`.
- [ ] **Step 3: Implement.** Make the loader emit null, not empty, when no row has a cron, so old and new projections
  read alike.
- [ ] **Step 4: Run them and see them pass.** Run `StartDrivenProjectionTests` and `BaseApi.Tests.Projection.L2KeyLayoutTests`. Expected: pass.
- [ ] **Step 5: Commit** `feat(baseapi): entry crons are projected to L2 on start`.

### Task 4: Orchestrator — Quartz jobs grouped by workflow

**Files:**
- Modify: `src/Orchestrator/Scheduling/IWorkflowScheduler.cs`
- Modify: `src/Orchestrator/Scheduling/WorkflowScheduler.cs`
- Modify: `src/tests/BaseApi.Tests/Orchestrator/RecordingWorkflowScheduler.cs`
- Test: `src/tests/BaseApi.Tests/Orchestrator/WorkflowSchedulerTests.cs`, `src/tests/BaseApi.Tests/Orchestrator/SelfReschedulingChainTests.cs`

**Interfaces:**
- Produces (replaces the current three methods):
  - `const string WorkflowIdKey = "workflowId"`, `JobIdKey = "jobId"` (unchanged), new `IndexKey = "index"`, new `CronKey = "cron"`
  - `Task ScheduleAsync(Guid workflowId, Guid activationId, int index, string cron, CancellationToken ct)`
  - `Task RescheduleAsync(Guid workflowId, Guid activationId, int index, string cron, CancellationToken ct)`
  - `Task UnscheduleWorkflowAsync(Guid workflowId, CancellationToken ct)`: `GetJobKeys(GroupMatcher<JobKey>.GroupEquals(workflowId.ToString("D")))`, then `DeleteJobs`
  - `UnscheduleAsync(Guid jobId, ...)` is removed.
  - Keys: `JobKey(name: $"{activationId:D}/{index}", group: workflowId.ToString("D"))`, with the trigger key the same.
    The job-data map carries all four keys. `index` and `cron` are stored as strings.
  - `RecordingWorkflowScheduler`: `Scheduled`/`Rescheduled` become `List<(Guid WorkflowId, Guid ActivationId, int Index, string Cron)>`,
    and `Unscheduled` becomes `List<Guid>` of workflow ids. `OnUnscheduleAsync` is kept and fired from
    `UnscheduleWorkflowAsync`.

- [ ] **Step 1: Write the failing tests** in `WorkflowSchedulerTests` (real job store):
  - `JobsOfOneWorkflowShareItsQuartzGroup`: schedule indexes 0 and 1. Expect both keys in group `workflowId`, named
    `"{activationId}/0"` and `"/1"`.
  - `UnscheduleWorkflowRemovesEveryJobOfThatWorkflowOnly`: two workflows with two jobs each. Unschedule one. Expect 0 left
    for it and 2 for the other.
  - `TheJobDataMapCarriesIndexAndCron`.
  - `AGroupWithNoFutureFireDoesNotBlockItsSiblings`: index 0 `"0 0 30 2 *"`, index 1 `"*/10 * * * * *"`. Expect only
    index 1 in the store.
  - Update `SelfReschedulingChainTests` to two groups. Expect each to fire twice, a second apart, with no `ObjectAlreadyExistsException`.
- [ ] **Step 2: Run them and see them fail.** Run `--filter-class "BaseApi.Tests.Orchestrator.WorkflowSchedulerTests"`.
- [ ] **Step 3: Implement** the interface and `WorkflowScheduler<TJob>`, and update `RecordingWorkflowScheduler`. Callers
  break until Tasks 5–6. Make them compile with the minimal call-shape change only:
  - activator and fire pass `index: 0, cron: definition.Cron`
  - stop calls `UnscheduleWorkflowAsync`
- [ ] **Step 4: Run them and see them pass.** Run `WorkflowSchedulerTests` and `SelfReschedulingChainTests`. Expected: pass.
- [ ] **Step 5: Commit** `feat(orchestrator): one Quartz job group per workflow; unschedule by workflow`.

### Task 5: Orchestrator — activation, stop and L2 read schedule groups

**Files:**
- Modify: `src/Orchestrator/L1/L2WorkflowReader.cs:96` (pass `store.EntryCrons`)
- Modify: `src/Orchestrator/L1/WorkflowActivator.cs`
- Modify: `src/Orchestrator/Messaging/ApplyStopHandler.cs:112`
- Test: `src/tests/BaseApi.Tests/Orchestrator/WorkflowActivatorTests.cs`, `ApplyHandlerTests.cs`, `L2WorkflowReaderTests.cs`,
  `HydrationServiceTests.cs`, `src/tests/BaseApi.Tests/Orchestration/StartStopIdempotencyTests.cs`

**Interfaces:**
- Consumes: Task 1 `EntrySchedule.Groups`; Task 4 scheduler methods.
- Produces: `WorkflowActivator.ActivateAsync` calls `UnscheduleWorkflowAsync(workflowId)`, then `store.Set(workflowId, definition, activationId)`,
  then `ScheduleAsync(workflowId, activationId, g.Index, g.Cron)` for each group. The information log gains a
  `{GroupCount}` template parameter. `HydrationService` goes through the activator (`HydrationService.cs:215`) and
  needs no change.

- [ ] **Step 1: Write the failing tests.**
  - `WorkflowActivatorTests.TwoCronsScheduleTwoGroupsUnderOneActivation`: workflow `*/30`, B → `*/10`. Expect
    `Scheduled == [(wf, act, 0, "*/30 * * * * *"), (wf, act, 1, "*/10 * * * * *")]` and `store` JobId `== act`.
  - `WorkflowActivatorTests.AnEntryCronEqualToTheWorkflowCronMakesOneGroup`
  - `WorkflowActivatorTests.ANullWorkflowCronSchedulesOnlyStepsWithTheirOwn`
  - `WorkflowActivatorTests.ARestartUnschedulesTheWholeWorkflowBeforeScheduling`: `Calls` order starts with
    `UnscheduleWorkflowAsync`, then the `ScheduleAsync` calls.
  - `ApplyHandlerTests.AStopUnschedulesTheWholeWorkflowThenMarks`
  - `L2WorkflowReaderTests.EntryCronsAreReadFromTheStore`, and that an old store without the field reads null.
- [ ] **Step 2: Run them and see them fail.** Run `--filter-class` for `WorkflowActivatorTests`, `ApplyHandlerTests`, `L2WorkflowReaderTests`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and see them pass.** Run those plus `HydrationServiceTests` and `StartStopIdempotencyTests`. Expected: pass.
- [ ] **Step 5: Commit** `feat(orchestrator): a workflow is scheduled as one job per entry cron`.

### Task 6: Orchestrator — a fire dispatches its own group

**Files:**
- Modify: `src/Orchestrator/Scheduling/WorkflowFireJob.cs`
- Test: `src/tests/BaseApi.Tests/Orchestrator/WorkflowFireJobTests.cs`

**Interfaces:**
- Consumes: Task 1 `EntrySchedule.EffectiveCron`/`Normalize`; Task 4 `IndexKey`, `CronKey`, `RescheduleAsync`.
- Produces: no new public surface.
  - `Execute` reads `index` (int) and `cron` (non-blank) as well. Either missing makes the fire log the existing "no
    usable ids" warning and return.
  - `DispatchEntryStepsAsync` sends only the steps where `EffectiveCron(stepId, definition.Cron, definition.EntryCrons) == Normalize(cron)`.
  - Re-arm calls `RescheduleAsync(workflowId, jobId, index, cron)`. The `current.Definition.Cron is not { } cron` branch
    (line 192) is removed.

- [ ] **Step 1: Write the failing tests** (extend the fixture to build job maps with `index` and `cron`):
  - `AFireDispatchesOnlyTheEntryStepsOfItsOwnCron`: A `*/30` and B `*/10`. Fire the `*/10` job. Expect one dispatch, to B.
  - `EachGroupsFireMintsItsOwnCorrelationId`: fire both jobs. Expect two different correlation ids.
  - `AStaleActivationStandsDownInEveryGroup`: L1 holds a new activation id. Fire index 1 of the old one. Expect no reschedule.
  - `AMapWithoutCronIsSkippedRatherThanThrown`
  - `TheRescheduleCarriesTheJobsOwnIndexAndCron`: replaces `TheRescheduleCarriesTheWorkflowsOwnIdsAndCron`.
  - Keep `AnEntryStepFrozenWithNeverIsNotDispatchedWhileItsSiblingsStillAre` green, with both steps in one group.
- [ ] **Step 2: Run them and see them fail.** Run `--filter-class "BaseApi.Tests.Orchestrator.WorkflowFireJobTests"`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and see them pass.** Run the same class plus the whole `BaseApi.Tests.Orchestrator` namespace
  (`--filter-namespace`). Expected: all pass.
- [ ] **Step 5: Commit** `feat(orchestrator): a fire dispatches only the entry steps of its own cron`.

### Task 7: Processor.Analyst — show each entry's schedule

**Files:**
- Modify: `src/Processor.Analyst/Graph/RunningGraph.cs` (add `IReadOnlyDictionary<Guid, string>? EntryCrons` after `EntryStepIds`)
- Modify: `src/Processor.Analyst/Graph/L2WorkflowGraphSource.cs:58`
- Modify: `src/Processor.Analyst/Graph/GraphRenderer.cs:57-59`
- Test: `src/tests/BaseApi.Tests/Analyst/RunningGraphTests.cs`

**Interfaces:**
- Consumes: Task 1 `WorkflowStoreProjection.EntryCrons`.
- Produces: after the existing `Schedule:` line, one line per entry step with its own cron:
  `"Entry {Ref(step)} runs on its own cron \"{cron}\"."`

- [ ] **Step 1: Write the failing test.** `RunningGraphTests.AnEntryWithItsOwnCronIsRenderedOnItsOwnLine`, plus a check
  that a graph without the field renders exactly as before.
- [ ] **Step 2: Run it and see it fail.** Run `--filter-class "BaseApi.Tests.Analyst.RunningGraphTests"`.
- [ ] **Step 3: Implement.** Leave `Bit/RehearsalGraph.cs` alone. If it no longer compiles because of the new positional
  parameter, give the parameter a default of `null` rather than editing that file.
- [ ] **Step 4: Run it and see it pass.** Same command.
- [ ] **Step 5: Commit** `feat(analyst): the graph names entry steps that run on their own cron`.

### Task 8: Acto — model, save and ghosts carry `entryCrons`

**Files:**
- Modify: `src/Acto/src/api/schema.d.ts` (regenerate from BaseAPI's OpenAPI with the existing script, or add `entryCrons?: { [key: string]: string } | null` to the three workflow DTO types)
- Modify: `src/Acto/src/design/board.ts` (`WorkflowRow.entryCrons: Record<Id, string>`)
- Modify: `src/Acto/src/api/toModel.ts:96-99`, `src/Acto/src/api/fixtures.ts`, `src/Acto/src/design/boardFixtures.ts`, `src/Acto/src/App.tsx:67`
- Modify: `src/Acto/src/design/changes.ts:38-41` (`workflowBody` sends `entryCrons: { ...w.entryCrons }`)
- Modify: `src/Acto/src/design/saveBoard.ts:76` (re-key `entryCrons` keys with `m`)
- Modify: `src/Acto/src/design/edits.ts`: `removeEntries` drops the pair's key. New `setEntryCron`.
- Modify: `src/Acto/src/design/ghosts.ts`: the entry ghost gains `cron?: string`, collected at line 61. Re-keyed at line 83.
  Restore at line 298 puts it back. A workflow ghost's row re-keys (line 79) and filters (line 262) `entryCrons` like `entryStepIds`.
- Test: `src/Acto/src/design/edits.test.ts`, `src/Acto/src/design/ghosts.test.ts`, `src/Acto/src/design/saveBoard.test.ts`, `src/Acto/src/api/toModel.test.ts`

**Interfaces:**
- Produces:
  - `setEntryCron(b: BoardState, wf: Id, step: Id, cron: string | null): BoardState`. Null or blank deletes the key. Not
    being an entry step is a no-op.
  - `WorkflowRow.entryCrons: Record<Id, string>`, which is always an object (`{}` when none).

- [ ] **Step 1: Write the failing tests.**
  - `toModel.test.ts` `readsEntryCronsAndDefaultsToEmpty`
  - `edits.test.ts` `setEntryCronSetsAndClears`, and `removeEntriesDropsTheCron`
  - `ghosts.test.ts` `restoringAnEntryArrowBringsItsCronBack`
  - `saveBoard.test.ts` `saveRekeysEntryCronsToNewStepIds`: a new step `tmp-1` is made an entry with `*/10`. The apply
    answers id `real-1`. Expect the board after save to have `entryCrons == { 'real-1': '*/10 * * * * *' }`.
  - `changes` diff: changing only a cron marks the workflow updated, and its body carries `entryCrons`.
- [ ] **Step 2: Run them and see them fail.** Run `cd src/Acto && npx vitest run src/design src/api`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and see them pass.** Run `cd src/Acto && npx vitest run` (the whole suite) and `npx tsc --noEmit`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(acto): workflows carry entry crons through edit, ghost and save`.

### Task 9: Acto — edit and see the cron on the entry arrow

**Files:**
- Modify: `src/Acto/src/inspector/tabs/LinkTab.tsx`. For `pick.kind === 'entry'`, add a `CronField` (from
  `inspector/fields`) under `Runs when`. The placeholder is the workflow's cron, or `not scheduled`. Below it goes the
  `cronText` reading. Edits go through `edit((b) => setEntryCron(...), \`entryCron:${wf}:${step}\`)` the same way
  `WorkflowTab` edits fields. `LinkTab` needs the `edit` prop that `WorkflowTab` already receives.
- Modify: `src/Acto/src/board/toFlow.ts:145-152`. An entry edge with its own cron gets `data.cron` and a ⏱ label.
- Modify: the entry-edge component that renders `type: 'entry'` (find it from `board/toFlow.ts` edge types; not `canvas/nodes/Chip.tsx`).
- Modify: `src/Acto/src/inspector/tabs/WorkflowTab.tsx:45-50`. Each entry row shows `⏱ <cron>` when it has its own cron.
- Test: `src/Acto/src/inspector/tabs/LinkTab.test.tsx` (new), `src/Acto/src/board/toFlow.test.ts`, and an e2e
  `src/Acto/e2e/entry-cron.spec.ts`

**Interfaces:**
- Consumes: Task 8 `setEntryCron`, `WorkflowRow.entryCrons`.

- [ ] **Step 1: Write the failing tests.**
  - `LinkTab.test.tsx` `anEntryArrowEditsItsCron`: type `*/10 * * * * *`. Expect the board state cron set and one undo entry.
  - `LinkTab.test.tsx` `aWireHasNoCronField`
  - `toFlow.test.ts` `anEntryEdgeWithItsOwnCronCarriesIt`
  - The e2e selects B's entry arrow, picks the `every 10 seconds` preset (or types it), clicks Save, reloads, reselects
    the arrow and expects the field to read `*/10 * * * * *`. It writes only a throwaway workflow and never Start/Stop,
    per the suite rule.
- [ ] **Step 2: Run them and see them fail.** Run `cd src/Acto && npx vitest run src/inspector src/board`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and see them pass.** Run vitest (whole suite), then `npx playwright test e2e/entry-cron.spec.ts`
  against the port-forwarded Acto (18083). That needs the Task 8–9 build deployed, so it runs after the deploy in Task 11.
- [ ] **Step 5: Commit** `feat(acto): an entry arrow's own cron, set in the Link tab and shown on the board`.

### Task 10: Acto — chat can read and set entry crons

**Files:**
- Modify: `src/Acto/src/chat/prompt.ts`. Add one sentence: an entry arrow may carry its own cron, which overrides the
  workflow's, and `set_entry_cron` sets or clears it.
- Modify: `src/Acto/src/chat/tools/read.ts:90-110`. `read_board` lists each entry step with its `cron` (own or null).
- Modify: `src/Acto/src/chat/tools/design.ts`. New tool `set_entry_cron` with params `{ workflow_id, step_id, value: string | null }`.
  It refuses with `"<step> is not an entry step of <workflow>"` when that's the case, and otherwise applies
  `setEntryCron` as one undoable edit.
- Test: `src/Acto/src/chat/tools/boardTools.test.ts`, `src/Acto/src/chat/tools/tools.test.ts` (the tool-list snapshot)

**Interfaces:**
- Consumes: Task 8 `setEntryCron`.

- [ ] **Step 1: Write the failing tests.** `setEntryCronSetsAndClears`, `setEntryCronRefusesANonEntryStep`, and
  `readBoardShowsEntryCrons`.
- [ ] **Step 2: Run them and see them fail.** Run `cd src/Acto && npx vitest run src/chat`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and see them pass.** Same command, then the whole suite.
- [ ] **Step 5: Commit** `feat(acto): chat reads and sets entry crons`.

### Task 11: Deploy and the live run (needs the user's go-ahead)

**Files:**
- Create: `src/tests/BaseApi.Tests/Live/EntryCronLiveTests.cs`

- [ ] **Step 1: Ask the user to approve the deploy.** The order is orchestrator, then BaseAPI (the migration runs on
  start), then Acto. Images go in with `docker save … | docker exec -i desktop-control-plane ctr -n k8s.io images import -`,
  then a rollout restart. After Acto, restart the 18083 port-forward.
- [ ] **Step 2: Write the live test** `EntryCronLiveTests.TwoEntryCronsFireAtTheirOwnRates`. Create a throwaway workflow:
  A and B on a fast processor, workflow `*/30 * * * * *`, B → `*/10 * * * * *`. Start it, wait 60 s, then count
  `"dispatched an entry step"` logs per step. Expect A 2±1 and B 6±1, every fire with a distinct correlation id. Then stop,
  wait 15 s, and expect no new dispatch. Delete the workflow.
- [ ] **Step 3: Run it.** Run `--filter-class "BaseApi.Tests.Live.EntryCronLiveTests"` with the live env flags the other
  `Live` tests use. Expected: pass.
- [ ] **Step 4: Run the Acto e2e** from Task 9 (`npx playwright test e2e/entry-cron.spec.ts`). Expected: pass.
- [ ] **Step 5: Commit** `test(live): two entry crons fire at their own rates and stop together`.
