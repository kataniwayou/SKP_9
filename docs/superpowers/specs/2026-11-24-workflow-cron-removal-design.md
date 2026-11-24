# Workflow cron removal: a workflow is scheduled only by its entry steps

Date: 2026-11-24. Status: agreed with the user, to be implemented. Follows
`2026-11-24-entry-step-cron-design.md` (built and deployed on feature/acto): this removes its fallback.

## Rules (user, 2026-11-24)

1. **The workflow has no cron.** `CronExpression` is removed from the workflow entity, its column, the DTOs and every
   contract. A workflow's schedule is the set of its entry steps' crons.
2. **Entry-step crons keep the full validation**: each must parse as a 5- or 6-field cron, be at most 120 characters,
   and name an existing entry step of that workflow.
3. **An entry step without a cron is allowed.** It is not scheduled. A workflow with no entry cron at all can still be
   saved and started; it never fires (today's behaviour for a workflow with a null cron).
4. **Complete removal, then redeploy.** No compatibility field is left in L2 or the contracts.
5. **WorkflowStudio and Valence stay out of scope.** They are not changed or redeployed. Their workflow-cron editing
   stops working: BaseAPI no longer has the field.
6. **Acto supports several crons per workflow.** Crons are edited per entry arrow and listed together on the workflow.
7. **Verification**: thorough Acto UI and regression tests, run headed with Playwright, plus live checks in the
   Elasticsearch logs.

## Effective cron

An entry step's effective cron is its own cron, normalised (trim, whitespace runs collapsed). There is no fallback.
Groups are formed exactly as before, from entry crons only.

## Data migration (`RemoveWorkflowCron`)

- **Up:** for every workflow whose `cron_expression` is not null, copy it onto each of its `workflow_entry_steps` rows
  whose `cron_expression` is null. Then drop `workflows.cron_expression`. Every existing workflow keeps firing as before.
- **Down:** re-add `workflows.cron_expression` as nullable `varchar(120)`, empty. The copied crons stay on the entry rows.

## Contracts (Messaging.Contracts, repacked)

- `WorkflowL1` loses `Cron`. `WorkflowStoreProjection` loses `cron`. An old stored projection's `cron` is ignored.
- `EntrySchedule.EffectiveCron(Guid stepId, IReadOnlyDictionary<Guid,string>? entryCrons)` and
  `EntrySchedule.Groups(IReadOnlyList<Guid> entryStepIds, IReadOnlyDictionary<Guid,string>? entryCrons)` lose their
  workflow-cron parameter.

## BaseAPI

- **Entity:** remove `WorkflowEntity.CronExpression` and its configuration.
- **DTOs:**
  - Remove `CronExpression` from `WorkflowCreateDto`, `WorkflowUpdateDto` and `WorkflowReadDto`.
  - Remove it from the WorkflowStudio-path DTOs too (`GraphWorkflowDto`, design fields and stages, `WorkflowDesignSyncer`).
  - The design path's `cronExpression` field becomes an unknown field, refused the way any unknown design field is.
- **Validator:** remove the workflow-cron rule. The entry-cron rules are unchanged.
- **Orchestration:** `OrchestrationService` and `L2ProjectionWriter` no longer send a workflow cron. The start gates
  are unchanged; a workflow with no cron at all still starts.
- **Keep-on-null:** unchanged. A save without `entryCrons` keeps the stored crons.

## Orchestrator

- `L2WorkflowReader` builds `WorkflowL1` without a cron. The activator and fire job use the new `EntrySchedule`
  signatures; their behaviour is otherwise unchanged.
- **Incompatibility:** a projection written before this change (`cron` set, `entryCrons` null) schedules nothing under
  the new orchestrator. That is why the deploy re-projects running workflows first.

## Processor.Analyst

- `L2WorkflowGraphSource` passes no workflow cron. `RunningGraph` keeps its `Cron` parameter (always null from L2)
  because `Bit/RehearsalGraph.cs` holds the user's uncommitted edits and builds a `RunningGraph` with one.
- `GraphRenderer` replaces the `Schedule: cron …` line with one schedule line per entry step: its cron, or "no schedule".

## Acto

- **Model and save:** remove `cronExpression` from `WorkflowRow`, `toModel`, the save body, the fixtures, the
  new-workflow probe, `diagramSvg`, `GhostTab`, the clipboard and `model/graph.ts`. Regenerate or hand-edit
  `schema.d.ts` and `openapi/baseapi.v1.json` to match.
- **Workflow tab:** the workflow cron field is replaced by a **Schedules** section. It has one row per entry step:
  the step name, an editable `CronField` with presets, and the `cronText` reading. Empty means not scheduled. Edits go
  through `setEntryCron`, so they are undoable and share the Link tab's merge key `entryCron:<wf>:<step>`.
- **Link tab:** an entry arrow's Cron field placeholder is `not scheduled`; there is no workflow fallback any more.
- **Toolbar and triangle:** the cron chip shows `⏱ <cron>` when every scheduled entry shares one cron,
  `⏱ <n> schedules` when they differ, and `⏱ not scheduled` when none has a cron.
- **Chat:**
  - `set_field` for a workflow no longer accepts `cronExpression`.
  - `read_board` drops the workflow cron and keeps each entry step's `cron`.
  - The prompt says once that a workflow is scheduled only by its entry arrows' crons. `set_entry_cron` is unchanged.
  - The `new_workflow` description says "no entry arrows, so not scheduled".

## Deploy order (needs no further approval: the user asked for "complete removal and redeploy")

1. **BaseAPI.** The migration copies workflow crons to entry rows and drops the column.
2. **Re-issue Start** for each workflow that is running: the chain `8cfdbcdb…` and napole-splitchain `2975f4b3…`.
   Start is idempotent and re-projects L2 with `entryCrons`. The orchestrator still deployed handles both shapes.
3. **Orchestrator.**
4. **Acto.** Then restart the 18083 port-forward.
5. **Processor.Analyst** is not redeployed. It is unhealthy and the user has uncommitted manifest edits.

## Verification

- **Unit and integration:** all touched test classes are updated, and the full BaseApi.Tests and Acto vitest suites pass,
  apart from the known pre-existing failures.
- **Migration test:** a workflow cron is copied onto the entry rows that have none, and an entry's own cron is kept.
- **Acto e2e, run headed with Playwright:** the whole existing suite (including `e2e/regression`), plus new specs:
  - a workflow with two entry arrows on different crons, set from the Workflow tab's Schedules section, saved, reloaded and shown on the toolbar chip;
  - a Link-tab edit reflected in the Schedules section and back;
  - undo and redo;
  - clearing a cron to not scheduled;
  - the chat tool, if the model key is configured.
- **Live, checked in the Elasticsearch logs:**
  - `EntryCronLiveTests` (A on `*/30`, B on `*/10`, now with no workflow cron) passes.
  - After the redeploy, the user's two running workflows keep dispatching at their cadence, read from the orchestrator's "dispatched an entry step" logs before and after.
  - A workflow with no entry cron starts and dispatches nothing.
