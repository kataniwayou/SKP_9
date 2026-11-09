# Napole Sections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Napole reports on any section `fromStepId → toStepId` of a watched workflow, with each
execution's verdict read from the orchestrator's step outcomes only. `reporterSubComponentName`
moves from the pod into the payload, so each section's report names itself.

**Architecture:** The shape stays the same: pure window, rules and report builder around one ES|QL
source and a thin `BaseProcessor<NapoleConfig>`. What changes:
- the payload grows from 2 fields to 5;
- the source's two statements (import selection, then trails) become one statement keyed on the
  section;
- the rules gain a `Bypassed` verdict;
- the two orchestrator templates Napole now reads become `Messaging.Contracts` constants.

**Tech Stack:** .NET 8, `BaseProcessor.Core` and `Messaging.Contracts` 1.0.0 (repo-local
packages), Elasticsearch 9.3 ES|QL with `INLINE STATS`, xUnit v3 (MTP runner), kind cluster
namespace `skp`.

**Spec:** `docs/superpowers/specs/2026-11-09-napole-sections-design.md` (revises
`2026-11-08-napole-design.md`). Read both. This plan argues from them.

## Global Constraints

- **Work in the main checkout `C:\Users\katan\source\repos\SK_P11`, on `feature/ems-exporter`.** Do
  not create a worktree or a sibling folder. The checkout holds the user's own uncommitted edits
  (`k8s/31-workflow-studio.yaml`, `k8s/32-valence.yaml`, `k8s/43-processor-analyst.yaml`,
  `src/Processor.Analyst/Bit/RehearsalGraph.cs`, `src/WorkflowStudio/src/canvas/nodes/Chip.tsx`,
  and untracked files):
  - never stage, stash, reset or reformat them;
  - commit with explicit paths only, never `git add -A` or `git commit -a`;
  - apply manifests one file at a time, never `kubectl apply -k k8s`.
- Payload: **exactly five** fields, all required.
  - `watchedWorkflowId`, `fromStepId`, `toStepId`: GUIDs, not empty.
  - `windowMinutes`: integer ≥ 1.
  - `reporterSubComponentName`: string, not empty and not whitespace; the schema says `minLength: 1`.
  - `fromStepId == toStepId` is allowed.
- `Napole:Report:ReporterSubComponentName` is **removed** from options and from its startup
  validation. If it is still set, it is ignored: no fallback, no override. The other four
  dimensions, `ElasticBaseUrl`, `LagSeconds` and `TrailMinutes` are unchanged.
- The report JSON is unchanged: same field names, misspellings included. `reporterSubComponentName`
  now comes from the payload.
- **Verdict order** (spec §5.2):
  1. `Roots != 1` → Unfinished;
  2. `Failed > 0` → Failed;
  3. `OpenBranches > 0` → Unfinished;
  4. `Cancelled > 0` → Cancelled;
  5. `Reached > 0` → Complete;
  6. otherwise Bypassed.

  Only Failed, Cancelled and Complete are counted. Counts are per execution.
- The identity `output + failed + discarded == input` is asserted before sending, as today. Nothing
  counted → `CancelledException`, never a silent return.
- New template constants must be **byte-identical** to what the orchestrator writes today, em dash
  `—` (U+2014) included. **`OutcomeTemplates.All` stays `[BranchEnds, Advanced]`**:
  `StepRolesContractTests` pins it, and the Analyst funnel counts by it.
- `Messaging.Contracts` is consumed as the pinned, repo-local package 1.0.0. Repack it in place:
  1. `dotnet pack src/Messaging.Contracts -c Release`;
  2. delete `~/.nuget/packages/messaging.contracts/1.0.0`;
  3. `dotnet restore SK_P.sln --force-evaluate`.

  Commit `src/Messaging.Contracts/nugets/1.0.0/Messaging.Contracts.1.0.0.nupkg` and the
  `packages.lock.json` files whose `Messaging.Contracts` hash changed. Precedent: commit `9b8dba1d`.
  Revert any lock file that changed only in line endings.
- The orchestrator is **not redeployed** in this plan.
- Code style: match the repo. Long `///` comments say *why*, `ConfigureAwait(false)`, file-scoped
  namespaces, warnings as errors, no package versions in csproj files. Pass
  `TestContext.Current.CancellationToken` in tests (analyzer xUnit1051).
