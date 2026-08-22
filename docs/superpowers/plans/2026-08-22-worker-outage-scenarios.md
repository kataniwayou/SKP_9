# Worker outage scenarios (S6, S7) — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two more live scenarios in the existing suite — the processor taken away mid-orchestration, and the orchestrator taken away mid-orchestration — verified from Elasticsearch records alone.

**Architecture:** Both reuse the whole existing harness unchanged: `OrchestrationSoak`'s five-minute skeleton, the eight-invariant `RunLedger`, the two-tier `RunClassifier`, and `OutageVerdict`'s three obligations. Task 1 extends the fault witness to recognise a worker going away — which needs a service filter, because a worker's shutdown record uses a framework template every service emits. Tasks 2 and 3 are one scenario file each.

**Tech Stack:** .NET 8, xunit v3 on Microsoft.Testing.Platform. No new NuGet packages.

**Spec:** `docs/superpowers/specs/2026-08-22-live-stack-resilience-scenarios-design.md` — §5.7 (S6), §5.8 (S7), §5.9 (out of scope), and the S6/S7 rows in §1.

## Global Constraints

- `net8.0`, `Nullable` enable, `ImplicitUsings` enable, `LangVersion latest` (C# 12).
- **`TreatWarningsAsErrors` is true and `EnforceCodeStyleInBuild` is true — a build warning is a build failure.** Prefer `CultureInfo.InvariantCulture` on format calls.
- **Add no NuGet package.** `RestorePackagesWithLockFile` is true.
- The test runner **silently ignores `--filter`**. Run the whole project. `--filter-method` works only after a bare `--`.
- Live tests gate on **two** environment variables read inside the test body — `SKP_REALSTACK=1` and `SKP_CHAOS=1` — via `Chaos.SkipUnlessEnabled()`, plus `[Trait("Category", Chaos.Category)]`. Never a trait-only guard.
- Use `TestContext.Current.CancellationToken`.
- **Never `git add -A` or `git add .`** — stage explicit paths.
- House style: substantial XML doc comments explaining *why*. Raw em dashes in prose are normal here (277 of 357 `.cs` files carry non-ASCII); do not escape them.

### Baseline

Before this plan: **515 passed, 16 skipped, 531 total**, exit 0, 0 warnings.
After: **515 passed, 18 skipped, 533 total** — two new chaos-gated scenarios, no new hermetic tests.

Read the shape, not the total. **If a chaos test runs rather than skips under a plain `dotnet test`, the gate is broken and that is a defect.**

### Verified environment facts

Gathered live before this plan was written; do not re-derive:

| Fact | Value |
| --- | --- |
| Processor workload | `Deployment/processor-sample`, **2** replicas |
| Orchestrator workload | `StatefulSet/orchestrator`, **3** replicas |
| Processor `service.name` | `sample-proc-v9` — from its database row, so **configuration, not a constant** |
| Processor arrival edge | `Application is shutting down...` — a `Microsoft.Hosting.Lifetime` template **every** service emits |
| Processor heal edge | `processor healthy; startup loops retired` — processor-unique |
| Orchestrator arrival edge | `Scheduler {0} shutting down.` — Quartz, orchestrator-only |
| Orchestrator heal edge | `hydrated {WorkflowCount} workflows from L2; admitting the consumer` — orchestrator-only |

`ProcessorLivenessValidator` lives in `BaseApi.Service` and runs at `POST /start`, **not** in the orchestrator's dispatch path — so a dead processor does not suppress dispatch.

---

## File structure

| File | Change | Responsibility |
| --- | --- | --- |
| `src/tests/BaseApi.Tests/Live/Resilience/Templates.cs` | modify | four new lifecycle template constants |
| `src/tests/BaseApi.Tests/Live/Resilience/Chaos.cs` | modify | `ProcessorService` address |
| `src/tests/BaseApi.Tests/Live/Resilience/ElasticLogReader.cs` | modify | optional service filter on the template query |
| `src/tests/BaseApi.Tests/Live/Resilience/FaultWitness.cs` | modify | `Processor` and `Orchestrator` kinds, service-scoped witness |
| `src/tests/BaseApi.Tests/Live/Resilience/OutageVerdict.cs` | modify | parameterised minimum run count |
| `src/tests/BaseApi.Tests/Live/Resilience/ProcessorUnavailableScenarioTests.cs` | create | S6 |
| `src/tests/BaseApi.Tests/Live/Resilience/OrchestratorUnavailableScenarioTests.cs` | create | S7 |

---

### Task 1: Witness a worker going away

**Files:**
- Modify: `src/tests/BaseApi.Tests/Live/Resilience/Templates.cs`
- Modify: `src/tests/BaseApi.Tests/Live/Resilience/Chaos.cs`
- Modify: `src/tests/BaseApi.Tests/Live/Resilience/ElasticLogReader.cs`
- Modify: `src/tests/BaseApi.Tests/Live/Resilience/FaultWitness.cs`
- Modify: `src/tests/BaseApi.Tests/Live/Resilience/OutageVerdict.cs`

**Interfaces:**
- Consumes: `Chaos.Get`-style config, `LogRecord`, `SearchAsync`'s existing filter list shape.
- Produces: `Templates.{HostShuttingDown, ProcessorLoopsRetired, SchedulerShuttingDown, OrchestratorHydrated}`; `Chaos.ProcessorService`; `ElasticLogReader.ReadTemplateRecordsAsync(templates, from, to, service, ct)` as a new overload beside the existing four-argument one; `FaultKind.{Processor, Orchestrator}`; `OutageVerdict.AssertNoUnaccountedLoss(SoakResult result, int minimumRuns = 9)`.

- [ ] **Step 1: Add the four lifecycle templates**

In `Templates.cs`, after the existing fault-edge constants:

```csharp
    // ---- worker lifecycle edges, for S6 and S7 ----

    /// <summary>
    /// Emitted by Microsoft.Hosting.Lifetime, so EVERY service in the deployment writes it. Matching
    /// it without also filtering on the service name witnesses the wrong process, which is why
    /// ReadTemplateRecordsAsync takes a service filter.
    /// </summary>
    public const string HostShuttingDown = "Application is shutting down...";

    /// <summary>Processor-unique: its startup loops stand down once it is serving.</summary>
    public const string ProcessorLoopsRetired = "processor healthy; startup loops retired";

    /// <summary>Orchestrator-unique: Quartz runs nowhere else in this deployment.</summary>
    public const string SchedulerShuttingDown = "Scheduler {0} shutting down.";

    /// <summary>Orchestrator-unique: the hydration record no other role writes.</summary>
    public const string OrchestratorHydrated =
        "hydrated {WorkflowCount} workflows from L2; admitting the consumer";
```

- [ ] **Step 2: Add the processor's service name as configuration**

In `Chaos.cs`, beside the existing addresses:

```csharp
    /// <summary>
    /// The processor's OpenTelemetry <c>service.name</c>, which the witness filters on for S6.
    /// <para>
    /// Configuration rather than a constant: this value comes from the processor's own database row,
    /// so a rebuilt processor changes it. A hardcoded name would match nothing, and the scenario
    /// would fail as inconclusive rather than telling anyone why.
    /// </para>
    /// </summary>
    public static string ProcessorService => RealStack.Get("SKP_PROCESSOR_SERVICE", "sample-proc-v9");
```

- [ ] **Step 3: Add the optional service filter to the template query**

In `ElasticLogReader.cs`, replace `ReadTemplateRecordsAsync` with:

```csharp
    /// <summary>
    /// Records matching any of a set of templates, unfiltered by workflow, and optionally scoped to
    /// one service.
    /// <para>
    /// The gate and channel records carry no WorkflowId — they are statements about a process, not
    /// about a run — so the fault witness cannot reuse the run query.
    /// </para>
    /// <para>
    /// <b>The service filter exists for one specific hazard.</b> A worker's shutdown edge is
    /// <c>Application is shutting down...</c>, a Microsoft.Hosting.Lifetime template every service in
    /// the deployment emits. Witnessing a processor outage on that template alone would match the
    /// API or the orchestrator restarting for unrelated reasons and report a fault that never
    /// happened to the process under test.
    /// </para>
    /// </summary>
    public Task<IReadOnlyList<LogRecord>> ReadTemplateRecordsAsync(
        IReadOnlyCollection<string> templates, DateTimeOffset from, DateTimeOffset to, CancellationToken ct) =>
        ReadTemplateRecordsAsync(templates, from, to, service: null, ct);

    /// <inheritdoc cref="ReadTemplateRecordsAsync(IReadOnlyCollection{string}, DateTimeOffset, DateTimeOffset, CancellationToken)"/>
    /// <param name="service">
    /// The <c>service.name</c> to scope to, or null for every service.
    /// </param>
    public Task<IReadOnlyList<LogRecord>> ReadTemplateRecordsAsync(
        IReadOnlyCollection<string> templates,
        DateTimeOffset from,
        DateTimeOffset to,
        string? service,
        CancellationToken ct)
    {
        var filters = new List<Dictionary<string, object>>
        {
            Range(from, to),
            Terms(templates),
        };

        if (service is { Length: > 0 })
        {
            filters.Add(Term("resource.attributes.service.name", service));
        }

        return SearchAsync(filters, ct);
    }
```

**Two overloads rather than an optional parameter, and `ct` stays last in both.** An optional
parameter after a `CancellationToken` trips CA1068, which is unconfigured here and so carries its
default warning severity — a build failure under `TreatWarningsAsErrors`. The overload also leaves
all three existing call sites compiling untouched.

If the existing `SearchAsync` takes `List<Dictionary<string, object>>`, this matches. If its
parameter type differs, adapt the construction rather than changing `SearchAsync`. If the
`<inheritdoc cref="..."/>` above cannot resolve, replace it with an ordinary `<summary>` — an
unresolvable cref is itself a build failure here.

- [ ] **Step 4: Teach the witness about workers**

In `FaultWitness.cs`, extend the enum:

```csharp
internal enum FaultKind
{
    None,
    Redis,
    Rabbit,
    Both,

    /// <summary>The processor deployment scaled to zero. Its arrival edge needs a service filter.</summary>
    Processor,

    /// <summary>The orchestrator statefulset scaled to zero. Both its edges are role-unique.</summary>
    Orchestrator,
}
```

Add the template cases:

```csharp
        FaultKind.Processor => [Templates.HostShuttingDown],
        FaultKind.Orchestrator => [Templates.SchedulerShuttingDown, Templates.HostShuttingDown],
```
in `ArrivalTemplates`, and:
```csharp
        FaultKind.Processor => [Templates.ProcessorLoopsRetired, Templates.ConsumptionAdmitted],
        FaultKind.Orchestrator => [Templates.OrchestratorHydrated],
```
in `HealTemplates`.

Then scope the query. Add beside the existing template helpers:

```csharp
    /// <summary>
    /// The service whose records witness this fault, or null to search every service.
    /// <para>
    /// Only the processor needs one. Its arrival edge is a framework template every service emits,
    /// so an unscoped match would witness whichever process happened to restart. The orchestrator's
    /// own edges are role-unique — Quartz and the hydration record run nowhere else — so it is
    /// searched unscoped, and a filter there would only add a way to be wrong.
    /// </para>
    /// </summary>
    private static string? ServiceFor(FaultKind kind) =>
        kind == FaultKind.Processor ? Chaos.ProcessorService : null;
```

and pass it at the single call site inside `WitnessAsync`:

```csharp
        var records = await reader.ReadTemplateRecordsAsync(
            [.. arrival, .. heal], injectedAt, searchTo, ServiceFor(kind), ct);
```

Leave the rest of `WitnessAsync` untouched — the absent-arrival throw and the heal-after-arrival ordering are both already correct and are what keep an unobserved fault from passing.

- [ ] **Step 5: Let the verdict take a run-count floor**

In `OutageVerdict.cs`, change the signature and the first assertion:

```csharp
    /// <param name="minimumRuns">
    /// The fewest fires this scenario can legitimately produce. Nine for a fault that leaves the
    /// orchestrator scheduling — the soak's ten fires all still happen, and one fire of slop is
    /// allowed for where t0 lands against the cron boundary. Lower only where the fault stops fires
    /// happening at all: a fire that never happened is not a lost step, and the ledger has no run to
    /// judge. See spec section 5.8.
    /// </param>
    public static void AssertNoUnaccountedLoss(SoakResult result, int minimumRuns = 9)
```

```csharp
        Assert.True(result.Runs.Count >= minimumRuns,
            $"expected at least {minimumRuns} fires in five minutes at a 30s cron, "
            + $"saw {result.Runs.Count}.\n{report}");
```

Every existing call site (S2, S3, S4) passes one argument and keeps the default — do not edit them.

- [ ] **Step 6: Build and run the hermetic suite**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: **515 passed, 16 skipped, 531 total**, exit 0, 0 warnings — unchanged, because this task adds no tests. What it proves is that the extension compiles clean under warnings-as-errors and breaks nothing.

- [ ] **Step 7: Commit**

```bash
git add src/tests/BaseApi.Tests/Live/Resilience/Templates.cs \
        src/tests/BaseApi.Tests/Live/Resilience/Chaos.cs \
        src/tests/BaseApi.Tests/Live/Resilience/ElasticLogReader.cs \
        src/tests/BaseApi.Tests/Live/Resilience/FaultWitness.cs \
        src/tests/BaseApi.Tests/Live/Resilience/OutageVerdict.cs
git commit -m "test: witness a worker going away, and let the verdict take a run floor"
```

---

### Task 2: S6 — processor unavailable

**Files:**
- Create: `src/tests/BaseApi.Tests/Live/Resilience/ProcessorUnavailableScenarioTests.cs`

**Interfaces:**
- Consumes: `FaultKind.Processor`, `ClusterControl.HoldScaledDownAsync`, `OutageVerdict.AssertNoUnaccountedLoss`, `OrchestrationSoak.RunAsync`.
- Produces: nothing further.

- [ ] **Step 1: Write the scenario**

```csharp
using Xunit;

namespace BaseApi.Tests.Live.Resilience;

/// <summary>
/// S6. The processor deployment is scaled to zero for a minute mid-orchestration.
/// <para>
/// <b>Nothing suppresses the dispatch while it is gone.</b> <c>ProcessorLivenessValidator</c> lives
/// in the API and runs at <c>POST /start</c>, not in the orchestrator's dispatch path, so the
/// orchestrator keeps firing and keeps sending process-dispatch messages to the processor's work
/// queue throughout. Those sit in a durable queue on a broker with a PVC and are drained when the
/// processor returns — which is why this scenario expects completion, not merely survival.
/// </para>
/// <para>
/// The full nine-fire floor applies: the orchestrator never stopped scheduling, so every fire of the
/// soak still happened. That is the difference between this scenario and S7.
/// </para>
/// </summary>
[Trait("Category", Chaos.Category)]
public sealed class ProcessorUnavailableScenarioTests
{
    [Fact]
    public async Task NoStepIsLostWhileTheProcessorIsGone()
    {
        Chaos.SkipUnlessEnabled();

        var result = await OrchestrationSoak.RunAsync(
            new FaultSchedule(
                FaultKind.Processor,
                ct => ClusterControl.HoldScaledDownAsync("deployment", "processor-sample", 2, ct)),
            TestContext.Current.CancellationToken);

        OutageVerdict.AssertNoUnaccountedLoss(result);
    }
}
```

Note `"deployment"` and a restore count of **2** — the processor runs two replicas, and restoring to 1 would silently halve its capacity for every later run.

- [ ] **Step 2: Run the hermetic suite**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: **515 passed, 17 skipped, 532 total**, exit 0, 0 warnings. The new scenario must skip.

- [ ] **Step 3: Run it live**

```bash
SKP_REALSTACK=1 SKP_CHAOS=1 dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj \
  -- --filter-method "*NoStepIsLostWhileTheProcessorIsGone*"
```

Expect roughly eight minutes.

**If it fails, read the report before touching anything.** A `FaultWitness` "no process reported it" means the service name is wrong — check `SKP_PROCESSOR_SERVICE` against `resource.attributes.service.name` in Elasticsearch, and fix the configuration, never the witness. An I6-only breach is log loss; re-run once. A non-zero Unaccounted count is a real finding: report it with the full `SoakReport` rather than weakening an assertion.

- [ ] **Step 4: Confirm the cluster is whole**

```bash
kubectl -n skp get deploy processor-sample
```
Must read `2/2`.

- [ ] **Step 5: Commit**

```bash
git add src/tests/BaseApi.Tests/Live/Resilience/ProcessorUnavailableScenarioTests.cs
git commit -m "test: lose no step while the processor is gone"
```

---

### Task 3: S7 — orchestrator unavailable

**Files:**
- Create: `src/tests/BaseApi.Tests/Live/Resilience/OrchestratorUnavailableScenarioTests.cs`

**Interfaces:**
- Consumes: `FaultKind.Orchestrator`, `ClusterControl.HoldScaledDownAsync`, `OutageVerdict.AssertNoUnaccountedLoss(result, minimumRuns)`.
- Produces: nothing further.

- [ ] **Step 1: Write the scenario**

```csharp
using Xunit;

namespace BaseApi.Tests.Live.Resilience;

/// <summary>
/// S7. The orchestrator statefulset is scaled to zero for a minute mid-orchestration.
/// <para>
/// <b>This does not breach the "never scale down" invariant.</b> That rule forbids reducing the
/// orchestrator's replica count because each replica owns a durable per-replica queue that would
/// accumulate forever once its owner was gone. Scaling 3 to 0 and back to 3 restores the same
/// ordinals, and therefore the same queue names, so no queue is orphaned. Restoring to a smaller
/// count would breach it; this does not.
/// </para>
/// <para>
/// <b>A fire that never happened is not a lost step.</b> With no scheduler running the cron does not
/// fire at all for the duration, so a sixty-second outage costs roughly two fires outright. Those
/// runs do not exist to be judged — the ledger only reasons about runs that started — so the floor
/// drops to seven. Asserting nine here would fail on the scenario working exactly as intended.
/// </para>
/// <para>
/// In-flight step-outcome messages accumulate in the durable per-replica queues meanwhile. On return
/// all three replicas rebuild L1 from L2, re-arm the cron, re-settle the Lease that fences the
/// leader, and drain their queues.
/// </para>
/// </summary>
[Trait("Category", Chaos.Category)]
public sealed class OrchestratorUnavailableScenarioTests
{
    /// <summary>
    /// Seven rather than nine: see the class remarks. This is the one scenario whose fault removes
    /// fires rather than delaying the work they cause.
    /// </summary>
    private const int MinimumRunsWithFiresSuppressed = 7;

    [Fact]
    public async Task NoStepIsLostWhileTheOrchestratorIsGone()
    {
        Chaos.SkipUnlessEnabled();

        var result = await OrchestrationSoak.RunAsync(
            new FaultSchedule(
                FaultKind.Orchestrator,
                ct => ClusterControl.HoldScaledDownAsync("statefulset", "orchestrator", 3, ct)),
            TestContext.Current.CancellationToken);

        OutageVerdict.AssertNoUnaccountedLoss(result, MinimumRunsWithFiresSuppressed);
    }
}
```

The restore count of **3** is load-bearing, not cosmetic: restoring to fewer replicas would orphan a per-replica queue permanently, which is the exact harm the never-scale-down invariant exists to prevent.

- [ ] **Step 2: Run the hermetic suite**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: **515 passed, 18 skipped, 533 total**, exit 0, 0 warnings.

- [ ] **Step 3: Run it live**

```bash
SKP_REALSTACK=1 SKP_CHAOS=1 dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj \
  -- --filter-method "*NoStepIsLostWhileTheOrchestratorIsGone*"
```

Expect eight to nine minutes — three replicas must each rehydrate and the Lease must re-settle.

**If it fails, read the report first.** Report the run count seen: if fires resumed but the count still fell below seven, the floor may be genuinely wrong for a sixty-second outage and I want to decide that, not have it adjusted silently. Everything else follows Task 2's rules — never weaken the witness, never relax an obligation.

- [ ] **Step 4: Confirm the cluster is whole — this one matters most**

```bash
kubectl -n skp get sts orchestrator
kubectl -n skp get pods -n skp -l app=orchestrator
```

The StatefulSet must read `3/3`, with `orchestrator-0`, `-1` and `-2` all present. **A StatefulSet left below three replicas orphans a durable queue that then accumulates forever** — if it does not come back to 3, stop and report immediately rather than continuing.

- [ ] **Step 5: Commit**

```bash
git add src/tests/BaseApi.Tests/Live/Resilience/OrchestratorUnavailableScenarioTests.cs
git commit -m "test: lose no step while the orchestrator is gone"
```

---

## Self-review notes

**Spec coverage.** §1's S6/S7 rows → Tasks 2 and 3. §5.7 (S6's obligations, the no-suppression argument, the service filter, the configurable service name) → Task 1 Steps 2-4 and Task 2. §5.8 (the invariant argument, the lowered floor, the queue-name reasoning) → Task 1 Step 5 and Task 3. §5.9 (out of scope) → no task, correctly: it states what these scenarios do not attempt.

**No hermetic tests are added by this plan, and that is a real gap worth naming.** Task 1 changes `FaultWitness` and `OutageVerdict`, both of which are exercised only by live scenarios. The existing suite has the same property for those two units — the plan that built them made the same call — so this follows precedent rather than setting one. The mitigation is that both new scenarios fail loudly and specifically when the witness is wrong: an unmatched service name throws "no process reported it" naming the templates searched, rather than passing quietly.

**Type consistency.** `AssertNoUnaccountedLoss` gains an optional second parameter, so S2/S3/S4's existing single-argument calls compile unchanged. `ReadTemplateRecordsAsync` gains an **overload** rather than an optional trailing parameter, keeping `CancellationToken` last in both signatures — CA1068 is unconfigured in this repo and so carries its default warning severity, which `TreatWarningsAsErrors` turns into a build failure. All three existing call sites (one in `FaultWitness`, two in `OrchestrationSoak`) bind to the four-argument overload and need no edit.
