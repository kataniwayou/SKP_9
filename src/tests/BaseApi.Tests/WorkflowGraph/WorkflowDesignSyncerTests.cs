using BaseApi.Core.Exceptions;
using BaseApi.Service.Features.Workflow.Design;
using FluentValidation;
using Xunit;

namespace BaseApi.Tests.WorkflowGraph;

/// <summary>Plan 8 §4.3, first part: the design is stored whatever the stages find; no error empties it.</summary>
public sealed class WorkflowDesignSyncerTests
{
    /// <summary>Refuses everything, so a test can see the store without any stage applying a change.</summary>
    private sealed class RefusingStage : IDesignStage
    {
        public Task RunAsync(DesignRun run, CancellationToken ct)
        {
            run.Fail("step", Guid.Empty, "steps", "name", "refused by the test");
            return Task.CompletedTask;
        }
    }

    [Fact]
    public async Task ADesignWithErrorsIsStoredWithItsLayoutAndAnsweredNotApplied()
    {
        await using var h = new GraphHarness();
        var step = await h.StepAsync(await h.ProcessorAsync());
        var wf = await h.WorkflowAsync("wf", [step]);

        var outcome = await h.Syncer([new RefusingStage()]).SaveAsync(wf,
            DesignBody.Of(steps: [new DesignStepDto(step, null, null, [])], layout: """{"v":1,"parked":["x"]}"""), h.Ct);

        Assert.False(outcome.Applied);
        Assert.Equal("refused by the test", Assert.Single(outcome.Errors).Message);
        var graph = await h.Reader.ReadAsync(wf, h.Ct);
        Assert.Equal(step, graph.Design!.Value.GetProperty("steps")[0].GetProperty("id").GetGuid());
        Assert.False(graph.Design.Value.TryGetProperty("layout", out _));
        Assert.Equal("x", graph.Layout!.Value.GetProperty("parked")[0].GetString());
    }

    [Fact]
    public async Task StoringDoesNotMoveTheWorkflowsUpdatedAt()
    {
        // Review Focus 1: a stamped store would make every later workflow stage conflict with itself.
        await using var h = new GraphHarness();
        var step = await h.StepAsync(await h.ProcessorAsync());
        var wf = await h.WorkflowAsync("wf", [step]);
        var before = (await h.Reader.ReadAsync(wf, h.Ct)).Workflow.UpdatedAt;

        h.Tick();
        await h.Syncer([new RefusingStage()]).SaveAsync(wf, DesignBody.Of(), h.Ct);

        Assert.Equal(before, (await h.Reader.ReadAsync(wf, h.Ct)).Workflow.UpdatedAt);
    }

    [Fact]
    public async Task TheStoredDesignIsLastWriteWins()
    {
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var a = await h.StepAsync(proc, "a");
        var b = await h.StepAsync(proc, "b");
        var wf = await h.WorkflowAsync("wf", [a]);
        var syncer = h.Syncer([new RefusingStage()]);

        await syncer.SaveAsync(wf, DesignBody.Of(steps: [new DesignStepDto(a, null, null, [a])]), h.Ct);
        await syncer.SaveAsync(wf, DesignBody.Of(steps: [new DesignStepDto(b, null, null, [])]), h.Ct);

        var design = (await h.Reader.ReadAsync(wf, h.Ct)).Design!.Value;
        Assert.Equal(b, design.GetProperty("steps")[0].GetProperty("id").GetGuid());
        Assert.Equal(1, design.GetProperty("steps").GetArrayLength());
    }

    [Fact]
    public async Task ADesignWithNoErrorsEmptiesTheStoredDesignAndKeepsTheLayout()
    {
        await using var h = new GraphHarness();
        var step = await h.StepAsync(await h.ProcessorAsync());
        var wf = await h.WorkflowAsync("wf", [step]);
        await h.Syncer([new RefusingStage()]).SaveAsync(wf, DesignBody.Of(layout: """{"v":1,"parked":["a"]}"""), h.Ct);
        Assert.NotNull((await h.Reader.ReadAsync(wf, h.Ct)).Design);

        var outcome = await h.Syncer([]).SaveAsync(wf, DesignBody.Of(layout: """{"v":1,"parked":["b"]}"""), h.Ct);

        Assert.True(outcome.Applied, DesignBody.Describe(outcome));
        Assert.Empty(outcome.Errors);
        var graph = await h.Reader.ReadAsync(wf, h.Ct);
        Assert.Null(graph.Design);
        Assert.Equal("b", graph.Layout!.Value.GetProperty("parked")[0].GetString());
    }

    [Fact]
    public async Task AMalformedDesignIsAValidationFailureAndStoresNothing()
    {
        await using var h = new GraphHarness();
        var step = await h.StepAsync(await h.ProcessorAsync());
        var wf = await h.WorkflowAsync("wf", [step]);

        await Assert.ThrowsAsync<ValidationException>(() => h.Syncer().SaveAsync(wf, DesignBody.Of(layout: "[]"), h.Ct));

        Assert.Null((await h.Reader.ReadAsync(wf, h.Ct)).Design);
    }

    [Fact]
    public async Task AnUnknownWorkflowIsNotFound()
    {
        await using var h = new GraphHarness();
        await Assert.ThrowsAsync<NotFoundException>(() => h.Syncer().SaveAsync(Guid.NewGuid(), DesignBody.Of(), h.Ct));
    }
}
