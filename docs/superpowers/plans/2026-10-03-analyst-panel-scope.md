# The Analyst reads each panel's scope -- implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the Analyst reporting window-edge residue as lost work. It must know what each panel counts, reason across those scopes, and be rehearsed on a window whose edges do not cancel.

**Architecture:** No panel query changes. Each panel description gains a fixed-form `Scope:` sentence. The compiled primer (`ContractPrompt.FrameworkPrimer`) gains an edge-residue rule and a persistence rule for uncorroborated gaps. The rehearsal fixture (`RehearsalPanels`) shows production's panel descriptions, separates fires that entered in a range (closed) from records stamped in it, serves consistent history for the three count panels, and gains an `EdgeSkewed` scenario. `GroundTruthRehearsal` runs that scenario second and fails any finding on it. Three Kibana descriptions get the same caveat, text only.

**Tech Stack:** .NET 8, xUnit v3 on Microsoft.Testing.Platform, ES|QL / Elasticsearch 9.3.4, Kibana saved-objects API, kind cluster `desktop`, Kimi `kimi-k3`.

**Spec:** `docs/superpowers/specs/2026-10-03-analyst-panel-scope-design.md`

## Global Constraints

- **No panel `Query` changes** in `PanelRegistry`. Descriptions only.
- **Kibana: description text only.** No query, visualization or data-view change. Import with `POST http://127.0.0.1:15601/api/saved_objects/_import?overwrite=true` and header `kbn-xsrf: true`.
- **Rehearsal numbers** (spec §D4): `PreWindowFailures = 1`, `InFlightAtEnd = 2`. Window: validate 34 Completed / 7 Failed, persist 32, record 7. `run-boundaries` terminal: persist-file 32, record-outcome 6. History from the start: 960 imported, record terminal 144, persist terminal 814.
- **Edge-skew grading: any finding fails** (as in the quiet rehearsal). Order: quiet, edge-skew, loss, bad input.
- **Uncorroborated** means no dead-letter growth, no parked refusals, and no failure cause naming infrastructure. The loss rehearsal's in-window loss must still grade as deterministic / system.
- **Test runs:** `--filter` is ignored under MTP. To run one class:
  `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -nologo -v q` then
  `& src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "<FQN>"`.
  The full suite: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj` must end `Failed: 0`.
- **Paid steps need the user's go-ahead in this session**: the live BIT fire (Task 7) and the replays (Task 8). `analyst-monitor` stays stopped apart from a fire.
- The cluster is kind `desktop` (`kind load docker-image ... --name desktop`). Never docker compose. Every Analyst source edit moves the SourceHash: rebuild, load, repoint the `analyst` row, roll out.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A history read that is not from the start**, for example one hour back. Counts must still obey the routing, and the start residue must still apply. Pinned in Task 4: `AHistoryReadAnHourBackKeepsTheRoutingAndTheStartResidue`.
2. **Two panels with the same scope must agree.** `step-failures.failedCount` must equal `failure-causes`' failed total in every scenario, window and history. Pinned in Task 4: `StepFailuresAndFailureCausesAgreeOnFailures`.
3. **The edge window must stay within its declared expectation.** 7/40 = 0.175 <= 0.2, or a correct prompt would be right to report it. Pinned in Task 4: `TheEdgeWindowServesASharesItsDeclaredExpectationAllows`.
4. **The loss scenario's history** must keep the 17 lost constant, not scale them. Otherwise a history read would invent a recurring loss. Pinned in Task 4: `AHistoryReadKeepsThePlantedLossConstant`.
5. **An unknown panel id** must still be refused by the rehearsal's `Describe` after it starts reading the registry. Pinned in Task 3: `AnUnknownPanelIsStillRefused`.

---

### Task 0: Capture the three live windows as replay fixtures (free, do first)

The 2026-10-03 windows are still in ES and Prometheus. Capturing them now makes Task 8 a real regression check rather than a reconstruction. These are reads only; no model is called.

**Files:**
- Create: `src/tests/BaseApi.Tests/Analyst/Fixtures/replay/edge-skew-2026-10-03/*.json`
- Create: `src/tests/BaseApi.Tests/Analyst/Fixtures/replay/declared-quiet-2026-10-03/*.json`
- Create: `src/tests/BaseApi.Tests/Analyst/Fixtures/replay/undeclared-notable-2026-10-03/*.json`

- [ ] **Step 1: Confirm the forwards answer**

Run: `curl -s http://localhost:19200 -o NUL -w "%{http_code}"; curl -s http://localhost:19090/-/ready`
Expected: `200` and `Prometheus Server is Ready.` If not, run `./tools/dev-up-after-restart.ps1 -NoFeed -NoBrowser`.

- [ ] **Step 2: Build once**

Run: `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -nologo -v q`
Expected: `0 Error(s)`

- [ ] **Step 3: Capture each window (PowerShell)**

```powershell
$windows = @(
  @{ name='declared-quiet-2026-10-03';     from='2026-10-03T14:16:01.1364901Z'; to='2026-10-03T14:31:01.1364901Z' },
  @{ name='undeclared-notable-2026-10-03'; from='2026-10-03T14:26:00.0670673Z'; to='2026-10-03T14:41:00.0670673Z' },
  @{ name='edge-skew-2026-10-03';          from='2026-10-03T14:58:00.0393158Z'; to='2026-10-03T15:13:00.0393158Z' }
)
foreach ($w in $windows) {
  $env:SKP_ANALYST_CAPTURE='1'; $env:SKP_CAPTURE_NAME=$w.name; $env:SKP_CAPTURE_FROM=$w.from; $env:SKP_CAPTURE_TO=$w.to
  & src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.Live.AnalystReplayCapture"
}
Remove-Item Env:SKP_ANALYST_CAPTURE, Env:SKP_CAPTURE_NAME, Env:SKP_CAPTURE_FROM, Env:SKP_CAPTURE_TO
```

Expected: `passed: 1` three times.

- [ ] **Step 4: Check the captures against what the published findings cited**

```powershell
$d='src/tests/BaseApi.Tests/Analyst/Fixtures/replay'
foreach ($n in 'declared-quiet-2026-10-03','undeclared-notable-2026-10-03','edge-skew-2026-10-03') {
  $o = (Get-Content "$d/$n/step-outcomes.json" | ConvertFrom-Json).valueJson | ConvertFrom-Json
  $r = (Get-Content "$d/$n/run-boundaries.json" | ConvertFrom-Json).valueJson | ConvertFrom-Json
  "$n outcomes=$($o.totalOutcomeRecords)/$($o.completed)/$($o.failed)/$($o.cancelled) imported=$($r.recordsImported) " + (($r.byStep | Where-Object role -eq 'terminal' | ForEach-Object { "$($_.step.Split('_')[0])=$($_.records)" }) -join ' ')
}
```

Expected:
- edge-skew: `1000/940/45/15`, `split-exporter=126 export-outcome=39` (offset 58's evidence).
- undeclared-notable: `780/676/78/26`, imported 130, `split-exporter=48 export-outcome=72` (offset 57).
- declared-quiet: `720/...`, imported 125, `split-exporter=48 export-outcome=72` (offset 56's reason).

A mismatch means late ingest or a wrong window; stop and report it. If `step-outcomes.json` stores the reading under another property name, open one file and read the field holding the value JSON.

- [ ] **Step 5: Commit**

```bash
git add src/tests/BaseApi.Tests/Analyst/Fixtures/replay/edge-skew-2026-10-03 src/tests/BaseApi.Tests/Analyst/Fixtures/replay/declared-quiet-2026-10-03 src/tests/BaseApi.Tests/Analyst/Fixtures/replay/undeclared-notable-2026-10-03
git commit -m "test(analyst-replay): capture the 2026-10-03 declared, undeclared and edge-skewed windows

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 1: Every panel states its scope

**Files:**
- Modify: `src/Processor.Analyst/Panels/PanelRegistry.cs`: the `Description:` of all 11 panels (lines ~117-123, 160-165, 214-230, 241-255, 266-280, 291-302, 316-341, 353-385, 456-470, 496-507)
- Test: `src/tests/BaseApi.Tests/Analyst/PanelRegistryTests.cs`

**Interfaces:**
- Produces: every `PanelDefinition.Description` contains `"Scope: "`. Task 2's primer text refers to "each one's Scope".

- [ ] **Step 1: Write the failing tests** (append to `PanelRegistryTests`)

```csharp
    [Fact]
    public void EveryPanelStatesItsScope()
    {
        // A panel's description goes into the prompt verbatim. Without its scope, the model sets one
        // panel against another as if they counted the same records (offset 58, 2026-10-03).
        Assert.All(PanelRegistry.All, p => Assert.Contains("Scope: ", p.Description, StringComparison.Ordinal));
    }

    [Fact]
    public void TheStampedPanelsSayTheyIncludeFiresFromBeforeTheWindow()
    {
        foreach (var id in new[] { "step-outcomes", "step-failures", "failure-causes" })
        {
            var description = PanelRegistry.All.Single(p => p.PanelId == id).Description;
            Assert.Contains("whatever fire they belong to", description, StringComparison.Ordinal);
        }
    }

    [Fact]
    public void RunBoundariesSaysItDropsTheLastFiresLateTerminalRecords()
    {
        var description = PanelRegistry.All.Single(p => p.PanelId == "run-boundaries").Description;

        Assert.Contains("entered before the window is never counted", description, StringComparison.Ordinal);
        Assert.Contains("later terminal records dropped", description, StringComparison.Ordinal);
        Assert.Contains("not the same population as step-outcomes", description, StringComparison.Ordinal);
    }
```

- [ ] **Step 2: Run them to see them fail**

Run (see Global Constraints): `--filter-class "BaseApi.Tests.Analyst.PanelRegistryTests"`
Expected: 3 failed, `Assert.Contains() Failure: Sub-string not found`.

- [ ] **Step 3: Append the scope sentences**

Append one final string segment to each panel's `Description:` concatenation. Add a trailing space to the previous segment if it lacks one. Keep every existing word, since other tests assert on it.

`step-outcomes` (after `"...carry the monitor workflow's id, not the target workflow's."`):
```csharp
                + " Scope: outcome records of any fire / stamped in the window, whatever fire they belong to / "
                + "so it includes records of fires that entered before the window began, and misses records "
                + "stamped after the window end, even of fires that entered inside it.",
```

`step-failures` (after `"...for this workflow appear."`):
```csharp
                + " Scope: Failed outcome records of any fire, and the window's outcome total / stamped in the "
                + "window, whatever fire they belong to / so a failure of a fire that entered before the window "
                + "is counted here, and one stamped after the window end is not.",
```

`failure-causes` (after `"...a history read uses wider buckets so the range fits."`):
```csharp
                + " Scope: Failed records by cause, and per bucket the items imported, failed and cancelled, "
                + "stamped in the range, whatever fire they belong to / so a bucket's failures can belong to "
                + "items imported in an earlier bucket or before the range began, and the range's last items "
                + "may not have completed or failed yet when it ends.",
```

`run-boundaries` (after `"...logging that is not reaching the store."`):
```csharp
                + " Scope: fires that ENTERED in the window, and their entry and terminal records / a fire is in "
                + "when its entry record is in the window, and each of its records counts only if it too is "
                + "stamped in the window / so a fire that entered before the window is never counted, even "
                + "where its records land inside, and a fire still running at the window end has its later "
                + "terminal records dropped. Its counts are not the same population as step-outcomes, "
                + "step-failures or failure-causes.",
```

`refused-messages` (after `"...but never the stack trace."`):
```csharp
                + " Scope: refusal events for this workflow, of any fire / stamped in the window / an event, so "
                + "a refusal before the window is never here even if its message still sits in a dead-letter "
                + "queue.",
```

`dead-letter-depth` (after `"...can take up to five minutes to appear."`):
```csharp
                + " Scope: queue depth across every workflow / a level sampled every 15 seconds across the "
                + "window / so its first sample already includes anything parked before the window.",
```

`queue-wait`, `produce-duration` and `consumer-duration-mean` (after each one's `"...every expected replica is present."`):
```csharp
                + " Scope: messages of every workflow on each replica / a rate over the trailing 60 seconds, "
                + "evaluated every 15 seconds / so the first minute of the window includes traffic from before it.",
```

`processor-liveness` (after `"...every expected replica is present."`):
```csharp
                + " Scope: each replica's identity / the worst value over the trailing 40 seconds, evaluated "
                + "every 15 seconds / so the first 40 seconds of the window include state from before it.",
```

- [ ] **Step 4: Run the class to see it pass**

Run: `--filter-class "BaseApi.Tests.Analyst.PanelRegistryTests"`
Expected: `failed: 0`.

- [ ] **Step 5: Run the full suite** (descriptions feed prompt snapshot tests, if any)

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj -nologo`
Expected: `Failed: 0`. If a test pins an exact description, update its expected text to include the new sentence; never delete the assertion.

- [ ] **Step 6: Commit**

```bash
git add src/Processor.Analyst/Panels/PanelRegistry.cs src/tests/BaseApi.Tests/Analyst/PanelRegistryTests.cs
git commit -m "feat(analyst): every panel states its scope -- what it counts, how time selects it, its edges

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The primer teaches arithmetic across scopes and persistence for an uncorroborated gap

**Files:**
- Modify: `src/Processor.Analyst/ContractPrompt.cs`: `FrameworkPrimer`, after the `step-outcomes` bullet (line ~96) and in the classification bullets (lines ~104-118)
- Test: `src/tests/BaseApi.Tests/Analyst/RunningGraphTests.cs` (next to `TheContractCarriesTheFrameworkPrimer`, line ~199)

**Interfaces:**
- Consumes: Task 1's `Scope:` sentences (the primer tells the model to read them).
- Produces: the primer phrases `edge residue` and `deterministic only if it recurs`. Task 5's rehearsal judges against them.

- [ ] **Step 1: Write the failing test**

```csharp
    [Fact]
    public void ThePrimerTeachesTheEdgeResidueAndPersistenceForAnUncorroboratedGap()
    {
        var primer = ContractPrompt.FrameworkPrimer;

        Assert.Contains("read each one's Scope", primer, StringComparison.Ordinal);
        Assert.Contains("edge residue", primer, StringComparison.Ordinal);
        Assert.Contains("recordsImported over fires", primer, StringComparison.Ordinal);
        Assert.Contains("is the window's edges, not a finding", primer, StringComparison.Ordinal);
        Assert.Contains("An uncorroborated conservation gap is deterministic only if it recurs", primer, StringComparison.Ordinal);
        // Corroborated loss keeps the existing rule: the loss rehearsal grades it deterministic / system.
        Assert.Contains("dead-letter growth, parked refusals or a failure cause naming infrastructure", primer, StringComparison.Ordinal);
    }
```

- [ ] **Step 2: Run it to see it fail**

Run: `--filter-class "BaseApi.Tests.Analyst.RunningGraphTests"`
Expected: 1 failed.

- [ ] **Step 3: Add the two bullets**

Insert after the bullet ending `"Never attribute a count to a step the panel cannot name."`:

```text
        - Panels count different populations: read each one's Scope. step-outcomes, step-failures and
          failure-causes count records stamped in the window, whatever fire they belong to;
          run-boundaries counts the fires that entered in the window, and only their records stamped in
          it. Setting one against the other leaves an edge residue: the work of fires that entered before
          the window, and the terminal records of fires still running when it ended. The residue is about
          one fire's work at each edge -- estimate it from recordsImported over fires and the routing (an
          item whose path writes two terminal records counts twice). A conservation gap within that
          residue, with nothing corroborating it, is the window's edges, not a finding. A gap beyond it,
          or one corroborated by dead-letter growth, parked refusals or a failure cause naming infrastructure,
          is evidence of loss and is reported.
```

Every phrase the Step 1 test asserts must sit on one line of the raw string. A phrase broken across
lines contains a newline and indentation, and `Contains` fails.

Insert after the bullet ending `"...the investigation is window-only."` (the history bullet):

```text
        - An uncorroborated conservation gap is deterministic only if it recurs: read run-boundaries and
          step-outcomes again with from. An edge residue stays about one fire per edge however long the
          range; a defect in the accounting grows with it. With no history available, such a gap is never
          deterministic.
```

Keep the raw-string indentation identical to the neighbouring bullets (8 spaces, 10 for continuation lines).

- [ ] **Step 4: Run it to see it pass**

Run: `--filter-class "BaseApi.Tests.Analyst.RunningGraphTests"`
Expected: `failed: 0`.

- [ ] **Step 5: Commit**

```bash
git add src/Processor.Analyst/ContractPrompt.cs src/tests/BaseApi.Tests/Analyst/RunningGraphTests.cs
git commit -m "feat(analyst): the primer teaches the edge residue, and persistence for an uncorroborated gap

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The rehearsal shows the model production's panel descriptions

**Files:**
- Modify: `src/Processor.Analyst/Bit/RehearsalPanels.cs:120-123` (`Describe`)
- Test: `src/tests/BaseApi.Tests/Analyst/RehearsalFixtureTests.cs`

**Interfaces:**
- Produces: `RehearsalPanels.Describe(id)` returns `PanelRegistry`'s description and layer. It throws `ArgumentException` for an id outside `PanelIds`.

- [ ] **Step 1: Write the failing tests** (append to `RehearsalFixtureTests`)

```csharp
    public static TheoryData<string> RehearsalPanelIds => new(RehearsalPanels.Quiet().PanelIds);

    [Theory]
    [MemberData(nameof(RehearsalPanelIds))]
    public void EveryRehearsalPanelIsDescribedAsProductionDescribesIt(string panelId)
    {
        // InvestigationLoop builds the tool catalog from Describe. A placeholder here means the BIT
        // never showed the model what a live dispatch reads -- including every panel's Scope.
        var expected = PanelRegistry.All.Single(p => p.PanelId == panelId);
        var described = RehearsalPanels.Quiet().Describe(panelId);

        Assert.Equal(expected.Description, described.Description);
        Assert.Equal(expected.Layer, described.Layer);
    }

    [Fact]
    public void AnUnknownPanelIsStillRefused()
        => Assert.Throws<ArgumentException>(() => RehearsalPanels.Quiet().Describe("gate-open"));
```

- [ ] **Step 2: Run them to see them fail**

Run: `--filter-class "BaseApi.Tests.Analyst.RehearsalFixtureTests"`
Expected: 8 failed (`"rehearsal panel step-outcomes"` vs the registry text). `AnUnknownPanelIsStillRefused` passes already.

- [ ] **Step 3: Replace `Describe`**

```csharp
    public PanelDescriptor Describe(string panelId)
    {
        if (!PanelIds.Contains(panelId))
        {
            throw new ArgumentException($"no rehearsal panel '{panelId}'", nameof(panelId));
        }

        // The description production shows: the BIT judges a prompt on what a live dispatch reads.
        var definition = PanelRegistry.All.Single(p => p.PanelId == panelId);
        return new PanelDescriptor(definition.PanelId, definition.Layer, definition.Description);
    }
```

- [ ] **Step 4: Run the class to see it pass**

Run: `--filter-class "BaseApi.Tests.Analyst.RehearsalFixtureTests"`
Expected: `failed: 0`.

- [ ] **Step 5: Commit**

```bash
git add src/Processor.Analyst/Bit/RehearsalPanels.cs src/tests/BaseApi.Tests/Analyst/RehearsalFixtureTests.cs
git commit -m "fix(analyst-bit): the rehearsal describes each panel as production does, not as a placeholder

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The fixture separates closed fires from stamped records, serves history, and gains EdgeSkewed

**Files:**
- Modify: `src/Processor.Analyst/Bit/RehearsalPanels.cs`: the constructor and `Ledger` (lines ~86-107), `ReadAsync` (~133-144), `Build` (~151-226), `FailureCauses` (~236-279), `RunBoundaries` (~298-319), `TerminalRecords` (~325-338)
- Test: `src/tests/BaseApi.Tests/Analyst/RehearsalFixtureTests.cs`

**Interfaces:**
- Produces:
  - `internal static RehearsalPanels EdgeSkewed()`
  - `internal const int PreWindowFailures = 1;` and `internal const int InFlightAtEnd = 2;`
  - `internal IReadOnlyList<RehearsalStep> ClosedLedger { get; }`: the fires that entered in the window, followed to their end. Routing-walkable.
  - `internal IReadOnlyList<RehearsalStep> Ledger { get; }`: what is stamped in the window. Unchanged meaning for the three existing scenarios, where it equals `ClosedLedger`.
  - History reads of `step-outcomes`, `run-boundaries` and `step-failures` are served from the range.

- [ ] **Step 1: Write the failing tests**

In `RehearsalFixtureTests`, replace `Scenarios` and `Scenario`:

```csharp
    public static TheoryData<string> Scenarios => new() { "quiet", "fault", "edge" };

    private static RehearsalPanels Scenario(string name) => name switch
    {
        "quiet" => RehearsalPanels.Quiet(),
        "edge" => RehearsalPanels.EdgeSkewed(),
        _ => RehearsalPanels.HoldingDiscardedWork(),
    };
```

In `EveryStepEntersExactlyTheItemsTheRoutingSendsIt`, change `panels.Ledger.ToDictionary` to `panels.ClosedLedger.ToDictionary`. The routing holds for whole fires, not for a window that cuts them.

In `RunBoundariesCarriesOnlyTheTwoEdges`, replace `var good = scenario == "quiet" ? 34 : 17;` with:

```csharp
        // persist-file's terminal: the good items, less any lost, less the last fire's items still being
        // persisted when the window closed (their terminal records land after it).
        var good = scenario switch { "quiet" => 34, "edge" => 34 - RehearsalPanels.InFlightAtEnd, _ => 17 };
```

Change `OnlyTheQuietScenarioCarriesExpectations` to:

```csharp
    [Fact]
    public void OnlyTheQuietScenariosCarryExpectations()
    {
        Assert.NotNull(RehearsalPanels.Quiet().Expectations);
        Assert.NotNull(RehearsalPanels.EdgeSkewed().Expectations);
        Assert.Null(RehearsalPanels.RejectingBadInput().Expectations);
        Assert.Null(RehearsalPanels.HoldingDiscardedWork().Expectations);
    }
```

In `WindowOnlyPanels`, remove `"step-outcomes"`, `"run-boundaries"` and `"step-failures"`. Then add:

```csharp
    private static async Task<JsonElement> ValueAsync(IPanelReader reader, string panelId, TimeRange range, bool history)
    {
        var reading = await reader.ReadAsync(panelId, RehearsalGraph.WorkflowId, range, history, CancellationToken.None);
        return JsonDocument.Parse(reading.ValueJson).RootElement;
    }

    private static int Terminal(JsonElement edges, Guid stepId)
        => edges.GetProperty("byStep").EnumerateArray()
            .Where(r => r.GetProperty("role").GetString() == StepRoles.Terminal
                        && r.GetProperty("step").GetString() == RehearsalGraph.Graph.Names[stepId])
            .Sum(r => r.GetProperty("records").GetInt32());

    [Fact]
    public async Task TheEdgeWindowIsShortAtBothExitsWithNothingLost()
    {
        var panels = RehearsalPanels.EdgeSkewed();
        var edges = await ValueAsync(panels, "run-boundaries", Window, history: false);
        var outcomes = await ValueAsync(panels, "step-outcomes", Window, history: false);
        var refused = await ValueAsync(panels, "refused-messages", Window, history: false);

        Assert.Equal(7, outcomes.GetProperty("failed").GetInt32());           // 6 + 1 from a pre-window fire
        Assert.Equal(6, Terminal(edges, RehearsalGraph.RecordStep));          // that fire never entered here
        Assert.Equal(32, Terminal(edges, RehearsalGraph.PersistStep));        // 34 validated, 2 still persisting
        Assert.Equal(40, edges.GetProperty("recordsImported").GetInt32());
        Assert.Equal(0, refused.GetProperty("refusedCount").GetInt32());
    }

    [Fact]
    public async Task AHistoryReadFromTheStartLosesTheStartResidueAndKeepsTheEndOne()
    {
        // The test D3 asks for: an edge residue stays about one fire per edge however long the range.
        var panels = RehearsalPanels.EdgeSkewed();
        var history = new TimeRange(RehearsalGraph.RunFor(To).Start!.Value, To);
        var edges = await ValueAsync(panels, "run-boundaries", history, history: true);
        var outcomes = await ValueAsync(panels, "step-outcomes", history, history: true);

        Assert.Equal(960, edges.GetProperty("recordsImported").GetInt32());
        Assert.Equal(144, outcomes.GetProperty("failed").GetInt32());
        Assert.Equal(144, Terminal(edges, RehearsalGraph.RecordStep));
        Assert.Equal(814, Terminal(edges, RehearsalGraph.PersistStep));
    }

    [Fact]
    public async Task AHistoryReadAnHourBackKeepsTheRoutingAndTheStartResidue()
    {
        var panels = RehearsalPanels.EdgeSkewed();
        var hour = new TimeRange(To.AddHours(-1), To);
        var edges = await ValueAsync(panels, "run-boundaries", hour, history: true);
        var outcomes = await ValueAsync(panels, "step-outcomes", hour, history: true);

        Assert.Equal(160, edges.GetProperty("recordsImported").GetInt32());
        Assert.Equal(24 + RehearsalPanels.PreWindowFailures, outcomes.GetProperty("failed").GetInt32());
        Assert.Equal(24, Terminal(edges, RehearsalGraph.RecordStep));
        Assert.Equal(136 - RehearsalPanels.InFlightAtEnd, Terminal(edges, RehearsalGraph.PersistStep));
    }

    [Fact]
    public async Task AHistoryReadKeepsThePlantedLossConstant()
    {
        // The loss happened in the window. Scaling it would invent a recurring loss.
        var panels = RehearsalPanels.HoldingDiscardedWork();
        var history = new TimeRange(RehearsalGraph.RunFor(To).Start!.Value, To);
        var edges = await ValueAsync(panels, "run-boundaries", history, history: true);

        Assert.Equal(816 - 17, Terminal(edges, RehearsalGraph.PersistStep));
        Assert.Equal(144, Terminal(edges, RehearsalGraph.RecordStep));
    }

    public static TheoryData<string, bool> FailureScopes => new()
    {
        { "quiet", false }, { "fault", false }, { "edge", false },
        { "quiet", true }, { "fault", true }, { "edge", true },
    };

    [Theory]
    [MemberData(nameof(FailureScopes))]
    public async Task StepFailuresAndFailureCausesAgreeOnFailures(string scenario, bool history)
    {
        // Two panels counting one scope must not disagree in a fixture.
        var panels = Scenario(scenario);
        var range = history ? new TimeRange(RehearsalGraph.RunFor(To).Start!.Value, To) : Window;
        var failures = await ValueAsync(panels, "step-failures", range, history);
        var causes = await ValueAsync(panels, "failure-causes", range, history);

        var bucketed = causes.GetProperty("buckets").EnumerateArray().Sum(b => b.GetProperty("failed").GetInt64());
        Assert.Equal(failures.GetProperty("failedCount").GetInt32(), (int)bucketed);
    }

    [Fact]
    public async Task TheEdgeWindowServesASharesItsDeclaredExpectationAllows()
    {
        var panels = RehearsalPanels.EdgeSkewed();
        var causes = await ValueAsync(panels, "failure-causes", Window, history: false);

        Assert.True(causes.GetProperty("failedShare").GetDouble() <= panels.Expectations!.MaxFailedShare!.Value);
    }
```

- [ ] **Step 2: Run them to see them fail to compile**

Run: `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -nologo -v q`
Expected: errors naming `EdgeSkewed`, `ClosedLedger`, `PreWindowFailures`, `InFlightAtEnd`.

- [ ] **Step 3: Implement the slice model in `RehearsalPanels`**

Add the constants and factory beside `HoldingDiscardedWork()`:

```csharp
    /// <summary>Failures of one fire that entered before the window, recorded inside it (edge-skew only).</summary>
    internal const int PreWindowFailures = 1;

    /// <summary>The last fire's good items still being persisted when the window closed (edge-skew only).</summary>
    internal const int InFlightAtEnd = 2;

    /// <summary>
    /// A healthy window whose edges do not cancel. A fire that entered before the window had 1 item
    /// fail and be recorded inside it, so the stamped panels count 7 failures while run-boundaries,
    /// which never sees that fire, has 6 terminal at record-outcome. The last fire's 2 good items were
    /// validated but still being persisted at the end, so persist-file reads 32 terminal against 34
    /// validated. Nothing was lost: no dead-letter growth, no refusal, and the failed share 7/40 is inside
    /// the declared 0.2. A history read from the start loses the start residue and keeps the end one.
    /// </summary>
    internal static RehearsalPanels EdgeSkewed()
        => new(lost: 0, RehearsalGraph.TestFeed, preWindowFailures: PreWindowFailures, inFlight: InFlightAtEnd);
```

Replace the fields, constructor and `Ledger` property (from `private readonly int _lost;` through the `Ledger` property) with:

```csharp
    private readonly int _lost;
    private readonly int _preWindowFailures;
    private readonly int _inFlight;

    private RehearsalPanels(int lost, AnalystExpectations? expectations, int preWindowFailures = 0, int inFlight = 0)
    {
        _lost = lost;
        _preWindowFailures = preWindowFailures;
        _inFlight = inFlight;
        Expectations = expectations;

        var window = SliceOf(WindowLength, startsAfterTheRunBegan: true);
        ClosedLedger = window.Closed;
        Ledger = window.Stamped;
    }

    /// <summary>What the step payload declares as expected for this scenario's source; only the quiet windows declare any.</summary>
    internal AnalystExpectations? Expectations { get; }

    /// <summary>The fires that entered in the window, followed to their end: what the routing explains.</summary>
    internal IReadOnlyList<RehearsalStep> ClosedLedger { get; }

    /// <summary>What every step logged inside the window, whatever fire it belonged to: what the stamped panels count.</summary>
    internal IReadOnlyList<RehearsalStep> Ledger { get; }

    /// <summary>One range's worth of fixture: its fires, polls and imports, the closed fires and the stamped records.</summary>
    private sealed record Slice(
        int Fires, int DrainedPolls, int Imported,
        IReadOnlyList<RehearsalStep> Closed, IReadOnlyList<RehearsalStep> Stamped);

    /// <summary>
    /// The slice for a range. It starts after the run began unless it is a history read from the start,
    /// so only then does a fire from before the range exist to leave a start residue.
    /// </summary>
    private Slice SliceOf(TimeRange range)
        => SliceOf(range.To - range.From, range.From > RehearsalGraph.RunFor(range.To).Start!.Value);

    /// <summary>
    /// The per-window rates scaled to the range. A planted loss stays constant: it happened in the window.
    /// Stamped = closed, plus a pre-range fire's failures (validated and recorded inside), less the last
    /// fire's items still being persisted at the end.
    /// </summary>
    private Slice SliceOf(TimeSpan length, bool startsAfterTheRunBegan)
    {
        var scale = length.TotalMinutes / WindowLength.TotalMinutes;
        int Scaled(int n) => (int)Math.Round(n * scale);

        var imported = Scaled(RecordsImported);
        var rejected = Scaled(RejectedItems);
        var drained = Scaled(DrainedPolls);
        var good = imported - rejected;

        IReadOnlyList<RehearsalStep> closed =
        [
            new(RehearsalGraph.ImportStep, Completed: imported, Failed: 0, Cancelled: drained, Parked: 0),
            new(RehearsalGraph.ValidateStep, Completed: good, Failed: rejected, Cancelled: 0, Parked: 0),
            new(RehearsalGraph.PersistStep, Completed: good - _lost, Failed: 0, Cancelled: 0, Parked: _lost),
            new(RehearsalGraph.RecordStep, Completed: rejected, Failed: 0, Cancelled: 0, Parked: 0),
        ];

        var pre = startsAfterTheRunBegan ? _preWindowFailures : 0;
        IReadOnlyList<RehearsalStep> stamped = closed
            .Select(s => s.StepId == RehearsalGraph.ValidateStep ? s with { Failed = s.Failed + pre }
                : s.StepId == RehearsalGraph.RecordStep ? s with { Completed = s.Completed + pre }
                : s.StepId == RehearsalGraph.PersistStep ? s with { Completed = s.Completed - _inFlight }
                : s)
            .ToList();

        return new Slice(Scaled(Fires), drained, imported, closed, stamped);
    }
```

Replace `ReadAsync`'s body (keep its doc comment, but rewrite the first sentence to: "failure-causes, step-outcomes, run-boundaries and step-failures are served from the range; every other panel answers a history read with the window reading."):

```csharp
        if (!PanelIds.Contains(panelId))
        {
            throw new PanelUnavailableException(panelId, "not part of the rehearsal");
        }

        var servedFromTheRange = panelId is "failure-causes" or "step-outcomes" or "run-boundaries" or "step-failures";
        return history && !servedFromTheRange
            ? Task.FromResult(Build(panelId, new TimeRange(range.To - WindowLength, range.To), history: false))
            : Task.FromResult(Build(panelId, range, history));
```

Replace `Outcomes` and `WorkflowRecords` with:

```csharp
    /// <summary>Every log record of the workflow in the slice, the scope count the Elastic panels report.</summary>
    private int WorkflowRecords(Slice slice) => slice.Stamped.Sum(s => s.Outcomes) * 6 + slice.Fires * 3 + _lost;
```

In `Build`, add `var slice = SliceOf(range);` as its first line. Then:
- `step-outcomes`: use `slice.Stamped` for `completed`, `failed`, `cancelled`, `totalOutcomeRecords`, and `slice.Stamped.Sum(s => s.Outcomes)` as samples.
- `step-failures`: `totalOutcomeRecords = slice.Stamped.Sum(s => s.Outcomes)`, `failedCount = slice.Stamped.Sum(s => s.Failed)`, samples `slice.Stamped.Sum(s => s.Outcomes)`.
- `run-boundaries` => `RunBoundaries(slice)`.
- `failure-causes` => `FailureCauses(range, history, slice)`.
- `refused-messages`: `totalWorkflowRecords = WorkflowRecords(slice)`, samples `WorkflowRecords(slice)`.

In `FailureCauses`, change the signature to `(TimeRange range, bool history, Slice slice)` and replace the three `Allocate(...)` lines with:

```csharp
        var imported = Allocate(slice.Imported, weights);
        var failed = Allocate(slice.Stamped.Sum(s => s.Failed), weights);
        var cancelled = Allocate(slice.Stamped.Sum(s => s.Cancelled), weights);
```

Delete the now-unused `scale` local there. Update the doc comment's "(40 imported, 6 failed, 5 cancelled for the window itself)" to "(the slice's stamped totals)".

Replace `RunBoundaries` and `TerminalRecords`:

```csharp
    private (string Value, int Samples) RunBoundaries(Slice slice)
    {
        var graph = RehearsalGraph.Graph;
        var rows = graph.EntryStepIds
            .Select(id => new { role = StepRoles.Entry, step = graph.Names[id], records = slice.Fires })
            .Concat(graph.Steps
                .Select(s => new { s.StepId, records = TerminalRecords(s, graph.Steps, slice) })
                .Where(t => t.records > 0)
                .Select(t => new { role = StepRoles.Terminal, step = graph.Names[t.StepId], t.records }))
            .ToList();

        return (Serialize(new
        {
            totalWorkflowRecords = WorkflowRecords(slice),
            fires = slice.Fires,
            importerPolls = slice.Fires,
            pollsThatImported = slice.Fires - slice.DrainedPolls,
            drainedPolls = slice.DrainedPolls,
            recordsImported = slice.Imported,
            byStep = rows,
        }), rows.Sum(r => r.records));
    }

    /// <summary>
    /// The orchestrator's terminal rule applied to the CLOSED fires -- run-boundaries never sees a fire
    /// that entered before the range -- less the last fire's terminal records that land after it.
    /// </summary>
    private int TerminalRecords(StepL1 step, IReadOnlyList<StepL1> steps, Slice slice)
    {
        var closed = slice.Closed.Single(l => l.StepId == step.StepId);
        var count = step.NextStepIds.Count == 0
            ? closed.Outcomes
            : step.NextStepIds
                .Select(id => steps.Single(s => s.StepId == id))
                .Any(next => GraphRenderer.Accepts(next.EntryCondition, StepResult.Completed))
                ? 0
                : closed.Completed;

        return step.StepId == RehearsalGraph.PersistStep ? count - _inFlight : count;
    }
```

- [ ] **Step 4: Run the class to see it pass**

Run: `--filter-class "BaseApi.Tests.Analyst.RehearsalFixtureTests"`
Expected: `failed: 0`. The existing quiet and fault numbers (34/17/6, 40 imported, failure-causes buckets) are unchanged.

- [ ] **Step 5: Run the full suite**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj -nologo`
Expected: `Failed: 0`.

- [ ] **Step 6: Commit**

```bash
git add src/Processor.Analyst/Bit/RehearsalPanels.cs src/tests/BaseApi.Tests/Analyst/RehearsalFixtureTests.cs
git commit -m "feat(analyst-bit): closed fires vs stamped records, consistent history, and an edge-skewed window

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The rehearsal runs the edge-skewed window second and fails any finding on it

**Files:**
- Modify: `src/Processor.Analyst/Bit/GroundTruthRehearsal.cs:63-119` (`RunAsync`)
- Test: `src/tests/BaseApi.Tests/Analyst/GroundTruthRehearsalTests.cs`

**Interfaces:**
- Consumes: `RehearsalPanels.EdgeSkewed()`, `PreWindowFailures`, `InFlightAtEnd` (Task 4).
- Produces: a `StageProblem("verify", "contradicting", ...)` whose `Offending` contains `"edges"`.

- [ ] **Step 1: Update existing scripts and write the failing tests**

Every script that gets past the quiet window now needs one more quiet investigation for edge-skew. Insert `.. ConcludesNothing(),` immediately after the quiet window's `.. ConcludesNothing(),` in:
- `APromptThatStaysQuietAndThenReportsBothFaultsPasses`
- `APromptThatStaysQuietOnUndeclaredBadInputFails`
- `ALossReportedAsADataProblemFails`
- `APromptThatMissesThePlantedDeadLetterDepthFails`
- `TheRehearsalIsPaidOncePerPromptPerProcess` (its list becomes `Fit(), Fit(), Fit(), .. ConcludesNothing(), .. ConcludesNothing(), .. ConcludesFinding("system"), .. ConcludesFinding("data")`)

Mark each insertion with the comment `// edge-skewed window: correctly silent`.

Add:

```csharp
    [Fact]
    public async Task AWindowEdgeReportedAsLostWorkFails()
    {
        // offset 58, 2026-10-03: a residue the window's edges explain, paged as a system defect.
        var (bit, _) = Build([
            Fit(), Fit(), Fit(),
            .. ConcludesNothing(),               // quiet window: correct
            .. ConcludesFinding("system"),       // edge-skewed window: a false page
        ]);

        var verdict = await bit.CheckAsync(Structured, CancellationToken.None);

        Assert.False(verdict.Fit);
        var problem = Assert.Single(verdict.Problems);
        Assert.Equal("verify", problem.Stage);
        Assert.Contains("edges", problem.Offending, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AFalsePageOnTheEdgeWindowCostsNoLossRehearsal()
    {
        // Edge-skew runs second: the cheap rejection of the costliest real mistake. Nothing is scripted
        // after it, so a third investigation would exhaust the script and throw.
        var (bit, model) = Build([Fit(), Fit(), Fit(), .. ConcludesNothing(), .. ConcludesFinding("system")]);

        await bit.CheckAsync(Structured, CancellationToken.None);

        Assert.Equal(3 + ConcludesNothing().Length + ConcludesFinding("system").Length, model.Received.Count);
    }
```

- [ ] **Step 2: Run them to see them fail**

Run: `--filter-class "BaseApi.Tests.Analyst.GroundTruthRehearsalTests"`
Expected: failures. The updated scripts now mis-align, since the code has no edge step yet, and the two new tests fail.

- [ ] **Step 3: Add the edge-skew step to `RunAsync`**

Insert immediately after the quiet block's closing `}` (before `var fault = ...`):

```csharp
        var edges = await ConcludesAsync(prompt, RehearsalPanels.EdgeSkewed(), ct).ConfigureAwait(false);

        if (edges is LoopOutcome.Finding paged)
        {
            return [new StageProblem("verify", "contradicting",
                "against a healthy rehearsal window whose edges do not cancel -- a fire that entered before "
                + $"the window had {RehearsalPanels.PreWindowFailures} failure recorded inside it, and the last "
                + $"fire's {RehearsalPanels.InFlightAtEnd} good items were still being persisted when it closed, "
                + "so record-outcome's terminal reads 6 against 7 failures and persist-file's 32 against 34 "
                + "validated, with no dead-letter growth, no refusal and the failed share inside the declared "
                + "expectation -- the prompt still produced a finding: " + Summarise(paged.Value)
                + " -- a gap the window's edges explain is not lost work, and paging it teaches the operator "
                + "to ignore the next one")];
        }
```

Update the pass log message to:

```csharp
        logger.LogInformation(
            "the payload prompt passed its ground-truth rehearsal: quiet and edge-skewed windows silent, "
            + "planted loss and undeclared bad input reported and classified");
```

Then search for any assertion or doc on the old text and update it:
Run: `git grep -n "quiet window silent, planted"`
Expected after the edit: matches only in docs. Update `docs/rebuild-analyst-monitor-workflow.md` if it quotes the line.

- [ ] **Step 4: Run the class to see it pass**

Run: `--filter-class "BaseApi.Tests.Analyst.GroundTruthRehearsalTests"`
Expected: `failed: 0`.

- [ ] **Step 5: Run the full suite**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj -nologo`
Expected: `Failed: 0`.

- [ ] **Step 6: Commit**

```bash
git add src/Processor.Analyst/Bit/GroundTruthRehearsal.cs src/tests/BaseApi.Tests/Analyst/GroundTruthRehearsalTests.cs
git commit -m "feat(analyst-bit): rehearse an edge-skewed window second; any finding on it fails the prompt

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The Kibana descriptions carry the same edge caveat (text only)

**Files:**
- Modify: `kibana/kibana-export.ndjson`: the `attributes.description` of the lens objects titled `Run edges — entry dispatches and terminal outcomes`, `Step outcomes over time` and `Outcome distribution`
- Create (scratch, not committed): `kibana-scope.py` in the session scratchpad

- [ ] **Step 1: Append the caveats with a script** (hand-escaping JSON in an ndjson line is error-prone)

```python
import json, pathlib
path = pathlib.Path("kibana/kibana-export.ndjson")
EDGES = (" SCOPE AT THE EDGES: a fire counts only if its entry record is in the range, and each of its records"
         " counts only if it too is stamped in the range. So a fire that entered before the range is never here,"
         " even where its terminal records land inside, and a fire still running when the range ends has its later"
         " terminal records dropped -- with a live 'Last 15 minutes' and a once-a-minute cron the last fire is"
         " nearly always still running. Set against the Step outcomes panels, which count every record stamped in"
         " the range whatever fire it belongs to, the two differ by about one fire's work at each end; that"
         " difference is the edges, not lost work.")
STAMPED = (" SCOPE: every outcome record stamped in the selected range, whatever fire it belongs to -- so it"
           " includes work of fires that entered before the range, and misses outcomes of fires still running"
           " when it ends. Run edges counts a different population (the fires that entered in the range);"
           " comparing the two leaves about one fire's work at each end, which is not loss.")
extra = {"Run edges — entry dispatches and terminal outcomes": EDGES,
         "Step outcomes over time": STAMPED, "Outcome distribution": STAMPED}
out, done = [], set()
for line in path.read_text(encoding="utf-8").splitlines():
    obj = json.loads(line)
    title = obj.get("attributes", {}).get("title")
    if obj.get("type") == "lens" and title in extra and extra[title].strip() not in obj["attributes"]["description"]:
        obj["attributes"]["description"] += extra[title]
        done.add(title)
        line = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    out.append(line)
path.write_text("\n".join(out) + "\n", encoding="utf-8")
print("updated:", sorted(done))
```

Run: `python <scratchpad>/kibana-scope.py`
Expected: `updated:` lists all three titles.

- [ ] **Step 2: Check that only the three descriptions changed**

Run: `git diff --stat kibana/kibana-export.ndjson` and `git diff --word-diff kibana/kibana-export.ndjson | Select-String "SCOPE"`
Expected: 3 lines changed, each adding a `SCOPE` sentence. If the re-serialisation changed other bytes on those lines (key order, escapes), stop. In that case, append to the raw string with a targeted string replace instead.

- [ ] **Step 3: Import and read the response**

Run: `curl -s -X POST "http://127.0.0.1:15601/api/saved_objects/_import?overwrite=true" -H "kbn-xsrf: true" --form file=@kibana/kibana-export.ndjson`
Expected: `"success":true`, with `successCount` equal to the number of lines in the file.

- [ ] **Step 4: Verify**

Run: `python tools/verify-kibana-dashboard.py`
Expected: every check passes. Then read one object back:
`curl -s "http://127.0.0.1:15601/api/saved_objects/_find?type=lens&search_fields=title&search=%22Run%20edges%22" | python -c "import json,sys; print([o['attributes']['description'][-120:] for o in json.load(sys.stdin)['saved_objects']])"`
Expected: it ends with `...that difference is the edges, not lost work.`

- [ ] **Step 5: Commit**

```bash
git add kibana/kibana-export.ndjson
git commit -m "docs(kibana): run edges and step outcomes say what they count at the range's edges

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Deploy and fire once on dev (PAID -- needs the user's go-ahead)

A rebuild moves the SourceHash, so the next dispatch pays a full four-scenario BIT: up to about 1.8M tokens and up to about 40 minutes.

**Files:**
- Modify: `docs/rebuild-analyst-monitor-workflow.md`: the `sourceHash` (line ~229), the provenance list (~531), and any text naming three rehearsals
- Modify: `docs/offline-steprole-drop.md:84-87`

- [ ] **Step 1: Ask the user for the go-ahead.** Stop here without it.

- [ ] **Step 2: Build, load, read the hash, repoint, roll out (PowerShell, repo root)**

```powershell
docker build -q -f src/Processor.Analyst/Dockerfile -t processor-analyst:local .
kind load docker-image processor-analyst:local --name desktop
dotnet build src/Processor.Analyst/Processor.Analyst.csproj -nologo -v q
$b=[IO.File]::ReadAllBytes((Resolve-Path "src/Processor.Analyst/bin/Debug/net8.0/Processor.Analyst.dll")); $asm=[Reflection.Assembly]::Load($b)
$hash=($asm.GetCustomAttributes([Reflection.AssemblyMetadataAttribute], $false) | Where-Object Key -eq 'SourceHash').Value; $hash
$u='http://localhost:18080/api/v1/processors/f361e170-c899-43d1-9a0e-4d30ff2cad87'
$p=(Invoke-WebRequest $u -UseBasicParsing).Content | ConvertFrom-Json; $p.sourceHash=$hash
$body=$p | Select-Object id,name,version,description,sourceHash,instanceId,inputSchemaId,outputSchemaId,configSchemaId | ConvertTo-Json
(Invoke-WebRequest $u -Method Put -Body $body -ContentType 'application/json' -UseBasicParsing).StatusCode
kubectl -n skp rollout restart deploy/processor-analyst; kubectl -n skp rollout status deploy/processor-analyst --timeout=180s
kubectl -n skp get pods -l app=processor-analyst -o name | ForEach-Object { kubectl -n skp logs $_ --tail=-1 | Select-String 'resolving identity for source hash' }
```

Expected: PUT `200`. Both pods log the new hash.

- [ ] **Step 3: Fire once with the declared expectations (Git Bash)**

Run: `bash tools/analyst-fire-once.sh scope-1`
Expected: `step started at HH:MM:SSZ`, `cron now: 0 9,39 * * * *`.

- [ ] **Step 4: Watch for the end** (`--since-time` AFTER the fire; `--tail=-1` is required with a selector)

Poll every 60 s until a `the step returned after` line appears:
`kubectl -n skp logs -l app=processor-analyst --tail=-1 --since-time=<fire minute>:00Z | Select-String 'passed its ground-truth|reported the step failed|dispatch spent|step returned'`

Expected: `quiet and edge-skewed windows silent, planted loss and undeclared bad input reported and classified`, then `step returned`.

- If the BIT fails, read the verdict's `it classified ...` or `the prompt still produced a finding: ...` text and report it to the user. Do not re-fire unchanged: the unfit verdict is cached until the next hash.

- [ ] **Step 5: Read the published message**

```powershell
docker exec skp-kafka sh -c '/opt/kafka/bin/kafka-get-offsets.sh --bootstrap-server localhost:9092 --topic skp-analyst-findings'
docker exec skp-kafka sh -c '/opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server localhost:9092 --topic skp-analyst-findings --partition 0 --offset <end-1> --max-messages 1 --timeout-ms 15000' | python -c "import sys,json; print(json.dumps(json.loads(sys.stdin.read()), indent=2, ensure_ascii=False))"
```

Expected: a verdict whose insights carry no `system`-domain claim resting on a gap the edges explain. Report it to the user as it stands.

- [ ] **Step 6: Docs and memory**

- `docs/rebuild-analyst-monitor-workflow.md`: set `"sourceHash"` to the new hash. Append to the provenance list: `` `bbfa4aec...` (...) and now `<new8>...` (panel scopes, edge-residue rule, edge-skew rehearsal, 2026-10-0X) `` (move "and now" from the previous entry). Replace any "three-scenario" or "three rehearsals" with four, naming quiet, edge-skew, loss and bad input.
- `docs/offline-steprole-drop.md`: put the new hash at the front of the `Dev 2026-10-03: SourceHash` paragraph, with the old one first in the "was" list.
- Memory: update `skp-bit-rehearsal-wall-clock-too-tight.md` and `skp-analyst-window-edge-false-positive.md` with the new hash and the result.

- [ ] **Step 7: Commit**

```bash
git add docs/rebuild-analyst-monitor-workflow.md docs/offline-steprole-drop.md
git commit -m "docs(analyst): SourceHash <new8> -- panel scopes and the edge-skew rehearsal

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Replay the three captured windows (PAID -- needs the user's approval, spec §7 Q3)

Replays cannot serve history (a fixture read returns the captured window), so D3's widening test is unavailable. A Quiet on the edge window must come from D2's bound alone. Each run is a full investigation, about 0.7M tokens.

**Files:**
- Modify: `src/tests/BaseApi.Tests/Analyst/ReplayFixtures.cs` (add `RunContext`)
- Create: `src/tests/BaseApi.Tests/Live/AnalystScopeReplay.cs`

- [ ] **Step 1: Ask the user for approval and the run count** (default 3 per window). Stop here without approval.

- [ ] **Step 2: Add the run-context loader to `ReplayFixtures`**

```csharp
    /// <summary>The run context captured with the window (start, history limit, deploys), as of its end.</summary>
    internal static global::Processor.Analyst.Graph.RunContext RunContext(string name)
        => JsonSerializer.Deserialize<global::Processor.Analyst.Graph.RunContext>(
            File.ReadAllText(Path.Combine(OutputRoot(), name, "run-context.json")))!;
```

- [ ] **Step 3: Write the replay class**

```csharp
using System.Text;
using BaseApi.Tests.Analyst;
using BaseApi.Tests.Support;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Processor.Analyst;
using Processor.Analyst.Bit;
using Processor.Analyst.Loop;
using Xunit;

namespace BaseApi.Tests.Live;

/// <summary>
/// The three windows the deployed v14 Analyst judged on 2026-10-03, replayed against the panel-scope
/// change: offset 56 (declared, Quiet), offset 57 (undeclared, Notable data) and offset 58 (declared,
/// the edge-skewed window it wrongly paged as a system defect). Each runs with the expectations it was
/// judged under and its captured run context. History is not served: a replay fixture answers every
/// range with the captured window.
/// </summary>
public sealed class AnalystScopeReplay
{
    private static readonly string[] Panels =
    [
        "step-outcomes", "step-failures", "refused-messages", "run-boundaries",
        "queue-wait", "processor-liveness", "dead-letter-depth", "failure-causes",
    ];

    private static readonly AnalystExpectations Declared =
        new(0.65, 0.25, "dev endless feed: 3 of every 5 files are built to fail, 1 to be cancelled");

    [Fact]
    public Task TheEdgeSkewedWindowIsQuiet() => Score(
        "edge-skew-2026-10-03", Declared,
        "Quiet: the S10 126-vs-136 and S5 39-vs-45 gaps are the window's edges",
        f => f.Verdict == "Quiet");

    [Fact]
    public Task TheDeclaredWindowStaysQuiet() => Score(
        "declared-quiet-2026-10-03", Declared, "Quiet", f => f.Verdict == "Quiet");

    [Fact]
    public Task TheUndeclaredWindowIsADataProblemAndNothingElse() => Score(
        "undeclared-notable-2026-10-03", null,
        "Notable with a deterministic data insight, and no system-domain insight",
        f => f.Verdict == "Notable"
             && f.Insights.Any(i => i.Classification == "deterministic" && i.Domain == "data")
             && f.Insights.All(i => i.Domain != "system"));

    private static async Task Score(
        string window, AnalystExpectations? expectations, string expected, Func<AnalystFinding, bool> correct)
    {
        Assert.SkipUnless(
            Environment.GetEnvironmentVariable("SKP_ANALYST_REPLAY") == "1",
            "set SKP_ANALYST_REPLAY=1 to replay; every run is a full investigation against the real model");

        var promptPath = System.IO.Path.Combine(ReplayFixtures.RepoRoot(),
            Environment.GetEnvironmentVariable("SKP_ANALYST_PROMPT") ?? "tools/analyst-prompt-v14.txt");
        var prompt = File.ReadAllText(promptPath).Trim();
        var runs = int.TryParse(Environment.GetEnvironmentVariable("SKP_ANALYST_REPLAY_RUNS"), out var n) && n > 0 ? n : 1;

        var card = new StringBuilder().AppendLine($"=== {window}  hash={PromptHash.Of(prompt)[..12]}  runs={runs}")
            .AppendLine($"expected: {expected}");
        var file = System.IO.Path.Combine(AppContext.BaseDirectory, "TestResults", $"scope-replay-{window}.txt");
        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(file)!);
        var passes = 0;

        for (var run = 1; run <= runs; run++)
        {
            try
            {
                using var cts = new CancellationTokenSource(TimeSpan.FromMinutes(22));
                var config = AnalystGroundTruthLiveTests.Config(prompt, Panels) with
                {
                    WallClockSeconds = 1200,
                    Expectations = expectations,
                };
                var finding = await Processor(window).AnalyseAsync(config, cts.Token);
                var ok = correct(finding);
                passes += ok ? 1 : 0;
                card.AppendLine($"--- run {run}: {(ok ? "PASS" : "FAIL")}  verdict={finding.Verdict}  calls={finding.Usage.Calls}");
                foreach (var insight in finding.Insights)
                {
                    card.AppendLine($"    insight {insight.Classification}/{insight.Domain} [{string.Join(",", insight.Panels)}] {insight.Claim}");
                }

                if (finding.Reason is { } reason)
                {
                    card.AppendLine($"    reason: {reason}");
                }
            }
            catch (Exception ex) when (ex is not Xunit.Sdk.XunitException)
            {
                card.AppendLine($"--- run {run}: ERROR  {ex.GetType().Name}: {ex.Message}");
            }

            // Rewritten after every run: a reaped process must not take finished runs with it.
            await File.WriteAllTextAsync(file, card + $"(so far {passes}/{run})\n", TestContext.Current.CancellationToken);
        }

        card.AppendLine($"score: {passes}/{runs}");
        await File.WriteAllTextAsync(file, card.ToString(), TestContext.Current.CancellationToken);
        Assert.True(passes == runs, $"{passes}/{runs}; scorecard at {file}\n{card}");
    }

    private static AnalystProcessor Processor(string window)
    {
        var model = AnalystGroundTruthLiveTests.RealModel();

        return new AnalystProcessor(
            new PreflightBit(
                model,
                new BitCache(new InMemorySharedState(), "replay"),
                options: Options.Create(new AnalystBitOptions { Mode = BitMode.StructureOnly })),
            new InvestigationLoop(model, ReplayFixtures.Reader(window), TimeProvider.System, NullLogger<InvestigationLoop>.Instance),
            NullLogger<AnalystProcessor>.Instance,
            graphs: new FixedGraphSource(global::Processor.Analyst.Graph.GraphBriefing.Of(ReplayFixtures.Graph(window))),
            clock: new Microsoft.Extensions.Time.Testing.FakeTimeProvider(ReplayFixtures.Window(window).To),
            runs: new FixedRunContextSource(ReplayFixtures.RunContext(window)));
    }
}
```

- [ ] **Step 4: Build**

Run: `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -nologo -v q`
Expected: `0 Error(s)`. If `AnalystProcessor`'s parameter names differ, match them to its constructor (`src/Processor.Analyst/AnalystProcessor.cs:20-27`).

- [ ] **Step 5: Run the replays**

```powershell
$env:SKP_ANALYST_REPLAY='1'; $env:SKP_ANALYST_REPLAY_RUNS='3'
& src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.Live.AnalystScopeReplay"
Remove-Item Env:SKP_ANALYST_REPLAY, Env:SKP_ANALYST_REPLAY_RUNS
```

Expected: three scorecards under `src/tests/BaseApi.Tests/bin/Debug/net8.0/TestResults/scope-replay-*.txt`. Report every score to the user, failures included. A failed run is a result, not a reason to re-run.

- [ ] **Step 6: Commit**

```bash
git add src/tests/BaseApi.Tests/Analyst/ReplayFixtures.cs src/tests/BaseApi.Tests/Live/AnalystScopeReplay.cs
git commit -m "test(analyst-replay): replay the 2026-10-03 windows -- declared, undeclared, edge-skewed

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
