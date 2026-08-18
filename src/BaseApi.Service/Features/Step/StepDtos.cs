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
/// <b><c>NextStepIds</c> is not populated on read.</b> The mapper projects from the entity, which
/// deliberately has no such property, so this comes back null on get and list. The junction rows are
/// the source of truth and must be queried directly. That is also why the property is nullable:
/// a non-nullable collection here would fail the mapper's strict-mapping analyzer.
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
