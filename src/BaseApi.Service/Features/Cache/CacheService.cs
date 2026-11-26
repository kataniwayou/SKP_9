using BaseApi.Core.Exceptions;
using BaseApi.Core.Mapping;
using BaseApi.Core.Persistence;
using BaseApi.Core.Persistence.Repositories;
using BaseApi.Core.Services;
using FluentValidation;
using FluentValidation.Results;
using Microsoft.EntityFrameworkCore;

namespace BaseApi.Service.Features.Cache;

/// <summary>
/// The cache's service. The five CRUD verbs are the base class's; the cache's items are not part of them
/// (they have their own verbs): <see cref="UpdateItemsAsync"/> replaces them, <see cref="AppendItemsAsync"/>
/// and <see cref="RemoveItemsAsync"/> change some of them, <see cref="PageItemsAsync"/> reads them.
/// </summary>
public sealed class CacheService :
    BaseService<CacheEntity, CacheCreateDto, CacheUpdateDto, CacheReadDto>
{
    private readonly IValidator<CacheItemsUpdateDto> _itemsValidator;
    private readonly IValidator<CacheItemsAppendDto> _appendValidator;
    private readonly IValidator<CacheItemsRemoveDto> _removeValidator;
    private readonly CacheItemsStore _store;
    private readonly CacheRefreshSender _refresh;
    private readonly IEntityMapper<CacheEntity, CacheCreateDto, CacheUpdateDto, CacheReadDto> _cacheMapper;

    public CacheService(
        IValidator<CacheCreateDto> createValidator,
        IValidator<CacheUpdateDto> updateValidator,
        IValidator<CacheItemsUpdateDto> itemsValidator,
        IValidator<CacheItemsAppendDto> appendValidator,
        IValidator<CacheItemsRemoveDto> removeValidator,
        IEntityMapper<CacheEntity, CacheCreateDto, CacheUpdateDto, CacheReadDto> mapper,
        IRepository<CacheEntity> repo,
        BaseDbContext dbContext,
        CacheItemsStore store,
        CacheRefreshSender refresh)
        : base(createValidator, updateValidator, mapper, repo, dbContext)
    {
        _itemsValidator  = itemsValidator ?? throw new ArgumentNullException(nameof(itemsValidator));
        _appendValidator = appendValidator ?? throw new ArgumentNullException(nameof(appendValidator));
        _removeValidator = removeValidator ?? throw new ArgumentNullException(nameof(removeValidator));
        _store           = store ?? throw new ArgumentNullException(nameof(store));
        _refresh         = refresh ?? throw new ArgumentNullException(nameof(refresh));
        _cacheMapper     = mapper;
    }

    /// <summary>
    /// Replaces the row's items, keeps every other field, and sends a refresh so the running workflows
    /// that projected this cache read the new items without a start.
    /// <para>
    /// <b>The replace takes the cache row's lock first</b> (<c>SELECT … FOR UPDATE</c>, the first statement
    /// of its transaction), the same lock append and remove take, so a replace and an append serialize on the
    /// row and <c>item_count</c> always equals the rows the cache holds.
    /// </para>
    /// <para>
    /// <b>The send follows the commit.</b> The refresh handler reads the rows, so a message that could
    /// overtake the commit would project the items it replaced. The store is written a moment after this
    /// returns: the request answers for the row, the queue for L2.
    /// </para>
    /// <para>
    /// A send that fails leaves the rows saved and the store as it was; the 500 names a stable operation,
    /// and the same request sent again re-sends, since the refresh applies an end state.
    /// </para>
    /// </summary>
    public async Task<CacheReadDto> UpdateItemsAsync(Guid id, CacheItemsUpdateDto dto, CancellationToken ct)
    {
        await _itemsValidator.ValidateAndThrowAsync(dto, ct);

        var joined = DbContext.Database.CurrentTransaction is not null;
        await using var own = joined ? null : await DbContext.Database.BeginTransactionAsync(ct);

        // The lock first, then the load: what is diffed is what no other writer can change until the commit.
        await DbContext.Database.ExecuteSqlInterpolatedAsync($"SELECT 1 FROM caches WHERE id = {id} FOR UPDATE", ct);
        var row = await DbContext.Set<CacheEntity>().Include(c => c.Items)
            .FirstOrDefaultAsync(c => c.Id == id, ct)
            ?? throw new NotFoundException(nameof(CacheEntity), id);

        CacheItems.Apply(DbContext, row, dto.Items);
        row.ItemCount = row.Items.Count;
        await DbContext.SaveChangesAsync(ct);
        if (own is not null) await own.CommitAsync(ct);

        var updated = _cacheMapper.ToRead(row);

        await _refresh.SendFullAsync(id, ct);
        return updated;
    }

    /// <summary>
    /// Adds the pairs to the cache; a key already stored is overwritten, a key twice in the batch keeps its
    /// last value. The cache's other items are untouched, however many.
    /// <para>
    /// <b><c>Overwritten</c> counts every key that was already stored, including one whose value was
    /// unchanged</b> (such a row is not rewritten, but it is counted and named). The refresh follows the
    /// commit and names each key of the batch once.
    /// </para>
    /// </summary>
    public async Task<CacheAppendReport> AppendItemsAsync(Guid id, CacheItemsAppendDto dto, CancellationToken ct)
    {
        await _appendValidator.ValidateAndThrowAsync(dto, ct);
        var report = await _store.AppendAsync(id, dto.Items, ct);
        await _refresh.SendKeysAsync(id, CacheItemsStore.LastWins(dto.Items).Items.ConvertAll(i => i.Key), ct);
        return report;
    }

    /// <summary>Drops the keys; a key not stored is reported, not an error. The refresh names each requested key once.</summary>
    public async Task<CacheRemoveReport> RemoveItemsAsync(Guid id, CacheItemsRemoveDto dto, CancellationToken ct)
    {
        await _removeValidator.ValidateAndThrowAsync(dto, ct);
        var report = await _store.RemoveAsync(id, dto.Keys, ct);
        await _refresh.SendKeysAsync(id, CacheItemsStore.Distinct(dto.Keys).Keys, ct);
        return report;
    }

    /// <summary>
    /// One page of items ordered by key. <paramref name="limit"/> defaults to <see cref="CacheRules.PageDefault"/>;
    /// outside 1..<see cref="CacheRules.PageMax"/> it is a validation error (400).
    /// </summary>
    public Task<CacheItemsPage> PageItemsAsync(Guid id, string? after, int? limit, CancellationToken ct)
    {
        var n = limit ?? CacheRules.PageDefault;
        if (n < 1 || n > CacheRules.PageMax)
            throw new ValidationException([new ValidationFailure("limit", $"limit must be between 1 and {CacheRules.PageMax}.")]);
        return _store.PageAsync(id, after, n, ct);
    }
}
