namespace Messaging.Contracts;

/// <summary>
/// The single definition of the orchestrator fan-out exchange and of each replica's own queue name,
/// shared by the API that publishes and the orchestrator that consumes.
/// <para>
/// <b>One definition, and that is a requirement rather than a preference.</b> These queues are
/// non-exclusive, so two replicas resolving to the SAME name does not raise <c>RESOURCE_LOCKED</c> and
/// does not fail loudly anywhere. It silently degrades the broadcast into a competing-consumer
/// load-balance: each announcement reaches one replica instead of three, the other two keep a stale
/// L1 and a stale schedule, and nothing in the transport reports it. A second definition of this
/// string, in either service, reintroduces that failure.
/// </para>
/// <para>
/// <b>Durable, never auto-delete.</b> A replica that is down must accumulate its announcements and
/// drain them on return; an auto-delete queue would drop them with nothing parked and nothing logged.
/// The cost is that a queue outlives a replica that is removed for good, which is why the orchestrator
/// StatefulSet does not scale down.
/// </para>
/// </summary>
public static class OrchestratorFanout
{
    /// <summary>The fan-out exchange every replica queue binds to.</summary>
    public const string Exchange = "orchestrator-fanout";

    /// <summary>
    /// The dead-letter exchange the per-replica queues name. It must be declared before any queue
    /// naming it: the argument is not validated at declare time, so a queue pointing at a missing
    /// exchange is accepted and discards everything it parks, silently.
    /// </summary>
    public const string DeadLetterExchange = "orchestrator-fanout-dlx";

    /// <summary>
    /// This replica's own durable queue: <c>orchestrator-control.{instanceId}</c>. The instance id is
    /// BaseConsole.Core's resolved replica identity — a StatefulSet ordinal in
    /// production — so a restarted pod reclaims the same queue and drains its backlog.
    /// </summary>
    public static string PerReplica(string instanceId) => $"orchestrator-control.{instanceId}";

    /// <summary>Where <see cref="PerReplica"/> parks a message it cannot read.</summary>
    public static string Dead(string instanceId) => $"{PerReplica(instanceId)}.dead";
}
