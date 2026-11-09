# Napole Reach Counting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Napole counts step outcomes, not verdicts. Each execution traced from `fromStepId` adds
`toStepId`'s outcomes if it reached that step, or else its Failed and Cancelled outcomes on the way.
All five report dimensions move from the pod into a nine-field payload.

**Architecture:** The same shape: window, pure rules and report builder around one ES|QL source and
a thin `BaseProcessor<NapoleConfig>`. What changes:
- the statement returns per-execution reach and outcome counts;
- `RoundTrip`/`RoundTripRules` give way to `ReachRules` returning a `Contribution`;
- `ReportBuilder` sums contributions and no longer asserts an identity;
- the dimensions come from the payload.

**Tech Stack:** .NET 8, `BaseProcessor.Core`/`Messaging.Contracts` 1.0.0 (repo-local packages),
Elasticsearch 9.3 ES|QL with `INLINE STATS`, xUnit v3 (MTP runner), kind namespace `skp`.

**Spec:** `docs/superpowers/specs/2026-11-09-napole-reach-design.md` (revises
`2026-11-09-napole-sections-design.md`, which revises `2026-11-08-napole-design.md`). Read all three.
This plan argues from the first.

## Global Constraints

- **Work in the main checkout `C:\Users\katan\source\repos\SK_P11` on `feature/ems-exporter`.** No
  worktree. The user's uncommitted edits must stay untouched:
  - `k8s/31-workflow-studio.yaml`, `k8s/32-valence.yaml`, `k8s/43-processor-analyst.yaml`;
  - `src/Processor.Analyst/Bit/RehearsalGraph.cs`;
  - `src/WorkflowStudio/src/canvas/nodes/Chip.tsx`;
  - untracked files.

  Commit with explicit paths only. Apply manifests one file at a time.
- **Payload: nine fields, all required, in this order:**
  1. `watchedWorkflowId`, `fromStepId`, `toStepId`: GUIDs, not empty;
  2. `windowMinutes`: integer ≥ 1;
  3. `reporterComponentName`, `reporterSubComponentName`, `reporterNetworkName`, `srcCode`,
     `sagCode`: strings. The schema says `minLength: 1`; at run time a whitespace-only value is a
     `FailedException` naming the field.

  The order is the schema's `properties` and `required`, `NapoleConfig`'s parameters, and every
  example.
- **Pod configuration** keeps only `Napole:ElasticBaseUrl` (required), `LagSeconds` and
  `TrailMinutes`. `ReportDimensions` stops being an options class and the four `Napole:Report:*`
  validations go. A leftover variable is ignored.
- **The counting rule** (spec §2.2), per traced execution:
  - `roots > 1` → left out ("re-imported");
  - else `reached > 0` → input 1, plus `endCompleted`/`endFailed`/`endCancelled` into
    output/failed/discarded;
  - else `wayFailed + wayCancelled > 0` → input 1, plus those into failed/discarded;
  - else → not in the report ("no proven end").

  Counters are step-outcome counts, with no deduplication and no waiting.
- **The report fields are unchanged.** No identity assertion. If the total input is 0 there is no
  report: `CancelledException` naming the workflow, both step ids and the window.
- **Kept:** the warning when traced executions exist but none reached `toStepId`, which names
  `toStepId`. The info log line counts "not in report" and "re-imported".
- `Result` values stay literal strings in the statement (the user declined to change that).
- Style: match the repo. Long `///` comments say *why*, `ConfigureAwait(false)`, file-scoped
  namespaces, warnings as errors. Pass `TestContext.Current.CancellationToken`.
