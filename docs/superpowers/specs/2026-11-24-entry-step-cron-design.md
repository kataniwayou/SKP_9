# Entry-step cron: one workflow, entry steps on their own schedules

Date: 2026-11-24. Status: design agreed in brainstorming, not implemented.

## Goal

A workflow with a 30-second cron fires entry step A. The same workflow must also fire entry step B every 10 seconds.
Today that is impossible: a workflow has one cron (`WorkflowEntity.CronExpression`), the orchestrator holds one Quartz
job per workflow (`L1Entry.JobId`), and each fire dispatches every entry step (`WorkflowFireJob.DispatchEntryStepsAsync`).

## Rules (user, 2026-11-24)

1. **An entry step may carry its own cron.** None means it uses the workflow's cron.
2. **The cron is stored on the entry-step junction**, as a nullable `CronExpression` column on `WorkflowEntrySteps`.
3. **One Quartz job per distinct cron.** The job's group is the workflow id. A fire dispatches only the entry steps of
   its own cron.
4. **Each fire mints its own correlation id.** A's runs and B's runs are unrelated, even where their branches meet.
5. **The liveness gate stays workflow-wide.** A processor with no live replica anywhere in the workflow stops every
   group's fire.
6. **Stop and start act on the whole workflow.** Stop removes every job of the workflow. To take one group out, freeze its
   steps (entry condition `Never`) and start again.

## Terms

- **Effective cron** of an entry step: its own cron if it has one, otherwise the workflow's cron. If neither exists, the step is
  unscheduled.
- **Group**: the entry steps that share one effective cron, compared after trimming and collapsing whitespace. Two
  expressions with the same meaning but different text (`*/10` and `0/10`) are two groups. Both fire, which is harmless.
- **Activation id**: the id the activator mints on each start. It is today's `L1Entry.JobId`, with a new meaning.

## Contracts (Messaging.Contracts)

- `WorkflowStoreProjection` gains `[JsonPropertyName("entryCrons")] Dictionary<Guid, string>? EntryCrons`.
- `WorkflowL1` gains `Dictionary<Guid, string>? EntryCrons = null`, after `Names`.
- Keys are entry step ids. Only steps with their own cron are listed. Null or missing means every entry step uses the
  workflow cron, so a projection written before this change reads exactly as it does today.
- `StepL1` is unchanged.

## BaseAPI

### Storage
- `WorkflowEntrySteps` gains `string? CronExpression`. The change needs a migration and an update to
  `WorkflowEntryStepsConfiguration`. The cron is deleted along with the junction row, so the deleter needs no change.

### DTOs
- `WorkflowCreateDto`, `WorkflowUpdateDto` and `WorkflowReadDto` gain `Dictionary<Guid, string>? EntryCrons`, placed after
  `CronExpression` and defaulting to null.
