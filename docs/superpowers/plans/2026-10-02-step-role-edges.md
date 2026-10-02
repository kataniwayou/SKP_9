# StepRole on the Run's Edges Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `StepRole` marks only a run's two edges — `entry` hardcoded on each entry-step dispatch, `terminal` on the outcome of a step with no successors (decided from the orchestrator's own L1 graph) — and the role-key machinery (BaseApi keys, framework resolver, `intermediate`) is removed; the Kibana pie and the Analyst panel read the two edges.

**Architecture:** `WorkflowFireJob` scopes `StepRole=entry` on its post-send dispatch line. `StepOutcomeHandler` scopes `StepRole=terminal` on the branch-ends line when the returning `StepL1` it already looked up has no `NextStepIds`. Everything that wrote, read or cached role keys is deleted. Kibana and the Analyst count `StepRole` records of fires that entered in the window, by role and step name.

**Tech Stack:** .NET 8, xUnit v3 + NSubstitute, StackExchange.Redis, Elasticsearch/Kibana 9.3.4 ES|QL, Python 3.

**Spec:** `docs/superpowers/specs/2026-10-02-step-role-edges-design.md` (supersedes the role model of `2026-10-02-step-role-design.md`).

## Global Constraints

- `StepRole` values, lowercase, exactly two: `entry`, `terminal`. Scope key `StepRole` (`attributes.StepRole`). Constants in `Messaging.Contracts.StepRoles`; `Intermediate` is removed.
- `entry` is stamped only on `"dispatched an entry step"`, only after a successful send; never on the frozen skip or a failed send.
- `terminal` is stamped only on the `OutcomeTemplates.BranchEnds` record of a step whose `StepL1.NextStepIds` is empty in the workflow named by the outcome message — whatever the result.
- No other record carries `StepRole`.
- BaseApi writes no role keys; no code under `src/` reads `skp:wf:{w}:step:{s}`. `StepRoleClassifier`, `L2ProjectionKeys.StepRole`, `L2ProjectionKeys.RoleField`, `IStepRoleSource`, `RedisStepRoleSource`, `StepRoleResolver`, `FakeStepRoleSource` are deleted.
- After editing `Messaging.Contracts`, `BaseConsole.Core` or `BaseProcessor.Core`: `bash scripts/pack-all.sh` before building consumers or tests.
- Run tests by executing `src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe` (`--filter-class`, `--filter-method`, `--filter-namespace`); always rebuild first (`cd src && dotnet build tests/BaseApi.Tests/BaseApi.Tests.csproj --no-restore -v q`) — a stale binary has already produced a false failure once.
- Full suite: 0 failed, skips only in `BaseApi.Tests.Live`.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never stage `.playwright-mcp/`, `.wf-restore.json`, `tools/simulate-approved-feed.py`.
- Task 5 changes the dev cluster, Redis and Kibana: its executor asks the user before the first change.

## Review Focus

1. **A step with successors that all decline the result** (e.g. a Cancelled outcome at a step whose successor accepts only Completed) — it ends the branch but is not terminal: its branch-ends record carries no `StepRole`. Pinned in Task 1 (`ABranchEndingAtAStepWithSuccessorsIsNotTerminal`).
2. **A step shared by two workflows**, terminal in one and not the other — each workflow's outcome is classified by that workflow's graph. Pinned in Task 1 (`ASharedStepIsTerminalOnlyInTheWorkflowWhereItHasNoSuccessors`).
3. **An outcome arriving after the workflow was stopped** — the handler still finds the step (`TryGetIncludingStopped`) and still stamps `terminal`. Pinned in Task 1 (`ATerminalOutcomeAfterAStopIsStillStamped`).
4. **A fire that dispatches two entry steps** — two `entry` records, one correlation id; `fires` counts one. Pinned in Task 1 (`EveryEntryStepOfOneFireCarriesEntryUnderOneCorrelationId`) and Task 4 (`TwoEntryStepsAreTwoEntryRowsButOneFire`).
5. **A window where every poll drained** — entry records, no terminal records, `recordsImported` 0: a quiet window, not a stall; the panel must expose `recordsImported` so the model can tell. Pinned in Task 4 (`ADrainedWindowCarriesNothingImported`).

---

### Task 1: Orchestrator — stamp the two edges from the L1 graph

**Files:**
- Modify: `src/Orchestrator/Scheduling/WorkflowFireJob.cs` (dispatch line ~305-314)
- Modify: `src/Orchestrator/Messaging/StepOutcomeHandler.cs` (ctor `roles` param and `_roles` field; role block ~334-342)
- Modify: `src/Orchestrator/L1/WorkflowActivator.cs` (ctor `roles` param; `roles?.Forget(workflowId)` ~89-91)
- Test: `src/tests/BaseApi.Tests/Orchestrator/WorkflowFireJobTests.cs`, `ExecutionRoundTripTests.cs`, `WorkflowActivatorTests.cs`, `OrchestratorHostWiringTests.cs`

**Interfaces:**
- Consumes: `StepRoles.Key`, `StepRoles.Entry`, `StepRoles.Terminal`, `StepRoles.Scope(string)`; `OutcomeTemplates.BranchEnds` (all exist).
- Produces: no constructor in `Orchestrator` takes a `StepRoleResolver` any more (Task 2 deletes the type).

- [ ] **Step 1: Write the failing tests**

`WorkflowFireJobTests.cs` — replace `NoRecordAFireWritesCarriesAStepRole` with:

```csharp
    [Fact]
    public async Task ADispatchedEntryStepCarriesEntry()
    {
        // The run's entry edge: hardcoded, no lookup. One record per entry step that reached a queue.
        var h = new Harness().AsLeader().WithWorkflow(W, [(S1, P1)]);

        await h.Build().Execute(h.Context(W, h.JobId));

        var scope = h.ScopeOf("dispatched an entry step");
        Assert.NotNull(scope);
        Assert.Equal(StepRoles.Entry, Assert.Contains(StepRoles.Key, scope!));
    }
```

In `EveryEntryStepOfOneFireCarriesItSeparatelyUnderOneCorrelationId` rename to `EveryEntryStepOfOneFireCarriesEntryUnderOneCorrelationId` and, inside the loop after `dispatches++;`, add:

