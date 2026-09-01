using System.Net;
using BaseProcessor.Core.Boot;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace BaseApi.Tests.Boot;

public sealed class BootProbeListenerTests
{
    // Port 0 lets the OS choose, so parallel test runs cannot collide on a fixed number.
    private static Task<BootProbeListener> StartAsync(ILoggerFactory? logs = null) =>
        BootProbeListener.StartAsync(
            0, logs ?? NullLoggerFactory.Instance, TestContext.Current.CancellationToken);

    [Fact]
    public async Task StartupAndLiveAnswerHealthyWhileDiscoveryRuns()
    {
        // This is the whole reason the listener exists. Without it nothing holds :8081 during Stage 1,
        // the startup budget expires, and the kubelet restarts a pod that is starting correctly.
        await using var listener = await StartAsync();
        using var http = new HttpClient { BaseAddress = listener.Address };

        foreach (var path in new[] { "/health/startup", "/health/live" })
        {
            var response = await http.GetAsync(path, TestContext.Current.CancellationToken);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        }
    }

    [Fact]
    public async Task ReadyAnswersUnavailable()
    {
        // Readiness is the honest signal during discovery: the process is up but cannot serve.
        await using var listener = await StartAsync();
        using var http = new HttpClient { BaseAddress = listener.Address };

        var response = await http.GetAsync("/health/ready", TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
    }

    /// <summary>
    /// The gap this closes. The boot window is unbounded, so a silent probe surface here left the one
    /// window an operator is actually reading with no evidence the kubelet was being answered at all.
    /// The line must match the real listener's, which is why it is written through the same helper.
    /// </summary>
    [Fact]
    public async Task EveryProbeVisitIsLoggedWithItsOutcome()
    {
        var logs = new RecordingLoggerFactory();
        await using var listener = await StartAsync(logs);
        using var http = new HttpClient { BaseAddress = listener.Address };

        foreach (var path in new[] { "/health/startup", "/health/live", "/health/ready" })
        {
            await http.GetAsync(path, TestContext.Current.CancellationToken);
        }

        var lines = logs.Snapshot()
            .Where(r => r.Category == typeof(BaseConsole.Core.Health.HealthProbeLog).FullName)
            .Select(r => r.Message)
            .ToArray();

        Assert.Equal(
            [
                "startup probe Healthy (200) in 0.00ms",
                "live probe Healthy (200) in 0.00ms",
                // Readiness names the one thing that is genuinely unknown during this window, which is
                // the true reason this stage answers 503 at all.
                "ready probe Unhealthy (503) in 0.00ms; failing: identity",
            ],
            lines);
        Assert.All(logs.Snapshot(), r => Assert.Equal(LogLevel.Information, r.Level));
    }

    [Fact]
    public async Task TheAddressIsLoopbackSoATestCanReachIt()
    {
        await using var listener = await StartAsync();

        Assert.Equal("127.0.0.1", listener.Address.Host);
        Assert.True(listener.Address.Port > 0);
    }

    [Fact]
    public async Task DisposingReleasesThePortForTheRealListener()
    {
        // Stage 2 binds the same port. If disposal did not actually release it the host would fail to
        // start, which is a far worse failure than the missed probe it is trading against.
        var listener = await StartAsync();
        var port = listener.Address.Port;
        await listener.DisposeAsync();

        await using var second = await BootProbeListener.StartAsync(
            port, NullLoggerFactory.Instance, TestContext.Current.CancellationToken);

        Assert.Equal(port, second.Address.Port);
    }

    /// <summary>Records category, level and message, which is all this test needs to assert.</summary>
    private sealed class RecordingLoggerFactory : ILoggerFactory
    {
        private readonly List<(string Category, LogLevel Level, string Message)> _records = [];

        public ILogger CreateLogger(string categoryName) => new Sink(this, categoryName);

        public void AddProvider(ILoggerProvider provider) { }

        public void Dispose() { }

        public IReadOnlyList<(string Category, LogLevel Level, string Message)> Snapshot()
        {
            lock (_records)
            {
                return _records.ToArray();
            }
        }

        private void Add(string category, LogLevel level, string message)
        {
            lock (_records)
            {
                _records.Add((category, level, message));
            }
        }

        private sealed class Sink : ILogger
        {
            private readonly RecordingLoggerFactory _owner;
            private readonly string _category;

            public Sink(RecordingLoggerFactory owner, string category)
            {
                _owner    = owner;
                _category = category;
            }

            public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

            public bool IsEnabled(LogLevel logLevel) => true;

            public void Log<TState>(
                LogLevel level,
                EventId eventId,
                TState state,
                Exception? exception,
                Func<TState, Exception?, string> formatter)
                => _owner.Add(_category, level, formatter(state, exception));
        }
    }
}
