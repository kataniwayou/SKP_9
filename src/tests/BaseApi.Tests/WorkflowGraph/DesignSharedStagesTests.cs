using BaseApi.Service.Features.Workflow.Design;
using Microsoft.EntityFrameworkCore;
using Xunit;
using static BaseApi.Tests.WorkflowGraph.DesignBody;

namespace BaseApi.Tests.WorkflowGraph;

/// <summary>Plan 8 §4.3 stages 1-3: shared entities, last write wins.</summary>
public sealed class DesignSharedStagesTests
{
    [Fact]
    public async Task ASchemaCopyKeepsTheOriginalsNameAndVersionAndTheSlotPointsAtIt()
    {
        await using var h = new GraphHarness();
        var original = await h.SchemaAsync("cfg", "1.2.3");
        var proc = await h.ProcessorAsync(config: original);
        var wf = await h.WorkflowAsync("wf", [await h.StepAsync(proc)]);
        var copy = Guid.NewGuid();

        var outcome = await h.Syncer().SaveAsync(wf, Of(
            processors: [new DesignProcessorDto(proc, null, new() { ["config"] = copy })],
            schemas: [new DesignSchemaDto(copy, "cfg", "1.2.3", null, """{"type":"string"}""")]), h.Ct);

        Assert.True(outcome.Applied, Describe(outcome));
        h.Forget();
        Assert.Equal(copy, (await h.Db.Processors.SingleAsync(p => p.Id == proc, h.Ct)).ConfigSchemaId);
        var row = await h.Db.Schemas.SingleAsync(s => s.Id == copy, h.Ct);
        Assert.Equal(("cfg", "1.2.3"), (row.Name, row.Version));
        Assert.True(await h.Db.Schemas.AnyAsync(s => s.Id == original, h.Ct), "other processors keep the original");
    }

    [Fact]
    public async Task AFailedCopyIsAnErrorAndItsRepointIsSkippedWithAnErrorOfItsOwn()
    {
        await using var h = new GraphHarness();
        var original = await h.SchemaAsync("cfg");
        var proc = await h.ProcessorAsync(config: original);
        var wf = await h.WorkflowAsync("wf", [await h.StepAsync(proc)]);
        var copy = Guid.NewGuid();

        var outcome = await h.Syncer().SaveAsync(wf, Of(
            processors: [new DesignProcessorDto(proc, null, new() { ["config"] = copy })],
            schemas: [new DesignSchemaDto(copy, "cfg", "1.0.0", null, "not json")]), h.Ct);

        Assert.False(outcome.Applied);
        Assert.Contains(outcome.Errors, e => (e.Kind, e.Id, e.Stage, e.Field) == ("schema", copy, "schemas", "definition"));
        Assert.Contains(outcome.Errors, e => (e.Kind, e.Id, e.Stage, e.Field) == ("processor", proc, "processors", "configSchemaId"));
        h.Forget();
        Assert.Equal(original, (await h.Db.Processors.SingleAsync(p => p.Id == proc, h.Ct)).ConfigSchemaId);
    }

    [Fact]
    public async Task AProcessorIsLastWriteWins()
    {
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var wf = await h.WorkflowAsync("wf", [await h.StepAsync(proc)]);
        // someone else changes the processor after the designer opened the workflow
        h.Tick();
        var row = await h.Db.Processors.SingleAsync(p => p.Id == proc, h.Ct);
        row.Description = "elsewhere";
        await h.Db.SaveChangesAsync(h.Ct);
        h.Forget();

        var outcome = await h.Syncer().SaveAsync(wf, Of(processors: [new DesignProcessorDto(proc, F("""{"name":"renamed"}"""), null)]), h.Ct);

        Assert.True(outcome.Applied, Describe(outcome));
        h.Forget();
        var after = await h.Db.Processors.SingleAsync(p => p.Id == proc, h.Ct);
        Assert.Equal(("renamed", "elsewhere"), (after.Name, after.Description));
    }

    [Fact]
    public async Task ACacheChangeBreakingACrudRuleIsAnErrorOnItsField()
    {
        await using var h = new GraphHarness();
        var cache = await h.CacheAsync("root-a");
        var wf = await h.WorkflowAsync("wf", [await h.StepAsync(await h.ProcessorAsync())]);

        var outcome = await h.Syncer().SaveAsync(wf, Of(caches: [new DesignCacheDto(cache, F("""{"root":"has:colon"}"""))]), h.Ct);

        var error = Assert.Single(outcome.Errors);
        Assert.Equal(("cache", cache, "caches", "root"), (error.Kind, error.Id, error.Stage, error.Field));
    }

    [Fact]
    public async Task AWrongTypedFieldIsOneErrorWithoutACrudVerdictOnTop()
    {
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var wf = await h.WorkflowAsync("wf", [await h.StepAsync(proc)]);

        var outcome = await h.Syncer().SaveAsync(wf, Of(processors: [new DesignProcessorDto(proc, F("""{"name":7}"""), null)]), h.Ct);

        var error = Assert.Single(outcome.Errors);
        Assert.Equal(("processor", proc, "processors", "name"), (error.Kind, error.Id, error.Stage, error.Field));
    }
}
