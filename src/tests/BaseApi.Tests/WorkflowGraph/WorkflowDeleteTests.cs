using System.Text.Json;
using BaseApi.Service.Features.Orchestration;
using BaseApi.Service.Features.Orchestration.Messaging;
using BaseApi.Service.Features.Orchestration.Projection;
using BaseApi.Service.Features.Orchestration.Validation;
using BaseApi.Service.Features.Workflow.Delete;
using BaseApi.Service.Features.Workflow.Design;
using BaseApi.Tests.Support;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Messaging.Transport;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using Xunit;

namespace BaseApi.Tests.WorkflowGraph;

/// <summary>
/// A workflow's deletion (the user's rules, 2026-10-10): never while it runs, with its own steps and assignments, never
/// its caches or processors, refused while another workflow uses a step or assignment of it; a dry run rolls back; a
/// start never races it (the guard refuses a start and keeps a queued start from projecting), and the plain CRUD
/// delete is refused while it runs.
/// </summary>
public sealed class WorkflowDeleteTests
{
    /// <summary>Records whether the deletion committed or rolled back (InMemory has no transactions to undo).</summary>
    private sealed class RecordingTransactions : IDesignTransactions
    {
        public int Commits { get; private set; }
        public int Rollbacks { get; private set; }

        public Task<IDesignTransaction> BeginAsync(CancellationToken ct) => Task.FromResult<IDesignTransaction>(new Tx(this));

        private sealed class Tx(RecordingTransactions owner) : IDesignTransaction
        {
            public Task SavepointAsync(string name, CancellationToken ct) => Task.CompletedTask;
            public Task RollbackToSavepointAsync(string name, CancellationToken ct) => Task.CompletedTask;
            public Task ReleaseSavepointAsync(string name, CancellationToken ct) => Task.CompletedTask;
            public Task CommitAsync(CancellationToken ct) { owner.Commits++; return Task.CompletedTask; }
            public Task RollbackAsync(CancellationToken ct) { owner.Rollbacks++; return Task.CompletedTask; }
            public ValueTask DisposeAsync() => ValueTask.CompletedTask;
        }
    }

    private sealed class Rig : IAsyncDisposable
    {
        public GraphHarness H { get; } = new();
        public InMemoryL2 L2 { get; } = new();
        public RecordingTransactions Tx { get; } = new();
        public RedisWorkflowRunGuard Guard { get; }

        public Rig() => Guard = new RedisWorkflowRunGuard(L2.Multiplexer);

        public WorkflowDeleter Deleter() => new(H.Db, Tx, Guard);

        public ValueTask DisposeAsync() => H.DisposeAsync();
    }

    private static string[] Lines(WorkflowDeleteOutcomeDto o) => o.Log.Select(l => $"{l.Level} {l.Stage}: {l.Message}").ToArray();

    /// <summary>wf: entry a -> b, a parked step p (in its layout), an assignment on a, a cache; another workflow other.</summary>
    private static async Task<(Guid Wf, Guid A, Guid B, Guid P, Guid Asg, Guid Cache, Guid Proc)> SeedAsync(GraphHarness h)
    {
        var proc = await h.ProcessorAsync();
        var b = await h.StepAsync(proc, "b");
        var a = await h.StepAsync(proc, "a", b);
        var p = await h.StepAsync(proc, "p");
        var asg = await h.AssignmentAsync(a);
        var wf = await h.WorkflowAsync("wf", [a], [asg], layout: $$"""{"parked":["{{p}}"]}""");
        var cache = await h.CacheAsync("root");
        h.Db.Add(new BaseApi.Service.Features.Workflow.WorkflowCaches { WorkflowId = wf, CacheId = cache });
        await h.Db.SaveChangesAsync(h.Ct);
        h.Forget();
        return (wf, a, b, p, asg, cache, proc);
    }

    [Fact]
    public async Task ADryRunSaysWhatWouldBeDeletedAndRollsBack()
    {
        await using var r = new Rig();
        var s = await SeedAsync(r.H);

        var o = await r.Deleter().DeleteAsync(s.Wf, dryRun: true, r.H.Ct);

        Assert.False(o.Applied);
        Assert.True(o.DryRun);
        Assert.Empty(o.Errors);
        Assert.Equal((3, 1, 1, 1), (o.Steps, o.Assignments, o.Caches, o.Processors));
        Assert.Equal((0, 1), (r.Tx.Commits, r.Tx.Rollbacks));
        Assert.Contains("info liveness: liveness: not running (read now)", Lines(o));
        Assert.Contains("info outcome: dry run passed: it would delete the workflow, 3 steps and 1 assignment; rolled back, nothing deleted", Lines(o));
        Assert.True(o.Log.Where(l => l.Kind is "step" or "workflow" or "assignment").All(l => l.RolledBack));
        // a dry run never holds the start guard
        Assert.False(r.L2.Has(RedisWorkflowRunGuard.Deleting(s.Wf)));
    }

