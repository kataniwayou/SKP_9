namespace BaseApi.Service.Features.Orchestration.Projection;

/// <summary>
/// The narrow store seam the orphan sweep needs, kept separate from the Redis client so the sweep's
/// decisions can be exercised against real semantics rather than a recording double.
/// <para>
/// <b><see cref="TryRemoveIfAbsentAsync"/> is deliberately one operation rather than an exists-check
/// the caller acts on.</b> The liveness writer sets the per-instance key and then adds the index
/// member as two separate commands, so a caller that read "missing" and then removed could delete a
/// membership a restarting replica had re-added in between — evicting a live instance the gate would
/// then be unable to discover. Folding the condition into the removal is what closes that window.
/// </para>
/// </summary>
internal interface IL2InstanceIndexStore
{
    /// <summary>Every per-processor instance-index key currently present.</summary>
    Task<IReadOnlyList<string>> ListIndexKeysAsync(CancellationToken ct);

    /// <summary>The instance ids registered under one index key.</summary>
    Task<IReadOnlyList<string>> ListMembersAsync(string indexKey, CancellationToken ct);

    /// <summary>
    /// Removes <paramref name="instanceId"/> from <paramref name="indexKey"/> if and only if its
    /// per-instance key is absent at that moment. Returns whether the removal happened.
    /// </summary>
    Task<bool> TryRemoveIfAbsentAsync(string indexKey, string instanceId, CancellationToken ct);
}
