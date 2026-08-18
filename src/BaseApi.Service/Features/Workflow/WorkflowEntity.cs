using BaseApi.Core.Entities;

namespace BaseApi.Service.Features.Workflow;

/// <summary>
/// Workflow domain entity — the apex of the entity foreign-key graph; nothing else references it.
/// The entity carries only the optional cron expression: its entry-step and assignment collections
/// live on the DTOs and are persisted through the two junction tables, synchronized by
/// <c>WorkflowService.SyncJunctionsAsync</c>.
/// <para>
/// <c>CronExpression</c> is nullable, and null means the workflow is not scheduled. A non-null value
/// is parsed by the validator, which accepts the five-field standard form; a six-field expression is
/// rejected with a 400.
/// </para>
/// <para>
/// <b>The junction collections are deliberately not properties here</b> — there are no navigation
/// properties between entities. The workflow owns the junction lifecycle: both junction
/// configurations cascade on the workflow side, so deleting a workflow removes its junction rows,
/// while the far side restricts, so deleting a step or assignment a workflow still points at raises
/// SQLSTATE 23001 and becomes a 422.
/// </para>
/// </summary>
public sealed class WorkflowEntity : BaseEntity
{
    public string? CronExpression { get; set; }
}
