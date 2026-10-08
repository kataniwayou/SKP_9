using BaseApi.Service.Features.Step;
using BaseApi.Service.Features.Workflow.Design;
using Microsoft.EntityFrameworkCore;
using Xunit;
using static BaseApi.Tests.WorkflowGraph.DesignBody;

namespace BaseApi.Tests.WorkflowGraph;

/// <summary>Plan 8 §4.3 stages 4-5: steps are owned, so they keep the conflict check; any wiring is allowed.</summary>
public sealed class DesignStepStagesTests
{
    private static async Task<(Guid Wf, Guid A, Guid B, DateTime StampA, DateTime StampB)> TwoSteps(GraphHarness h)
    {
        var proc = await h.ProcessorAsync();
        var b = await h.StepAsync(proc, "b");
        var a = await h.StepAsync(proc, "a", b);
        var wf = await h.WorkflowAsync("wf", [a]);
        var graph = await h.Reader.ReadAsync(wf, h.Ct);
        h.Forget();
        return (wf, a, b, graph.Steps.Single(s => s.Id == a).UpdatedAt, graph.Steps.Single(s => s.Id == b).UpdatedAt);
    }

    private static async Task<List<Guid>> NextOf(GraphHarness h, Guid step)
    {
        h.Forget();
        return await h.Db.StepNextSteps.Where(j => j.StepId == step).Select(j => j.NextStepId).ToListAsync(h.Ct);
    }

    [Fact]
    public async Task AStepChangeBreakingACrudRuleIsAnErrorNamingItsField()
    {
        await using var h = new GraphHarness();
        var (wf, a, _, stampA, _) = await TwoSteps(h);

        var outcome = await h.Syncer().SaveAsync(wf, Of(steps: [new DesignStepDto(a, stampA, F("""{"version":"abc"}"""), null)]), h.Ct);

        Assert.False(outcome.Applied);
        Assert.Contains(outcome.Errors, e => (e.Kind, e.Id, e.Stage, e.Field) == ("step", a, "steps", "version"));
    }

    [Fact]
    public async Task AStepChangedSinceItWasOpenedFailsWithTheConflict()
    {
        await using var h = new GraphHarness();
        var (wf, a, _, stampA, _) = await TwoSteps(h);
        h.Tick();
        var row = await h.Db.Steps.SingleAsync(s => s.Id == a, h.Ct);
        row.Description = "someone else";
        await h.Db.SaveChangesAsync(h.Ct);
        h.Forget();

        var outcome = await h.Syncer().SaveAsync(wf, Of(steps: [new DesignStepDto(a, stampA, F("""{"name":"mine"}"""), null)]), h.Ct);

        var error = Assert.Single(outcome.Errors);
        Assert.Equal(("step", a, "steps", DesignRun.Conflict), (error.Kind, error.Id, error.Stage, error.Message));
    }

    [Fact]
    public async Task FieldsAndWiringOnTheSameStepApplyWithoutConflictingWithThemselves()
    {
        // Review Focus 2: stage 4 moves the step's stamp; stage 5 must not check it again.
        await using var h = new GraphHarness();
        var (wf, a, b, stampA, _) = await TwoSteps(h);
        h.Tick();

        var outcome = await h.Syncer().SaveAsync(wf, Of(steps: [new DesignStepDto(a, stampA, F("""{"description":"rewired"}"""), [])]), h.Ct);

        Assert.True(outcome.Applied, Describe(outcome));
        Assert.Empty(await NextOf(h, a));
        Assert.Equal("rewired", (await h.Db.Steps.SingleAsync(s => s.Id == a, h.Ct)).Description);
        Assert.True(await h.Db.Steps.AnyAsync(s => s.Id == b, h.Ct), "unwiring never deletes a step");
    }

    [Fact]
    public async Task ALoopIsWritten()
    {
        await using var h = new GraphHarness();
        var (wf, a, b, _, stampB) = await TwoSteps(h);

        var outcome = await h.Syncer().SaveAsync(wf, Of(steps: [new DesignStepDto(b, stampB, null, [a])]), h.Ct);

        Assert.True(outcome.Applied, Describe(outcome));
        Assert.Equal([a], await NextOf(h, b));
    }

    [Fact]
    public async Task AFailedStepsWiresAreSkippedWithAnErrorOfTheirOwn()
    {
        await using var h = new GraphHarness();
        var (wf, a, _, stampA, _) = await TwoSteps(h);

        var outcome = await h.Syncer().SaveAsync(wf, Of(steps: [new DesignStepDto(a, stampA, F("""{"version":"abc"}"""), [])]), h.Ct);

        Assert.Contains(outcome.Errors, e => (e.Kind, e.Id, e.Stage) == ("step", a, "steps"));
        Assert.Contains(outcome.Errors, e => (e.Kind, e.Id, e.Stage, e.Field) == ("step", a, "wires", "nextStepIds"));
    }
}
