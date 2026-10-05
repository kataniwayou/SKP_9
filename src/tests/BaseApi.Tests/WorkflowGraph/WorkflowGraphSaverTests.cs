using BaseApi.Service.Features.Step;
using BaseApi.Service.Features.Workflow;
using BaseApi.Service.Features.Workflow.Graph;
using FluentValidation;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace BaseApi.Tests.WorkflowGraph;

public sealed class WorkflowGraphSaverTests
{
    [Fact]
    public async Task CreatesANewWorkflowWithClientIdsAndWiresBetweenNewSteps()
    {
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var (wf, a, b) = (Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid());

        var graph = await h.Saver.SaveAsync(wf, GraphHarness.Request(
            entry: [a],
            steps: [GraphHarness.NewStep(a, proc, "a", b), GraphHarness.NewStep(b, proc, "b")],
            layout: """{"nodes":{}}"""), h.Ct);

        Assert.Equal(wf, graph.Workflow.Id);
        Assert.Equal(new[] { a, b }.OrderBy(x => x), graph.Steps.Select(s => s.Id).OrderBy(x => x));
        Assert.Equal([b], graph.Steps.Single(s => s.Id == a).NextStepIds!);
        Assert.True(graph.Layout!.Value.TryGetProperty("nodes", out _));
    }

    [Fact]
    public async Task ReplacingRewiresAChangedStepAndKeepsUntouchedSteps()
    {
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var c = await h.StepAsync(proc, "c");
        var b = await h.StepAsync(proc, "b");
        var a = await h.StepAsync(proc, "a", b);
        var wf = await h.WorkflowAsync("wf", [a]);
        var loaded = await h.Reader.ReadAsync(wf, h.Ct);
        var aLoaded = loaded.Steps.Single(s => s.Id == a);
        h.Forget();

        // a -> b becomes a -> c. b is untouched, so it is not sent.
        var graph = await h.Saver.SaveAsync(wf, GraphHarness.Request(
            entry: [a],
            workflowUpdatedAt: loaded.Workflow.UpdatedAt,
            steps: [new GraphStepDto(a, aLoaded.UpdatedAt, "a", "1.0.0", null, proc, [c], StepEntryCondition.PreviousCompleted)]), h.Ct);

        Assert.Equal([c], graph.Steps.Single(s => s.Id == a).NextStepIds!);
        Assert.True(await h.Db.Steps.AnyAsync(s => s.Id == b, h.Ct), "unlinking never deletes the step row");
    }

    [Fact]
    public async Task ALayoutOfNullLeavesTheStoredLayoutAlone()
    {
        await using var h = new GraphHarness();
        var step = await h.StepAsync(await h.ProcessorAsync());
        var wf = await h.WorkflowAsync("wf", [step], layout: """{"keep":true}""");
        var loaded = await h.Reader.ReadAsync(wf, h.Ct);
        h.Forget();

        var graph = await h.Saver.SaveAsync(wf, GraphHarness.Request([step], loaded.Workflow.UpdatedAt), h.Ct);

        Assert.True(graph.Layout!.Value.GetProperty("keep").GetBoolean());
    }

    [Fact]
    public async Task NoEntryStepIsAValidationFailure()
    {
        await using var h = new GraphHarness();
        await Assert.ThrowsAsync<ValidationException>(() =>
            h.Saver.SaveAsync(Guid.NewGuid(), GraphHarness.Request(entry: []), h.Ct));
    }

    [Fact]
    public async Task AnEntryConditionOfZeroIsAValidationFailure()
    {
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var a = Guid.NewGuid();
        var bad = new GraphStepDto(a, null, "a", "1.0.0", null, proc, null, StepEntryCondition.PreviousProcessing);

        await Assert.ThrowsAsync<ValidationException>(() =>
            h.Saver.SaveAsync(Guid.NewGuid(), GraphHarness.Request([a], steps: [bad]), h.Ct));
    }

    [Fact]
    public async Task ANonObjectLayoutIsAValidationFailure()
    {
        await using var h = new GraphHarness();
        var step = await h.StepAsync(await h.ProcessorAsync());
        await Assert.ThrowsAsync<ValidationException>(() =>
            h.Saver.SaveAsync(Guid.NewGuid(), GraphHarness.Request([step], layout: "[]"), h.Ct));
    }

