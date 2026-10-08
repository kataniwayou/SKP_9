using System.Text.Json;
using BaseApi.Core.Persistence.Repositories;
using BaseApi.Service;
using BaseApi.Service.Features.Workflow;
using BaseApi.Service.Features.Workflow.Graph;
using Microsoft.AspNetCore.Mvc;
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

    private static JsonElement Json(string text) => JsonDocument.Parse(text).RootElement.Clone();

    [Fact]
    public void AnObjectWithinTheCapIsValid() =>
        Assert.Null(WorkflowLayout.Validate(Json("""{"nodes":{"a":{"x":8,"y":16}}}""")));

    [Theory]
    [InlineData("[]")]
    [InlineData("42")]
    [InlineData("\"text\"")]
    [InlineData("null")]
    public void ANonObjectIsRejected(string text) =>
        Assert.NotNull(WorkflowLayout.Validate(Json(text)));

    [Fact]
    public void AnObjectOverTheCapIsRejected()
    {
        var big = "{\"pad\":\"" + new string('x', WorkflowLayout.MaxChars) + "\"}";
        Assert.NotNull(WorkflowLayout.Validate(Json(big)));
    }

    private static (AppDbContext Db, WorkflowsController Controller) NewController()
    {
        var db = NewContext();
        var service = new WorkflowService(
            new WorkflowCreateDtoValidator(), new WorkflowUpdateDtoValidator(),
            new WorkflowEntityMapper(), new Repository<WorkflowEntity>(db), db);
        return (db, new WorkflowsController(service, db, graphReader: null!, graphSaver: null!, validator: null!, designSyncer: null!));
    }

    [Fact]
    public async Task PutThenGetRoundTripsTheLayout()
    {
        var (db, controller) = NewController();
        var id = Guid.NewGuid();
        db.Add(new WorkflowEntity { Id = id, Name = "wf", Version = "1.0.0" });
        await db.SaveChangesAsync(TestContext.Current.CancellationToken);

        var put = await controller.PutLayout(id, Json("""{"nodes":{"s1":{"x":8,"y":16}}}"""), TestContext.Current.CancellationToken);
        var get = await controller.GetLayout(id, TestContext.Current.CancellationToken);

        var saved = Assert.IsType<LayoutSavedDto>(Assert.IsType<OkObjectResult>(put).Value);
        var row = await db.Set<WorkflowEntity>().AsNoTracking().SingleAsync(w => w.Id == id, TestContext.Current.CancellationToken);
        Assert.Equal(row.UpdatedAt, saved.UpdatedAt);
        var content = Assert.IsType<ContentResult>(get);
        Assert.Equal("application/json", content.ContentType);
        Assert.Equal(16, JsonDocument.Parse(content.Content!).RootElement.GetProperty("nodes").GetProperty("s1").GetProperty("y").GetInt32());
    }

    [Fact]
    public async Task GetOnAWorkflowNeverLaidOutAnswersJsonNull()
    {
        var (db, controller) = NewController();
        var id = Guid.NewGuid();
        db.Add(new WorkflowEntity { Id = id, Name = "wf", Version = "1.0.0" });
        await db.SaveChangesAsync(TestContext.Current.CancellationToken);

        var content = Assert.IsType<ContentResult>(await controller.GetLayout(id, TestContext.Current.CancellationToken));
        Assert.Equal("null", content.Content);
    }

    [Fact]
    public async Task AMissingWorkflowIs404OnBothVerbs()
    {
        var (_, controller) = NewController();
        Assert.IsType<NotFoundResult>(await controller.GetLayout(Guid.NewGuid(), TestContext.Current.CancellationToken));
        Assert.IsType<NotFoundResult>(await controller.PutLayout(Guid.NewGuid(), Json("{}"), TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task PutRejectsANonObjectWith400()
    {
        var (db, controller) = NewController();
        var id = Guid.NewGuid();
        db.Add(new WorkflowEntity { Id = id, Name = "wf", Version = "1.0.0" });
        await db.SaveChangesAsync(TestContext.Current.CancellationToken);

        Assert.IsType<BadRequestObjectResult>(await controller.PutLayout(id, Json("[]"), TestContext.Current.CancellationToken));
    }
}
