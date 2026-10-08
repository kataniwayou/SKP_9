using BaseApi.Core.Persistence.Interceptors;
using BaseApi.Service;
using BaseApi.Service.Features.Assignment;
using BaseApi.Service.Features.Cache;
using BaseApi.Service.Features.Orchestration;
using BaseApi.Service.Features.Orchestration.Loading;
using BaseApi.Service.Features.Processor;
using BaseApi.Service.Features.Schema;
using BaseApi.Service.Features.Step;
using BaseApi.Service.Features.Workflow;
using BaseApi.Service.Features.Workflow.Design;
using BaseApi.Service.Features.Workflow.Graph;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using BaseApi.Service.Features.Orchestration.Validation;
using StackExchange.Redis;

namespace BaseApi.Tests.WorkflowGraph;

/// <summary>
/// An InMemory context with the real audit interceptor on a fake clock, so <c>UpdatedAt</c> moves
/// exactly as it does in production and the concurrency tests can step time deliberately. InMemory
/// enforces no foreign keys and no transactions; what depends on Postgres is proven by
/// <c>WorkflowGraphLiveTests</c>.
/// </summary>
internal sealed class GraphHarness : IAsyncDisposable
{
    private readonly string _name = $"graph-{Guid.NewGuid():N}";

    // One root for the whole test run (each harness has its own database name): a root per harness would make
    // EF build a service provider per harness and trip ManyServiceProvidersCreatedWarning after twenty.
    private static readonly InMemoryDatabaseRoot SharedRoot = new();

    /// <summary>Shared by every context of this harness, so a second context (the design store's) sees the same rows.</summary>
    public InMemoryDatabaseRoot Root => SharedRoot;

    public FakeTimeProvider Clock { get; } = new(new DateTimeOffset(2026, 10, 5, 12, 0, 0, TimeSpan.Zero));
    public AppDbContext Db { get; }
    public IWorkflowGraphReader Reader { get; }
    public IWorkflowGraphSaver Saver { get; }
    public IWorkflowGraphLoader Loader { get; }

    public GraphHarness()
    {
        Db = new AppDbContext(new DbContextOptionsBuilder<AppDbContext>()
            .UseInMemoryDatabase(_name, Root)
            .AddInterceptors(new AuditInterceptor(new HttpContextAccessor(), Clock))
            .Options);

        Loader = new WorkflowGraphLoader(
            Db, NullLogger<WorkflowGraphSnapshot>.Instance,
            new SchemaEntityMapper(), new ProcessorEntityMapper(), new StepEntityMapper(),
            new AssignmentEntityMapper(), new WorkflowEntityMapper(), new CacheEntityMapper());
        Reader = new WorkflowGraphReader(Db, Loader);
        Saver = new WorkflowGraphSaver(
            Db, Reader,
            new WorkflowUpdateDtoValidator(),
            new StepCreateDtoValidator(), new StepUpdateDtoValidator(),
            new WorkflowEntityMapper(), new StepEntityMapper(),
            new GraphAssignmentResolver(Db, new AssignmentCreateDtoValidator()),
            new GraphSchemaEditor(Db, new SchemaCreateDtoValidator()));
    }


    public static GraphSaveRequest Request(
        Guid[] entry,
        DateTime? workflowUpdatedAt = null,
        GraphStepDto[]? steps = null,
        GraphAssignmentIntent[]? assignments = null,
        GraphSchemaEdit[]? schemaEdits = null,
        string? layout = null,
        string name = "wf") =>
        new(new GraphWorkflowDto(name, "1.0.0", null, null, workflowUpdatedAt, entry.ToList(), null),
            steps?.ToList(), assignments?.ToList(), schemaEdits?.ToList(),
            layout is null ? null : System.Text.Json.JsonDocument.Parse(layout).RootElement.Clone());

    public static GraphStepDto NewStep(Guid id, Guid processorId, string name = "step", params Guid[] next) =>
        new(id, null, name, "1.0.0", null, processorId, next.ToList(), StepEntryCondition.PreviousCompleted);

    public CancellationToken Ct => Xunit.TestContext.Current.CancellationToken;

    /// <summary>Moves the clock a second, so the next save stamps a later UpdatedAt.</summary>
    public void Tick() => Clock.Advance(TimeSpan.FromSeconds(1));

    public async Task<Guid> SchemaAsync(string name = "schema", string version = "1.0.0", string definition = """{"type":"object"}""")
    {
        var s = new SchemaEntity { Id = Guid.NewGuid(), Name = name, Version = version, Definition = definition };
        Db.Add(s);
        await Db.SaveChangesAsync(Ct);
        return s.Id;
    }

    public async Task<Guid> ProcessorAsync(string name = "proc", Guid? input = null, Guid? output = null, Guid? config = null)
    {
        var p = new ProcessorEntity
        {
            Id = Guid.NewGuid(), Name = name, Version = "1.0.0", SourceHash = Guid.NewGuid().ToString("N"),
            InputSchemaId = input, OutputSchemaId = output, ConfigSchemaId = config,
        };
        Db.Add(p);
        await Db.SaveChangesAsync(Ct);
        return p.Id;
    }

