namespace Messaging.Contracts.Projections;

/// <summary>
/// Single source of truth for the L2 (Redis) projection key formats, so the writer and the reader
/// consume one shape and a future GUID-format or suffix change cannot silently desynchronize them.
/// <para>
/// The scheme is flat: a single prefix, a kind discriminator (<c>wf:</c>, <c>step:</c>, <c>proc:</c>,
/// <c>data:</c>) and a GUID, plus the one shared <c>skp:live</c> set. GUIDs render
/// in the default hyphenated "D" format, not the 32-digit "N" format; <see cref="Workflow"/> states
/// the <c>:D</c> specifier explicitly, which is byte-identical to a bare interpolation. The prefix is
/// a compile-time const owned here rather than a config value or a builder parameter, which removes
/// any config-injection path into key names.
/// </para>
/// <list type="bullet">
///   <item><description>Live: <c>skp:live</c> — SET of running workflow ids</description></item>
///   <item><description>Workflow: <c>skp:wf:{workflowId}</c> — HASH <c>name</c>, <c>store</c>, <c>roots</c></description></item>
///   <item><description>StepEntity: <c>skp:step:{stepId}</c> — HASH <c>name</c></description></item>
///   <item><description>Processor: <c>skp:proc:{processorId}</c> — HASH <c>name</c>, written by the processor, TTL</description></item>
///   <item><description>ProcessorInstances: <c>skp:proc:{processorId}:instances</c> — SET, TTL</description></item>
///   <item><description>PerInstance: <c>skp:proc:{processorId}:{instanceId}</c> — liveness, TTL</description></item>
///   <item><description>ProcessorShared: <c>skp:proc:{processorId}:shared</c> — SET of shared entry names, TTL</description></item>
///   <item><description>ProcessorSharedEntry: <c>skp:proc:{processorId}:shared:{name}</c> — one shared entry, TTL</description></item>
///   <item><description>Cache: <c>skp:wf:{workflowId}:cache:{root}</c> — one dictionary's key list</description></item>
///   <item><description>CacheEntry: <c>skp:wf:{workflowId}:cache:{root}:{key}</c> — one entry</description></item>
///   <item><description>StepRole: <c>skp:wf:{workflowId}:step:{stepId}</c> — HASH <c>role</c>, this workflow's role for the step</description></item>
///   <item><description>ExecutionData: <c>skp:data:{guid}</c> — the blob for both roles</description></item>
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

        // The length guard first: "skp:proc:instances" matches both the head and the suffix, which
        // overlap in it, and would otherwise slice a negative length.
        if (key is null
            || key.Length < head.Length + InstancesSuffix.Length
            || !key.StartsWith(head, StringComparison.Ordinal)
            || !key.EndsWith(InstancesSuffix, StringComparison.Ordinal))
        {
            return false;
        }

        var id = key.AsSpan(head.Length, key.Length - head.Length - InstancesSuffix.Length);
        return Guid.TryParseExact(id, "D", out processorId);
    }

    /// <summary>
    /// The cache root: the key holding the JSON array of key names in one projected dictionary.
    /// <para>
    /// <b>It nests under the workflow's own key.</b> Every entity kind has its own discriminator right
    /// after the prefix — <c>wf:</c>, <c>step:</c>, <c>proc:</c>, <c>data:</c> — so a cache key can
    /// collide with no other kind's key: it starts <c>skp:wf:</c>, which no step, processor or data key
    /// does. Within <c>skp:wf:{id}</c> it adds a literal <c>:cache:</c> segment, and the workflow hash
    /// itself has no suffix at all, so the two never meet. Nesting it there keeps every key a workflow
    /// owns under that workflow's one prefix.
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

    /// <summary>The role field on <see cref="StepRole"/>: entry, intermediate or terminal.</summary>
    public const string RoleField = "role";

    /// <summary>
    /// A step's role in ONE workflow. Nested under the workflow's key, not the global step key,
    /// because a step shared by two workflows can hold a different role in each. Written with the
    /// projection at start; a dropped step's key is deleted at the next start.
    /// </summary>
    public static string StepRole(Guid workflowId, Guid stepId) => $"{Workflow(workflowId)}:step:{stepId:D}";

    /// <summary>The per-instance processor-liveness key. <paramref name="instanceId"/> is the
    /// already-resolved pod identity — a plain string, not a Guid.</summary>
    public static string PerInstance(Guid processorId, string instanceId)
        => $"{Processor(processorId)}:{instanceId}";

    /// <summary>
    /// The index of a processor's shared entries: a SET of entry names, which every replica's heartbeat
    /// walks to refresh each entry's TTL. It exists so the refresh never has to scan for them.
    /// <para>
    /// Data here is visible to every replica of the processor and lives exactly as long as one of them
    /// does: each beat re-arms the liveness TTL on the index and on every entry it names, so the set
    /// and its entries expire together once the last replica stops beating.
    /// </para>
    /// </summary>
    public static string ProcessorShared(Guid processorId) => $"{Processor(processorId)}:shared";

    /// <summary>
    /// One shared entry. <paramref name="name"/> is interpolated verbatim and may itself contain
    /// colons (<c>bit:{hash}</c>); the <c>shared:</c> segment keeps every such name clear of the
    /// framework's own keys under <c>skp:proc:{id}</c>.
    /// </summary>
    public static string ProcessorSharedEntry(Guid processorId, string name)
        => $"{ProcessorShared(processorId)}:{name}";

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
}
