using BaseApi.Service.Features.Workflow.Design;
using Xunit;
using static BaseApi.Tests.WorkflowGraph.DesignBody;

namespace BaseApi.Tests.WorkflowGraph;

/// <summary>
/// The design save's log (the studio's Output, 2026-10-09): the store, each stage's start and counts, one line per
/// entity changed or refused, then the dry run's verdict and the commit or rollback, in the order they happened.
/// </summary>
public sealed class DesignLogTests
{
    private static string[] Lines(DesignOutcomeDto o) => o.Log!.Select(l => $"{l.Level} {l.Stage}: {l.Message}").ToArray();

    [Fact]
    public async Task AnAppliedSaveLogsEveryStageEveryChangeAndTheCommitInOrder()
    {
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var c = await h.StepAsync(proc, "c");
        var e = await h.StepAsync(proc, "e");
        var a = await h.StepAsync(proc, "a", c);
        var wf = await h.WorkflowAsync("wf", [a]);
        var loaded = await h.Reader.ReadAsync(wf, h.Ct);
        var stampA = loaded.Steps.Single(s => s.Id == a).UpdatedAt;
        var stampC = loaded.Steps.Single(s => s.Id == c).UpdatedAt;
        h.Forget();

        var outcome = await h.Syncer().SaveAsync(wf, Of(
            workflow: new DesignWorkflowDto(loaded.Workflow.UpdatedAt, null, [a, e], null),
            steps:
            [
                new DesignStepDto(a, stampA, F("""{"name":"a2","entryCondition":2}"""), [e]),
                new DesignStepDto(c, stampC, null, null),
            ]), h.Ct);

        Assert.True(outcome.Applied, Describe(outcome));
        Assert.Equal(new[]
        {
            "info store: design stored on the workflow (the design and its layout), whatever the dry run finds",
            "info outcome: dry run started: every stage in one transaction, each entity in its own savepoint",
            "info schemas: schemas: nothing to do",
            "info processors: processors: nothing to do",
            "info caches: caches: nothing to do",
            "info steps: steps: 2 steps to check",
            "info steps: step 'a': name 'a' → 'a2'; entryCondition PreviousCompleted → PreviousFailed",
            "info steps: steps: 1 updated, 1 unchanged",
            "info wires: wires: 1 step with new next steps",
            "info wires: step 'a': next steps a2→e added, a2→c removed",
            "info wires: wires: 1 rewired",
            "info assignments: assignments: nothing to do",
            "info workflow: workflow: 1 workflow to update",
            "info workflow: workflow 'wf': entry steps e added",
            "info workflow: workflow: 1 updated",
            "info outcome: dry run passed: 3 changes, no errors",
            "info outcome: committed: the entities hold the design; the stored design is emptied",
        }, Lines(outcome));
        var change = outcome.Log!.Single(l => l.Message.StartsWith("step 'a': name"));
        Assert.Equal(("step", (Guid?)a), (change.Kind, change.Id));
        Assert.All(outcome.Log!.Where(l => l.Kind == "stage" || l.Kind == "outcome"), l => Assert.Null(l.Id));
    }