```csharp
            Assert.Equal(StepRoles.Entry, h.Log.RecordScopes[i][StepRoles.Key]);
```

In `AFrozenEntryStepWritesNoDispatchRecord` and `AFailedSendWritesNoDispatchRecord`, add after the existing `Assert.NotNull(...)` of the frozen / failed record:

```csharp
        Assert.All(h.Log.RecordScopes, scope => Assert.DoesNotContain(StepRoles.Key, scope));
```

`ExecutionRoundTripTests.cs` — delete the second `Harness` constructor and the `_roles` field, restoring:

```csharp
        public Harness(params StepL1[] steps)
        {
            Store.Set(W, new WorkflowL1(W, [A], "* * * * *", [.. steps], []), Guid.NewGuid());
        }

        public IQueueMessageHandler Pre => new StepOutcomeHandler(Store, L2.Multiplexer, Bus, PreLog);
```

Replace the whole `// StepRole: stamped on the one record each returned outcome produces` section with:

```csharp
    // ---------------------------------------------------------------------------------------
    // StepRole: terminal on the outcome of a step with no successors in this workflow's graph
    // ---------------------------------------------------------------------------------------

    [Theory]
    [InlineData(StepResult.Completed)]
    [InlineData(StepResult.Failed)]
    [InlineData(StepResult.Cancelled)]
    public async Task ATerminalStepsOutcomeCarriesTerminalWhateverItsResult(StepResult result)
    {
        var h = new Harness(Step(A, PA, 1, "{}"));
        Seed(h, Entry, Output);

        await h.Deliver(MessageTypes.StepOutcome, Outcome(result, Entry));

        Assert.Equal(StepRoles.Terminal, Assert.Contains(StepRoles.Key, h.ScopeOf(OutcomeTemplates.BranchEnds)!));
    }

    [Fact]
    public async Task ABranchEndingAtAStepWithSuccessorsIsNotTerminal()
    {
        // B accepts only Completed (condition 1), so a Cancelled A ends its branch -- but A has a
        // successor in the graph, so it is not an edge and carries nothing.
        var h = new Harness(Step(A, PA, 1, "{}", B), Step(B, PB, 1, """{"n":2}"""));
        Seed(h, Entry, Output);

        await h.Deliver(MessageTypes.StepOutcome, Outcome(StepResult.Cancelled, Entry));

        Assert.DoesNotContain(StepRoles.Key, h.ScopeOf(OutcomeTemplates.BranchEnds)!);
    }

    [Fact]
    public async Task AnAdvancingOutcomeAndItsHandoffCarryNoRole()
    {
        var h = new Harness(Step(A, PA, 1, "{}", B), Step(B, PB, 1, """{"n":2}"""));
        Seed(h, Entry, Output);

        await h.Deliver(MessageTypes.StepOutcome, Outcome(StepResult.Completed, Entry));

        Assert.DoesNotContain(StepRoles.Key, h.ScopeOf(OutcomeTemplates.Advanced)!);
        Assert.DoesNotContain(StepRoles.Key, h.ScopeOf("handed off to {NextStepId} on {NextProcessorId} with {NextEntryId}")!);
        Assert.DoesNotContain(StepRoles.Key, h.ScopeOf("the entry step completed with {Result}")!);
    }

    [Fact]
    public async Task ASharedStepIsTerminalOnlyInTheWorkflowWhereItHasNoSuccessors()
    {
        // A has no successors in W (the harness) and one successor in W2.
        var w2 = Guid.Parse("99999999-9999-9999-9999-999999999999");
        var h = new Harness(Step(A, PA, 1, "{}"));
        h.Store.Set(w2, new WorkflowL1(w2, [A], "* * * * *", [Step(A, PA, 1, "{}", B), Step(B, PB, 1, """{"n":2}""")], []), Guid.NewGuid());
        Seed(h, Entry, Output);

        await h.Deliver(MessageTypes.StepOutcome, Outcome(StepResult.Completed, Entry) with { WorkflowId = w2 });

        Assert.Null(h.ScopeOf(OutcomeTemplates.BranchEnds));
        Assert.DoesNotContain(StepRoles.Key, h.ScopeOf(OutcomeTemplates.Advanced)!);
    }

    [Fact]
    public async Task ATerminalOutcomeAfterAStopIsStillStamped()
    {
        // A stop marks the L1 entry rather than removing it, so outcomes in flight still resolve.
        var h = new Harness(Step(A, PA, 1, "{}"));
        h.Store.MarkDeleted(W, DateTimeOffset.UtcNow);
        Seed(h, Entry, Output);

        await h.Deliver(MessageTypes.StepOutcome, Outcome(StepResult.Completed, Entry));

        Assert.Equal(StepRoles.Terminal, Assert.Contains(StepRoles.Key, h.ScopeOf(OutcomeTemplates.BranchEnds)!));
    }
```

(If `StepOutcome`'s positional parameter is not named `WorkflowId`, use its actual name; if a second workflow's outcome needs its own seeded entry, seed it the same way — keep the assertions.)

`WorkflowActivatorTests.cs` — delete `ARestartReplacesCachedRoles`; change `Harness.Build(StepRoleResolver? roles = null)` back to `Build()` without the `roles:` argument; drop the `using BaseConsole.Core.Naming;` / `FakeStepRoleSource` usages if nothing else uses them.

`OrchestratorHostWiringTests.cs` — delete `TheStepRoleResolverReachesEveryOrchestratorConsumerOfIt`.

- [ ] **Step 2: Build to verify RED**

