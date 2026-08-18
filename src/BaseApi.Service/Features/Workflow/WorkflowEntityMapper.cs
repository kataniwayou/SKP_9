using BaseApi.Core.Mapping;
using Riok.Mapperly.Abstractions;

namespace BaseApi.Service.Features.Workflow;

/// <summary>
/// Source-generated mapper for <see cref="WorkflowEntity"/>. That this partial compiles, with the
/// Mapperly diagnostics promoted to errors, is itself the drift check.
/// <para>
/// The attribute coverage is asymmetric, because the entry-step and assignment collections live on
/// the DTOs but not on the entity:
/// </para>
/// <list type="bullet">
///   <item><see cref="ToEntity"/> and <see cref="Update"/> ignore the five server-side targets, plus
///     both collections on the source — otherwise the generator reports source members the target
///     has no home for.</item>
///   <item><see cref="ToRead"/> maps both collections to null explicitly. The read DTO is a
///     positional record, so each is a required constructor parameter and cannot simply be ignored;
///     mapping a value is what satisfies it. Reads therefore return null for both and the junction
///     rows stay the source of truth.</item>
/// </list>
/// </summary>
[Mapper]
public sealed partial class WorkflowEntityMapper :
    IEntityMapper<WorkflowEntity, WorkflowCreateDto, WorkflowUpdateDto, WorkflowReadDto>
{
    [MapperIgnoreTarget(nameof(WorkflowEntity.Id))]
    [MapperIgnoreTarget(nameof(WorkflowEntity.CreatedAt))]
    [MapperIgnoreTarget(nameof(WorkflowEntity.UpdatedAt))]
    [MapperIgnoreTarget(nameof(WorkflowEntity.CreatedBy))]
    [MapperIgnoreTarget(nameof(WorkflowEntity.UpdatedBy))]
    [MapperIgnoreSource(nameof(WorkflowCreateDto.EntryStepIds))]
    [MapperIgnoreSource(nameof(WorkflowCreateDto.AssignmentIds))]
    public partial WorkflowEntity ToEntity(WorkflowCreateDto dto);

    [MapperIgnoreTarget(nameof(WorkflowEntity.Id))]
    [MapperIgnoreTarget(nameof(WorkflowEntity.CreatedAt))]
    [MapperIgnoreTarget(nameof(WorkflowEntity.UpdatedAt))]
    [MapperIgnoreTarget(nameof(WorkflowEntity.CreatedBy))]
    [MapperIgnoreTarget(nameof(WorkflowEntity.UpdatedBy))]
    [MapperIgnoreSource(nameof(WorkflowUpdateDto.EntryStepIds))]
    [MapperIgnoreSource(nameof(WorkflowUpdateDto.AssignmentIds))]
    public partial void Update(WorkflowUpdateDto dto, WorkflowEntity target);

    // Both collections are required constructor parameters on the positional read record, so they
    // cannot be ignored — a mapped value is what satisfies them. Reads return null for both.
    [MapValue(nameof(WorkflowReadDto.EntryStepIds), null)]
    [MapValue(nameof(WorkflowReadDto.AssignmentIds), null)]
    public partial WorkflowReadDto ToRead(WorkflowEntity entity);
}
