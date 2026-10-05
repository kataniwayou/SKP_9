namespace BaseApi.Service.Features.Workflow.Graph;

/// <summary>
/// A graph save carried an <c>updatedAt</c> older than the stored row (or claimed a row was new when
/// it already exists), so applying it would silently overwrite someone else's change. Becomes a 409
/// that names the entity, so the editor can say what went stale.
/// </summary>
public sealed class GraphConflictException : Exception
{
    /// <summary><c>workflow</c> or <c>step</c>.</summary>
    public string Kind { get; }

    public Guid Id { get; }

    public GraphConflictException(string kind, Guid id)
        : base($"The {kind} '{id}' was changed since it was loaded.")
    {
        Kind = kind;
        Id = id;
    }
}
