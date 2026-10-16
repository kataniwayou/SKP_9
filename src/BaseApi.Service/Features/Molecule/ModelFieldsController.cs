using Asp.Versioning;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Net.Http.Headers;

namespace BaseApi.Service.Features.Molecule;

/// <summary>
/// The fields beside the relations: every entity's writable fields and the rules a write must pass, and a dry run of a
/// change set against all of them, so a client such as Valence checks its edits as BaseApi will, without a copy of the rules.
/// </summary>
[ApiController]
[ApiVersion("1.0")]
public sealed class ModelFieldsController : ControllerBase
{
    private readonly IModelFieldsReader _fields;
    private readonly IModelChangesValidator _changes;

    public ModelFieldsController(IModelFieldsReader fields, IModelChangesValidator changes)
    {
        _fields = fields ?? throw new ArgumentNullException(nameof(fields));
        _changes = changes ?? throw new ArgumentNullException(nameof(changes));
    }

    /// <summary>
    /// Every entity's update fields with their validator rules, store types and unique indexes. It changes only with a
    /// redeploy, so it carries a strong ETag and answers a matching If-None-Match with 304.
    /// </summary>
    [HttpGet("api/v{version:apiVersion}/model/fields")]
    [ProducesResponseType(typeof(ModelFieldsDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status304NotModified)]
    public IActionResult Fields()
    {
        var read = _fields.Read();
        var etag = new EntityTagHeaderValue($"\"{read.ETag}\"");
        if (Request.GetTypedHeaders().IfNoneMatch?.Any(t => t.Compare(etag, useStrongComparison: true) || t.Equals(EntityTagHeaderValue.Any)) == true)
            return StatusCode(StatusCodes.Status304NotModified);

        Response.GetTypedHeaders().ETag = etag;
        return Ok(read.Fields);
    }

    /// <summary>
    /// A dry run of changes, in order, through the services a <c>PUT</c> or <c>DELETE</c> uses, in one transaction that
    /// is always rolled back: each change's result is what the real call would answer. Nothing is written. A 200 carries
    /// the results even when changes fail; a 400 means the request itself could not be read.
    /// </summary>
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
}

/// <summary>The dry run, for <see cref="ModelFieldsController.Validate"/>.</summary>
public interface IModelChangesValidator
{
    Task<ModelValidateResultDto> DryRunAsync(IReadOnlyList<ModelChangeDto> changes, HttpContext http, CancellationToken ct);
}

/// <summary>The fields' description and its ETag, for <see cref="ModelFieldsController.Fields"/>.</summary>
public interface IModelFieldsReader
{
    ModelFieldsRead Read();
}

public sealed record ModelFieldsRead(ModelFieldsDto Fields, string ETag);

internal sealed class ContextModelFieldsReader : IModelFieldsReader
{
    private readonly AppDbContext _db;
    private readonly IServiceProvider _services;

    public ContextModelFieldsReader(AppDbContext db, IServiceProvider services)
    {
        _db = db ?? throw new ArgumentNullException(nameof(db));
        _services = services ?? throw new ArgumentNullException(nameof(services));
    }

    public ModelFieldsRead Read() { var s = ModelFields.Describe(_db.Model, _services); return new ModelFieldsRead(s.Dto, s.ETag); }
}