- **All tests run in the Linux container.** Windows Application Control blocks fresh DLLs here.
  `<FILTER>` is repeatable `--filter-class "<Namespace.Class>"`, or empty for the full suite:
  ```bash
  MSYS_NO_PATHCONV=1 docker run --rm -v "C:/Users/katan/source/repos/SK_P11:/ro:ro" mcr.microsoft.com/dotnet/sdk:8.0-bookworm-slim bash -o pipefail -c \
    'mkdir /repo && tar -C /ro --exclude=bin --exclude=obj --exclude=node_modules --exclude=.superpowers -cf - . | tar -C /repo -xf - && cd /repo && dotnet build src/tests/BaseApi.Tests -v q && dotnet src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.dll <FILTER>'
  ```
  The full suite has **6 known failures**, which are not this plan's:
  - `QueueDepthTests.BothInstrumentsUseAnAnnotationUnitRatherThanOne`;
  - `EnvelopeContractTests.APlainFileSurvivesBothHops`;
  - 4 `FfmpegAudioTranscoderTests`.

## Review Focus

1. **An execution that reached `toStepId` but also failed elsewhere** adds only `toStepId`'s
   outcomes. Pinned in Task 2 (`AFailureElsewhereInAReachedExecutionIsNotCounted`), and live in Task
   3 on the failure-path section: output 48, failed 0.
2. **Two arrivals at `toStepId`** add 2, not 1. Pinned in Task 2
   (`TwoArrivalsAtTheEndAddTwo`), and live: whole run, output 32 for 16 good files.
3. **An execution with no proven end** is in no counter and not in input. Pinned in Task 2
   (`NoProvenEndIsNotInTheReport`), and live on the failure-path section: 16 not in report.
4. **`roots`**: 2 → left out; 0 with a reach → counted, because nothing needs the run to have ended
   now. Pinned in Task 2.
5. **Swapped or mistyped `toStepId`** gives output 0 and the warning. Pinned in Task 2
   (`ATickWhereNoRunReachedTheEndWarnsNamingTheEndStep`, kept), and checked against ES on
   2026-11-09: filefetcher → importer gives input 64, output 0.

---

### Task 1: The payload carries all five report dimensions

**Files:**
- Modify: `src/Processor.Napole/NapoleConfig.cs`, `NapoleOptions.cs`, `ProcessorHost.cs`,
  `ReportBuilder.cs`, `NapoleProcessor.cs`
- Modify: `src/tests/BaseApi.Tests/Schemas/napole-config.json` (v3)
- Modify: `k8s/46-processor-napole.yaml` (remove the four `Napole__Report__*` pairs and their
  comment, and say where the dimensions come from now)
- Test: `NapoleConfigSchemaTests.cs`, `NapoleHostTests.cs`, `ReportBuilderTests.cs`,
  `NapoleProcessorTests.cs`, `NapoleReportSchemaTests.cs` (fixture only)

**Interfaces:**
- Produces:
  - `public sealed record NapoleConfig(Guid WatchedWorkflowId, Guid FromStepId, Guid ToStepId, int WindowMinutes, string ReporterComponentName, string ReporterSubComponentName, string ReporterNetworkName, string SrcCode, string SagCode) : ProcessorConfig;`
  - `public sealed record ReportDimensions(string ReporterComponentName, string ReporterSubComponentName, string ReporterNetworkName, string SrcCode, string SagCode)` with `static ReportDimensions Of(NapoleConfig config)`. It moves out of `NapoleOptions.cs` into its own file `ReportDimensions.cs`.
  - `NapoleOptions` has no `Report` property.
  - `ReportBuilder.Build(ReportWindow window, IEnumerable<RoundTrip> verdicts, ReportDimensions dimensions, DateTimeOffset insertedAt)`. The separate `reporterSubComponentName` parameter goes, and Task 2 replaces `verdicts`.
- Schema v3: title `"Napole step payload v3"`. The nine properties are in the order above,
  `required` is the same list, and `additionalProperties: false`. Each dimension is
  `{"type":"string","minLength":1}`, with a description saying it is copied into
  `commonDimentions` and that the operator owns it.

