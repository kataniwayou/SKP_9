using BaseApi.Core.Controllers;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace BaseApi.Service.Features.Cache;

public sealed class CachesController :
    BaseController<CacheEntity, CacheCreateDto, CacheUpdateDto, CacheReadDto>
{
    private readonly CacheService _service;

    public CachesController(CacheService service)
        : base(service) => _service = service;

    /// <summary>
    /// Replaces the cache's items and nothing else, returning 200 with the read DTO. Running workflows
    /// that projected this cache read the new items a moment later, without a start; the full
    /// <c>PUT</c> still waits for the next start.
    /// </summary>
    [HttpPut("{id:guid}/items")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ValidationProblemDetails), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ProblemDetails), StatusCodes.Status404NotFound)]
    public async Task<ActionResult<CacheReadDto>> UpdateItems(
        Guid id, [FromBody] CacheItemsUpdateDto dto, CancellationToken ct)
        => Ok(await _service.UpdateItemsAsync(id, dto, ct));

    /// <summary>
    /// Adds the pairs to the cache without touching the others; a key already stored is overwritten, and a
    /// key twice in the batch keeps its last value. The report says what was added, overwritten and repeated.
    /// </summary>
    [HttpPost("{id:guid}/items")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ValidationProblemDetails), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ProblemDetails), StatusCodes.Status404NotFound)]
    public async Task<ActionResult<CacheAppendReport>> AppendItems(
        Guid id, [FromBody] CacheItemsAppendDto dto, CancellationToken ct)
        => Ok(await _service.AppendItemsAsync(id, dto, ct));

    /// <summary>Drops the named keys; a key not stored is reported, not an error.</summary>
    [HttpPost("{id:guid}/items/remove")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ValidationProblemDetails), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ProblemDetails), StatusCodes.Status404NotFound)]
    public async Task<ActionResult<CacheRemoveReport>> RemoveItems(
        Guid id, [FromBody] CacheItemsRemoveDto dto, CancellationToken ct)
        => Ok(await _service.RemoveItemsAsync(id, dto, ct));

    /// <summary>
    /// One page of the cache's items ordered by key: <c>after</c> is the previous page's <c>next</c>,
    /// <c>from</c> starts at that key or the next one after it and <c>before</c> returns the rows just before it
    /// (give at most one of the three); the page reports <c>index</c> (keys before its first row), <c>prev</c>
    /// and, for <c>from</c>, <c>fromMatch</c>. <c>limit</c> defaults to 500 and is at most 5000. A page also stops once its key + value characters
    /// would pass 8,000,000, so a page of large values holds fewer than <c>limit</c> rows and carries
    /// <c>next</c>; keep paging until <c>next</c> is null. A single row over that budget is returned alone.
    /// </summary>
    [HttpGet("{id:guid}/items")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ValidationProblemDetails), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ProblemDetails), StatusCodes.Status404NotFound)]
    public async Task<ActionResult<CacheItemsPage>> PageItems(
        Guid id, [FromQuery] string? after, [FromQuery] string? from, [FromQuery] string? before,
        [FromQuery] int? limit, CancellationToken ct)
    {
        // Model binding turns an empty "?from=" into null; the service must see the empty string to refuse it.
        if (Request.Query.TryGetValue("from", out var f)) from = f.ToString();
        if (Request.Query.TryGetValue("before", out var b)) before = b.ToString();
        return Ok(await _service.PageItemsAsync(id, after, from, before, limit, ct));
    }
}
