using BaseProcessor.Core.Processing;
using StackExchange.Redis;

namespace Processor.SKNormalizer;

/// <summary>
/// Reads one projected dictionary out of L2, under the address the step payload supplied.
/// <para>
/// <b>One key per lookup, composed and never scanned.</b> The address is the dictionary's root —
/// <c>skp:{workflowId}:cache:{root}</c> — and an entry is that string, a colon, and the field. The
/// writer forbids a colon in either half precisely so this concatenation cannot resolve to another
/// dictionary's entry.
/// </para>
/// <para>
/// <b>The read is synchronous, and deliberately so.</b> The handler stage that calls this is
/// synchronous down the whole pipeline, and one <c>StringGet</c> per item is cheaper than making
/// seven stages async to avoid it. It is a real synchronous API on the multiplexer, not a blocking
/// wait on a task.
/// </para>
/// <para>
/// <b>A missing ENTRY is a miss; a missing DICTIONARY is a defect, and the two are distinguishable
/// exactly.</b> <c>L2ProjectionWriter</c> always writes the cache root — an empty dictionary is
/// stored as <c>[]</c> rather than as nothing — so a root that is absent was never projected, while
/// a root holding <c>[]</c> is a deliberately empty whitelist. Without that distinction an address
/// pointing at nothing would cancel every document, which reads in the logs exactly like a list that
/// approves nobody: the failure this design refuses to make invisible.
/// </para>
/// <para>
/// <b>The root is checked once per instance, not once per lookup.</b> One whitelist is built per
/// dispatch and asked about every item in the document, so the check costs one extra read per
/// message. It is deliberately lazy: a handler that never consults the list — because the document
/// had no items — should not pay for a store round trip.
/// </para>
/// <para>
/// <b>Store faults are not caught here.</b> A <c>RedisConnectionException</c> or
/// <c>RedisTimeoutException</c> propagates out of the handler, where <c>ProcessDispatchHandler</c>
/// lets it escape and the consumer answers <c>RequeueAndTrip</c> — requeue, and pause on the L2 gate
/// until the store is healthy. Translating one into a miss would cancel a document over an outage;
/// into a failure, would burn it. Neither is what a redelivery would decide.
/// </para>
/// </summary>
internal sealed class RedisFieldWhitelist : IFieldWhitelist
{
    private readonly IConnectionMultiplexer _multiplexer;
    private readonly string _address;

    /// <summary>Set once the root has been seen, so the check costs one read per dispatch.</summary>
    private bool _dictionaryConfirmed;

    public RedisFieldWhitelist(IConnectionMultiplexer multiplexer, string address)
    {
        _multiplexer = multiplexer ?? throw new ArgumentNullException(nameof(multiplexer));

        if (string.IsNullOrWhiteSpace(address))
        {
            throw new ArgumentException("address must not be blank", nameof(address));
        }

        _address = address.Trim();
    }

    public bool TryGet(string field, out string? value)
    {
        value = null;

        if (string.IsNullOrWhiteSpace(field))
        {
            return false;
        }

        var db = _multiplexer.GetDatabase();

        EnsureDictionaryProjected(db);

        var stored = db.StringGet($"{_address}:{field}");

        if (stored.IsNullOrEmpty)
        {
            return false;
        }

        value = stored.ToString();
        return true;
    }

    /// <summary>
    /// Confirms, once, that a dictionary was actually projected at this address.
    /// <para>
    /// Deterministic on purpose: the address is wrong, or the workflow names no cache, and every
    /// redelivery answers the same way. A requeue would spin on a misconfiguration no retry can
    /// repair, and a cancel would report a business decision the whitelist never got to make.
    /// </para>
    /// </summary>
    private void EnsureDictionaryProjected(IDatabase db)
    {
        if (_dictionaryConfirmed)
        {
            return;
        }

        if (db.StringGet(_address).IsNullOrEmpty)
        {
            throw new FailedException(
                $"step payload rejected: no whitelist is projected at '{_address}'. Either the "
                + "workflow names no cache with that root, or the payload's cacheAddress is wrong.");
        }

        _dictionaryConfirmed = true;
    }
}
