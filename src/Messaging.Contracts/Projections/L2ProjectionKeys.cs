namespace Messaging.Contracts.Projections;

/// <summary>
/// Single source of truth for the L2 (Redis) projection key formats, so the writer and the reader
/// consume one shape and a future GUID-format or suffix change cannot silently desynchronize them.
/// <para>
/// The scheme is flat: a single prefix followed by GUIDs, with no type discriminator. GUIDs render
/// in the default hyphenated "D" format, not the 32-digit "N" format; <see cref="Root"/> states the
/// <c>:D</c> specifier explicitly, which is byte-identical to a bare interpolation. The prefix is a
/// compile-time const owned here rather than a config value or a builder parameter, which removes
/// any config-injection path into key names.
/// </para>
/// <list type="bullet">
///   <item><description>ParentIndex: <c>{Prefix}</c> — the bare prefix, used as the parent-index SET key</description></item>
///   <item><description>Root: <c>{Prefix}{workflowId}</c></description></item>
///   <item><description>Step: <c>{Prefix}{workflowId}:{stepId}</c></description></item>
///   <item><description>PerInstance: <c>{Prefix}proc:{processorId}:{instanceId}</c> — the per-replica liveness key</description></item>
///   <item><description>InstanceIndex: <c>{Prefix}proc:{processorId}</c> — the per-processor instance-index SET key</description></item>
///   <item><description>ExecutionData: <c>{Prefix}data:{guid}</c> — the blob for both roles</description></item>
/// </list>
/// </summary>
public static class L2ProjectionKeys
{
    public const string Prefix = "skp:";

    public static string ParentIndex() => Prefix;

    public static string Root(Guid workflowId) => $"{Prefix}{workflowId:D}";

    public static string Step(Guid workflowId, Guid stepId) => $"{Prefix}{workflowId:D}:{stepId:D}";

    /// <summary>The per-instance processor-liveness key. <paramref name="instanceId"/> is the
    /// already-resolved pod identity — a plain string, not a Guid.</summary>
    public static string PerInstance(Guid processorId, string instanceId)
        => $"{Prefix}proc:{processorId:D}:{instanceId}";

    /// <summary>The per-processor instance-index SET key that each replica adds its instance id to.
    /// It is exactly the prefix of <see cref="PerInstance"/> before the trailing instance id.</summary>
    public static string InstanceIndex(Guid processorId)
        => $"{Prefix}proc:{processorId:D}";

    /// <summary>
    /// The execution blob key, and the only one. A step's output is written here under its
    /// <c>MessageId</c> and read back by its successor under that same id as the successor's
    /// <c>EntryId</c> — output and input are one blob under one key, so the hand-off is a no-op
    /// rather than a copy.
    /// <para>
    /// <b>No TTL, ever.</b> Reclaim is explicit: the pre handler deletes the key once its author's
    /// transform returns normally, and the orchestrator reclaims the two keys no pre hop ever comes
    /// for — a failed step's input, and the terminal step's output. An expiry
    /// here would delete a live workflow's input during a slow hand-off, which is a silent loss —
    /// and loss is the one outcome this design refuses. An unreclaimed key has no automatic reclaimer
    /// today: <c>L2OrphanSweeper</c> covers stale liveness-index entries left by dead processor
    /// replicas, not <c>data:</c> keys, so it cannot be pointed to as a backstop for this one.
    /// </para>
    /// </summary>
    public static string ExecutionData(Guid entryId) => $"{Prefix}data:{entryId:D}";

    /// <summary>Probe scratch key — written then deleted, with a short TTL as the net for a crash
    /// between the two.</summary>
    public static string KeeperProbe(string h) => $"{Prefix}keeper:probe:{h}";
}