- **All tests run in the Linux container.** Windows Application Control blocks freshly built DLLs
  here. `<FILTER>` is `--filter-class "<Namespace.Class>"`, repeatable, or empty for the full suite:
  ```bash
  MSYS_NO_PATHCONV=1 docker run --rm -v "C:/Users/katan/source/repos/SK_P11:/ro:ro" mcr.microsoft.com/dotnet/sdk:8.0-bookworm-slim bash -o pipefail -c \
    'mkdir /repo && tar -C /ro --exclude=bin --exclude=obj --exclude=node_modules --exclude=.superpowers -cf - . | tar -C /repo -xf - && cd /repo && dotnet build src/tests/BaseApi.Tests -v q && dotnet src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.dll <FILTER>'
  ```
  On the base tree (`697c7b80`) the full suite has **6 known failures**, which are not this plan's:
  - `QueueDepthTests.BothInstrumentsUseAnAnnotationUnitRatherThanOne`;
  - `EnvelopeContractTests.APlainFileSurvivesBothHops`;
  - 4 `FfmpegAudioTranscoderTests`.

## Review Focus

1. **A failure inside the section while a branch is still open** must count as Failed, not be lost
   as Unfinished. Pinned in Task 3 (`AFailureWithABranchStillOpenIsFailed`).
2. **A split that meets again at `toStepId`** must give one output, not two. Pinned in Task 3: the
   rule `TwoEndsAtTheTerminatorAreOneOutput`, and the source reading `reached = 2` as one Complete.
3. **A failure after `toStepId` completed** must not count: the upper time bound. Unit tests cannot
   run ES|QL, so this is pinned live in Task 4. On the `importer → split-filefetcher` section,
   `failedCount` must equal the filefetcher failures alone.
4. **A template reworded, or its em dash replaced by `-`,** would make Napole read every
   advanced-anyway step as Completed, with no error. Pinned in Task 1 against literal strings that
   spell out `\u2014`, and live in Task 4: the failed counts match §8.
5. **A typo in `fromStepId`** gives an empty answer and no report. The Cancelled message must name
   both step ids. Pinned in Task 3 (`NothingCountedIsCancelledAndNamesTheSection`).

---

### Task 1: The two templates become contract constants

**Files:**
- Modify: `src/Messaging.Contracts/OutcomeTemplates.cs`
- Modify: `src/Orchestrator/Messaging/StepOutcomeHandler.cs:269` (the root line) and `:428-432` (the
  advanced-anyway warning)
- Modify: `src/tests/BaseApi.Tests/Orchestrator/StepRolesContractTests.cs` (add tests)
- Modify: `src/Messaging.Contracts/nugets/1.0.0/Messaging.Contracts.1.0.0.nupkg`, plus the
  `packages.lock.json` files that change

**Interfaces:**
- Produces: `OutcomeTemplates.EntryCompleted` = `"the entry step completed with {Result}"` and
  `OutcomeTemplates.AdvancedAnyway` =
  `"advancing {SuccessorCount} successor(s) on a {Result} step — their entry conditions accept it"`.
  Both `public const string`, neither in `All`.

- [ ] **Step 1: Write the failing tests** in `StepRolesContractTests`:
  - `TheEntryTemplateIsWhatTheOrchestratorWritesToday`:
    `Assert.Equal("the entry step completed with {Result}", OutcomeTemplates.EntryCompleted)`.
  - `TheAdvancedAnywayTemplateIsWhatTheOrchestratorWritesToday`:
    `Assert.Equal("advancing {SuccessorCount} successor(s) on a {Result} step \u2014 their entry conditions accept it", OutcomeTemplates.AdvancedAnyway)`.
  - `NapolesTemplatesStayOutOfTheFunnelList`: `Assert.DoesNotContain(OutcomeTemplates.EntryCompleted, OutcomeTemplates.All)`,
    and the same for `AdvancedAnyway`.
- [ ] **Step 2: Run `--filter-class "BaseApi.Tests.Orchestrator.StepRolesContractTests"`.**
  Expected: the build fails, because `OutcomeTemplates` has no `EntryCompleted`.
