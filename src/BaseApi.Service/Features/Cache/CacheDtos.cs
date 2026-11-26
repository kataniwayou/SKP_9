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
    int ItemCount,
    DateTime CreatedAt,
    DateTime UpdatedAt,
    string? CreatedBy,
    string? UpdatedBy,
    double? BoardX = null,
    double? BoardY = null) : IBaseDto, IHasId;

/// <summary>Body of <c>POST /caches/{id}/items</c>: pairs to add; a key already stored is overwritten, and a key twice in the batch keeps its last value.</summary>
public sealed record CacheItemsAppendDto(List<CacheItemDto> Items);

/// <summary>Body of <c>POST /caches/{id}/items/remove</c>: the keys to drop.</summary>
public sealed record CacheItemsRemoveDto(List<string> Keys);

/// <summary>What an append did. The key lists are capped (<c>CacheRules.ReportKeyCap</c>); <c>KeysTruncated</c> says so.</summary>
public sealed record CacheAppendReport(
    int Added,
    int Overwritten,
    int RepeatedInBatch,
    List<string> OverwrittenKeys,
    List<string> RepeatedKeys,
    bool KeysTruncated);

/// <summary>What a remove did. The key lists are capped (<c>CacheRules.ReportKeyCap</c>); <c>KeysTruncated</c> says so.</summary>
public sealed record CacheRemoveReport(
    int Removed,
    int NotFound,
    int RepeatedInBatch,
    List<string> NotFoundKeys,
    List<string> RepeatedKeys,
    bool KeysTruncated);

/// <summary>One page of a cache's items, ordered by key; <c>Next</c> is the cursor for the following page, or null at the end.</summary>
public sealed record CacheItemsPage(List<CacheItemDto> Items, string? Next);
