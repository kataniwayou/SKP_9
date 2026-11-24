using BaseApi.Core.Contracts;
using BaseApi.Core.Validation;

namespace BaseApi.Service.Features.Cache;

/// <summary>
/// Create-side DTO. Server-controlled fields are deliberately absent: the mapper cannot map what is
/// not on the source.
/// </summary>
public sealed record CacheCreateDto(
    string Name,
    string Version,
    string? Description,
    string Root,
    List<CacheItemDto> Items,
    double? BoardX = null,
    double? BoardY = null) : IBaseDto;

/// <summary>
/// Update-side DTO. Server-controlled fields are absent here, and the mapper's <c>Update</c> method
/// additionally ignores them on the target side.
/// </summary>
public sealed record CacheUpdateDto(
    string Name,
    string Version,
    string? Description,
    string Root,
    List<CacheItemDto> Items,
    double? BoardX = null,
    double? BoardY = null) : IBaseDto;

/// <summary>
/// Body of <c>PUT /caches/{id}/items</c>: the whole dictionary, which replaces the row's. The root and
/// every other field are absent, so the one edit that reaches running workflows cannot move the address
/// their steps read.
/// </summary>
public sealed record CacheItemsUpdateDto(List<CacheItemDto> Items);

/// <summary>
/// One entry of a cache's dictionary as the API carries it. Items travel as a list of these, not as an
/// object: a list can say a key twice, which the validator then refuses by name, where an object would
/// silently keep the last one.
/// </summary>
public sealed record CacheItemDto(string Key, string Value);

/// <summary>
/// Read-side DTO returned to clients, carrying the id and the audit fields. It implements
/// <see cref="IHasId"/> so the base controller can read the id when building the created-at
/// response.
/// </summary>
public sealed record CacheReadDto(
    Guid Id,
    string Name,
    string Version,
    string? Description,
    string Root,
    List<CacheItemDto> Items,
    DateTime CreatedAt,
    DateTime UpdatedAt,
    string? CreatedBy,
    string? UpdatedBy,
    double? BoardX = null,
    double? BoardY = null) : IBaseDto, IHasId;
