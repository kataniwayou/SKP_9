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
    /// <c>limit</c> defaults to 500 and is at most 5000.
    /// </summary>
    [HttpGet("{id:guid}/items")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ValidationProblemDetails), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ProblemDetails), StatusCodes.Status404NotFound)]
    public async Task<ActionResult<CacheItemsPage>> PageItems(
        Guid id, [FromQuery] string? after, [FromQuery] int? limit, CancellationToken ct)
        => Ok(await _service.PageItemsAsync(id, after, limit, ct));
}
