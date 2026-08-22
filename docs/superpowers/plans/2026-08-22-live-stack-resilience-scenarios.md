# Live-stack resilience scenarios — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Five timed orchestrations against the running `skp` cluster that prove the round trip loses no step across a Redis or RabbitMQ outage, verified from Elasticsearch log records alone.

**Architecture:** A pure oracle — `RunLedger` and `RunClassifier` — decides completeness from a run's log-template histogram, and is unit-tested hermetically against a captured fixture. Live units around it read Elasticsearch, drive `kubectl` and `redis-cli` fault levers, and witness the fault's arrival and heal from the logs. One `OrchestrationSoak` skeleton is parameterised by a fault schedule; five scenario classes supply the schedules and the verdicts.

**Tech Stack:** .NET 8, xunit v3 on Microsoft.Testing.Platform, `System.Text.Json`, `HttpClient`, `System.Diagnostics.Process` for `kubectl`. No new NuGet packages.

**Spec:** `docs/superpowers/specs/2026-08-22-live-stack-resilience-scenarios-design.md`

## Global Constraints

- `TargetFramework` `net8.0`, `Nullable` enable, `ImplicitUsings` enable, `TreatWarningsAsErrors` true. **A build warning is a build failure.** An unresolvable `<see cref="..."/>` fails the build, so keep XML docs prose-only unless the target is certain.
- `RestorePackagesWithLockFile` is true. **Add no NuGet package** — every type in this plan comes from the framework or from packages already referenced by `BaseApi.Tests.csproj`.
- The test runner **silently ignores `--filter`**. Run the whole project. `--filter-method` works only after a bare `--`: `dotnet test <csproj> -- --filter-method "*Name*"`.
- Live tests gate on an **environment variable read inside the test**, never on a trait filter. Chaos tests gate on **two**: `SKP_REALSTACK=1` and `SKP_CHAOS=1`.
- Never `git add -A` or `git add .`. Always stage explicit paths.
- Message templates contain **U+2014 EM DASH**. Write them in C# as `—` escapes so the source is ASCII and immune to encoding drift, and never round-trip one through a shell.
- The workflow under test is `4cd8af45-1295-43db-ab2e-e955dd82b5c5`, cron `*/30 * * * * *`, eleven step executions and two terminals per fire.

### Hermetic baseline

Before this plan: `Failed 0, Passed 400, Skipped 7, Total 407`, exit 0, 0 warnings.

After this plan: **`Failed 0, Passed 424, Skipped 15, Total 439`**. The 8 new skips are chaos-gated (7 existing Live + 8 chaos = 15); the 24 new passes are the hermetic tests of Tasks 1, 2 and 3. Theory cases count individually, so a `[Theory]` with five `[InlineData]` rows adds five. Read the shape, not the total: if a chaos test *runs* rather than skips under a plain `dotnet test`, the gate is broken and that is a defect.

Verification command used throughout:

```bash
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

---

## File structure

**Hermetic** — runs in the normal gate, no cluster:

| File | Responsibility |
| --- | --- |
| `src/tests/BaseApi.Tests/Live/Resilience/Templates.cs` | every message template as a constant, in two groups: ledger and accounting |
| `src/tests/BaseApi.Tests/Live/Resilience/LogRecord.cs` | one projected Elasticsearch record |
| `src/tests/BaseApi.Tests/Live/Resilience/WorkflowShape.cs` | dispatches and terminals expected per fire |
| `src/tests/BaseApi.Tests/Live/Resilience/RunLedger.cs` | template histogram + invariants I1–I6. Pure. |
| `src/tests/BaseApi.Tests/Live/Resilience/RunClassifier.cs` | complete / accounted / unaccounted. Pure. |
| `src/tests/BaseApi.Tests/Resilience/RunLedgerTests.cs` | hermetic tests for the ledger |
| `src/tests/BaseApi.Tests/Resilience/RunClassifierTests.cs` | hermetic tests for the classifier |
| `src/tests/BaseApi.Tests/Resilience/Fixtures/complete-run.json` | a captured 77-record run |

**Live** — chaos-gated:

| File | Responsibility |
| --- | --- |
| `src/tests/BaseApi.Tests/Live/Resilience/Chaos.cs` | the second gate and this suite's addresses |
| `src/tests/BaseApi.Tests/Live/Resilience/ElasticLogReader.cs` | windowed, paged search → records |
| `src/tests/BaseApi.Tests/Live/Resilience/StabilityWaiter.cs` | the ingest settle poll |
| `src/tests/BaseApi.Tests/Live/Resilience/Kubectl.cs` | process runner for `kubectl` |
| `src/tests/BaseApi.Tests/Live/Resilience/ClusterControl.cs` | the fault levers, with unconditional restore |
| `src/tests/BaseApi.Tests/Live/Resilience/FaultWitness.cs` | observed fault arrival and heal |
| `src/tests/BaseApi.Tests/Live/Resilience/PromReader.cs` | corroboration queries |
| `src/tests/BaseApi.Tests/Live/Resilience/OrchestrationSoak.cs` | the five-minute skeleton |
| `src/tests/BaseApi.Tests/Live/Resilience/OutageVerdict.cs` | the three obligations of §5.4 |
| `src/tests/BaseApi.Tests/Live/Resilience/HappyPathScenarioTests.cs` | S1 |
| `src/tests/BaseApi.Tests/Live/Resilience/RedisUnavailableScenarioTests.cs` | S2 |
| `src/tests/BaseApi.Tests/Live/Resilience/RabbitUnavailableScenarioTests.cs` | S3 |
| `src/tests/BaseApi.Tests/Live/Resilience/BothUnavailableScenarioTests.cs` | S4 |
| `src/tests/BaseApi.Tests/Live/Resilience/RedisWipeScenarioTests.cs` | S5 |

**Modified:** `src/tests/BaseApi.Tests/Live/RealStack.cs` (one access modifier), `k8s/port-forward-realstack.ps1`, `k8s/README.md`.

---

### Task 1: The chaos gate and this suite's addresses

Nothing here talks to the cluster yet. The deliverable is a gate that is provably closed by default, because every later task depends on `SKP_REALSTACK=1` alone never scaling down infrastructure.

**Files:**
- Create: `src/tests/BaseApi.Tests/Live/Resilience/Chaos.cs`
- Create: `src/tests/BaseApi.Tests/Resilience/ChaosGateTests.cs`
- Modify: `src/tests/BaseApi.Tests/Live/RealStack.cs:44` — `private static string Get` becomes `internal static string Get`
- Modify: `k8s/port-forward-realstack.ps1`

**Interfaces:**
- Consumes: `RealStack.Enabled`, `RealStack.Get` (after the modifier change).
- Produces: `Chaos.Enabled`, `Chaos.SkipUnlessEnabled()`, `Chaos.Category`, `Chaos.ElasticUrl`, `Chaos.PrometheusUrl`, `Chaos.WorkflowId`, `Chaos.Namespace`, `Chaos.LogIndex`.

- [ ] **Step 1: Write the failing test**

Create `src/tests/BaseApi.Tests/Resilience/ChaosGateTests.cs`:

```csharp
using BaseApi.Tests.Live.Resilience;
using Xunit;

namespace BaseApi.Tests.Resilience;

/// <summary>
/// The gate is the whole safety story for a suite that pauses Redis and scales StatefulSets to zero.
/// These run hermetically and assert it is shut unless BOTH switches are thrown.
/// </summary>
public sealed class ChaosGateTests
{
    [Fact]
    public void TheGateIsClosedWhenOnlyTheRealStackSwitchIsSet()
    {
        using var _ = new EnvScope(("SKP_REALSTACK", "1"), ("SKP_CHAOS", null));

        Assert.False(Chaos.Enabled);
    }

    [Fact]
    public void TheGateIsClosedWhenOnlyTheChaosSwitchIsSet()
    {
        using var _ = new EnvScope(("SKP_REALSTACK", null), ("SKP_CHAOS", "1"));

        Assert.False(Chaos.Enabled);
    }

    [Fact]
    public void TheGateOpensOnlyWhenBothSwitchesAreSet()
    {
        using var _ = new EnvScope(("SKP_REALSTACK", "1"), ("SKP_CHAOS", "1"));

        Assert.True(Chaos.Enabled);
    }

    [Fact]
    public void TheDefaultsAddressTheForwardsTheScriptOpens()
    {
        using var _ = new EnvScope(
            ("SKP_ES_URL", null), ("SKP_PROM_URL", null),
            ("SKP_WORKFLOW_ID", null), ("SKP_K8S_NAMESPACE", null));

        Assert.Equal("http://localhost:19200", Chaos.ElasticUrl);
        Assert.Equal("http://localhost:19090", Chaos.PrometheusUrl);
        Assert.Equal(Guid.Parse("4cd8af45-1295-43db-ab2e-e955dd82b5c5"), Chaos.WorkflowId);
        Assert.Equal("skp", Chaos.Namespace);
    }

    /// <summary>Sets environment variables for the life of the scope and restores them after.</summary>
    private sealed class EnvScope : IDisposable
    {
        private readonly (string Key, string? Previous)[] _saved;

        public EnvScope(params (string Key, string? Value)[] values)
        {
            _saved = values
                .Select(v => (v.Key, Environment.GetEnvironmentVariable(v.Key)))
                .ToArray();

            foreach (var (key, value) in values)
            {
                Environment.SetEnvironmentVariable(key, value);
            }
        }

