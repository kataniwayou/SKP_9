using BaseApi.Service.Features.Workflow;
using Xunit;

namespace BaseApi.Tests.WorkflowGraph;

/// <summary>The loader's snapshot carries each entry step's own cron, and null when no step has one.</summary>
public sealed class LoaderEntryCronsTests
{
    [Fact]
    public async Task TheSnapshotCarriesTheEntryCronsOfTheRowsThatHaveOne()
    {
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var a = await h.StepAsync(proc, "a");
        var b = await h.StepAsync(proc, "b");
        var w = await h.WorkflowAsync("wf", [a, b]);
        var row = h.Db.Set<WorkflowEntrySteps>().Single(j => j.WorkflowId == w && j.StepId == b);
        row.CronExpression = "*/10 * * * * *";
        await h.Db.SaveChangesAsync(h.Ct);
        h.Forget();

        var snap = await h.Loader.LoadL1Async([w], h.Ct);

        var crons = snap.Workflows[w].EntryCrons!;
        Assert.Single(crons);
        Assert.Equal("*/10 * * * * *", crons[b]);
    }

    [Fact]
    public async Task ASnapshotWithNoEntryCronsHasNullNotAnEmptyMap()
    {
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var a = await h.StepAsync(proc, "a");
        var w = await h.WorkflowAsync("wf", [a]);

        var snap = await h.Loader.LoadL1Async([w], h.Ct);

        Assert.Null(snap.Workflows[w].EntryCrons);
    }
}
