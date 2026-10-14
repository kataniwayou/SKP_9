using Messaging.Contracts.Projections;
using StackExchange.Redis;

namespace Orchestrator.Scheduling;

/// <summary>
/// One processor's answer from the fire-time liveness read.
/// </summary>
/// <param name="ProcessorId">The processor.</param>
/// <param name="Live">At least one replica classified <see cref="ReplicaLiveness.Healthy"/>.</param>
/// <param name="Fault">
/// The Redis fault that stopped this processor from being read, or null when it was read. A faulted
/// processor is never <paramref name="Live"/>: the caller decides from the fault whether that was the
/// store (trip the gate) or the key (log it), but either way the fire does not dispatch.
/// </param>
public sealed record ProcessorLivenessVerdict(Guid ProcessorId, bool Live, Exception? Fault = null);

/// <summary>
/// Reads whether each of a workflow's processors has at least one live replica — the fire's liveness
/// gate. See <see cref="WorkflowFireJob"/> for where it sits and what a "no" costs.
/// </summary>
public interface IProcessorLivenessCheck
{
    /// <summary>
    /// One verdict per processor in <paramref name="indexKeys"/>, in no particular order. Never throws
    /// for a Redis fault: each one is captured on the verdict of the processor it belongs to, so the
    /// caller can name it and so one bad key does not hide the state of the others.
    /// </summary>
    /// <param name="indexKeys">Processor id to its instance-index key, as L1 holds them.</param>
    Task<IReadOnlyList<ProcessorLivenessVerdict>> ReadAsync(IReadOnlyDictionary<Guid, string> indexKeys);
}

/// <summary>
/// The Redis read behind <see cref="IProcessorLivenessCheck"/>: each processor's instance index, then
/// every replica's per-instance value, classified by the shared <see cref="ReplicaLivenessClassifier"/>
/// — the same rule the API's start gate applies, so a processor that gate admitted is one this one
/// dispatches to.
/// <para>
/// <b>Two round trips per fire, however many processors.</b> Every index read is issued before any is
/// awaited, then every per-instance read the same way. Individual GETs rather than one MGET: a multi-key
/// command against a clustered Redis fails when the keys span hash slots, and these do.
/// </para>
/// <para>
/// <b>Each read is awaited on its own, under its own catch.</b> A <c>Task.WhenAll</c> would surface one
/// fault and drop the attribution: the fire could not say which processor's key was broken, and a
/// deterministic fault — a WRONGTYPE on one index — repeats every tick until someone finds that key.
/// </para>
/// <para>
/// <b>Strictly read-only.</b> An index member whose key has expired classifies as absent and is left
/// alone; pruning belongs to the orphan sweep.
/// </para>
/// </summary>
public sealed class ProcessorLivenessCheck(IConnectionMultiplexer redis, TimeProvider clock)
    : IProcessorLivenessCheck
{
    public async Task<IReadOnlyList<ProcessorLivenessVerdict>> ReadAsync(
        IReadOnlyDictionary<Guid, string> indexKeys)
    {
        ArgumentNullException.ThrowIfNull(indexKeys);

        var db = redis.GetDatabase();

        // Round trip one: every index, issued before any is awaited.
        var indexReads = indexKeys
            .Select(p => (ProcessorId: p.Key, Read: Issue(() => db.SetMembersAsync(p.Value))))
            .ToList();

        var verdicts = new List<ProcessorLivenessVerdict>(indexReads.Count);
        var replicaReads = new List<(Guid ProcessorId, Task<RedisValue>[] Reads)>(indexReads.Count);

        foreach (var (processorId, read) in indexReads)
        {
            try
            {
                var members = await read.ConfigureAwait(false);

                // Round trip two is issued here, per processor as its index lands, and awaited below.
                replicaReads.Add((processorId, members
                    .Select(m => Issue(() => db.StringGetAsync(L2ProjectionKeys.PerInstance(processorId, m.ToString()))))
                    .ToArray()));
            }
            catch (Exception ex)
            {
                verdicts.Add(new ProcessorLivenessVerdict(processorId, Live: false, ex));
            }
        }

        // One clock read for the whole fire, so every replica is judged against the same instant.
        var now = clock.GetUtcNow().UtcDateTime;

        foreach (var (processorId, reads) in replicaReads)
        {
            var live = false;
            Exception? fault = null;

            // Every read is awaited even after a healthy one: an abandoned faulted task is an
            // unobserved exception, and the fault is worth reporting even when the answer is known.
            foreach (var read in reads)
            {
                try
                {
                    var raw = await read.ConfigureAwait(false);
                    live |= ReplicaLivenessClassifier.Classify(
                        raw.IsNullOrEmpty ? null : raw.ToString(), now) == ReplicaLiveness.Healthy;
                }
                catch (Exception ex)
                {
                    fault ??= ex;
                }
            }

            verdicts.Add(new ProcessorLivenessVerdict(processorId, live && fault is null, fault));
        }

        return verdicts;
    }

    /// <summary>
    /// Starts one read, turning a synchronous throw into a faulted task so it lands on the verdict of the
    /// processor it belongs to like any other fault, rather than escaping the whole read.
    /// </summary>
    private static Task<T> Issue<T>(Func<Task<T>> read)
    {
        try
        {
            return read();
        }
        catch (Exception ex)
        {
            return Task.FromException<T>(ex);
        }
    }
}