- [ ] **Step 1: Write the failing tests.**
  - `NapoleConfigSchemaTests`: `WellFormed` becomes the nine-field payload of spec §2.5. Add:
    - `APayloadWithNoComponentIsRejected`;
    - `AnEmptyNetworkIsRejected`;
    - `AnEmptySrcCodeIsRejected`;
    - `APayloadWithNoSagCodeIsRejected`;
    - `ThePropertiesAreInTheDecidedOrder`: the schema's `properties` names equal the nine names in
      order, and so does `required`.

    The existing tests stay.
  - `NapoleHostTests`: the base configuration has no `Napole:Report:*` keys. `TheGraphResolves`
    passes. Replace `AMissingReportDimensionFailsAtStart` with `ThePodNeedsNoReportDimensions`: the
    host starts and options resolve with no `Napole:Report:*` keys.
  - `ReportBuilderTests`: `Dimensions()` returns the record
    `new ReportDimensions("myDepartment", "myTeam", "myNetwork", "928", "LLL")`. The calls drop the
    sub-component argument. `TheDimensionsAreCopiedUnchanged` stays.
  - `NapoleProcessorTests`: `Config(...)` builds the nine-field record, and `Payload()` serializes
    the nine fields in order. `Processor(...)` no longer sets `Report`. Add a theory
    `AWhitespaceDimensionFails(string field)` over the five camelCase names, each set to `"  "`. It
    expects a `FailedException` whose message contains that field name. It replaces
    `AWhitespaceSubComponentFails`. Add `TheReportCarriesThePayloadsDimensions`: a payload with
    distinct values, and the report's five dimensions equal them.
- [ ] **Step 2: Run** the five classes. Expected: compile errors on the `NapoleConfig` arity and
  `ReportDimensions` construction.
