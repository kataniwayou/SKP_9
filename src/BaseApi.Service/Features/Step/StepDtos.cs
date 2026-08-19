using BaseApi.Core.Contracts;
using BaseApi.Core.Validation;

namespace BaseApi.Service.Features.Step;

/// <summary>
/// Create-side DTO. Server-controlled fields are deliberately absent. <c>NextStepIds</c> lives on the
/// DTOs only, never on <see cref="StepEntity"/>: the <c>StepNextSteps</c> junction is the source of
/// truth, written by <c>StepService.SyncJunctionsAsync</c> between the add and the save.
/// </summary>
public sealed record StepCreateDto(
    string Name,
    string Version,
    string? Description,
    Guid ProcessorId,
    List<Guid>? NextStepIds,
    StepEntryCondition EntryCondition) : IBaseDto;

/// <summary>
/// Update-side DTO. On update the existing junction rows for this step are removed before the new
/// <c>NextStepIds</c> are inserted — a remove-and-replace, handled in the service's junction-sync
/// override.
/// </summary>
public sealed record StepUpdateDto(
    string Name,
    string Version,
    string? Description,
    Guid ProcessorId,
    List<Guid>? NextStepIds,
    StepEntryCondition EntryCondition) : IBaseDto;

/// <summary>
/// Read-side DTO returned to clients, carrying the id and the audit fields.
/// <para>
/// <b><c>NextStepIds</c> is populated after the mapper has run, not by it.</b> The mapper projects
/// from the entity, which deliberately has no such property, so it hard-codes null;
/// <c>StepService.EnrichReadAsync</c> then fills it from the junction rows, which remain the source
/// of truth. Every read verb goes through that enrichment, so a client sees the edges it wrote, and
/// a sink reads as an empty list rather than null. The property stays nullable only because the
/// mapper's strict-mapping analyzer rejects a non-nullable collection it has no source for.
/// </para>
/// </summary>
public sealed record StepReadDto(
    Guid Id,
    string Name,
    string Version,
    string? Description,
    Guid ProcessorId,
    List<Guid>? NextStepIds,
    StepEntryCondition EntryCondition,
    DateTime CreatedAt,
    DateTime UpdatedAt,
    string? CreatedBy,
    string? UpdatedBy) : IBaseDto, IHasId;