        public void Dispose()
        {
            foreach (var (key, previous) in _saved)
            {
                Environment.SetEnvironmentVariable(key, previous);
            }
        }
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: build failure — `Chaos` does not exist in namespace `BaseApi.Tests.Live.Resilience`.

- [ ] **Step 3: Widen `RealStack.Get`**

In `src/tests/BaseApi.Tests/Live/RealStack.cs`, change the final member from:

```csharp
    private static string Get(string key, string fallback) =>
```

to:

```csharp
    /// <summary>
    /// Reads an override or falls back. Internal rather than private so the chaos suite's own
    /// address block reads its environment the same way, instead of growing a second copy that
    /// could drift on the empty-string case.
    /// </summary>
    internal static string Get(string key, string fallback) =>
```

- [ ] **Step 4: Write the gate**

Create `src/tests/BaseApi.Tests/Live/Resilience/Chaos.cs`:

```csharp
using Xunit;

namespace BaseApi.Tests.Live.Resilience;

/// <summary>
/// The second switch, and the addresses the resilience scenarios use.
/// <para>
/// <b>Two gates, not one.</b> The existing Live tests read the cluster; these ones break it — they
/// pause Redis and scale StatefulSets to zero. Someone exporting SKP_REALSTACK=1 to run the seven
/// existing live tests is asking to talk to the stack, not to take it down, so chaos needs its own
/// consent. Both are read inside the test rather than expressed as a trait filter, for the reason
/// RealStack already documents: this runner accepts a --filter and silently ignores it.
/// </para>
/// </summary>
internal static class Chaos
{
    public const string Category = "Chaos";

    /// <summary>The data stream the collector's elasticsearch exporter writes into.</summary>
    public const string LogIndex = "logs-generic.otel-default";

    /// <summary>True only when the operator has thrown both switches.</summary>
    public static bool Enabled =>
        RealStack.Enabled && Environment.GetEnvironmentVariable("SKP_CHAOS") == "1";

    /// <summary>Skips the calling scenario unless both switches are set.</summary>
    public static void SkipUnlessEnabled() =>
        Assert.SkipUnless(Enabled,
            "set SKP_REALSTACK=1 and SKP_CHAOS=1, and run k8s/port-forward-realstack.ps1, "
            + "to run the resilience scenarios; they pause Redis and scale StatefulSets to zero");

    public static string ElasticUrl => RealStack.Get("SKP_ES_URL", "http://localhost:19200");
    public static string PrometheusUrl => RealStack.Get("SKP_PROM_URL", "http://localhost:19090");
    public static string Namespace => RealStack.Get("SKP_K8S_NAMESPACE", "skp");

    public static Guid WorkflowId =>
        Guid.Parse(RealStack.Get("SKP_WORKFLOW_ID", "4cd8af45-1295-43db-ab2e-e955dd82b5c5"));
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: PASS. `Passed 404, Skipped 7, Total 411`, 0 warnings.

- [ ] **Step 6: Add the two forwards the suite needs**

In `k8s/port-forward-realstack.ps1`, extend the `$forwards` array:

```powershell
$forwards = @(
    @{ svc = "rabbitmq";       local = 5673;  remote = 5672 },
    @{ svc = "baseapi-service";local = 18080; remote = 8080 },
    @{ svc = "otel-collector"; local = 14317; remote = 4317 },
    @{ svc = "otel-collector"; local = 18889; remote = 8889 },
    @{ svc = "redis";          local = 6380;  remote = 6379 },
    @{ svc = "elasticsearch";  local = 19200; remote = 9200 },
    @{ svc = "prometheus";     local = 19090; remote = 9090 }
)
```

- [ ] **Step 7: Commit**

```bash
git add src/tests/BaseApi.Tests/Live/Resilience/Chaos.cs \
        src/tests/BaseApi.Tests/Resilience/ChaosGateTests.cs \
        src/tests/BaseApi.Tests/Live/RealStack.cs \
        k8s/port-forward-realstack.ps1
git commit -m "test: gate the resilience scenarios behind a second switch"
```

---

### Task 2: The ledger — six invariants over a template histogram

The oracle's core, and pure. Its only input is a bag of records; it never touches Elasticsearch. That is what lets it be tested hermetically, which matters because an oracle only exercisable by a five-minute live run is one nobody will trust.

**Files:**
- Create: `src/tests/BaseApi.Tests/Live/Resilience/Templates.cs`
- Create: `src/tests/BaseApi.Tests/Live/Resilience/LogRecord.cs`
- Create: `src/tests/BaseApi.Tests/Live/Resilience/WorkflowShape.cs`
- Create: `src/tests/BaseApi.Tests/Live/Resilience/RunLedger.cs`
- Create: `src/tests/BaseApi.Tests/Resilience/Fixtures/complete-run.json`
- Create: `src/tests/BaseApi.Tests/Resilience/RunLedgerTests.cs`
- Modify: `src/tests/BaseApi.Tests/BaseApi.Tests.csproj`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `LogRecord(DateTimeOffset Timestamp, string Template, string Body, string? CorrelationId, string? Result, string Service, string Scope)`; `Templates.*` string constants; `WorkflowShape(int Dispatches, int Terminals)` with `WorkflowShape.V8FanoutProof`; `RunLedger.From(string, IReadOnlyCollection<LogRecord>, WorkflowShape)` returning a `RunLedger` exposing `CorrelationId`, `StartedAt`, `EndedAt`, `Count(string)`, `Breaches` (`IReadOnlyList<LedgerBreach>`), `IsComplete`; `LedgerBreach(string Invariant, string Detail)`.

- [ ] **Step 1: Capture the fixture from the live stack**

This is a one-time capture of a real complete run, committed so the hermetic tests never need a cluster. With the Elasticsearch forward open:

```bash
python -c "
import json, urllib.request
base = 'http://localhost:19200/logs-generic.otel-default/_search'
def search(q):
    req = urllib.request.Request(base, data=json.dumps(q).encode('utf-8'),
                                 headers={'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(req))

top = search({'size': 1, 'sort': [{'@timestamp': 'desc'}],
              'query': {'term': {'attributes.{OriginalFormat}': 'dispatched an entry step'}},
              '_source': ['attributes.CorrelationId']})
cid = top['hits']['hits'][0]['_source']['attributes']['CorrelationId']

run = search({'size': 200, 'sort': [{'@timestamp': 'asc'}],
              'query': {'term': {'attributes.CorrelationId': cid}},
              '_source': ['@timestamp', 'body.text', 'attributes', 'scope.name',
                          'resource.attributes.service.name']})
hits = [h['_source'] for h in run['hits']['hits']]
assert len(hits) == 77, f'captured {len(hits)} records, expected a complete 77-record run'
open('src/tests/BaseApi.Tests/Resilience/Fixtures/complete-run.json', 'w', encoding='utf-8').write(
    json.dumps(hits, indent=2, ensure_ascii=False))
print('captured', len(hits), 'records for', cid)
"
```

Expected: `captured 77 records for <hex>`. If the assert trips, the most recent run was truncated — pick an earlier one, or start the workflow and wait for a clean fire.

- [ ] **Step 2: Make the fixture reachable at runtime**

In `src/tests/BaseApi.Tests/BaseApi.Tests.csproj`, extend the existing `None` item group:

```xml
  <ItemGroup>
    <None Include="xunit.runner.json" CopyToOutputDirectory="PreserveNewest" />
    <None Include="Resilience\Fixtures\*.json" CopyToOutputDirectory="PreserveNewest" />
  </ItemGroup>
```

- [ ] **Step 3: Write the failing test**

Create `src/tests/BaseApi.Tests/Resilience/RunLedgerTests.cs`:

```csharp
using System.Text.Json;
using BaseApi.Tests.Live.Resilience;
using Xunit;

namespace BaseApi.Tests.Resilience;

/// <summary>
/// The oracle, exercised against a real captured run and against that run with one record taken
/// away. Each removal names the hop it breaks, which is the property the scenarios rely on: a
/// breach is a diagnosis, not a boolean.
/// </summary>
public sealed class RunLedgerTests
{
    private static readonly IReadOnlyList<LogRecord> CompleteRun = LoadFixture();

    [Fact]
    public void TheCapturedRunIsSeventySevenRecords()
    {
        Assert.Equal(77, CompleteRun.Count);
    }

    [Fact]
    public void TheCapturedRunSatisfiesEveryInvariant()
    {
        var ledger = RunLedger.From(
            CompleteRun[0].CorrelationId!, CompleteRun, WorkflowShape.V8FanoutProof);

        Assert.Empty(ledger.Breaches);
        Assert.True(ledger.IsComplete);
    }

    [Fact]
    public void TheLedgerCountsTheCanonicalHistogram()
    {
        var ledger = RunLedger.From(
            CompleteRun[0].CorrelationId!, CompleteRun, WorkflowShape.V8FanoutProof);

        Assert.Equal(1, ledger.Count(Templates.EntryDispatched));
        Assert.Equal(10, ledger.Count(Templates.HandoffDispatched));
        Assert.Equal(11, ledger.Count(Templates.RunningTheStep));
        Assert.Equal(11, ledger.Count(Templates.AuthorConfig));
        Assert.Equal(11, ledger.Count(Templates.StepReturned));
        Assert.Equal(11, ledger.Count(Templates.BranchCompleted));
        Assert.Equal(1, ledger.Count(Templates.EntryStepCompleted));
        Assert.Equal(10, ledger.Count(Templates.HandedOff));
        Assert.Equal(9, ledger.Count(Templates.AdvancedSuccessors));
        Assert.Equal(2, ledger.Count(Templates.TerminalCompleted));
    }

    [Theory]
    [InlineData(Templates.RunningTheStep, "I1")]
    [InlineData(Templates.StepReturned, "I2")]
    [InlineData(Templates.BranchCompleted, "I3")]
    [InlineData(Templates.HandedOff, "I4")]
    [InlineData(Templates.AuthorConfig, "I6")]
    public void DroppingOneRecordBreachesTheInvariantThatNamesItsHop(string template, string invariant)
    {
        var maimed = DropOne(CompleteRun, template);

        var ledger = RunLedger.From(
            CompleteRun[0].CorrelationId!, maimed, WorkflowShape.V8FanoutProof);

        Assert.Contains(ledger.Breaches, b => b.Invariant == invariant);
    }

    [Fact]
    public void DroppingAHandoffDispatchBreachesBothTheHopAndTheGraphWalk()
    {
        var maimed = DropOne(CompleteRun, Templates.HandoffDispatched);

        var ledger = RunLedger.From(
            CompleteRun[0].CorrelationId!, maimed, WorkflowShape.V8FanoutProof);

        Assert.Contains(ledger.Breaches, b => b.Invariant == "I1");
        Assert.Contains(ledger.Breaches, b => b.Invariant == "I4");
        Assert.Contains(ledger.Breaches, b => b.Invariant == "I5");
    }

    [Fact]
    public void DroppingATerminalBreachesTheGraphWalkOnly()
    {
        var maimed = DropOne(CompleteRun, Templates.TerminalCompleted);

        var ledger = RunLedger.From(
            CompleteRun[0].CorrelationId!, maimed, WorkflowShape.V8FanoutProof);

        Assert.Contains(ledger.Breaches, b => b.Invariant == "I5");
        Assert.DoesNotContain(ledger.Breaches, b => b.Invariant == "I1");
    }

    /// <summary>
    /// The discriminator that keeps log loss from reading as step loss. An author record without
    /// its framework twin is not a lost step, and I6 is the only invariant that must notice.
    /// </summary>
    [Fact]
    public void LosingOnlyTheAuthorRecordIsNotAStepLoss()
    {
        var maimed = DropOne(CompleteRun, Templates.AuthorConfig);

        var ledger = RunLedger.From(
            CompleteRun[0].CorrelationId!, maimed, WorkflowShape.V8FanoutProof);

        Assert.Equal(new[] { "I6" }, ledger.Breaches.Select(b => b.Invariant).ToArray());
    }

    [Fact]
    public void TheLedgerSpansTheRunsFirstAndLastRecord()
    {
        var ledger = RunLedger.From(
            CompleteRun[0].CorrelationId!, CompleteRun, WorkflowShape.V8FanoutProof);

        Assert.Equal(CompleteRun.Min(r => r.Timestamp), ledger.StartedAt);
        Assert.Equal(CompleteRun.Max(r => r.Timestamp), ledger.EndedAt);
    }

    private static IReadOnlyList<LogRecord> DropOne(IReadOnlyList<LogRecord> records, string template)
    {
        var index = records.ToList().FindIndex(r => r.Template == template);
        Assert.True(index >= 0, $"the fixture carries no record for template '{template}'");

        return records.Where((_, i) => i != index).ToList();
    }

    /// <summary>
    /// Reads the captured run through the same projection the live reader uses, so a change to the
    /// field names breaks here — hermetically — rather than in a five-minute scenario.
    /// </summary>
    private static IReadOnlyList<LogRecord> LoadFixture()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "Resilience", "Fixtures", "complete-run.json");
        using var document = JsonDocument.Parse(File.ReadAllText(path));

        return document.RootElement.EnumerateArray().Select(LogRecord.FromSource).ToList();
    }
}
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: build failure — `Templates`, `LogRecord`, `WorkflowShape` and `RunLedger` do not exist.

- [ ] **Step 5: Write the templates**

Create `src/tests/BaseApi.Tests/Live/Resilience/Templates.cs`:

```csharp
namespace BaseApi.Tests.Live.Resilience;

/// <summary>
/// Every message template the scenarios count, copied from the emitting call site.
/// <para>
/// <b>Templates, not rendered text.</b> The OpenTelemetry bridge puts the unsubstituted template on
/// <c>attributes.{OriginalFormat}</c> as a keyword, so "the step returned after {ElapsedMs}ms" is one
/// bucket where the rendered text would be one bucket per distinct duration. A verifier written
/// against rendered text miscounts the moment a step's timing varies, which is always.
/// </para>
/// <para>
/// <b>The em dashes are written as — escapes.</b> Two of these templates carry U+2014. Spelling
/// it literally makes the constant's correctness depend on the file's encoding surviving every editor
/// and tool that touches it, and a template that differs by one byte matches nothing and reports a
/// lost step. The escape is unambiguous.
/// </para>
/// </summary>
internal static class Templates
{
    // ---- the ledger: the ten templates a complete run emits ----

    public const string EntryDispatched = "dispatched an entry step";
    public const string HandoffDispatched = "dispatched in {ElapsedMs}ms";
    public const string RunningTheStep = "running the step";
    public const string AuthorConfig = "config gives label {Label} and number {Number}";
    public const string StepReturned = "the step returned after {ElapsedMs}ms";
    public const string BranchCompleted = "branch completed in {ElapsedMs}ms";
    public const string EntryStepCompleted = "the entry step completed with {Result}";
    public const string HandedOff =
        "handed off to {NextStepId} on {NextProcessorId} with {NextEntryId}";
    public const string AdvancedSuccessors = "advanced {SuccessorCount} successor(s) in {ElapsedMs}ms";
    public const string TerminalCompleted =
        "the terminal step completed with {Result} — no successor accepts it, the run ends here";

    // ---- the accounting vocabulary: the closed set of legitimate excuses for a short ledger ----

    public const string StoreUnreachable = "projection store unreachable — returning message to {Queue}";
    public const string RefusingAndParking = "refusing message of type {Type} — parking";
    public const string SendFailedReturning =
        "send failed while handling {Type} — returning message to {Queue}";
    public const string EntryDispatchSendFailed = "the entry-step dispatch failed to send; continuing";
    public const string EntryAbsentDuplicate = "entry absent — treating as a duplicate delivery";

    // ---- fault arrival and heal, witnessed rather than assumed ----

    public const string GateClosed = "L2 gate closed — projection store unusable, consumers paused";
    public const string GateOpen = "L2 gate open — projection store healthy, consumers may run";
    public const string ChannelShutDown = "channel shut down: {Reason} — will reopen";
    public const string ConnectionRecovered = "connection recovered — delivery tags invalidated";
    public const string ConsumptionPaused =
        "consumption no longer admitted or the projection store unhealthy — paused consuming {Queue}";
    public const string ConsumptionAdmitted =
        "consumption admitted and the projection store healthy — consuming {Queue}";

    /// <summary>The ten ledger templates, for building a histogram with every bucket present.</summary>
    public static readonly IReadOnlyList<string> Ledger =
    [
        EntryDispatched, HandoffDispatched, RunningTheStep, AuthorConfig, StepReturned,
        BranchCompleted, EntryStepCompleted, HandedOff, AdvancedSuccessors, TerminalCompleted,
    ];

    /// <summary>
    /// The closed set of records that excuse a short ledger. Closed deliberately: anything outside
    /// it is unaccounted loss, and widening this list is a decision about what the system is allowed
    /// to do, not a detail of the verifier.
    /// </summary>
    public static readonly IReadOnlyList<string> Accounting =
    [
        StoreUnreachable, RefusingAndParking, SendFailedReturning,
        EntryDispatchSendFailed, EntryAbsentDuplicate,
    ];
}
```

- [ ] **Step 6: Write the record projection and the workflow shape**

Create `src/tests/BaseApi.Tests/Live/Resilience/LogRecord.cs`:

```csharp
using System.Globalization;
using System.Text.Json;

namespace BaseApi.Tests.Live.Resilience;

/// <summary>
/// One Elasticsearch log record, cut down to the fields the oracle reads.
/// <para>
/// <b><see cref="Result"/> is read from its own attribute, not parsed out of the body.</b> The
/// bridge lands every structured parameter as <c>attributes.&lt;Name&gt;</c>, so an outcome record
/// carries <c>attributes.Result</c> = "Completed" alongside the rendered text. Substring-matching
/// the body for "Failed" would be a second, weaker spelling of a fact already on the record.
/// </para>
/// </summary>
internal sealed record LogRecord(
    DateTimeOffset Timestamp,
    string Template,
    string Body,
    string? CorrelationId,
    string? Result,
    string Service,
    string Scope)
{
    /// <summary>
    /// Projects one <c>_source</c> object. Used by both the live reader and the hermetic fixture
    /// loader, so a drift in the field names breaks in the fast tests rather than in a soak.
    /// </summary>
    public static LogRecord FromSource(JsonElement source)
    {
        var attributes = source.TryGetProperty("attributes", out var a) ? a : default;

        return new LogRecord(
            Timestamp: ParseTimestamp(source),
            Template: Attribute(attributes, "{OriginalFormat}") ?? string.Empty,
            Body: source.TryGetProperty("body", out var body)
                && body.TryGetProperty("text", out var text)
                    ? text.GetString() ?? string.Empty
                    : string.Empty,
            CorrelationId: Attribute(attributes, "CorrelationId"),
            Result: Attribute(attributes, "Result"),
            Service: source.TryGetProperty("resource", out var resource)
                && resource.TryGetProperty("attributes", out var ra)
                    ? Attribute(ra, "service.name") ?? string.Empty
                    : string.Empty,
            Scope: source.TryGetProperty("scope", out var scope)
                && scope.TryGetProperty("name", out var name)
                    ? name.GetString() ?? string.Empty
                    : string.Empty);
    }

    /// <summary>
    /// Reads <c>@timestamp</c>, which arrives either as an ISO-8601 string or as epoch milliseconds
    /// with a fractional part — the exporter writes the latter and Elasticsearch accepts both against
    /// the same <c>date</c> mapping. Handling only one form would work until it silently did not.
    /// </summary>
    private static DateTimeOffset ParseTimestamp(JsonElement source)
    {
        if (!source.TryGetProperty("@timestamp", out var stamp))
        {
            return default;
        }

        var raw = stamp.ValueKind == JsonValueKind.Number
            ? stamp.GetRawText()
            : stamp.GetString() ?? string.Empty;

        if (double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out var epochMillis))
        {
            return DateTimeOffset.FromUnixTimeMilliseconds((long)epochMillis);
        }

        return DateTimeOffset.Parse(raw, CultureInfo.InvariantCulture,
            DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal);
    }

    private static string? Attribute(JsonElement attributes, string key) =>
        attributes.ValueKind == JsonValueKind.Object
        && attributes.TryGetProperty(key, out var value)
            ? value.GetString()
            : null;
}
```

Create `src/tests/BaseApi.Tests/Live/Resilience/WorkflowShape.cs`:

```csharp
namespace BaseApi.Tests.Live.Resilience;

/// <summary>
/// How many dispatches and terminals one fire of a workflow must produce.
/// <para>
/// A parameter rather than two constants inside the ledger: the ledger is a statement about any
/// workflow's round trip, and baking one graph's numbers into it would make every future workflow
/// need a second oracle.
/// </para>
/// </summary>
/// <param name="Dispatches">Step executions per fire — one entry dispatch plus every handoff.</param>
/// <param name="Terminals">Branches that end without a successor.</param>
internal sealed record WorkflowShape(int Dispatches, int Terminals)
{
    /// <summary>
    /// The seeded workflow: A - B - C - {D1,D2} - {E1,E2} - {F1,F2} - G, where G is reached from
    /// both F1 and F2 and so runs twice. Eleven executions from ten assignments, two terminals.
    /// </summary>
    public static readonly WorkflowShape V8FanoutProof = new(Dispatches: 11, Terminals: 2);
}
```

- [ ] **Step 7: Write the ledger**

Create `src/tests/BaseApi.Tests/Live/Resilience/RunLedger.cs`:

```csharp
namespace BaseApi.Tests.Live.Resilience;

/// <summary>One invariant that did not hold, and the counts that show it.</summary>
/// <param name="Invariant">"I1" through "I6".</param>
/// <param name="Detail">The relation as it actually stood.</param>
internal sealed record LedgerBreach(string Invariant, string Detail);

/// <summary>
/// One run's template histogram, and the six relations that decide whether it lost a step.
/// <para>
/// <b>Six relations rather than a total.</b> Asserting "the run reached 77 records" would pass a run
/// that lost a dispatch and gained a redelivery. Each relation names one hop, so a breach is a
/// diagnosis — which hop dropped it — instead of a boolean.
/// </para>
/// <para>
/// Pure by construction: the input is a bag of records and there is no I/O here, which is what lets
/// the oracle be tested hermetically. An oracle only exercisable by a five-minute live run against a
/// shared cluster is one nobody will trust enough to act on.
/// </para>
/// </summary>
internal sealed class RunLedger
{
    private readonly IReadOnlyDictionary<string, int> _counts;

    private RunLedger(
        string correlationId,
        DateTimeOffset startedAt,
        DateTimeOffset endedAt,
        IReadOnlyDictionary<string, int> counts,
        IReadOnlyList<LedgerBreach> breaches)
    {
        CorrelationId = correlationId;
        StartedAt = startedAt;
        EndedAt = endedAt;
        _counts = counts;
        Breaches = breaches;
    }

    public string CorrelationId { get; }

    /// <summary>The first record of the run — in a complete run, the entry dispatch.</summary>
    public DateTimeOffset StartedAt { get; }

    /// <summary>The last record of the run.</summary>
    public DateTimeOffset EndedAt { get; }

    /// <summary>Every invariant that did not hold. Empty means complete.</summary>
    public IReadOnlyList<LedgerBreach> Breaches { get; }

    public bool IsComplete => Breaches.Count == 0;

    /// <summary>How many records this run emitted for one template. Zero for an absent bucket.</summary>
    public int Count(string template) => _counts.TryGetValue(template, out var n) ? n : 0;

    public static RunLedger From(
        string correlationId, IReadOnlyCollection<LogRecord> records, WorkflowShape shape)
    {
        ArgumentNullException.ThrowIfNull(records);
        ArgumentNullException.ThrowIfNull(shape);

        var counts = Templates.Ledger.ToDictionary(
            template => template,
            template => records.Count(r => r.Template == template),
            StringComparer.Ordinal);

        var dispatched = counts[Templates.EntryDispatched] + counts[Templates.HandoffDispatched];
        var breaches = new List<LedgerBreach>();

        Require(breaches, "I1", counts[Templates.RunningTheStep] == dispatched,
            $"steps started {counts[Templates.RunningTheStep]}, dispatches sent {dispatched}");

        Require(breaches, "I2", counts[Templates.StepReturned] == counts[Templates.RunningTheStep],
            $"steps returned {counts[Templates.StepReturned]}, started {counts[Templates.RunningTheStep]}");

        Require(breaches, "I3", counts[Templates.BranchCompleted] == counts[Templates.StepReturned],
            $"branches persisted {counts[Templates.BranchCompleted]}, returned {counts[Templates.StepReturned]}");

        Require(breaches, "I4", counts[Templates.HandoffDispatched] == counts[Templates.HandedOff],
            $"handoffs dispatched {counts[Templates.HandoffDispatched]}, decided {counts[Templates.HandedOff]}");

        Require(breaches, "I5",
            dispatched == shape.Dispatches && counts[Templates.TerminalCompleted] == shape.Terminals,
            $"dispatches {dispatched} of {shape.Dispatches}, "
            + $"terminals {counts[Templates.TerminalCompleted]} of {shape.Terminals}");

        Require(breaches, "I6", counts[Templates.AuthorConfig] == counts[Templates.RunningTheStep],
            $"author records {counts[Templates.AuthorConfig]}, "
            + $"framework records {counts[Templates.RunningTheStep]} — a mismatch is log loss, not step loss");

        return new RunLedger(
            correlationId,
            records.Count == 0 ? default : records.Min(r => r.Timestamp),
            records.Count == 0 ? default : records.Max(r => r.Timestamp),
            counts,
            breaches);
    }

    private static void Require(List<LedgerBreach> breaches, string invariant, bool held, string detail)
    {
        if (!held)
        {
            breaches.Add(new LedgerBreach(invariant, detail));
        }
    }
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: PASS. `Passed 416, Skipped 7, Total 423`, 0 warnings.

- [ ] **Step 9: Commit**

```bash
git add src/tests/BaseApi.Tests/Live/Resilience/Templates.cs \
        src/tests/BaseApi.Tests/Live/Resilience/LogRecord.cs \
        src/tests/BaseApi.Tests/Live/Resilience/WorkflowShape.cs \
        src/tests/BaseApi.Tests/Live/Resilience/RunLedger.cs \
        src/tests/BaseApi.Tests/Resilience/RunLedgerTests.cs \
        src/tests/BaseApi.Tests/Resilience/Fixtures/complete-run.json \
        src/tests/BaseApi.Tests/BaseApi.Tests.csproj
git commit -m "test: decide a run's completeness from its template histogram"
```

---

### Task 3: The classifier — complete, accounted, or unaccounted

The ledger says whether a run is whole. This says whether an incomplete run had an excuse, and it is where "no lost steps" becomes a testable sentence. Also pure.

**Files:**
- Create: `src/tests/BaseApi.Tests/Live/Resilience/FaultWindow.cs`
- Create: `src/tests/BaseApi.Tests/Live/Resilience/RunClassifier.cs`
- Create: `src/tests/BaseApi.Tests/Resilience/RunClassifierTests.cs`

**Interfaces:**
- Consumes: `LogRecord`, `RunLedger`, `WorkflowShape`, `Templates` from Task 2.
- Produces: `FaultWindow(DateTimeOffset FaultAt, DateTimeOffset HealedAt)` with `FaultWindow.None` and `Overlaps(DateTimeOffset, DateTimeOffset)`; `RunVerdict` enum `{ Complete, Accounted, Unaccounted }`; `RunClassification(RunLedger Ledger, RunVerdict Verdict, IReadOnlyList<string> Excuses, bool Straddles)`; `RunClassifier.Classify(RunLedger, IReadOnlyCollection<LogRecord>, FaultWindow)`.

- [ ] **Step 1: Write the failing test**

Create `src/tests/BaseApi.Tests/Resilience/RunClassifierTests.cs`:

```csharp
using BaseApi.Tests.Live.Resilience;
using Xunit;

namespace BaseApi.Tests.Resilience;

/// <summary>
/// Where "no lost steps" becomes a sentence a test can fail on. A short ledger is forgiven only
/// when the run met the fault AND something on that run says why; everything else is loss.
/// </summary>
public sealed class RunClassifierTests
{
    private static readonly DateTimeOffset T0 = new(2026, 8, 22, 12, 0, 0, TimeSpan.Zero);
    private static readonly FaultWindow Window =
        new(T0 + TimeSpan.FromSeconds(150), T0 + TimeSpan.FromSeconds(220));