    [Fact]
    public async Task TheRealRunDeletesItsStepsAndAssignmentsKeepsCachesAndProcessorsAndRemovesWhatItProjected()
    {
        await using var r = new Rig();
        var s = await SeedAsync(r.H);
        var db = r.L2.Db;
        await db.HashSetAsync(L2ProjectionKeys.Workflow(s.Wf), [new StackExchange.Redis.HashEntry(L2ProjectionKeys.RootsField, "[\"root\"]")]);
        await db.StringSetAsync(L2ProjectionKeys.Cache(s.Wf, "root"), "[\"k\"]");
        await db.StringSetAsync(L2ProjectionKeys.CacheEntry(s.Wf, "root", "k"), "v");
        await db.HashSetAsync(L2ProjectionKeys.StepEntity(s.A), L2ProjectionKeys.NameField, "a");

        var o = await r.Deleter().DeleteAsync(s.Wf, dryRun: false, r.H.Ct);

        Assert.True(o.Applied, string.Join("\n", Lines(o)));
        Assert.Equal((1, 0), (r.Tx.Commits, r.Tx.Rollbacks));
        r.H.Forget();
        Assert.False(await r.H.Db.Workflows.AnyAsync(w => w.Id == s.Wf, r.H.Ct));
        Assert.False(await r.H.Db.Steps.AnyAsync(x => x.Id == s.A || x.Id == s.B || x.Id == s.P, r.H.Ct));
        Assert.False(await r.H.Db.Assignments.AnyAsync(x => x.Id == s.Asg, r.H.Ct));
        Assert.False(await r.H.Db.StepNextSteps.AnyAsync(j => j.StepId == s.A, r.H.Ct));
        Assert.False(await r.H.Db.WorkflowEntrySteps.AnyAsync(j => j.WorkflowId == s.Wf, r.H.Ct));
        Assert.False(await r.H.Db.WorkflowCaches.AnyAsync(j => j.WorkflowId == s.Wf, r.H.Ct));
        Assert.True(await r.H.Db.Caches.AnyAsync(c => c.Id == s.Cache, r.H.Ct));
        Assert.True(await r.H.Db.Processors.AnyAsync(p => p.Id == s.Proc, r.H.Ct));
        Assert.Contains("info delete: workflow 'wf' deleted: its id is gone for good", Lines(o));
        Assert.Contains("info delete: kept: 1 cache (unlinked only), 1 processor (untouched)", Lines(o));
        // what it projected is gone; a tombstone keeps a queued start from projecting it; the running marker is released
        Assert.False(r.L2.HasHash(L2ProjectionKeys.Workflow(s.Wf)));
        Assert.False(r.L2.Has(L2ProjectionKeys.Cache(s.Wf, "root")));
        Assert.False(r.L2.Has(L2ProjectionKeys.CacheEntry(s.Wf, "root", "k")));
        Assert.False(r.L2.HasHash(L2ProjectionKeys.StepEntity(s.A)));
        Assert.True(r.L2.Has(RedisWorkflowRunGuard.Deleted(s.Wf)));
        Assert.False(r.L2.Has(RedisWorkflowRunGuard.Deleting(s.Wf)));
    }

    [Fact]
    public async Task ARunningWorkflowIsRefusedAndNothingIsDeleted()
    {
        await using var r = new Rig();
        var s = await SeedAsync(r.H);
        await r.L2.Db.SetAddAsync(L2ProjectionKeys.Live(), s.Wf.ToString("D"));

        foreach (var dry in new[] { true, false })
        {
            var o = await r.Deleter().DeleteAsync(s.Wf, dry, r.H.Ct);
            Assert.False(o.Applied);
            var e = Assert.Single(o.Errors);
            Assert.Equal(("workflow", "liveness"), (e.Kind, e.Stage));
            Assert.StartsWith("running: stop it first", e.Message);
        }
        Assert.Equal(0, r.Tx.Commits);
        r.H.Forget();
        Assert.True(await r.H.Db.Workflows.AnyAsync(w => w.Id == s.Wf, r.H.Ct));
        Assert.True(await r.H.Db.Steps.AnyAsync(x => x.Id == s.A, r.H.Ct));
        // refused, the start guard is released and no tombstone is left
        Assert.False(r.L2.Has(RedisWorkflowRunGuard.Deleting(s.Wf)));
        Assert.False(r.L2.Has(RedisWorkflowRunGuard.Deleted(s.Wf)));
    }

    [Fact]
    public async Task AStepOrAssignmentAnotherWorkflowUsesIsRefusedByNameAndNothingIsDeleted()
    {
        await using var r = new Rig();
        var s = await SeedAsync(r.H);
        // another workflow enters at b and links the assignment
        await r.H.WorkflowAsync("other", [s.B], [s.Asg]);

        var o = await r.Deleter().DeleteAsync(s.Wf, dryRun: false, r.H.Ct);

        Assert.False(o.Applied);
        Assert.Contains(o.Errors, e => e.Id == s.B && e.Message == "not deleted: used by workflow 'other' (an entry step there)");
        Assert.Contains(o.Errors, e => e.Id == s.Asg && e.Message == "not deleted: used by workflow 'other' (linked there)");
        Assert.Equal((0, 1), (r.Tx.Commits, r.Tx.Rollbacks));
        r.H.Forget();
        Assert.True(await r.H.Db.Workflows.AnyAsync(w => w.Id == s.Wf, r.H.Ct));
        Assert.Contains("error outcome: rolled back: nothing was deleted", Lines(o));
    }

