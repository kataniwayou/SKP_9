using BaseApi.Core.Contracts;
using BaseApi.Core.Validation;

namespace BaseApi.Service.Features.Assignment;

/// <summary>
/// Create-side DTO. Server-controlled fields are deliberately absent: the mapper cannot map what is
/// not on the source.
/// </summary>
public sealed record AssignmentCreateDto(
    string Name,
    string Version,
    string? Description,
    Guid StepId,
    string Payload) : IBaseDto;

/// <summary>
/// Update-side DTO. Server-controlled fields are absent here, and the mapper's <c>Update</c> method
/// additionally ignores them on the target side.
/// </summary>
public sealed record AssignmentUpdateDto(
    string Name,
    string Version,
    string? Description,
    Guid StepId,
    string Payload) : IBaseDto;

/// <summary>
/// Read-side DTO returned to clients, carrying the id and the audit fields. It implements
/// <see cref="IHasId"/> so the base controller can read the id when building the created-at
/// response.
/// </summary>
public sealed record AssignmentReadDto(
    Guid Id,
    string Name,
    string Version,
    string? Description,
    Guid StepId,
    string Payload,
    DateTime CreatedAt,
    DateTime UpdatedAt,
    string? CreatedBy,
    string? UpdatedBy) : IBaseDto, IHasId;
