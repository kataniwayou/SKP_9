using BaseApi.Core.Contracts;
using BaseApi.Core.Validation;

namespace BaseApi.Service.Features.Schema;

/// <summary>
/// Create-side DTO. Server-controlled fields are deliberately absent: the mapper cannot map what is
/// not on the source.
/// </summary>
public sealed record SchemaCreateDto(
    string Name,
    string Version,
    string? Description,
    string Definition) : IBaseDto;

/// <summary>
/// Update-side DTO. Server-controlled fields are absent here, and the mapper's <c>Update</c> method
/// additionally ignores them on the target side.
/// </summary>
public sealed record SchemaUpdateDto(
    string Name,
    string Version,
    string? Description,
    string Definition) : IBaseDto;

/// <summary>
/// Read-side DTO returned to clients, carrying the id and the audit fields. It implements
/// <see cref="IHasId"/> so the base controller can read the id when building the created-at
/// response, and <see cref="IBaseDto"/> for symmetry with the create and update shapes.
/// </summary>
public sealed record SchemaReadDto(
    Guid Id,
    string Name,
    string Version,
    string? Description,
    string Definition,
    DateTime CreatedAt,
    DateTime UpdatedAt,
    string? CreatedBy,
    string? UpdatedBy) : IBaseDto, IHasId;