    [Fact]
    public void ACompleteRunIsComplete()
    {
        var records = Run(T0, complete: true);

        var classification = RunClassifier.Classify(Ledger(records), records, Window);

        Assert.Equal(RunVerdict.Complete, classification.Verdict);
    }

    /// <summary>
    /// Obligation 1 of the spec: a run that never met the fault has no excuse, and an excuse record
    /// on it does not buy one. Zero tolerance outside the window is what stops a scenario passing
    /// because the pipeline was quietly broken the whole time.
    /// </summary>
    [Fact]
    public void AShortRunClearOfTheWindowIsUnaccountedEvenWithAnExcuse()
    {
        var records = Run(T0, complete: false, excuse: Templates.StoreUnreachable);

        var classification = RunClassifier.Classify(Ledger(records), records, Window);

        Assert.False(classification.Straddles);
        Assert.Equal(RunVerdict.Unaccounted, classification.Verdict);
    }

    [Fact]
    public void AShortRunStraddlingTheWindowWithAnExcuseIsAccounted()
    {
        var records = Run(T0 + TimeSpan.FromSeconds(140), complete: false,
            excuse: Templates.StoreUnreachable);

        var classification = RunClassifier.Classify(Ledger(records), records, Window);

        Assert.True(classification.Straddles);
        Assert.Equal(RunVerdict.Accounted, classification.Verdict);
        Assert.Contains(Templates.StoreUnreachable, classification.Excuses);
    }

    [Fact]
    public void AShortRunStraddlingTheWindowWithNoExcuseIsUnaccounted()
    {
        var records = Run(T0 + TimeSpan.FromSeconds(140), complete: false);

        var classification = RunClassifier.Classify(Ledger(records), records, Window);

        Assert.True(classification.Straddles);
        Assert.Equal(RunVerdict.Unaccounted, classification.Verdict);
        Assert.Empty(classification.Excuses);
    }

    /// <summary>A Failed or Cancelled outcome is a run that ended and said so, not a run that vanished.</summary>
    [Theory]
    [InlineData("Failed")]
    [InlineData("Cancelled")]
    public void ANonCompletedOutcomeInTheWindowIsAnExcuse(string result)
    {
        var records = Run(T0 + TimeSpan.FromSeconds(140), complete: false)
            .Append(Record(T0 + TimeSpan.FromSeconds(160), Templates.EntryStepCompleted, result))
            .ToList();

        var classification = RunClassifier.Classify(Ledger(records), records, Window);

        Assert.Equal(RunVerdict.Accounted, classification.Verdict);
    }

    [Fact]
    public void ACompletedOutcomeIsNotAnExcuse()
    {
        var records = Run(T0 + TimeSpan.FromSeconds(140), complete: false)
            .Append(Record(T0 + TimeSpan.FromSeconds(160), Templates.EntryStepCompleted, "Completed"))
            .ToList();

        var classification = RunClassifier.Classify(Ledger(records), records, Window);

        Assert.Equal(RunVerdict.Unaccounted, classification.Verdict);
    }

    /// <summary>With no fault scheduled nothing straddles, so every short run is loss.</summary>
    [Fact]
    public void UnderNoFaultAShortRunIsAlwaysUnaccounted()
    {
        var records = Run(T0, complete: false, excuse: Templates.StoreUnreachable);

        var classification = RunClassifier.Classify(Ledger(records), records, FaultWindow.None);

        Assert.False(classification.Straddles);
        Assert.Equal(RunVerdict.Unaccounted, classification.Verdict);
    }

    private static RunLedger Ledger(IReadOnlyCollection<LogRecord> records) =>
        RunLedger.From("run", records, WorkflowShape.V8FanoutProof);

