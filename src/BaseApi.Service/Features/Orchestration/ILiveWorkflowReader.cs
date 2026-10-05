namespace BaseApi.Service.Features.Orchestration;

/// <summary>
/// The workflows that are running: the members of the <c>skp:live</c> set. Read through BaseApi so the
/// studio never couples to Redis or its key layout.
/// </summary>
public interface ILiveWorkflowReader
{
    /// <summary>Every running workflow id, sorted. A member that is not a workflow id is skipped.</summary>
    Task<IReadOnlyList<Guid>> ListAsync(CancellationToken ct);
}
