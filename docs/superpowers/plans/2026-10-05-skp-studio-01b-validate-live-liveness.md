# SKP Studio, Plan 1b: Dry-run Validate, Live Workflows, Processor Liveness -- Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** BaseApi answers the three questions the studio cannot answer itself: `POST /api/v1/workflows/{id}/validate` runs **every** workflow-start gate against a draft (or the stored workflow) and returns **all** problems without saving or starting anything; `GET /api/v1/orchestration/live` lists the running workflows; `GET /api/v1/processors/liveness` reports each processor's liveness.

**Architecture:** The four start gates gain a *collect* mode next to their existing *throw-first* mode, so `StartAsync` is unchanged and the dry run reuses the exact same rules: one implementation of each rule, in C#, nowhere else. The dry run applies the draft with the existing `IWorkflowGraphSaver` inside a database transaction, loads the result through the same `IWorkflowGraphLoader` the start path uses, collects every gate's problems, and **rolls back**. The liveness classification is extracted from the gate into a probe shared by the gate and the liveness endpoint. The live list reads the `skp:live` set through the existing `L2LiveSet`. The browser never reaches Redis: BaseApi is its only coupling (the studio is static files; nginx only passes `/api/` through).

**Tech Stack:** .NET 8, EF Core 8 (Npgsql), StackExchange.Redis, JsonSchema.Net, xUnit v3 on Microsoft.Testing.Platform, NSubstitute, EF InMemory, the kind RealStack.

**Spec:** `docs/superpowers/specs/2026-10-05-skp-studio-design.md` (§3.2, §4.4, §6.1 status, §7 Problems, §11; amended alongside this plan).

> **Note 2026-10-10:** the two GETs stay as built here; the studio now follows the same data through the liveness hub (`/api/hubs/liveness`, SignalR), whose monitor judges processors with this plan's `ProcessorLivenessProbe`. Studio spec §6.4.

## Global Constraints

- **One implementation per rule.** The gates' rules are not copied anywhere. `Validate`/`ValidateAsync` keep throwing the **same first problem** they throw today; `Collect`/`CollectAsync` return every problem in the same traversal order, so the first collected problem is exactly the one `Validate` throws.
- **`StartAsync` and `StopAsync` are not modified.** The 422 contract of `/orchestration/start` (one problem, `errors = { gate, offending }`) is unchanged.
- **A dry run never escapes the transaction.** The validate path never calls `ToDefinition`, never sends to the broker, never writes Redis. The only Redis access in it is the read-only liveness probe. It rolls back on every path (success, gate problems, exception) and clears the change tracker afterwards.
- **Validate answers 200 with the problems list** for gate problems (`valid: false`). Request-shape failures keep the graph save's statuses: 400 (field validation), 404 (no draft and no such workflow, or a missing processor in a schema edit), 409 (stale draft), 422 (FK violation).
- **No backend validator changes** (the FluentValidation DTO validators are untouched). **No navigation properties.** **`BaseApi.Core` is not modified.**
- **Redis faults are 500s, tagged.** A `RedisException` propagates; the code that catches it only adds `ex.Data["redisOp"]` (a stable name) and rethrows, as `StartAsync` does today.
- **Liveness semantics are the gate's, unchanged:** a replica qualifies when its per-instance key exists, deserializes with a non-null summary, has status `Healthy` (ordinal) and `timestamp + 2 × interval` is still ahead of now; a processor is live when any replica qualifies.
- **Test commands.** Build: `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo`. One class: `src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "<FQN>"`. Full hermetic suite: `src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-not-trait "Category=RealStack" --filter-not-namespace "BaseApi.Tests.Live*"`. Fully-qualified class names only (a bare name matches 0 tests and exits 0). Never `dotnet test`. Warnings are errors; private fields are `_camelCase`.
- **Machine notes.** Windows, Git Bash. Bash heredocs with apostrophes or backticks fail: write files with the Write tool. Stage only the files a task names. Do not touch: `.wf-restore.json`, `tools/simulate-*.py`, `.playwright-mcp/`, `docs/HANDOVER-*.md`. The kind cluster is named `desktop` (`kind load docker-image <img> --name desktop`).

## Review Focus

1. **A dry run that fails half-way** (an FK violation from a draft step pointing at a missing processor). Expected: 422 as for a real save, and nothing persisted. Live test in Task 6.
2. **Redis down during validate or liveness.** Expected: 500 with a tagged `redisOp`, never a wrong "not live" answer and never a half-applied draft (the transaction still rolls back). Hermetic test in Task 5.
3. **A graph with several back-edges and dangling wires.** Expected: every cycle and every missing step reported, the traversal terminates, and `Validate` still throws the same first problem as before. Test in Task 1.
4. **A `skp:live` member that is not a workflow id.** Expected: skipped, the rest listed. Test in Task 3.
5. **Validate with no body on a workflow that does not exist.** Expected: 404. With a draft for a workflow that does not exist yet: the draft creates it inside the transaction and is validated, then rolled back. Tests in Task 5 and Task 6.

---

## File Structure

**New**

| File | Responsibility |
|---|---|
| `src/BaseApi.Service/Features/Orchestration/Validation/ProcessorLivenessProbe.cs` | `ProcessorLiveness` record and the probe: read one processor's replicas and classify every one |
| `src/BaseApi.Service/Features/Orchestration/ILiveWorkflowReader.cs` | Public read interface for running workflow ids |
| `src/BaseApi.Service/Features/Processor/ProcessorLiveness.cs` | `ProcessorLivenessDto`, `IProcessorLivenessReader`, `ProcessorLivenessReader` |
| `src/BaseApi.Service/Features/Orchestration/WorkflowValidation.cs` | `WorkflowProblemDto`, `WorkflowValidationDto`, `IWorkflowValidator` |
| `src/BaseApi.Service/Features/Orchestration/Validation/GraphDryRun.cs` | `IGraphDryRun` and its Postgres implementation (transaction + rollback) |
| `src/BaseApi.Service/Features/Orchestration/WorkflowValidator.cs` | The dry run: apply draft, load, collect every gate, roll back |
| Tests: `src/tests/BaseApi.Tests/Orchestration/GateCollectionTests.cs`, `ProcessorLivenessProbeTests.cs`, `LiveWorkflowListTests.cs`, `ProcessorLivenessReaderTests.cs`; `src/tests/BaseApi.Tests/WorkflowGraph/WorkflowValidatorTests.cs`; `src/tests/BaseApi.Tests/Live/WorkflowValidationLiveTests.cs` | |

**Modified**

| File | Change |
|---|---|
| `Features/Orchestration/Validation/CycleDetector.cs`, `SchemaEdgeValidator.cs`, `PayloadConfigSchemaValidator.cs` | `Collect` beside `Validate` |
| `Features/Orchestration/Validation/ProcessorLivenessValidator.cs` | Uses the probe; `CollectAsync` beside `ValidateAsync` |
| `Features/Orchestration/Projection/L2LiveSet.cs` | `ListAsync`; implements `ILiveWorkflowReader` |
| `Features/Orchestration/OrchestrationController.cs` | `GET live` |
| `Features/Processor/ProcessorController.cs` | `GET liveness` |
| `Features/Workflow/WorkflowController.cs` | `POST {id}/validate` |
| `Features/Orchestration/OrchestrationServiceCollectionExtensions.cs`, `Features/Processor/ProcessorServiceCollectionExtensions.cs` | Registrations |
| `src/tests/BaseApi.Tests/WorkflowGraph/GraphHarness.cs`, `WorkflowLayoutTests.cs`, `WorkflowGraphControllerTests.cs` | Harness gains the validator; controller constructor calls gain the new argument |

---

### Task 1: Collect mode for the cycle, schema-edge and payload gates

**Files:**
- Modify: `src/BaseApi.Service/Features/Orchestration/Validation/CycleDetector.cs`, `SchemaEdgeValidator.cs`, `PayloadConfigSchemaValidator.cs`
- Test: `src/tests/BaseApi.Tests/Orchestration/GateCollectionTests.cs`

**Interfaces:**
- Produces, on each of the three classes: `public IReadOnlyList<OrchestrationValidationException> Collect(WorkflowGraphSnapshot snapshot)`. `public void Validate(WorkflowGraphSnapshot snapshot)` keeps its signature and becomes "collect, then throw the first".

A problem is an `OrchestrationValidationException` built by the existing factories but **not thrown**: it already carries `Gate`, `Title`, `Message` and `Offending`, so the collect path and the 422 path describe a problem identically.

- [ ] **Step 1: Write the failing tests**

Create `src/tests/BaseApi.Tests/Orchestration/GateCollectionTests.cs`:

```csharp
using BaseApi.Service.Features.Assignment;
using BaseApi.Service.Features.Orchestration;
using BaseApi.Service.Features.Orchestration.Validation;
using BaseApi.Service.Features.Processor;
using BaseApi.Service.Features.Schema;
using BaseApi.Service.Features.Step;
using BaseApi.Service.Features.Workflow;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace BaseApi.Tests.Orchestration;

/// <summary>
/// The collect mode of the three snapshot gates: every problem, in the gate's own traversal order,
/// so the first collected problem is exactly the one Validate throws. No unit tests existed for these
/// gates before; the cases are derived from their code.
/// </summary>
public sealed class GateCollectionTests
{
    private static readonly DateTime T = new(2026, 10, 5, 12, 0, 0, DateTimeKind.Utc);

    private sealed class Graph
    {
        public WorkflowGraphSnapshot Snapshot { get; } = new(NullLogger<WorkflowGraphSnapshot>.Instance);

        public Guid Workflow(params Guid[] entry)
        {
            var id = Guid.NewGuid();
            Snapshot.Workflows[id] = new WorkflowReadDto(id, "wf", "1.0.0", null, entry.ToList(), [], [], null, T, T, null, null);
            return id;
        }

        public Guid Processor(Guid? input = null, Guid? output = null, Guid? config = null)
        {
            var id = Guid.NewGuid();
            Snapshot.Processors[id] = new ProcessorReadDto(id, "p", "1.0.0", null, "hash", null, input, output, config, T, T, null, null);
            return id;
        }

        public Guid Step(Guid processor)
        {
            var id = Guid.NewGuid();
            Snapshot.Steps[id] = new StepReadDto(id, "s", "1.0.0", null, processor, [], StepEntryCondition.PreviousCompleted, T, T, null, null);
            return id;
        }

        public void Wire(Guid from, params Guid[] to) => Snapshot.Steps[from].NextStepIds!.AddRange(to);

        public Guid Schema(string definition)
        {
            var id = Guid.NewGuid();
            Snapshot.Schemas[id] = new SchemaReadDto(id, "schema", "1.0.0", null, definition, T, T, null, null);
            return id;
        }

        public Guid Assignment(Guid step, string payload)
        {
            var id = Guid.NewGuid();
            Snapshot.Assignments[id] = new AssignmentReadDto(id, "asg", "1.0.0", null, step, payload, T, T, null, null);
            return id;
        }
    }

    [Fact]
    public void TheCycleGateCollectsEveryCycleAndMissingStepInTraversalOrder()
    {
        var g = new Graph();
        var p = g.Processor();
        var (a, b, c) = (g.Step(p), g.Step(p), g.Step(p));
        var ghost = Guid.NewGuid();
        g.Wire(a, b, c);
        g.Wire(b, a, ghost);   // back-edge, then a dangling wire
        g.Wire(c, c);          // self-loop
        g.Workflow(a);

        var problems = new CycleDetector().Collect(g.Snapshot);

        Assert.Equal(["cycle", "missingStep", "cycle"], problems.Select(x => x.Gate));
        Assert.Equal([a, b, a], ((CycleOffending)problems[0].Offending).stepChain);
        Assert.Equal(new MissingStepOffending(b, ghost), problems[1].Offending);
        Assert.Equal([c, c], ((CycleOffending)problems[2].Offending).stepChain);
    }

    [Fact]
    public void ValidateStillThrowsTheFirstProblemOnly()
    {
        var g = new Graph();
        var p = g.Processor();
        var (a, b) = (g.Step(p), g.Step(p));
        g.Wire(a, b);
        g.Wire(b, a, Guid.NewGuid());
        g.Workflow(a);

        var ex = Assert.Throws<OrchestrationValidationException>(() => new CycleDetector().Validate(g.Snapshot));

        Assert.Equal("cycle", ex.Gate);
        Assert.Equal([a, b, a], ((CycleOffending)ex.Offending).stepChain);
    }

    [Fact]
    public void AMissingEntryStepIsReportedAndTheNextEntryIsStillWalked()
    {
        var g = new Graph();
        var p = g.Processor();
        var a = g.Step(p);
        g.Wire(a, a);
        var ghost = Guid.NewGuid();
        g.Workflow(ghost, a);

        var problems = new CycleDetector().Collect(g.Snapshot);

        Assert.Equal(["missingStep", "cycle"], problems.Select(x => x.Gate));
        Assert.Equal(new MissingStepOffending(Guid.Empty, ghost), problems[0].Offending);
    }

    [Fact]
    public void ACleanGraphHasNoProblemsAndValidatePasses()
    {
        var g = new Graph();
        var p = g.Processor();
        var (a, b, c, d) = (g.Step(p), g.Step(p), g.Step(p), g.Step(p));
        g.Wire(a, b, c);
        g.Wire(b, d);
        g.Wire(c, d);          // a diamond is legal
        g.Workflow(a);

        Assert.Empty(new CycleDetector().Collect(g.Snapshot));
        new CycleDetector().Validate(g.Snapshot);
    }

    [Fact]
    public void TheSchemaEdgeGateCollectsEveryMismatchedEdge()
    {
        var g = new Graph();
        var (s1, s2, s3) = (Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid());
        var a = g.Step(g.Processor(output: s1));
        var b = g.Step(g.Processor(input: s2));
        var c = g.Step(g.Processor(input: s3));
        var d = g.Step(g.Processor(input: s1));
        g.Wire(a, b, c, d);
        g.Workflow(a);

        var problems = new SchemaEdgeValidator().Collect(g.Snapshot);

        Assert.Equal([new SchemaEdgeOffending(a, b), new SchemaEdgeOffending(a, c)], problems.Select(x => x.Offending));
        var ex = Assert.Throws<OrchestrationValidationException>(() => new SchemaEdgeValidator().Validate(g.Snapshot));
        Assert.Equal(new SchemaEdgeOffending(a, b), ex.Offending);
    }

    [Fact]
    public void ThePayloadGateCollectsEveryNonConformingAssignment()
    {
        var g = new Graph();
        var cfg = g.Schema("""{"type":"object","required":["url"]}""");
        var step = g.Step(g.Processor(config: cfg));
        g.Workflow(step);
        var missing = g.Assignment(step, "{}");
        var broken = g.Assignment(step, "{not json");
        g.Assignment(step, """{"url":"https://x"}""");

        var problems = new PayloadConfigSchemaValidator().Collect(g.Snapshot);

        Assert.Equal([missing, broken], problems.Select(x => ((PayloadConfigSchemaOffending)x.Offending).assignmentId));
        Assert.Equal(["Payload is not valid JSON."], ((PayloadConfigSchemaOffending)problems[1].Offending).errors);
    }

    [Fact]
    public void AnInvalidConfigSchemaIsReportedForEachAssignmentThatUsesIt()
    {
        var g = new Graph();
        var cfg = g.Schema("{not a schema");
        var step = g.Step(g.Processor(config: cfg));
        g.Workflow(step);
        g.Assignment(step, "{}");
        g.Assignment(step, "{}");

        var problems = new PayloadConfigSchemaValidator().Collect(g.Snapshot);

        Assert.Equal(2, problems.Count);
        Assert.All(problems, x => Assert.Contains("is not a valid JSON Schema", ((PayloadConfigSchemaOffending)x.Offending).errors[0]));
    }
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo`
Expected: build error `'CycleDetector' does not contain a definition for 'Collect'`.

- [ ] **Step 3: Add collect mode to the three gates**

In `CycleDetector.cs`, replace `Validate` and `RunDfs` (keep the class doc comment and `Push` unchanged; keep the existing doc comment on `Validate`, adding that it throws the first problem `Collect` finds):

```csharp
    public void Validate(WorkflowGraphSnapshot snapshot)
    {
        var problems = Collect(snapshot);
        if (problems.Count > 0)
        {
            throw problems[0];
        }
    }

    /// <summary>
    /// Every cycle and missing step the search meets, in the order <see cref="Validate"/> would meet
    /// them, so the first entry is the one it throws. A back-edge is recorded and not followed, and a
    /// dangling wire is recorded and not descended, so the search still terminates.
    /// </summary>
    public IReadOnlyList<OrchestrationValidationException> Collect(WorkflowGraphSnapshot snapshot)
    {
        var problems = new List<OrchestrationValidationException>();

        // Completed subtrees, shared across all entry seeds so a cleared subtree is never re-walked.
        var fullyVisited = new HashSet<Guid>();

        foreach (var workflow in snapshot.Workflows.Values)
        {
            foreach (var entryId in workflow.EntryStepIds ?? Enumerable.Empty<Guid>())
            {
                if (fullyVisited.Contains(entryId))
                {
                    continue;
                }

                // An entry step id that does not resolve is itself a missing step. There is no parent
                // here, so an empty GUID stands in as the parent for an entry-seed miss.
                if (!snapshot.Steps.ContainsKey(entryId))
                {
                    problems.Add(OrchestrationValidationException.MissingStep(Guid.Empty, entryId));
                    continue;
                }

                RunDfs(snapshot, entryId, fullyVisited, problems);
            }
        }

        return problems;
    }

    /// <summary>
    /// Explicit-stack search from <paramref name="entryId"/>. The on-stack set tracks the active path
    /// for cycle detection, the path list tracks the same nodes in order so the offending chain can be
    /// reconstructed, and <paramref name="fullyVisited"/> records completed subtrees across seeds.
    /// </summary>
    private static void RunDfs(
        WorkflowGraphSnapshot snapshot, Guid entryId, HashSet<Guid> fullyVisited, List<OrchestrationValidationException> problems)
    {
        var stack = new Stack<(Guid Step, IEnumerator<Guid> Children)>();
        var onStack = new HashSet<Guid>();
        var path = new List<Guid>();

        Push(snapshot, entryId, stack, onStack, path);

        while (stack.Count > 0)
        {
            var (currentStep, children) = stack.Peek();

            if (children.MoveNext())
            {
                var child = children.Current;

                if (!snapshot.Steps.ContainsKey(child))
                {
                    // Referenced as a next step but absent from the graph.
                    problems.Add(OrchestrationValidationException.MissingStep(currentStep, child));
                    continue;
                }

                if (onStack.Contains(child))
                {
                    // Back-edge, so a cycle. Reconstruct it as the path slice from the first
                    // occurrence of the child to the end, then close the loop by appending it again.
                    // The child is already on the stack, so not following the edge keeps the search finite.
                    var startIndex = path.IndexOf(child);
                    var cycleChain = new List<Guid>(path.GetRange(startIndex, path.Count - startIndex)) { child };
                    problems.Add(OrchestrationValidationException.Cycle(cycleChain));
                    continue;
                }

                if (!fullyVisited.Contains(child))
                {
                    // Unvisited node — descend.
                    Push(snapshot, child, stack, onStack, path);
                }

                // Otherwise the child is already complete, which is a legal shared or fan-in
                // subgraph. Skipping it here is what prevents the diamond false positive.
            }
            else
            {
                // Subtree exhausted — pop the frame and mark the step complete.
                stack.Pop();
                onStack.Remove(currentStep);
                path.RemoveAt(path.Count - 1);
                fullyVisited.Add(currentStep);
            }
        }
    }
```

In `SchemaEdgeValidator.cs`, replace `Validate` with:

```csharp
    /// <summary>Walks every parent-to-child edge in the snapshot, throwing on the first mismatched edge.</summary>
    public void Validate(WorkflowGraphSnapshot snapshot)
    {
        var problems = Collect(snapshot);
        if (problems.Count > 0)
        {
            throw problems[0];
        }
    }

    /// <summary>Every mismatched edge, in walk order; the first is the one <see cref="Validate"/> throws.</summary>
    public IReadOnlyList<OrchestrationValidationException> Collect(WorkflowGraphSnapshot snapshot)
    {
        var problems = new List<OrchestrationValidationException>();

        foreach (var parent in snapshot.Steps.Values)
        {
            foreach (var childId in parent.NextStepIds ?? Enumerable.Empty<Guid>())
            {
                if (!snapshot.Steps.TryGetValue(childId, out var child))
                {
                    // Dangling child — the cycle gate runs first and owns this error.
                    continue;
                }

                var parentOut = snapshot.Processors.TryGetValue(parent.ProcessorId, out var pproc)
                    ? pproc.OutputSchemaId
                    : (Guid?)null;
                var childIn = snapshot.Processors.TryGetValue(child.ProcessorId, out var cproc)
                    ? cproc.InputSchemaId
                    : (Guid?)null;

                // A null on either side passes: source, sink or unconfigured processor.
                if (parentOut is null || childIn is null)
                {
                    continue;
                }

                if (parentOut.Value != childIn.Value)
                {
                    problems.Add(OrchestrationValidationException.SchemaEdge(parent.Id, child.Id));
                }
            }
        }

        return problems;
    }
```

In `PayloadConfigSchemaValidator.cs`, replace `Validate` with the pair below. The class doc comment stays; its last paragraph about the local parse cache now applies to `Collect`. An invalid config schema is remembered as `null` in the local cache, so it is parsed once and reported for each assignment that uses it.

