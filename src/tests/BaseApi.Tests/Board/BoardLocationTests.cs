using BaseApi.Core.DependencyInjection;
using BaseApi.Core.Persistence.Repositories;
using BaseApi.Service;
using BaseApi.Service.Features.Cache;
using BaseApi.Service.Features.Molecule;
using BaseApi.Service.Features.Step;
using BaseApi.Service.Features.Workflow;
using Messaging.Transport;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Metadata;
using Microsoft.EntityFrameworkCore.Migrations;
using Microsoft.Extensions.DependencyInjection;
using NSubstitute;
using Xunit;

namespace BaseApi.Tests.Board;

/// <summary>
/// Steps, caches and workflows carry an optional board location (BoardX, BoardY). A create stores it, an update that
/// carries one moves it, and an update that carries none keeps the stored one — so a caller that does not know locations
/// (WorkflowStudio's design save, Valence) never erases what Acto saved. X and Y are treated independently.
/// </summary>
public sealed class BoardLocationTests : IAsyncLifetime
{
    private AppDbContext _db = null!;
    private StepService _steps = null!;
    private CacheService _caches = null!;
    private WorkflowService _workflows = null!;
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    public ValueTask InitializeAsync()
    {
        _db = new AppDbContext(new DbContextOptionsBuilder<AppDbContext>()
            .UseInMemoryDatabase($"board-locations-{Guid.NewGuid():N}").Options);
        _steps = new StepService(new StepCreateDtoValidator(), new StepUpdateDtoValidator(),
            new StepEntityMapper(), new Repository<StepEntity>(_db), _db);
        _caches = new CacheService(new CacheCreateDtoValidator(), new CacheUpdateDtoValidator(),
            new CacheItemsUpdateDtoValidator(), new CacheEntityMapper(), new Repository<CacheEntity>(_db), _db,
            Substitute.For<IQueueSender>());
        _workflows = new WorkflowService(new WorkflowCreateDtoValidator(), new WorkflowUpdateDtoValidator(),
            new WorkflowEntityMapper(), new Repository<WorkflowEntity>(_db), _db);
        return ValueTask.CompletedTask;
    }

    public async ValueTask DisposeAsync() => await _db.DisposeAsync();

    [Fact]
    public async Task AStepKeepsTheLocationItWasCreatedWith()
    {
        var created = await _steps.CreateAsync(
            new StepCreateDto("s", "1.0.0", null, Guid.NewGuid(), null, StepEntryCondition.Always, 120.5, -40), Ct);

        var read = await _steps.GetByIdAsync(created.Id, Ct);
        Assert.Equal(120.5, read.BoardX);
        Assert.Equal(-40, read.BoardY);
    }

    [Fact]
    public async Task AnUpdateWithALocationMovesIt()
    {
        var id = (await _steps.CreateAsync(StepDto(120.5, -40), Ct)).Id;

        await _steps.UpdateAsync(id, StepUpdate(300, 10), Ct);

        var read = await _steps.GetByIdAsync(id, Ct);
        Assert.Equal(300, read.BoardX);
        Assert.Equal(10, read.BoardY);
    }

    [Fact]
    public async Task AnUpdateWithoutALocationKeepsIt()
    {
        var id = (await _steps.CreateAsync(StepDto(300, 10), Ct)).Id;

        await _steps.UpdateAsync(id, StepUpdate(null, null), Ct);

        var read = await _steps.GetByIdAsync(id, Ct);
        Assert.Equal(300, read.BoardX);
        Assert.Equal(10, read.BoardY);
    }

    [Fact]
    public async Task AnUpdateWithOneCoordinateMovesOnlyThatOne()
    {
        var id = (await _steps.CreateAsync(StepDto(300, 10), Ct)).Id;

        await _steps.UpdateAsync(id, StepUpdate(null, 99), Ct);

        var read = await _steps.GetByIdAsync(id, Ct);
        Assert.Equal(300, read.BoardX);
        Assert.Equal(99, read.BoardY);
    }

    [Fact]
    public async Task AStepNeverPlacedReadsNull()
    {
        var created = await _steps.CreateAsync(StepDto(null, null), Ct);

        var read = await _steps.GetByIdAsync(created.Id, Ct);
        Assert.Null(read.BoardX);
        Assert.Null(read.BoardY);
    }

