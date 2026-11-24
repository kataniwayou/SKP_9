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
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using BaseApi.Service.Features.Orchestration.Validation;
using StackExchange.Redis;

namespace BaseApi.Tests.WorkflowGraph;

/// <summary>
/// An InMemory context with the real audit interceptor on a fake clock, so <c>UpdatedAt</c> moves
/// exactly as it does in production and the concurrency tests can step time deliberately. InMemory
/// enforces no foreign keys and no transactions; what depends on Postgres is proven by the live tests.
/// </summary>
internal sealed class GraphHarness : IAsyncDisposable
{
    private readonly string _name = $"graph-{Guid.NewGuid():N}";

    // One root for the whole test run (each harness has its own database name): a root per harness would make
    // EF build a service provider per harness and trip ManyServiceProvidersCreatedWarning after twenty.
    private static readonly Microsoft.EntityFrameworkCore.Storage.InMemoryDatabaseRoot Root = new();

    public FakeTimeProvider Clock { get; } = new(new DateTimeOffset(2026, 10, 5, 12, 0, 0, TimeSpan.Zero));
    public AppDbContext Db { get; }
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
    }


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
            Id = Guid.NewGuid(), Name = name, Version = "1.0.0", SourceHash = Guid.NewGuid().ToString("N") + Guid.NewGuid().ToString("N"),
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

    public async Task<Guid> CacheAsync(string root, params (string Key, string Value)[] items)
    {
        var c = new CacheEntity
        {
            Id = Guid.NewGuid(), Name = "cache", Version = "1.0.0", Root = root,
            Items = items.Select(i => new CacheItem { Key = i.Key, Value = i.Value }).ToList(),
        };
        Db.Add(c);
        await Db.SaveChangesAsync(Ct);
        return c.Id;
    }

    /// <summary>Forgets every tracked entity, so the next read sees the store rather than the tracker.</summary>
    public void Forget() => Db.ChangeTracker.Clear();

    /// <summary>
    /// The dry-run validator over this harness. InMemory has no transactions, so the dry run is a pass
    /// through here; these tests assert problems only.
    /// </summary>
    public IWorkflowValidator Validator(IConnectionMultiplexer redis) =>
        new WorkflowValidator(
            Db, Loader,
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

    public ValueTask DisposeAsync() => Db.DisposeAsync();
}