    [Fact]
    public async Task ARefusedEntityIsAnErrorLineCountedInItsStageAndTheSaveIsRolledBack()
    {
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var b = await h.StepAsync(proc, "b");
        var a = await h.StepAsync(proc, "a", b);
        var wf = await h.WorkflowAsync("wf", [a]);
        var loaded = await h.Reader.ReadAsync(wf, h.Ct);
        var stampA = loaded.Steps.Single(s => s.Id == a).UpdatedAt;
        var stampB = loaded.Steps.Single(s => s.Id == b).UpdatedAt;
        h.Forget();

        var outcome = await h.Syncer().SaveAsync(wf, Of(steps:
        [
            new DesignStepDto(a, stampA, F("""{"version":"abc"}"""), []),
            new DesignStepDto(b, stampB, F("""{"description":"fine"}"""), null),
        ]), h.Ct);

        Assert.False(outcome.Applied);
        var lines = Lines(outcome);
        var version = Assert.Single(outcome.Errors, x => x.Stage == "steps").Message;
        Assert.Equal(new[]
        {
            "info steps: steps: 2 steps to check",
            $"error steps: step 'a': version: {version}",
            "info steps: step 'b': description none → 'fine'",
            "error steps: steps: 1 updated, 1 refused",
            "info wires: wires: 1 step with new next steps",
            "error wires: step 'a': nextStepIds: Not rewired: the step itself failed.",
            "error wires: wires: 1 refused",
        }, lines[5..12]);
        Assert.Equal(new[]
        {
            "error outcome: dry run failed: 2 errors on 1 entity",
            "error outcome: rolled back: no entity was changed; the design stays stored on the workflow",
        }, lines[^2..]);
        // every error the answer lists has its line, in the same order
        Assert.Equal(outcome.Errors.Select(x => x.Id), outcome.Log!.Where(l => l.Level == "error" && l.Id is not null).Select(l => l.Id!.Value));
    }

    [Fact]
    public async Task SharedEntitiesAssignmentsAndWorkflowLinksAreLoggedByName()
    {
        await using var h = new GraphHarness();
        var original = await h.SchemaAsync("cfg", "1.2.3");
        var proc = await h.ProcessorAsync("p", config: original);
        var cache = await h.CacheAsync("root-a");
        var s1 = await h.StepAsync(proc, "s1");
        var s2 = await h.StepAsync(proc, "s2");
        var old = await h.AssignmentAsync(s2);
        var wf = await h.WorkflowAsync("wf", [s1, s2], [old]);
        var loaded = await h.Reader.ReadAsync(wf, h.Ct);
        var copy = Guid.NewGuid();
        var made = Guid.NewGuid();
        h.Forget();

        var outcome = await h.Syncer().SaveAsync(wf, Of(
            workflow: new DesignWorkflowDto(loaded.Workflow.UpdatedAt, null, null, null),
            processors: [new DesignProcessorDto(proc, F("""{"description":"new words"}"""), new() { ["config"] = copy })],
            caches: [new DesignCacheDto(cache, F("""{"root":"root-b"}"""))],
            schemas: [new DesignSchemaDto(copy, "cfg", "1.2.3", null, """{"type":"object"}""")],
            assignments:
            [
                new DesignAssignmentDto("create", made, s1, null, F("""{"name":"made","version":"1.0.0","payload":"{}"}""")),
                new DesignAssignmentDto("delete", old, s2, loaded.Assignments.Single().UpdatedAt, null),
            ]), h.Ct);

        Assert.True(outcome.Applied, Describe(outcome));
        var lines = Lines(outcome);
        Assert.Contains($"info schemas: schema copy 'cfg' 1.2.3: inserted as {copy.ToString()[..8]}", lines);
        Assert.Contains("info schemas: schemas: 1 inserted", lines);
        Assert.Contains($"info processors: processor 'p': description none → 'new words'; config schema {original.ToString()[..8]} → {copy.ToString()[..8]}", lines);
        Assert.Contains("info caches: cache 'cache': root 'root-a' → 'root-b'", lines);
        Assert.Contains("info assignments: assignment 'made' on step 's1': created (linked to the workflow in the workflow stage)", lines);
        Assert.Contains("info assignments: assignment 'asg' on step 's2': unlinked from this workflow and deleted", lines);
        Assert.Contains("info assignments: assignments: 1 created, 1 deleted", lines);
        Assert.Contains("info workflow: workflow 'wf': assignments made linked", lines);
        // stages log in the spec's order
        string[] order = ["schemas", "processors", "caches", "steps", "wires", "assignments", "workflow"];
        var starts = order.Select(st => Array.FindIndex(lines, l => l.StartsWith($"info {st}: {st}: "))).ToArray();
        Assert.Equal(starts.OrderBy(i => i), starts);
        Assert.DoesNotContain(-1, starts);
    }
}
