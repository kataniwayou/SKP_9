using System.Text.Json;
using Messaging.Contracts.Projections;
using StackExchange.Redis;

namespace BaseApi.Service.Features.Orchestration.Validation;

/// <summary>
/// Per-replica processor-liveness gate. For each participating processor it discovers the replicas
/// from the instance-index set, with no prior knowledge of instance ids, then reads each
/// per-instance key and deserializes a <see cref="ProcessorLivenessEntry"/>.
/// <para>
/// A processor passes as soon as one discovered replica is present, healthy, and fresh — its
/// timestamp plus twice its interval, in seconds, still ahead of now. The first qualifying replica
/// short-circuits the scan, so one healthy replica admits the processor even when its siblings are
/// unhealthy, stale, absent or malformed. When none qualifies, it throws and becomes a 422 carrying
/// a count-only reason.
/// </para>
/// <para>
/// <b>The reads are batched per processor.</b> The index is fetched, then every per-instance read is
/// issued before any is awaited, so one processor costs two round trips however many replicas it has.
/// The short-circuit below then applies to deserialization only, not to I/O.
/// </para>
/// <para>
/// <b>This gate is strictly read-only.</b> It reads the index and the per-instance keys and writes
/// nothing — an index member whose key has expired is counted as absent and left alone. Reclaiming
/// those members belongs to a background sweep, not to a request path: pruning here could only ever
/// clean the members it happened to read before the short-circuit, and a prune racing a replica's
/// re-registration would evict a processor that had just come back.
/// </para>
/// </summary>
internal sealed class ProcessorLivenessValidator
{
    private readonly IConnectionMultiplexer _multiplexer;
    private readonly TimeProvider _clock;

    public ProcessorLivenessValidator(IConnectionMultiplexer multiplexer, TimeProvider clock)
    {
        _multiplexer = multiplexer ?? throw new ArgumentNullException(nameof(multiplexer));
        _clock       = clock ?? throw new ArgumentNullException(nameof(clock));
    }

    public async Task ValidateAsync(WorkflowGraphSnapshot snapshot, CancellationToken ct)
    {
        var db = _multiplexer.GetDatabase();
        var now = _clock.GetUtcNow().UtcDateTime;
        foreach (var proc in snapshot.Processors.Values)
        {
            // Checked per processor rather than per replica: it is the coarsest granularity that
            // still bounds the work, since everything below is a single pipelined batch. The Redis
            // client takes no token of its own, so this is the only place cancellation can land.
            ct.ThrowIfCancellationRequested();

            var members = await db.SetMembersAsync(L2ProjectionKeys.InstanceIndex(proc.Id));

            // Every read is issued BEFORE any is awaited, so the client writes them to the connection
            // as one batch and the cost is a single round trip's latency instead of one per replica.
            // That matters only when the news is bad — a healthy processor short-circuits below — but
            // bad news is exactly when a workflow with many processors would otherwise turn a start
            // request into a long serial walk.
            //
            // Deliberately individual GETs rather than one MGET: a multi-key command against a
            // clustered Redis fails outright when the keys span hash slots, and these keys do, since
            // the instance id is the part that varies. Pipelined single-key reads cost the same and
            // carry no such constraint.
            var reads = new Task<RedisValue>[members.Length];
            for (var i = 0; i < members.Length; i++)
            {
                reads[i] = db.StringGetAsync(L2ProjectionKeys.PerInstance(proc.Id, members[i].ToString()));
            }

            var values = await Task.WhenAll(reads);

            int absent = 0, unhealthy = 0, stale = 0, malformed = 0;
            bool qualified = false;

            // Each per-instance value is external, self-registered data this service does not own, so
            // every deterministic bad state maps to a counted 422 rather than escaping as an
            // exception: a missing key is absent, invalid JSON or a null summary is malformed, a
            // non-healthy status is unhealthy, and an expired window is stale. Only a genuine
            // transport fault propagates untouched to the caller, which tags it and returns a 500.
            // This validator deliberately adds no Redis catch — the 422-versus-500 split lives in the
            // caller.
            foreach (var raw in values)
            {
                if (raw.IsNullOrEmpty)
                {
                    absent++;
                    continue;
                }

                ProcessorLivenessEntry? entry;
                try { entry = JsonSerializer.Deserialize<ProcessorLivenessEntry>(raw!); }
                // Any deserialization failure on external data counts as malformed, never a 500. The
                // serializer can also raise an unsupported-conversion error, and the read that
                // produced the value already succeeded, so no transport fault originates here.
                catch (Exception ex) when (ex is JsonException or NotSupportedException) { malformed++; continue; }
                if (entry?.Summary is null) { malformed++; continue; }    // a null shape fails that replica
                // Ordinal compare: case sensitivity is intentional, since the writer is the sole
                // producer and always emits the canonical constant.
                if (!string.Equals(entry.Status, LivenessStatus.Healthy, StringComparison.Ordinal)) { unhealthy++; continue; }
                if (entry.Timestamp.AddSeconds(entry.Interval * 2) <= now) { stale++; continue; }
                qualified = true; break;   // one healthy and fresh replica is enough to admit the processor
            }

            if (!qualified)
            {
                // Counts only — never instance ids, connection strings or stack traces. Because the
                // loop above only breaks on success, a failure has classified every replica, so these
                // sum to the number checked.
                var reason = $"no healthy replica ({members.Length} checked: " +
                             $"{absent} absent, {unhealthy} unhealthy, {stale} stale, {malformed} malformed)";
                throw OrchestrationValidationException.ProcessorNotLive(proc.Id, reason);
            }
        }
    }
}
