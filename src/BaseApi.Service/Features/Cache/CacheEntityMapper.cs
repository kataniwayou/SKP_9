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
    [MapperIgnoreSource(nameof(CacheCreateDto.Items))]
    private partial CacheEntity ToEntityFields(CacheCreateDto dto);

    /// <summary>The generated field copy, then one item row per pair: a new cache has no rows to diff against.</summary>
    public CacheEntity ToEntity(CacheCreateDto dto)
    {
        var entity = ToEntityFields(dto);
        entity.Items = dto.Items.Select(i => new CacheItem { Key = i.Key, Value = i.Value }).ToList();
        return entity;
    }

    [MapperIgnoreTarget(nameof(CacheEntity.Id))]
    [MapperIgnoreTarget(nameof(CacheEntity.CreatedAt))]
    [MapperIgnoreTarget(nameof(CacheEntity.UpdatedAt))]
    [MapperIgnoreTarget(nameof(CacheEntity.CreatedBy))]
    [MapperIgnoreTarget(nameof(CacheEntity.UpdatedBy))]
    [MapperIgnoreTarget(nameof(CacheEntity.BoardX))]
    [MapperIgnoreTarget(nameof(CacheEntity.BoardY))]
    [MapperIgnoreTarget(nameof(CacheEntity.Items))]
    [MapperIgnoreSource(nameof(CacheUpdateDto.BoardX))]
    [MapperIgnoreSource(nameof(CacheUpdateDto.BoardY))]
    [MapperIgnoreSource(nameof(CacheUpdateDto.Items))]
    private partial void UpdateFields(CacheUpdateDto dto, CacheEntity target);

    /// <summary>
    /// The generated field copy, then the location: BoardX and BoardY are each written only when the DTO
    /// carries them, so a caller that does not know locations (a design save, Valence) never erases them.
    /// <para>
    /// <b>The items are not touched here.</b> Replacing them needs the context (a diff against the tracked rows,
    /// and the cache marked Modified when only they changed), so every update path calls
    /// <see cref="CacheItems.Apply"/> after this.
    /// </para>
    /// </summary>
    public void Update(CacheUpdateDto dto, CacheEntity target)
    {
        UpdateFields(dto, target);
        if (dto.BoardX is { } x) target.BoardX = x;
        if (dto.BoardY is { } y) target.BoardY = y;
    }

    public partial CacheReadDto ToRead(CacheEntity entity);

    /// <summary>How <see cref="ToRead"/> maps the item rows (Mapperly picks it by type): as pairs ordered by key.</summary>
    private static List<CacheItemDto> ItemsToRead(List<CacheItem> rows) => CacheItems.ToDtos(rows);
}
