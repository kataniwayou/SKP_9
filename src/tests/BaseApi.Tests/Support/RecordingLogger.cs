using Microsoft.Extensions.Logging;

namespace BaseApi.Tests.Support;

/// <summary>
/// A real <see cref="ILogger{T}"/> that records what was written, so a test can assert on the
/// logging a component actually performs rather than on a mock's call list.
/// </summary>
internal sealed class RecordingLogger<T> : ILogger<T>
{
    public List<(LogLevel Level, string Message, Exception? Exception)> Records { get; } = [];

    /// <summary>
    /// Every scope dictionary opened on this logger, in the order they were opened. Scopes are how
    /// the execution ids reach a record — the ids are never in the message template — so a test that
    /// cannot see them cannot verify the log contract at all.
    /// </summary>
    public List<IReadOnlyDictionary<string, object>> Scopes { get; } = [];

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
