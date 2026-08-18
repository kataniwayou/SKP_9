using BaseApi.Core.Controllers;
using BaseApi.Core.Services;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace BaseApi.Service.Features.Processor;

/// <summary>
/// Concrete controller for the Processor feature. It inherits the five CRUD verbs from
/// <see cref="BaseController{TEntity,TCreate,TUpdate,TRead}"/>, and the URL prefix
/// <c>/api/v1/processors</c> comes from the <c>[controller]</c> token convention.
/// <para>
/// The constructor injects both the abstract <see cref="BaseService{TEntity,TCreate,TUpdate,TRead}"/>,
/// for the inherited verbs, and the concrete <see cref="ProcessorService"/>, for the source-hash
/// lookup below. The feature registration already exposes both shapes, so no extra wiring is needed.
/// </para>
/// </summary>
public sealed class ProcessorsController :
    BaseController<ProcessorEntity, ProcessorCreateDto, ProcessorUpdateDto, ProcessorReadDto>
{
    private readonly ProcessorService _processorService;

    public ProcessorsController(
        BaseService<ProcessorEntity, ProcessorCreateDto, ProcessorUpdateDto, ProcessorReadDto> service,
        ProcessorService processorService)
        : base(service)
    {
        _processorService = processorService ?? throw new ArgumentNullException(nameof(processorService));
    }

    /// <summary>
    /// Returns the single processor whose source hash matches the route segment. There is no
    /// route-level format validation, so an off-format hash simply misses and 404s through the
    /// not-found handler.
    /// </summary>
    /// <remarks>
    /// <b>The route segment must be lowercase.</b> Matching is byte-for-byte against the stored value,
    /// which the create-side validator constrains to a lowercase 64-character hex string, so an
    /// uppercase or mixed-case variant returns 404 even when an equivalent row exists. See
    /// <see cref="ProcessorService.GetBySourceHashAsync"/> for why the read path does not normalize.
    /// </remarks>
    [HttpGet("by-source-hash/{sourceHash}")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ProblemDetails), StatusCodes.Status404NotFound)]
    public async Task<ActionResult<ProcessorReadDto>> GetBySourceHash(string sourceHash, CancellationToken ct)
        => Ok(await _processorService.GetBySourceHashAsync(sourceHash, ct));
}