- [ ] **Step 3: Add the two constants** with `///` docs naming the emitter
  (`StepOutcomeHandler`) and the reader (Napole). In the orchestrator, replace the two literal
  templates with the constants. The concatenated warning string becomes one constant. The emitted
  text must not change. Repack `Messaging.Contracts` per Global Constraints.
- [ ] **Step 4: Run the same filter.** Expected: PASS, the existing tests included.
- [ ] **Step 5: Commit** the two source files, the test file, the nupkg and the changed lock files:
  `feat(contracts): the entry and advanced-anyway templates are OutcomeTemplates constants, byte-identical, outside All`.

### Task 2: The payload names the section and the sub-component

**Files:**
- Modify: `src/Processor.Napole/NapoleConfig.cs`, `NapoleOptions.cs`, `ProcessorHost.cs` (drop the
  sub-component validation), `ReportBuilder.cs`, `NapoleProcessor.cs` (validation and the `Build`
  call), `appsettings.json` if it names the sub-component
- Modify: `src/tests/BaseApi.Tests/Schemas/napole-config.json`
- Modify: `k8s/46-processor-napole.yaml` (remove the `Napole__Report__ReporterSubComponentName` pair,
  and say "four report dimensions" in its comment)
- Test: `NapoleConfigSchemaTests.cs`, `NapoleHostTests.cs`, `ReportBuilderTests.cs`,
  `NapoleProcessorTests.cs`

**Interfaces:**
- Produces:
  - `public sealed record NapoleConfig(Guid WatchedWorkflowId, Guid FromStepId, Guid ToStepId, int WindowMinutes, string ReporterSubComponentName) : ProcessorConfig;`
  - `ReportDimensions` without `ReporterSubComponentName`.
  - `ReportBuilder.Build(ReportWindow window, IEnumerable<RoundTrip> verdicts, ReportDimensions dimensions, string reporterSubComponentName, DateTimeOffset insertedAt)`.
- The schema title becomes `"Napole step payload v2"`, with all five fields required and
  `additionalProperties: false`. The two step ids use the same `format` and `pattern` as
  `watchedWorkflowId`. `reporterSubComponentName` is `{"type":"string","minLength":1}`, with a
  description saying it names the section in the report and that the operator keeps it unique.

- [ ] **Step 1: Write the failing tests.**
  - `NapoleConfigSchemaTests`: update `AWellFormedPayloadValidates` to the five-field payload of
    spec §3. Add:
    - `APayloadWithNoFromStepIsRejected`;
    - `APayloadWithNoToStepIsRejected`;
    - `AStepThatIsNoGuidIsRejected`;
    - `AnEmptySubComponentIsRejected` (`""`);
    - `APayloadWithNoSubComponentIsRejected`.

    `TheSchemaDescribesTheConfigRecord` must still pass against the new record.
  - `NapoleHostTests`: remove `Napole:Report:ReporterSubComponentName` from the base configuration.
    `TheGraphResolves` must still pass. Add `TheSubComponentIsNoLongerAPodSetting`: the host starts
    without it.
  - `ReportBuilderTests`: in `TheDimensionsAreCopiedUnchanged`, the sub-component comes from the
    new parameter. Add `ThePodsOldSubComponentIsNotUsed`, which builds with `"split-whole-run"` and
    expects exactly that.
  - `NapoleProcessorTests`:
    - `AWhitespaceSubComponentFails`, for `"  "`;
    - `AnEmptyFromStepFails`;
    - `AnEmptyToStepFails`.

    Each expects `FailedException`. Add `ASingleStepSectionIsAccepted`: `fromStepId == toStepId`
    reaches the source with no exception.
  - `NapoleConfigSchemaTests`: also add `ASingleStepSectionValidates`.
- [ ] **Step 2: Run** the four classes. Expected: compile errors on `NapoleConfig` arity.
- [ ] **Step 3: Implement.**
  - The record and its `///` doc: replace "two fields" with the five, and keep the
    operator-responsibility and mid-slot paragraphs.
  - The schema.
  - Drop the option and its `Validate`.
  - Add a `Build` parameter.
  - `ReportAsync` validation, in this order: empty workflow, empty from-step, empty to-step,
    `windowMinutes`, then the sub-component. Each throws a `FailedException` naming the field.
  - The manifest edit.
