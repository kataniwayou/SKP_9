using Microsoft.Extensions.Logging;

namespace BaseApi.Tests.Support;

/// <summary>
/// Loggers that share one scope chain and one record list, as loggers from a real LoggerFactory do.
/// A scope begun on one category (the consumer) must appear on records written by another (the
/// handler), and a RecordingLogger per type cannot show that.
/// </summary>
internal sealed class SharedLog
{
    private readonly AsyncLocal<Node?> _active = new();
    private readonly object _gate = new();
    private readonly List<(string Category, LogLevel Level, string? Template, string Message, IReadOnlyDictionary<string, object> Scope)> _records = [];

    public IReadOnlyList<(string Category, LogLevel Level, string? Template, string Message, IReadOnlyDictionary<string, object> Scope)> Records
    {
        get { lock (_gate) { return _records.ToList(); } }
    }

    public ILogger<T> For<T>() => new Logger<T>(this);

    /// <summary>The flattened scope of the one record whose template or message contains <paramref name="text"/>.</summary>
    public IReadOnlyDictionary<string, object> ScopeOf(string text) =>
        Records.Single(r => (r.Template ?? r.Message).Contains(text, StringComparison.Ordinal)).Scope;

    private sealed record Node(IReadOnlyDictionary<string, object>? Values, Node? Parent);

    private sealed class Logger<T>(SharedLog log) : ILogger<T>
    {
        public IDisposable BeginScope<TState>(TState state) where TState : notnull
        {
            var values = state is IEnumerable<KeyValuePair<string, object>> pairs
                ? pairs.ToDictionary(p => p.Key, p => p.Value)
                : null;
            var restore = log._active.Value;
            log._active.Value = new Node(values, restore);
            return new Restore(log, restore);
        }

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel level, EventId eventId, TState state, Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            var template = state is IEnumerable<KeyValuePair<string, object?>> values
                ? values.FirstOrDefault(v => v.Key == "{OriginalFormat}").Value?.ToString()
                : null;

            var chain = new List<Node>();
            for (var n = log._active.Value; n is not null; n = n.Parent)
            {
                chain.Add(n);
            }

            var merged = new Dictionary<string, object>(StringComparer.Ordinal);
            for (var i = chain.Count - 1; i >= 0; i--)
            {
                foreach (var pair in chain[i].Values ?? new Dictionary<string, object>())
                {
                    merged[pair.Key] = pair.Value;
                }
            }

            lock (log._gate)
            {
                log._records.Add((typeof(T).Name, level, template, formatter(state, exception), merged));
            }
        }
    }

    private sealed class Restore(SharedLog log, Node? restore) : IDisposable
    {
        public void Dispose() => log._active.Value = restore;
    }
}
