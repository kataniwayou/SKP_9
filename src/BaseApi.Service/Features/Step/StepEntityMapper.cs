using BaseApi.Core.Mapping;
using Riok.Mapperly.Abstractions;

namespace BaseApi.Service.Features.Step;

/// <summary>
/// Source-generated mapper for <see cref="StepEntity"/>. That this partial compiles, with the
/// Mapperly diagnostics promoted to errors, is itself the drift check.
/// <para>
/// The attribute coverage is asymmetric, because the next-step collection lives on the DTOs but not
/// on the entity:
/// </para>
/// <list type="bullet">
///   <item><see cref="ToEntity"/> and <see cref="Update"/> ignore the five server-side targets, plus
///     the collection on the source — otherwise the generator reports a source member the target
///     has no home for.</item>
///   <item><see cref="ToRead"/> maps the collection to null explicitly. The read DTO is a positional
///     record, so the collection is a required constructor parameter and cannot simply be ignored;
///     mapping a value is what satisfies it. Reads therefore return null and the junction rows stay
///     the source of truth.</item>
/// </list>
/// </summary>
[Mapper]
public sealed partial class StepEntityMapper :
    IEntityMapper<StepEntity, StepCreateDto, StepUpdateDto, StepReadDto>
{
    [MapperIgnoreTarget(nameof(StepEntity.Id))]
    [MapperIgnoreTarget(nameof(StepEntity.CreatedAt))]
    [MapperIgnoreTarget(nameof(StepEntity.UpdatedAt))]
    [MapperIgnoreTarget(nameof(StepEntity.CreatedBy))]
    [MapperIgnoreTarget(nameof(StepEntity.UpdatedBy))]
    [MapperIgnoreSource(nameof(StepCreateDto.NextStepIds))]
    public partial StepEntity ToEntity(StepCreateDto dto);

    [MapperIgnoreTarget(nameof(StepEntity.Id))]
    [MapperIgnoreTarget(nameof(StepEntity.CreatedAt))]
    [MapperIgnoreTarget(nameof(StepEntity.UpdatedAt))]
    [MapperIgnoreTarget(nameof(StepEntity.CreatedBy))]
    [MapperIgnoreTarget(nameof(StepEntity.UpdatedBy))]
    [MapperIgnoreSource(nameof(StepUpdateDto.NextStepIds))]
    public partial void Update(StepUpdateDto dto, StepEntity target);

    [MapValue(nameof(StepReadDto.NextStepIds), null)]
    public partial StepReadDto ToRead(StepEntity entity);
}
