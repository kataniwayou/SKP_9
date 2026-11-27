using BaseApi.Core.Exceptions;
using BaseApi.Service;
using BaseApi.Service.Features.Cache;
using BaseApi.Tests.Support;
using FluentValidation;
using Messaging.Contracts;
using Messaging.Transport;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace BaseApi.Tests.Cache;

/// <summary>
/// The append, remove and paged-read verbs of <see cref="CacheService"/> (what the controller's routes call),
/// the full replace, and the delete and list paths that must not touch the item rows. Postgres.
/// </summary>
[Collection("Postgres")]
public sealed class CacheItemsEndpointsTests(PostgresFixture fixture)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private sealed class RecordingSender : IQueueSender
    {
        public List<(string Queue, string Type, object? Body)> Sent { get; } = [];

        public Task SendAsync<T>(string queue, string type, T body, CancellationToken ct,
            string? replyTo = null, string? correlationId = null)
        {
            Sent.Add((queue, type, body));
            return Task.CompletedTask;
        }
    }

    private static List<CacheItemDto> Many(int n, string prefix = "k") =>
        Enumerable.Range(0, n).Select(i => new CacheItemDto($"{prefix}{i:D6}", "v")).ToList();

    private async Task<Guid> NewCacheAsync()
    {
        PostgresFixture.SkipUnlessEnabled();
        await using var db = fixture.NewContext();
        var cache = new CacheEntity { Name = "c", Version = "1.0.0", Root = $"r-{Guid.NewGuid():N}" };
        db.Set<CacheEntity>().Add(cache);
        await db.SaveChangesAsync(Ct);
        return cache.Id;
    }

    [Fact]
    public async Task AppendEndpointReturnsReportAndSendsKeyRefresh()
    {
        var id = await NewCacheAsync();
        var sender = new RecordingSender();
        await using var db = fixture.NewContext();
        var service = CacheServiceFactory.Create(db, sender);

        var report = await service.AppendItemsAsync(id,
            new CacheItemsAppendDto([new("a", "1"), new("b", "2"), new("a", "3")]), Ct);

        Assert.Equal(2, report.Added);
        Assert.Equal(1, report.RepeatedInBatch);
        var sent = Assert.Single(sender.Sent);
        Assert.Equal(OrchestratorQueues.Control, sent.Queue);
        Assert.Equal(MessageTypes.RefreshCacheItems, sent.Type);
        var body = Assert.IsType<RefreshCacheItems>(sent.Body);
        Assert.Equal(id, body.CacheId);
        Assert.Equal(["a", "b"], body.Keys);
    }

    [Fact]
    public async Task AppendOf25000KeysSendsThreeRefreshMessages()
    {
        var id = await NewCacheAsync();
        var sender = new RecordingSender();
        await using var db = fixture.NewContext();

        await CacheServiceFactory.Create(db, sender).AppendItemsAsync(id, new CacheItemsAppendDto(Many(25_000)), Ct);

        Assert.Equal(3, sender.Sent.Count);
        Assert.All(sender.Sent, s => Assert.Equal(MessageTypes.RefreshCacheItems, s.Type));
        Assert.Equal([10_000, 10_000, 5_000], sender.Sent.Select(s => ((RefreshCacheItems)s.Body!).Keys.Count).ToArray());
        Assert.Equal(25_000, sender.Sent.SelectMany(s => ((RefreshCacheItems)s.Body!).Keys).Distinct().Count());
    }

    [Fact]
    public async Task RemoveEndpointSendsKeyRefresh()
    {
        var id = await NewCacheAsync();
        var sender = new RecordingSender();
        await using var db = fixture.NewContext();
        var service = CacheServiceFactory.Create(db, sender);
        await service.AppendItemsAsync(id, new CacheItemsAppendDto([new("a", "1"), new("b", "2")]), Ct);
        sender.Sent.Clear();

        var report = await service.RemoveItemsAsync(id, new CacheItemsRemoveDto(["a", "missing"]), Ct);

        Assert.Equal(1, report.Removed);
        Assert.Equal(1, report.NotFound);
        var sent = Assert.Single(sender.Sent);
        Assert.Equal(MessageTypes.RefreshCacheItems, sent.Type);
        Assert.Equal(["a", "missing"], ((RefreshCacheItems)sent.Body!).Keys);
    }

    [Fact]
    public async Task APostToAnUnknownCacheIsNotFoundAndSendsNothing()
    {
        PostgresFixture.SkipUnlessEnabled();
        var sender = new RecordingSender();
        await using var db = fixture.NewContext();

        await Assert.ThrowsAsync<NotFoundException>(() => CacheServiceFactory.Create(db, sender)
            .AppendItemsAsync(Guid.NewGuid(), new CacheItemsAppendDto([new("a", "1")]), Ct));

        Assert.Empty(sender.Sent);
    }

    [Fact]
    public async Task PageEndpointDefaultsTo500()
    {
        var id = await NewCacheAsync();
        await using var db = fixture.NewContext();
        var service = CacheServiceFactory.Create(db, new RecordingSender());
        await service.AppendItemsAsync(id, new CacheItemsAppendDto(Many(600)), Ct);

        var page = await service.PageItemsAsync(id, null, null, null, null, Ct);

        Assert.Equal(500, page.Items.Count);
        Assert.Equal(page.Items[^1].Key, page.Next);
    }

    [Theory]
    [InlineData(5001)]
    [InlineData(0)]
    [InlineData(-1)]
    public async Task PageLimitOutOfRangeIsAValidationError(int limit)
    {
        var id = await NewCacheAsync();
        await using var db = fixture.NewContext();

        await Assert.ThrowsAsync<ValidationException>(() =>
            CacheServiceFactory.Create(db, new RecordingSender()).PageItemsAsync(id, null, null, null, limit, Ct));
    }

    [Fact]
    public async Task PageLimitAtTheMaxIsAllowed()
    {
        var id = await NewCacheAsync();
        await using var db = fixture.NewContext();

        var page = await CacheServiceFactory.Create(db, new RecordingSender()).PageItemsAsync(id, null, null, null, 5000, Ct);

        Assert.Empty(page.Items);
        Assert.Null(page.Next);
    }

    [Fact]
    public async Task PageFromAKeyReportsIndexPrevAndMatch()
    {
        var id = await NewCacheAsync();
        await using var db = fixture.NewContext();
        var service = CacheServiceFactory.Create(db, new RecordingSender());
        await service.AppendItemsAsync(id, new CacheItemsAppendDto(Many(10)), Ct);

        var page = await service.PageItemsAsync(id, null, "k000003", null, 3, Ct);

        Assert.Equal(["k000003", "k000004", "k000005"], page.Items.Select(i => i.Key));
        Assert.Equal(3, page.Index);
        Assert.Equal("k000003", page.Prev);
        Assert.Equal("exact", page.FromMatch);
    }

    [Theory]
    [InlineData("a", "b", null)]
    [InlineData("a", null, "b")]
    [InlineData(null, "a", "b")]
    public async Task MoreThanOneAnchorIsAValidationError(string? after, string? from, string? before)
    {
        var id = await NewCacheAsync();
        await using var db = fixture.NewContext();

        var ex = await Assert.ThrowsAsync<ValidationException>(() =>
            CacheServiceFactory.Create(db, new RecordingSender()).PageItemsAsync(id, after, from, before, null, Ct));

        Assert.Contains("give at most one of after, from, before", ex.Errors.Select(e => e.ErrorMessage));
    }

    [Theory]
    [InlineData("from")]
    [InlineData("before")]
    public async Task AnEmptyAnchorIsAValidationError(string which)
    {
        var id = await NewCacheAsync();
        await using var db = fixture.NewContext();
        var service = CacheServiceFactory.Create(db, new RecordingSender());

        var ex = await Assert.ThrowsAsync<ValidationException>(() =>
            service.PageItemsAsync(id, null, which == "from" ? "" : null, which == "before" ? "" : null, null, Ct));

        Assert.Contains($"{which} must not be empty", ex.Errors.Select(e => e.ErrorMessage));
    }

    [Fact]
    public async Task ReplaceItemsSetsItemCountAndSendsFullRefresh()
    {
        var id = await NewCacheAsync();
        var sender = new RecordingSender();
        await using var db = fixture.NewContext();
        var service = CacheServiceFactory.Create(db, sender);
        await service.AppendItemsAsync(id, new CacheItemsAppendDto(Many(5)), Ct);
        sender.Sent.Clear();

        var read = await service.UpdateItemsAsync(id, new CacheItemsUpdateDto([new("x", "1"), new("y", "2")]), Ct);

        Assert.Equal(2, read.ItemCount);
        await using var check = fixture.NewContext();
        Assert.Equal(2, await check.Set<CacheEntity>().Where(c => c.Id == id).Select(c => c.ItemCount).SingleAsync(Ct));
        Assert.Equal(2, await check.Set<CacheItem>().CountAsync(i => i.CacheId == id, Ct));
        var sent = Assert.Single(sender.Sent);
        Assert.Equal(MessageTypes.RefreshCache, sent.Type);
        Assert.Equal(new RefreshCache(id), sent.Body);
    }

    [Fact]
    public async Task DeleteCacheWith10000ItemsCascades()
    {
        var id = await NewCacheAsync();
        await using var db = fixture.NewContext();
        var service = CacheServiceFactory.Create(db, new RecordingSender());
        await service.AppendItemsAsync(id, new CacheItemsAppendDto(Many(10_000)), Ct);
        db.ChangeTracker.Clear();

        await service.DeleteAsync(id, Ct);

        Assert.Empty(db.ChangeTracker.Entries<CacheItem>());
        await using var check = fixture.NewContext();
        Assert.Equal(0, await check.Set<CacheItem>().CountAsync(i => i.CacheId == id, Ct));
        Assert.False(await check.Set<CacheEntity>().AnyAsync(c => c.Id == id, Ct));
    }

    [Fact]
    public async Task ListCachesDoesNotReadItemRows()
    {
        var id = await NewCacheAsync();
        await using (var seed = fixture.NewContext())
            await CacheServiceFactory.Create(seed, new RecordingSender())
                .AppendItemsAsync(id, new CacheItemsAppendDto(Many(50)), Ct);

        var log = new List<string>();
        await using var db = new AppDbContext(new DbContextOptionsBuilder<AppDbContext>()
            .UseNpgsql(fixture.ConnectionString)
            .LogTo(log.Add, Microsoft.Extensions.Logging.LogLevel.Information)
            .Options);

        var listed = await CacheServiceFactory.Create(db, new RecordingSender()).ListAsync(Ct);

        Assert.Contains(listed, c => c.Id == id && c.ItemCount == 50);
        Assert.NotEmpty(log);
        Assert.DoesNotContain(log, l => l.Contains("cache_items"));
    }
}