- [ ] **Step 3: Implement.**
  - The record and its `///` doc ("nine fields": the section, the time frame, and the report's
    dimensions; all the operator's).
  - The `ReportDimensions` record with `Of`.
  - Drop `Report` from the options and the four validations from the host. Update the host comment.
  - `ReportAsync` validation, in field order: watchedWorkflowId, fromStepId, toStepId,
    windowMinutes, then each dimension, using
    `string.IsNullOrWhiteSpace → FailedException($"Napole's {name} is empty")`.
  - `Build(..., ReportDimensions.Of(config), ...)`.
  - The schema file and the manifest.
- [ ] **Step 4: Run** the five classes, plus `NapoleOpensItsOwnLineageTests`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(napole): all five report dimensions move from the pod into a nine-field payload`.

### Task 2: Count step outcomes where each execution ended

**Files:**
- Create: `src/Processor.Napole/ReachRules.cs` (`Contribution`, `Reach`, `ReachRules`)
- Delete: `src/Processor.Napole/RoundTrip.cs`, `src/tests/BaseApi.Tests/Napole/RoundTripRulesTests.cs`
- Modify: `ExecutionTrail.cs`, `ElasticTrailSource.cs`, `ReportBuilder.cs`, `NapoleProcessor.cs`,
  `TrailRecords.cs` (doc only)
- Modify: `src/tests/BaseApi.Tests/Schemas/napole-report.json`: descriptions only (spec §2.3).
  Fields, types and `required` are unchanged.
- Test: create `ReachRulesTests.cs`. Rewrite the trail-shaped parts of `ElasticTrailSourceTests.cs`,
  `ReportBuilderTests.cs` and `NapoleProcessorTests.cs`.

**Interfaces:**
- Consumes: Task 1's `NapoleConfig`, `ReportDimensions` and `Build(window, …, dimensions, insertedAt)`.
- Produces:
  - `public sealed record ExecutionTrail(Guid ExecutionId, long Roots, long Reached, long EndCompleted, long EndFailed, long EndCancelled, long WayFailed, long WayCancelled)`.
  - `public enum Reach { Reached, EndedOnTheWay, NoProvenEnd, ReImported }`.
  - `public readonly record struct Contribution(int Input, int Output, int Failed, int Discarded)`.
  - `public static class ReachRules`, with `static Reach Classify(ExecutionTrail trail)` and
    `static Contribution Count(ExecutionTrail trail)`. `Count` is zero for `NoProvenEnd` and
    `ReImported`.
  - `ReportBuilder.Build(ReportWindow window, IEnumerable<Contribution> contributions, ReportDimensions dimensions, DateTimeOffset insertedAt)`
    sums the contributions and returns null when the summed `Input` is 0. No identity check.

- [ ] **Step 1: Write the failing rule tests** in `ReachRulesTests`, using a helper
  `T(roots, reached, endC, endF, endX, wayF, wayX)`:
  - `TwoArrivalsAtTheEndAddTwo`: (1,2,2,0,0,0,0) → Reached, (1,2,0,0).
  - `MixedOutcomesAtTheEndAreEachCounted`: (1,2,1,1,0,1,0) → (1,1,1,0).
  - `AFailureElsewhereInAReachedExecutionIsNotCounted`: (1,1,1,0,0,1,1) → (1,1,0,0).
  - `ACancelAtTheEndIsDiscarded`: (1,1,0,0,1,0,1) → (1,0,0,1).
  - `TwoFailuresOnTheWayAddTwo`: (1,0,0,0,0,2,0) → EndedOnTheWay, (1,0,2,0).
  - `ACancelOnTheWayIsDiscarded`: (1,0,0,0,0,0,1) → (1,0,0,1).
  - `NoProvenEndIsNotInTheReport`: (1,0,0,0,0,0,0) → NoProvenEnd, (0,0,0,0).
  - `TwoRootsAreLeftOut`: (2,1,1,0,0,0,0) → ReImported, (0,0,0,0).
  - `NoRootButAReachIsCounted`: (0,1,1,0,0,0,0) → Reached, (1,1,0,0).
- [ ] **Step 2: Write the failing report tests** in `ReportBuilderTests`:
  - `TheWorkedExample` becomes the live window of spec §5: 16 × (1,2,0,0), 48 × (1,0,1,0),
    16 × (1,0,0,1), plus 3 × `default`. Expect input 80, output 32, failed 48, discarded 16.
  - `TheCountersMayExceedTheInput`: one (1,2,0,0) → input 1, output 2, with no exception.
  - `NothingWithAProvenEndIsNoReport`: only `default` contributions → null.
  - Delete `TheCountsAlwaysAddUp`. The other tests adapt to contributions.
- [ ] **Step 3: Write the failing source tests.** The columns are
  `attributes.ExecutionId, roots, reached, endCompleted, endFailed, endCancelled, wayFailed, wayCancelled`.
  - `ItPostsOneStatementWithTheSectionAsParams`: the same 11 params in the same order as today.
    The query contains `INLINE STATS`, `endCompleted` and `wayFailed`, and does not contain
    `openBranches` or `toT`.
  - `ItReadsTheTrailsBack` and `ItReadsRowsByColumnName`: the new shape.
  - The failure-mapping tests stay as they are.
- [ ] **Step 4: Write the failing processor tests.** The `FakeTrailSource` helpers use the new
  trail shape:
  - `Reached2()` = (1,2,2,0,0,0,0);
  - `FailedOnTheWay()` = (1,0,0,0,0,1,0);
  - `CancelledOnTheWay()` = (1,0,0,0,0,0,1);
  - `NoEnd()` = (1,0,0,0,0,0,0);
  - `ReImported()` = (2,1,1,0,0,0,0).

  Tests:
  - `TheReportCountsStepOutcomes`: Reached2, FailedOnTheWay, CancelledOnTheWay, NoEnd → input 3,
    output 2, failed 1, discarded 1.
  - `TheReportLineCountsTheRunsLeftOut`: Reached2, NoEnd, ReImported, ReImported → the info line
    contains `1 not in report` and `2 re-imported`.
  - `ATickWhereNoRunReachedTheEndWarnsNamingTheEndStep`: FailedOnTheWay, NoEnd → one warning naming
    `toStepId`.
  - `ATickWhereARunReachedTheEndDoesNotWarn`: kept.
  - `NothingCountedIsCancelledAndNamesTheSection`: NoEnd, ReImported → `CancelledException`, no
    send.
  - Delete `BypassedRunsAreInNoCount`.
- [ ] **Step 5: Run**:
  - `BaseApi.Tests.Napole.ReachRulesTests`;
  - `BaseApi.Tests.Napole.ReportBuilderTests`;
  - `BaseApi.Tests.Napole.ElasticTrailSourceTests`;
  - `BaseApi.Tests.Napole.NapoleProcessorTests`.

  Expected: compile errors on `ReachRules`, `Contribution` and the trail shape.
- [ ] **Step 6: Implement.** `ElasticTrailSource` sends this statement verbatim. It ran against
  live ES on 2026-11-09 and reproduced spec §5 on all five sections:
  ```
  FROM logs-generic.otel-default
  | WHERE attributes.WorkflowId == ?workflow AND resource.attributes.service.name == "orchestrator"
    AND attributes.ExecutionId IS NOT NULL AND @timestamp >= ?trailFrom AND @timestamp < ?trailTo
  | EVAL fmt = TO_STRING(`attributes.{OriginalFormat}`)
  | WHERE fmt == ?root OR fmt == ?advanced OR fmt == ?branchEnds OR fmt == ?advancedAnyway
  | EVAL isRoot = CASE(fmt == ?root, 1, 0),
         res = CASE(fmt == ?branchEnds OR fmt == ?advancedAnyway, attributes.Result, null)
  | STATS root = SUM(isRoot), res = MAX(res), ts = MIN(@timestamp)
          BY attributes.ExecutionId, attributes.EntryId, attributes.StepId
  | EVAL outcome = COALESCE(res, "Completed")
  | INLINE STATS fromT = MIN(CASE(attributes.StepId == ?fromStep, ts, null)) BY attributes.ExecutionId
  | WHERE fromT IS NOT NULL
  | EVAL after = CASE(ts >= fromT, 1, 0), atEnd = CASE(after == 1 AND attributes.StepId == ?toStep, 1, 0)
  | STATS fromT = MIN(fromT), roots = SUM(root), reached = SUM(atEnd),
          endCompleted = SUM(CASE(atEnd == 1 AND outcome == "Completed", 1, 0)),
          endFailed = SUM(CASE(atEnd == 1 AND outcome == "Failed", 1, 0)),
          endCancelled = SUM(CASE(atEnd == 1 AND outcome == "Cancelled", 1, 0)),
          wayFailed = SUM(CASE(after == 1 AND outcome == "Failed", 1, 0)),
          wayCancelled = SUM(CASE(after == 1 AND outcome == "Cancelled", 1, 0)) BY attributes.ExecutionId
  | WHERE fromT >= ?from AND fromT < ?to
  | KEEP attributes.ExecutionId, roots, reached, endCompleted, endFailed, endCancelled, wayFailed, wayCancelled
  | LIMIT 10000
  ```
  Keep the 11 params as they are. `advanced` and `branchEnds` stay, because they select the
  step-run records. Rewrite the class `///` doc for the reach rule: no open branches, no time
  bound, counts per step outcome.
  - `ReachRules.Classify` follows the Global Constraints order.
  - `ReportBuilder` sums the contributions. It keeps the `timStampHour` and dimension code and
    loses the identity check. Rewrite its `///` doc: "the counters count step outcomes; they may
    exceed the input".
  - The processor:
    - `contributions = trails.Select(ReachRules.Count)`;
    - the warning when `trails.Count > 0 && trails.All(t => t.Reached == 0)`;
    - the info line: `reported {InputCount} executions of {WatchedWorkflowId} {FromStepId}..{ToStepId}: {OutputCount} output, {DiscardedCount} discarded, {FailedCount} failed; left out {NoEndCount} not in report, {ReImportedCount} re-imported; window …`.

    The class doc says "counts the step outcomes where each traced execution ended".
  - Rewrite `napole-report.json`'s descriptions to spec §2.2–2.3. Keep the title's version
    consistent ("Napole report v2").
- [ ] **Step 7: Run** every `BaseApi.Tests.Napole.*` class, plus
  `BaseApi.Tests.Orchestrator.StepRolesContractTests`. Expected: PASS.
- [ ] **Step 8: Commit:** `feat(napole): count the step outcomes where each traced execution ended — at toStepId if reached, on the way if not`.

### Task 3: Roll out and prove live ticks

**Files:**
- Modify: `docs/superpowers/specs/2026-11-09-napole-reach-design.md` (status → implemented, and a
  "Live" note with the ticks' counts)

Live ids:
- workflow `napole-splitchain` `2975f4b3-516e-4167-a025-0baef9a7ba86`;
- assignment `dc5ca477-f86a-4e5e-9825-3c7bd9a7240d`;
- processor row `d336a2e3-c711-40c1-84db-ea1da72a0f78`;
- report schema v1 `acefe4ba-dd30-488d-9d79-f8a2f9130099`.

BaseApi is on `localhost:18080`, ES on `localhost:19200`. The independent recount is `reach.py` in
the session scratchpad,
`C:\Users\katan\AppData\Local\Temp\claude\C--Users-katan-source-repos-SK-P11\b6d3f0bf-0f32-4bc5-885f-8c3d177d6c11\scratchpad\reach.py`,
run as `python reach.py <reportFromTime ms> "I>SE"`.

- [ ] **Step 1: Full suite in the container**, empty `<FILTER>`. Expected: only the six known
  failures.
- [ ] **Step 2: Roll out** in this order:
  1. POST `napole-config` 3.0.0 from the v3 file, and `napole-report` 2.0.0 from the rewritten
     file (`POST /api/v1/schemas`, definition as a string).
  2. Stop the workflow (`POST /api/v1/orchestration/stop`, the body a JSON string of the id).
  3. PUT the assignment with the nine-field payload: the whole-run section (importer `95225f8c-…` →
     split-exporter `06f1c5fd-…`), `windowMinutes` 10, and `myDepartment`, `myTeam`, `myNetwork`,
     `928`, `LLL`.
  4. Build `processor-napole:local` and load it into kind.
  5. `kubectl apply -f k8s/46-processor-napole.yaml` alone, then restart the deployment.
  6. Read the source hash from the "no processor registered for source hash" line.
  7. PUT the processor row: version 3.0.0, the hash, `configSchemaId` = config 3.0.0,
     `outputSchemaId` = report 2.0.0.
  8. Start the workflow.

  Expected: every call returns 2xx. A 422 on start means the pod isn't live yet; retry once it's
  ready.
- [ ] **Step 3: Prove the whole-run tick.** At the next `:x5` tick, read the latest
  `skp-napole-reports` record with its `execution-id` header. Read it from the beginning with
  `--from-beginning --timeout-ms 10000` and take the last record; `--offset -1` reads nothing. Run
  `reach.py` for its window. Expected:
  - the four counts are equal;
  - output is twice the good files (about 2/5 of input);
  - the five dimensions are the payload's.
- [ ] **Step 4: Prove the failure-path section.** PUT the assignment with `toStepId`
  `export-outcome` (`9b4224a5-…`) and a distinct `reporterSubComponentName`, then restart the
  workflow. At the next tick, check against `reach.py`. Expected:
  - failed 0 and output ≈ 3/5 of all traced executions (Review Focus 1);
  - about 1/5 not in report, shown in the log line (Review Focus 3).

  Then restore the whole-run payload and restart.
- [ ] **Step 5: Commit** the spec's status and live note:
  `docs(napole): reach counting live — whole run and failure path match an independent recount`.
