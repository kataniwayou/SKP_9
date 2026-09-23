namespace BaseApi.Service.Features.Lookup;

/// <summary>Writes the id → name table into the log store's lookup index and materialises it.</summary>
public interface IEntityLookupPublisher
{
    Task PublishAsync(IReadOnlyCollection<LookupRow> rows, CancellationToken ct);

    /// <summary>Creates the index, policy and pipeline. Idempotent.</summary>
    Task EnsureProvisionedAsync(CancellationToken ct);
}