- [ ] **Step 4: Run** the four classes, plus `BaseApi.Tests.Napole.NapoleReportSchemaTests`.
  Expected: PASS.
- [ ] **Step 5: Commit** with explicit paths:
  `feat(napole): five-field payload, fromStepId/toStepId/reporterSubComponentName, the sub-component leaves the pod`.

### Task 3: Section trails, the verdict, and the one statement

**Files:**
- Modify: `src/Processor.Napole/ExecutionTrail.cs`, `RoundTrip.cs`, `IExecutionTrailSource.cs`,
  `ElasticTrailSource.cs`, `TrailRecords.cs` (doc only), `NapoleProcessor.cs`
- Create: `src/Processor.Napole/WatchedSection.cs`
- Test: `RoundTripRulesTests.cs` (rewrite), `ElasticTrailSourceTests.cs` (rewrite),
  `NapoleProcessorTests.cs` (`FakeTrailSource` and its callers)

**Interfaces:**
- Consumes: Task 1's constants, and Task 2's `NapoleConfig`.
- Produces:
  - `public readonly record struct WatchedSection(Guid WorkflowId, Guid FromStepId, Guid ToStepId)`
    with `static WatchedSection Of(NapoleConfig config)`.
  - `public sealed record ExecutionTrail(Guid ExecutionId, long Roots, long OpenBranches, long Failed, long Cancelled, long Reached)`.
  - `enum RoundTrip { Failed, Cancelled, Complete, Unfinished, Bypassed }`, where `Bypassed` means
    the run finished cleanly by a route that does not pass `toStepId`, and is in no count.
  - `RoundTripRules.Decide(ExecutionTrail)` in the Global Constraints order.
  - `IExecutionTrailSource.ReadAsync(WatchedSection section, ReportWindow window, TimeSpan trail, CancellationToken ct)`.

- [ ] **Step 1: Write the failing rule tests.** Keep the file's `Decide(...)` helper, reordered to
  the new record. Each test asserts one verdict:
  - `AWholeSectionIsComplete` (1,0,0,0,1) → Complete.
  - `TwoEndsAtTheTerminatorAreOneOutput` (1,0,0,0,2) → Complete.
  - `AFailureThatRanToItsFailureExportIsFailed` (1,0,1,0,0) → Failed.
  - `AFailureWithABranchStillOpenIsFailed` (1,1,1,0,0) → Failed.
  - `AFailureAndACancelIsFailed` (1,0,1,1,0) → Failed.
  - `AWhitelistCancelIsCancelled` (1,0,0,1,0) → Cancelled.
  - `ACancelWithABranchStillOpenIsUnfinished` (1,1,0,1,0) → Unfinished.
  - `AnOpenBranchIsUnfinished` (1,1,0,0,1) → Unfinished.
  - `ACleanRunThatNeverReachedTheTerminatorIsBypassed` (1,0,0,0,0) → Bypassed.
  - `TwoRootsAreUnfinished` (2,0,1,0,2) → Unfinished.
  - `NoRootIsUnfinished` (0,0,0,0,1) → Unfinished.
- [ ] **Step 2: Write the failing source tests**, reusing the file's `ScriptedHandler`. The answer
  columns are `attributes.ExecutionId, roots, openBranches, failed, cancelled, reached`.
  - `ItPostsOneStatementWithTheSectionAsParams`: exactly one request, to
    `/_query?allow_partial_results=false`, with params in this order:
    1. `workflow`;
    2. `trailFrom=2026-11-08T10:30:00.000Z`;
    3. `trailTo=2026-11-08T11:00:00.000Z`;
    4. `root=` + `EntryCompleted`;
    5. `advanced`;
    6. `branchEnds`;
    7. `advancedAnyway=` + `AdvancedAnyway`;
    8. `fromStep`;
    9. `toStep`;
    10. `from=2026-11-08T10:40:00.000Z`;
    11. `to=2026-11-08T10:50:00.000Z`.

    Assert that the query contains `INLINE STATS`, and contains neither `kafka-importer` nor
    `Record`.
  - `TheStepOutcomeTemplatesTravelAsParams`: no template text appears in the query string.
  - `ItReadsTheTrailsBack`: two rows, mapped to `ExecutionTrail`s.
  - `ItReadsRowsByColumnName`: columns shuffled.
  - `AnEmptyAnswerIsNoTrails`: zero rows → empty list.
  - Keep, adapted to one request:
    - `APartialAnswerFails`, no longer a theory;
    - `AnAnswerAtTheRowLimitFails`;
    - `ANon2xxFails`;
    - `AnUnreachableClusterFails`;
    - `ATimeoutFails`;
    - `AMalformedBaseUrlFailsWhenRead`.
  - Delete `NoImportsSendsOnlyTheFirstStatement`, `AnIdBHasNoRowForComesBackWithNoImports` and
    `BranchesCloseOnTheOrchestratorsOutcomeContractNotOnLogText`; the new param tests replace
    them.