    [Fact]
    public async Task TheSameStepTwiceInOneRequestIsAValidationFailure()
    {
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var a = Guid.NewGuid();
        await Assert.ThrowsAsync<ValidationException>(() =>
            h.Saver.SaveAsync(Guid.NewGuid(), GraphHarness.Request([a],
                steps: [GraphHarness.NewStep(a, proc), GraphHarness.NewStep(a, proc)]), h.Ct));
    }

    [Fact]
    public async Task AStaleWorkflowIsAConflictNamingTheWorkflow()
    {
        await using var h = new GraphHarness();
        var step = await h.StepAsync(await h.ProcessorAsync());
        var wf = await h.WorkflowAsync("wf", [step]);
        var loaded = await h.Reader.ReadAsync(wf, h.Ct);

        // Someone else saves after we loaded.
        h.Tick();
        var row = await h.Db.Workflows.SingleAsync(w => w.Id == wf, h.Ct);
        row.Description = "changed elsewhere";
        await h.Db.SaveChangesAsync(h.Ct);
        h.Forget();

        var ex = await Assert.ThrowsAsync<GraphConflictException>(() =>
            h.Saver.SaveAsync(wf, GraphHarness.Request([step], loaded.Workflow.UpdatedAt), h.Ct));
        Assert.Equal(("workflow", wf), (ex.Kind, ex.Id));
    }

    [Fact]
    public async Task AStaleChangedStepIsAConflictNamingTheStep()
    {
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var step = await h.StepAsync(proc, "s");
        var wf = await h.WorkflowAsync("wf", [step]);
        var loaded = await h.Reader.ReadAsync(wf, h.Ct);
        var stepLoaded = loaded.Steps.Single();

        h.Tick();
        var row = await h.Db.Steps.SingleAsync(s => s.Id == step, h.Ct);
        row.Description = "changed elsewhere";
        await h.Db.SaveChangesAsync(h.Ct);
        h.Forget();

        var ex = await Assert.ThrowsAsync<GraphConflictException>(() =>
            h.Saver.SaveAsync(wf, GraphHarness.Request([step], loaded.Workflow.UpdatedAt,
                steps: [new GraphStepDto(step, stepLoaded.UpdatedAt, "s2", "1.0.0", null, proc, null, StepEntryCondition.PreviousCompleted)]), h.Ct));
        Assert.Equal(("step", step), (ex.Kind, ex.Id));
    }

    [Fact]
    public async Task ANewStepWhoseIdAlreadyExistsIsAConflict()
    {
        // Review focus 1: a retried save, or two tabs creating the same step.
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var existing = await h.StepAsync(proc);
        h.Forget();

        var ex = await Assert.ThrowsAsync<GraphConflictException>(() =>
            h.Saver.SaveAsync(Guid.NewGuid(), GraphHarness.Request([existing],
                steps: [GraphHarness.NewStep(existing, proc)]), h.Ct));
        Assert.Equal(("step", existing), (ex.Kind, ex.Id));
        Assert.Equal(0, await h.Db.Workflows.CountAsync(h.Ct));
    }

    [Fact]
    public async Task CreatingOverAnExistingWorkflowWithoutItsUpdatedAtIsAConflict()
    {
        await using var h = new GraphHarness();
        var step = await h.StepAsync(await h.ProcessorAsync());
        var wf = await h.WorkflowAsync("wf", [step]);
        h.Forget();

        var ex = await Assert.ThrowsAsync<GraphConflictException>(() =>
            h.Saver.SaveAsync(wf, GraphHarness.Request([step], workflowUpdatedAt: null), h.Ct));
        Assert.Equal(("workflow", wf), (ex.Kind, ex.Id));
    }

    [Fact]
    public async Task NothingIsWrittenWhenTheConflictIsFound()
    {
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var existing = await h.StepAsync(proc);
        h.Forget();
        var fresh = Guid.NewGuid();

        await Assert.ThrowsAsync<GraphConflictException>(() =>
            h.Saver.SaveAsync(Guid.NewGuid(), GraphHarness.Request([fresh],
                steps: [GraphHarness.NewStep(fresh, proc), GraphHarness.NewStep(existing, proc)]), h.Ct));
        h.Forget();

        Assert.False(await h.Db.Steps.AnyAsync(s => s.Id == fresh, h.Ct));
    }
}
