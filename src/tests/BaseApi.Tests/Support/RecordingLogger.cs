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

    /// <summary>
    /// Every record's ACTIVE scope, flattened outer-to-inner, aligned with <see cref="Records"/> by
    /// index.
    /// <para>
    /// <b>This is what the OpenTelemetry bridge actually does,</b> and <see cref="Scopes"/> is not:
    /// that list says a scope was opened at some point, which cannot answer "did THIS record carry
    /// that field". With <c>IncludeScopes</c> + <c>ParseStateValues</c> every open scope's pairs are
    /// flattened onto the record as <c>attributes.&lt;Key&gt;</c>, so a test asserting on an attribute
    /// has to look at the scope that was live when the line was written. Inner scopes win, matching
    /// the bridge.
    /// </para>
    /// </summary>
    public Recorded<IReadOnlyDictionary<string, object>> RecordScopes { get; } = new();

    /// <summary>
    /// The live scope chain, per async flow — the real providers keep this in an
    /// <see cref="AsyncLocal{T}"/> for the same reason: a scope opened on one flow must not leak onto
    /// a record written by another. A linked node rather than a mutable stack so a captured chain
    /// cannot be changed by a later push or pop.
    /// </summary>
    private readonly AsyncLocal<ScopeNode?> _active = new();

    public IDisposable? BeginScope<TState>(TState state) where TState : notnull
    {
        var values = state is IEnumerable<KeyValuePair<string, object>> pairs
            ? pairs.ToDictionary(p => p.Key, p => p.Value)
            : null;

        if (values is not null)
        {
            Scopes.Add(values);
        }

        var restore = _active.Value;
        _active.Value = new ScopeNode(values, restore);
        return new Scope(this, restore);
    }

    /// <summary>Flattens the live chain outer-to-inner, so an inner scope's value wins.</summary>
    private IReadOnlyDictionary<string, object> FlattenActiveScope()
    {
        var chain = new List<ScopeNode>();
        for (var node = _active.Value; node is not null; node = node.Parent)
        {
            chain.Add(node);
        }

        var merged = new Dictionary<string, object>(StringComparer.Ordinal);
        for (var i = chain.Count - 1; i >= 0; i--)
        {
            if (chain[i].Values is null)
            {
                continue;
            }

            foreach (var pair in chain[i].Values!)
            {
                merged[pair.Key] = pair.Value;
            }
        }

        return merged;
    }

    private sealed record ScopeNode(Dictionary<string, object>? Values, ScopeNode? Parent);

    /// <summary>
    /// Every record's unsubstituted message template, in the same order as <see cref="Records"/>
    /// (null for a record written without one).
    /// <para>
    /// <b>Separate from <see cref="Records"/>' formatted message, because only the template is a
    /// contract.</b> The formatted text carries the substituted values, so a test asserting on it
    /// re-asserts the arguments; the template is what the OpenTelemetry bridge puts on
    /// <c>attributes.{OriginalFormat}</c> as a keyword, and therefore what a dashboard panel, the
    /// live suite's scenario counting and the Analyst's own panel all select on. Those selectors
    /// break on a one-byte change to a template and on nothing else, so the template is the thing
    /// worth pinning.
    /// </para>
    /// <para>
    /// Index i here is the template of <see cref="Records"/>'s record i. That pairing holds under
    /// concurrent logging only because both appends happen under one lock; see the field below.
    /// </para>
    /// </summary>
    public Recorded<string?> Templates { get; } = new();

    /// <summary>
    /// Held across BOTH appends in <see cref="Log"/>, so a template and its record are added as one
    /// step. <see cref="Recorded{T}"/> locks each list individually, which is enough for a reader of
    /// either list alone but not enough to pair them: two components logging concurrently on the same
    /// logger could otherwise interleave as template-A, template-B, record-B, record-A and silently
    /// swap which template belongs to which record.
    /// </summary>
    private readonly object _pair = new();

    public bool IsEnabled(LogLevel logLevel) => true;

    public void Log<TState>(
        LogLevel level,
        EventId eventId,
        TState state,
        Exception? exception,
        Func<TState, Exception?, string> formatter)
    {
        var template = state is IEnumerable<KeyValuePair<string, object?>> values
            ? values.FirstOrDefault(v => v.Key == "{OriginalFormat}").Value?.ToString()
            : null;
        var message = formatter(state, exception);

        var scope = FlattenActiveScope();

        lock (_pair)
        {
            // Template and scope first, so neither list is ever SHORTER than Records: a reader walking
            // Records by index can always index both with the same one, even mid-append.
            Templates.Add(template);
            RecordScopes.Add(scope);
            Records.Add((level, message, exception));
        }
    }

    private sealed class Scope(RecordingLogger<T> owner, ScopeNode? restore) : IDisposable
    {
        public void Dispose() => owner._active.Value = restore;
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