    /// <summary>
    /// A synthetic run over five seconds. Complete emits the canonical histogram; incomplete drops
    /// the last dispatch's downstream records, which is what an outage in flight looks like.
    /// </summary>
    private static List<LogRecord> Run(DateTimeOffset start, bool complete, string? excuse = null)
    {
        var steps = complete ? 11 : 10;
        var records = new List<LogRecord>
        {
            Record(start, Templates.EntryDispatched),
        };

        for (var i = 0; i < 10; i++)
        {
            records.Add(Record(start.AddSeconds(1), Templates.HandoffDispatched));
            records.Add(Record(start.AddSeconds(1), Templates.HandedOff));
        }

        for (var i = 0; i < 9; i++)
        {
            records.Add(Record(start.AddSeconds(2), Templates.AdvancedSuccessors));
        }

        for (var i = 0; i < steps; i++)
        {
            records.Add(Record(start.AddSeconds(3), Templates.RunningTheStep));
            records.Add(Record(start.AddSeconds(3), Templates.AuthorConfig));
            records.Add(Record(start.AddSeconds(4), Templates.StepReturned));
            records.Add(Record(start.AddSeconds(4), Templates.BranchCompleted));
        }

        records.Add(Record(start.AddSeconds(5), Templates.EntryStepCompleted, "Completed"));
        records.Add(Record(start.AddSeconds(5), Templates.TerminalCompleted, "Completed"));
        records.Add(Record(start.AddSeconds(5), Templates.TerminalCompleted, "Completed"));

        if (excuse is not null)
        {
            records.Add(Record(start.AddSeconds(4), excuse));
        }

        return records;
    }

