using BaseApi.Core.Exceptions;
using BaseApi.Core.Persistence.Repositories;
using BaseApi.Service;
using BaseApi.Service.Features.Cache;
using FluentValidation;
using Messaging.Contracts;
using Messaging.Transport;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace BaseApi.Tests.Cache;

/// <summary>
/// <c>PUT /caches/{id}/items</c>: the items replaced in the row, every other field kept, and the refresh
/// sent only once the row is saved.
/// </summary>
public sealed class CacheItemsUpdateTests : IAsyncLifetime
{
    private readonly Guid _cache = Guid.NewGuid();
    private readonly RecordingSender _sender = new();
    private AppDbContext _db = null!;

    private sealed class RecordingSender : IQueueSender
    {
        public List<(string Queue, string Type, object? Body)> Sent { get; } = [];
        public Exception? Fault { get; set; }

        public Task SendAsync<T>(string queue, string type, T body, CancellationToken ct,
            string? replyTo = null, string? correlationId = null)
        {
            if (Fault is not null) throw Fault;
            Sent.Add((queue, type, body));
            return Task.CompletedTask;
        }
    }

    public async ValueTask InitializeAsync()
    {
        _db = new AppDbContext(new DbContextOptionsBuilder<AppDbContext>()
            .UseInMemoryDatabase($"cache-items-{Guid.NewGuid():N}")
            .Options);

        _db.Set<CacheEntity>().Add(new CacheEntity
        {
            Id = _cache, Name = "artists", Version = "1.0.0", Description = "the whitelist", Root = "artists",
            Items = """{"acme":"Acme"}""",
        });
        await _db.SaveChangesAsync(TestContext.Current.CancellationToken);
        _db.ChangeTracker.Clear();
    }

    public async ValueTask DisposeAsync() => await _db.DisposeAsync();

    private CacheService Service() => new(
        new CacheCreateDtoValidator(), new CacheUpdateDtoValidator(), new CacheItemsUpdateDtoValidator(),
        new CacheEntityMapper(), new Repository<CacheEntity>(_db), _db, _sender);

    private Task<CacheReadDto> UpdateAsync(Guid id, Dictionary<string, string> items) =>
        Service().UpdateItemsAsync(id, new CacheItemsUpdateDto(items), TestContext.Current.CancellationToken);

    private async Task<CacheEntity> RowAsync()
    {
        _db.ChangeTracker.Clear();
        return await _db.Set<CacheEntity>().SingleAsync(c => c.Id == _cache, TestContext.Current.CancellationToken);
    }

    [Fact]
    public async Task TheItemsAreReplacedInTheRow()
    {
        await UpdateAsync(_cache, new() { ["beta"] = "Beta" });

        Assert.Equal("""{"beta":"Beta"}""", (await RowAsync()).Items);
    }

    [Fact]
    public async Task EveryOtherFieldIsKept()
    {
        await UpdateAsync(_cache, new() { ["beta"] = "Beta" });

        var row = await RowAsync();
        Assert.Equal(("artists", "1.0.0", "the whitelist", "artists"), (row.Name, row.Version, row.Description, row.Root));
    }

    [Fact]
    public async Task TheReadDtoCarriesTheNewItems()
    {
        var read = await UpdateAsync(_cache, new() { ["beta"] = "Beta" });

        Assert.Equal("""{"beta":"Beta"}""", read.Items);
    }

    [Fact]
    public async Task OneRefreshIsSentOnTheControlQueue()
    {
        await UpdateAsync(_cache, new() { ["beta"] = "Beta" });

        var sent = Assert.Single(_sender.Sent);
        Assert.Equal(OrchestratorQueues.Control, sent.Queue);
        Assert.Equal(MessageTypes.RefreshCache, sent.Type);
        Assert.Equal(new RefreshCache(_cache), sent.Body);
    }

    [Fact]
    public async Task EmptyItemsAreAllowed()
    {
        // "Allow nothing" is a whitelist too.
        await UpdateAsync(_cache, new());

        Assert.Equal("{}", (await RowAsync()).Items);
    }

    [Fact]
    public async Task AnUnknownCacheIsNotFoundAndSendsNothing()
    {
        await Assert.ThrowsAsync<NotFoundException>(() => UpdateAsync(Guid.NewGuid(), new() { ["beta"] = "Beta" }));

        Assert.Empty(_sender.Sent);
    }

    [Fact]
    public async Task AKeyWithAColonIsRefusedAndSendsNothing()
    {
        await Assert.ThrowsAsync<ValidationException>(() => UpdateAsync(_cache, new() { ["a:b"] = "x" }));

        Assert.Equal("""{"acme":"Acme"}""", (await RowAsync()).Items);
        Assert.Empty(_sender.Sent);
    }

    [Fact]
    public async Task NoItemsAtAllIsRefused()
    {
        await Assert.ThrowsAsync<ValidationException>(() =>
            Service().UpdateItemsAsync(_cache, new CacheItemsUpdateDto(null!), TestContext.Current.CancellationToken));

        Assert.Empty(_sender.Sent);
    }

    [Fact]
    public async Task ASendFaultIsTaggedAfterTheRowIsSaved()
    {
        _sender.Fault = new InvalidOperationException("broker down");

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => UpdateAsync(_cache, new() { ["beta"] = "Beta" }));

        Assert.Equal("SendRefreshCache", ex.Data["brokerOp"]);
        Assert.Equal("""{"beta":"Beta"}""", (await RowAsync()).Items);
    }
}