    [Fact]
    public async Task AMissingWorkflowIsNotFound()
    {
        await using var r = new Rig();
        await Assert.ThrowsAsync<BaseApi.Core.Exceptions.NotFoundException>(() => r.Deleter().DeleteAsync(Guid.NewGuid(), dryRun: true, r.H.Ct));
    }

    [Fact]
    public async Task AStartIsRefusedWhileItsDeletionRunsAndAfterItIsDeleted()
    {
        await using var r = new Rig();
        var s = await SeedAsync(r.H);
        var sender = Substitute.For<IQueueSender>();
        var service = new OrchestrationService(
            r.H.Db, r.H.Loader, new CycleDetector(), new SchemaEdgeValidator(), new PayloadConfigSchemaValidator(),
            new ProcessorLivenessValidator(r.L2.Multiplexer, r.H.Clock), sender, NullLogger<OrchestrationService>.Instance, r.Guard);

        await r.Guard.BeginDeleteAsync(s.Wf, r.H.Ct);
        var refused = await Assert.ThrowsAsync<OrchestrationValidationException>(() => service.StartAsync(s.Wf, r.H.Ct));
        Assert.Equal("workflowDeleting", refused.Gate);

        await r.Guard.EndDeleteAsync(s.Wf, deleted: true, [], r.H.Ct);
        Assert.Equal("workflowDeleting", (await Assert.ThrowsAsync<OrchestrationValidationException>(() => service.StartAsync(s.Wf, r.H.Ct))).Gate);
        await sender.DidNotReceiveWithAnyArgs().SendAsync<StartOrchestration>(default!, default!, default!, r.H.Ct, default, default);
    }

    [Fact]
    public async Task AStartQueuedBeforeTheDeletionIsNotProjected()
    {
        await using var r = new Rig();
        var wf = Guid.NewGuid();
        var publisher = Substitute.For<IQueueFanoutPublisher>();
        var handler = new StartOrchestrationHandler(
            new L2ProjectionWriter(r.L2.Multiplexer, FakeStepRows.Everything()), new L2LiveSet(r.L2.Multiplexer), publisher,
            NullLogger<StartOrchestrationHandler>.Instance, r.Guard);
        var body = JsonSerializer.SerializeToUtf8Bytes(
            new StartOrchestration(new WorkflowL1(wf, [], null, [], [], new Dictionary<Guid, string>())), MessagingJson.Options);

        await r.Guard.BeginDeleteAsync(wf, r.H.Ct);
        await handler.HandleAsync(body, r.H.Ct);
        await r.Guard.EndDeleteAsync(wf, deleted: true, [], r.H.Ct);
        await handler.HandleAsync(body, r.H.Ct);

        Assert.Empty(r.L2.Members(L2ProjectionKeys.Live()));
        Assert.False(r.L2.HasHash(L2ProjectionKeys.Workflow(wf)));
        await publisher.DidNotReceiveWithAnyArgs().PublishAsync<OrchestrationStarted>(default!, default!, default!, r.H.Ct);
    }

    [Fact]
    public async Task ThePlainCrudDeleteIsRefusedWhileTheWorkflowRunsOrIsBeingDeleted()
    {
        await using var r = new Rig();
        var filter = new WorkflowDeleteGuardFilter(r.Guard);
        var wf = Guid.NewGuid();
        var nexts = 0;
        Task Run(string method)
        {
            var http = new DefaultHttpContext();
            http.Request.Method = method;
            var context = new ActionExecutingContext(
                new ActionContext(http, new RouteData(), new ActionDescriptor()), [], new Dictionary<string, object?> { ["id"] = wf }, controller: null!);
            return filter.OnActionExecutionAsync(context, () => { nexts++; return Task.FromResult<ActionExecutedContext>(null!); });
        }

        await r.L2.Db.SetAddAsync(L2ProjectionKeys.Live(), wf.ToString("D"));
        Assert.Equal("workflowRunning", (await Assert.ThrowsAsync<OrchestrationValidationException>(() => Run("DELETE"))).Gate);
        await Run("GET");
        Assert.Equal(1, nexts);

        await r.L2.Db.SetRemoveAsync(L2ProjectionKeys.Live(), wf.ToString("D"));
        await r.Guard.BeginDeleteAsync(wf, r.H.Ct);
        Assert.Equal("workflowDeleting", (await Assert.ThrowsAsync<OrchestrationValidationException>(() => Run("DELETE"))).Gate);

        // ended: deleted, its tombstone does not refuse the CRUD delete (the id is simply not found there)
        await r.Guard.EndDeleteAsync(wf, deleted: true, [], r.H.Ct);
        await Run("DELETE");
        Assert.Equal(2, nexts);
    }
}
