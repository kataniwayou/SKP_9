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
}
