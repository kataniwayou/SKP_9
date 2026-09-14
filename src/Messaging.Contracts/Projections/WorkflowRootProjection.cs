using System.Text.Json.Serialization;

namespace Messaging.Contracts.Projections;

/// <summary>
/// L2 root projection value for the <c>{prefix}{workflowId}</c> key — the stored definition of one
/// workflow, and the record of which keys make it up.
/// <para>
/// <b>There is no job id.</b> A scheduler needs a stable key per workflow, and the workflow id is
/// already exactly that; a second identity for the same thing has to be minted somewhere, kept in
/// step with the first, and looked up before the job it names can be deleted. Keying the job on the
/// workflow id instead makes teardown addressable without a lookup — so a job whose stored state was
/// lost can still be cancelled, which a job addressed by a stored id cannot.
/// </para>
/// <para>
/// <b>There is no correlation id.</b> The projection is keyed by workflow id and is overwritten
/// wholesale on every start, so a stored request id would describe whichever start happened to write
/// last — a fact about the write, recorded as though it were a fact about the workflow.
/// </para>
/// <para>
/// The <c>[property: ...]</c> attribute targets are load-bearing: on a positional record a bare
/// attribute binds to the constructor parameter, which the serializer ignores.
/// </para>
/// </summary>
/// <param name="EntryStepIds">The steps a fire begins from.</param>
/// <param name="StepIds">
/// Every step key written alongside this root — the workflow's complete key set, recorded by the
/// writer rather than rediscovered by a reader.
/// <para>
/// <b>This exists so removal can be exact.</b> The alternative is to find the step keys by walking
/// the graph from <see cref="EntryStepIds"/>, which costs one read per step and — worse — is only as
/// complete as the graph is connected: a step key that is already missing stops the walk, stranding
/// every step downstream of it with nothing that will ever collect them. A recorded list is one read,
/// and it does not care whether the graph still hangs together.
/// </para>
/// <para>
/// It must list every step the write touched, including ones unreachable from the entry steps.
/// Writing a partial list is worse than writing none, because the keys it omits become permanently
/// invisible to the only thing that deletes them.
/// </para>
/// </param>
/// <param name="Cron">The cron expression, or null when the workflow is not scheduled.</param>
/// <param name="Liveness">Freshness of the projection, stamped by the writer.</param>
/// <param name="CacheRoots">
/// The roots of every dictionary this workflow projected — names only. Nothing else records which
/// roots exist for a workflow, and discovering them with a SCAN is the walk this design refuses
/// everywhere else.
/// <para>
/// <b>The keys under each root are recorded at that root, not here, and that split is
/// deliberate.</b> The step-key list lives here because a step key names its successors, so a
/// missing one strands everything beyond it. A cache root names nothing — its key list is a flat
/// leaf — so keeping it at the root costs one extra read at stop and buys the property the flat key
/// layout exists for: an operator reading one key sees the dictionary's contents by name.
/// </para>
/// <para>Null for a root written before caches existed, and read as empty.</para>
/// </param>
public sealed record WorkflowRootProjection(
    [property: JsonPropertyName("entryStepIds")] List<Guid> EntryStepIds,
    [property: JsonPropertyName("stepIds")]      List<Guid> StepIds,
    [property: JsonPropertyName("cron")]         string? Cron,
    [property: JsonPropertyName("liveness")]     LivenessProjection Liveness,
    [property: JsonPropertyName("cacheRoots")]   List<string>? CacheRoots = null);
