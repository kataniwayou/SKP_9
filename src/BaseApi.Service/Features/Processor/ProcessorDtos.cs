using BaseApi.Core.Contracts;
using BaseApi.Core.Validation;

namespace BaseApi.Service.Features.Processor;

/// <summary>
/// Create-side DTO. Server-controlled fields are deliberately absent: the mapper cannot map what is
/// not on the source.
/// </summary>
public sealed record ProcessorCreateDto(
    string Name,
    string Version,
    string? Description,
    string SourceHash,
    Guid? InputSchemaId,
    Guid? OutputSchemaId,
    Guid? ConfigSchemaId) : IBaseDto;

/// <summary>
/// Update-side DTO. Server-controlled fields are absent here, and the mapper's <c>Update</c> method
/// additionally ignores them on the target side.
/// </summary>
public sealed record ProcessorUpdateDto(
    string Name,
    string Version,
    string? Description,
    string SourceHash,
    Guid? InputSchemaId,
    Guid? OutputSchemaId,
    Guid? ConfigSchemaId) : IBaseDto;

/// <summary>
/// Read-side DTO returned to clients, carrying the id and the audit fields. It implements
/// <see cref="IHasId"/> so the base controller can read the id when building the created-at
/// response.
/// </summary>
public sealed record ProcessorReadDto(
    Guid Id,
    string Name,
    string Version,
    string? Description,
    string SourceHash,
    Guid? InputSchemaId,
    Guid? OutputSchemaId,
    Guid? ConfigSchemaId,
    DateTime CreatedAt,
    DateTime UpdatedAt,
    string? CreatedBy,
    string? UpdatedBy) : IBaseDto, IHasId;
