using BaseApi.Core.Exceptions;
using Xunit;

namespace BaseApi.Tests.WorkflowGraph;

public sealed class WorkflowGraphReaderTests
{
    [Fact]
    public async Task ReadsTheReachableStepsTheirProcessorsSchemasAndTheLayout()
    {
        await using var h = new GraphHarness();
        var outSchema = await h.SchemaAsync("out");
        var proc = await h.ProcessorAsync("p", output: outSchema);
        var tail = await h.StepAsync(proc, "tail");
        var head = await h.StepAsync(proc, "head", tail);
        var parked = await h.StepAsync(proc, "parked");
        var asg = await h.AssignmentAsync(head);
        var wf = await h.WorkflowAsync("wf", [head], [asg], layout: """{"parked":["x"]}""");

        var graph = await h.Reader.ReadAsync(wf, h.Ct);

        Assert.Equal(wf, graph.Workflow.Id);
        Assert.Equal([head], graph.Workflow.EntryStepIds!);
        Assert.Equal(new[] { head, tail }.OrderBy(x => x), graph.Steps.Select(s => s.Id).OrderBy(x => x));
        Assert.DoesNotContain(graph.Steps, s => s.Id == parked);
        Assert.Equal([tail], graph.Steps.Single(s => s.Id == head).NextStepIds!);
        Assert.Equal([proc], graph.Processors.Select(p => p.Id));
        Assert.Equal([outSchema], graph.Schemas.Select(s => s.Id));
        Assert.Equal([asg], graph.Assignments.Select(a => a.Id));
        Assert.Equal("x", graph.Layout!.Value.GetProperty("parked")[0].GetString());
    }

    [Fact]
    public async Task AWorkflowNeverLaidOutHasANullLayout()
    {
        await using var h = new GraphHarness();
        var step = await h.StepAsync(await h.ProcessorAsync());
        var wf = await h.WorkflowAsync("wf", [step]);

        Assert.Null((await h.Reader.ReadAsync(wf, h.Ct)).Layout);
    }

    [Fact]
    public async Task AMissingWorkflowIsNotFound()
    {
        await using var h = new GraphHarness();
        await Assert.ThrowsAsync<NotFoundException>(() => h.Reader.ReadAsync(Guid.NewGuid(), h.Ct));
    }
}
