using BaseApi.Core.Mapping;
using Riok.Mapperly.Abstractions;

namespace BaseApi.Service.Features.Schema;

/// <summary>
/// Source-generated mapper for <see cref="SchemaEntity"/>. That this partial compiles at all, with
/// the Mapperly diagnostics promoted to errors in Directory.Build.props, is itself the drift check:
/// the generator's strict mapping strategy reports both unmapped targets and unmapped sources, so
/// the ignore attributes below are the only sanctioned exceptions. Add a property to the entity
/// without wiring it through the DTOs, or into this ignore list, and the build fails.
/// <para>
/// <see cref="ToRead"/> needs no ignores: the read DTO carries the id and the audit fields, so every
/// entity member has a target.
/// </para>
/// </summary>
[Mapper]
public sealed partial class SchemaEntityMapper :
    IEntityMapper<SchemaEntity, SchemaCreateDto, SchemaUpdateDto, SchemaReadDto>
{
    [MapperIgnoreTarget(nameof(SchemaEntity.Id))]
    [MapperIgnoreTarget(nameof(SchemaEntity.CreatedAt))]
    [MapperIgnoreTarget(nameof(SchemaEntity.UpdatedAt))]
    [MapperIgnoreTarget(nameof(SchemaEntity.CreatedBy))]
    [MapperIgnoreTarget(nameof(SchemaEntity.UpdatedBy))]
    public partial SchemaEntity ToEntity(SchemaCreateDto dto);

    [MapperIgnoreTarget(nameof(SchemaEntity.Id))]
    [MapperIgnoreTarget(nameof(SchemaEntity.CreatedAt))]
    [MapperIgnoreTarget(nameof(SchemaEntity.UpdatedAt))]
    [MapperIgnoreTarget(nameof(SchemaEntity.CreatedBy))]
    [MapperIgnoreTarget(nameof(SchemaEntity.UpdatedBy))]
    public partial void Update(SchemaUpdateDto dto, SchemaEntity target);

    public partial SchemaReadDto ToRead(SchemaEntity entity);
}
