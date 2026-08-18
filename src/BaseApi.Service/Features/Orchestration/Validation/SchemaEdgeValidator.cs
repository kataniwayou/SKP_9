using BaseApi.Service.Features.Orchestration;

namespace BaseApi.Service.Features.Orchestration.Validation;

/// <summary>
/// Schema-edge compatibility gate: an independent walk over every parent-to-child edge, across every
/// entry in a parent's next-step list rather than only the first.
/// <para>
/// For each edge it resolves the parent processor's output schema and the child processor's input
/// schema and requires strict equality. A null on either side passes, which is what allows source,
/// sink and unconfigured processors. A mismatch — both present and different — throws and becomes a
/// 422 naming the offending pair.
/// </para>
/// <para>
/// <b>Deliberately independent of the cycle gate.</b> It does not call it and shares no traversal
/// abstraction; it is a flat per-edge equality check. A dangling child, referenced but absent from
/// the graph, belongs to the cycle-and-missing-step gate, which runs first in the locked order — so
/// this walk skips an unresolved child rather than raising another gate's error.
/// </para>
/// </summary>
internal sealed class SchemaEdgeValidator
{
    /// <summary>
    /// Walks every parent-to-child edge in the snapshot, throwing on the first mismatched edge.
    /// </summary>
    public void Validate(WorkflowGraphSnapshot snapshot)
    {
        foreach (var parent in snapshot.Steps.Values)
        {
            foreach (var childId in parent.NextStepIds ?? Enumerable.Empty<Guid>())
            {
                if (!snapshot.Steps.TryGetValue(childId, out var child))
                {
                    // Dangling child — the cycle gate runs first and owns this error.
                    continue;
                }

                var parentOut = snapshot.Processors.TryGetValue(parent.ProcessorId, out var pproc)
                    ? pproc.OutputSchemaId
                    : (Guid?)null;
                var childIn = snapshot.Processors.TryGetValue(child.ProcessorId, out var cproc)
                    ? cproc.InputSchemaId
                    : (Guid?)null;

                // A null on either side passes: source, sink or unconfigured processor.
                if (parentOut is null || childIn is null)
                {
                    continue;
                }

                if (parentOut.Value != childIn.Value)
                {
                    throw OrchestrationValidationException.SchemaEdge(parent.Id, child.Id);
                }
            }
        }
    }
}
