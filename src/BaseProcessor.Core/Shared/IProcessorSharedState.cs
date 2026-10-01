namespace BaseProcessor.Core.Shared;

/// <summary>
/// Data one replica of a processor publishes for every replica of the same processor, which vanishes
/// once all of them are gone.
/// <para>
/// <b>Lifetime is the processor's liveness, not the writer's.</b> An entry is stored under
/// <c>skp:proc:{id}:shared:{name}</c> and its name added to the <c>skp:proc:{id}:shared</c> index;
/// every live replica's heartbeat re-arms the liveness TTL on both, whichever replica wrote it. The
/// entry therefore outlives the replica that wrote it and expires about one TTL after the last
/// replica stops beating. A rolling deploy never stops them all, so shared data survives image
/// changes: anything that must not should carry what distinguishes the image in its value or name.
/// </para>
/// <para>
/// <b>A fault reads as a miss, never as a failure.</b> The caller is expected to recompute what it
/// could not read, so a Redis outage costs a duplicate computation rather than a lost outcome.
/// </para>
/// </summary>
public interface IProcessorSharedState
{
    /// <summary>The entry's value, or null when it is absent, the store is unreachable, or this
    /// replica has not resolved its identity yet.</summary>
    Task<string?> GetAsync(string name);

    /// <summary>Publishes the entry to every replica. False when it could not be written; the fault
    /// is logged, and the caller keeps whatever it computed.</summary>
    Task<bool> SetAsync(string name, string value);
}
