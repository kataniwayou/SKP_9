using BaseApi.Core.Exceptions;
using BaseApi.Core.Mapping;
using BaseApi.Core.Persistence;
using BaseApi.Core.Persistence.Repositories;
using BaseApi.Core.Services;
using FluentValidation;
using Messaging.Contracts;
using Messaging.Transport;
using Microsoft.EntityFrameworkCore;

namespace BaseApi.Service.Features.Cache;

/// <summary>
/// The cache's service. The five CRUD verbs are the base class's; the one collection it syncs is the
/// cache's items are not part of them (they have their own verbs). It adds one verb of its own,
/// <see cref="UpdateItemsAsync"/>.
/// </summary>
public sealed class CacheService :
    BaseService<CacheEntity, CacheCreateDto, CacheUpdateDto, CacheReadDto>
{
    private readonly IValidator<CacheItemsUpdateDto> _itemsValidator;
    private readonly IQueueSender _sender;
    private readonly IEntityMapper<CacheEntity, CacheCreateDto, CacheUpdateDto, CacheReadDto> _cacheMapper;

    public CacheService(
        IValidator<CacheCreateDto> createValidator,
        IValidator<CacheUpdateDto> updateValidator,
        IValidator<CacheItemsUpdateDto> itemsValidator,
        IEntityMapper<CacheEntity, CacheCreateDto, CacheUpdateDto, CacheReadDto> mapper,
        IRepository<CacheEntity> repo,
        BaseDbContext dbContext,
        IQueueSender sender)
        : base(createValidator, updateValidator, mapper, repo, dbContext)
    {
        _itemsValidator = itemsValidator ?? throw new ArgumentNullException(nameof(itemsValidator));
        _sender         = sender ?? throw new ArgumentNullException(nameof(sender));
        _cacheMapper    = mapper;
    }

    /// <summary>
    /// Replaces the row's items, keeps every other field, and sends a refresh so the running workflows
    /// that projected this cache read the new items without a start.
    /// <para>
    /// <b>The send follows the save.</b> The refresh handler reads the row, so a message that could
    /// overtake the commit would project the items it replaced. The store is written a moment after this
    /// returns: the request answers for the row, the queue for L2.
    /// </para>
    /// <para>
    /// A send that fails leaves the row saved and the store as it was; the 500 names a stable operation,
    /// and the same request sent again re-sends, since the refresh applies an end state.
    /// </para>
    /// </summary>
    public async Task<CacheReadDto> UpdateItemsAsync(Guid id, CacheItemsUpdateDto dto, CancellationToken ct)
    {
        await _itemsValidator.ValidateAndThrowAsync(dto, ct);

        // The items are not auto-included, so the replace loads them itself. Task 4 of the append plan
        // replaces this with a set-based write.
        var row = await DbContext.Set<CacheEntity>().Include(c => c.Items)
            .FirstOrDefaultAsync(c => c.Id == id, ct)
            ?? throw new NotFoundException(nameof(CacheEntity), id);

        CacheItems.Apply(DbContext, row, dto.Items);
        row.ItemCount = row.Items.Count;
        await DbContext.SaveChangesAsync(ct);

        var updated = _cacheMapper.ToRead(row);

        try
        {
            await _sender.SendAsync(OrchestratorQueues.Control, MessageTypes.RefreshCache, new RefreshCache(id), ct);
        }
        catch (Exception ex)
        {
            ex.Data["brokerOp"] = "SendRefreshCache";
            throw;
        }

        return updated;
    }
}
