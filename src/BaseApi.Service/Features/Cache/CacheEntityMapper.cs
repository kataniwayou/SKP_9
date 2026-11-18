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
    [MapperIgnoreTarget(nameof(CacheEntity.BoardX))]
    [MapperIgnoreTarget(nameof(CacheEntity.BoardY))]
    [MapperIgnoreSource(nameof(CacheUpdateDto.BoardX))]
    [MapperIgnoreSource(nameof(CacheUpdateDto.BoardY))]
    private partial void UpdateFields(CacheUpdateDto dto, CacheEntity target);

    /// <summary>
    /// The generated field copy, then the location: BoardX and BoardY are each written only when the DTO
    /// carries them, so a caller that does not know locations (a design save, Valence) never erases them.
    /// </summary>
    public void Update(CacheUpdateDto dto, CacheEntity target)
    {
        UpdateFields(dto, target);
        if (dto.BoardX is { } x) target.BoardX = x;
        if (dto.BoardY is { } y) target.BoardY = y;
    }

    public partial CacheReadDto ToRead(CacheEntity entity);
}
