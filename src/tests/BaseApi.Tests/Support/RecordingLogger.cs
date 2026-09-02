using System.Collections;
using Microsoft.Extensions.Logging;

namespace BaseApi.Tests.Support;

/// <summary>
/// A real <see cref="ILogger{T}"/> that records what was written, so a test can assert on the
/// logging a component actually performs rather than on a mock's call list.
/// <para>
/// <b>Thread-safe, because the components under test log from their own loops.</b> An
/// <c>L2GateProbe</c> or a <c>LoopHeartbeat</c> writes from a background timer while the test polls
/// what has been recorded so far, so a plain <see cref="List{T}"/> here is a write racing an
/// enumeration. That surfaced as
/// <c>L2GateProbeTests.RearmsSoASecondOutageIsAlsoReported</c> failing with
/// "Collection was modified; enumeration operation may not execute" — roughly one full-suite run in
/// four, and never when the class was run alone, which is the signature of a race rather than a bug
/// in the assertion.
/// </para>
/// </summary>
internal sealed class RecordingLogger<T> : ILogger<T>
{
    public Recorded<(LogLevel Level, string Message, Exception? Exception)> Records { get; } = new();

    /// <summary>
    /// Every scope dictionary opened on this logger, in the order they were opened. Scopes are how
    /// the execution ids reach a record — the ids are never in the message template — so a test that
    /// cannot see them cannot verify the log contract at all.
    /// </summary>
    public Recorded<IReadOnlyDictionary<string, object>> Scopes { get; } = new();

    public IDisposable? BeginScope<TState>(TState state) where TState : notnull
    {
        if (state is IEnumerable<KeyValuePair<string, object>> pairs)
        {
            Scopes.Add(pairs.ToDictionary(p => p.Key, p => p.Value));
        }

        return new Scope();
    }

    public bool IsEnabled(LogLevel logLevel) => true;

    public void Log<TState>(
        LogLevel level,
        EventId eventId,
        TState state,
        Exception? exception,
        Func<TState, Exception?, string> formatter)
        => Records.Add((level, formatter(state, exception), exception));

    private sealed class Scope : IDisposable
    {
        public void Dispose() { }
    }
}

/// <summary>
/// An append-only list whose reads cannot observe a concurrent write.
/// <para>
/// <b>Enumeration is over a snapshot taken under the lock,</b> which is the whole point: locking the
/// mutators alone would still let <c>foreach</c> — and therefore every LINQ operator a test reaches
/// for — walk the live list while the component under test appends to it.
/// </para>
/// <para>
/// Deliberately NOT a <c>ConcurrentBag</c> or a lock-free queue: order is load-bearing here, since
/// tests assert on the first record and on records by index, and a bag does not preserve it.
/// </para>
/// <para>
/// Exposes exactly what the call sites need — <see cref="Count"/>, the indexer, <see cref="Clear"/>
/// and enumeration — so this replaced <c>List&lt;T&gt;</c> without touching a single assertion.
/// <see cref="Clear"/> in particular has to stay a real mutation: a test that clears between phases
/// would silently assert against stale records if this handed back a copy to clear.
/// </para>
/// </summary>
internal sealed class Recorded<T> : IReadOnlyList<T>
{
    private readonly List<T> _items = [];

    // A plain object, not System.Threading.Lock: that type is .NET 9 and this targets net8.0.
    private readonly object _gate = new();

    public int Count
    {
        get { lock (_gate) { return _items.Count; } }
    }

    public T this[int index]
    {
        get { lock (_gate) { return _items[index]; } }
    }

    public void Add(T item)
    {
        lock (_gate)
        {
            _items.Add(item);
        }
    }

    public void Clear()
    {
        lock (_gate)
        {
            _items.Clear();
        }
    }

    public IEnumerator<T> GetEnumerator()
    {
        T[] snapshot;
        lock (_gate)
        {
            snapshot = _items.ToArray();
        }

        return ((IEnumerable<T>)snapshot).GetEnumerator();
    }

    IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
}
