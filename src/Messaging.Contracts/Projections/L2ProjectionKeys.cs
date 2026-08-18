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
///   <item><description>ExecutionData: <c>{Prefix}data:{entryId}</c> — the input data blob</description></item>
///   <item><description>OutputData: <c>{Prefix}out:{messageId}</c> — the per-message output blob</description></item>
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

    /// <summary>The input data blob key. No TTL is implied here — that is a caller concern.</summary>
    public static string ExecutionData(Guid entryId) => $"{Prefix}data:{entryId:D}";

    /// <summary>The per-message output blob key. The separate <c>out:</c> namespace keeps output
    /// blobs, keyed by message id, distinct from input blobs keyed by entry id. The TTL is a caller
    /// concern — see <see cref="OutputDataTtl"/>.</summary>
    public static string OutputData(Guid messageId) => $"{Prefix}out:{messageId:D}";

    /// <summary>
    /// The single source of truth for the output-blob TTL policy: a jittered value in
    /// [ttlSeconds, 2 × ttlSeconds]. Both the processor's output tail and the keeper's inject
    /// consumer call this, so a keeper-completed result and a directly-completed one cannot end up
    /// with desynchronized lifetimes. Only the policy is shared; the floor comes from each writer's
    /// own configured option.
    /// </summary>
    public static TimeSpan OutputDataTtl(int ttlSeconds)
        => TimeSpan.FromSeconds(Random.Shared.Next(ttlSeconds, 2 * ttlSeconds + 1));

    /// <summary>Probe scratch key — written then deleted, with a short TTL as the net for a crash
    /// between the two.</summary>
    public static string KeeperProbe(string h) => $"{Prefix}keeper:probe:{h}";
}
