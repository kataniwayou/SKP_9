using Asp.Versioning;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace BaseApi.Service.Features.Orchestration;

/// <summary>
/// Cross-entity orchestration controller. Start and stop, each acting on a single workflow id supplied
/// as the request body and returning 202 Accepted, plus a read of the running workflows.
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
    private readonly ILiveWorkflowReader _live;

    public OrchestrationController(OrchestrationService service, ILiveWorkflowReader live)
    {
        _service = service;
        _live = live ?? throw new ArgumentNullException(nameof(live));
    }

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

    /// <summary>
    /// The running workflows. Start and stop are queued (both answer 202), so a workflow appears here
    /// a moment after its start was accepted and leaves a moment after its stop.
    /// </summary>
    [HttpGet("live")]
    [ProducesResponseType(typeof(IReadOnlyList<Guid>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ProblemDetails), StatusCodes.Status500InternalServerError)]
    public async Task<ActionResult<IReadOnlyList<Guid>>> Live(CancellationToken ct)
        => Ok(await _live.ListAsync(ct));
}
