using BaseApi.Core.Persistence.Repositories;
using BaseApi.Service;
using BaseApi.Service.Features.Cache;
using Messaging.Transport;
using Microsoft.AspNetCore.Http;

namespace BaseApi.Tests.Support;

/// <summary>A <see cref="CacheService"/> over a context and a sender, built the way the container builds it.</summary>
internal static class CacheServiceFactory
{
    public static CacheService Create(AppDbContext db, IQueueSender sender) => new(
        new CacheCreateDtoValidator(), new CacheUpdateDtoValidator(), new CacheItemsUpdateDtoValidator(),
        new CacheItemsAppendDtoValidator(), new CacheItemsRemoveDtoValidator(),
        new CacheEntityMapper(), new Repository<CacheEntity>(db), db,
        new CacheItemsStore(db, TimeProvider.System, new HttpContextAccessor()),
        new CacheRefreshSender(sender));
}
