using BaseApi.Core.Mapping;
using Riok.Mapperly.Abstractions;

namespace BaseApi.Service.Features.Assignment;

/// <summary>
/// Source-generated mapper for <see cref="AssignmentEntity"/>. That this partial compiles at all, with the
/// Mapperly diagnostics promoted to errors in Directory.Build.props, is itself the drift check: the
/// generator's strict mapping strategy reports both unmapped targets and unmapped sources, so the
/// ignore attributes below are the only sanctioned exceptions. Add a property to the entity without
/// wiring it through the DTOs, or into this ignore list, and the build fails.
/// <para>
/// <see cref="ToRead"/> needs no ignores: the read DTO carries the id and the audit fields, so every
/// entity member has a target.
/// </para>
/// </summary>
[Mapper]
public sealed partial class AssignmentEntityMapper :
    IEntityMapper<AssignmentEntity, AssignmentCreateDto, AssignmentUpdateDto, AssignmentReadDto>
{
    [MapperIgnoreTarget(nameof(AssignmentEntity.Id))]
    [MapperIgnoreTarget(nameof(AssignmentEntity.CreatedAt))]
    [MapperIgnoreTarget(nameof(AssignmentEntity.UpdatedAt))]
    [MapperIgnoreTarget(nameof(AssignmentEntity.CreatedBy))]
    [MapperIgnoreTarget(nameof(AssignmentEntity.UpdatedBy))]
    public partial AssignmentEntity ToEntity(AssignmentCreateDto dto);

    [MapperIgnoreTarget(nameof(AssignmentEntity.Id))]
    [MapperIgnoreTarget(nameof(AssignmentEntity.CreatedAt))]
    [MapperIgnoreTarget(nameof(AssignmentEntity.UpdatedAt))]
    [MapperIgnoreTarget(nameof(AssignmentEntity.CreatedBy))]
    [MapperIgnoreTarget(nameof(AssignmentEntity.UpdatedBy))]
    public partial void Update(AssignmentUpdateDto dto, AssignmentEntity target);

    public partial AssignmentReadDto ToRead(AssignmentEntity entity);
}
