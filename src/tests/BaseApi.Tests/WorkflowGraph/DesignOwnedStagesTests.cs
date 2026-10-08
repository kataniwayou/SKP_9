using BaseApi.Service.Features.Workflow.Design;
using Microsoft.EntityFrameworkCore;
using Xunit;
using static BaseApi.Tests.WorkflowGraph.DesignBody;

namespace BaseApi.Tests.WorkflowGraph;

/// <summary>Plan 8 §4.3 stages 6-7, and the whole run: every error at once, or everything applied.</summary>
public sealed class DesignOwnedStagesTests
{
    [Fact]
    public async Task AssignmentsAreCreatedUpdatedAndDeletedAndTheWorkflowLinksFollow()
    {
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var (s1, s2, s3) = (await h.StepAsync(proc, "s1"), await h.StepAsync(proc, "s2"), await h.StepAsync(proc, "s3"));
        var x = await h.AssignmentAsync(s2);
        var y = await h.AssignmentAsync(s3);
        var wf = await h.WorkflowAsync("wf", [s1, s2, s3], [x, y]);
        var loaded = await h.Reader.ReadAsync(wf, h.Ct);
        var stamp = (Guid id) => loaded.Assignments.Single(a => a.Id == id).UpdatedAt;
        var made = Guid.NewGuid();
        h.Forget();

        var outcome = await h.Syncer().SaveAsync(wf, Of(
            workflow: new DesignWorkflowDto(loaded.Workflow.UpdatedAt, null, null, null),
            assignments:
            [
                new DesignAssignmentDto("create", made, s1, null, F("""{"name":"s1-assignment","version":"1.0.0","payload":"{\"a\":1}"}""")),
                new DesignAssignmentDto("update", x, s2, stamp(x), F("""{"payload":"{\"b\":2}"}""")),
                new DesignAssignmentDto("delete", y, s3, stamp(y), null),
            ]), h.Ct);

        Assert.True(outcome.Applied, Describe(outcome));
        h.Forget();
        var links = await h.Db.WorkflowAssignments.Where(j => j.WorkflowId == wf).Select(j => j.AssignmentId).ToListAsync(h.Ct);
        Assert.Equal(new[] { made, x }.OrderBy(g => g), links.OrderBy(g => g));
        Assert.Equal("""{"b":2}""", (await h.Db.Assignments.SingleAsync(a => a.Id == x, h.Ct)).Payload);
        Assert.False(await h.Db.Assignments.AnyAsync(a => a.Id == y, h.Ct));
        Assert.Equal(s1, (await h.Db.Assignments.SingleAsync(a => a.Id == made, h.Ct)).StepId);
    }

    [Fact]
    public async Task ACreatedAssignmentBreakingACrudRuleIsAnErrorOnItsField()
    {
        await using var h = new GraphHarness();
        var s1 = await h.StepAsync(await h.ProcessorAsync());
        var wf = await h.WorkflowAsync("wf", [s1]);
        var made = Guid.NewGuid();

        var outcome = await h.Syncer().SaveAsync(wf, Of(assignments:
            [new DesignAssignmentDto("create", made, s1, null, F("""{"name":"n","version":"1.0.0","payload":"not json"}"""))]), h.Ct);

        Assert.Contains(outcome.Errors, e => (e.Kind, e.Id, e.Stage, e.Field) == ("assignment", made, "assignments", "payload"));
    }

    [Fact]
    public async Task NoEntryStepIsAWorkflowError()
    {
        await using var h = new GraphHarness();
        var s1 = await h.StepAsync(await h.ProcessorAsync());
        var wf = await h.WorkflowAsync("wf", [s1]);
        var loaded = await h.Reader.ReadAsync(wf, h.Ct);

        var outcome = await h.Syncer().SaveAsync(wf, Of(workflow: new DesignWorkflowDto(loaded.Workflow.UpdatedAt, null, [], null)), h.Ct);

        var error = Assert.Single(outcome.Errors);
        Assert.Equal(("workflow", wf, "workflow", "entryStepIds"), (error.Kind, error.Id, error.Stage, error.Field));
        Assert.Contains("at least one", error.Message);
    }