- [ ] **Step 3: Write the failing processor tests.**
  - `ItAsksForTheSectionAndTheSnappedWindow`: `FakeTrailSource` records the `WatchedSection` it was
    given, which equals the payload's three ids.
  - `BypassedRunsAreInNoCount`: trails Complete + Bypassed → input 1.
  - `NothingCountedIsCancelledAndNamesTheSection`: no trails → a `CancelledException` whose message
    contains the workflow id, `fromStepId`, `toStepId` and the window. It replaces
    `NothingTerminatedIsCancelledAndSendsNothing` and keeps its "sends nothing" assert.
- [ ] **Step 4: Run**:
  - `BaseApi.Tests.Napole.RoundTripRulesTests`;
  - `BaseApi.Tests.Napole.ElasticTrailSourceTests`;
  - `BaseApi.Tests.Napole.NapoleProcessorTests`.

  Expected: compile errors on the new record and interface.
- [ ] **Step 5: Implement.** `ElasticTrailSource` sends this one statement, verbatim. It was run
  against the live cluster on 2026-11-09 and reproduced every row of spec §8:
  ```
  FROM logs-generic.otel-default
  | WHERE attributes.WorkflowId == ?workflow AND resource.attributes.service.name == "orchestrator"
    AND attributes.ExecutionId IS NOT NULL AND @timestamp >= ?trailFrom AND @timestamp < ?trailTo
  | EVAL fmt = TO_STRING(`attributes.{OriginalFormat}`)
  | WHERE fmt == ?root OR fmt == ?advanced OR fmt == ?branchEnds OR fmt == ?advancedAnyway
  | EVAL isRoot = CASE(fmt == ?root, 1, 0), isAdv = CASE(fmt == ?advanced, 1, 0), isEnded = CASE(fmt == ?branchEnds, 1, 0),
         succ = CASE(fmt == ?advanced, TO_LONG(attributes.SuccessorCount), 0),
         res = CASE(fmt == ?branchEnds OR fmt == ?advancedAnyway, attributes.Result, null)
  | STATS root = SUM(isRoot), adv = MAX(isAdv), ended = MAX(isEnded), succ = SUM(succ), res = MAX(res), ts = MIN(@timestamp)
          BY attributes.ExecutionId, attributes.EntryId, attributes.StepId
  | EVAL outcome = COALESCE(res, "Completed")
  | INLINE STATS fromT = MIN(CASE(attributes.StepId == ?fromStep, ts, null)),
                 toT = MAX(CASE(attributes.StepId == ?toStep AND outcome == "Completed", ts, null)) BY attributes.ExecutionId
  | WHERE fromT IS NOT NULL
  | EVAL inSection = CASE(ts >= fromT AND (toT IS NULL OR ts <= toT), 1, 0)
  | STATS fromT = MIN(fromT), roots = SUM(root), dispatched = SUM(succ), handled = SUM(adv) + SUM(ended),
          failed = SUM(CASE(inSection == 1 AND outcome == "Failed", 1, 0)),
          cancelled = SUM(CASE(inSection == 1 AND outcome == "Cancelled", 1, 0)),
          reached = SUM(CASE(attributes.StepId == ?toStep AND outcome == "Completed", 1, 0)) BY attributes.ExecutionId
  | WHERE fromT >= ?from AND fromT < ?to
  | EVAL openBranches = roots + dispatched - handled
  | KEEP attributes.ExecutionId, roots, openBranches, failed, cancelled, reached
  | LIMIT 10000
  ```
  - **Why `res` excludes the root record:** the root record also carries `Result`.
  - **Why `root` is `SUM`:** two runs of one id share no `EntryId`, but a `SUM` stays right even if
    they did.
  - Rewrite the class `///` doc: one statement, section-keyed, and the time-bounded section limit
    (spec §5.3).
  - The processor:
    - passes `WatchedSection.Of(config)`;
    - feeds `RoundTripRules.Decide`;
    - logs `reported {InputCount} executions of {WatchedWorkflowId} {FromStepId}..{ToStepId}: …`;
    - on nothing counted, throws `no executions of {workflow} counted in section {from}..{to}, window {from:o}..{to:o}`.
