using BaseApi.Core.Mapping;
using Riok.Mapperly.Abstractions;

namespace BaseApi.Service.Features.Processor;

/// <summary>
/// Source-generated mapper for <see cref="ProcessorEntity"/>. That this partial compiles at all, with the
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
public sealed partial class ProcessorEntityMapper :
    IEntityMapper<ProcessorEntity, ProcessorCreateDto, ProcessorUpdateDto, ProcessorReadDto>
{
    [MapperIgnoreTarget(nameof(ProcessorEntity.Id))]
    [MapperIgnoreTarget(nameof(ProcessorEntity.CreatedAt))]
    [MapperIgnoreTarget(nameof(ProcessorEntity.UpdatedAt))]
    [MapperIgnoreTarget(nameof(ProcessorEntity.CreatedBy))]
    [MapperIgnoreTarget(nameof(ProcessorEntity.UpdatedBy))]
    public partial ProcessorEntity ToEntity(ProcessorCreateDto dto);

    [MapperIgnoreTarget(nameof(ProcessorEntity.Id))]
    [MapperIgnoreTarget(nameof(ProcessorEntity.CreatedAt))]
    [MapperIgnoreTarget(nameof(ProcessorEntity.UpdatedAt))]
    [MapperIgnoreTarget(nameof(ProcessorEntity.CreatedBy))]
    [MapperIgnoreTarget(nameof(ProcessorEntity.UpdatedBy))]
    public partial void Update(ProcessorUpdateDto dto, ProcessorEntity target);

    public partial ProcessorReadDto ToRead(ProcessorEntity entity);
}
