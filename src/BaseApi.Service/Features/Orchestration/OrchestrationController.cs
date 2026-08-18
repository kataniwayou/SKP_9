using Asp.Versioning;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace BaseApi.Service.Features.Orchestration;

/// <summary>
/// Cross-entity orchestration controller. Two endpoints, start and stop, each acting on a single
/// workflow id supplied as the request body, and returning <c>202 Accepted</c> with no response body.
/// <para>
/// <b>Accepted rather than No Content, because the work is not finished when the response is
/// written.</b> Both verbs validate the request completely and then hand the projection write to a
/// durable queue, so a 2xx here means the request was well-formed and has been taken responsibility
/// for — not that the projection store has been changed. No Content would claim the latter.
/// </para>
/// <para>
/// <b>Singular class name:</b> this is the only controller here with one — the five entity
/// controllers are plural. The <c>[controller]</c> token resolves to <c>orchestration</c>.
/// </para>
/// <para>
/// <b>Concrete on concrete:</b> the constructor injects <see cref="OrchestrationService"/> directly.
/// There is no interface and no abstract base, so the abstract-base injection pattern the entity
/// controllers use does not apply here.
/// </para>
/// </summary>
[ApiController]
[ApiVersion("1.0")]
[Route("api/v{version:apiVersion}/[controller]")]
public sealed class OrchestrationController : ControllerBase
{
    private readonly OrchestrationService _service;

    public OrchestrationController(OrchestrationService service)
        => _service = service ?? throw new ArgumentNullException(nameof(service));

    /// <summary>
    /// Validates the requested workflow and its graph and queues the projection write, returning
    /// <c>202 Accepted</c> on success.
    /// </summary>
    [HttpPost("start")]
    [ProducesResponseType(StatusCodes.Status202Accepted)]
    [ProducesResponseType(typeof(ValidationProblemDetails), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ProblemDetails), StatusCodes.Status404NotFound)]
    [ProducesResponseType(typeof(ProblemDetails), StatusCodes.Status422UnprocessableEntity)]
    [ProducesResponseType(typeof(ProblemDetails), StatusCodes.Status500InternalServerError)]
    public async Task<IActionResult> Start([FromBody] Guid workflowId, CancellationToken ct)
    {
        await _service.StartAsync(workflowId, ct);
        return Accepted();
    }

    /// <summary>
    /// Validates the requested workflow id and queues the removal, returning <c>202 Accepted</c> on
    /// success. Only the URL segment and the service method differ from start.
    /// </summary>
    [HttpPost("stop")]
    [ProducesResponseType(StatusCodes.Status202Accepted)]
    [ProducesResponseType(typeof(ValidationProblemDetails), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ProblemDetails), StatusCodes.Status500InternalServerError)]
    public async Task<IActionResult> Stop([FromBody] Guid workflowId, CancellationToken ct)
    {
        await _service.StopAsync(workflowId, ct);
        return Accepted();
    }
}
