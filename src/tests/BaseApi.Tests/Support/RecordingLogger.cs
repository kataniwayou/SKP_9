using Microsoft.Extensions.Logging;

namespace BaseApi.Tests.Support;

/// <summary>
/// A real <see cref="ILogger{T}"/> that records what was written, so a test can assert on the
/// logging a component actually performs rather than on a mock's call list.
/// </summary>
internal sealed class RecordingLogger<T> : ILogger<T>
{
    public List<(LogLevel Level, string Message, Exception? Exception)> Records { get; } = [];

    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

    public bool IsEnabled(LogLevel logLevel) => true;

    public void Log<TState>(
        LogLevel level,
        EventId eventId,
        TState state,
        Exception? exception,
        Func<TState, Exception?, string> formatter)
        => Records.Add((level, formatter(state, exception), exception));
}
