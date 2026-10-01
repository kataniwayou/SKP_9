using BaseProcessor.Core.Identity;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Microsoft.Extensions.Logging;
using StackExchange.Redis;

namespace BaseProcessor.Core.Liveness;

/// <summary>
/// Writes the per-instance liveness key, keeps the instance index current, writes the processor's
/// own name hash, and re-arms the processor's shared entries.
/// <para>
/// A Redis fault is logged and swallowed. The caller is a loop whose next iteration will write
/// again, and a write failure must never end it. Liveness and name are reported under separate
/// templates, because only the first is what the start gate reads.
/// </para>
/// </summary>
public sealed class ProcessorLivenessWriter
{
    private readonly IConnectionMultiplexer _redis;
    private readonly ILogger<ProcessorLivenessWriter> _logger;

    public ProcessorLivenessWriter(
        IConnectionMultiplexer redis,
        ILogger<ProcessorLivenessWriter> logger)
    {
        _redis  = redis ?? throw new ArgumentNullException(nameof(redis));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    /// <summary>
    /// The key's lifetime: four times the interval the entry itself records.
    /// <para>
    /// Derived from the <b>entry's own</b> interval rather than live configuration, so each processor
    /// gets a TTL proportional to its own cadence and a slow one can never expire between its own
    /// writes. It also means a startup entry, which records the backoff anchor rather than the
    /// steady-state cadence, gets the longer lifetime its slower writes need.
    /// </para>
    /// <para>
    /// Four rather than two because the reader calls an entry stale at <c>interval x 2</c>. Expiring
    /// exactly then would collapse two distinct answers into one: a replica that registered and then
    /// wedged would vanish just as it became stale, and read as <c>absent</c> — indistinguishable
    /// from one deleted hours ago. The extra window is what keeps <c>stale</c> reportable, and it is
    /// deliberately proportional rather than a fixed floor, so the relationship holds at every
    /// configured cadence instead of only at the default one.
    /// </para>
    /// </summary>
    public static int DeriveTtlSeconds(int interval) => interval * 4;

    public async Task WriteAsync(ProcessorIdentity identity, string instanceId, ProcessorLivenessEntry entry)
    {
        ArgumentNullException.ThrowIfNull(identity);
        ArgumentNullException.ThrowIfNull(entry);

        IDatabase db;
        TimeSpan ttl;
        try
        {
            db = _redis.GetDatabase();
            ttl = TimeSpan.FromSeconds(DeriveTtlSeconds(entry.Interval));

            // Liveness first: it is what the start gate reads, so a failure of the name write below (a
            // WRONGTYPE against a pre-migration key, a timeout) must not cost it.
            //
            // When/flags passed explicitly, matching ProcessedDataHandler. Behaviourally identical to
            // the bare three-argument call, but StackExchange.Redis overloads that shape between a
            // keepTtl-bool overload and an Expiration-struct one — the compiler picks silently, and
            // that trap has already produced a test here that matched a method the code never called.
            // Naming all five parameters pins the overload for the reader and for the matcher.
            await db.StringSetAsync(
                L2ProjectionKeys.PerInstance(identity.Id, instanceId),
                System.Text.Json.JsonSerializer.Serialize(entry),
                ttl,
                When.Always,
                CommandFlags.None).ConfigureAwait(false);

            // The set gets the liveness TTL too, refreshed by every replica's beat: while one replica
            // lives the set stays and the sweeper prunes the dead members; once none does, the set
            // expires with them and nothing is left behind for BaseApi to clean.
            var instances = L2ProjectionKeys.ProcessorInstances(identity.Id);
            await db.SetAddAsync(instances, instanceId).ConfigureAwait(false);
            await db.KeyExpireAsync(instances, ttl, ExpireWhen.Always, CommandFlags.None).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            // The name write is skipped too: a store that just refused liveness would almost surely
            // refuse it as well, and one Warning per beat is enough to say so.
            _logger.LogWarning(ex, "liveness write failed for {ProcessorId}/{InstanceId}", identity.Id, instanceId);
            return;
        }

        // THE PROCESSOR OWNS ITS NAME. Written on every beat with the same TTL, so a flushed key heals
        // within one interval and a processor that is gone for good leaves nothing. The id suffix, never
        // the instance id: every replica writes this one key. Its own catch and its own template, so a
        // failure here is not reported as a liveness failure — liveness was written above.
        var processorKey = L2ProjectionKeys.Processor(identity.Id);
        var name = EntityNames.Format(identity.Name, identity.Version, identity.Id);
        try
        {
            try
            {
                await WriteNameAsync(db, processorKey, name, ttl).ConfigureAwait(false);
            }
            catch (RedisServerException ex) when (IsWrongType(ex))
            {
                // A pre-migration SET still sits at skp:proc:{id} (a rollout that deleted the retired
                // keys before every processor ran the new image, and an old-image replica re-created
                // it). This key is the processor's own (principle 6), so delete it and write once more.
                // A second WRONGTYPE — an old replica re-created it in between — falls to the catch
                // below and is retried next beat.
                await db.KeyDeleteAsync(processorKey).ConfigureAwait(false);
                await WriteNameAsync(db, processorKey, name, ttl).ConfigureAwait(false);
                _logger.LogInformation(
                    "processor name key for {ProcessorId} held a retired type; replaced it with the name hash",
                    identity.Id);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "processor name write failed for {ProcessorId}", identity.Id);
        }

        // Shared entries live as long as any replica does, so every replica re-arms all of them, not
        // only the ones it wrote. Last, with its own catch and template, for the same reason as the
        // name: liveness is what the start gate reads, and nothing after it may cost it.
        try
        {
            await RefreshSharedAsync(db, identity.Id, ttl).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "shared entry refresh failed for {ProcessorId}", identity.Id);
        }
    }

    /// <summary>
    /// Re-arms the shared index and every entry it names. A name whose entry has already expired is
    /// pruned from the index rather than kept: re-arming a missing key does nothing, so the line would
    /// otherwise sit there forever. If that races a fresh write of the same name, the entry survives
    /// unindexed and simply expires one TTL later — the writer recomputes it, a duplicate rather than
    /// a loss.
    /// </summary>
    private static async Task RefreshSharedAsync(IDatabase db, Guid processorId, TimeSpan ttl)
    {
        var index = L2ProjectionKeys.ProcessorShared(processorId);

        // No index, nothing shared: one round trip, which is all most processors ever pay.
        if (!await db.KeyExpireAsync(index, ttl, ExpireWhen.Always, CommandFlags.None).ConfigureAwait(false))
        {
            return;
        }

        foreach (var name in await db.SetMembersAsync(index).ConfigureAwait(false))
        {
            var entry = L2ProjectionKeys.ProcessorSharedEntry(processorId, name.ToString());

            if (!await db.KeyExpireAsync(entry, ttl, ExpireWhen.Always, CommandFlags.None).ConfigureAwait(false))
            {
                await db.SetRemoveAsync(index, name).ConfigureAwait(false);
            }
        }
    }

    private static async Task WriteNameAsync(IDatabase db, string processorKey, string name, TimeSpan ttl)
    {
        await db.HashSetAsync(processorKey, L2ProjectionKeys.NameField, name).ConfigureAwait(false);
        await db.KeyExpireAsync(processorKey, ttl, ExpireWhen.Always, CommandFlags.None).ConfigureAwait(false);
    }

    private static bool IsWrongType(RedisServerException ex)
        => ex.Message.StartsWith("WRONGTYPE", StringComparison.Ordinal);
}
