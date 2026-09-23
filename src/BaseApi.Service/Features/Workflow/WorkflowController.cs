using BaseApi.Core.Controllers;
using BaseApi.Core.Services;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace BaseApi.Service.Features.Workflow;

/// <summary>
/// Concrete controller for the Workflow feature. The five CRUD verbs are inherited from
/// <see cref="BaseController{TEntity,TCreate,TUpdate,TRead}"/>, and the URL prefix
/// <c>/api/v1/workflows</c> comes from the <c>[controller]</c> token convention.
/// <para>
/// The constructor injects the <b>abstract</b> <see cref="BaseService{TEntity,TCreate,TUpdate,TRead}"/>
/// rather than the concrete <see cref="WorkflowService"/>, which makes the alias registered in
/// <see cref="WorkflowServiceCollectionExtensions.AddWorkflowFeature"/> load-bearing: without it, the container
/// cannot resolve this controller's dependency.
/// </para>
/// <para>
/// <b>The body is no longer empty.</b> The two diagram actions below sit outside CRUD deliberately.
/// The diagram is not on any DTO — see <see cref="WorkflowEntity.Diagram"/> — so it has nowhere to
/// travel through the inherited verbs, and it should not: a read DTO is JSON returned to a client
/// that wants a workflow, while a diagram is image bytes fetched by a browser that wants a picture.
/// They differ in content type, in size and in who asks for them.
/// </para>
/// <para>
/// These two actions take the <see cref="AppDbContext"/> directly rather than going through the
/// service. A diagram touches exactly one column on one row, and the service layer exists to keep
/// the three junction tables in step with the DTO collections — none of which applies here.
/// </para>
/// </summary>
public sealed class WorkflowsController :
    BaseController<WorkflowEntity, WorkflowCreateDto, WorkflowUpdateDto, WorkflowReadDto>
{
    private readonly AppDbContext _db;

    public WorkflowsController(
        BaseService<WorkflowEntity, WorkflowCreateDto, WorkflowUpdateDto, WorkflowReadDto> service,
        AppDbContext db)
        : base(service) => _db = db;

    /// <summary>
    /// Returns the workflow's diagram as SVG, or the placeholder when none has been published.
    /// </summary>
    /// <remarks>
    /// <b>The <c>.svg</c> suffix is not cosmetic.</b> The dashboard panel builds this URL by
    /// string-concatenating a base with the workflow id it read from its own query — it has no way
    /// to express a path segment after the id — so the id must be the last thing in the path. That
    /// is why this is <c>{id}.svg</c> and not <c>{id}/diagram</c>, while the PUT below, which no
    /// browser constructs, is free to use the tidier shape.
    /// <para>
    /// <b>A missing workflow answers 404, a workflow with no diagram answers 200 and the
    /// placeholder.</b> The distinction is deliberate: the first is a wrong id and the second is an
    /// ordinary un-enriched workflow, and collapsing them would make a typo look like a design
    /// choice.
    /// </para>
    /// </remarks>
    [HttpGet("{id:guid}.svg")]
    [Produces(WorkflowDiagram.ContentType)]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<IActionResult> GetDiagram(Guid id, CancellationToken ct)
    {
        // Projected to the one column: selecting the entity would drag the whole row for a field
        // nothing else here reads.
        var row = await _db.Set<WorkflowEntity>()
            .Where(w => w.Id == id)
            .Select(w => new { w.Diagram })
            .FirstOrDefaultAsync(ct);

        if (row is null)
            return NotFound();

        var svg = row.Diagram ?? WorkflowDiagram.Placeholder;

        // CACHED, BECAUSE THE PANEL ASKS FOR THIS CONSTANTLY. Measured: five requests per dashboard
        // load, every load, plus every control change, time-range change and auto-refresh tick -
        // and a drawing changes only when an operator publishes one. With an ETag a repeat view
        // costs a 304 instead of the whole SVG.
        //
        // This was NOT safe to add while the lookup-table refresh rode on these requests: caching
        // them would have silently stopped it, with nothing connecting the two changes. The refresh
        // now has its own no-store endpoint, so the two are independent.
        var etag = "\"" + Convert.ToHexString(
            System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(svg)))[..16] + "\"";
        if (Request.Headers.IfNoneMatch.Any(v => v == etag))
            return StatusCode(StatusCodes.Status304NotModified);

        Response.Headers.ETag = etag;
        Response.Headers.CacheControl = "max-age=60";
        return Content(svg, WorkflowDiagram.ContentType);
    }

    /// <summary>
    /// Publishes or replaces the workflow's diagram. The body is raw SVG, not JSON.
    /// </summary>
    /// <remarks>
    /// <b>Enriching a workflow is the operator's choice, not a step in any pipeline.</b> Nothing
    /// calls this automatically: an operator runs the diagram task when they want a picture, and a
    /// workflow that never gets one keeps serving the placeholder indefinitely. That is why this is
    /// a separate verb rather than a field the create or update DTO could carry — those would make
    /// the diagram something every caller has to think about.
    /// <para>
    /// The only validation is that the body looks like SVG. A deeper check belongs in the diagram
    /// task, which renders and measures the drawing before it ever gets here; repeating it would be
    /// a second, weaker implementation of a check that already exists.
    /// </para>
    /// </remarks>
    [HttpPut("{id:guid}/diagram")]
    [Consumes(WorkflowDiagram.ContentType)]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<IActionResult> PutDiagram(Guid id, CancellationToken ct)
    {
        using var reader = new StreamReader(Request.Body);
        var svg = await reader.ReadToEndAsync(ct);

        if (string.IsNullOrWhiteSpace(svg) || !svg.Contains("<svg", StringComparison.Ordinal))
            return BadRequest("Body must be SVG source.");

        var workflow = await _db.Set<WorkflowEntity>().FirstOrDefaultAsync(w => w.Id == id, ct);
        if (workflow is null)
            return NotFound();

        workflow.Diagram = svg;
        await _db.SaveChangesAsync(ct);
        return NoContent();
    }
}
