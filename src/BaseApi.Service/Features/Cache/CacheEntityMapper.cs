using BaseApi.Core.Mapping;
using Riok.Mapperly.Abstractions;

namespace BaseApi.Service.Features.Cache;

/// <summary>
/// Maps between <see cref="CacheEntity"/> and its DTOs. The five server-controlled targets are
/// ignored on both write directions: the audit interceptor owns them, and a mapper that could write
/// them would let a caller forge an id or an audit stamp.
/// </summary>
[Mapper]
public sealed partial class CacheEntityMapper :
    IEntityMapper<CacheEntity, CacheCreateDto, CacheUpdateDto, CacheReadDto>
{
    [MapperIgnoreTarget(nameof(CacheEntity.Id))]
    [MapperIgnoreTarget(nameof(CacheEntity.CreatedAt))]
    [MapperIgnoreTarget(nameof(CacheEntity.UpdatedAt))]
    [MapperIgnoreTarget(nameof(CacheEntity.CreatedBy))]
    [MapperIgnoreTarget(nameof(CacheEntity.UpdatedBy))]
    public partial CacheEntity ToEntity(CacheCreateDto dto);

    [MapperIgnoreTarget(nameof(CacheEntity.Id))]
    [MapperIgnoreTarget(nameof(CacheEntity.CreatedAt))]
    [MapperIgnoreTarget(nameof(CacheEntity.UpdatedAt))]
    [MapperIgnoreTarget(nameof(CacheEntity.CreatedBy))]
    [MapperIgnoreTarget(nameof(CacheEntity.UpdatedBy))]
    public partial void Update(CacheUpdateDto dto, CacheEntity target);

    public partial CacheReadDto ToRead(CacheEntity entity);
}
