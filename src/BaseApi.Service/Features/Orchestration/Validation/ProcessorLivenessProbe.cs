using Messaging.Contracts.Projections;
using StackExchange.Redis;

namespace BaseApi.Service.Features.Orchestration.Validation;

/// <summary>One processor's replicas, each classified. Counts only: never instance ids.</summary>
internal sealed record ProcessorLiveness(Guid ProcessorId, int Replicas, int Healthy, int Absent, int Unhealthy, int Stale, int Malformed)
{
    /// <summary>A processor is live as soon as one replica is present, healthy and fresh.</summary>
    public bool Live => Healthy > 0;

    /// <summary>The start gate's refusal reason, worded exactly as it always was.</summary>
    public string Reason =>
        $"no healthy replica ({Replicas} checked: {Absent} absent, {Unhealthy} unhealthy, {Stale} stale, {Malformed} malformed)";
}

/// <summary>
/// Reads one processor's replicas from the instance-index set, with no prior knowledge of instance ids,
/// and classifies every per-instance entry: absent, malformed, unhealthy, stale or healthy. Shared by the
/// start gate and the liveness endpoint, so "live" means one thing.
/// <para>
/// <b>The reads are batched.</b> The index is fetched, then every per-instance read is issued before any
/// is awaited, so a processor costs two round trips however many replicas it has. Individual GETs rather
/// than one MGET: a multi-key command against a clustered Redis fails when the keys span hash slots, and
/// these do.
/// </para>
/// <para>
/// <b>Strictly read-only.</b> An index member whose key has expired is counted as absent and left alone;
/// pruning belongs to the orphan sweep. Each per-instance value is external, self-registered data, so
/// every bad state is counted rather than thrown. Only a transport fault propagates, untouched, and the
/// caller tags it.
/// </para>
/// </summary>
internal sealed class ProcessorLivenessProbe
{
    private readonly IConnectionMultiplexer _multiplexer;
    private readonly TimeProvider _clock;

    public ProcessorLivenessProbe(IConnectionMultiplexer multiplexer, TimeProvider clock)
    {
        _multiplexer = multiplexer ?? throw new ArgumentNullException(nameof(multiplexer));
        _clock = clock ?? throw new ArgumentNullException(nameof(clock));
    }

    public async Task<ProcessorLiveness> ProbeAsync(Guid processorId, CancellationToken ct)
    {
        // The Redis client takes no token of its own, so this is the only place cancellation can land.
        ct.ThrowIfCancellationRequested();

        var db = _multiplexer.GetDatabase();
        var now = _clock.GetUtcNow().UtcDateTime;
        var members = await db.SetMembersAsync(L2ProjectionKeys.ProcessorInstances(processorId));

        var reads = new Task<RedisValue>[members.Length];
        for (var i = 0; i < members.Length; i++)
        {
            reads[i] = db.StringGetAsync(L2ProjectionKeys.PerInstance(processorId, members[i].ToString()));
        }
        var values = await Task.WhenAll(reads);

        // The rule itself is shared with the orchestrator's fire gate: see ReplicaLivenessClassifier.
        int healthy = 0, absent = 0, unhealthy = 0, stale = 0, malformed = 0;
        foreach (var raw in values)
        {
            switch (ReplicaLivenessClassifier.Classify(raw.IsNullOrEmpty ? null : raw.ToString(), now))
            {
                case ReplicaLiveness.Absent:    absent++;    break;
                case ReplicaLiveness.Malformed: malformed++; break;
                case ReplicaLiveness.Unhealthy: unhealthy++; break;
                case ReplicaLiveness.Stale:     stale++;     break;
                case ReplicaLiveness.Healthy:   healthy++;   break;
            }
        }

        return new ProcessorLiveness(processorId, members.Length, healthy, absent, unhealthy, stale, malformed);
    }
}