```csharp
    public void Validate(WorkflowGraphSnapshot snapshot)
    {
        var problems = Collect(snapshot);
        if (problems.Count > 0)
        {
            throw problems[0];
        }
    }

    /// <summary>Every non-conforming assignment, in snapshot order; the first is the one <see cref="Validate"/> throws.</summary>
    public IReadOnlyList<OrchestrationValidationException> Collect(WorkflowGraphSnapshot snapshot)
    {
        var problems = new List<OrchestrationValidationException>();

        // Local cache, so each schema is parsed at most once per call and nothing outlives it. A
        // definition that is not a valid JSON Schema is cached as null.
        var schemaCache = new Dictionary<Guid, JsonSchema?>();

        foreach (var assignment in snapshot.Assignments.Values)
        {
            if (!snapshot.Steps.TryGetValue(assignment.StepId, out var step)) continue;
            if (!snapshot.Processors.TryGetValue(step.ProcessorId, out var proc)) continue;

            var cfgId = proc.ConfigSchemaId;
            if (cfgId is null) continue;   // no config schema means nothing to validate against

            if (!schemaCache.TryGetValue(cfgId.Value, out var schema))
            {
                if (!snapshot.Schemas.TryGetValue(cfgId.Value, out var schemaDto)) continue; // defensive
                try
                {
                    schema = JsonSchema.FromText(schemaDto.Definition);
                }
                catch (Exception ex) when (ex is JsonException or JsonSchemaException)
                {
                    schema = null;
                }
                schemaCache[cfgId.Value] = schema;
            }

            if (schema is null)
            {
                problems.Add(OrchestrationValidationException.PayloadConfigSchema(
                    assignment.Id,
                    new[] { $"Config schema '{cfgId.Value}' is not a valid JSON Schema." }));
                continue;
            }

            JsonDocument payloadDoc;
            try
            {
                payloadDoc = JsonDocument.Parse(assignment.Payload);
            }
            catch (JsonException)
            {
                problems.Add(OrchestrationValidationException.PayloadConfigSchema(
                    assignment.Id, new[] { "Payload is not valid JSON." }));
                continue;
            }

            using (payloadDoc)
            {
                var results = schema.Evaluate(payloadDoc.RootElement, JsonSchemaConfig.DefaultOptions);
                if (!results.IsValid)
                {
                    var errorStrings = (results.Details ?? Enumerable.Empty<EvaluationResults>())
                        .Where(d => d.Errors is { Count: > 0 })
                        .SelectMany(d => d.Errors!.Select(kv => $"{d.InstanceLocation}: {kv.Value}"))
                        .ToList();
                    if (errorStrings.Count == 0 && results.Errors is { Count: > 0 })
                        errorStrings = results.Errors.Select(kv => $"{results.InstanceLocation}: {kv.Value}").ToList();
                    problems.Add(OrchestrationValidationException.PayloadConfigSchema(assignment.Id, errorStrings));
                }
            }
        }

        return problems;
    }
```

`JsonSchemaConfig.DefaultOptions` stays: it pins the dialect and installs the no-op `$ref` fetcher.

- [ ] **Step 4: Run the new tests, then everything that exercises start**

```bash
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.Orchestration.GateCollectionTests"
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-not-trait "Category=RealStack" --filter-not-namespace "BaseApi.Tests.Live*"
```

Expected: 7 passed, then the full hermetic suite reports 0 failed (it includes `OrchestrationRefusalDiagnosticsTests` and the config-schema tests that reach these gates).

- [ ] **Step 5: Commit**

```bash
git add src/BaseApi.Service/Features/Orchestration/Validation/CycleDetector.cs src/BaseApi.Service/Features/Orchestration/Validation/SchemaEdgeValidator.cs src/BaseApi.Service/Features/Orchestration/Validation/PayloadConfigSchemaValidator.cs src/tests/BaseApi.Tests/Orchestration/GateCollectionTests.cs
git commit -m "feat(orchestration): collect mode for the cycle, schema-edge and payload gates"
```

---

### Task 2: The liveness probe, and collect mode for the liveness gate

**Files:**
- Create: `src/BaseApi.Service/Features/Orchestration/Validation/ProcessorLivenessProbe.cs`
- Modify: `src/BaseApi.Service/Features/Orchestration/Validation/ProcessorLivenessValidator.cs`
- Test: `src/tests/BaseApi.Tests/Orchestration/ProcessorLivenessProbeTests.cs`

**Interfaces:**
- Produces:
  - `internal sealed record ProcessorLiveness(Guid ProcessorId, int Replicas, int Healthy, int Absent, int Unhealthy, int Stale, int Malformed)` with `bool Live` and `string Reason`.
  - `internal sealed class ProcessorLivenessProbe(IConnectionMultiplexer multiplexer, TimeProvider clock)` with `Task<ProcessorLiveness> ProbeAsync(Guid processorId, CancellationToken ct)`.
  - `ProcessorLivenessValidator` keeps its constructor `(IConnectionMultiplexer, TimeProvider)` and `ValidateAsync`; adds `Task<IReadOnlyList<OrchestrationValidationException>> CollectAsync(WorkflowGraphSnapshot snapshot, CancellationToken ct)`.

The probe classifies **every** replica (the gate used to stop deserializing at the first healthy one), so the liveness endpoint can show full counts. I/O is unchanged: one index read and one pipelined batch per processor. `ValidateAsync` still stops at the first dead processor, so a start does no more Redis work than today.

- [ ] **Step 1: Write the failing tests**

Create `src/tests/BaseApi.Tests/Orchestration/ProcessorLivenessProbeTests.cs`. Copy the `using` directives from `ProcessorLivenessValidatorTests.cs` (they bring `ProcessorLivenessEntry`, `LivenessSummary`, `LivenessStatus` and `SchemaOutcome`), and add `using BaseApi.Service.Features.Orchestration;` if it is not among them.

```csharp
namespace BaseApi.Tests.Orchestration;

public sealed class ProcessorLivenessProbeTests
{
    private static readonly DateTime Now = new(2026, 1, 1, 12, 0, 0, DateTimeKind.Utc);

    private readonly IDatabase _db = Substitute.For<IDatabase>();
    private readonly FakeTimeProvider _clock = new(new DateTimeOffset(Now, TimeSpan.Zero));

    private IConnectionMultiplexer Redis()
    {
        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase().Returns(_db);
        return redis;
    }

    private void Replicas(Guid processorId, params (string InstanceId, RedisValue Value)[] replicas)
    {
        _db.SetMembersAsync(L2ProjectionKeys.ProcessorInstances(processorId))
            .Returns(replicas.Select(r => (RedisValue)r.InstanceId).ToArray());
        foreach (var (instanceId, value) in replicas)
            _db.StringGetAsync(L2ProjectionKeys.PerInstance(processorId, instanceId)).Returns(value);
    }

    private static RedisValue Entry(string status, int ageSeconds, int interval = 10) =>
        JsonSerializer.Serialize(new ProcessorLivenessEntry(
            Now.AddSeconds(-ageSeconds), interval, status,
            new LivenessSummary(SchemaOutcome.Success, SchemaOutcome.Success, SchemaOutcome.Success)));

    private static WorkflowGraphSnapshot Snapshot(params Guid[] processors)
    {
        var snapshot = new WorkflowGraphSnapshot(NullLogger<WorkflowGraphSnapshot>.Instance);
        foreach (var id in processors)
            snapshot.Processors[id] = new ProcessorReadDto(id, "p", "1.0.0", null, "abc", null, null, null, null, Now, Now, null, null);
        return snapshot;
    }

    [Fact]
    public async Task ClassifiesEveryReplicaEvenAfterAHealthyOne()
    {
        var id = Guid.NewGuid();
        Replicas(id,
            ("good", Entry(LivenessStatus.Healthy, ageSeconds: 1)),
            ("gone", RedisValue.Null),
            ("sick", Entry(LivenessStatus.Unhealthy, ageSeconds: 1)),
            ("old", Entry(LivenessStatus.Healthy, ageSeconds: 999)),
            ("junk", "{not json"));

        var result = await new ProcessorLivenessProbe(Redis(), _clock).ProbeAsync(id, TestContext.Current.CancellationToken);

        Assert.Equal(new ProcessorLiveness(id, Replicas: 5, Healthy: 1, Absent: 1, Unhealthy: 1, Stale: 1, Malformed: 1), result);
        Assert.True(result.Live);
    }

    [Fact]
    public async Task AProcessorWithNoReplicasIsNotLiveAndItsReasonKeepsTheGatesWording()
    {
        var id = Guid.NewGuid();
        Replicas(id);

        var result = await new ProcessorLivenessProbe(Redis(), _clock).ProbeAsync(id, TestContext.Current.CancellationToken);

        Assert.False(result.Live);
        Assert.Equal("no healthy replica (0 checked: 0 absent, 0 unhealthy, 0 stale, 0 malformed)", result.Reason);
    }

    [Fact]
    public async Task CollectReportsEveryDeadProcessorAndSkipsTheLiveOnes()
    {
        var (dead1, live, dead2) = (Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid());
        Replicas(dead1);
        Replicas(live, ("good", Entry(LivenessStatus.Healthy, ageSeconds: 1)));
        Replicas(dead2, ("old", Entry(LivenessStatus.Healthy, ageSeconds: 999)));

        var problems = await new ProcessorLivenessValidator(Redis(), _clock)
            .CollectAsync(Snapshot(dead1, live, dead2), TestContext.Current.CancellationToken);

        Assert.Equal([dead1, dead2], problems.Select(p => ((ProcessorLivenessOffending)p.Offending).procId));
        Assert.All(problems, p => Assert.Equal("processorLiveness", p.Gate));
        Assert.Equal("no healthy replica (1 checked: 0 absent, 0 unhealthy, 1 stale, 0 malformed)",
            ((ProcessorLivenessOffending)problems[1].Offending).reason);
    }
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo`
Expected: build error `The type or namespace name 'ProcessorLivenessProbe' could not be found`.

- [ ] **Step 3: Implement the probe and rewire the gate**

Create `src/BaseApi.Service/Features/Orchestration/Validation/ProcessorLivenessProbe.cs`:

