using BaseApi.Service;
using BaseApi.Service.Features.Workflow;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace BaseApi.Tests.WorkflowGraph;

/// <summary>
/// The workflow's canvas layout: positions only, opaque to the server, stored beside the workflow
/// row so a graph save can write it in the same commit as the graph it describes.
/// </summary>
public sealed class WorkflowLayoutTests
{
    private static AppDbContext NewContext() =>
        new(new DbContextOptionsBuilder<AppDbContext>()
            .UseInMemoryDatabase($"layout-{Guid.NewGuid():N}")
            .Options);

    [Fact]
    public void LayoutIsANullableJsonbColumn()
    {
        using var db = NewContext();
        var property = db.Model.FindEntityType(typeof(WorkflowEntity))!.FindProperty(nameof(WorkflowEntity.Layout))!;

        Assert.True(property.IsNullable);
        Assert.Equal("jsonb", property["Relational:ColumnType"]);
    }

    [Fact]
    public void TheReadMapperDoesNotCarryTheLayout()
    {
        // Layout travels only through the layout and graph actions, never through CRUD.
        var read = new WorkflowEntityMapper().ToRead(new WorkflowEntity
        {
            Name = "wf", Version = "1.0.0", Layout = """{"nodes":{}}""",
        });

        Assert.DoesNotContain(typeof(WorkflowReadDto).GetProperties(),
            p => p.Name == nameof(WorkflowEntity.Layout));
        Assert.Equal("wf", read.Name);
    }
}
