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
    [MapperIgnoreTarget(nameof(CacheEntity.Items))]
    [MapperIgnoreTarget(nameof(CacheEntity.ItemCount))]
    public partial CacheEntity ToEntity(CacheCreateDto dto);

    [MapperIgnoreTarget(nameof(CacheEntity.Id))]
    [MapperIgnoreTarget(nameof(CacheEntity.CreatedAt))]
    [MapperIgnoreTarget(nameof(CacheEntity.UpdatedAt))]
    [MapperIgnoreTarget(nameof(CacheEntity.CreatedBy))]
    [MapperIgnoreTarget(nameof(CacheEntity.UpdatedBy))]
    [MapperIgnoreTarget(nameof(CacheEntity.BoardX))]
    [MapperIgnoreTarget(nameof(CacheEntity.BoardY))]
    [MapperIgnoreTarget(nameof(CacheEntity.Items))]
    [MapperIgnoreTarget(nameof(CacheEntity.ItemCount))]
    [MapperIgnoreSource(nameof(CacheUpdateDto.BoardX))]
    [MapperIgnoreSource(nameof(CacheUpdateDto.BoardY))]
    private partial void UpdateFields(CacheUpdateDto dto, CacheEntity target);

    /// <summary>
    /// The generated field copy, then the location: BoardX and BoardY are each written only when the DTO
    /// carries them, so a caller that does not know locations (a design save, Valence) never erases them.
    /// The items and their count are not on the DTO and are never touched here.
    /// </summary>
    public void Update(CacheUpdateDto dto, CacheEntity target)
    {
        UpdateFields(dto, target);
        if (dto.BoardX is { } x) target.BoardX = x;
        if (dto.BoardY is { } y) target.BoardY = y;
    }

    [MapperIgnoreSource(nameof(CacheEntity.Items))]
    public partial CacheReadDto ToRead(CacheEntity entity);
}
