using NSubstitute;
using StackExchange.Redis;

namespace BaseApi.Tests.Support;

/// <summary>
/// An L2 that actually stores what is written to it: strings and sets in two dictionaries, behind a
/// substituted <see cref="IConnectionMultiplexer"/>.
/// <para>
/// <b>Why a store rather than the usual per-key stubs.</b> Stubbing <c>StringGetAsync</c> to return a
/// canned root answers "what does the code do when L2 says X". Idempotency is a different question —
/// "does running this twice leave the same L2" — and it cannot be asked of a store whose answers are
/// fixed in advance, because the second run would read the stub rather than the first run's writes.
/// Assertions here are about the resulting key space, so a write that leaks a key or a clean that
/// misses one shows up as state, not as a call count that happened to match.
/// </para>
/// <para>
/// <b>The batch applies eagerly.</b> A real <see cref="IBatch"/> queues its operations and dispatches
/// them on <see cref="IBatch.Execute"/>; here each call mutates the store as it is made and
/// <c>Execute</c> does nothing. Every batch these paths build writes or deletes independent keys and
/// then awaits the whole set, so no ordering within a batch is observable — what a batch buys them is
/// that the operations travel together, which a test against a local dictionary cannot lose. What
/// this does <i>not</i> model is a batch failing part-way; a test that needs that should fault a
/// specific call instead.
/// </para>
/// </summary>
internal sealed class InMemoryL2
{
    private readonly Dictionary<string, string> _strings = new(StringComparer.Ordinal);
    private readonly Dictionary<string, SortedSet<string>> _sets = new(StringComparer.Ordinal);

    public InMemoryL2()
    {
        Db = Substitute.For<IDatabase>();
        var batch = Substitute.For<IBatch>();

        Wire(Db);
        Wire(batch);

        Db.CreateBatch().Returns(batch);

        Multiplexer = Substitute.For<IConnectionMultiplexer>();
        Multiplexer.GetDatabase().Returns(Db);
    }

    public IConnectionMultiplexer Multiplexer { get; }

    /// <summary>Exposed so a test can fault one operation on top of the working store.</summary>
    public IDatabase Db { get; }

    /// <summary>Whether a key holds a value right now.</summary>
    public bool Has(string key) => _strings.ContainsKey(key);

    /// <summary>The value under <paramref name="key"/>, or null.</summary>
    public string? Value(string key) => _strings.TryGetValue(key, out var v) ? v : null;

    /// <summary>The members of a set key, sorted, empty when the key is absent.</summary>
    public IReadOnlyList<string> Members(string key)
        => _sets.TryGetValue(key, out var set) ? set.ToList() : [];

    /// <summary>Every string key that holds a value, sorted.</summary>
    public IReadOnlyList<string> Keys() => _strings.Keys.Order(StringComparer.Ordinal).ToList();

    /// <summary>
    /// The whole store as one canonical string: every string key with its value, then every set key
    /// with its members, all sorted. Two runs that left L2 in the same state produce the same text,
    /// so a test can assert convergence without naming the keys it expects.
    /// </summary>
    public string Snapshot()
    {
        var lines = _strings
            .Select(kv => $"str {kv.Key} = {kv.Value}")
            .Concat(_sets.Where(kv => kv.Value.Count > 0)
                .Select(kv => $"set {kv.Key} = [{string.Join(",", kv.Value)}]"))
            .Order(StringComparer.Ordinal);

        return string.Join("\n", lines);
    }

    /// <summary>
    /// Drops a set member behind the code's back, to stage the state a clean that was interrupted
    /// after its index removal leaves: the index entry gone, the root and step keys still there.
    /// </summary>
    public void ForgetMember(string key, string member)
    {
        if (_sets.TryGetValue(key, out var set))
        {
            set.Remove(member);
        }
    }

    /// <summary>
    /// Backs the six operations these paths use onto the dictionaries. <see cref="IBatch"/> derives
    /// from <see cref="IDatabaseAsync"/>, so the database and its batches are wired by one method and
    /// cannot drift apart.
    /// </summary>
    private void Wire(IDatabaseAsync target)
    {
        target.StringSetAsync(Arg.Any<RedisKey>(), Arg.Any<RedisValue>())
            .Returns(ci =>
            {
                _strings[ci.ArgAt<RedisKey>(0).ToString()] = ci.ArgAt<RedisValue>(1).ToString();
                return true;
            });

        target.StringGetAsync(Arg.Any<RedisKey>())
            .Returns(ci => _strings.TryGetValue(ci.ArgAt<RedisKey>(0).ToString(), out var value)
                ? (RedisValue)value
                : RedisValue.Null);

        target.KeyExistsAsync(Arg.Any<RedisKey>())
            .Returns(ci => _strings.ContainsKey(ci.ArgAt<RedisKey>(0).ToString()));

        target.KeyDeleteAsync(Arg.Any<RedisKey>())
            .Returns(ci => _strings.Remove(ci.ArgAt<RedisKey>(0).ToString()));

        target.KeyDeleteAsync(Arg.Any<RedisKey[]>())
            .Returns(ci => (long)ci.ArgAt<RedisKey[]>(0)
                .Count(k => _strings.Remove(k.ToString())));

        target.SetAddAsync(Arg.Any<RedisKey>(), Arg.Any<RedisValue>())
            .Returns(ci =>
            {
                var key = ci.ArgAt<RedisKey>(0).ToString();
                if (!_sets.TryGetValue(key, out var set))
                {
                    set = new SortedSet<string>(StringComparer.Ordinal);
                    _sets[key] = set;
                }

                return set.Add(ci.ArgAt<RedisValue>(1).ToString());
            });

        target.SetRemoveAsync(Arg.Any<RedisKey>(), Arg.Any<RedisValue>())
            .Returns(ci => _sets.TryGetValue(ci.ArgAt<RedisKey>(0).ToString(), out var set)
                           && set.Remove(ci.ArgAt<RedisValue>(1).ToString()));

        target.SetMembersAsync(Arg.Any<RedisKey>())
            .Returns(ci => _sets.TryGetValue(ci.ArgAt<RedisKey>(0).ToString(), out var set)
                ? set.Select(m => (RedisValue)m).ToArray()
                : []);
    }
}