    [Fact]
    public async Task EveryErrorIsReportedNotOnlyTheFirst()
    {
        await using var h = new GraphHarness();
        var s1 = await h.StepAsync(await h.ProcessorAsync());
        var cache = await h.CacheAsync("root-a");
        var wf = await h.WorkflowAsync("wf", [s1]);
        var loaded = await h.Reader.ReadAsync(wf, h.Ct);

        var outcome = await h.Syncer().SaveAsync(wf, Of(
            workflow: new DesignWorkflowDto(loaded.Workflow.UpdatedAt, F("""{"cronExpression":"not a cron"}"""), null, null),
            steps: [new DesignStepDto(s1, loaded.Steps.Single().UpdatedAt, F("""{"version":"abc"}"""), null)],
            caches: [new DesignCacheDto(cache, F("""{"root":"a:b"}"""))]), h.Ct);

        Assert.False(outcome.Applied);
        Assert.Contains(outcome.Errors, e => (e.Kind, e.Stage, e.Field) == ("cache", "caches", "root"));
        Assert.Contains(outcome.Errors, e => (e.Kind, e.Stage, e.Field) == ("step", "steps", "version"));
        Assert.Contains(outcome.Errors, e => (e.Kind, e.Stage, e.Field) == ("workflow", "workflow", "cronExpression"));
        // in stage order
        Assert.Equal(["caches", "steps", "workflow"], outcome.Errors.Select(e => e.Stage).Distinct());
    }

    [Fact]
    public async Task AValidDesignAlignsTheRealEntitiesInFullAndEmptiesTheStoredDesign()
    {
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var b = await h.StepAsync(proc, "b");
        var a = await h.StepAsync(proc, "a", b);
        var wf = await h.WorkflowAsync("wf", [a]);
        var loaded = await h.Reader.ReadAsync(wf, h.Ct);
        h.Forget();

        var outcome = await h.Syncer().SaveAsync(wf, Of(
            workflow: new DesignWorkflowDto(loaded.Workflow.UpdatedAt, F("""{"description":"designed"}"""), [a, b], null),
            steps: [new DesignStepDto(a, loaded.Steps.Single(s => s.Id == a).UpdatedAt, F("""{"name":"renamed"}"""), [])],
            layout: """{"v":1,"parked":["a","b"]}"""), h.Ct);

        Assert.True(outcome.Applied, Describe(outcome));
        var graph = await h.Reader.ReadAsync(wf, h.Ct);
        Assert.Null(graph.Design);
        Assert.Equal("designed", graph.Workflow.Description);
        Assert.Equal(new[] { a, b }.OrderBy(g => g), graph.Workflow.EntryStepIds!.OrderBy(g => g));
        Assert.Equal("renamed", graph.Steps.Single(s => s.Id == a).Name);
        Assert.Empty(graph.Steps.Single(s => s.Id == a).NextStepIds!);
    }

    [Fact]
    public async Task ANotStartableDesignIsWritten()
    {
        // spec §6.7: a loop and an unwired step are start problems, not design errors
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var c = await h.StepAsync(proc, "c");
        var b = await h.StepAsync(proc, "b");
        var a = await h.StepAsync(proc, "a", b);
        var wf = await h.WorkflowAsync("wf", [a]);
        var loaded = await h.Reader.ReadAsync(wf, h.Ct);
        h.Forget();

        var outcome = await h.Syncer().SaveAsync(wf, Of(
            steps: [new DesignStepDto(b, loaded.Steps.Single(s => s.Id == b).UpdatedAt, null, [a])],
            layout: $$"""{"v":1,"parked":["{{c}}"]}"""), h.Ct);

        Assert.True(outcome.Applied, Describe(outcome));
        Assert.Equal([a], (await h.Reader.ReadAsync(wf, h.Ct)).Steps.Single(s => s.Id == b).NextStepIds!);
    }

    [Fact]
    public async Task AWorkflowChangeWithTheLoadedStampAppliesAfterTheStore()
    {
        // Review Focus 1: the store before the stages must not make the workflow stage conflict.
        await using var h = new GraphHarness();
        var s1 = await h.StepAsync(await h.ProcessorAsync());
        var wf = await h.WorkflowAsync("wf", [s1]);
        var loaded = await h.Reader.ReadAsync(wf, h.Ct);
        h.Tick();

        var outcome = await h.Syncer().SaveAsync(wf, Of(workflow: new DesignWorkflowDto(loaded.Workflow.UpdatedAt, F("""{"description":"d"}"""), null, null)), h.Ct);

        Assert.True(outcome.Applied, Describe(outcome));
    }
}