    private static LogRecord Record(DateTimeOffset at, string template, string? result = null) =>
        new(at, template, Body: template, CorrelationId: "run", Result: result,
            Service: "orchestrator", Scope: "test");
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: build failure — `FaultWindow`, `RunVerdict`, `RunClassifier` do not exist.

- [ ] **Step 3: Write the fault window**

Create `src/tests/BaseApi.Tests/Live/Resilience/FaultWindow.cs`:

```csharp
namespace BaseApi.Tests.Live.Resilience;

/// <summary>
/// When the fault was injected and when it was observed to heal.
/// <para>
/// <b><see cref="HealedAt"/> is observed, never scheduled.</b> It is the timestamp of the heal
/// record the pipeline actually wrote. RabbitMQ's pod start and topology re-declare take an
/// unbounded time, and a window that assumed "fault plus sixty seconds" would forgive runs the
/// fault had already released, or condemn runs it still held.
/// </para>
/// </summary>
internal sealed record FaultWindow(DateTimeOffset FaultAt, DateTimeOffset HealedAt)
{
    /// <summary>The happy path's window: empty, so nothing straddles and every short run is loss.</summary>
    public static readonly FaultWindow None =
        new(DateTimeOffset.MaxValue, DateTimeOffset.MaxValue);

    public bool IsNone => FaultAt == DateTimeOffset.MaxValue;

    /// <summary>True when a run's span touches the outage at any point.</summary>
    public bool Overlaps(DateTimeOffset startedAt, DateTimeOffset endedAt) =>
        !IsNone && startedAt <= HealedAt && endedAt >= FaultAt;
}
```

- [ ] **Step 4: Write the classifier**

Create `src/tests/BaseApi.Tests/Live/Resilience/RunClassifier.cs`:

```csharp
namespace BaseApi.Tests.Live.Resilience;

/// <summary>What a run's ledger and its excuses add up to.</summary>
internal enum RunVerdict
{
    /// <summary>Every invariant held.</summary>
    Complete,

    /// <summary>Short, but the run met the fault and something on it says why.</summary>
    Accounted,

    /// <summary>Short with no excuse the fault can carry. This is a lost step.</summary>
    Unaccounted,
}

/// <summary>One run's verdict, with the excuses that earned it.</summary>
internal sealed record RunClassification(
    RunLedger Ledger,
    RunVerdict Verdict,
    IReadOnlyList<string> Excuses,
    bool Straddles);

/// <summary>
/// Turns a ledger into a verdict.
/// <para>
/// <b>Two rules, and the first is the load-bearing one.</b> A run clear of the outage is held to
/// completeness absolutely, excuse or no excuse — otherwise a pipeline that was quietly broken for
/// the whole soak would pass every scenario by pointing at a fault it never met. Only a run whose
/// span touches the window may spend an excuse.
/// </para>
/// </summary>
internal static class RunClassifier
{
    public static RunClassification Classify(
        RunLedger ledger, IReadOnlyCollection<LogRecord> records, FaultWindow window)
    {
        ArgumentNullException.ThrowIfNull(ledger);
        ArgumentNullException.ThrowIfNull(records);
        ArgumentNullException.ThrowIfNull(window);

        var straddles = window.Overlaps(ledger.StartedAt, ledger.EndedAt);

        if (ledger.IsComplete)
        {
            return new RunClassification(ledger, RunVerdict.Complete, [], straddles);
        }

        if (!straddles)
        {
            return new RunClassification(ledger, RunVerdict.Unaccounted, [], straddles);
        }

        var excuses = Excuses(records);

        return new RunClassification(
            ledger,
            excuses.Count > 0 ? RunVerdict.Accounted : RunVerdict.Unaccounted,
            excuses,
            straddles);
    }

    /// <summary>
    /// The closed accounting vocabulary, plus an outcome that reported a non-Completed result.
    /// <para>
    /// The result is read from the record's own <c>Result</c> attribute rather than matched out of
    /// the rendered body: the bridge already lands it as a field, and a substring search is a
    /// second, weaker spelling of a fact the record states.
    /// </para>
    /// </summary>
    private static IReadOnlyList<string> Excuses(IReadOnlyCollection<LogRecord> records)
    {
        var vocabulary = records
            .Where(r => Templates.Accounting.Contains(r.Template, StringComparer.Ordinal))
            .Select(r => r.Template);

        var outcomes = records
            .Where(r => r.Template is Templates.EntryStepCompleted or Templates.TerminalCompleted)
            .Where(r => r.Result is "Failed" or "Cancelled")
            .Select(r => $"{r.Template} = {r.Result}");

        return vocabulary.Concat(outcomes).Distinct(StringComparer.Ordinal).ToList();
    }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: PASS. `Passed 424, Skipped 7, Total 431`, 0 warnings.

- [ ] **Step 6: Commit**

```bash
git add src/tests/BaseApi.Tests/Live/Resilience/FaultWindow.cs \
        src/tests/BaseApi.Tests/Live/Resilience/RunClassifier.cs \
        src/tests/BaseApi.Tests/Resilience/RunClassifierTests.cs
git commit -m "test: forgive a short ledger only where the fault can carry it"
```

---

### Task 4: Reading the records out of Elasticsearch

First live unit. It has no test of its own beyond a smoke check, because its correctness is the projection in `LogRecord.FromSource` — already covered hermetically by the fixture loader in Task 2, which reads through the same method.

**Files:**
- Create: `src/tests/BaseApi.Tests/Live/Resilience/ElasticLogReader.cs`
- Create: `src/tests/BaseApi.Tests/Live/Resilience/StabilityWaiter.cs`
- Create: `src/tests/BaseApi.Tests/Live/Resilience/ElasticReaderLiveTests.cs`

**Interfaces:**
- Consumes: `Chaos`, `LogRecord`, `Templates`.
- Produces: `ElasticLogReader(HttpClient)` with `ReadRunRecordsAsync(Guid workflowId, DateTimeOffset from, DateTimeOffset to, CancellationToken)` returning `IReadOnlyList<LogRecord>`, `ReadTemplateRecordsAsync(IReadOnlyCollection<string> templates, DateTimeOffset from, DateTimeOffset to, CancellationToken)` returning `IReadOnlyList<LogRecord>`, and `CountAsync(DateTimeOffset from, DateTimeOffset to, CancellationToken)`; `StabilityWaiter.WaitForStableIngestAsync(ElasticLogReader, DateTimeOffset, DateTimeOffset, CancellationToken)`.

- [ ] **Step 1: Write the failing test**

Create `src/tests/BaseApi.Tests/Live/Resilience/ElasticReaderLiveTests.cs`:

```csharp
using Xunit;

namespace BaseApi.Tests.Live.Resilience;

/// <summary>
/// A smoke check that the reader addresses a real index and projects real records. The projection
/// itself is covered hermetically in RunLedgerTests, which loads its fixture through the same method.
/// </summary>
[Trait("Category", Chaos.Category)]
public sealed class ElasticReaderLiveTests
{
    [Fact]
    public async Task TheReaderProjectsRecordsFromTheLiveIndex()
    {
        Chaos.SkipUnlessEnabled();

        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
        var reader = new ElasticLogReader(http);

        var to = DateTimeOffset.UtcNow;
        var from = to - TimeSpan.FromDays(7);

        var records = await reader.ReadRunRecordsAsync(Chaos.WorkflowId, from, to, TestContext.Current.CancellationToken);

        Assert.NotEmpty(records);
        Assert.All(records, r => Assert.False(string.IsNullOrEmpty(r.Template)));
        Assert.Contains(records, r => r.Template == Templates.EntryDispatched);
        Assert.All(records, r => Assert.InRange(r.Timestamp, from, to));
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: build failure — `ElasticLogReader` does not exist.

- [ ] **Step 3: Write the reader**

Create `src/tests/BaseApi.Tests/Live/Resilience/ElasticLogReader.cs`:

```csharp
using System.Globalization;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;

namespace BaseApi.Tests.Live.Resilience;

/// <summary>
/// Reads log records out of the collector's Elasticsearch data stream.
/// <para>
/// <b>Every query is bounded on both time and workflow.</b> The index here is a single shard holding
/// millions of documents on a shared dev cluster; an unbounded aggregation is slow enough to look
/// like a hang.
/// </para>
/// <para>
/// <b>Paged with search_after rather than from/size.</b> A five-minute soak is roughly 800 records
/// and deep paging past 10,000 is refused outright, so from/size would work right up until a
/// scenario got interesting.
/// </para>
/// </summary>
internal sealed class ElasticLogReader
{
    private static readonly string[] SourceFields =
    [
        "@timestamp", "body.text", "attributes", "scope.name", "resource.attributes.service.name",
    ];

    private const int PageSize = 1000;

    private readonly HttpClient _http;

    public ElasticLogReader(HttpClient http) => _http = http ?? throw new ArgumentNullException(nameof(http));

    /// <summary>
    /// Every record of every run of one workflow in a window. Filtering on WorkflowId is safe:
    /// all 77 records of a complete run carry it, including the entry dispatch, whose own scope
    /// leaves it empty but which is nested inside a fire scope that sets it.
    /// </summary>
    public Task<IReadOnlyList<LogRecord>> ReadRunRecordsAsync(
        Guid workflowId, DateTimeOffset from, DateTimeOffset to, CancellationToken ct) =>
        SearchAsync(
            [
                Range(from, to),
                Term("attributes.WorkflowId", workflowId.ToString("D")),
            ],
            ct);

    /// <summary>
    /// Records matching any of a set of templates, unfiltered by workflow.
    /// <para>
    /// The gate and channel records carry no WorkflowId — they are statements about a process, not
    /// about a run — so the fault witness cannot reuse the query above.
    /// </para>
    /// </summary>
    public Task<IReadOnlyList<LogRecord>> ReadTemplateRecordsAsync(
        IReadOnlyCollection<string> templates, DateTimeOffset from, DateTimeOffset to, CancellationToken ct) =>
        SearchAsync(
            [
                Range(from, to),
                new Dictionary<string, object>
                {
                    ["terms"] = new Dictionary<string, object> { ["attributes.{OriginalFormat}"] = templates },
                },
            ],
            ct);

    /// <summary>How many records one workflow wrote in a window. The settle poll's stability signal.</summary>
    public async Task<long> CountAsync(DateTimeOffset from, DateTimeOffset to, CancellationToken ct)
    {
        var body = new Dictionary<string, object>
        {
            ["query"] = Bool(
            [
                Range(from, to),
                Term("attributes.WorkflowId", Chaos.WorkflowId.ToString("D")),
            ]),
        };

        using var response = await PostAsync($"/{Chaos.LogIndex}/_count", body, ct);
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));

        return document.RootElement.GetProperty("count").GetInt64();
    }

    private async Task<IReadOnlyList<LogRecord>> SearchAsync(
        List<Dictionary<string, object>> filters, CancellationToken ct)
    {
        var records = new List<LogRecord>();
        object[]? searchAfter = null;

        while (true)
        {
            var body = new Dictionary<string, object>
            {
                ["size"] = PageSize,
                ["sort"] = new object[]
                {
                    new Dictionary<string, object> { ["@timestamp"] = "asc" },
                    new Dictionary<string, object> { ["_doc"] = "asc" },
                },
                ["_source"] = SourceFields,
                ["query"] = Bool(filters),
            };

            if (searchAfter is not null)
            {
                body["search_after"] = searchAfter;
            }

            using var response = await PostAsync($"/{Chaos.LogIndex}/_search", body, ct);
            using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));

            var hits = document.RootElement.GetProperty("hits").GetProperty("hits");
            if (hits.GetArrayLength() == 0)
            {
                return records;
            }

            JsonElement last = default;
            foreach (var hit in hits.EnumerateArray())
            {
                records.Add(LogRecord.FromSource(hit.GetProperty("_source")));
                last = hit;
            }

            // Deserialized from raw text so a numeric sort value stays numeric on the way back in.
            // Passing it as a quoted string would make the next page start from a string, which
            // matches nothing and silently truncates the window at 1000 records.
            searchAfter = last.GetProperty("sort").EnumerateArray()
                .Select(e => JsonSerializer.Deserialize<object>(e.GetRawText())!).ToArray();
        }
    }

    private async Task<HttpResponseMessage> PostAsync(
        string path, Dictionary<string, object> body, CancellationToken ct)
    {
        // Encoding.UTF8 explicitly: two of the templates carry U+2014, and a request written in any
        // other encoding is rejected by Elasticsearch as an invalid UTF-8 start byte.
        using var content = new StringContent(
            JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");

        var response = await _http.PostAsync($"{Chaos.ElasticUrl.TrimEnd('/')}{path}", content, ct);
        if (!response.IsSuccessStatusCode)
        {
            var detail = await response.Content.ReadAsStringAsync(ct);
            response.Dispose();
            throw new InvalidOperationException(
                $"elasticsearch {path} returned {(int)response.StatusCode}: {detail}");
        }

        return response;
    }

    private static Dictionary<string, object> Bool(List<Dictionary<string, object>> filters) =>
        new() { ["bool"] = new Dictionary<string, object> { ["filter"] = filters } };

    private static Dictionary<string, object> Term(string field, string value) =>
        new() { ["term"] = new Dictionary<string, object> { [field] = value } };

    private static Dictionary<string, object> Range(DateTimeOffset from, DateTimeOffset to) =>
        new()
        {
            ["range"] = new Dictionary<string, object>
            {
                ["@timestamp"] = new Dictionary<string, object>
                {
                    ["gte"] = from.UtcDateTime.ToString("o", CultureInfo.InvariantCulture),
                    ["lte"] = to.UtcDateTime.ToString("o", CultureInfo.InvariantCulture),
                },
            },
        };
}
```

- [ ] **Step 4: Write the settle poll**

Create `src/tests/BaseApi.Tests/Live/Resilience/StabilityWaiter.cs`:

```csharp
namespace BaseApi.Tests.Live.Resilience;

/// <summary>
/// Waits until the window has stopped growing in Elasticsearch.
/// <para>
/// <b>A stability poll, not a fixed sleep.</b> OTLP export, collector batching and index refresh
/// together give a variable ingest lag; a fixed sleep either wastes minutes or reads a half-ingested
/// window and reports lost steps that are still in flight.
/// </para>
/// </summary>
internal static class StabilityWaiter
{
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan Budget = TimeSpan.FromMinutes(3);

    /// <summary>
    /// Returns once two consecutive counts ten seconds apart agree, or throws when the budget runs
    /// out — a window that never settles is a broken pipeline, not a slow one, and saying so beats
    /// verifying against a moving target.
    /// </summary>
    public static async Task WaitForStableIngestAsync(
        ElasticLogReader reader, DateTimeOffset from, DateTimeOffset to, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(reader);

        var deadline = DateTimeOffset.UtcNow + Budget;
        var previous = -1L;

        while (DateTimeOffset.UtcNow < deadline)
        {
            var current = await reader.CountAsync(from, to, ct);
            if (current == previous && current > 0)
            {
                return;
            }

            previous = current;
            await Task.Delay(PollInterval, ct);
        }

        throw new TimeoutException(
            $"the window {from:o}..{to:o} was still growing after {Budget.TotalMinutes} minutes; "
            + "elasticsearch ingest has not settled and no verdict can be trusted");
    }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Hermetic run first — the new live test must skip, not run:

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: `Passed 424, Skipped 8, Total 432`, 0 warnings.

Then against the cluster, with the forwards open:

```bash
SKP_REALSTACK=1 SKP_CHAOS=1 dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj \
  -- --filter-method "*TheReaderProjectsRecordsFromTheLiveIndex*"
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tests/BaseApi.Tests/Live/Resilience/ElasticLogReader.cs \
        src/tests/BaseApi.Tests/Live/Resilience/StabilityWaiter.cs \
        src/tests/BaseApi.Tests/Live/Resilience/ElasticReaderLiveTests.cs
git commit -m "test: read a window of run records out of elasticsearch"
```

---

### Task 5: The fault levers, and their unconditional restore

The dangerous task. Restore is written before injection, and every lever is released in a `finally`.

**Files:**
- Create: `src/tests/BaseApi.Tests/Live/Resilience/Kubectl.cs`
- Create: `src/tests/BaseApi.Tests/Live/Resilience/ClusterControl.cs`
- Create: `src/tests/BaseApi.Tests/Live/Resilience/ClusterControlLiveTests.cs`

**Interfaces:**
- Consumes: `Chaos`.
- Produces: `Kubectl.RunAsync(CancellationToken, params string[])` returning `(int ExitCode, string Stdout, string Stderr)`; `ClusterControl` with `PauseRedisAsync`, `UnpauseRedisAsync`, `ScaleAsync(string kind, string name, int replicas, CancellationToken)`, `WaitForReadyAsync(string kind, string name, TimeSpan, CancellationToken)`, and the disposable `RedisPause` / `ScaledDown` handles.

- [ ] **Step 1: Write the failing test**

Create `src/tests/BaseApi.Tests/Live/Resilience/ClusterControlLiveTests.cs`:

```csharp
using Xunit;

namespace BaseApi.Tests.Live.Resilience;

/// <summary>
/// Proves the levers move before a five-minute scenario bets on them. The pause here is two
/// seconds — long enough to be real, short enough that an idle stack does not notice.
/// </summary>
[Trait("Category", Chaos.Category)]
public sealed class ClusterControlLiveTests
{
    [Fact]
    public async Task TheRedisPauseIsAcceptedAndReleased()
    {
        Chaos.SkipUnlessEnabled();

        var ct = TestContext.Current.CancellationToken;

        await ClusterControl.PauseRedisAsync(TimeSpan.FromSeconds(2), ct);
        await ClusterControl.UnpauseRedisAsync(ct);

        // The proof the release landed: a command answers immediately afterwards.
        var (exitCode, stdout, _) = await Kubectl.RunAsync(
            ct, "-n", Chaos.Namespace, "exec", "redis-0", "--", "redis-cli", "PING");

        Assert.Equal(0, exitCode);
        Assert.Contains("PONG", stdout, StringComparison.Ordinal);
    }

    /// <summary>
    /// The lever this suite refuses to use for an outage, asserted so the reason stays checked:
    /// redis runs with --save "" --appendonly no, so a restart empties L2 rather than interrupting it.
    /// </summary>
    [Fact]
    public async Task RedisIsConfiguredWithoutPersistenceWhichIsWhyScaleDownIsItsOwnScenario()
    {
        Chaos.SkipUnlessEnabled();

        var ct = TestContext.Current.CancellationToken;

        var (exitCode, stdout, _) = await Kubectl.RunAsync(
            ct, "-n", Chaos.Namespace, "exec", "redis-0", "--",
            "redis-cli", "CONFIG", "GET", "appendonly");

        Assert.Equal(0, exitCode);
        Assert.Contains("no", stdout, StringComparison.Ordinal);
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: build failure — `Kubectl` and `ClusterControl` do not exist.

- [ ] **Step 3: Write the process runner**

Create `src/tests/BaseApi.Tests/Live/Resilience/Kubectl.cs`:

```csharp
using System.Diagnostics;
using System.Text;

namespace BaseApi.Tests.Live.Resilience;

/// <summary>
/// Runs kubectl and captures what it said.
/// <para>
/// <b>Shelling out is unavoidable here.</b> TcpForwarder — the lever the existing live tests use —
/// can only interpose on this process's own connections, never on the pods'. A fault that has to
/// reach a consumer running inside the cluster has to be applied inside the cluster.
/// </para>
/// </summary>
internal static class Kubectl
{
    private static readonly TimeSpan Budget = TimeSpan.FromMinutes(5);

    public static async Task<(int ExitCode, string Stdout, string Stderr)> RunAsync(
        CancellationToken ct, params string[] arguments)
    {
        ArgumentNullException.ThrowIfNull(arguments);

        var info = new ProcessStartInfo("kubectl")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };

        foreach (var argument in arguments)
        {
            info.ArgumentList.Add(argument);
        }

        using var process = new Process { StartInfo = info };
        var stdout = new StringBuilder();
        var stderr = new StringBuilder();

        process.OutputDataReceived += (_, e) => { if (e.Data is not null) stdout.AppendLine(e.Data); };
        process.ErrorDataReceived += (_, e) => { if (e.Data is not null) stderr.AppendLine(e.Data); };

        if (!process.Start())
        {
            throw new InvalidOperationException("kubectl did not start; is it on PATH?");
        }

        process.BeginOutputReadLine();
        process.BeginErrorReadLine();

        using var budget = CancellationTokenSource.CreateLinkedTokenSource(ct);
        budget.CancelAfter(Budget);

        try
        {
            await process.WaitForExitAsync(budget.Token);
        }
        catch (OperationCanceledException)
        {
            try
            {
                process.Kill(entireProcessTree: true);
            }
            catch (InvalidOperationException)
            {
                // Already gone. Nothing to kill, and nothing worth failing a restore over.
            }

            throw;
        }

        return (process.ExitCode, stdout.ToString(), stderr.ToString());
    }

    /// <summary>Runs kubectl and throws when it fails, for steps whose failure must stop the scenario.</summary>
    public static async Task<string> RunOrThrowAsync(CancellationToken ct, params string[] arguments)
    {
        var (exitCode, stdout, stderr) = await RunAsync(ct, arguments);
        if (exitCode != 0)
        {
            throw new InvalidOperationException(
                $"kubectl {string.Join(' ', arguments)} exited {exitCode}: {stderr}");
        }

        return stdout;
    }
}
```

- [ ] **Step 4: Write the levers**

Create `src/tests/BaseApi.Tests/Live/Resilience/ClusterControl.cs`:

```csharp
using System.Globalization;

namespace BaseApi.Tests.Live.Resilience;

/// <summary>
/// The three fault levers, and the restores that must outlive any failure.
/// <para>
/// <b>NetworkPolicy is not among them, and that is a finding rather than a preference.</b> The kind
/// cluster's kindnetd runs with no --network-policy argument: a deny-all-egress policy is accepted by
/// the API server and enforced by nothing. A scenario built on it would inject no fault, observe an
/// uninterrupted happy path, and pass — which is the worst failure available to a resilience suite.
/// </para>
/// <para>
/// <b>CLIENT PAUSE expires on its own deadline</b>, so a killed or crashed run cannot leave Redis
/// wedged. That is why it is re-issued on a keepalive rather than set once for the whole window: a
/// single long pause would lapse early if the scenario overran, silently shortening the outage.
/// </para>
/// </summary>
internal static class ClusterControl
{
    /// <summary>Re-issued well inside the pause it renews, so a slow kubectl cannot leave a gap.</summary>
    private static readonly TimeSpan KeepaliveInterval = TimeSpan.FromSeconds(15);
    private static readonly TimeSpan KeepalivePause = TimeSpan.FromSeconds(45);

    public static async Task PauseRedisAsync(TimeSpan duration, CancellationToken ct) =>
        await Kubectl.RunOrThrowAsync(
            ct, "-n", Chaos.Namespace, "exec", "redis-0", "--", "redis-cli",
            "CLIENT", "PAUSE",
            ((long)duration.TotalMilliseconds).ToString(CultureInfo.InvariantCulture), "ALL");

    public static async Task UnpauseRedisAsync(CancellationToken ct) =>
        await Kubectl.RunOrThrowAsync(
            ct, "-n", Chaos.Namespace, "exec", "redis-0", "--", "redis-cli", "CLIENT", "UNPAUSE");

    public static async Task ScaleAsync(string kind, string name, int replicas, CancellationToken ct) =>
        await Kubectl.RunOrThrowAsync(
            ct, "-n", Chaos.Namespace, "scale", $"{kind}/{name}",
            $"--replicas={replicas.ToString(CultureInfo.InvariantCulture)}");

    /// <summary>
    /// Blocks until every replica of a workload reports ready. Both StatefulSets here declare a
    /// readiness probe and no liveness probe, so ready is the only signal that the dependency is
    /// answering again — and rollout status is the only way to learn it without polling by hand.
    /// </summary>
    public static async Task WaitForReadyAsync(
        string kind, string name, TimeSpan budget, CancellationToken ct) =>
        await Kubectl.RunOrThrowAsync(
            ct, "-n", Chaos.Namespace, "rollout", "status", $"{kind}/{name}",
            $"--timeout={((int)budget.TotalSeconds).ToString(CultureInfo.InvariantCulture)}s");

    /// <summary>
    /// Holds Redis paused until disposed, renewing the pause on a keepalive.
    /// <para>
    /// Disposal releases it explicitly rather than waiting the pause out, so the heal is at a moment
    /// the scenario chose. Even if disposal never runs, the pause lapses on its own — the property
    /// that made this the lever rather than a policy or a scale-down.
    /// </para>
    /// </summary>
    public static async Task<IAsyncDisposable> HoldRedisPausedAsync(CancellationToken ct)
    {
        await PauseRedisAsync(KeepalivePause, ct);
        return new RedisPause();
    }

    /// <summary>Scales a workload to zero and restores it on disposal.</summary>
    public static async Task<IAsyncDisposable> HoldScaledDownAsync(
        string kind, string name, int restoreTo, CancellationToken ct)
    {
        await ScaleAsync(kind, name, 0, ct);
        return new ScaledDown(kind, name, restoreTo);
    }

    private sealed class RedisPause : IAsyncDisposable
    {
        private readonly CancellationTokenSource _stop = new();
        private readonly Task _keepalive;

        /// <summary>
        /// The keepalive runs on its own token, not the scenario's. Releasing the pause is the one
        /// thing that must still happen when the scenario is cancelled.
        /// </summary>
        public RedisPause() => _keepalive = KeepAliveAsync(_stop.Token);

        public async ValueTask DisposeAsync()
        {
            await _stop.CancelAsync();

            try
            {
                await _keepalive;
            }
            catch (OperationCanceledException)
            {
                // The keepalive was told to stop. Expected on every clean path.
            }

            _stop.Dispose();

            // Its own token: the scenario's may already be cancelled, and a release that skipped
            // because the run was aborted is exactly the case the release exists for.
            using var release = new CancellationTokenSource(TimeSpan.FromMinutes(1));
            await UnpauseRedisAsync(release.Token);
        }

        private static async Task KeepAliveAsync(CancellationToken ct)
        {
            while (!ct.IsCancellationRequested)
            {
                await Task.Delay(KeepaliveInterval, ct);
                await PauseRedisAsync(KeepalivePause, ct);
            }
        }
    }

    private sealed class ScaledDown : IAsyncDisposable
    {
        private readonly string _kind;
        private readonly string _name;
        private readonly int _restoreTo;

        public ScaledDown(string kind, string name, int restoreTo)
        {
            _kind = kind;
            _name = name;
            _restoreTo = restoreTo;
        }

        public async ValueTask DisposeAsync()
        {
            using var restore = new CancellationTokenSource(TimeSpan.FromMinutes(6));

            await ScaleAsync(_kind, _name, _restoreTo, restore.Token);
            await WaitForReadyAsync(_kind, _name, TimeSpan.FromMinutes(5), restore.Token);
        }
    }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Hermetic:

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: `Passed 424, Skipped 10, Total 434`, 0 warnings.

Live:

```bash
SKP_REALSTACK=1 SKP_CHAOS=1 dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj \
  -- --filter-method "*TheRedisPauseIsAcceptedAndReleased*"
```

Expected: PASS. Afterwards confirm Redis is answering: `kubectl -n skp exec redis-0 -- redis-cli PING` prints `PONG`.

- [ ] **Step 6: Commit**

```bash
git add src/tests/BaseApi.Tests/Live/Resilience/Kubectl.cs \
        src/tests/BaseApi.Tests/Live/Resilience/ClusterControl.cs \
        src/tests/BaseApi.Tests/Live/Resilience/ClusterControlLiveTests.cs
git commit -m "test: pause redis and scale the broker, releasing both unconditionally"
```

---

### Task 6: Witnessing the fault, and corroborating it with metrics

The task that keeps §4.1's finding from ever recurring: a scenario that cannot see its fault arrive fails as inconclusive rather than passing.

**Files:**
- Create: `src/tests/BaseApi.Tests/Live/Resilience/FaultWitness.cs`
- Create: `src/tests/BaseApi.Tests/Live/Resilience/PromReader.cs`

**Interfaces:**
- Consumes: `ElasticLogReader`, `Templates`, `Chaos`, `FaultWindow`.
- Produces: `FaultKind` enum `{ None, Redis, Rabbit, Both }`; `FaultWitness.WitnessAsync(ElasticLogReader, FaultKind, DateTimeOffset injectedAt, DateTimeOffset searchTo, CancellationToken)` returning `FaultWindow`; `PromReader(HttpClient)` with `InstantAsync(string query, CancellationToken)` returning `double?` and `CorroborationAsync(CancellationToken)` returning `IReadOnlyDictionary<string, double?>`.

- [ ] **Step 1: Write the witness**

Create `src/tests/BaseApi.Tests/Live/Resilience/FaultWitness.cs`:

```csharp
namespace BaseApi.Tests.Live.Resilience;

/// <summary>Which dependency a scenario takes away.</summary>
internal enum FaultKind
{
    None,
    Redis,
    Rabbit,
    Both,
}

/// <summary>
/// Reads the fault's arrival and heal out of the logs.
/// <para>
/// <b>Observed, never assumed, and this is the load-bearing habit of the whole suite.</b> A
/// NetworkPolicy on this cluster is accepted and enforced by nothing; a scenario that trusted its
/// own injection would have reported a clean happy path as a passing outage test. If the arrival
/// record is absent, the scenario is inconclusive — which is a failure, because the alternative is a
/// green result that means nothing.
/// </para>
/// <para>
/// <b>The heal timestamp comes from the record, not the schedule.</b> RabbitMQ's pod start and
/// topology re-declare take an unbounded time; a window that assumed the scheduled restore would
/// forgive runs the fault had already released and condemn runs it still held.
/// </para>
/// </summary>
internal static class FaultWitness
{
    public static async Task<FaultWindow> WitnessAsync(
        ElasticLogReader reader,
        FaultKind kind,
        DateTimeOffset injectedAt,
        DateTimeOffset searchTo,
        CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(reader);

        if (kind == FaultKind.None)
        {
            return FaultWindow.None;
        }

        var arrival = ArrivalTemplates(kind);
        var heal = HealTemplates(kind);

        var records = await reader.ReadTemplateRecordsAsync(
            [.. arrival, .. heal], injectedAt, searchTo, ct);

        var arrived = records
            .Where(r => arrival.Contains(r.Template, StringComparer.Ordinal))
            .OrderBy(r => r.Timestamp)
            .FirstOrDefault();

        if (arrived is null)
        {
            throw new InvalidOperationException(
                $"the {kind} fault was applied at {injectedAt:o} but no process reported it. "
                + $"Expected one of: {string.Join(" | ", arrival)}. "
                + "The scenario is inconclusive: an unobserved fault is indistinguishable from no fault.");
        }

        var healed = records
            .Where(r => heal.Contains(r.Template, StringComparer.Ordinal))
            .Where(r => r.Timestamp > arrived.Timestamp)
            .OrderBy(r => r.Timestamp)
            .LastOrDefault();

        if (healed is null)
        {
            throw new InvalidOperationException(
                $"the {kind} fault arrived at {arrived.Timestamp:o} and nothing reported it healing by "
                + $"{searchTo:o}. Expected one of: {string.Join(" | ", heal)}.");
        }

        return new FaultWindow(arrived.Timestamp, healed.Timestamp);
    }

    private static IReadOnlyList<string> ArrivalTemplates(FaultKind kind) => kind switch
    {
        FaultKind.Redis => [Templates.GateClosed, Templates.StoreUnreachable],
        FaultKind.Rabbit => [Templates.ChannelShutDown, Templates.ConsumptionPaused],
        FaultKind.Both =>
            [Templates.GateClosed, Templates.StoreUnreachable,
             Templates.ChannelShutDown, Templates.ConsumptionPaused],
        _ => [],
    };

    private static IReadOnlyList<string> HealTemplates(FaultKind kind) => kind switch
    {
        FaultKind.Redis => [Templates.GateOpen],
        FaultKind.Rabbit => [Templates.ConnectionRecovered, Templates.ConsumptionAdmitted],
        FaultKind.Both =>
            [Templates.GateOpen, Templates.ConnectionRecovered, Templates.ConsumptionAdmitted],
        _ => [],
    };
}
```

- [ ] **Step 2: Write the corroboration reader**

Create `src/tests/BaseApi.Tests/Live/Resilience/PromReader.cs`:

```csharp
using System.Text.Json;

namespace BaseApi.Tests.Live.Resilience;

/// <summary>
/// Reads the pipeline instruments, for the report only. No verdict depends on this.
/// <para>
/// <b>These are exported names, and they are not the instrument names.</b> Every gauge declares unit
/// "1", for which the OpenTelemetry Prometheus exporter appends _ratio — the code creates
/// pipeline.gate.open and Prometheus serves pipeline_gate_open_ratio. The names below were read back
/// from the live server rather than derived; an earlier draft elsewhere in this repo queried the
/// unsuffixed forms and would have matched nothing.
/// </para>
/// <para>
/// <b>A counter with no observations is absent, not zero.</b> pipeline_gate_trips_total has no series
/// until the gate first trips, so its appearance is itself the evidence. Every query returns a
/// nullable and a missing series is reported as "no series", never as an error or a zero.
/// </para>
/// </summary>
internal sealed class PromReader
{
    private static readonly IReadOnlyDictionary<string, string> Corroboration =
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["gate trips"] = "sum(pipeline_gate_trips_total)",
            ["gate open"] = "min(pipeline_gate_open_ratio)",
            ["channel resets"] = "sum(pipeline_consumer_channel_resets_total)",
            ["consumers consuming"] = "min(pipeline_consumer_consuming_ratio)",
            ["transient sends"] = "sum(pipeline_messages_produced_total{outcome=\"transient\"})",
            ["requeued or parked"] =
                "sum(pipeline_messages_consumed_total{disposition=~\"requeued|parked\"})",
            ["inflight"] = "sum(pipeline_consumer_inflight)",
        };

    private readonly HttpClient _http;

    public PromReader(HttpClient http) => _http = http ?? throw new ArgumentNullException(nameof(http));

    /// <summary>The current value of an instant query, or null when the series does not exist.</summary>
    public async Task<double?> InstantAsync(string query, CancellationToken ct)
    {
        // Uri.EscapeDataString rather than HttpUtility.UrlEncode: the latter lives in a separate
        // assembly this test project has no reason to take a dependency on, and the queries below
        // carry braces, quotes and regex pipes that must survive intact.
        var url = $"{Chaos.PrometheusUrl.TrimEnd('/')}/api/v1/query?query={Uri.EscapeDataString(query)}";

        using var response = await _http.GetAsync(url, ct);
        if (!response.IsSuccessStatusCode)
        {
            return null;
        }

        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
        var result = document.RootElement.GetProperty("data").GetProperty("result");

        if (result.GetArrayLength() == 0)
        {
            return null;
        }

        var raw = result[0].GetProperty("value")[1].GetString();

        return double.TryParse(raw, out var value) ? value : null;
    }

    /// <summary>Every corroborating series, for printing beside a verdict.</summary>
    public async Task<IReadOnlyDictionary<string, double?>> CorroborationAsync(CancellationToken ct)
    {
        var readings = new Dictionary<string, double?>(StringComparer.Ordinal);

        foreach (var (label, query) in Corroboration)
        {
            readings[label] = await InstantAsync(query, ct);
        }

        return readings;
    }
}
```

- [ ] **Step 3: Verify the build**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: `Passed 424, Skipped 10, Total 434`, 0 warnings. No new tests — both units are exercised by the scenarios from Task 7 onward.

- [ ] **Step 4: Commit**

```bash
git add src/tests/BaseApi.Tests/Live/Resilience/FaultWitness.cs \
        src/tests/BaseApi.Tests/Live/Resilience/PromReader.cs
git commit -m "test: witness the fault in the logs rather than trusting the injection"
```

---

### Task 7: The soak skeleton

**Files:**
- Create: `src/tests/BaseApi.Tests/Live/Resilience/OrchestrationSoak.cs`

**Interfaces:**
- Consumes: everything from Tasks 1–6, plus `RealStack.BaseApiUrl`.
- Produces: `FaultSchedule(FaultKind Kind, Func<CancellationToken, Task<IAsyncDisposable>> Inject)` with `FaultSchedule.None`; `SoakResult(IReadOnlyList<RunClassification> Runs, FaultWindow Window, IReadOnlyDictionary<string, double?> Metrics, DateTimeOffset StartedAt, DateTimeOffset StoppedAt)`; `OrchestrationSoak.RunAsync(FaultSchedule, CancellationToken)`.

- [ ] **Step 1: Write the skeleton**

Create `src/tests/BaseApi.Tests/Live/Resilience/OrchestrationSoak.cs`:

```csharp
using System.Net.Http.Json;

namespace BaseApi.Tests.Live.Resilience;

/// <summary>What fault a scenario injects, and how.</summary>
/// <param name="Kind">Which dependency goes away, for the witness to look for.</param>
/// <param name="Inject">Applies the fault and returns the handle whose disposal releases it.</param>
internal sealed record FaultSchedule(
    FaultKind Kind,
    Func<CancellationToken, Task<IAsyncDisposable>> Inject)
{
    public static readonly FaultSchedule None =
        new(FaultKind.None, _ => Task.FromResult<IAsyncDisposable>(new NoFault()));

    private sealed class NoFault : IAsyncDisposable
    {
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}

/// <summary>Everything one soak observed.</summary>
internal sealed record SoakResult(
    IReadOnlyList<RunClassification> Runs,
    FaultWindow Window,
    IReadOnlyDictionary<string, double?> Metrics,
    DateTimeOffset StartedAt,
    DateTimeOffset StoppedAt);

/// <summary>
/// The five-minute skeleton every scenario shares: drain, start, inject at 150s, release at 210s,
/// stop at 300s, settle, then read one window out of Elasticsearch and classify every run in it.
/// <para>
/// <b>The fault sits at 150-210s deliberately.</b> At a thirty-second cron that leaves roughly five
/// clean runs before it, two straddling it, and three after — and it is the last group that proves
/// recovery, which is the assertion a shorter soak cannot make.
/// </para>
/// </summary>
internal static class OrchestrationSoak
{
    private static readonly TimeSpan DrainCheck = TimeSpan.FromSeconds(40);
    private static readonly TimeSpan InjectAt = TimeSpan.FromSeconds(150);
    private static readonly TimeSpan ReleaseAt = TimeSpan.FromSeconds(210);
    private static readonly TimeSpan StopAt = TimeSpan.FromSeconds(300);
    private static readonly TimeSpan Settle = TimeSpan.FromSeconds(60);

    public static async Task<SoakResult> RunAsync(FaultSchedule schedule, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(schedule);

        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
        var reader = new ElasticLogReader(http);
        var prometheus = new PromReader(http);

        await StopWorkflowAsync(http, ct);
        await AssertDrainedAsync(reader, ct);

        var startedAt = DateTimeOffset.UtcNow;
        await StartWorkflowAsync(http, ct);

        DateTimeOffset injectedAt;

        try
        {
            await Task.Delay(InjectAt, ct);

            injectedAt = DateTimeOffset.UtcNow;
            var fault = await schedule.Inject(ct);

            try
            {
                await Task.Delay(ReleaseAt - InjectAt, ct);
            }
            finally
            {
                // Released before the soak's remaining time, and unconditionally: a scenario that
                // threw mid-window must still hand the cluster back.
                await fault.DisposeAsync();
            }

            await Task.Delay(StopAt - ReleaseAt, ct);
        }
        finally
        {
            await StopWorkflowAsync(http, ct);
        }

        var stoppedAt = DateTimeOffset.UtcNow;
        var windowEnd = stoppedAt + Settle;

        await Task.Delay(Settle, ct);
        await StabilityWaiter.WaitForStableIngestAsync(reader, startedAt, windowEnd, ct);

        var window = await FaultWitness.WitnessAsync(
            reader, schedule.Kind, injectedAt, windowEnd, ct);

        var records = await reader.ReadRunRecordsAsync(Chaos.WorkflowId, startedAt, windowEnd, ct);

        var runs = records
            .Where(r => r.CorrelationId is not null)
            .GroupBy(r => r.CorrelationId!, StringComparer.Ordinal)
            .Select(g =>
            {
                var run = g.ToList();
                return RunClassifier.Classify(
                    RunLedger.From(g.Key, run, WorkflowShape.V8FanoutProof), run, window);
            })
            .OrderBy(c => c.Ledger.StartedAt)
            .ToList();

        return new SoakResult(
            runs, window, await prometheus.CorroborationAsync(ct), startedAt, stoppedAt);
    }

    /// <summary>
    /// Refuses to start on top of a run already in progress. It cannot catch a run someone else
    /// starts mid-soak — this suite assumes exclusive use of the cluster and says so rather than
    /// pretending to detect it.
    /// </summary>
    private static async Task AssertDrainedAsync(ElasticLogReader reader, CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        var recent = await reader.ReadTemplateRecordsAsync(
            [Templates.EntryDispatched], now - DrainCheck, now, ct);

        if (recent.Count > 0)
        {
            throw new InvalidOperationException(
                $"{recent.Count} entry dispatch(es) in the last {DrainCheck.TotalSeconds}s: the "
                + "workflow is still firing. Stop it and let it drain before starting a scenario.");
        }
    }

    private static async Task StartWorkflowAsync(HttpClient http, CancellationToken ct)
    {
        using var response = await http.PostAsJsonAsync(
            $"{RealStack.BaseApiUrl}/api/v1/orchestration/start", Chaos.WorkflowId, ct);

        response.EnsureSuccessStatusCode();
    }

    private static async Task StopWorkflowAsync(HttpClient http, CancellationToken ct)
    {
        using var response = await http.PostAsJsonAsync(
            $"{RealStack.BaseApiUrl}/api/v1/orchestration/stop", Chaos.WorkflowId, ct);

        response.EnsureSuccessStatusCode();
    }
}
```

- [ ] **Step 2: Verify the build**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: `Passed 424, Skipped 10, Total 434`, 0 warnings.

- [ ] **Step 3: Commit**

```bash
git add src/tests/BaseApi.Tests/Live/Resilience/OrchestrationSoak.cs
git commit -m "test: drive a five-minute orchestration around a scheduled fault"
```

---

### Task 8: S1 — the happy path

The scenario that must pass before any outage scenario means anything.

**Files:**
- Create: `src/tests/BaseApi.Tests/Live/Resilience/SoakReport.cs`
- Create: `src/tests/BaseApi.Tests/Live/Resilience/HappyPathScenarioTests.cs`

**Interfaces:**
- Consumes: `OrchestrationSoak`, `SoakResult`, `RunVerdict`.
- Produces: `SoakReport.Describe(SoakResult)` returning `string`.

- [ ] **Step 1: Write the failing test**

Create `src/tests/BaseApi.Tests/Live/Resilience/HappyPathScenarioTests.cs`:

```csharp
using Xunit;

namespace BaseApi.Tests.Live.Resilience;

/// <summary>
/// S1. Five minutes of undisturbed orchestration, every run whole.
/// <para>
/// This is the scenario the other four are measured against. If the round trip drops a step with
/// nothing broken, no outage result below carries any information.
/// </para>
/// </summary>
[Trait("Category", Chaos.Category)]
public sealed class HappyPathScenarioTests
{
    [Fact]
    public async Task EveryRunCompletesWhenNothingIsTakenAway()
    {
        Chaos.SkipUnlessEnabled();

        var result = await OrchestrationSoak.RunAsync(
            FaultSchedule.None, TestContext.Current.CancellationToken);

        var report = SoakReport.Describe(result);

        Assert.True(result.Runs.Count >= 9,
            $"expected at least 9 fires in five minutes at a 30s cron, saw {result.Runs.Count}.\n{report}");

        Assert.All(result.Runs, run =>
            Assert.True(run.Verdict == RunVerdict.Complete,
                $"run {run.Ledger.CorrelationId} was {run.Verdict}: "
                + $"{string.Join("; ", run.Ledger.Breaches.Select(b => $"{b.Invariant} {b.Detail}"))}"));
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: build failure — `SoakReport` does not exist.

- [ ] **Step 3: Write the report**

Create `src/tests/BaseApi.Tests/Live/Resilience/SoakReport.cs`:

```csharp
using System.Globalization;
using System.Text;

namespace BaseApi.Tests.Live.Resilience;

/// <summary>
/// Renders a soak so a failure arrives with its evidence attached.
/// <para>
/// A five-minute scenario against a shared cluster is expensive to repeat, so a failure that says
/// only "expected Complete" costs another five minutes to understand. The breaches name the hop and
/// the metrics say whether the fault landed.
/// </para>
/// </summary>
internal static class SoakReport
{
    public static string Describe(SoakResult result)
    {
        ArgumentNullException.ThrowIfNull(result);

        var report = new StringBuilder();
        report.AppendLine(CultureInfo.InvariantCulture,
            $"soak {result.StartedAt:o} .. {result.StoppedAt:o}");
        report.AppendLine(result.Window.IsNone
            ? "fault window: none"
            : $"fault window: {result.Window.FaultAt:o} .. {result.Window.HealedAt:o} (observed)");
        report.AppendLine(CultureInfo.InvariantCulture, $"runs: {result.Runs.Count}");

        foreach (var group in result.Runs.GroupBy(r => r.Verdict))
        {
            report.AppendLine(CultureInfo.InvariantCulture, $"  {group.Key}: {group.Count()}");
        }

        foreach (var run in result.Runs.Where(r => r.Verdict != RunVerdict.Complete))
        {
            report.AppendLine(CultureInfo.InvariantCulture,
                $"  {run.Ledger.CorrelationId} {run.Verdict} "
                + $"(straddles={run.Straddles}) {run.Ledger.StartedAt:HH:mm:ss}");

            foreach (var breach in run.Ledger.Breaches)
            {
                report.AppendLine(CultureInfo.InvariantCulture, $"      {breach.Invariant}: {breach.Detail}");
            }

            foreach (var excuse in run.Excuses)
            {
                report.AppendLine(CultureInfo.InvariantCulture, $"      excuse: {excuse}");
            }
        }

        report.AppendLine("metrics (corroboration only):");
        foreach (var (label, value) in result.Metrics)
        {
            report.AppendLine(CultureInfo.InvariantCulture,
                $"  {label}: {(value is null ? "no series" : value.Value.ToString(CultureInfo.InvariantCulture))}");
        }

        return report.ToString();
    }
}
```

- [ ] **Step 4: Run the scenario**

Hermetic first — it must skip:

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: `Passed 424, Skipped 11, Total 435`, 0 warnings.

Live, with the forwards open. This takes about seven minutes:

```bash
SKP_REALSTACK=1 SKP_CHAOS=1 dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj \
  -- --filter-method "*EveryRunCompletesWhenNothingIsTakenAway*"
```

Expected: PASS with 10 complete runs.

**If it fails with 9 or 10 runs but one incomplete**, read the breach. An `I6` breach alone is log loss, not step loss — re-run before treating it as a defect. Any other breach is a real finding and should be reported rather than tuned away.

- [ ] **Step 5: Commit**

```bash
git add src/tests/BaseApi.Tests/Live/Resilience/SoakReport.cs \
        src/tests/BaseApi.Tests/Live/Resilience/HappyPathScenarioTests.cs
git commit -m "test: prove the undisturbed round trip loses no step"
```

---

### Task 9: The outage verdict, and S2 — Redis unavailable

**Files:**
- Create: `src/tests/BaseApi.Tests/Live/Resilience/OutageVerdict.cs`
- Create: `src/tests/BaseApi.Tests/Live/Resilience/RedisUnavailableScenarioTests.cs`

**Interfaces:**
- Consumes: `SoakResult`, `RunClassification`, `RunVerdict`, `SoakReport`, `ClusterControl`.
- Produces: `OutageVerdict.AssertNoUnaccountedLoss(SoakResult)`.

- [ ] **Step 1: Write the failing test**

Create `src/tests/BaseApi.Tests/Live/Resilience/RedisUnavailableScenarioTests.cs`:

```csharp
using Xunit;

namespace BaseApi.Tests.Live.Resilience;

/// <summary>
/// S2. Redis is made unavailable for a minute in the middle of a five-minute orchestration, without
/// losing its data.
/// <para>
/// <b>CLIENT PAUSE, not a scale-down and not a NetworkPolicy.</b> Redis here runs with
/// --save "" --appendonly no, so scaling it to zero destroys L2 rather than interrupting it — that is
/// S5, and it cannot satisfy "no lost steps" by construction. A NetworkPolicy is accepted by this
/// cluster's API server and enforced by nothing at all.
/// </para>
/// <para>
/// The pause surfaces as RedisTimeoutException, which L2FaultClassifier names alongside the
/// connection fault, so DeliveryClassifier returns RequeueAndTrip: the message goes back to its queue
/// and the gate closes. That is the same disposition a refused connection would take, through a
/// branch the code documents.
/// </para>
/// </summary>
[Trait("Category", Chaos.Category)]
public sealed class RedisUnavailableScenarioTests
{
    [Fact]
    public async Task NoStepIsLostWhileRedisIsUnavailable()
    {
        Chaos.SkipUnlessEnabled();

        var result = await OrchestrationSoak.RunAsync(
            new FaultSchedule(FaultKind.Redis, ClusterControl.HoldRedisPausedAsync),
            TestContext.Current.CancellationToken);

        OutageVerdict.AssertNoUnaccountedLoss(result);
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: build failure — `OutageVerdict` does not exist.

- [ ] **Step 3: Write the verdict**

Create `src/tests/BaseApi.Tests/Live/Resilience/OutageVerdict.cs`:

```csharp
using Xunit;

namespace BaseApi.Tests.Live.Resilience;

/// <summary>
/// The three obligations an outage scenario must meet. Shared by S2, S3 and S4, which differ only in
/// what they take away.
/// </summary>
internal static class OutageVerdict
{
    public static void AssertNoUnaccountedLoss(SoakResult result)
    {
        ArgumentNullException.ThrowIfNull(result);

        var report = SoakReport.Describe(result);

        Assert.True(result.Runs.Count >= 9,
            $"expected at least 9 fires in five minutes at a 30s cron, saw {result.Runs.Count}.\n{report}");

        // Obligation 1. A run that never met the fault has no excuse, and RunClassifier already
        // refuses to spend one on it — so anything short and clear of the window lands here.
        var clearOfWindow = result.Runs
            .Where(r => !r.Straddles && r.Verdict != RunVerdict.Complete)
            .ToList();

        Assert.True(clearOfWindow.Count == 0,
            $"{clearOfWindow.Count} run(s) outside the fault window were incomplete. A run that never "
            + $"met the outage has no excuse.\n{report}");

        // Obligation 2. Inside the window a run may be short, but only with a record saying why.
        var unaccounted = result.Runs.Where(r => r.Verdict == RunVerdict.Unaccounted).ToList();

        Assert.True(unaccounted.Count == 0,
            $"{unaccounted.Count} run(s) lost steps with nothing on the run to account for it. "
            + $"This is the loss the scenario exists to detect.\n{report}");

        // Obligation 3. The pipeline heals within one cron period.
        var afterHeal = result.Runs
            .Where(r => r.Ledger.StartedAt > result.Window.HealedAt)
            .ToList();

        Assert.True(afterHeal.Count > 0,
            $"no run began after the fault healed at {result.Window.HealedAt:o}, so recovery was "
            + $"never exercised. Lengthen the soak or shorten the outage.\n{report}");

        Assert.True(afterHeal[0].Verdict == RunVerdict.Complete,
            $"the first run after the heal ({afterHeal[0].Ledger.CorrelationId}) was "
            + $"{afterHeal[0].Verdict}; the pipeline did not recover within one cron period.\n{report}");
    }
}
```

- [ ] **Step 4: Run the scenario**

Hermetic:

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: `Passed 424, Skipped 12, Total 436`, 0 warnings.

Live:

```bash
SKP_REALSTACK=1 SKP_CHAOS=1 dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj \
  -- --filter-method "*NoStepIsLostWhileRedisIsUnavailable*"
```

Expected: PASS. Then confirm the cluster was handed back: `kubectl -n skp exec redis-0 -- redis-cli PING` prints `PONG`.

**If `FaultWitness` throws "no process reported it"**, the pause did not reach the consumers — check that `redis-0` is the pod name and that the keepalive is running. Do not weaken the witness; an unobserved fault is the failure mode this whole suite is built around.

- [ ] **Step 5: Commit**

```bash
git add src/tests/BaseApi.Tests/Live/Resilience/OutageVerdict.cs \
        src/tests/BaseApi.Tests/Live/Resilience/RedisUnavailableScenarioTests.cs
git commit -m "test: lose no step while redis is paused"
```

---

### Task 10: S3 and S4 — RabbitMQ, and both at once

**Files:**
- Create: `src/tests/BaseApi.Tests/Live/Resilience/RabbitUnavailableScenarioTests.cs`
- Create: `src/tests/BaseApi.Tests/Live/Resilience/BothUnavailableScenarioTests.cs`

**Interfaces:**
- Consumes: `OrchestrationSoak`, `FaultSchedule`, `FaultKind`, `ClusterControl`, `OutageVerdict`.
- Produces: nothing further.

- [ ] **Step 1: Write S3**

Create `src/tests/BaseApi.Tests/Live/Resilience/RabbitUnavailableScenarioTests.cs`:

```csharp
using Xunit;

namespace BaseApi.Tests.Live.Resilience;

/// <summary>
/// S3. The broker is scaled to zero for a minute mid-orchestration.
/// <para>
/// <b>Scale-down is the right lever here, where it is the wrong one for Redis.</b> The RabbitMQ
/// StatefulSet provisions a 1Gi per-pod PVC on the mnesia directory, so queues and durable messages
/// survive the pod. It also declares no liveness probe, so nothing restarts it underneath the test.
/// </para>
/// <para>
/// Unacknowledged deliveries return to their queues when the channel dies, so the expectation is
/// redelivery and completion rather than merely a survivable failure.
/// </para>
/// </summary>
[Trait("Category", Chaos.Category)]
public sealed class RabbitUnavailableScenarioTests
{
    [Fact]
    public async Task NoStepIsLostWhileTheBrokerIsDown()
    {
        Chaos.SkipUnlessEnabled();

        var result = await OrchestrationSoak.RunAsync(
            new FaultSchedule(
                FaultKind.Rabbit,
                ct => ClusterControl.HoldScaledDownAsync("statefulset", "rabbitmq", 1, ct)),
            TestContext.Current.CancellationToken);

        OutageVerdict.AssertNoUnaccountedLoss(result);
    }
}
```

- [ ] **Step 2: Write S4**

Create `src/tests/BaseApi.Tests/Live/Resilience/BothUnavailableScenarioTests.cs`:

```csharp
using Xunit;

namespace BaseApi.Tests.Live.Resilience;

/// <summary>
/// S4. Redis and the broker are taken away over one window.
/// <para>
/// <b>The order is load-bearing in both directions.</b> Redis is paused first and released last, so
/// the broker's whole outage — including its pod start, which is unbounded — sits inside the Redis
/// fault. On the way back the consumer needs its channel before the gate reopens; reopening the gate
/// against a broker that is not there yet interleaves the heal records in an order the witness would
/// have to special-case.
/// </para>
/// <para>
/// The Redis pause is renewed on a keepalive throughout, so a slow broker start cannot let it lapse
/// and quietly turn this into S3 with a longer preamble.
/// </para>
/// </summary>
[Trait("Category", Chaos.Category)]
public sealed class BothUnavailableScenarioTests
{
    [Fact]
    public async Task NoStepIsLostWhileBothDependenciesAreUnavailable()
    {
        Chaos.SkipUnlessEnabled();

        var result = await OrchestrationSoak.RunAsync(
            new FaultSchedule(FaultKind.Both, InjectBothAsync),
            TestContext.Current.CancellationToken);

        OutageVerdict.AssertNoUnaccountedLoss(result);
    }

    private static async Task<IAsyncDisposable> InjectBothAsync(CancellationToken ct)
    {
        var redis = await ClusterControl.HoldRedisPausedAsync(ct);

        try
        {
            var rabbit = await ClusterControl.HoldScaledDownAsync("statefulset", "rabbitmq", 1, ct);
            return new BothFaults(redis, rabbit);
        }
        catch
        {
            // The broker never went down, so release Redis rather than leaving it paused behind a
            // scenario that is about to fail.
            await redis.DisposeAsync();
            throw;
        }
    }

    /// <summary>Releases the broker first, then Redis — the reverse of the order they were applied.</summary>
    private sealed class BothFaults : IAsyncDisposable
    {
        private readonly IAsyncDisposable _redis;
        private readonly IAsyncDisposable _rabbit;

        public BothFaults(IAsyncDisposable redis, IAsyncDisposable rabbit)
        {
            _redis = redis;
            _rabbit = rabbit;
        }

        public async ValueTask DisposeAsync()
        {
            try
            {
                await _rabbit.DisposeAsync();
            }
            finally
            {
                // In a finally: a broker that failed to come back must not strand Redis paused.
                await _redis.DisposeAsync();
            }
        }
    }
}
```

- [ ] **Step 3: Run the scenarios**

Hermetic:

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: `Passed 424, Skipped 14, Total 438`, 0 warnings.

Live, one at a time — each takes about eight minutes because the broker's pod start is inside the window:

```bash
SKP_REALSTACK=1 SKP_CHAOS=1 dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj \
  -- --filter-method "*NoStepIsLostWhileTheBrokerIsDown*"

SKP_REALSTACK=1 SKP_CHAOS=1 dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj \
  -- --filter-method "*NoStepIsLostWhileBothDependenciesAreUnavailable*"
```

Expected: PASS. After each, confirm the cluster is whole:

```bash
kubectl -n skp get sts rabbitmq redis
kubectl -n skp exec redis-0 -- redis-cli PING
```

- [ ] **Step 4: Commit**

```bash
git add src/tests/BaseApi.Tests/Live/Resilience/RabbitUnavailableScenarioTests.cs \
        src/tests/BaseApi.Tests/Live/Resilience/BothUnavailableScenarioTests.cs
git commit -m "test: lose no step while the broker, or both dependencies, are away"
```

---

### Task 11: S5 — the L2 wipe, and the docs

The scenario with a different verdict, because it asks a different question: not "did we lose a step" but "how much, and can we see it".

**Files:**
- Create: `src/tests/BaseApi.Tests/Live/Resilience/RedisWipeScenarioTests.cs`
- Modify: `k8s/README.md`
- Modify: `docs/superpowers/specs/2026-08-22-live-stack-resilience-scenarios-design.md` — status line only

**Interfaces:**
- Consumes: everything above.
- Produces: nothing further.

- [ ] **Step 1: Write S5**

Create `src/tests/BaseApi.Tests/Live/Resilience/RedisWipeScenarioTests.cs`:

```csharp
using Xunit;

namespace BaseApi.Tests.Live.Resilience;

/// <summary>
/// S5. Redis is scaled to zero, which does not make L2 unavailable — it destroys it.
/// <para>
/// <b>Why this is its own scenario and not a variant of S2.</b> Redis runs with
/// --save "" --appendonly no and has no volumeClaimTemplates: persistence is off by design. Scaling
/// to zero therefore takes every in-flight step blob, the projected workflow, and every processor
/// liveness key with it. A redelivered dispatch then finds its entry gone, and the processor logs
/// "entry absent - treating as a duplicate delivery" and drops it. That is a genuinely lost step
/// which, in the logs, is indistinguishable from correct duplicate suppression.
/// </para>
/// <para>
/// So "no lost steps" is unachievable here — not because the system is broken, but because the fault
/// destroyed the state recovery would have used. What is worth asserting instead is that the blast
/// radius is bounded, that the wipe is visible, and that recovery is total.
/// </para>
/// </summary>
[Trait("Category", Chaos.Category)]
public sealed class RedisWipeScenarioTests
{
    [Fact]
    public async Task TheWipeIsBoundedVisibleAndFullyRecoveredFrom()
    {
        Chaos.SkipUnlessEnabled();

        var result = await OrchestrationSoak.RunAsync(
            new FaultSchedule(
                FaultKind.Redis,
                ct => ClusterControl.HoldScaledDownAsync("statefulset", "redis", 1, ct)),
            TestContext.Current.CancellationToken);

        var report = SoakReport.Describe(result);

        // Bounded: nothing clear of the window may be short. The wipe must not reach past itself.
        var clearOfWindow = result.Runs
            .Where(r => !r.Straddles && r.Verdict != RunVerdict.Complete)
            .ToList();

        Assert.True(clearOfWindow.Count == 0,
            $"{clearOfWindow.Count} run(s) outside the wipe window were incomplete; the blast radius "
            + $"is wider than the outage.\n{report}");

        // Recovery is total: the first fire after the heal walks the whole graph again, which also
        // proves the processor rewrote its liveness key and the orchestrator resumed dispatching.
        var afterHeal = result.Runs
            .Where(r => r.Ledger.StartedAt > result.Window.HealedAt)
            .ToList();

        Assert.True(afterHeal.Count > 0,
            $"no run began after the wipe healed at {result.Window.HealedAt:o}.\n{report}");

        Assert.True(afterHeal[0].Verdict == RunVerdict.Complete,
            $"the first run after the wipe ({afterHeal[0].Ledger.CorrelationId}) was "
            + $"{afterHeal[0].Verdict}; the pipeline did not recover from an empty L2.\n{report}");

        // Visible: report what the wipe cost rather than asserting a number. The count is a property
        // of where the outage landed relative to the cron, not of the system's correctness, so
        // pinning it would make this test fail on timing.
        var truncated = result.Runs.Where(r => r.Straddles && r.Verdict != RunVerdict.Complete).ToList();

        Assert.All(result.Runs, run =>
            Assert.True(run.Verdict != RunVerdict.Unaccounted || run.Straddles,
                $"run {run.Ledger.CorrelationId} lost steps outside the wipe window.\n{report}"));

        TestContext.Current.TestOutputHelper?.WriteLine(
            $"the L2 wipe truncated {truncated.Count} run(s) of {result.Runs.Count}.\n{report}");
    }
}
```

- [ ] **Step 2: Run the scenario**

Hermetic:

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: `Passed 424, Skipped 15, Total 439`, 0 warnings.

Live:

```bash
SKP_REALSTACK=1 SKP_CHAOS=1 dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj \
  -- --filter-method "*TheWipeIsBoundedVisibleAndFullyRecoveredFrom*"
```

Expected: PASS. Read the printed truncation count — it is the finding this scenario exists to produce.

**After this one, re-project the workflow.** The wipe removed it from L2; the soak's final stop-and-start cycle re-projects it, but confirm with `curl -s http://localhost:18080/api/v1/workflows` before leaving the cluster.

- [ ] **Step 3: Document the suite where an operator will find it**

Append to `k8s/README.md`:

```markdown
## Resilience scenarios

`src/tests/BaseApi.Tests/Live/Resilience` drives five timed orchestrations against this namespace
and verifies them from Elasticsearch records. They are gated on **two** environment variables —
`SKP_REALSTACK=1` and `SKP_CHAOS=1` — because they pause Redis and scale StatefulSets to zero.
`SKP_REALSTACK=1` alone runs the read-only live tests and never touches infrastructure.

```
./k8s/port-forward-realstack.ps1
$env:SKP_REALSTACK = "1"; $env:SKP_CHAOS = "1"
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Each scenario takes 7-8 minutes and assumes exclusive use of the cluster: a workflow started by
someone else mid-soak is attributed to the scenario.

Three notes an operator will otherwise learn the hard way:

- **NetworkPolicy does nothing here.** kindnetd runs without `--network-policy`, so a policy is
  accepted by the API server and enforced by nothing. Redis is made unavailable with
  `redis-cli CLIENT PAUSE ... ALL`, which also expires on its own so a killed run cannot wedge the
  cluster.
- **Never scale Redis down to simulate an outage.** It runs `--save "" --appendonly no` with no PVC,
  so scaling to zero wipes L2 rather than interrupting it. That is scenario S5, which asserts a
  bounded blast radius rather than zero loss.
- **RabbitMQ scale-down is safe**, because its StatefulSet has a 1Gi PVC on the mnesia directory.

Design: `docs/superpowers/specs/2026-08-22-live-stack-resilience-scenarios-design.md`
```

- [ ] **Step 4: Mark the spec implemented**

In `docs/superpowers/specs/2026-08-22-live-stack-resilience-scenarios-design.md`, change:

```markdown
Status: approved, not yet implemented
```

to:

```markdown
Status: implemented
```

- [ ] **Step 5: Run the full hermetic gate**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: `Failed 0, Passed 424, Skipped 15, Total 439`, exit 0, 0 warnings.

Read the shape, not the total: 15 skips is 7 pre-existing Live plus 8 chaos-gated (5 scenarios, 2 `ClusterControlLiveTests`, 1 `ElasticReaderLiveTests`). **If any chaos test runs rather than skips here, the gate is broken and that is a defect, not a passing run.**

- [ ] **Step 6: Commit**

```bash
git add src/tests/BaseApi.Tests/Live/Resilience/RedisWipeScenarioTests.cs \
        k8s/README.md \
        docs/superpowers/specs/2026-08-22-live-stack-resilience-scenarios-design.md
git commit -m "test: bound and expose what an L2 wipe costs"
```

---

## Self-review notes

**Spec coverage.** §2 → Task 2 (`WorkflowShape`, the ledger table). §3.1 → Task 2 (`LogRecord`, `Templates`). §3.2/§3.3 → Task 2 (`RunLedger`, I1–I6). §4.1/§4.2 → Task 5 (`ClusterControl` docs and `ClusterControlLiveTests`), Task 11 (README). §4.3 → Task 5. §5.1 → Task 7. §5.2 → Task 5 (`finally`-restore) and Task 7. §5.3 → Task 6 (`FaultWitness`). §5.4 → Task 9 (`OutageVerdict`) and Task 3 (`RunClassifier`). §5.5 → Task 11. §5.6 → Task 10 (S4 ordering). §6 → Task 6 (`PromReader`). §7 → the file structure. §7.1/§7.2 → Task 1. §8 traps 1–2 → the live-test preflight failures surface as reader exceptions naming the endpoint; trap 3 → `ElasticLogReader` bounds every query; trap 5 → `AssertDrainedAsync`; trap 6 → `LogRecord` treats absent attributes as null; trap 7 → `role` is never read. §9 → not implemented, and correctly so: it states what the suite does *not* prove.

**Trap 4 is deliberately not implemented.** The spec asks that `sum_other_doc_count` be checked on every terms aggregation. This plan runs no terms aggregation — counting happens in memory in `RunLedger` after `search_after` paging has fetched every record — so the trap does not arise. Anyone adding an aggregation later must add the check.

**Type consistency.** `LogRecord.FromSource(JsonElement)` is the single projection, called by both the hermetic fixture loader (Task 2) and `ElasticLogReader` (Task 4) — which is what makes a field-name drift break in the fast tests. `RunLedger.From(string, IReadOnlyCollection<LogRecord>, WorkflowShape)`, `RunClassifier.Classify(RunLedger, IReadOnlyCollection<LogRecord>, FaultWindow)` and `FaultSchedule(FaultKind, Func<CancellationToken, Task<IAsyncDisposable>>)` are spelled identically at every call site; `ClusterControl.HoldRedisPausedAsync` matches that `Func` shape directly, which is why S2 passes the method group rather than a lambda.

**Two build-level cautions for the executor.** `TreatWarningsAsErrors` is on and `EnforceCodeStyleInBuild` is true, so an analyzer suggestion that happens to be raised as a warning stops the build. Prefer `CultureInfo.InvariantCulture` on every interpolated `AppendLine` and format call rather than discovering CA1305 one file at a time. And collection expressions (`[Templates.GateClosed, ...]`, `[.. arrival, .. heal]`) target `IReadOnlyList<string>` and `IReadOnlyCollection<string>` — valid on C# 12, which `LangVersion latest` on net8.0 gives.
