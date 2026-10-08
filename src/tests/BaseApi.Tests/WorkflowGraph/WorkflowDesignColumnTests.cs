using BaseApi.Service.Features.Workflow;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace BaseApi.Tests.WorkflowGraph;

/// <summary>Plan 8: the studio's stored design lives on the workflow row and comes back with the graph.</summary>
public sealed class WorkflowDesignColumnTests
{
    [Fact]
    public async Task DesignIsANullableJsonbColumn()
    {
        await using var h = new GraphHarness();
        var property = h.Db.Model.FindEntityType(typeof(WorkflowEntity))!.FindProperty(nameof(WorkflowEntity.Design))!;

        Assert.True(property.IsNullable);
        // GetColumnType() throws on the InMemory provider; read the annotation HasColumnType sets (as CacheModelTests does).
        Assert.Equal("jsonb", property["Relational:ColumnType"]);
    }

    [Fact]
    public void NoCrudDtoCarriesTheDesign()
    {
        Assert.DoesNotContain(typeof(WorkflowReadDto).GetProperties(), p => p.Name == nameof(WorkflowEntity.Design));
        Assert.DoesNotContain(typeof(WorkflowUpdateDto).GetProperties(), p => p.Name == nameof(WorkflowEntity.Design));
    }

    [Fact]
    public async Task TheGraphReadReturnsTheStoredDesignAndNullWhenThereIsNone()
    {
        await using var h = new GraphHarness();
        var step = await h.StepAsync(await h.ProcessorAsync());
        var wf = await h.WorkflowAsync("wf", [step]);
        Assert.Null((await h.Reader.ReadAsync(wf, h.Ct)).Design);

        var row = await h.Db.Workflows.SingleAsync(w => w.Id == wf, h.Ct);
        row.Design = """{"steps":[]}""";
        await h.Db.SaveChangesAsync(h.Ct);
        h.Forget();

        var graph = await h.Reader.ReadAsync(wf, h.Ct);
        Assert.Equal(0, graph.Design!.Value.GetProperty("steps").GetArrayLength());
    }
}