- [ ] **Step 6: Run** the three classes, then every `BaseApi.Tests.Napole.*` class. Expected: PASS.
- [ ] **Step 7: Commit:** `feat(napole): a section's verdict from step outcomes alone — one ES|QL statement, roots from the entry record, Bypassed in no count`.

### Task 4: Roll out and prove one live tick per section shape

**Files:**
- Modify: `docs/superpowers/specs/2026-11-09-napole-sections-design.md` (status line →
  `implemented`, plus a short "Live" note with the tick's counts)

Live ids:
- workflow `napole-splitchain` `2975f4b3-516e-4167-a025-0baef9a7ba86`;
- processor row napole 1.0.1 `d336a2e3-c711-40c1-84db-ea1da72a0f78`;
- schema row napole-config `d0350c5b-670d-4aab-bf76-2991ffc88cb7`;
- watched workflow `8cfdbcdb-a7e0-4a7d-9b4d-e4120ccacf02`;
- step ids in spec §8.

BaseApi is usually forwarded on `localhost:18080`, and ES on `localhost:19200`.

- [ ] **Step 1: Full suite in the container**, empty `<FILTER>`. Expected: the only failures are the
  six known ones from Global Constraints.
- [ ] **Step 2: Roll out,** in the repo's order for a config change.
  1. Post a new `napole-config` schema version from the v2 file (`POST /api/v1/schemas`, with the
     definition as a string).
  2. Stop `napole-splitchain`.
  3. PUT the Napole assignment's payload: the whole-run section (`fromStepId` importer
     `95225f8c-…`, `toStepId` split-exporter `06f1c5fd-…`), `windowMinutes` 10, and
     `reporterSubComponentName` `"myTeam"`, the value the pod sent until now.
  4. Build the image `processor-napole` with version 2.0.0 (*my call*: the payload breaks), and load
     it with `docker save | docker exec -i desktop-control-plane ctr -n k8s.io images import -`.
  5. `kubectl apply -f k8s/46-processor-napole.yaml` alone.
  6. Restart the pod, then read the new source hash from its "no processor registered for source
     hash" log line.
  7. PUT the processor row with the hash and the new schema id.
  8. Start the workflow.

  Expected: the start returns 2xx. A 422 means the pod isn't live yet; retry once it is ready.
- [ ] **Step 3: Prove a live tick.** Wait for the next `:x5` tick. Read the report from
  `skp-napole-reports` and its `execution-id` header. Recount the same window with
  `section_bounded.py` from the session scratchpad
  (`C:\Users\katan\AppData\Local\Temp\claude\C--Users-katan-source-repos-SK-P11\b6d3f0bf-0f32-4bc5-885f-8c3d177d6c11\scratchpad\section_bounded.py`),
  with its window set to the report's `reportFromTime..reportToTime`.
  Expected:
  - the four counts are equal;
  - `reporterSubComponentName` is `"myTeam"`;
  - `failedCount` ≈ 3/5 of input (the §8 path types).
- [ ] **Step 4: Prove the section shapes.** For each section below, PUT a different section payload,
  restart the workflow, and check one tick against the same recount:
  - importer → split-filefetcher: Review Focus 3, `failedCount` = only the filefetcher failures,
    about 1/5;
  - sk-normalizer-sample → split-archivecollapser: an end mid-graph.

  Then restore the whole-run payload. *Builder's call:* use a second Napole step on the same
  workflow instead of switching. Either way, record each tick's counts.
- [ ] **Step 5: Commit** the spec's status and live note:
  `docs(napole): sections live — whole run and two partial sections match an independent recount`.
