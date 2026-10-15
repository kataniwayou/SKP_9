using Asp.Versioning;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Net.Http.Headers;

namespace BaseApi.Service.Features.Molecule;

/// <summary>
/// The entity molecule's two reads: the schema's foreign keys with their rules, and one workflow's rows with the links
/// between them. Together they let a client draw the molecule and preview a delete without holding any schema knowledge.
/// <para>
/// The molecule sits under <c>/workflows/{id}</c> but lives here, beside the relations it is joined to, rather than on
/// <c>WorkflowsController</c>: it reads through the model, not through the workflow's DTOs.
/// </para>
/// </summary>
[ApiController]
[ApiVersion("1.0")]
public sealed class MoleculeController : ControllerBase
{
    private readonly IModelRelationsReader _relations;
    private readonly IMoleculeReader _reader;

    public MoleculeController(IModelRelationsReader relations, IMoleculeReader reader)
    {
        _relations = relations ?? throw new ArgumentNullException(nameof(relations));
        _reader = reader ?? throw new ArgumentNullException(nameof(reader));
    }

    /// <summary>
    /// Every table and foreign key the database enforces, with each key's delete rule, nullability and strength.
    /// It changes only with a migration, so it carries a strong ETag and answers a matching If-None-Match with 304.
    /// </summary>
    [HttpGet("api/v{version:apiVersion}/model/relations")]
    [ProducesResponseType(typeof(ModelRelationsDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status304NotModified)]
    public IActionResult Relations()
    {
        var read = _relations.Read();
        var etag = new EntityTagHeaderValue($"\"{read.ETag}\"");
        if (Request.GetTypedHeaders().IfNoneMatch?.Any(t => t.Compare(etag, useStrongComparison: true) || t.Equals(EntityTagHeaderValue.Any)) == true)
            return StatusCode(StatusCodes.Status304NotModified);

        Response.GetTypedHeaders().ETag = etag;
        return Ok(read.Relations);
    }

    /// <summary>
    /// The workflow's rows (the step set a start validates, with their processors, schemas, assignments and caches) and
    /// every foreign-key link between them, each named by its constraint. A missing workflow is a 404.
    /// </summary>
    [HttpGet("api/v{version:apiVersion}/workflows/{id:guid}/molecule")]
    [ProducesResponseType(typeof(MoleculeDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<MoleculeDto>> Molecule(Guid id, CancellationToken ct) =>
        Ok(await _reader.ReadAsync(id, ct));
}

/// <summary>The schema's description and its ETag, for <see cref="MoleculeController.Relations"/>.</summary>
public interface IModelRelationsReader
{
    ModelRelationsRead Read();
}

public sealed record ModelRelationsRead(ModelRelationsDto Relations, string ETag);

/// <summary>Where the schema's description comes from: the request's own context in production, a fixed model in tests.</summary>
internal interface IModelRelationsSource
{
    ModelRelationsSnapshot Get();
}

internal sealed class ContextModelRelationsSource : IModelRelationsSource, IModelRelationsReader
{
    private readonly AppDbContext _db;

    public ContextModelRelationsSource(AppDbContext db) => _db = db ?? throw new ArgumentNullException(nameof(db));

    public ModelRelationsSnapshot Get() => ModelRelations.Describe(_db.Model);

    public ModelRelationsRead Read() { var s = Get(); return new ModelRelationsRead(s.Dto, s.ETag); }
}
