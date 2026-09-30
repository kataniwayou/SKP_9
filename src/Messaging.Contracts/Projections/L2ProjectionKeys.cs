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
///   <item><description>Live: <c>skp:live</c> — SET of running workflow ids</description></item>
///   <item><description>Workflow: <c>skp:wf:{workflowId}</c> — HASH <c>name</c>, <c>store</c>, <c>roots</c></description></item>
///   <item><description>StepEntity: <c>skp:step:{stepId}</c> — HASH <c>name</c></description></item>
///   <item><description>Processor: <c>skp:proc:{processorId}</c> — HASH <c>name</c>, written by the processor, TTL</description></item>
///   <item><description>ProcessorInstances: <c>skp:proc:{processorId}:instances</c> — SET, TTL</description></item>
///   <item><description>PerInstance: <c>skp:proc:{processorId}:{instanceId}</c> — liveness, TTL</description></item>
///   <item><description>Cache: <c>skp:wf:{workflowId}:cache:{root}</c> — one dictionary's key list</description></item>
///   <item><description>CacheEntry: <c>skp:wf:{workflowId}:cache:{root}:{key}</c> — one entry</description></item>
///   <item><description>ExecutionData: <c>skp:data:{guid}</c> — the blob for both roles</description></item>
///   <item><description>Retiring (removed by later tasks): ParentIndex <c>skp:</c>, Root <c>skp:{workflowId}</c>, Step <c>skp:{workflowId}:{stepId}</c>, InstanceIndex <c>skp:proc:{processorId}</c> as a SET, Name <c>skp:name:{id}</c></description></item>
/// </list>
/// </summary>
public static class L2ProjectionKeys
{
    public const string Prefix = "skp:";

    /// <summary>The display-name field on every entity hash.</summary>
    public const string NameField = "name";

    /// <summary>The flattened L1 structure on <see cref="Workflow"/>; see <see cref="WorkflowStoreProjection"/>.</summary>
    public const string StoreField = "store";

    /// <summary>The JSON list of cache roots on <see cref="Workflow"/>, read back by the next start to find its own leftovers.</summary>
    public const string RootsField = "roots";

    private const string InstancesSuffix = ":instances";

    /// <summary>The SET of running workflow ids: start adds, stop removes, hydration reads.</summary>
    public static string Live() => $"{Prefix}live";

    public static string Workflow(Guid workflowId) => $"{Prefix}wf:{workflowId:D}";

    /// <summary>A step's own key. Global, not per workflow: a step can be shared by several workflows.</summary>
    public static string StepEntity(Guid stepId) => $"{Prefix}step:{stepId:D}";

    /// <summary>A processor's name hash. Written only by the processor's own instances, with a TTL.</summary>
    public static string Processor(Guid processorId) => $"{Prefix}proc:{processorId:D}";

    public static string Entity(L2EntityKind kind, Guid id) => kind switch
    {
        L2EntityKind.Workflow  => Workflow(id),
        L2EntityKind.Step      => StepEntity(id),
        L2EntityKind.Processor => Processor(id),
        _ => throw new ArgumentOutOfRangeException(nameof(kind), kind, "unknown entity kind"),
    };

    /// <summary>The SET each replica adds its instance id to. TTL, refreshed by every heartbeat.</summary>
    public static string ProcessorInstances(Guid processorId) => $"{Processor(processorId)}{InstancesSuffix}";

    /// <summary>
    /// The inverse of <see cref="ProcessorInstances"/>, for the orphan sweeper, which finds these keys
    /// by scan and has to rebuild each member's <see cref="PerInstance"/> key from them.
    /// </summary>
    public static bool TryParseProcessorInstances(string key, out Guid processorId)
    {
        processorId = Guid.Empty;
        var head = $"{Prefix}proc:";

        if (key is null
            || !key.StartsWith(head, StringComparison.Ordinal)
            || !key.EndsWith(InstancesSuffix, StringComparison.Ordinal))
        {
            return false;
        }

        var id = key.AsSpan(head.Length, key.Length - head.Length - InstancesSuffix.Length);
        return Guid.TryParseExact(id, "D", out processorId);
    }

    public static string ParentIndex() => Prefix;

    public static string Root(Guid workflowId) => $"{Prefix}{workflowId:D}";

    public static string Step(Guid workflowId, Guid stepId) => $"{Prefix}{workflowId:D}:{stepId:D}";

    /// <summary>
    /// The cache root: the key holding the JSON array of key names in one projected dictionary.
    /// <para>
    /// <b>This is the first key to place a literal segment after the workflow id.</b> Every other
    /// discriminator in this scheme — <c>proc:</c>, <c>data:</c> — sits immediately after the
    /// prefix. It cannot collide with <see cref="Step"/>, because <c>cache</c> is not a GUID, and
    /// keeping a workflow's keys contiguous under one scan prefix is worth more here than symmetry
    /// with the other two.
    /// </para>
    /// <para>
    /// <paramref name="root"/> is interpolated verbatim, which is safe because the cache validator
    /// refuses a root containing a colon — the one character that could forge another address.
    /// </para>
    /// </summary>
    public static string Cache(Guid workflowId, string root)
        => $"{Workflow(workflowId)}:cache:{root}";

    /// <summary>
    /// One entry of a projected dictionary: exactly <see cref="Cache"/> followed by the key. The two
    /// must stay in that relationship, because cleanup reads the key list from the cache root and
    /// rebuilds every entry key from it.
    /// </summary>
    public static string CacheEntry(Guid workflowId, string root, string key)
        => $"{Cache(workflowId, root)}:{key}";

    /// <summary>The per-instance processor-liveness key. <paramref name="instanceId"/> is the
    /// already-resolved pod identity — a plain string, not a Guid.</summary>
    public static string PerInstance(Guid processorId, string instanceId)
        => $"{Processor(processorId)}:{instanceId}";

    /// <summary>The per-processor instance-index SET key that each replica adds its instance id to.
    /// It is exactly the prefix of <see cref="PerInstance"/> before the trailing instance id.</summary>
    public static string InstanceIndex(Guid processorId)
        => $"{Prefix}proc:{processorId:D}";

    /// <summary>
    /// The execution blob key, and the only one. A step's output is written here under the
    /// <c>EntryId</c> its branch minted, and read back by its successor under that same id as the
    /// successor's own <c>EntryId</c> — output and input are one blob under one key and one name, so
    /// the hand-off is a no-op rather than a copy.
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

    /// <summary>
    /// An entity's display name, <c>skp:name:{id}</c>: written by BaseApi on every start, read by the
    /// orchestrator and processors when they log. Its own namespace, so the orphan sweeper (which scans
    /// only <c>skp:proc:*</c> Sets) cannot see it, and it never collides with a workflow root
    /// (<c>skp:{id}</c>). Never deleted: entities are shared across workflows, and records keep
    /// arriving after a stop.
    /// </summary>
    public static string Name(Guid id) => $"{Prefix}name:{id:D}";
}
