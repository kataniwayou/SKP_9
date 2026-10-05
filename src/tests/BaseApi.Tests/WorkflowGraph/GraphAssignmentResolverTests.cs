using BaseApi.Service.Features.Assignment;
using BaseApi.Service.Features.Workflow;
using BaseApi.Service.Features.Workflow.Graph;
using FluentValidation;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace BaseApi.Tests.WorkflowGraph;

public sealed class GraphAssignmentResolverTests
{
    private static async Task<(GraphHarness H, Guid Proc, Guid Step)> SetupAsync()
    {
        var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var step = await h.StepAsync(proc, "fetch");
        return (h, proc, step);
    }

    private static async Task<WorkflowGraphDto> SaveAsync(GraphHarness h, Guid wf, Guid entry, params GraphAssignmentIntent[] intents)
    {
        var loaded = await h.Reader.ReadAsync(wf, h.Ct);
        h.Forget();
        return await h.Saver.SaveAsync(wf, GraphHarness.Request([entry], loaded.Workflow.UpdatedAt, assignments: intents, name: loaded.Workflow.Name), h.Ct);
    }

    [Fact]
    public async Task APayloadForAnUnassignedStepCreatesAndLinksARow()
    {
        var (h, _, step) = await SetupAsync();
        await using var _h = h;
        var wf = await h.WorkflowAsync("orders", [step]);

        var graph = await SaveAsync(h, wf, step, new GraphAssignmentIntent(step, """{"url":"x"}"""));

        var asg = Assert.Single(graph.Assignments);
        Assert.Equal(step, asg.StepId);
        Assert.Equal("orders / fetch", asg.Name);
        Assert.Equal("1.0.0", asg.Version);
        Assert.Contains("\"url\"", asg.Payload);
    }

    [Fact]
    public async Task APayloadForARowOnlyThisWorkflowUsesUpdatesItInPlace()
    {
        var (h, _, step) = await SetupAsync();
        await using var _h = h;
        var asg = await h.AssignmentAsync(step, """{"v":1}""");
        var wf = await h.WorkflowAsync("orders", [step], [asg]);

        var graph = await SaveAsync(h, wf, step, new GraphAssignmentIntent(step, """{"v":2}"""));

        var only = Assert.Single(graph.Assignments);
        Assert.Equal(asg, only.Id);
        Assert.Contains("2", only.Payload);
    }

    [Fact]
    public async Task APayloadForASharedRowCopiesItAndLeavesTheOtherWorkflowAlone()
    {
        var (h, _, step) = await SetupAsync();
        await using var _h = h;
        var shared = await h.AssignmentAsync(step, """{"v":1}""");
        var mine = await h.WorkflowAsync("mine", [step], [shared]);
        var theirs = await h.WorkflowAsync("theirs", [step], [shared]);

        var graph = await SaveAsync(h, mine, step, new GraphAssignmentIntent(step, """{"v":2}"""));

        var copy = Assert.Single(graph.Assignments);
        Assert.NotEqual(shared, copy.Id);
        Assert.Contains("2", copy.Payload);
        h.Forget();
        var theirGraph = await h.Reader.ReadAsync(theirs, h.Ct);
        Assert.Equal(shared, Assert.Single(theirGraph.Assignments).Id);
        Assert.Contains("1", theirGraph.Assignments[0].Payload);
    }

    [Fact]
    public async Task ANullIntentUnlinksAndDeletesAnOrphanedRow()
    {
        var (h, _, step) = await SetupAsync();
        await using var _h = h;
        var asg = await h.AssignmentAsync(step);
        var wf = await h.WorkflowAsync("orders", [step], [asg]);

        var graph = await SaveAsync(h, wf, step, new GraphAssignmentIntent(step, null));

        Assert.Empty(graph.Assignments);
        h.Forget();
        Assert.False(await h.Db.Assignments.AnyAsync(a => a.Id == asg, h.Ct));
    }

    [Fact]
    public async Task ANullIntentOnASharedRowUnlinksButKeepsTheRow()
    {
        // Review focus 3.
        var (h, _, step) = await SetupAsync();
        await using var _h = h;
        var shared = await h.AssignmentAsync(step);
        var mine = await h.WorkflowAsync("mine", [step], [shared]);
        await h.WorkflowAsync("theirs", [step], [shared]);

        var graph = await SaveAsync(h, mine, step, new GraphAssignmentIntent(step, null));

        Assert.Empty(graph.Assignments);
        h.Forget();
        Assert.True(await h.Db.Assignments.AnyAsync(a => a.Id == shared, h.Ct));
    }

    [Fact]
    public async Task LinksForStepsWithoutAnIntentAreKept()
    {
        var (h, proc, step) = await SetupAsync();
        await using var _h = h;
        var other = await h.StepAsync(proc, "other");
        var keep = await h.AssignmentAsync(other);
        var wf = await h.WorkflowAsync("orders", [step], [keep]);

        var graph = await SaveAsync(h, wf, step, new GraphAssignmentIntent(step, """{"v":1}"""));

        Assert.Contains(graph.Workflow.AssignmentIds!, id => id == keep);
        Assert.Equal(2, graph.Workflow.AssignmentIds!.Count);
    }

    [Fact]
    public async Task AnIntentForAStepCreatedInTheSameRequestLands()
    {
        // Review focus 2. InMemory proves the staging; WorkflowGraphLiveTests proves the FK order.
        var (h, proc, _) = await SetupAsync();
        await using var _h = h;
        var (wf, fresh) = (Guid.NewGuid(), Guid.NewGuid());

        var graph = await h.Saver.SaveAsync(wf, GraphHarness.Request([fresh],
            steps: [GraphHarness.NewStep(fresh, proc, "fresh")],
            assignments: [new GraphAssignmentIntent(fresh, """{"v":1}""")]), h.Ct);

        Assert.Equal(fresh, Assert.Single(graph.Assignments).StepId);
    }

    [Fact]
    public async Task AnInvalidJsonPayloadIsAValidationFailure()
    {
        var (h, _, step) = await SetupAsync();
        await using var _h = h;
        var wf = await h.WorkflowAsync("orders", [step]);

        await Assert.ThrowsAsync<ValidationException>(() =>
            SaveAsync(h, wf, step, new GraphAssignmentIntent(step, "{not json")));
    }

    [Fact]
    public async Task DuplicateLegacyRowsCollapseToOne()
    {
        var (h, _, step) = await SetupAsync();
        await using var _h = h;
        var first = await h.AssignmentAsync(step, """{"v":1}""");
        var second = await h.AssignmentAsync(step, """{"v":1}""");
        var wf = await h.WorkflowAsync("orders", [step], [first, second]);

        var graph = await SaveAsync(h, wf, step, new GraphAssignmentIntent(step, """{"v":2}"""));

        Assert.Single(graph.Assignments);
    }
}
