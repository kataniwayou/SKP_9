using System.Text.Json;
using BaseApi.Core.Persistence.Repositories;
using BaseApi.Service.Features.Workflow;
using BaseApi.Service.Features.Workflow.Graph;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace BaseApi.Tests.WorkflowGraph;

public sealed class WorkflowGraphControllerTests
{
    private static WorkflowsController Controller(GraphHarness h) =>
        new(new WorkflowService(
                new WorkflowCreateDtoValidator(), new WorkflowUpdateDtoValidator(),
                new WorkflowEntityMapper(), new Repository<WorkflowEntity>(h.Db), h.Db),
            h.Db, h.Reader, h.Saver);

    [Fact]
    public async Task GetGraphReturnsTheGraph()
    {
        await using var h = new GraphHarness();
        var step = await h.StepAsync(await h.ProcessorAsync());
        var wf = await h.WorkflowAsync("wf", [step]);

        var ok = Assert.IsType<OkObjectResult>(await Controller(h).GetGraph(wf, h.Ct));
        Assert.Equal(wf, Assert.IsType<WorkflowGraphDto>(ok.Value).Workflow.Id);
    }

    [Fact]
    public async Task PutGraphReturnsTheSavedGraph()
    {
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var (wf, a) = (Guid.NewGuid(), Guid.NewGuid());

        var ok = Assert.IsType<OkObjectResult>(await Controller(h).PutGraph(wf,
            GraphHarness.Request([a], steps: [GraphHarness.NewStep(a, proc)]), h.Ct));
        Assert.Equal([a], Assert.IsType<WorkflowGraphDto>(ok.Value).Workflow.EntryStepIds!);
    }

    [Fact]
    public async Task TheConflictHandlerWritesA409NamingTheEntity()
    {
        var services = new ServiceCollection().AddOptions().AddProblemDetails().BuildServiceProvider();
        var http = new DefaultHttpContext { RequestServices = services };
        http.Response.Body = new MemoryStream();
        var handler = new GraphConflictExceptionHandler(services.GetRequiredService<IProblemDetailsService>());
        var id = Guid.NewGuid();

        var handled = await handler.TryHandleAsync(http, new GraphConflictException("step", id), CancellationToken.None);

        Assert.True(handled);
        Assert.Equal(StatusCodes.Status409Conflict, http.Response.StatusCode);
        http.Response.Body.Position = 0;
        var body = await JsonDocument.ParseAsync(http.Response.Body, cancellationToken: TestContext.Current.CancellationToken);
        Assert.Equal("step", body.RootElement.GetProperty("kind").GetString());
        Assert.Equal(id, body.RootElement.GetProperty("id").GetGuid());
    }

    [Fact]
    public async Task TheConflictHandlerIgnoresOtherExceptions()
    {
        var services = new ServiceCollection().AddOptions().AddProblemDetails().BuildServiceProvider();
        var handler = new GraphConflictExceptionHandler(services.GetRequiredService<IProblemDetailsService>());

        Assert.False(await handler.TryHandleAsync(new DefaultHttpContext(), new InvalidOperationException(), CancellationToken.None));
    }
}
