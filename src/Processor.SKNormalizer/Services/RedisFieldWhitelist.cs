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
/// <b>A missing key is a miss, not a fault.</b> "Not on the list" is the answer the caller asked
/// for, and it is the answer whether the dictionary omits the field or the whole dictionary was
/// never projected. Distinguishing those would mean a second round trip to learn something no
/// caller acts on differently.
/// </para>
/// </summary>
internal sealed class RedisFieldWhitelist : IFieldWhitelist
{
    private readonly IConnectionMultiplexer _multiplexer;
    private readonly string _address;

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

        var stored = _multiplexer.GetDatabase().StringGet($"{_address}:{field}");

        if (stored.IsNullOrEmpty)
        {
            return false;
        }

        value = stored.ToString();
        return true;
    }
}
