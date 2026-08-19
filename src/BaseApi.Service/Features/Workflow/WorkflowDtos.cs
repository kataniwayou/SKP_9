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
/// <b>Both collections are populated after the mapper has run, not by it.</b> The mapper projects
/// from the entity, which deliberately has neither property, so it hard-codes null;
/// <c>WorkflowService.EnrichReadAsync</c> then fills both from the junction rows, which remain the
/// source of truth. Every read verb goes through that enrichment, so a client sees the bindings it
/// wrote, and a workflow with no assignments reads as an empty list rather than null. The
/// properties stay nullable only because the mapper's strict-mapping analyzer rejects a
/// non-nullable collection it has no source for.
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
