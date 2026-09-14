using BaseApi.Core.Persistence.Repositories;
using BaseApi.Service;
using BaseApi.Service.Features.Workflow;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace BaseApi.Tests.Cache;

/// <summary>
/// The caches a workflow names live in <c>workflow_caches</c> rather than on the entity, so the
/// mapper cannot supply them and hard-codes null. Without the enrichment step every read reports a
/// workflow as having no caches, and a client that reads-then-writes destroys the bindings it just
/// failed to see — the same failure the entry-step and assignment collections were given
/// <c>EnrichReadAsync</c> to prevent.
/// </summary>
public sealed class WorkflowCacheJunctionTests : IAsyncLifetime
{
    private AppDbContext _db = null!;
    private WorkflowService _service = null!;
    private readonly Guid _entryStep = Guid.NewGuid();
    private readonly Guid _cacheA = Guid.NewGuid();
    private readonly Guid _cacheB = Guid.NewGuid();
    private Guid _bound, _bare;

    public async ValueTask InitializeAsync()
    {
        _db = new AppDbContext(new DbContextOptionsBuilder<AppDbContext>()
            .UseInMemoryDatabase($"workflow-caches-{Guid.NewGuid():N}")
            .Options);

        _service = new WorkflowService(
            new WorkflowCreateDtoValidator(),
            new WorkflowUpdateDtoValidator(),
            new WorkflowEntityMapper(),
            new Repository<WorkflowEntity>(_db),
            _db);

        // Two caches on the first workflow, so no assertion can pass by accident on a single-element
        // list. The second names none at all.
        _bound = await CreateAsync("wf-bound", [_cacheA, _cacheB]);
        _bare  = await CreateAsync("wf-bare", null);
    }

    public async ValueTask DisposeAsync() => await _db.DisposeAsync();

    private async Task<Guid> CreateAsync(string name, List<Guid>? caches)
    {
        var dto = new WorkflowCreateDto(name, "1.0.0", null, [_entryStep], null, caches, null);
        return (await _service.CreateAsync(dto, TestContext.Current.CancellationToken)).Id;
    }

    [Fact]
    public async Task GetByIdReturnsTheCaches()
    {
        var read = await _service.GetByIdAsync(_bound, TestContext.Current.CancellationToken);

        Assert.NotNull(read.CacheIds);
        Assert.Equal(
            new[] { _cacheA, _cacheB }.OrderBy(x => x),
            read.CacheIds!.OrderBy(x => x));
    }

    [Fact]
    public async Task GetByIdReturnsAnEmptyListForAWorkflowWithNoCaches()
    {
        // Empty, not null — the field always means what it says, so a caller can tell a workflow
        // with no caches from a collection that was never read.
        var read = await _service.GetByIdAsync(_bare, TestContext.Current.CancellationToken);

        Assert.NotNull(read.CacheIds);
        Assert.Empty(read.CacheIds!);
    }

    [Fact]
    public async Task AnUpdateReplacesTheCachesRatherThanAppending()
    {
        var replacement = new WorkflowUpdateDto(
            "wf-bound", "1.0.0", null, [_entryStep], null, [_cacheB], null);

        await _service.UpdateAsync(_bound, replacement, TestContext.Current.CancellationToken);
        var read = await _service.GetByIdAsync(_bound, TestContext.Current.CancellationToken);

        Assert.Equal([_cacheB], read.CacheIds!);
    }

    [Fact]
    public void TheJunctionCascadesFromItsWorkflowAndRestrictsFromItsCache()
    {
        // Deleting a workflow takes its junction rows with it; deleting a cache a workflow still
        // names is refused, becoming a 422 rather than silently unbinding a live projection.
        var junction = _db.Model.FindEntityType(typeof(WorkflowCaches))!;

        var toWorkflow = junction.GetForeignKeys()
            .Single(f => f.Properties.Any(p => p.Name == nameof(WorkflowCaches.WorkflowId)));
        var toCache = junction.GetForeignKeys()
            .Single(f => f.Properties.Any(p => p.Name == nameof(WorkflowCaches.CacheId)));

        Assert.Equal(DeleteBehavior.Cascade, toWorkflow.DeleteBehavior);
        Assert.Equal(DeleteBehavior.Restrict, toCache.DeleteBehavior);
    }

    [Fact]
    public void TheJunctionIsNotAnAuditedEntity()
    {
        // Deriving from BaseEntity would pull it into the xmin shadow-token loop in
        // BaseDbContext.OnModelCreating, which is for audited domain rows only.
        Assert.False(typeof(BaseApi.Core.Entities.BaseEntity)
            .IsAssignableFrom(typeof(WorkflowCaches)));
    }

    [Fact]
    public void DuplicateCacheIdsAreRefusedByTheValidator()
    {
        var id = Guid.NewGuid();
        var dto = new WorkflowCreateDto("wf", "1.0.0", null, [_entryStep], null, [id, id], null);

        var result = new WorkflowCreateDtoValidator().Validate(dto);

        Assert.False(result.IsValid);
    }

    [Fact]
    public void AnEmptyGuidInCacheIdsIsRefusedByTheValidator()
    {
        var dto = new WorkflowCreateDto(
            "wf", "1.0.0", null, [_entryStep], null, [Guid.Empty], null);

        var result = new WorkflowCreateDtoValidator().Validate(dto);

        Assert.False(result.IsValid);
    }
}
