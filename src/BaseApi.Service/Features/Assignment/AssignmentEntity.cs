using BaseApi.Core.Entities;

namespace BaseApi.Service.Features.Assignment;

/// <summary>
/// Assignment domain entity — a leaf of the entity foreign-key graph.
/// <para>
/// <c>StepId</c> is a non-nullable foreign key to the step. Its constraint restricts deletes, so
/// deleting a step while an assignment references it raises SQLSTATE 23001 and becomes a 422. The
/// other direction — creating an assignment whose step id names nothing — raises 23503.
/// </para>
/// <para>
/// <c>Payload</c> stores an arbitrary JSON document as a Postgres <c>jsonb</c> column. The validator
/// confirms the syntax parses and enforces a maximum length. Validating the payload against a schema
/// is not possible at this layer, because the assignment carries no schema reference.
/// </para>
/// </summary>
public sealed class AssignmentEntity : BaseEntity
{
    public Guid StepId { get; set; }
    public string Payload { get; set; } = string.Empty;
}
