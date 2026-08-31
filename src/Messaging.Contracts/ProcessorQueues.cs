namespace Messaging.Contracts;

/// <summary>
/// Single source of truth for the API responder queue endpoint names, shared between the API, which
/// binds the receive endpoints, and the processor request clients that send to them. Bare
/// short-names, no scheme prefix.
/// </summary>
public static class ProcessorQueues
{
    public const string IdentityQuery = "processor-identity-query";
    public const string SchemaQuery   = "schema-definition-query";

    /// <summary>
    /// The per-processor work queue, carrying the dispatches this processor is asked to run. Named
    /// rather than a bare GUID: every other queue here is a readable short-name, and a bare GUID is
    /// unidentifiable in the broker's management UI.
    /// <para>
    /// <b>The advance half of the pair</b> — see <see cref="Post"/> for the other half and for why
    /// the two are separate queues rather than one routed by type header.
    /// </para>
    /// </summary>
    public static string Work(Guid processorId) => $"processor-{processorId:D}";

    /// <summary>Where <see cref="Work"/> parks a message it cannot read.</summary>
    public static string Dead(Guid processorId) => $"processor-{processorId:D}.dead";

    /// <summary>
    /// The per-processor post queue, carrying the branches an author hands off during its own run.
    /// <para>
    /// <b>A separate queue rather than a second message type on <see cref="Work"/>, and the reason is
    /// the one the orchestrator's own pair is built on.</b> The advance hop mints a fresh key per
    /// branch and cannot be replayed without minting new ones; the hop that consumes this queue writes
    /// <c>L2[EntryId] = Data</c> from the message alone, so it is idempotent under any number of
    /// redeliveries. Splitting them puts the replayable half on its own delivery, its own retry and
    /// its own dead-letter queue.
    /// </para>
    /// <para>
    /// <b>It also removes a starvation shape one queue cannot avoid.</b> Prefetch is 1 per consumer,
    /// so on a single shared queue a replica running an author has its only slot occupied — and an
    /// author is the one stage in this system with no bound on how long it runs. With every replica
    /// mid-transform, branch work waited behind them however many replicas there were. A queue of its
    /// own reserves a slot for it.
    /// </para>
    /// </summary>
    public static string Post(Guid processorId) => $"processor-{processorId:D}-post";

    /// <summary>Where <see cref="Post"/> parks a message it cannot read.</summary>
    public static string PostDead(Guid processorId) => $"processor-{processorId:D}-post.dead";

    /// <summary>
    /// The exchange <see cref="Work"/> and <see cref="Post"/> both name in their
    /// <c>x-dead-letter-exchange</c> argument; one exchange serves both, the two dead queues being
    /// distinguished by routing key. It must
    /// be declared before the queue that names it: the argument is not validated at declare time, so
    /// a queue pointing at a missing exchange is accepted and silently discards everything it parks.
    /// </summary>
    public const string DeadLetterExchange = "processor-dlx";
}
