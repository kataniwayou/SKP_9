using BaseApi.Core.Exceptions;
using BaseApi.Service.Features.Workflow.Graph;
using FluentValidation;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace BaseApi.Tests.WorkflowGraph;

public sealed class GraphSchemaEditorTests
{
    private const string NewDefinition = """{"type":"object","required":["id"]}""";

    private static async Task<(GraphHarness H, Guid Wf, Guid Proc, Guid Step, Guid OldSchema)> SetupAsync()
    {
        var h = new GraphHarness();
        var old = await h.SchemaAsync("orders-out", "1.4.2");
        var proc = await h.ProcessorAsync("fetcher", output: old);
        var step = await h.StepAsync(proc);
        var wf = await h.WorkflowAsync("wf", [step]);
        return (h, wf, proc, step, old);
    }

    private static async Task<WorkflowGraphDto> SaveAsync(GraphHarness h, Guid wf, Guid entry, params GraphSchemaEdit[] edits)
    {
        var loaded = await h.Reader.ReadAsync(wf, h.Ct);
        h.Forget();
        return await h.Saver.SaveAsync(wf, GraphHarness.Request([entry], loaded.Workflow.UpdatedAt, schemaEdits: edits), h.Ct);
    }

    [Fact]
    public async Task AnEditCreatesANewVersionAndRepointsTheSlot()
    {
        var (h, wf, proc, step, old) = await SetupAsync();
        await using var _h = h;

        var graph = await SaveAsync(h, wf, step, new GraphSchemaEdit(proc, "output", NewDefinition));

        var p = Assert.Single(graph.Processors);
        Assert.NotEqual(old, p.OutputSchemaId);
        var fresh = graph.Schemas.Single(s => s.Id == p.OutputSchemaId);
        Assert.Equal("orders-out", fresh.Name);
        Assert.Equal("1.4.3", fresh.Version);
        Assert.True(await h.Db.Schemas.AnyAsync(s => s.Id == old, h.Ct), "the old version is kept for other processors");
    }

    [Fact]
    public async Task AnEditOnAnEmptySlotNamesTheSchemaAfterTheProcessor()
    {
        // Review focus 4.
        var (h, wf, proc, step, _) = await SetupAsync();
        await using var _h = h;

        var graph = await SaveAsync(h, wf, step, new GraphSchemaEdit(proc, "config", NewDefinition));

        var fresh = graph.Schemas.Single(s => s.Id == graph.Processors[0].ConfigSchemaId);
        Assert.Equal("fetcher-config", fresh.Name);
        Assert.Equal("1.0.0", fresh.Version);
    }

    [Fact]
    public async Task ANullDefinitionClearsTheSlot()
    {
        var (h, wf, proc, step, _) = await SetupAsync();
        await using var _h = h;

        var graph = await SaveAsync(h, wf, step, new GraphSchemaEdit(proc, "output", null));

        Assert.Null(graph.Processors[0].OutputSchemaId);
    }

    [Theory]
    [InlineData("inbound", NewDefinition)]
    [InlineData("output", "{not json")]
    [InlineData("output", """{"type":42}""")]
    public async Task ABadSlotOrDefinitionIsAValidationFailure(string slot, string definition)
    {
        var (h, wf, proc, step, _) = await SetupAsync();
        await using var _h = h;

        await Assert.ThrowsAsync<ValidationException>(() =>
            SaveAsync(h, wf, step, new GraphSchemaEdit(proc, slot, definition)));
    }

    [Fact]
    public async Task AMissingProcessorIsNotFound()
    {
        var (h, wf, _, step, _) = await SetupAsync();
        await using var _h = h;

        await Assert.ThrowsAsync<NotFoundException>(() =>
            SaveAsync(h, wf, step, new GraphSchemaEdit(Guid.NewGuid(), "output", NewDefinition)));
    }
}
