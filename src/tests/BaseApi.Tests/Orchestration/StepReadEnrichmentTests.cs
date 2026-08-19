using BaseApi.Service;
using BaseApi.Service.Features.Step;
using BaseApi.Core.Persistence.Repositories;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace BaseApi.Tests.Orchestration;

/// <summary>
/// The read path must return the next-step collection. It lives in a junction table rather than on
/// the entity, so the mapper cannot supply it and hard-codes null; without an enrichment step every
/// read reports a step as having no successors, and a client that reads-then-writes destroys the
/// edges it just failed to see.
/// </summary>
public sealed class StepReadEnrichmentTests : IAsyncLifetime
{
    private AppDbContext _db = null!;
    private StepService _service = null!;
    private Guid _a, _b, _c;

    public async ValueTask InitializeAsync()
    {
        _db = new AppDbContext(new DbContextOptionsBuilder<AppDbContext>()
            .UseInMemoryDatabase($"step-enrichment-{Guid.NewGuid():N}")
            .Options);

        _service = new StepService(
            new StepCreateDtoValidator(),
            new StepUpdateDtoValidator(),
            new StepEntityMapper(),
            new Repository<StepEntity>(_db),
            _db);

        // A -> B, A -> C: a fan-out, so the assertion cannot pass by accident on a single-element list.
        _c = await CreateAsync("step-C", null);
        _b = await CreateAsync("step-B", null);
        _a = await CreateAsync("step-A", [_b, _c]);
    }

    public async ValueTask DisposeAsync() => await _db.DisposeAsync();

    private async Task<Guid> CreateAsync(string name, List<Guid>? next)
    {
        var dto = new StepCreateDto(name, "1.0.0", null, Guid.NewGuid(), next, StepEntryCondition.Always);
        return (await _service.CreateAsync(dto, TestContext.Current.CancellationToken)).Id;
    }

    [Fact]
    public async Task GetByIdReturnsTheSuccessors()
    {
        var read = await _service.GetByIdAsync(_a, TestContext.Current.CancellationToken);

        Assert.NotNull(read.NextStepIds);
        Assert.Equal([_b, _c], read.NextStepIds!.OrderBy(x => x == _b ? 0 : 1));
    }

    [Fact]
    public async Task GetByIdReturnsAnEmptyListForASink()
    {
        // Empty, not null. Null previously meant "not populated"; now the field always means what it
        // says, so a caller can tell a sink from an unread collection.
        var read = await _service.GetByIdAsync(_c, TestContext.Current.CancellationToken);

        Assert.NotNull(read.NextStepIds);
        Assert.Empty(read.NextStepIds!);
    }

    [Fact]
    public async Task ListReturnsSuccessorsForEveryStep()
    {
        var all = await _service.ListAsync(TestContext.Current.CancellationToken);

        Assert.Equal(3, all.Count);
        Assert.Equal(2, all.Single(s => s.Id == _a).NextStepIds!.Count);
        Assert.Empty(all.Single(s => s.Id == _b).NextStepIds!);
    }

    [Fact]
    public async Task CreateEchoesBackWhatWasPersisted()
    {
        // The response to a POST that supplied a collection must not report it as absent — that reads
        // as the input having been dropped, and invites a retry that duplicates the row.
        var created = await _service.CreateAsync(
            new StepCreateDto("step-D", "1.0.0", null, Guid.NewGuid(), [_b], StepEntryCondition.Always),
            TestContext.Current.CancellationToken);

        Assert.Equal([_b], created.NextStepIds!);
    }

    [Fact]
    public async Task UpdateReflectsTheReplacedCollection()
    {
        // Update is remove-and-replace, so the response has to show the new set rather than the old.
        var updated = await _service.UpdateAsync(
            _a,
            new StepUpdateDto("step-A", "1.0.0", null, Guid.NewGuid(), [_c], StepEntryCondition.Always),
            TestContext.Current.CancellationToken);

        Assert.Equal([_c], updated.NextStepIds!);
    }

    [Fact]
    public async Task AReadFedStraightBackIntoAnUpdatePreservesTheEdges()
    {
        // The regression this whole change exists to prevent: read-modify-write. When the read said
        // null, echoing it into a PUT silently deleted every edge and returned 200.
        var read = await _service.GetByIdAsync(_a, TestContext.Current.CancellationToken);

        await _service.UpdateAsync(
            _a,
            new StepUpdateDto(read.Name, read.Version, read.Description, read.ProcessorId,
                              read.NextStepIds, read.EntryCondition),
            TestContext.Current.CancellationToken);

        var after = await _service.GetByIdAsync(_a, TestContext.Current.CancellationToken);
        Assert.Equal(2, after.NextStepIds!.Count);
    }
}