```csharp
using System.Text.Json;
using Messaging.Contracts.Projections;
using StackExchange.Redis;

namespace BaseApi.Service.Features.Orchestration.Validation;

/// <summary>One processor's replicas, each classified. Counts only: never instance ids.</summary>
internal sealed record ProcessorLiveness(Guid ProcessorId, int Replicas, int Healthy, int Absent, int Unhealthy, int Stale, int Malformed)
{
    /// <summary>A processor is live as soon as one replica is present, healthy and fresh.</summary>
    public bool Live => Healthy > 0;

    /// <summary>The start gate's refusal reason, worded exactly as it always was.</summary>
    public string Reason =>
        $"no healthy replica ({Replicas} checked: {Absent} absent, {Unhealthy} unhealthy, {Stale} stale, {Malformed} malformed)";
}

/// <summary>
/// Reads one processor's replicas from the instance-index set, with no prior knowledge of instance ids,
/// and classifies every per-instance entry: absent, malformed, unhealthy, stale or healthy. Shared by the
/// start gate and the liveness endpoint, so "live" means one thing.
/// <para>
/// <b>The reads are batched.</b> The index is fetched, then every per-instance read is issued before any
/// is awaited, so a processor costs two round trips however many replicas it has. Individual GETs rather
/// than one MGET: a multi-key command against a clustered Redis fails when the keys span hash slots, and
/// these do.
/// </para>
/// <para>
/// <b>Strictly read-only.</b> An index member whose key has expired is counted as absent and left alone;
/// pruning belongs to the orphan sweep. Each per-instance value is external, self-registered data, so
/// every bad state is counted rather than thrown. Only a transport fault propagates, untouched, and the
/// caller tags it.
/// </para>
/// </summary>
internal sealed class ProcessorLivenessProbe
{
    private readonly IConnectionMultiplexer _multiplexer;
    private readonly TimeProvider _clock;

    public ProcessorLivenessProbe(IConnectionMultiplexer multiplexer, TimeProvider clock)
    {
        _multiplexer = multiplexer ?? throw new ArgumentNullException(nameof(multiplexer));
        _clock = clock ?? throw new ArgumentNullException(nameof(clock));
    }

    public async Task<ProcessorLiveness> ProbeAsync(Guid processorId, CancellationToken ct)
    {
        // The Redis client takes no token of its own, so this is the only place cancellation can land.
        ct.ThrowIfCancellationRequested();

        var db = _multiplexer.GetDatabase();
        var now = _clock.GetUtcNow().UtcDateTime;
        var members = await db.SetMembersAsync(L2ProjectionKeys.ProcessorInstances(processorId));

        var reads = new Task<RedisValue>[members.Length];
        for (var i = 0; i < members.Length; i++)
        {
            reads[i] = db.StringGetAsync(L2ProjectionKeys.PerInstance(processorId, members[i].ToString()));
        }
        var values = await Task.WhenAll(reads);

        int healthy = 0, absent = 0, unhealthy = 0, stale = 0, malformed = 0;
        foreach (var raw in values)
        {
            if (raw.IsNullOrEmpty) { absent++; continue; }

            ProcessorLivenessEntry? entry;
            // Any deserialization failure on external data counts as malformed, never a 500.
            try { entry = JsonSerializer.Deserialize<ProcessorLivenessEntry>(raw!); }
            catch (Exception ex) when (ex is JsonException or NotSupportedException) { malformed++; continue; }
            if (entry?.Summary is null) { malformed++; continue; }
            // Ordinal: the writer is the sole producer and always emits the canonical constant.
            if (!string.Equals(entry.Status, LivenessStatus.Healthy, StringComparison.Ordinal)) { unhealthy++; continue; }
            if (entry.Timestamp.AddSeconds(entry.Interval * 2) <= now) { stale++; continue; }
            healthy++;
        }

        return new ProcessorLiveness(processorId, members.Length, healthy, absent, unhealthy, stale, malformed);
    }
}
```

Replace the body of `ProcessorLivenessValidator` (keep its class doc comment, trimming the paragraphs that now live on the probe to one sentence pointing at `ProcessorLivenessProbe`):

```csharp
internal sealed class ProcessorLivenessValidator
{
    private readonly ProcessorLivenessProbe _probe;

    public ProcessorLivenessValidator(IConnectionMultiplexer multiplexer, TimeProvider clock)
        => _probe = new ProcessorLivenessProbe(multiplexer, clock);

    /// <summary>Throws for the first participating processor with no healthy, fresh replica.</summary>
    public async Task ValidateAsync(WorkflowGraphSnapshot snapshot, CancellationToken ct)
    {
        foreach (var proc in snapshot.Processors.Values)
        {
            var liveness = await _probe.ProbeAsync(proc.Id, ct);
            if (!liveness.Live)
            {
                throw OrchestrationValidationException.ProcessorNotLive(proc.Id, liveness.Reason);
            }
        }
    }

    /// <summary>Every participating processor with no healthy, fresh replica, in snapshot order.</summary>
    public async Task<IReadOnlyList<OrchestrationValidationException>> CollectAsync(WorkflowGraphSnapshot snapshot, CancellationToken ct)
    {
        var problems = new List<OrchestrationValidationException>();
        foreach (var proc in snapshot.Processors.Values)
        {
            var liveness = await _probe.ProbeAsync(proc.Id, ct);
            if (!liveness.Live)
            {
                problems.Add(OrchestrationValidationException.ProcessorNotLive(proc.Id, liveness.Reason));
            }
        }
        return problems;
    }
}
```

Remove `using System.Text.Json;` from the validator if nothing else there uses it.

- [ ] **Step 4: Run the new tests and the gate's existing tests**

```bash
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.Orchestration.ProcessorLivenessProbeTests" --filter-class "BaseApi.Tests.Orchestration.ProcessorLivenessValidatorTests"
```

