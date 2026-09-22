using BaseProcessor.Core.Processing;
using Microsoft.Extensions.Logging;
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
/// <para>
/// <b>Every decision is logged here rather than in the handler, and that is what makes the board
/// possible.</b> A handler could write its own line, but then each one would name the value and the
/// verdict differently and no single query could count them. Logging at the only place a lookup
/// actually happens gives every present and future gated field one attribute shape for free. See
/// <see cref="TryGet"/> for what the three attributes are and why the value is among them.
/// </para>
/// </summary>
internal sealed class RedisFieldWhitelist : IFieldWhitelist
{
    private readonly IConnectionMultiplexer _multiplexer;
    private readonly ILogger<RedisFieldWhitelist> _logger;
    private readonly string _address;
    private readonly string _root;

    /// <summary>Set once the root has been seen, so the check costs one read per dispatch.</summary>
    private bool _dictionaryConfirmed;

    public RedisFieldWhitelist(
        IConnectionMultiplexer multiplexer, string address, ILogger<RedisFieldWhitelist> logger)
    {
        _multiplexer = multiplexer ?? throw new ArgumentNullException(nameof(multiplexer));

        // REQUIRED, NOT OPTIONAL. A defaulted null logger would let a wiring mistake drop every
        // verdict silently, and an empty board reads exactly like a step nobody ran.
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));

        if (string.IsNullOrWhiteSpace(address))
        {
            throw new ArgumentException("address must not be blank", nameof(address));
        }

        _address = address.Trim();

        // THE ROOT IS THE LAST SEGMENT, and that is safe because L2ProjectionKeys refuses a root
        // containing a colon — the same rule that stops one address forging another. Taken from the
        // address rather than accepted as a second argument so the two cannot disagree: a caller
        // that passed the wrong name would label a whole board's worth of verdicts with a list they
        // did not come from.
        var lastSeparator = _address.LastIndexOf(':');
        _root = lastSeparator >= 0 && lastSeparator < _address.Length - 1
            ? _address[(lastSeparator + 1)..]
            : _address;
    }

    /// <summary>
    /// Looks the field up, and records the decision under three attributes.
    /// <para>
    /// <b><c>WhitelistRoot</c>, <c>WhitelistValue</c>, <c>WhitelistVerdict</c> — scoped, never
    /// templated.</b> The message carries only the verdict and the root, both of which are
    /// system-authored; the value reaches the record as an attribute. Scoping is what makes it a
    /// field a board can slice on instead of prose a query has to match inside.
    /// </para>
    /// <para>
    /// <b>The value is upstream content, and putting it here is a deliberate exception to the rule
    /// that keeps item keys and field values out of logs.</b> The exception already existed on one
    /// side: an unlisted value reaches the log store today, verbatim, inside the author's cancel
    /// reason, because an operator cannot decide whether to add a value to a list they cannot see.
    /// This extends that same judgement to the listed side, for the same reason — a board showing
    /// only rejections cannot tell an operator what proportion of traffic the list admits.
    /// </para>
    /// <para>
    /// <b>Both branches log at Information, on one template.</b> Demoting hits to Debug would be the
    /// obvious economy and it would quietly break the board: any deployment filtering below
    /// Information would drop every hit and render a pie chart reading 100% unlisted, which is
    /// indistinguishable from a list that approves nobody.
    /// </para>
    /// <para>
    /// <b>A blank field is not a verdict and is not logged.</b> The list never saw it, so counting it
    /// as a miss would put a caller's own defect into a chart measuring upstream data.
    /// </para>
    /// </summary>
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
        var listed = !stored.IsNullOrEmpty;

        Record(field, listed);

        if (!listed)
        {
            return false;
        }

        value = stored.ToString();
        return true;
    }

    /// <summary>
    /// Writes the one record per lookup that the whitelist board counts.
    /// <para>
    /// The canonical form a hit resolves to is deliberately NOT among the attributes. It is the same
    /// value for every occurrence of a listed field, so it would add a second slice-by dimension
    /// that never says anything the first one did not — while doubling the upstream content this
    /// record carries.
    /// </para>
    /// </summary>
    private void Record(string field, bool listed)
    {
        var verdict = listed ? "Listed" : "Unlisted";

        using (_logger.BeginScope(new Dictionary<string, object>
        {
            ["WhitelistRoot"] = _root,
            ["WhitelistValue"] = field,
            ["WhitelistVerdict"] = verdict,
        }))
        {
            _logger.LogInformation(
                "the whitelist {WhitelistRoot} answered {WhitelistVerdict}", _root, verdict);
        }
    }

    /// <summary>
    /// Confirms, once, that a dictionary was actually projected at this address.
    /// <para>
    /// Deterministic on purpose: the address is wrong, or the workflow names no cache, and every
    /// redelivery answers the same way. A requeue would spin on a misconfiguration no retry can
    /// repair, and a cancel would report a business decision the whitelist never got to make.
    /// </para>
    /// <para>
    /// <b>It throws instead of recording a verdict, and the board depends on that.</b> "There is no
    /// list" is not an answer a list gave; counting it as Unlisted would put a configuration defect
    /// into a chart an operator reads as upstream behaviour, which is the precise conflation
    /// <see cref="UnconfiguredFieldWhitelist"/> exists to prevent.
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
