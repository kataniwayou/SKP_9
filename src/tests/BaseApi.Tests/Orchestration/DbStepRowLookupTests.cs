using BaseApi.Core.Persistence.Repositories;
using BaseApi.Service;
using BaseApi.Service.Features.Orchestration.Projection;
using BaseApi.Service.Features.Step;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace BaseApi.Tests.Orchestration;

/// <summary>
/// The database side of start alignment: which of the steps a start dropped still have a row. Against
/// the real <see cref="AppDbContext"/>, so the query the writer relies on is the one that ships.
/// </summary>
public sealed class DbStepRowLookupTests : IAsyncLifetime
{
    private AppDbContext _db = null!;
    private StepService _steps = null!;

    public ValueTask InitializeAsync()
    {
        _db = new AppDbContext(new DbContextOptionsBuilder<AppDbContext>()
            .UseInMemoryDatabase($"step-row-lookup-{Guid.NewGuid():N}")
            .Options);

        _steps = new StepService(
            new StepCreateDtoValidator(),
            new StepUpdateDtoValidator(),
            new StepEntityMapper(),
            new Repository<StepEntity>(_db),
            _db);

        return ValueTask.CompletedTask;
    }

    public async ValueTask DisposeAsync() => await _db.DisposeAsync();

    private async Task<Guid> CreateStepAsync(string name) =>
        (await _steps.CreateAsync(
            new StepCreateDto(name, "1.0.0", null, Guid.NewGuid(), null, StepEntryCondition.Always),
            TestContext.Current.CancellationToken)).Id;

    [Fact]
    public async Task ReturnsOnlyTheIdsThatStillHaveARow()
    {
        var kept = await CreateStepAsync("kept");
        var deleted = await CreateStepAsync("deleted");
        await _steps.DeleteAsync(deleted, TestContext.Current.CancellationToken);
        var neverExisted = Guid.NewGuid();

        var found = await new DbStepRowLookup(_db)
            .ExistingAsync([kept, deleted, neverExisted], TestContext.Current.CancellationToken);

        Assert.Equal([kept], found);
    }

    [Fact]
    public async Task AnEmptyAskReturnsAnEmptySet()
    {
        var found = await new DbStepRowLookup(_db).ExistingAsync([], TestContext.Current.CancellationToken);

        Assert.Empty(found);
    }
}
