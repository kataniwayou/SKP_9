namespace BaseApi.Service.Features.Orchestration.Projection;

/// <summary>
/// Which steps still have a database row. The start path asks it about the steps a workflow dropped
/// since its previous start, so it can align their <c>skp:step:{id}</c> keys with the database.
/// <para>
/// <b>A missing row is safe to act on because referential integrity says so.</b> Every reference to a
/// step is <c>ON DELETE RESTRICT</c>, so a step row can only be gone once no workflow references it —
/// deleting its key cannot pull a name from under another workflow.
/// </para>
/// </summary>
internal interface IStepRowLookup
{
    /// <summary>The subset of <paramref name="stepIds"/> that still exists.</summary>
    Task<IReadOnlySet<Guid>> ExistingAsync(IReadOnlyCollection<Guid> stepIds, CancellationToken ct);
}