    public async Task<Guid> StepAsync(Guid processorId, string name = "step", params Guid[] next)
    {
        var s = new StepEntity
        {
            Id = Guid.NewGuid(), Name = name, Version = "1.0.0", ProcessorId = processorId,
            EntryCondition = StepEntryCondition.PreviousCompleted,
        };
        Db.Add(s);
        foreach (var n in next) Db.Add(new StepNextSteps { StepId = s.Id, NextStepId = n });
        await Db.SaveChangesAsync(Ct);
        return s.Id;
    }

    public async Task<Guid> WorkflowAsync(string name, Guid[] entry, Guid[]? assignments = null, string? layout = null)
    {
        var w = new WorkflowEntity { Id = Guid.NewGuid(), Name = name, Version = "1.0.0", Layout = layout };
        Db.Add(w);
        foreach (var e in entry) Db.Add(new WorkflowEntrySteps { WorkflowId = w.Id, StepId = e });
        foreach (var a in assignments ?? []) Db.Add(new WorkflowAssignments { WorkflowId = w.Id, AssignmentId = a });
        await Db.SaveChangesAsync(Ct);
        return w.Id;
    }

    public async Task<Guid> AssignmentAsync(Guid stepId, string payload = """{"k":1}""")
    {
        var a = new AssignmentEntity { Id = Guid.NewGuid(), Name = "asg", Version = "1.0.0", StepId = stepId, Payload = payload };
        Db.Add(a);
        await Db.SaveChangesAsync(Ct);
        return a.Id;
    }

    /// <summary>Forgets every tracked entity, so the next read sees the store rather than the tracker.</summary>
    public void Forget() => Db.ChangeTracker.Clear();

    /// <summary>
    /// The dry-run validator over this harness. InMemory has no transactions, so the dry run is a pass
    /// through here: what the draft writes stays written, and these tests assert problems only.
    /// WorkflowValidationLiveTests proves on Postgres that nothing persists.
    /// </summary>
    public IWorkflowValidator Validator(IConnectionMultiplexer redis) =>
        new WorkflowValidator(
            Db, Saver, Loader,
            new CycleDetector(), new SchemaEdgeValidator(), new PayloadConfigSchemaValidator(),
            new ProcessorLivenessValidator(redis, Clock),
            new PassThroughDryRun(Db));

    private sealed class PassThroughDryRun(AppDbContext db) : IGraphDryRun
    {
        public async Task<T> RunAsync<T>(Func<CancellationToken, Task<T>> work, CancellationToken ct)
        {
            try { return await work(ct); }
            finally { db.ChangeTracker.Clear(); }
        }
    }

    /// <summary>
    /// The design syncer over this harness. InMemory has no transactions, so the stages' writes are not
    /// rolled back here: these tests assert the answer and what an applied design wrote;
    /// WorkflowDesignLiveTests proves the rollback on Postgres.
    /// </summary>
    public IWorkflowDesignSyncer Syncer(IReadOnlyList<IDesignStage>? stages = null) =>
        new WorkflowDesignSyncer(Db, new HarnessDesignStore(Root, _name), new PassThroughDesignTransactions(), stages ?? AllStages());

    /// <summary>Every stage, in the spec's order (plan 8 §4.3); each stage task adds its own.</summary>
    public IReadOnlyList<IDesignStage> AllStages() => [];

    /// <summary>The store through a second context with no audit interceptor, as ExecuteUpdate bypasses it in production.</summary>
    private sealed class HarnessDesignStore(InMemoryDatabaseRoot root, string name) : IDesignStore
    {
        private AppDbContext Plain() => new(new DbContextOptionsBuilder<AppDbContext>().UseInMemoryDatabase(name, root).Options);

        public async Task<bool> StoreAsync(Guid workflowId, string design, string layout, CancellationToken ct)
        {
            await using var db = Plain();
            var row = await db.Workflows.FirstOrDefaultAsync(w => w.Id == workflowId, ct);
            if (row is null) return false;
            row.Design = design;
            row.Layout = layout;
            await db.SaveChangesAsync(ct);
            return true;
        }

        public async Task ClearAsync(Guid workflowId, CancellationToken ct)
        {
            await using var db = Plain();
            var row = await db.Workflows.FirstAsync(w => w.Id == workflowId, ct);
            row.Design = null;
            await db.SaveChangesAsync(ct);
        }
    }

    private sealed class PassThroughDesignTransactions : IDesignTransactions
    {
        public Task<IDesignTransaction> BeginAsync(CancellationToken ct) => Task.FromResult<IDesignTransaction>(new Nothing());

        private sealed class Nothing : IDesignTransaction
        {
            public Task SavepointAsync(string name, CancellationToken ct) => Task.CompletedTask;
            public Task RollbackToSavepointAsync(string name, CancellationToken ct) => Task.CompletedTask;
            public Task ReleaseSavepointAsync(string name, CancellationToken ct) => Task.CompletedTask;
            public Task CommitAsync(CancellationToken ct) => Task.CompletedTask;
            public Task RollbackAsync(CancellationToken ct) => Task.CompletedTask;
            public ValueTask DisposeAsync() => ValueTask.CompletedTask;
        }
    }

    public ValueTask DisposeAsync() => Db.DisposeAsync();
}
