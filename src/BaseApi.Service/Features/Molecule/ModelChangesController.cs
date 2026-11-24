using Asp.Versioning;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace BaseApi.Service.Features.Molecule;

/// <summary>
/// A change set across the entity tables, run through each entity's own service: a dry run (<c>/model/validate</c>) or
/// an apply, all or nothing (<c>/model/apply</c>) — Acto's board Save.
/// </summary>
[ApiController]
[ApiVersion("1.0")]
public sealed class ModelChangesController : ControllerBase
{
    private readonly IModelChangesValidator _changes;

    public ModelChangesController(IModelChangesValidator changes)
    {
        _changes = changes ?? throw new ArgumentNullException(nameof(changes));
    }

    [HttpPost("api/v{version:apiVersion}/model/validate")]
    [ProducesResponseType(typeof(ModelValidateResultDto), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ProblemDetails), StatusCodes.Status400BadRequest)]
    public async Task<IActionResult> Validate([FromBody] ModelChangesDto body, CancellationToken ct)
    {
        if (body?.Changes is not { } changes)
            return Problem(statusCode: StatusCodes.Status400BadRequest, title: "No changes", detail: "The body is { changes: [...] }.");
        if (changes.Count > ModelChangeRunner.MaxChanges)
            return Problem(statusCode: StatusCodes.Status400BadRequest, title: "Too many changes", detail: $"At most {ModelChangeRunner.MaxChanges} changes in one dry run.");
        return Ok(await _changes.DryRunAsync(changes, HttpContext, ct));
    }

    /// <summary>
    /// Applies changes, all of them or none (the user, 2026-10-17): the dry run's way, in one transaction, committed only
    /// when every change passed. A 200 carries the results either way: <c>applied</c> says whether they were kept, and
    /// <c>made</c> maps each created row's client id to the id BaseApi gave it. A change that names when its row was read
    /// (<c>updatedAt</c>) is refused with a 409 if the row changed since. A 400 means the request could not be read.
    /// </summary>
    [HttpPost("api/v{version:apiVersion}/model/apply")]
    [ProducesResponseType(typeof(ModelApplyResultDto), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ProblemDetails), StatusCodes.Status400BadRequest)]
    public async Task<IActionResult> Apply([FromBody] ModelChangesDto body, CancellationToken ct)
    {
        if (body?.Changes is not { Count: > 0 } changes)
            return Problem(statusCode: StatusCodes.Status400BadRequest, title: "No changes", detail: "The body is { changes: [...] }, with at least one change.");
        if (changes.Count > ModelChangeRunner.MaxChanges)
            return Problem(statusCode: StatusCodes.Status400BadRequest, title: "Too many changes", detail: $"At most {ModelChangeRunner.MaxChanges} changes in one apply.");
        return Ok(await _changes.ApplyAsync(changes, HttpContext, ct));
    }
}

/// <summary>The dry run, for <see cref="ModelChangesController.Validate"/>.</summary>
public interface IModelChangesValidator
{
    Task<ModelValidateResultDto> DryRunAsync(IReadOnlyList<ModelChangeDto> changes, HttpContext http, CancellationToken ct);
    /// <summary>The same run, committed when every change passed: <c>POST /model/apply</c>.</summary>
    Task<ModelApplyResultDto> ApplyAsync(IReadOnlyList<ModelChangeDto> changes, HttpContext http, CancellationToken ct);
}