- `DesignWorkflowDto` (WorkflowStudio's design path) is **not** changed. WorkflowStudio is out of scope; the
  keep-on-null rule below means its saves leave the crons alone.
- Read: `WorkflowService.EnrichReadAsync` fills `EntryCrons` from the junction rows. The map holds only the steps that
  have their own cron; it is an empty map, not null, when none do.

### Writing the junction (`WorkflowJunctions.cs`)
The writer removes the old rows and inserts new ones. Their crons follow these rules:
- `EntryCrons` given: each new row takes its cron from the map, and a step missing from the map gets null.
- `EntryCrons` null: each new row keeps the cron its step had before, if the step was already an entry. Without this, a
  client that doesn't know the field (WorkflowStudio, Valence, an older Acto) would wipe the crons on its next save.
- `WorkflowGraphSaver` passes the map through. The `/model/apply` runner that Acto saves through uses
  `WorkflowCreateDto`/`WorkflowUpdateDto`, so it carries `EntryCrons` without further change.

### Validation (`WorkflowDtoValidator`, design apply)
- Every value parses as a cron, using the same 5- or 6-field rule as `CronExpression` (`CronFieldForm`).
- Every key is one of the workflow's entry steps. A cron on a step that is not an entry step is refused, with a message
  naming the step.

### Projection (`L2ProjectionWriter.cs:72`, `WorkflowGraphLoader`, `OrchestrationService`)
- The loader reads the crons together with the entry rows. The writer puts `EntryCrons` into the store projection and
  into `WorkflowL1`.

## Orchestrator

### Job key
- `JobKey(name: "{activationId}/{index}", group: workflowId)`, with the trigger key the same.
- The job-data map carries `workflowId`, `jobId` (the activation id; the key name is unchanged) and a new `cron`, the
  group's effective cron.
- Nothing remains in Quartz's `DEFAULT` group. Quartz runs on the in-memory store (`AddQuartz()`), so there is
  nothing to migrate.

### `IWorkflowScheduler`
- `ScheduleAsync(workflowId, activationId, index, cron, ct)` and `RescheduleAsync(...)` take the index so they can build
  the key. A cron with no next fire time still schedules nothing and logs a warning, as today.
- New: `UnscheduleWorkflowAsync(workflowId, ct)` calls `GetJobKeys(GroupMatcher<JobKey>.GroupEquals(workflowId))`, then
  `DeleteJobs(keys)`.
- `UnscheduleAsync(jobId)` is removed; nothing calls it any more.

### `WorkflowActivator`
1. Checks the live set and reads L2, as today.
2. Calls `UnscheduleWorkflowAsync(workflowId)` instead of tearing down `held.JobId`.
3. Mints the activation id and calls `store.Set(workflowId, definition, activationId)`. `L1Entry` is unchanged.
4. Groups the entry steps by effective cron and calls `ScheduleAsync` once per group. Steps with no effective cron are not
   scheduled.
5. The log line gains `{GroupCount}`. Cron text is never logged, because it is user data.

### `WorkflowFireJob`
- Reads `cron` from the job-data map. A map without `cron` is treated like a map with unusable ids: log a warning and
  return.
- The gates are unchanged and run in the same order: active in L1, L2 gate, leader, workflow-wide liveness.
- Dispatch sends only the entry steps whose effective cron, recomputed from `entry.Definition`, equals the job's cron.
  It keeps the freeze (`Never`) check and uses one new correlation id per fire.
- Supersession is unchanged: `current.JobId != jobId` compares activation ids, so a new start retires every old job of
  every group.
- Re-arm uses the job's own `cron` instead of `Definition.Cron`.

### `ApplyStopHandler`
- Calls `UnscheduleWorkflowAsync(workflowId)` instead of `UnscheduleAsync(entry.JobId)`. The order stays: unschedule,
  then `MarkDeleted`.

### Known race (exists today, heals itself)
A fire that passes its L1 check just before a stop deletes the group re-creates its own job through
`RescheduleAsync`'s fallback. That job fires once, finds the workflow marked, dispatches nothing and does not re-arm.

### `L2WorkflowReader`
- Passes `store.EntryCrons` into `WorkflowL1`.

## Processor.Analyst

- `RunningGraph` gains `EntryCrons`, and `L2WorkflowGraphSource` fills it.
- `GraphRenderer` prints the workflow schedule, then one line for each entry step that has its own cron.
- `Bit/RehearsalGraph.cs` is out of scope because the user has uncommitted edits there.

## Acto (src/Acto) — the only UI in scope

WorkflowStudio and Valence are out of scope (user, 2026-11-24). They keep working: they never send `EntryCrons`, so the
keep-on-null rule leaves the crons as Acto set them.

On the board a workflow is a triangle with one **entry arrow** to each entry step. The cron belongs to that arrow: the
arrow is the (workflow, step) pair, which is exactly what the junction row is.

- **API and model:** `api/schema.d.ts` (regenerated), `api/toModel.ts`, `design/board.ts` (the workflow row gains
  `entryCrons: Record<Id, string>`), `api/fixtures.ts`, `design/boardFixtures.ts`.
- **Save:** `design/changes.ts` puts `entryCrons` on the workflow's update when the map changed. `design/saveBoard.ts`
  re-keys the map with the new step ids after the apply, as it already does for `entryStepIds` (line 76).
- **Inspector:** `inspector/tabs/LinkTab.tsx` gains a **Cron** field for an entry arrow (not for a wire or a cache line).
  Empty means the workflow's cron, and the placeholder shows that cron. It uses the same cron presets dropdown as
  `WorkflowTab`. The edit goes into the workflow's undo history like any field edit.
- **Board:** `board/toFlow.ts` adds a ⏱ label on an entry arrow that has its own cron.
- **Entry list changes:** removing an entry arrow (a ghost) drops its cron from the map. Restoring the ghost brings the
  cron back with it (`design/ghosts.ts`), in line with the restore-with-wires rule. Copying a workflow alone carries no
  entry arrows, so no crons (`operate/clipboard.ts` is unchanged).
- **Chat:** `chat/prompt.ts` says once that an entry arrow may carry its own cron, which overrides the workflow's.
  `read_board` (`chat/tools/read.ts`) lists each entry step with its cron. A new tool `set_entry_cron(workflow_id,
  step_id, value)` sets or clears it (`value` null). `chat/tools/fields.ts` is unchanged.
- **Workflow tab:** `inspector/tabs/WorkflowTab.tsx` keeps showing the workflow's cron and lists the entry steps that
  override it.

## Behaviour

| Case | Result |
|---|---|
| Workflow `*/30 * * * * *`, A with no cron, B `*/10 * * * * *` | Two jobs. A fires at :00 and :30, B every 10 s, each fire with its own correlation id |
| B's cron equals the workflow's | One job, and A and B share each fire's correlation id, as today |
| Workflow cron null, B has a cron | One job for B. A is unscheduled |
| Every step of a group frozen | The job still fires and logs a skip for each step, as a fully frozen workflow does today |
| A processor anywhere in the workflow has no live replica | Every group skips its fire and re-arms |
| Stop | Every job in the workflow's group is deleted. In-flight steps finish against the marked entry |
| Edit B's cron while running | Takes effect on the next start (L1 is a projection snapshot) |

## Rollout

Deploy the orchestrator first, then BaseAPI, then Acto. WorkflowStudio and Valence are not redeployed.
- **New orchestrator, old projection:** reads `entryCrons` as null and behaves exactly as today.
- **Old orchestrator, new projection:** ignores `entryCrons` and fires B at the workflow cron, with no error. That is why
  the orchestrator goes first.

## Tests

- **Scheduler:** `WorkflowSchedulerTests` (real job store) checks that group keys are used and that
  `UnscheduleWorkflowAsync` removes every job of one workflow and none of another's. `SelfReschedulingChainTests` runs
  with two groups.
- **Fire job:** `WorkflowFireJobTests` checks that a fire sends only its own group's steps, that a fire with a stale
  activation id stands down in every group, that a map without `cron` skips, and that re-arm uses the job's cron.
- **Activator and stop:** `WorkflowActivatorTests`, `ApplyHandlerTests`, `StartStopIdempotencyTests` and
  `HydrationServiceTests` cover N groups scheduled, a restart replacing them all, and stop clearing them all.
- **Projection:** `L2WorkflowReaderTests`, `L2KeyLayoutTests` and `StartDrivenProjectionTests` cover the new field and
  confirm an old projection without it reads as today.
- **BaseAPI:** validator tests (bad cron, a key that is not an entry step), junction tests (crons kept when `EntryCrons`
  is null, replaced when given), the read enrichment, and a `/model/apply` round trip carrying `EntryCrons`.
- **Acto:** vitest for `toModel`, the save diff and re-keying, ghost restore bringing the cron back, and the chat tool.
  An e2e in `src/Acto/e2e` selects B's entry arrow, sets its cron in the Link tab, saves, reloads and finds it.
- **Live:** a workflow with A at `*/30` and B at `*/10`, started for 60 s. It expects about 2 dispatches of A and about 6
  of B, each with its own correlation id, and stop ends both.

## Out of scope

- A liveness gate per group.
- Stopping one group (use the freeze).
- Not scheduling a group whose steps are all frozen.
- `Bit/RehearsalGraph.cs`.
- WorkflowStudio (`src/WorkflowStudio`) and Valence (`src/Valence`): no change. BaseAPI's `DesignWorkflowDto` is
  unchanged too.
