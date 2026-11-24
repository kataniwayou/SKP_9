using BaseApi.Service.Features.Cache;
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
    public async Task ACachesItemsAreReplacedRowByRow()
    {
        await using var h = new GraphHarness();
        var cache = await h.CacheAsync("root-a", ("acme", "Acme"), ("beta", "Beta"));
        var wf = await h.WorkflowAsync("wf", [await h.StepAsync(await h.ProcessorAsync())]);

        var outcome = await h.Syncer().SaveAsync(wf, Of(caches: [new DesignCacheDto(cache,
            F("""{"items":[{"key":"acme","value":"Acme (Approved)"},{"key":"gamma","value":"G"}]}"""))]), h.Ct);

        Assert.True(outcome.Applied, Describe(outcome));
        h.Forget();
        var rows = await h.Db.Set<CacheItem>().Where(i => i.CacheId == cache).ToListAsync(h.Ct);
        Assert.Equal([("acme", "Acme (Approved)"), ("gamma", "G")],
            rows.OrderBy(i => i.Key, StringComparer.Ordinal).Select(i => (i.Key, i.Value)));
        Assert.Contains(outcome.Log!, l => l.Id == cache && l.Message.Contains("items changed"));
    }

    [Fact]
    public async Task AnItemsOnlyDesignChangeStampsTheCache()
    {
        await using var h = new GraphHarness();
        var cache = await h.CacheAsync("root-a", ("acme", "Acme"));
        var wf = await h.WorkflowAsync("wf", [await h.StepAsync(await h.ProcessorAsync())]);
        h.Forget();
        var before = (await h.Db.Caches.SingleAsync(c => c.Id == cache, h.Ct)).UpdatedAt;
        h.Forget();
        h.Tick();

        var outcome = await h.Syncer().SaveAsync(wf, Of(caches: [new DesignCacheDto(cache,
            F("""{"items":[{"key":"acme","value":"Changed"}]}"""))]), h.Ct);

        Assert.True(outcome.Applied, Describe(outcome));
        h.Forget();
        Assert.True((await h.Db.Caches.SingleAsync(c => c.Id == cache, h.Ct)).UpdatedAt > before);
    }

    [Fact]
    public async Task TheSameItemsInAnotherOrderAreNoChange()
    {
        await using var h = new GraphHarness();
        var cache = await h.CacheAsync("root-a", ("acme", "Acme"), ("beta", "Beta"));
        var wf = await h.WorkflowAsync("wf", [await h.StepAsync(await h.ProcessorAsync())]);

        var outcome = await h.Syncer().SaveAsync(wf, Of(caches: [new DesignCacheDto(cache,
            F("""{"items":[{"key":"beta","value":"Beta"},{"key":"acme","value":"Acme"}]}"""))]), h.Ct);

        Assert.True(outcome.Applied, Describe(outcome));
        Assert.DoesNotContain(outcome.Log!, l => l.Id == cache && l.Message.Contains("items changed"));
    }

    [Fact]
    public async Task ADesignedCacheIsCreatedWithItsItemRows()
    {
        await using var h = new GraphHarness();
        var wf = await h.WorkflowAsync("wf", [await h.StepAsync(await h.ProcessorAsync())]);
        var cache = Guid.NewGuid();

        var outcome = await h.Syncer().SaveAsync(wf, Of(newCaches: [new DesignNewCacheDto(cache, null,
            F("""{"name":"c","version":"1.0.0","root":"root-new","items":[{"key":"acme","value":"Acme"}]}"""))]), h.Ct);

        Assert.True(outcome.Applied, Describe(outcome));
        h.Forget();
        var row = Assert.Single(await h.Db.Set<CacheItem>().Where(i => i.CacheId == cache).ToListAsync(h.Ct));
        Assert.Equal(("acme", "Acme"), (row.Key, row.Value));
    }

    [Fact]
    public async Task ADesignedItemTwiceIsAnErrorOnTheItemsField()
    {
        await using var h = new GraphHarness();
        var cache = await h.CacheAsync("root-a", ("acme", "Acme"));
        var wf = await h.WorkflowAsync("wf", [await h.StepAsync(await h.ProcessorAsync())]);

        var outcome = await h.Syncer().SaveAsync(wf, Of(caches: [new DesignCacheDto(cache,
            F("""{"items":[{"key":"beta","value":"1"},{"key":"beta","value":"2"}]}"""))]), h.Ct);

        var error = Assert.Single(outcome.Errors);
        Assert.Equal(("cache", cache, "caches", "items"), (error.Kind, error.Id, error.Stage, error.Field));
        h.Forget();
        Assert.Equal(["acme"], await h.Db.Set<CacheItem>().Where(i => i.CacheId == cache).Select(i => i.Key).ToListAsync(h.Ct));
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