Run: `cd src && dotnet build tests/BaseApi.Tests/BaseApi.Tests.csproj --no-restore -v q`
Expected: it builds (the constructors' `roles` parameters are still optional), and running `--filter-namespace "BaseApi.Tests.Orchestrator"` fails `ADispatchedEntryStepCarriesEntry`, `EveryEntryStepOfOneFireCarriesEntryUnderOneCorrelationId`, the three `ATerminalStepsOutcomeCarriesTerminalWhateverItsResult` cases and `ATerminalOutcomeAfterAStopIsStillStamped` (no role is resolved without a resolver).

- [ ] **Step 3: Implement**

`WorkflowFireJob.cs` — replace the comment block and line after the send with:

```csharp
                    // The only record a successful fire leaves. Without it the correlation id minted
                    // above -- the one thing tying this run to everything the processors go on to do
                    // with it -- would exist solely inside messages, and a run could not be found from
                    // the orchestrator's side at all. Every id rides the open scope; the template
                    // carries none, and never the payload.
                    //
                    // StepRole=entry, hardcoded: this line IS the run's entry edge, one per entry step
                    // that reached a queue. Scoped to this line only, so the frozen skip and the send
                    // failure below, which share the outer scope, never carry it. See StepRoles.
                    using (logger.BeginScope(StepRoles.Scope(StepRoles.Entry)))
                    {
                        logger.LogInformation("dispatched an entry step");
                    }
```

`StepOutcomeHandler.cs` — remove the `StepRoleResolver? roles = null` constructor parameter, the `_roles` field and its assignment, and the two lines `var role = …` / `using var roleScope = …` with their comment. Replace the `if (selection.Matches.Count == 0)` body with:

```csharp
        if (selection.Matches.Count == 0)
        {
            // StepRole=terminal marks the run's exit edge: a step with no successors in THIS
            // workflow's graph, whatever its result. A step whose successors exist but all declined
            // this result ends its branch too, but it is not an edge and carries nothing. The graph is
            // the L1 entry this outcome was just routed from, so a step shared by two workflows is
            // classified per workflow. See StepRoles.
            using (completed.NextStepIds.Count == 0 ? _logger.BeginScope(StepRoles.Scope(StepRoles.Terminal)) : null)
            {
                _logger.Log(level, OutcomeTemplates.BranchEnds, m.Result);
            }
        }
```

Remove the now-unused `using BaseConsole.Core.Naming;` only if nothing else in the file uses that namespace.

`WorkflowActivator.cs` — remove the `StepRoleResolver? roles = null` constructor parameter and the `roles?.Forget(workflowId);` line with its comment.

- [ ] **Step 4: Run the tests**

```bash
cd src && dotnet build tests/BaseApi.Tests/BaseApi.Tests.csproj --no-restore -v q
cd tests/BaseApi.Tests && ./bin/Debug/net8.0/BaseApi.Tests.exe --filter-namespace "BaseApi.Tests.Orchestrator"
```

Expected: all pass. Then the full suite once: 0 failed.

- [ ] **Step 5: Commit**

```bash
git add src/Orchestrator src/tests/BaseApi.Tests/Orchestrator
git commit -m "feat(orchestrator): StepRole on the run's edges -- entry on each dispatch, terminal from the L1 graph"
```

---

### Task 2: Remove the role-key machinery and `intermediate`

**Files:**
- Delete: `src/BaseApi.Service/Features/Orchestration/Projection/StepRoleClassifier.cs`, `src/BaseConsole.Core/Naming/IStepRoleSource.cs`, `src/BaseConsole.Core/Naming/RedisStepRoleSource.cs`, `src/BaseConsole.Core/Naming/StepRoleResolver.cs`, `src/tests/BaseApi.Tests/Support/FakeStepRoleSource.cs`, `src/tests/BaseApi.Tests/Naming/StepRoleResolverTests.cs`, `src/tests/BaseApi.Tests/Orchestration/StepRoleProjectionTests.cs`
- Modify: `src/BaseApi.Service/Features/Orchestration/Projection/L2ProjectionWriter.cs` (role writes in `WriteAsync`; `FindRemovedStepsAsync` back to its pre-StepRole signature)
- Modify: `src/BaseConsole.Core/DependencyInjection/ConsoleRedisServiceCollectionExtensions.cs` (two registrations)
- Modify: `src/Messaging.Contracts/Projections/L2ProjectionKeys.cs` (`StepRole`, `RoleField`, the summary `<item>`)
- Modify: `src/Messaging.Contracts/StepRoles.cs` (remove `Intermediate`; doc rewritten for edges)
- Test: `src/tests/BaseApi.Tests/Projection/L2KeyLayoutTests.cs`, `src/tests/BaseApi.Tests/Orchestrator/StepRolesContractTests.cs`

**Interfaces:**
- Consumes: Task 1 (nothing in `Orchestrator` references the resolver).
- Produces: `StepRoles { Key = "StepRole", Entry = "entry", Terminal = "terminal", Scope(string) }` and nothing else role-related in `src/`.

- [ ] **Step 1: Update the contract tests (RED)**

`StepRolesContractTests.cs`:

```csharp
    [Fact]
    public void TheKeyAndValuesAreFixed()
    {
        Assert.Equal("StepRole", StepRoles.Key);
        Assert.Equal(["entry", "terminal"], new[] { StepRoles.Entry, StepRoles.Terminal });
    }

    [Fact]
    public void ThereAreExactlyTwoRoles()
    {
        // The run's two edges. A third value would put a graph role back on every step.
        var values = typeof(StepRoles).GetFields()
            .Where(f => f.IsLiteral && f.Name != nameof(StepRoles.Key))
            .Select(f => (string)f.GetRawConstantValue()!);
        Assert.Equal(["entry", "terminal"], values.Order());
    }
```

(keep `AScopeCarriesExactlyTheRole` and `TheOutcomeTemplatesAreTheHandlersTwoPerOutcomeLines` as they are). In `L2KeyLayoutTests.cs` delete `AStepRoleKeyNestsUnderItsWorkflow`.

- [ ] **Step 2: Delete and edit the sources**

Delete the seven files listed. In `L2ProjectionWriter.cs` remove the `foreach (var (stepId, role) in StepRoleClassifier.Classify(...))` block and its comment; in `FindRemovedStepsAsync` remove the `Guid workflowId` parameter, the `roleKeys` variable and its comment, and the `.Concat(roleKeys)`, so it returns
`dropped.Where(id => !existing.Contains(id)).Select(id => (RedisKey)L2ProjectionKeys.StepEntity(id));` — and update its call site. Compare against `git show 0688b06:src/BaseApi.Service/Features/Orchestration/Projection/L2ProjectionWriter.cs` (the file before StepRole) to restore it exactly, keeping any unrelated later edits.

In `ConsoleRedisServiceCollectionExtensions.cs` remove:

```csharp
        services.TryAddSingleton<IStepRoleSource, RedisStepRoleSource>();
        services.TryAddSingleton<StepRoleResolver>();
```

In `L2ProjectionKeys.cs` remove `RoleField`, `StepRole(Guid, Guid)` and the `StepRole` summary `<item>`.

`StepRoles.cs`:

```csharp
namespace Messaging.Contracts;

/// <summary>
/// The run's two edges, as stamped on orchestrator records: the log-scope key and its two values.
/// <para>
/// <b>entry</b> is on the scheduler's "dispatched an entry step" record, one per entry step that
/// reached a queue (a fire with two entry steps writes two). <b>terminal</b> is on the branch-ends
/// record of a step with no successors in the workflow's graph, whatever its result. No other record
/// carries the key: steps between the edges are counted by the step-outcomes panel, not here.
/// </para>
/// <para>
/// <b>Decided by the orchestrator from its own L1 graph</b>, with no lookup: entry is hardcoded on the
/// dispatch line, terminal is <c>NextStepIds</c> empty on the step the outcome handler already holds.
/// A step shared by two workflows is classified per workflow.
/// </para>
/// <para>
/// <b>Here in the contracts assembly because the readers do not share a compiler with the emitter</b>
/// -- the Kibana dashboard and the Analyst select on these strings.
/// </para>
/// </summary>
public static class StepRoles
{
    public const string Key = "StepRole";

    public const string Entry = "entry";

    public const string Terminal = "terminal";

    public static IReadOnlyDictionary<string, object> Scope(string role)
        => new Dictionary<string, object>(1) { [Key] = role };
}
```

- [ ] **Step 3: Repack, build, grep, test**

```bash
bash scripts/pack-all.sh
cd src && dotnet build tests/BaseApi.Tests/BaseApi.Tests.csproj --no-restore -v q
cd /c/Users/UserL/source/repos/SK_P9 && grep -rn "StepRoleResolver\|IStepRoleSource\|RedisStepRoleSource\|StepRoleClassifier\|FakeStepRoleSource\|L2ProjectionKeys.StepRole\|RoleField\|StepRoles.Intermediate" src --include=*.cs | grep -v "/obj/\|/bin/"
cd src/tests/BaseApi.Tests && ./bin/Debug/net8.0/BaseApi.Tests.exe
```

Expected: the grep prints nothing; 0 failed, skips only in `Live/`.

- [ ] **Step 4: Commit**

```bash
git add -A src/BaseApi.Service src/BaseConsole.Core src/Messaging.Contracts src/tests/BaseApi.Tests src/*/nugets src/*/packages.lock.json nugets
git commit -m "refactor(step-role): remove role keys, the resolver and intermediate -- the orchestrator decides both edges"
```

(Stage only what `git status` shows this task changed; the repack touches lock files and nupkgs.)

---

### Task 3: Kibana — the edges pie, its checker and its doc

**Files:**
- Modify: `kibana/kibana-export.ndjson` (object `skp-runposition-pie`; edit with a Python script written to the scratchpad and run, preserving the file's serialization style)
- Modify: `tools/verify-kibana-dashboard.py` (`FUNNEL_*` constants → `EDGES_*`, check 14, the step-role selector comments)
- Modify: `docs/testing/kibana-panels-through-the-graph.md` (§3.3)

**Interfaces:**
- Consumes: `StepRoles` strings (`StepRole`, `entry`, `terminal`).
- Produces: the Lens object titled `Run edges — entry dispatches and terminal outcomes`, id unchanged (`skp-runposition-pie`), query `EDGES_ESQL` below, groups `attributes.StepRole` then `attributes.StepName`, metric `records`.

- [ ] **Step 1: Update the checker (RED)**

In `tools/verify-kibana-dashboard.py` replace `FUNNEL_TITLE`, `FUNNEL_ESQL` and check 14's metric expectation:

```python
EDGES_TITLE = "Run edges — entry dispatches and terminal outcomes"

# The run's two edges for the fires that entered in range: each entry-step dispatch (entry) and each
# outcome of a step with no successors (terminal), by role and step name. Only those two kinds of
# record carry attributes.StepRole, so the WHERE alone keeps every other atom out; INLINE STATS keeps
# only fires with an entry record in range, so a fire that began before the range does not show as
# phantom terminal outcomes. Kept byte-identical to the export so check 14 catches drift.
EDGES_ESQL = (
    "FROM logs-generic.otel-default\n"
    "| WHERE attributes.StepRole IS NOT NULL\n"
    "| EVAL entered = CASE(attributes.StepRole == \"entry\", 1, 0)\n"
    "| INLINE STATS fire_entered = MAX(entered) BY attributes.CorrelationId\n"
    "| WHERE fire_entered == 1\n"
    "| STATS records = COUNT(*) BY attributes.StepRole, attributes.StepName"
)
```

Rename every use of `FUNNEL_TITLE`/`FUNNEL_ESQL` to `EDGES_TITLE`/`EDGES_ESQL` (PANEL_GUARDS entry for `skp-runposition-pie` included), and in check 14 change `metrics == ["outcomes"]` to `metrics == ["records"]` and its failure message to name the edges object. Rewrite the step-role selector comment (the block above `STEPROLE_KQL`) to: the records carrying a StepRole are exactly the scheduler's dispatch records (entry) and the branch-ends records of steps with no successors (terminal); the dispatch record carries no Result and the orchestrator records are excluded from COUNTED_KQL by name, so without the `attributes.StepRole:*` clause the pie would be empty — keep the existing paragraph's reasoning about COUNTED_KQL guards on the outcome panels.

Run: `python tools/verify-kibana-dashboard.py kibana/kibana-export.ndjson`
Expected: FAIL at check 14 (title / query / metric mismatch).

- [ ] **Step 2: Edit the saved object.** In the Lens object `skp-runposition-pie`: title `EDGES_TITLE`; every copy of the ES|QL (`state.query.esql` and the text-based layer's `query.esql`) = `EDGES_ESQL`; the metric column renamed `outcomes` → `records` in the layer's columns and in the visualization's `metrics`; groups unchanged (`attributes.StepRole`, `attributes.StepName`); remove any colour assignment for `intermediate`. Description:

"Where does the work enter and leave? For the fires that ENTERED in the selected range: inner ring entry (one record per entry-step dispatch) and terminal (one per outcome of a step with no successors, whatever its result); outer ring the step. Entry far above terminal is work that left the path between the edges (failures routed elsewhere, cancellations) or is still running -- the Step outcomes panels show where. With every poll drained, entry with no terminal is a quiet window, not a stall. The Step and Outcome dashboard controls do NOT apply to this panel: they filter out the dispatch record, which carries no Result and belongs to the entry step only, so they empty or skew the pie. The workflow control scopes it."

Run the checker: Expected PASS (`0 check(s) failed`).

- [ ] **Step 3: Doc.** Replace §3.3 of `docs/testing/kibana-panels-through-the-graph.md` with the edges panel: what each ring counts (entry = dispatches, one per entry step per fire; terminal = outcomes of steps with no successors, any result), that the middle of the graph is not on this panel, the Step/Outcome control caveat, and that verified numbers come from the `endless-feed-edges` capture (Task 5). Remove the funnel's per-step example numbers.

- [ ] **Step 4: Commit**

```bash
git add kibana/kibana-export.ndjson tools/verify-kibana-dashboard.py docs/testing/kibana-panels-through-the-graph.md
git commit -m "feat(kibana): the run-edges pie -- entry dispatches and terminal outcomes by step"
```

---

### Task 4: Analyst — the edges panel, primer, prompt v12, rehearsal and replay

**Files:**
- Modify: `src/Processor.Analyst/Panels/PanelRegistry.cs` (run-boundaries definition, its comment, `WithOutcomeTemplates` → `WithStepRoles`)
- Modify: `src/Processor.Analyst/Panels/ElasticPanelSource.cs` (`BuildFunnel` → `BuildEdges`)
- Modify: `src/Processor.Analyst/ContractPrompt.cs` (run-boundaries primer bullet)
- Modify: `src/Processor.Analyst/Bit/RehearsalPanels.cs:55-56`
- Create: `tools/analyst-prompt-v12.txt`
- Modify fixtures: `src/tests/BaseApi.Tests/Analyst/Fixtures/esql-fires.json`, `esql-fires-no-records.json`, `esql-funnel-healthy.json` → `esql-edges-healthy.json`, `esql-funnel-stalled.json` → `esql-edges-stalled.json`, `esql-funnel-partial.json` → `esql-edges-partial.json`, `esql-polls.json`
- Modify tests: `src/tests/BaseApi.Tests/Analyst/PanelTrustTests.cs`, `PanelRegistryTests.cs`, `PromptStructureTests.cs`, `src/tests/BaseApi.Tests/Live/AnalystReplayScenarios.cs`, `src/tests/BaseApi.Tests/Live/AnalystGroundTruthLiveTests.cs`

**Interfaces:**
- Consumes: `StepRoles.Key`, `StepRoles.Entry` (Task 2).
- Produces: panel `run-boundaries` with `ValueJson`
  `{"totalWorkflowRecords":N,"fires":N,"importerPolls":N,"pollsThatImported":N,"drainedPolls":N,"recordsImported":N,"byStep":[{"role":"entry","step":"…","records":N},{"role":"terminal","step":"…","records":N}]}`; `SampleCount` = sum of `records`.

- [ ] **Step 1: Fixtures**

`esql-fires.json`:
```json
{"columns":[{"name":"totalWorkflowRecords","type":"long"},{"name":"fires","type":"long"},{"name":"earliest","type":"date"}],"values":[[6213,15,"2026-10-01T19:08:00.408Z"]]}
```
`esql-fires-no-records.json`:
```json
{"columns":[{"name":"totalWorkflowRecords","type":"long"},{"name":"fires","type":"long"},{"name":"earliest","type":"date"}],"values":[[0,0,null]]}
```
`esql-edges-healthy.json`:
```json
{"columns":[{"name":"records","type":"long"},{"name":"attributes.StepRole","type":"keyword"},{"name":"attributes.StepName","type":"keyword"}],
 "values":[[75,"terminal","export-outcome"],[75,"terminal","record-outcome"],[15,"entry","split-importer"]]}
```
`esql-edges-stalled.json`:
```json
{"columns":[{"name":"records","type":"long"},{"name":"attributes.StepRole","type":"keyword"},{"name":"attributes.StepName","type":"keyword"}],
 "values":[[15,"entry","split-importer"]]}
```
`esql-edges-partial.json`: the current partial fixture with `outcomes` renamed `records`.
`esql-polls.json`:
```json
{"columns":[{"name":"importerPolls","type":"long"},{"name":"drainedPolls","type":"long"},{"name":"recordsImported","type":"long"}],"values":[[15,0,125]]}
```

- [ ] **Step 2: Rewrite the run-boundaries tests (RED)**

In `PanelTrustTests.cs` update every run-boundaries test to the renamed fixtures and the `records` field, delete `RecordsPresentButNoStepRoleIsNotATrustedNothingFired`, change the inline JSON in `AWindowWithNoWorkflowRecordsAtAllIsIndistinguishableFromNothingReported` and `NoFireInTheWindowReadsZeroAndIsNotFullyCovered` to the three-column fires shape (no `roleRecords`), the edges column `records`, and the polls shape with `recordsImported` (`[[0,null,null]]`). Replace `TheFunnelCarriesEveryStepWithItsRole` with:

```csharp
    [Fact]
    public async Task TheEdgesCarryEntryAndEveryTerminalStep()
    {
        var reading = await ElasticSource(Fixture("esql-fires.json"), Fixture("esql-edges-healthy.json"), Fixture("esql-polls.json"))
            .ReadAsync(RunBoundaries, W, Range, CancellationToken.None);

        using var value = JsonDocument.Parse(reading.ValueJson);
        var root = value.RootElement;
        Assert.Equal(15, root.GetProperty("fires").GetInt64());
        Assert.Equal(125, root.GetProperty("recordsImported").GetInt64());
        var rows = root.GetProperty("byStep").EnumerateArray().ToList();
        Assert.Equal(3, rows.Count);
        Assert.Equal(15, rows.Single(r => r.GetProperty("role").GetString() == "entry").GetProperty("records").GetInt64());
        Assert.Equal(150, rows.Where(r => r.GetProperty("role").GetString() == "terminal").Sum(r => r.GetProperty("records").GetInt64()));
        Assert.False(root.TryGetProperty("roleRecords", out _));
        Assert.Equal(165, reading.SampleCount);
        Assert.True(reading.Trust.WindowFullyCovered);
        Assert.True(reading.Trust.NoDataDistinguishable);
    }

    [Fact]
    public async Task ADrainedWindowCarriesNothingImported()
    {
        // Every poll empty: entry records, no terminal, nothing imported. The panel must carry
        // recordsImported 0 so the reading is a quiet window, not a stall.
        const string drained =
            """{"columns":[{"name":"importerPolls","type":"long"},{"name":"drainedPolls","type":"long"},{"name":"recordsImported","type":"long"}],"values":[[15,15,0]]}""";

        var reading = await ElasticSource(Fixture("esql-fires.json"), Fixture("esql-edges-stalled.json"), drained)
            .ReadAsync(RunBoundaries, W, Range, CancellationToken.None);

        using var value = JsonDocument.Parse(reading.ValueJson);
        Assert.Equal(0, value.RootElement.GetProperty("recordsImported").GetInt64());
        Assert.Equal(0, value.RootElement.GetProperty("pollsThatImported").GetInt64());
        Assert.True(reading.Trust.NoDataDistinguishable);
    }

    [Fact]
    public async Task TwoEntryStepsAreTwoEntryRowsButOneFire()
    {
        const string twoEntries =
            """{"columns":[{"name":"records","type":"long"},{"name":"attributes.StepRole","type":"keyword"},{"name":"attributes.StepName","type":"keyword"}],"values":[[15,"entry","importer-a"],[15,"entry","importer-b"]]}""";

        var reading = await ElasticSource(Fixture("esql-fires.json"), twoEntries, Fixture("esql-polls.json"))
            .ReadAsync(RunBoundaries, W, Range, CancellationToken.None);

        using var value = JsonDocument.Parse(reading.ValueJson);
        Assert.Equal(15, value.RootElement.GetProperty("fires").GetInt64());
        Assert.Equal(2, value.RootElement.GetProperty("byStep").GetArrayLength());
    }
```

`AStalledWindowIsATrustedEntryOnlyFunnel` → rename `AStalledWindowIsATrustedEntryOnlyReading`, using `esql-edges-stalled.json`; same assertions. In `PanelRegistryTests.cs` update the run-boundaries pin: statement 1 has `totalWorkflowRecords`, `fires`, `earliest` and no `roleRecords`; statement 2 has no `{OriginalFormat}` filter and counts `records`; statement 3 has `recordsImported = SUM(attributes.Consumed)`; `Assert.DoesNotContain("$", query)` stays.

Run: `cd src && dotnet build tests/BaseApi.Tests/BaseApi.Tests.csproj --no-restore -v q && cd tests/BaseApi.Tests && ./bin/Debug/net8.0/BaseApi.Tests.exe --filter-namespace "BaseApi.Tests.Analyst"`
Expected: FAIL (reading still has `roleRecords`, column `outcomes`, no `recordsImported`).

- [ ] **Step 3: Implement the panel**

`PanelRegistry.cs` — the run-boundaries `Query` (via `WithStepRoles`, which replaces `$ROLE$` with `StepRoles.Key` and `$ENTRY$` with `StepRoles.Entry`; delete `WithOutcomeTemplates`):

```
FROM logs-generic.otel-default
| WHERE @timestamp >= "{{FROM}}" AND @timestamp <= "{{TO}}" AND attributes.WorkflowId == "{{WORKFLOW}}"
| STATS totalWorkflowRecords = COUNT(*), fires = COUNT_DISTINCT(attributes.CorrelationId) WHERE attributes.$ROLE$ == "$ENTRY$", earliest = MIN(@timestamp) WHERE attributes.$ROLE$ == "$ENTRY$"
---
FROM logs-generic.otel-default
| WHERE @timestamp >= "{{FROM}}" AND @timestamp <= "{{TO}}" AND attributes.WorkflowId == "{{WORKFLOW}}" AND attributes.$ROLE$ IS NOT NULL
| EVAL entered = CASE(attributes.$ROLE$ == "$ENTRY$", 1, 0)
| INLINE STATS fire_entered = MAX(entered) BY attributes.CorrelationId
| WHERE fire_entered == 1
| STATS records = COUNT(*) BY attributes.$ROLE$, attributes.StepName
| SORT records DESC
---
FROM logs-generic.otel-default
| WHERE @timestamp >= "{{FROM}}" AND @timestamp <= "{{TO}}" AND attributes.WorkflowId == "{{WORKFLOW}}" AND attributes.`{OriginalFormat}` == "consumed {Consumed}/{Requested} records; stopped because {Reason}"
| STATS importerPolls = COUNT(*), drainedPolls = SUM(CASE(attributes.Consumed == 0, 1, 0)), recordsImported = SUM(attributes.Consumed)
```

Description:

"The workflow's two edges for the fires that entered in this window. entry rows count dispatches: one per entry step each time a fire sent it work (with one entry step, entry equals fires). terminal rows count the outcomes returned by steps with no successors, by step, whatever their result. Nothing between the edges is on this panel: work that entered and did not reach a terminal step was routed elsewhere on failure, cancelled, or is still running -- step-outcomes and step-failures show which. recordsImported is how many items the importer took in; pollsThatImported and drainedPolls split its polls. Entry with no terminal and recordsImported 0 is a quiet window (every poll drained), not a stall; entry with no terminal while items were imported is a stall. totalWorkflowRecords is every record the workflow logged in the window; at zero nothing was reported at all, which cannot be told apart from logging that is not reaching the store."

Rewrite the comment above the definition: the agent's counterpart to the board's run-edges pie; both count the StepRole records (entry dispatches, terminal outcomes) of fires whose entry record falls in the range.

`ElasticPanelSource.cs` — rename `BuildFunnel` → `BuildEdges` (and its dispatch at `"run-boundaries" =>`), `FunnelRow` → `EdgeRow(string Role, string Step, long Records)`; read `totalWorkflowRecords`, `fires`, `earliest` from table 0 (no `roleRecords`), rows `attributes.StepRole`/`attributes.StepName`/`records` from table 1, `importerPolls`/`drainedPolls`/`recordsImported` from table 2 (`recordsImported` null → 0, as `drainedPolls` is handled); serialize

```csharp
        var valueJson = JsonSerializer.Serialize(new
        {
            totalWorkflowRecords,
            fires,
            importerPolls,
            pollsThatImported = importerPolls - drainedPolls,
            drainedPolls,
            recordsImported,
            byStep = edges.Select(r => new { role = r.Role, step = r.Step, records = r.Records }),
        });
```

Trust: `totalWorkflowRecords == 0` → all three false (unchanged); otherwise `new PanelTrust(SeriesPresent: true, WindowFullyCovered: covered, NoDataDistinguishable: true)`; `SampleCount: checked((int)edges.Sum(r => r.Records))`. Delete the `rolesWritten` logic and its comment. Keep the `is_partial` refusal and by-name parsing unchanged.

- [ ] **Step 4: Run the panel tests** — same command as Step 2. Expected: PASS.

- [ ] **Step 5: Primer, rehearsal, prompt v12**

`ContractPrompt.cs` — replace the run-boundaries bullet (starts `- run-boundaries is the workflow's funnel`) with:

```
        - run-boundaries is the workflow's two edges for the fires that entered in the window. entry
          rows count dispatches, one per entry step each time a fire sent it work; terminal rows
          count the outcomes of steps with no successors, by step, whatever the result. Nothing
          between the edges is here: set the items the importer took in (recordsImported) against
          what the routing should deliver to the terminal steps; the difference left the path as
          failures routed elsewhere, cancellations, or work still running at the window's end.
          Entry with no terminal while items were imported is a stall; with recordsImported 0 it is
          a quiet window.
```

`RehearsalPanels.cs`:

```csharp
            ["run-boundaries"] = Clean("run-boundaries", "business",
                """{"totalWorkflowRecords":240,"fires":30,"importerPolls":30,"pollsThatImported":0,"drainedPolls":30,"recordsImported":0,"byStep":[{"role":"entry","step":"importer","records":30}]}""", 30),
```

`tools/analyst-prompt-v12.txt` — copy `tools/analyst-prompt-v11.txt`, then:
- hypothesis 1: replace "run-boundaries showed the steps after entry returning outcomes" with "run-boundaries showed terminal steps returning outcomes";
- hypothesis 3: "3. THE WORK STALLS PARTWAY THROUGH. Killed if run-boundaries shows the terminal steps returning outcomes in numbers the routing accounts for, given the items the importer took in (recordsImported) and the failures and cancellations on step-outcomes.";
- the stage-4 run-boundaries bullet: the primer bullet's sentences above, as one line;
- no other change.

`PromptStructureTests.EachPublishedPromptHasAllFiveStages`: add `[InlineData("analyst-prompt-v12.txt")]`.

- [ ] **Step 6: Replay and ground truth**

`AnalystReplayScenarios.cs`:
- `private const string Window = "endless-feed-edges";` (captured in Task 5; the scenarios skip until its `run-boundaries.json` exists — `SkipUnlessCaptureHasAFunnel` already checks that file; rename it `SkipUnlessCaptureHasEdges`, message "the captured window predates the edges model; recapture it after deployment (plan Task 5)").
- default prompt `tools/analyst-prompt-v12.txt`.
- `LosingWork()`: replace the funnel loop with one that lowers the `export-outcome` terminal row (step name `StartsWith("export-outcome", StringComparison.Ordinal)`) by `lost / 2`, assert the row was found (`Assert.True(found, "the capture has no export-outcome terminal row")`), drop the `roleRecords` line, and compute `funnelSamples` from `records`.
- `StalledAfterTheFirstHop()`: build the reading from the capture's entry row only:

```csharp
        var reader = BusyAndHealthy();
        var captured = JsonNode.Parse(reader.ValueOf("run-boundaries"))!;
        var entry = captured["byStep"]!.AsArray().Single(r => (string)r!["role"]! == "entry")!;
        var dispatched = (int)entry["records"]!;
        var total = (int)captured["totalWorkflowRecords"]!;

        var edges = new JsonObject
        {
            ["totalWorkflowRecords"] = total,
            ["fires"] = (int)captured["fires"]!,
            ["importerPolls"] = (int)captured["importerPolls"]!,
            ["pollsThatImported"] = (int)captured["pollsThatImported"]!,
            ["drainedPolls"] = (int)captured["drainedPolls"]!,
            ["recordsImported"] = (int)captured["recordsImported"]!,
            ["byStep"] = new JsonArray(new JsonObject
            {
                ["role"] = "entry",
                ["step"] = (string)entry["step"]!,
                ["records"] = dispatched,
            }),
        };
```

and plant `run-boundaries` = `edges` (samples `dispatched`), `refused-messages` with `totalWorkflowRecords` = `total` (replacing the hard-coded 1874 in both places); keep the step-outcomes / step-failures plants, using the capture's split-importer Completed count from `step-outcomes` if the plant needs an entered-item count (read it from the capture; do not hard-code).
- Update the XML docs of both plants to the edges wording.

`AnalystGroundTruthLiveTests.cs` quiet window:

```csharp
        .Reading("run-boundaries", "business",
            """{"totalWorkflowRecords":240,"fires":30,"importerPolls":30,"pollsThatImported":0,"drainedPolls":30,"recordsImported":0,"byStep":[{"role":"entry","step":"importer","records":30}]}""",
            samples: 30)
```

Delete the `endless-feed-steprole` capture directory only after Task 5 has captured `endless-feed-edges` — not in this task.

- [ ] **Step 7: Full suite and grep**

```bash
cd src && dotnet build tests/BaseApi.Tests/BaseApi.Tests.csproj --no-restore -v q
cd tests/BaseApi.Tests && ./bin/Debug/net8.0/BaseApi.Tests.exe
cd /c/Users/UserL/source/repos/SK_P9 && grep -rn "roleRecords\|intermediate\|WithOutcomeTemplates\|BuildFunnel" src/Processor.Analyst src/tests/BaseApi.Tests --include=*.cs --include=*.json | grep -v "/obj/\|/bin/\|Fixtures/replay/endless-feed-steprole\|Fixtures/replay/busy-mixed-feed"
```

Expected: 0 failed, skips only in `Live/`; the grep prints nothing.

- [ ] **Step 8: Commit**

```bash
git add -A src/Processor.Analyst src/tests/BaseApi.Tests tools/analyst-prompt-v12.txt
git commit -m "feat(analyst): run-boundaries reads the run's edges; primer, rehearsal and prompt v12"
```

---

### Task 5: Deploy to dev, clean the old keys, recapture, document

**Files:**
- Create: `src/tests/BaseApi.Tests/Analyst/Fixtures/replay/endless-feed-edges/*`
- Delete: `src/tests/BaseApi.Tests/Analyst/Fixtures/replay/endless-feed-steprole/` (after the new capture verifies)
- Modify: `docs/rebuild-analyst-monitor-workflow.md` (Analyst SourceHash, prompt v12), `docs/offline-steprole-drop.md` (edges model: no role keys, no restart needed for roles, deploy order, key cleanup), `src/tests/BaseApi.Tests/Live/AnalystReplayScenarios.cs` only if the capture's step names differ from what the plants expect

**Interfaces:**
- Consumes: Tasks 1-4.
- Produces: dev running the edges build; a verified capture.

- [ ] **Step 1: Ask the user before changing dev.** Say: "Task 5 rebuilds and rolls out baseapi, the orchestrator and the Analyst on dev, repoints the Analyst's SourceHash, PUTs prompt v12 into analyst-monitor-cfg, deletes the ten stale `skp:wf:*:step:*` role keys from Redis, imports Kibana, runs the endless feed and recaptures the replay window. analyst-monitor stays stopped. OK?" Stop until they agree.

- [ ] **Step 2: Build, load, repoint, roll.** For `BaseApi.Service:baseapi-service`, `Orchestrator:orchestrator`, `Processor.Analyst:processor-analyst`: `docker build -q -f src/<proj>/Dockerfile -t <img>:local .` then `kind load docker-image <img>:local --name desktop` (the cluster is kind `desktop` whatever the kube context says). Read the Analyst's SourceHash from a local build (pwsh):

```powershell
dotnet build src/Processor.Analyst/Processor.Analyst.csproj
$asm  = [Reflection.Assembly]::LoadFrom((Resolve-Path "src/Processor.Analyst/bin/Debug/net8.0/Processor.Analyst.dll"))
$hash = ($asm.GetCustomAttributes([Reflection.AssemblyMetadataAttribute], $false) | Where-Object { $_.Key -eq 'SourceHash' }).Value
kubectl -n skp exec postgres-0 -- psql -U postgres -d stepsdb -c "UPDATE processors SET source_hash='$hash', updated_at=now() AT TIME ZONE 'utc' WHERE name='analyst';"
```

Expect `UPDATE 1`. Then `kubectl -n skp rollout restart deploy/baseapi-service sts/orchestrator deploy/processor-analyst` and `rollout status` each. Verify each pod's image against `docker exec desktop-control-plane crictl images | grep <img>`.

- [ ] **Step 3: Prompt v12.** GET the `analyst-monitor-cfg` assignment, resend every field with the prompt replaced by `tools/analyst-prompt-v12.txt` (see `docs/rebuild-analyst-monitor-workflow.md` §6.1 for the shape; a partial PUT wipes fields). `analyst-monitor` stays stopped.

- [ ] **Step 4: Remove the stale role keys.** List first, then delete exactly the listed keys:

```bash
kubectl -n skp exec redis-0 -- redis-cli --scan --pattern 'skp:wf:*:step:*'
kubectl -n skp exec redis-0 -- sh -c "redis-cli --scan --pattern 'skp:wf:*:step:*' | xargs -r redis-cli DEL"
kubectl -n skp exec redis-0 -- redis-cli --scan --pattern 'skp:wf:*:step:*'
```

Expected: ten keys listed, `(integer) 10`, then nothing. If the list holds anything other than `skp:wf:<guid>:step:<guid>` keys, stop and report.

- [ ] **Step 5: Kibana.** `python tools/offline/pin-workflow-control.py --workflow filefetcher-archiveexpander-chain_1.0.0` (expect no diff), then `curl -s -X POST 'http://localhost:15601/api/saved_objects/_import?overwrite=true' -H 'kbn-xsrf: true' --form file=@kibana/kibana-export.ndjson` — every object overwritten.

- [ ] **Step 6: Verify the edges on the first fire.** Query ES|QL for the workflow's orchestrator records since the rollout, grouped by template and StepRole: `dispatched an entry step` → `entry`; the branch-ends record of export-outcome / record-outcome → `terminal`; every other template → no StepRole.

- [ ] **Step 7: Feed and answer key.** Write down the expected edge counts for 30 cycles before reading anything (entry = one per fire that dispatched; terminal per terminal step from the feed composition and the graph), run `python -u tools/simulate-endless-feed.py --start-serial 232 --cycles 30` from PowerShell (the previous run used serials 202-231; if 232 is already taken, use the next free one and say so), wait for the importer lag to drain, run the Task 4 statements for the window, compare. A mismatch is investigated and reported, never fitted.

- [ ] **Step 8: Capture** `endless-feed-edges` (`SKP_ANALYST_CAPTURE=1 SKP_CAPTURE_NAME=endless-feed-edges SKP_CAPTURE_FROM=… SKP_CAPTURE_TO=…` with `--filter-method "*CaptureAWindow"`), write `window.json`'s answer key (stating which figures were predicted before reading and which were corroborated after), copy `running-graph.json` the way the previous capture did, delete `endless-feed-steprole/`, run the hermetic suite (0 failed) and confirm the replay scenarios now skip only for `SKP_ANALYST_REPLAY`. Do not run the replay.

- [ ] **Step 9: Docs.** Runbook: new Analyst SourceHash, prompt v12. Offline note: the edges model; BaseApi writes no role keys (deploy order no longer matters for roles; no workflow restart needed for StepRole); the one-time key cleanup command from Step 4; the edges pie and panel meaning.

- [ ] **Step 10: Commit**

```bash
git add -A src/tests/BaseApi.Tests/Analyst/Fixtures/replay src/tests/BaseApi.Tests/Live docs/rebuild-analyst-monitor-workflow.md docs/offline-steprole-drop.md
git commit -m "test(analyst-replay): capture an edges window; runbook and offline note for the edges model"
```