Expected: 3 new tests pass and every existing `ProcessorLivenessValidatorTests` test passes unchanged. If an existing test asserts that deserialization stops after the first healthy replica (for example by checking a sibling's value is never read), it no longer holds: report it as DONE_WITH_CONCERNS with the test name instead of editing it.

- [ ] **Step 5: Commit**

```bash
git add src/BaseApi.Service/Features/Orchestration/Validation/ProcessorLivenessProbe.cs src/BaseApi.Service/Features/Orchestration/Validation/ProcessorLivenessValidator.cs src/tests/BaseApi.Tests/Orchestration/ProcessorLivenessProbeTests.cs
git commit -m "feat(orchestration): shared liveness probe and collect mode for the liveness gate"
```

---

### Task 3: `GET /api/v1/orchestration/live`

**Files:**
- Create: `src/BaseApi.Service/Features/Orchestration/ILiveWorkflowReader.cs`
- Modify: `src/BaseApi.Service/Features/Orchestration/Projection/L2LiveSet.cs`, `OrchestrationController.cs`, `OrchestrationServiceCollectionExtensions.cs`
- Test: `src/tests/BaseApi.Tests/Orchestration/LiveWorkflowListTests.cs`

**Interfaces:**
- Produces: `public interface ILiveWorkflowReader { Task<IReadOnlyList<Guid>> ListAsync(CancellationToken ct); }`, implemented by `L2LiveSet`; `OrchestrationController(OrchestrationService service, ILiveWorkflowReader live)`; `GET /api/v1/orchestration/live` → 200 with a JSON array of workflow ids, sorted.

`skp:live` changes asynchronously: `/start` and `/stop` answer 202 and the queue handler updates the set afterwards. The studio polls this endpoint and shows "starting…" until the id appears.

- [ ] **Step 1: Write the failing tests**

Create `src/tests/BaseApi.Tests/Orchestration/LiveWorkflowListTests.cs`:

```csharp
using BaseApi.Service.Features.Orchestration;
using BaseApi.Service.Features.Orchestration.Projection;
using BaseApi.Tests.Support;
using Messaging.Contracts.Projections;
using Microsoft.AspNetCore.Mvc;
using NSubstitute;
using NSubstitute.ExceptionExtensions;
using StackExchange.Redis;
using Xunit;

namespace BaseApi.Tests.Orchestration;

public sealed class LiveWorkflowListTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task ListsEveryRunningWorkflowSortedAndSkipsMembersThatAreNotIds()
    {
        var l2 = new InMemoryL2();
        var (a, b) = (Guid.NewGuid(), Guid.NewGuid());
        await l2.Db.SetAddAsync(L2ProjectionKeys.Live(), b.ToString("D"));
        await l2.Db.SetAddAsync(L2ProjectionKeys.Live(), "not-a-workflow");
        await l2.Db.SetAddAsync(L2ProjectionKeys.Live(), a.ToString("D"));

        var ids = await new L2LiveSet(l2.Multiplexer).ListAsync(Ct);

        Assert.Equal(new[] { a, b }.OrderBy(x => x), ids);
    }

    [Fact]
    public async Task AnEmptyLiveSetIsAnEmptyList()
    {
        Assert.Empty(await new L2LiveSet(new InMemoryL2().Multiplexer).ListAsync(Ct));
    }

    [Fact]
    public async Task ARedisFaultPropagatesTaggedWithItsOperation()
    {
        var db = Substitute.For<IDatabase>();
        db.SetMembersAsync(Arg.Any<RedisKey>(), Arg.Any<CommandFlags>())
            .ThrowsAsync(new RedisConnectionException(ConnectionFailureType.UnableToConnect, "down"));
        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase().Returns(db);

        var ex = await Assert.ThrowsAsync<RedisConnectionException>(() => new L2LiveSet(redis).ListAsync(Ct));

        Assert.Equal("ListLiveWorkflows", ex.Data["redisOp"]);
    }

    [Fact]
    public async Task TheControllerAnswersTheList()
    {
        var id = Guid.NewGuid();
        var reader = Substitute.For<ILiveWorkflowReader>();
        reader.ListAsync(Arg.Any<CancellationToken>()).Returns(new[] { id });

        var result = await new OrchestrationController(service: null!, reader).Live(Ct);

        Assert.Equal([id], Assert.IsAssignableFrom<IReadOnlyList<Guid>>(Assert.IsType<OkObjectResult>(result.Result).Value));
    }
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo`
Expected: build error `'L2LiveSet' does not contain a definition for 'ListAsync'`.

- [ ] **Step 3: Implement**

Create `src/BaseApi.Service/Features/Orchestration/ILiveWorkflowReader.cs`:

```csharp
namespace BaseApi.Service.Features.Orchestration;

/// <summary>
/// The workflows that are running: the members of the <c>skp:live</c> set. Read through BaseApi so the
/// studio never couples to Redis or its key layout.
/// </summary>
public interface ILiveWorkflowReader
{
    /// <summary>Every running workflow id, sorted. A member that is not a workflow id is skipped.</summary>
    Task<IReadOnlyList<Guid>> ListAsync(CancellationToken ct);
}
```

In `L2LiveSet.cs`: make the class implement it (`internal sealed class L2LiveSet : ILiveWorkflowReader`), add `using StackExchange.Redis;` if absent, extend the class summary with "It also answers the read side for the studio's status (<see cref=\"ILiveWorkflowReader\"/>).", and add:

```csharp
    public async Task<IReadOnlyList<Guid>> ListAsync(CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        RedisValue[] members;
        try
        {
            members = await _multiplexer.GetDatabase().SetMembersAsync(L2ProjectionKeys.Live());
        }
        catch (RedisException ex)
        {
            // Tagged so the 500 body names a stable operation rather than a transport message.
            ex.Data["redisOp"] = "ListLiveWorkflows";
            throw;
        }

        var ids = new List<Guid>(members.Length);
        foreach (var member in members)
        {
            // A member that is not a workflow id is skipped, not reported: it is whatever happens to be
            // in the store, and one unusable entry must not hide the rest.
            if (Guid.TryParseExact(member.ToString(), "D", out var id))
            {
                ids.Add(id);
            }
        }

        ids.Sort();
        return ids;
    }
```

`RedisConnectionException` derives from `RedisException`, so the catch covers the test's fault.

In `OrchestrationController.cs`: add a field `private readonly ILiveWorkflowReader _live;`, change the constructor to

```csharp
    public OrchestrationController(OrchestrationService service, ILiveWorkflowReader live)
    {
        _service = service;
        _live = live ?? throw new ArgumentNullException(nameof(live));
    }
```

(the `service` null guard moves to DI: the test passes `null!` for it), and add after `Stop`:

```csharp
    /// <summary>
    /// The running workflows. Start and stop are queued (both answer 202), so a workflow appears here
    /// a moment after its start was accepted and leaves a moment after its stop.
    /// </summary>
    [HttpGet("live")]
    [ProducesResponseType(typeof(IReadOnlyList<Guid>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ProblemDetails), StatusCodes.Status500InternalServerError)]
    public async Task<ActionResult<IReadOnlyList<Guid>>> Live(CancellationToken ct)
        => Ok(await _live.ListAsync(ct));
```

Update the class doc comment: "Two endpoints, start and stop" becomes "Start and stop, each acting on a single workflow id supplied as the request body and returning 202 Accepted, plus a read of the running workflows."

In `OrchestrationServiceCollectionExtensions.AddOrchestrationFeature`, after `services.AddScoped<L2LiveSet>();` add:

```csharp
        // The studio's status read: the same live set, through a public interface the controller can take.
        services.AddScoped<ILiveWorkflowReader>(sp => sp.GetRequiredService<L2LiveSet>());
```

- [ ] **Step 4: Run the tests**

```bash
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.Orchestration.LiveWorkflowListTests"
```

Expected: 4 passed. If `InMemoryL2` does not route `SetAddAsync` or `SetMembersAsync` (check its `Wire` method), seed through whatever it does route and say so in the report.

- [ ] **Step 5: Commit**

```bash
git add src/BaseApi.Service/Features/Orchestration/ILiveWorkflowReader.cs src/BaseApi.Service/Features/Orchestration/Projection/L2LiveSet.cs src/BaseApi.Service/Features/Orchestration/OrchestrationController.cs src/BaseApi.Service/Features/Orchestration/OrchestrationServiceCollectionExtensions.cs src/tests/BaseApi.Tests/Orchestration/LiveWorkflowListTests.cs
git commit -m "feat(orchestration): GET /orchestration/live lists the running workflows"
```

---

### Task 4: `GET /api/v1/processors/liveness`

**Files:**
- Create: `src/BaseApi.Service/Features/Processor/ProcessorLiveness.cs`
- Modify: `src/BaseApi.Service/Features/Processor/ProcessorController.cs`, `src/BaseApi.Service/Features/Processor/ProcessorServiceCollectionExtensions.cs`, `src/BaseApi.Service/Features/Orchestration/OrchestrationServiceCollectionExtensions.cs`
- Test: `src/tests/BaseApi.Tests/Orchestration/ProcessorLivenessReaderTests.cs`

**Interfaces:**
- Consumes: `ProcessorLivenessProbe` (Task 2).
- Produces: `public sealed record ProcessorLivenessDto(Guid ProcessorId, bool Live, int Replicas, int Healthy, int Absent, int Unhealthy, int Stale, int Malformed)`; `public interface IProcessorLivenessReader { Task<IReadOnlyList<ProcessorLivenessDto>> ReadAllAsync(CancellationToken ct); }`; `GET /api/v1/processors/liveness` → 200 with one entry per processor row, ordered by name then id.

- [ ] **Step 1: Write the failing tests**

Create `src/tests/BaseApi.Tests/Orchestration/ProcessorLivenessReaderTests.cs`. Copy the `using` directives of `ProcessorLivenessProbeTests.cs` (Task 2) and add `using BaseApi.Service; using BaseApi.Service.Features.Processor; using Microsoft.EntityFrameworkCore; using NSubstitute.ExceptionExtensions;`.

```csharp
namespace BaseApi.Tests.Orchestration;

public sealed class ProcessorLivenessReaderTests
{
    private static readonly DateTime Now = new(2026, 1, 1, 12, 0, 0, DateTimeKind.Utc);
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private readonly IDatabase _db = Substitute.For<IDatabase>();
    private readonly FakeTimeProvider _clock = new(new DateTimeOffset(Now, TimeSpan.Zero));

    private ProcessorLivenessProbe Probe()
    {
        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase().Returns(_db);
        return new ProcessorLivenessProbe(redis, _clock);
    }

    private static AppDbContext Db() =>
        new(new DbContextOptionsBuilder<AppDbContext>().UseInMemoryDatabase($"liveness-{Guid.NewGuid():N}").Options);

    private static async Task<Guid> AddProcessor(AppDbContext db, string name)
    {
        var p = new ProcessorEntity { Id = Guid.NewGuid(), Name = name, Version = "1.0.0", SourceHash = Guid.NewGuid().ToString("N") };
        db.Add(p);
        await db.SaveChangesAsync(Ct);
        return p.Id;
    }

    private static RedisValue Healthy() =>
        JsonSerializer.Serialize(new ProcessorLivenessEntry(Now, 10, LivenessStatus.Healthy,
            new LivenessSummary(SchemaOutcome.Success, SchemaOutcome.Success, SchemaOutcome.Success)));

    [Fact]
    public async Task ReportsEveryProcessorRowOrderedByName()
    {
        await using var db = Db();
        var zeta = await AddProcessor(db, "zeta");
        var alpha = await AddProcessor(db, "alpha");
        _db.SetMembersAsync(L2ProjectionKeys.ProcessorInstances(alpha)).Returns(new RedisValue[] { "i1" });
        _db.StringGetAsync(L2ProjectionKeys.PerInstance(alpha, "i1")).Returns(Healthy());
        _db.SetMembersAsync(L2ProjectionKeys.ProcessorInstances(zeta)).Returns(Array.Empty<RedisValue>());

        var result = await new ProcessorLivenessReader(db, Probe()).ReadAllAsync(Ct);

        Assert.Equal(
            [new ProcessorLivenessDto(alpha, true, 1, 1, 0, 0, 0, 0), new ProcessorLivenessDto(zeta, false, 0, 0, 0, 0, 0, 0)],
            result);
    }

    [Fact]
    public async Task ARedisFaultPropagatesTaggedWithItsOperation()
    {
        await using var db = Db();
        await AddProcessor(db, "p");
        _db.SetMembersAsync(Arg.Any<RedisKey>(), Arg.Any<CommandFlags>())
            .ThrowsAsync(new RedisConnectionException(ConnectionFailureType.UnableToConnect, "down"));

        var ex = await Assert.ThrowsAsync<RedisConnectionException>(() => new ProcessorLivenessReader(db, Probe()).ReadAllAsync(Ct));

        Assert.Equal("ProcessorLivenessRead", ex.Data["redisOp"]);
    }
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo`
Expected: build error `The type or namespace name 'ProcessorLivenessReader' could not be found`.

- [ ] **Step 3: Implement**

Create `src/BaseApi.Service/Features/Processor/ProcessorLiveness.cs`:

```csharp
using BaseApi.Core.Persistence;
using BaseApi.Service.Features.Orchestration.Validation;
using Microsoft.EntityFrameworkCore;
using StackExchange.Redis;

namespace BaseApi.Service.Features.Processor;

/// <summary>
/// One processor's liveness as the start gate judges it: live when any replica is present, healthy and
/// fresh. The counts classify every replica, so the studio can say why a processor is not live.
/// </summary>
public sealed record ProcessorLivenessDto(
    Guid ProcessorId, bool Live, int Replicas, int Healthy, int Absent, int Unhealthy, int Stale, int Malformed);

/// <summary>Every processor's liveness, read through BaseApi so the studio never reads Redis itself.</summary>
public interface IProcessorLivenessReader
{
    Task<IReadOnlyList<ProcessorLivenessDto>> ReadAllAsync(CancellationToken ct);
}

/// <summary>
/// Probes every processor row, in name order. Two Redis round trips per processor (see
/// <see cref="ProcessorLivenessProbe"/>); a workflow editor's processor count keeps that small.
/// </summary>
internal sealed class ProcessorLivenessReader : IProcessorLivenessReader
{
    private readonly BaseDbContext _db;
    private readonly ProcessorLivenessProbe _probe;

    public ProcessorLivenessReader(BaseDbContext db, ProcessorLivenessProbe probe)
    {
        _db = db ?? throw new ArgumentNullException(nameof(db));
        _probe = probe ?? throw new ArgumentNullException(nameof(probe));
    }

    public async Task<IReadOnlyList<ProcessorLivenessDto>> ReadAllAsync(CancellationToken ct)
    {
        var ids = await _db.Set<ProcessorEntity>().AsNoTracking()
            .OrderBy(p => p.Name).ThenBy(p => p.Id)
            .Select(p => p.Id)
            .ToListAsync(ct);

        var result = new List<ProcessorLivenessDto>(ids.Count);
        try
        {
            foreach (var id in ids)
            {
                var l = await _probe.ProbeAsync(id, ct);
                result.Add(new ProcessorLivenessDto(id, l.Live, l.Replicas, l.Healthy, l.Absent, l.Unhealthy, l.Stale, l.Malformed));
            }
        }
        catch (RedisException ex)
        {
            // Tagged so the 500 body names a stable operation; never answered as "not live".
            ex.Data["redisOp"] = "ProcessorLivenessRead";
            throw;
        }
        return result;
    }
}
```

In `ProcessorController.cs`: add `using BaseApi.Service.Features.Processor;` if needed (same namespace — then not needed), a field `private readonly IProcessorLivenessReader _liveness;`, a third constructor parameter `IProcessorLivenessReader liveness` with `_liveness = liveness ?? throw new ArgumentNullException(nameof(liveness));`, and after `GetBySourceHash`:

```csharp
    /// <summary>
    /// Every processor's liveness, as the start gate judges it. A Redis fault is a 500, never a
    /// "not live" answer.
    /// </summary>
    [HttpGet("liveness")]
    [ProducesResponseType(typeof(IReadOnlyList<ProcessorLivenessDto>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ProblemDetails), StatusCodes.Status500InternalServerError)]
    public async Task<ActionResult<IReadOnlyList<ProcessorLivenessDto>>> Liveness(CancellationToken ct)
        => Ok(await _liveness.ReadAllAsync(ct));
```

`liveness` is a literal segment, so it does not collide with the inherited `{id:guid}` route.

Registrations:
- In `OrchestrationServiceCollectionExtensions.AddOrchestrationFeature`, after `services.AddScoped<ProcessorLivenessValidator>();`: `services.AddScoped<ProcessorLivenessProbe>();` with the comment `// Shared by the liveness endpoint; the gate builds its own from the same two dependencies.`
- In `ProcessorServiceCollectionExtensions` (the processor feature's registration method), add `services.AddScoped<IProcessorLivenessReader, ProcessorLivenessReader>();` with `using BaseApi.Service.Features.Processor;` as needed.

Search the test project for `new ProcessorsController(` and add the new argument (`null!` where the test does not exercise liveness) to every call.

- [ ] **Step 4: Run the tests and the full hermetic suite**

```bash
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.Orchestration.ProcessorLivenessReaderTests"
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-not-trait "Category=RealStack" --filter-not-namespace "BaseApi.Tests.Live*"
```

Expected: 2 passed, then 0 failed.

- [ ] **Step 5: Commit**

```bash
git add src/BaseApi.Service/Features/Processor src/BaseApi.Service/Features/Orchestration/OrchestrationServiceCollectionExtensions.cs src/tests/BaseApi.Tests
git commit -m "feat(processor): GET /processors/liveness, judged as the start gate judges it"
```

---

### Task 5: `POST /api/v1/workflows/{id}/validate` -- the dry run

**Files:**
- Create: `src/BaseApi.Service/Features/Orchestration/WorkflowValidation.cs`, `src/BaseApi.Service/Features/Orchestration/Validation/GraphDryRun.cs`, `src/BaseApi.Service/Features/Orchestration/WorkflowValidator.cs`
- Modify: `src/BaseApi.Service/Features/Workflow/WorkflowController.cs`, `OrchestrationServiceCollectionExtensions.cs`, `src/tests/BaseApi.Tests/WorkflowGraph/GraphHarness.cs`, `WorkflowLayoutTests.cs`, `WorkflowGraphControllerTests.cs`
- Test: `src/tests/BaseApi.Tests/WorkflowGraph/WorkflowValidatorTests.cs`

**Interfaces:**
- Consumes: the four gates' collect mode (Tasks 1–2); `IWorkflowGraphSaver`, `GraphSaveRequest` (plan 1); `IWorkflowGraphLoader.LoadL1Async` (existing).
- Produces:
  - `public sealed record WorkflowProblemDto(string Gate, string Title, string Detail, object Offending)`; `public sealed record WorkflowValidationDto(bool Valid, List<WorkflowProblemDto> Problems)`; `public interface IWorkflowValidator { Task<WorkflowValidationDto> ValidateAsync(Guid workflowId, GraphSaveRequest? draft, CancellationToken ct); }`.
  - `internal interface IGraphDryRun { Task<T> RunAsync<T>(Func<CancellationToken, Task<T>> work, CancellationToken ct); }` and `RelationalGraphDryRun`.
  - `WorkflowsController(service, db, graphReader, graphSaver, IWorkflowValidator validator)`; `POST /api/v1/workflows/{id}/validate` with an optional `GraphSaveRequest` body.

How the dry run reuses everything: inside one transaction, the draft is applied by the real graph saver, the result is loaded by the same loader the start path uses (it shares the scoped context and so sees the uncommitted rows), every gate collects, and the transaction is rolled back. The problems are the gates' own: same `Gate`, `Title`, detail and `Offending` as a start's 422. With no body, the stored workflow is validated as it is.

EF InMemory has no transactions (`BeginTransaction` throws by default) and cannot roll back, so the transaction sits behind `IGraphDryRun`. The hermetic tests use a pass-through implementation and assert the problems; Task 6 proves on Postgres that nothing is persisted.

- [ ] **Step 1: Extend the harness and write the failing tests**

In `GraphHarness.cs`: keep the loader built in the constructor as a property `public IWorkflowGraphLoader Loader { get; }` (assign it before `Reader` uses it), add `using BaseApi.Service.Features.Orchestration; using BaseApi.Service.Features.Orchestration.Validation; using StackExchange.Redis;`, and add:

```csharp
    /// <summary>
    /// The dry-run validator over this harness. InMemory has no transactions, so the dry run is a pass
    /// through here: what the draft writes stays written, and these tests assert problems only.
    /// WorkflowValidationLiveTests proves on Postgres that nothing persists.
    /// </summary>
    public IWorkflowValidator Validator(IConnectionMultiplexer redis) =>
        new WorkflowValidator(
            Db, Saver, Loader,
            new CycleDetector(), new SchemaEdgeValidator(), new PayloadConfigSchemaValidator(),
            new ProcessorLivenessValidator(redis, Clock),
            new PassThroughDryRun(Db));

    private sealed class PassThroughDryRun(AppDbContext db) : IGraphDryRun
    {
        public async Task<T> RunAsync<T>(Func<CancellationToken, Task<T>> work, CancellationToken ct)
        {
            try { return await work(ct); }
            finally { db.ChangeTracker.Clear(); }
        }
    }
```

In `WorkflowLayoutTests.NewController`, the constructor call gains `validator: null!`. In `WorkflowGraphControllerTests.Controller`, it gains `h.Validator(RedisStub.AllLive(h.Clock))` (the helper below).

Create `src/tests/BaseApi.Tests/WorkflowGraph/WorkflowValidatorTests.cs`. Copy the `using` directives that bring `ProcessorLivenessEntry`, `LivenessSummary`, `LivenessStatus` and `SchemaOutcome` from `src/tests/BaseApi.Tests/Orchestration/ProcessorLivenessValidatorTests.cs`, and add `using System.Text.Json; using BaseApi.Core.Exceptions; using BaseApi.Service.Features.Orchestration; using BaseApi.Service.Features.Step; using BaseApi.Service.Features.Workflow.Graph; using FluentValidation; using Microsoft.Extensions.Time.Testing; using NSubstitute; using NSubstitute.ExceptionExtensions; using StackExchange.Redis; using Xunit;`.

```csharp
namespace BaseApi.Tests.WorkflowGraph;

/// <summary>Redis stand-ins for the liveness gate: every processor live, none live, or Redis down.</summary>
internal static class RedisStub
{
    public static IConnectionMultiplexer AllLive(FakeTimeProvider clock)
    {
        var db = Substitute.For<IDatabase>();
        db.SetMembersAsync(Arg.Any<RedisKey>(), Arg.Any<CommandFlags>()).Returns(new RedisValue[] { "i1" });
        db.StringGetAsync(Arg.Any<RedisKey>(), Arg.Any<CommandFlags>()).Returns((RedisValue)JsonSerializer.Serialize(
            new ProcessorLivenessEntry(clock.GetUtcNow().UtcDateTime, 10, LivenessStatus.Healthy,
                new LivenessSummary(SchemaOutcome.Success, SchemaOutcome.Success, SchemaOutcome.Success))));
        return Wrap(db);
    }

    public static IConnectionMultiplexer NoneLive()
    {
        var db = Substitute.For<IDatabase>();
        db.SetMembersAsync(Arg.Any<RedisKey>(), Arg.Any<CommandFlags>()).Returns(Array.Empty<RedisValue>());
        return Wrap(db);
    }

    public static IConnectionMultiplexer Down()
    {
        var db = Substitute.For<IDatabase>();
        db.SetMembersAsync(Arg.Any<RedisKey>(), Arg.Any<CommandFlags>())
            .ThrowsAsync(new RedisConnectionException(ConnectionFailureType.UnableToConnect, "down"));
        return Wrap(db);
    }

    private static IConnectionMultiplexer Wrap(IDatabase db)
    {
        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase().Returns(db);
        return redis;
    }
}

public sealed class WorkflowValidatorTests
{
    [Fact]
    public async Task AStoredWorkflowWithNoProblemsIsValid()
    {
        await using var h = new GraphHarness();
        var b = await h.StepAsync(await h.ProcessorAsync(), "b");
        var a = await h.StepAsync(await h.ProcessorAsync(), "a", b);
        var wf = await h.WorkflowAsync("wf", [a]);

        var result = await h.Validator(RedisStub.AllLive(h.Clock)).ValidateAsync(wf, null, h.Ct);

        Assert.True(result.Valid);
        Assert.Empty(result.Problems);
    }

    [Fact]
    public async Task ADraftThatCreatesACycleReportsItWithoutThrowing()
    {
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var b = await h.StepAsync(proc, "b");
        var a = await h.StepAsync(proc, "a", b);
        var wf = await h.WorkflowAsync("wf", [a]);
        var loaded = await h.Reader.ReadAsync(wf, h.Ct);
        var bLoaded = loaded.Steps.Single(s => s.Id == b);
        h.Forget();

        var draft = GraphHarness.Request([a], loaded.Workflow.UpdatedAt,
            steps: [new GraphStepDto(b, bLoaded.UpdatedAt, "b", "1.0.0", null, proc, [a], StepEntryCondition.PreviousCompleted)]);
        var result = await h.Validator(RedisStub.AllLive(h.Clock)).ValidateAsync(wf, draft, h.Ct);

        Assert.False(result.Valid);
        var cycle = Assert.Single(result.Problems);
        Assert.Equal("cycle", cycle.Gate);
        Assert.Equal("Workflow contains a cycle", cycle.Title);
    }

    [Fact]
    public async Task EveryGateReportsAtOnce()
    {
        await using var h = new GraphHarness();
        var (sOut, sIn) = (await h.SchemaAsync("out"), await h.SchemaAsync("in"));
        var cfg = await h.SchemaAsync("cfg", definition: """{"type":"object","required":["url"]}""");
        var child = await h.StepAsync(await h.ProcessorAsync("child", input: sIn, config: cfg), "child");
        var parent = await h.StepAsync(await h.ProcessorAsync("parent", output: sOut), "parent", child);
        var asg = await h.AssignmentAsync(child, "{}");
        var wf = await h.WorkflowAsync("wf", [parent], [asg]);

        var result = await h.Validator(RedisStub.NoneLive()).ValidateAsync(wf, null, h.Ct);

        Assert.False(result.Valid);
        Assert.Equal(["schemaEdge", "payloadConfigSchema", "processorLiveness", "processorLiveness"], result.Problems.Select(p => p.Gate));
    }

    [Fact]
    public async Task ADraftForAWorkflowThatDoesNotExistYetIsValidated()
    {
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var (wf, a) = (Guid.NewGuid(), Guid.NewGuid());

        var result = await h.Validator(RedisStub.AllLive(h.Clock)).ValidateAsync(wf,
            GraphHarness.Request([a], steps: [GraphHarness.NewStep(a, proc, "a", a)]), h.Ct);

        Assert.Equal("cycle", Assert.Single(result.Problems).Gate);
    }

    [Fact]
    public async Task NoDraftAndNoSuchWorkflowIsNotFound()
    {
        await using var h = new GraphHarness();
        await Assert.ThrowsAsync<NotFoundException>(() => h.Validator(RedisStub.AllLive(h.Clock)).ValidateAsync(Guid.NewGuid(), null, h.Ct));
    }

    [Fact]
    public async Task AnEmptyIdIsAValidationFailure()
    {
        await using var h = new GraphHarness();
        await Assert.ThrowsAsync<ValidationException>(() => h.Validator(RedisStub.AllLive(h.Clock)).ValidateAsync(Guid.Empty, null, h.Ct));
    }

    [Fact]
    public async Task ADraftWithFieldErrorsIsStillA400()
    {
        await using var h = new GraphHarness();
        await Assert.ThrowsAsync<ValidationException>(() =>
            h.Validator(RedisStub.AllLive(h.Clock)).ValidateAsync(Guid.NewGuid(), GraphHarness.Request(entry: []), h.Ct));
    }

    [Fact]
    public async Task RedisDownIsATaggedFaultNotANotLiveAnswer()
    {
        // Review focus 2.
        await using var h = new GraphHarness();
        var a = await h.StepAsync(await h.ProcessorAsync());
        var wf = await h.WorkflowAsync("wf", [a]);

        var ex = await Assert.ThrowsAsync<RedisConnectionException>(() => h.Validator(RedisStub.Down()).ValidateAsync(wf, null, h.Ct));

        Assert.Equal("ValidateLiveness", ex.Data["redisOp"]);
    }
}
```

Append to `WorkflowGraphControllerTests.cs`:

```csharp
    [Fact]
    public async Task ValidateReturnsTheProblems()
    {
        await using var h = new GraphHarness();
        var a = await h.StepAsync(await h.ProcessorAsync());
        var wf = await h.WorkflowAsync("wf", [a]);

        var ok = Assert.IsType<OkObjectResult>(await Controller(h).Validate(wf, null, h.Ct));
        Assert.True(Assert.IsType<WorkflowValidationDto>(ok.Value).Valid);
    }
```

(with `using BaseApi.Service.Features.Orchestration;` at the top of that file.)

- [ ] **Step 2: Run them to verify they fail**

Run: `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo`
Expected: build error `The type or namespace name 'WorkflowValidator' could not be found`.

- [ ] **Step 3: Implement the DTOs, the dry-run seam and the validator**

Create `src/BaseApi.Service/Features/Orchestration/WorkflowValidation.cs`:

```csharp
using BaseApi.Service.Features.Workflow.Graph;

namespace BaseApi.Service.Features.Orchestration;

/// <summary>
/// One start-gate problem, described exactly as a start's 422 describes it: the gate, its title, the
/// detail, and the gate's offending payload (entity ids and flattened messages only).
/// </summary>
public sealed record WorkflowProblemDto(string Gate, string Title, string Detail, object Offending);

/// <summary>Every problem a start of this workflow would refuse, from every gate, in gate order.</summary>
public sealed record WorkflowValidationDto(bool Valid, List<WorkflowProblemDto> Problems);

/// <summary>
/// Runs every workflow-start gate against a draft, or the stored workflow when there is none, without
/// saving and without starting. One implementation of each rule: the studio never re-implements them.
/// </summary>
public interface IWorkflowValidator
{
    Task<WorkflowValidationDto> ValidateAsync(Guid workflowId, GraphSaveRequest? draft, CancellationToken ct);
}
```

Create `src/BaseApi.Service/Features/Orchestration/Validation/GraphDryRun.cs`:

```csharp
using BaseApi.Core.Persistence;

namespace BaseApi.Service.Features.Orchestration.Validation;

/// <summary>Runs work whose database writes must not survive it.</summary>
internal interface IGraphDryRun
{
    Task<T> RunAsync<T>(Func<CancellationToken, Task<T>> work, CancellationToken ct);
}

/// <summary>
/// A transaction that is always rolled back. Everything the work does through the scoped context --
/// the graph saver's writes, the loader's reads of them -- runs on that transaction's connection, so
/// the reads see the uncommitted rows and nothing is ever committed. The tracker is cleared afterwards,
/// because the saver leaves the rolled-back entities tracked. Legal here because the context has no
/// retrying execution strategy.
/// </summary>
internal sealed class RelationalGraphDryRun : IGraphDryRun
{
    private readonly BaseDbContext _db;

    public RelationalGraphDryRun(BaseDbContext db) => _db = db ?? throw new ArgumentNullException(nameof(db));

    public async Task<T> RunAsync<T>(Func<CancellationToken, Task<T>> work, CancellationToken ct)
    {
        await using var transaction = await _db.Database.BeginTransactionAsync(ct);
        try
        {
            return await work(ct);
        }
        finally
        {
            // Not the request's token: a cancelled request must still roll back.
            await transaction.RollbackAsync(CancellationToken.None);
            _db.ChangeTracker.Clear();
        }
    }
}
```

Create `src/BaseApi.Service/Features/Orchestration/WorkflowValidator.cs`:

```csharp
using BaseApi.Core.Exceptions;
using BaseApi.Core.Persistence;
using BaseApi.Service.Features.Orchestration.Loading;
using BaseApi.Service.Features.Orchestration.Validation;
using BaseApi.Service.Features.Workflow;
using BaseApi.Service.Features.Workflow.Graph;
using FluentValidation;
using FluentValidation.Results;
using Microsoft.EntityFrameworkCore;
using StackExchange.Redis;

namespace BaseApi.Service.Features.Orchestration;

/// <summary>
/// The dry run behind <c>POST /workflows/{id}/validate</c>: apply the draft with the real graph saver,
/// load the result with the loader the start path uses, collect every gate's problems in the start's
/// locked order, and roll everything back.
/// <para>
/// <b>Nothing escapes.</b> This never builds a start definition, never sends to the broker and never
/// writes Redis; its only Redis access is the read-only liveness probe. The draft's database writes live
/// inside <see cref="IGraphDryRun"/>, which always rolls back.
/// </para>
/// <para>
/// <b>Request-shape failures keep the save's statuses.</b> A draft with field errors is a 400, a stale
/// draft a 409, an FK violation a 422, exactly as <c>PUT /graph</c> would answer; only the gates' own
/// problems are returned as data.
/// </para>
/// </summary>
internal sealed class WorkflowValidator : IWorkflowValidator
{
    private readonly BaseDbContext _db;
    private readonly IWorkflowGraphSaver _saver;
    private readonly IWorkflowGraphLoader _loader;
    private readonly CycleDetector _cycles;
    private readonly SchemaEdgeValidator _schemaEdges;
    private readonly PayloadConfigSchemaValidator _payloads;
    private readonly ProcessorLivenessValidator _liveness;
    private readonly IGraphDryRun _dryRun;

    public WorkflowValidator(
        BaseDbContext db,
        IWorkflowGraphSaver saver,
        IWorkflowGraphLoader loader,
        CycleDetector cycles,
        SchemaEdgeValidator schemaEdges,
        PayloadConfigSchemaValidator payloads,
        ProcessorLivenessValidator liveness,
        IGraphDryRun dryRun)
    {
        _db = db;
        _saver = saver;
        _loader = loader;
        _cycles = cycles;
        _schemaEdges = schemaEdges;
        _payloads = payloads;
        _liveness = liveness;
        _dryRun = dryRun;
    }

    public Task<WorkflowValidationDto> ValidateAsync(Guid workflowId, GraphSaveRequest? draft, CancellationToken ct)
    {
        if (workflowId == Guid.Empty)
        {
            throw new ValidationException(new[] { new ValidationFailure(nameof(workflowId), "WorkflowId must not be Guid.Empty.") });
        }

        return _dryRun.RunAsync(async c =>
        {
            if (draft is not null)
            {
                await _saver.SaveAsync(workflowId, draft, c);
            }
            else if (!await _db.Set<WorkflowEntity>().AsNoTracking().AnyAsync(w => w.Id == workflowId, c))
            {
                throw new NotFoundException(nameof(WorkflowEntity), workflowId);
            }

            using var snapshot = await _loader.LoadL1Async(new[] { workflowId }, c);

            // The start's locked order: cycle and missing step, schema edge, payload, liveness.
            var problems = new List<OrchestrationValidationException>();
            problems.AddRange(_cycles.Collect(snapshot));
            problems.AddRange(_schemaEdges.Collect(snapshot));
            problems.AddRange(_payloads.Collect(snapshot));
            try
            {
                problems.AddRange(await _liveness.CollectAsync(snapshot, c));
            }
            catch (RedisException ex)
            {
                // A transport fault is a tagged 500, never a "not live" problem.
                ex.Data["redisOp"] = "ValidateLiveness";
                throw;
            }

            return new WorkflowValidationDto(
                problems.Count == 0,
                problems.Select(p => new WorkflowProblemDto(p.Gate, p.Title, p.Message, p.Offending)).ToList());
        }, ct);
    }
}
```

- [ ] **Step 4: Add the action and the registrations**

In `WorkflowController.cs`: add `using BaseApi.Service.Features.Orchestration;` and `using Microsoft.AspNetCore.Mvc.ModelBinding;`, a field `private readonly IWorkflowValidator _validator;`, a fifth constructor parameter `IWorkflowValidator validator` assigned to it, and after `PutGraph`:

```csharp
    /// <summary>
    /// Every problem a start of this workflow would refuse, from every gate -- cycles, missing steps,
    /// schema edges, payloads against config schemas, processor liveness -- without saving and without
    /// starting. The body is an optional draft in the shape of <c>PUT /graph</c>; without one, the stored
    /// workflow is checked. Gate problems are a 200 with <c>valid: false</c>; a draft the graph save would
    /// reject keeps that save's status.
    /// </summary>
    [HttpPost("{id:guid}/validate")]
    [ProducesResponseType(typeof(WorkflowValidationDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    [ProducesResponseType(StatusCodes.Status409Conflict)]
    [ProducesResponseType(StatusCodes.Status422UnprocessableEntity)]
    public async Task<IActionResult> Validate(
        Guid id,
        [FromBody(EmptyBodyBehavior = EmptyBodyBehavior.Allow)] GraphSaveRequest? request,
        CancellationToken ct)
        => Ok(await _validator.ValidateAsync(id, request, ct));
```

Add one sentence to the controller's class doc comment: "The validate action delegates to `IWorkflowValidator`."

In `OrchestrationServiceCollectionExtensions.AddOrchestrationFeature`, after the gate registrations:

```csharp
        // The dry run behind POST /workflows/{id}/validate. Scoped, like the context it rolls back.
        services.AddScoped<IGraphDryRun, RelationalGraphDryRun>();
        services.AddScoped<IWorkflowValidator, WorkflowValidator>();
```

- [ ] **Step 5: Run the new tests, then the full hermetic suite**

```bash
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.WorkflowGraph.WorkflowValidatorTests" --filter-class "BaseApi.Tests.WorkflowGraph.WorkflowGraphControllerTests"
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-not-trait "Category=RealStack" --filter-not-namespace "BaseApi.Tests.Live*"
```

Expected: 8 validator tests and every controller test pass, then the full suite reports 0 failed.

- [ ] **Step 6: Commit**

```bash
git add src/BaseApi.Service/Features/Orchestration src/BaseApi.Service/Features/Workflow/WorkflowController.cs src/tests/BaseApi.Tests/WorkflowGraph
git commit -m "feat(studio): POST /workflows/{id}/validate runs every start gate as a dry run"
```

---

### Task 6: Postgres proof (RealStack)

**Files:**
- Create: `src/tests/BaseApi.Tests/Live/WorkflowValidationLiveTests.cs`

**Interfaces:**
- Consumes: the three endpoints, deployed; `RealStack.SkipUnlessEnabled()`, `RealStack.BaseApiUrl`, `RealStack.Category`.

What InMemory cannot show: that the rolled-back transaction leaves nothing behind (review focus 1 and 5), and that the endpoints answer through the real wiring.

- [ ] **Step 1: Write the live tests**

Create `src/tests/BaseApi.Tests/Live/WorkflowValidationLiveTests.cs`:

```csharp
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Xunit;

namespace BaseApi.Tests.Live;

/// <summary>
/// The dry run against Postgres: whatever the draft writes is rolled back. Each test builds its own
/// rows and removes them afterwards.
/// </summary>
[Trait("Category", RealStack.Category)]
public sealed class WorkflowValidationLiveTests : IAsyncLifetime
{
    private readonly HttpClient _http = new() { BaseAddress = new Uri(RealStack.BaseApiUrl), Timeout = TimeSpan.FromSeconds(20) };
    private readonly List<string> _cleanup = [];
    private Guid _processor;

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        if (!RealStack.Enabled) return;
        var hash = Convert.ToHexString(Guid.NewGuid().ToByteArray().Concat(Guid.NewGuid().ToByteArray()).ToArray()).ToLowerInvariant();
        _processor = await PostAsync("processors", new { SourceHash = hash, Name = $"validate-live-{Guid.NewGuid():N}", Version = "1.0.0" });
    }

    public async ValueTask DisposeAsync()
    {
        // Workflows first (they cascade their junction rows), then steps after unwiring them, then the processor.
        foreach (var path in _cleanup.Where(p => p.StartsWith("workflows")))
        {
            try { await _http.DeleteAsync($"/api/v1/{path}"); } catch (Exception) { }
        }
        foreach (var path in _cleanup.Where(p => p.StartsWith("steps")))
        {
            try
            {
                using var get = await _http.GetAsync($"/api/v1/{path}");
                if (!get.IsSuccessStatusCode) continue;
                var s = JsonDocument.Parse(await get.Content.ReadAsStringAsync()).RootElement;
                await _http.PutAsJsonAsync($"/api/v1/{path}", new
                {
                    name = s.GetProperty("name").GetString(), version = s.GetProperty("version").GetString(),
                    description = (string?)null, processorId = s.GetProperty("processorId").GetGuid(),
                    nextStepIds = Array.Empty<Guid>(), entryCondition = s.GetProperty("entryCondition").GetInt32(),
                });
            }
            catch (Exception) { }
        }
        foreach (var path in _cleanup.Where(p => p.StartsWith("steps")))
        {
            try { await _http.DeleteAsync($"/api/v1/{path}"); } catch (Exception) { }
        }
        if (_processor != Guid.Empty)
        {
            try { await _http.DeleteAsync($"/api/v1/processors/{_processor}"); } catch (Exception) { }
        }
        _http.Dispose();
    }

    private async Task<Guid> PostAsync(string resource, object body)
    {
        using var response = await _http.PostAsJsonAsync($"/api/v1/{resource}", body, Ct);
        var text = await response.Content.ReadAsStringAsync(Ct);
        Assert.True(response.IsSuccessStatusCode, $"POST {resource} -> {(int)response.StatusCode}: {text}");
        return JsonDocument.Parse(text).RootElement.GetProperty("id").GetGuid();
    }

    private static object Step(Guid id, Guid processor, string? updatedAt = null, params Guid[] next) => new
    {
        id, updatedAt, name = $"v-{id:N}"[..12], version = "1.0.0", description = (string?)null,
        processorId = processor, nextStepIds = next, entryCondition = 1,
    };

    private static object Body(string? updatedAt, Guid[] entry, object[]? steps = null) => new
    {
        workflow = new { name = $"validate-live-{Guid.NewGuid():N}"[..27], version = "1.0.0", description = (string?)null,
            cronExpression = (string?)null, updatedAt, entryStepIds = entry, cacheIds = Array.Empty<Guid>() },
        steps, assignments = (object[]?)null, schemaEdits = (object[]?)null, layout = (object?)null,
    };

    private async Task<(HttpStatusCode Status, JsonElement Body)> SendAsync(HttpMethod method, string path, object? body)
    {
        using var request = new HttpRequestMessage(method, path) { Content = body is null ? null : JsonContent.Create(body) };
        using var response = await _http.SendAsync(request, Ct);
        var text = await response.Content.ReadAsStringAsync(Ct);
        return (response.StatusCode, text.Length == 0 ? default : JsonDocument.Parse(text).RootElement.Clone());
    }

    [Fact]
    public async Task ADraftIsValidatedAndNothingOfItIsPersisted()
    {
        // Review focus 5: the draft creates the workflow and a self-looping step inside the transaction.
        RealStack.SkipUnlessEnabled();
        var (wf, a) = (Guid.NewGuid(), Guid.NewGuid());
        _cleanup.AddRange([$"workflows/{wf}", $"steps/{a}"]);

        var (status, result) = await SendAsync(HttpMethod.Post, $"/api/v1/workflows/{wf}/validate",
            Body(null, [a], [Step(a, _processor, null, a)]));

        Assert.Equal(HttpStatusCode.OK, status);
        Assert.False(result.GetProperty("valid").GetBoolean());
        var gates = result.GetProperty("problems").EnumerateArray().Select(p => p.GetProperty("gate").GetString()).ToList();
        Assert.Contains("cycle", gates);
        Assert.Contains("processorLiveness", gates);   // the throwaway processor has no replica
        Assert.Equal(HttpStatusCode.NotFound, (await _http.GetAsync($"/api/v1/steps/{a}", Ct)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await _http.GetAsync($"/api/v1/workflows/{wf}", Ct)).StatusCode);
    }

    [Fact]
    public async Task ADraftEditOfAStoredWorkflowLeavesTheStoredGraphUnchanged()
    {
        RealStack.SkipUnlessEnabled();
        var (wf, a, b) = (Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid());
        _cleanup.AddRange([$"workflows/{wf}", $"steps/{a}", $"steps/{b}"]);
        var (saved, graph) = await SendAsync(HttpMethod.Put, $"/api/v1/workflows/{wf}/graph",
            Body(null, [a], [Step(a, _processor, null, b), Step(b, _processor)]));
        Assert.Equal(HttpStatusCode.OK, saved);
        var stamp = graph.GetProperty("workflow").GetProperty("updatedAt").GetString();
        var bStamp = graph.GetProperty("steps").EnumerateArray().Single(s => s.GetProperty("id").GetGuid() == b).GetProperty("updatedAt").GetString();

        // The draft wires b back to a: a cycle.
        var (status, result) = await SendAsync(HttpMethod.Post, $"/api/v1/workflows/{wf}/validate",
            Body(stamp, [a], [Step(b, _processor, bStamp, a)]));

        Assert.Equal(HttpStatusCode.OK, status);
        Assert.Contains(result.GetProperty("problems").EnumerateArray(), p => p.GetProperty("gate").GetString() == "cycle");
        var (_, after) = await SendAsync(HttpMethod.Get, $"/api/v1/workflows/{wf}/graph", null);
        var bAfter = after.GetProperty("steps").EnumerateArray().Single(s => s.GetProperty("id").GetGuid() == b);
        Assert.Equal(0, bAfter.GetProperty("nextStepIds").GetArrayLength());
        Assert.Equal(stamp, after.GetProperty("workflow").GetProperty("updatedAt").GetString());
    }

    [Fact]
    public async Task ADraftWithAnFkViolationIsA422AndLeavesNothing()
    {
        // Review focus 1: the second new step points at a processor that does not exist.
        RealStack.SkipUnlessEnabled();
        var (wf, a, b) = (Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid());
        _cleanup.AddRange([$"workflows/{wf}", $"steps/{a}", $"steps/{b}"]);

        var (status, _) = await SendAsync(HttpMethod.Post, $"/api/v1/workflows/{wf}/validate",
            Body(null, [a], [Step(a, _processor, null, b), Step(b, Guid.NewGuid())]));

        Assert.Equal(HttpStatusCode.UnprocessableEntity, status);
        Assert.Equal(HttpStatusCode.NotFound, (await _http.GetAsync($"/api/v1/steps/{a}", Ct)).StatusCode);
    }

    [Fact]
    public async Task TheStoredWorkflowIsValidatedWhenThereIsNoBody()
    {
        RealStack.SkipUnlessEnabled();
        var (wf, a) = (Guid.NewGuid(), Guid.NewGuid());
        _cleanup.AddRange([$"workflows/{wf}", $"steps/{a}"]);
        await SendAsync(HttpMethod.Put, $"/api/v1/workflows/{wf}/graph", Body(null, [a], [Step(a, _processor)]));

        var (status, result) = await SendAsync(HttpMethod.Post, $"/api/v1/workflows/{wf}/validate", null);

        Assert.Equal(HttpStatusCode.OK, status);
        Assert.Equal("processorLiveness", Assert.Single(result.GetProperty("problems").EnumerateArray()).GetProperty("gate").GetString());
    }

    [Fact]
    public async Task TheLiveListAndTheLivenessReadAnswer()
    {
        RealStack.SkipUnlessEnabled();

        var (liveStatus, live) = await SendAsync(HttpMethod.Get, "/api/v1/orchestration/live", null);
        var (livenessStatus, liveness) = await SendAsync(HttpMethod.Get, "/api/v1/processors/liveness", null);

        Assert.Equal(HttpStatusCode.OK, liveStatus);
        Assert.Equal(JsonValueKind.Array, live.ValueKind);
        Assert.Equal(HttpStatusCode.OK, livenessStatus);
        var mine = liveness.EnumerateArray().Single(p => p.GetProperty("processorId").GetGuid() == _processor);
        Assert.False(mine.GetProperty("live").GetBoolean());
        Assert.Equal(0, mine.GetProperty("replicas").GetInt32());
    }
}
```

- [ ] **Step 2: Build, deploy and run (ask the user first: this restarts the shared dev BaseApi)**

```bash
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo
docker build -f src/BaseApi.Service/Dockerfile -t baseapi-service:local .
kind load docker-image baseapi-service:local --name desktop
kubectl -n skp rollout restart deploy/baseapi-service
kubectl -n skp rollout status deploy/baseapi-service
```

`k8s/port-forward-realstack.ps1` supervises its forwards and reconnects after the restart; check `./k8s/port-forward-realstack.ps1 -Status` and that `curl http://localhost:18080/api/v1/workflows` answers 200. Then:

```bash
SKP_REALSTACK=1 src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.Live.WorkflowValidationLiveTests"
SKP_REALSTACK=1 src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.Live.WorkflowGraphLiveTests"
```

Expected: 5 passed, then plan 1's 6 still pass.

- [ ] **Step 3: Run the full hermetic suite once more**

```bash
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-not-trait "Category=RealStack" --filter-not-namespace "BaseApi.Tests.Live*"
```

Expected: 0 failed.

- [ ] **Step 4: Commit**

```bash
git add src/tests/BaseApi.Tests/Live/WorkflowValidationLiveTests.cs
git commit -m "test(studio): dry-run validate against Postgres -- rollback, FK 422, stored-graph unchanged; live and liveness reads"
```

---

## Self-review notes

- **Spec coverage:** §4.4 validate (all gates, no save, no start, 200 with problems, save statuses kept) — Tasks 1, 2, 5, 6; §6.1 status from the live list — Task 3; §7 Problems including liveness — Tasks 2, 4, 5; §11 liveness no longer deferred — Tasks 2, 4. The studio side (plan 2 onwards) consumes these through the generated client.
- **Unchanged on purpose:** `StartAsync`, `StopAsync`, the 422 handler, the DTO validators, `BaseApi.Core`.
- **Type consistency:** `Collect`, `CollectAsync`, `ProcessorLiveness`, `ProcessorLivenessProbe`, `ILiveWorkflowReader`, `ProcessorLivenessDto`, `IProcessorLivenessReader`, `WorkflowProblemDto`, `WorkflowValidationDto`, `IWorkflowValidator`, `IGraphDryRun`, `RelationalGraphDryRun`, `WorkflowValidator` are each defined once and used with the same members.
