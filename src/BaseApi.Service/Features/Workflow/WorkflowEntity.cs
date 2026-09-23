using BaseApi.Core.Entities;

namespace BaseApi.Service.Features.Workflow;

/// <summary>
/// Workflow domain entity — the apex of the entity foreign-key graph; nothing else references it.
/// The entity carries only the optional cron expression: its entry-step, assignment and cache
/// collections live on the DTOs and are persisted through the three junction tables, synchronized by
/// <c>WorkflowService.SyncJunctionsAsync</c>.
/// <para>
/// <c>CronExpression</c> is nullable, and null means the workflow is not scheduled. A non-null value
/// is parsed by the validator, which accepts the five-field standard form; a six-field expression is
/// rejected with a 400.
/// </para>
/// <para>
/// <b>The junction collections are deliberately not properties here</b> — there are no navigation
/// properties between entities. The workflow owns the junction lifecycle: all three junction
/// configurations cascade on the workflow side, so deleting a workflow removes its junction rows,
/// while the far side restricts, so deleting a step, assignment or cache a workflow still points at
/// raises SQLSTATE 23001 and becomes a 422. The third junction, <c>WorkflowCaches</c>, carries the
/// caches the workflow projects.
/// </para>
/// <para>
/// <b><c>Diagram</c> is deliberately absent from all three DTOs.</b> It is written and read by the
/// two dedicated actions on <c>WorkflowsController</c>, never through CRUD, for two reasons: the
/// read DTO is a positional record whose constructor every mapper must satisfy, and a diagram is
/// tens of kilobytes that no list response should carry. The mappers therefore ignore it explicitly
/// — with Mapperly diagnostics promoted to errors, an unmapped member is a build failure, so the
/// ignores are not decoration but the thing that keeps the asymmetry compiling.
/// </para>
/// <para>
/// Null means <b>no diagram has been published</b>, which is an ordinary state rather than an error:
/// enriching a workflow is the operator's choice. The GET action answers null with a placeholder
/// that says so, so "nobody drew this one" stays distinguishable from "the API is unreachable" —
/// the latter renders as nothing at all, because the dashboard's image tag carries empty alt text.
/// </para>
/// </summary>
public sealed class WorkflowEntity : BaseEntity
{
    public string? CronExpression { get; set; }

    /// <summary>
    /// The workflow's diagram as SVG source, or null when none has been published.
    /// <para>
    /// SVG rather than PNG: the committed drawings are 15.8 KB and 5.6 KB against 195 KB and 83 KB
    /// for the same images rendered to PNG, they stay sharp at any size the dashboard panel gives
    /// them, and storing the source removes the headless-Chrome render from the pipeline entirely.
    /// </para>
    /// </summary>
    public string? Diagram { get; set; }
}