    [Fact]
    public async Task CachesAndWorkflowsCarryLocationsTheSameWay()
    {
        var cache = await _caches.CreateAsync(new CacheCreateDto("c", "1.0.0", null, "sk-c", "{}", 120.5, -40), Ct);
        Assert.Equal((120.5, -40.0), Pair(await _caches.GetByIdAsync(cache.Id, Ct)));
        await _caches.UpdateAsync(cache.Id, new CacheUpdateDto("c", "1.0.0", null, "sk-c", "{}", 300, 10), Ct);
        Assert.Equal((300.0, 10.0), Pair(await _caches.GetByIdAsync(cache.Id, Ct)));
        await _caches.UpdateAsync(cache.Id, new CacheUpdateDto("c", "1.0.0", null, "sk-c", "{}"), Ct);
        Assert.Equal((300.0, 10.0), Pair(await _caches.GetByIdAsync(cache.Id, Ct)));
        // The items-only edit builds its update without a location and must not erase it either.
        await _caches.UpdateItemsAsync(cache.Id, new CacheItemsUpdateDto(new Dictionary<string, string> { ["k"] = "v" }), Ct);
        Assert.Equal((300.0, 10.0), Pair(await _caches.GetByIdAsync(cache.Id, Ct)));

        var entry = Guid.NewGuid();
        var wf = await _workflows.CreateAsync(
            new WorkflowCreateDto("w", "1.0.0", null, [entry], null, null, null, 120.5, -40), Ct);
        Assert.Equal((120.5, -40.0), Pair(await _workflows.GetByIdAsync(wf.Id, Ct)));
        await _workflows.UpdateAsync(wf.Id, new WorkflowUpdateDto("w", "1.0.0", null, [entry], null, null, null, 300, 10), Ct);
        Assert.Equal((300.0, 10.0), Pair(await _workflows.GetByIdAsync(wf.Id, Ct)));
        await _workflows.UpdateAsync(wf.Id, new WorkflowUpdateDto("w", "1.0.0", null, [entry], null, null, null), Ct);
        Assert.Equal((300.0, 10.0), Pair(await _workflows.GetByIdAsync(wf.Id, Ct)));
    }

    [Fact]
    public void ModelFieldsDescribesTheLocationOfAllThreeTablesAsOptionalNumbers()
    {
        using var sp = new ServiceCollection().AddBaseApiValidation(typeof(AppDbContext).Assembly).BuildServiceProvider();
        using var scope = sp.CreateScope();
        using var db = Molecule.ModelRelationsTests.NpgsqlModelContext();
        var dto = ModelFields.Build(db.Model, scope.ServiceProvider).Dto;

        foreach (var table in new[] { "steps", "caches", "workflows" })
        foreach (var name in new[] { "boardX", "boardY" })
        {
            var f = dto.Entities.Single(e => e.Table == table).Fields.Single(x => x.Field == name);
            Assert.Equal("number", f.Type);
            Assert.True(f.Nullable);
            Assert.Equal(name == "boardX" ? "board_x" : "board_y", f.Column);
            Assert.Equal("double precision", f.StoreType);
        }
    }

    [Fact]
    public void TheMigrationSnapshotMatchesTheModel()
    {
        // Migrations are written by hand on this machine (no dotnet-ef); this fails when the snapshot and the
        // model disagree, e.g. a column the model has and no migration adds.
        using var db = Molecule.ModelRelationsTests.NpgsqlModelContext();
        var snapshot = db.GetService<IMigrationsAssembly>().ModelSnapshot!.Model;
        var designTime = db.GetService<IDesignTimeModel>().Model;
        var differ = db.GetService<IMigrationsModelDiffer>();
        var relational = db.GetService<IModelRuntimeInitializer>().Initialize(snapshot, designTime: true, validationLogger: null);

        Assert.Empty(differ.GetDifferences(relational.GetRelationalModel(), designTime.GetRelationalModel()));
    }

    private static (double?, double?) Pair(CacheReadDto r) => (r.BoardX, r.BoardY);
    private static (double?, double?) Pair(WorkflowReadDto r) => (r.BoardX, r.BoardY);

    private static StepCreateDto StepDto(double? x, double? y) =>
        new("s", "1.0.0", null, Guid.NewGuid(), null, StepEntryCondition.Always, x, y);

    private static StepUpdateDto StepUpdate(double? x, double? y) =>
        new("s", "1.0.0", null, Guid.NewGuid(), null, StepEntryCondition.Always, x, y);
}
