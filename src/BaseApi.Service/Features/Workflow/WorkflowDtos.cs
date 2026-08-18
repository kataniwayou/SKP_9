using BaseApi.Core.Contracts;
using BaseApi.Core.Validation;

namespace BaseApi.Service.Features.Workflow;

/// <summary>
/// Create-side DTO. Server-controlled fields are deliberately absent. Both collections live on the
/// DTOs only, never on <see cref="WorkflowEntity"/>: the <c>WorkflowEntrySteps</c> and
/// <c>WorkflowAssignments</c> junctions are the source of truth, written by
/// <c>WorkflowService.SyncJunctionsAsync</c> between the add and the save.
/// <para>
/// <c>EntryStepIds</c> is required and must be non-empty. <c>AssignmentIds</c> is nullable, since a
/// workflow may have none. <c>CronExpression</c> is nullable, where null means not scheduled; a
/// non-null value must parse as a five-field cron expression.
/// </para>
/// </summary>
public sealed record WorkflowCreateDto(
    string Name,
    string Version,
    string? Description,
    List<Guid> EntryStepIds,
    List<Guid>? AssignmentIds,
    string? CronExpression) : IBaseDto;

/// <summary>
/// Update-side DTO. On update the existing rows in <i>both</i> junctions for this workflow are
/// removed before the new collection values are inserted — a remove-and-replace, handled in the
/// service's junction-sync override.
/// </summary>
public sealed record WorkflowUpdateDto(
    string Name,
    string Version,
    string? Description,
    List<Guid> EntryStepIds,
    List<Guid>? AssignmentIds,
    string? CronExpression) : IBaseDto;

/// <summary>
/// Read-side DTO returned to clients, carrying the id and the audit fields.
/// <para>
/// <b>Neither collection is populated on read.</b> The mapper projects from the entity, which
/// deliberately has neither property, so both come back null on get and list. The junction rows are
/// the source of truth and must be queried directly. That is also why <c>EntryStepIds</c> is
/// nullable here while it is required on create and update: a non-nullable collection would fail
/// the mapper's strict-mapping analyzer.
/// </para>
/// </summary>
public sealed record WorkflowReadDto(
    Guid Id,
    string Name,
    string Version,
    string? Description,
    List<Guid>? EntryStepIds,
    List<Guid>? AssignmentIds,
    string? CronExpression,
    DateTime CreatedAt,
    DateTime UpdatedAt,
    string? CreatedBy,
    string? UpdatedBy) : IBaseDto, IHasId;
