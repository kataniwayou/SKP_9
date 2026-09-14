using BaseApi.Core.Mapping;
using BaseApi.Core.Persistence;
using BaseApi.Core.Persistence.Repositories;
using BaseApi.Core.Services;
using FluentValidation;

namespace BaseApi.Service.Features.Cache;

/// <summary>
/// The cache's service. It overrides nothing: there are no junctions to synchronize from this side
/// and no collection to enrich on read, so the base class's behaviour is the whole behaviour.
/// </summary>
public sealed class CacheService :
    BaseService<CacheEntity, CacheCreateDto, CacheUpdateDto, CacheReadDto>
{
    public CacheService(
        IValidator<CacheCreateDto> createValidator,
        IValidator<CacheUpdateDto> updateValidator,
        IEntityMapper<CacheEntity, CacheCreateDto, CacheUpdateDto, CacheReadDto> mapper,
        IRepository<CacheEntity> repo,
        BaseDbContext dbContext)
        : base(createValidator, updateValidator, mapper, repo, dbContext) { }
}
