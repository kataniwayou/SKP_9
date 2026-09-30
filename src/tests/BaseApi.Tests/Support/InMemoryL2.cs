using NSubstitute;
using StackExchange.Redis;

namespace BaseApi.Tests.Support;

/// <summary>
/// An L2 that actually stores what is written to it: strings, sets and hashes in three dictionaries,
/// plus the TTL last applied to each key, behind a substituted <see cref="IConnectionMultiplexer"/>.
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
    private readonly Dictionary<string, Dictionary<string, string>> _hashes = new(StringComparer.Ordinal);
    private readonly Dictionary<string, TimeSpan> _ttls = new(StringComparer.Ordinal);

    public InMemoryL2()
    {
        Db = Substitute.For<IDatabase>();
        var batch = Substitute.For<IBatch>();

        Wire(Db);
        Wire(batch);

        Db.CreateBatch().Returns(batch);

        // THE SYNCHRONOUS READ, STUBBED HERE RATHER THAN IN Wire BECAUSE IT DOES NOT EXIST ON
        // IDatabaseAsync — a batch has no synchronous surface, only IDatabase does.
        // RedisFieldWhitelist reads through it: the normalization pipeline is synchronous across all
        // seven of its stages, so a whitelist lookup inside stage 4 cannot await without making the
        // handler interface async. Left unstubbed, NSubstitute answers RedisValue.Null for every key
        // and a seeded whitelist behaves exactly like an empty one — the failure hardest to tell
        // from a working gate.
        Db.StringGet(Arg.Any<RedisKey>(), Arg.Any<CommandFlags>())
            .Returns(ci => _strings.TryGetValue(ci.ArgAt<RedisKey>(0).ToString(), out var value)
                ? (RedisValue)value
                : RedisValue.Null);

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

    /// <summary>One hash field, or null when the key or the field is absent.</summary>
    public string? HashValue(string key, string field)
        => _hashes.TryGetValue(key, out var h) && h.TryGetValue(field, out var v) ? v : null;

    /// <summary>Whether a hash key exists right now.</summary>
    public bool HasHash(string key) => _hashes.ContainsKey(key);

    /// <summary>The TTL last applied to <paramref name="key"/>, or null when none was. Recorded, not enforced.</summary>
    public TimeSpan? Ttl(string key) => _ttls.TryGetValue(key, out var t) ? t : null;

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
            .Concat(_hashes.SelectMany(kv => kv.Value.Select(f => $"hash {kv.Key}.{f.Key} = {f.Value}")))
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

    private bool Exists(string key)
        => _strings.ContainsKey(key) || _hashes.ContainsKey(key)
           || (_sets.TryGetValue(key, out var set) && set.Count > 0);

    private bool Delete(string key)
    {
        var removed = _strings.Remove(key) | _hashes.Remove(key) | _sets.Remove(key);
        _ttls.Remove(key);
        return removed;
    }

    /// <summary>
    /// Whether an HSET on <paramref name="key"/> would answer WRONGTYPE on a real server: the key holds
    /// a string or a non-empty set. Modelled for the single-field HSET only — the one write that can
    /// meet a retired key shape (the pre-migration <c>skp:proc:{id}</c> SET).
    /// </summary>
    private bool HoldsNonHash(string key)
        => _strings.ContainsKey(key) || (_sets.TryGetValue(key, out var set) && set.Count > 0);

    private static RedisServerException WrongType()
        => new("WRONGTYPE Operation against a key holding the wrong kind of value");

    private Dictionary<string, string> Hash(string key)
    {
        if (!_hashes.TryGetValue(key, out var h))
        {
            h = new Dictionary<string, string>(StringComparer.Ordinal);
            _hashes[key] = h;
        }

        return h;
    }

    /// <summary>
    /// Backs the string, set, hash, key-existence, delete and expire operations these paths use onto
    /// the dictionaries (both string-set overloads, GET and MGET, SADD/SREM/SMEMBERS/SISMEMBER, both
    /// HSET overloads and HGET, EXISTS, single- and multi-key DEL, EXPIRE). <see cref="IBatch"/> derives
    /// from <see cref="IDatabaseAsync"/>, so the database and its batches are wired by one method and
    /// cannot drift apart.
    /// </summary>
    private void Wire(IDatabaseAsync target)
    {
        // BOTH string-set overloads, because they are two different methods rather than one with
        // defaults. StackExchange.Redis declares a (key, value, expiry, keepTtl, when, flags) overload
        // and a (key, value, expiry, when, flags) one; a bare two-argument call binds to the first and
        // an explicit five-argument call to the second. Wiring only one leaves the other answered with
        // default(Task<bool>) — which stores nothing, throws nothing, and shows up much later as a key
        // that is simply absent. Every handler that writes an execution blob names all five parameters
        // precisely to pin its overload against the keepTtl one, so this side has to cover both.
        Task<bool> Store(NSubstitute.Core.CallInfo ci)
        {
            _strings[ci.ArgAt<RedisKey>(0).ToString()] = ci.ArgAt<RedisValue>(1).ToString();
            return Task.FromResult(true);
        }

        target.StringSetAsync(Arg.Any<RedisKey>(), Arg.Any<RedisValue>()).Returns(Store);

        target.StringSetAsync(Arg.Any<RedisKey>(), Arg.Any<RedisValue>(), Arg.Any<TimeSpan?>(),
                              Arg.Any<When>(), Arg.Any<CommandFlags>())
            .Returns(ci =>
            {
                var key = ci.ArgAt<RedisKey>(0).ToString();
                _strings[key] = ci.ArgAt<RedisValue>(1).ToString();
                if (ci.ArgAt<TimeSpan?>(2) is { } ttl)
                {
                    _ttls[key] = ttl;
                }

                return Task.FromResult(true);
            });

        target.StringGetAsync(Arg.Any<RedisKey>())
            .Returns(ci => _strings.TryGetValue(ci.ArgAt<RedisKey>(0).ToString(), out var value)
                ? (RedisValue)value
                : RedisValue.Null);

        // MGET. The name resolver reads all of a record's ids in one round trip.
        target.StringGetAsync(Arg.Any<RedisKey[]>())
            .Returns(ci => ci.ArgAt<RedisKey[]>(0)
                .Select(k => _strings.TryGetValue(k.ToString(), out var value) ? (RedisValue)value : RedisValue.Null)
                .ToArray());

        target.KeyExistsAsync(Arg.Any<RedisKey>())
            .Returns(ci => Exists(ci.ArgAt<RedisKey>(0).ToString()));

        target.KeyDeleteAsync(Arg.Any<RedisKey>())
            .Returns(ci => Delete(ci.ArgAt<RedisKey>(0).ToString()));

        target.KeyDeleteAsync(Arg.Any<RedisKey[]>())
            .Returns(ci => (long)ci.ArgAt<RedisKey[]>(0).Count(k => Delete(k.ToString())));

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

        target.HashSetAsync(Arg.Any<RedisKey>(), Arg.Any<RedisValue>(), Arg.Any<RedisValue>(),
                            Arg.Any<When>(), Arg.Any<CommandFlags>())
            .Returns(ci =>
            {
                if (HoldsNonHash(ci.ArgAt<RedisKey>(0).ToString()))
                {
                    return Task.FromException<bool>(WrongType());
                }

                var h = Hash(ci.ArgAt<RedisKey>(0).ToString());
                var field = ci.ArgAt<RedisValue>(1).ToString();
                var added = !h.ContainsKey(field);
                h[field] = ci.ArgAt<RedisValue>(2).ToString();
                return Task.FromResult(added);
            });

        target.HashSetAsync(Arg.Any<RedisKey>(), Arg.Any<HashEntry[]>(), Arg.Any<CommandFlags>())
            .Returns(ci =>
            {
                var h = Hash(ci.ArgAt<RedisKey>(0).ToString());
                foreach (var entry in ci.ArgAt<HashEntry[]>(1))
                {
                    h[entry.Name.ToString()] = entry.Value.ToString();
                }

                return Task.CompletedTask;
            });

        target.HashGetAsync(Arg.Any<RedisKey>(), Arg.Any<RedisValue>(), Arg.Any<CommandFlags>())
            .Returns(ci => HashValue(ci.ArgAt<RedisKey>(0).ToString(), ci.ArgAt<RedisValue>(1).ToString())
                           is { } v ? (RedisValue)v : RedisValue.Null);

        target.SetContainsAsync(Arg.Any<RedisKey>(), Arg.Any<RedisValue>(), Arg.Any<CommandFlags>())
            .Returns(ci => _sets.TryGetValue(ci.ArgAt<RedisKey>(0).ToString(), out var set)
                           && set.Contains(ci.ArgAt<RedisValue>(1).ToString()));

        target.KeyExpireAsync(Arg.Any<RedisKey>(), Arg.Any<TimeSpan?>(), Arg.Any<ExpireWhen>(), Arg.Any<CommandFlags>())
            .Returns(ci =>
            {
                var key = ci.ArgAt<RedisKey>(0).ToString();
                if (!Exists(key))
                {
                    return false;
                }

                if (ci.ArgAt<TimeSpan?>(1) is { } ttl)
                {
                    _ttls[key] = ttl;
                }

                return true;
            });
    }
}
