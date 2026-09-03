using BaseProcessor.Core.Boot;
using BaseProcessor.Core.Identity;
using Messaging.Contracts;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using Xunit;

namespace BaseApi.Tests.Boot;

public sealed class BrokerIdentityBootstrapTests
{
    private static IConfiguration ConfigWith(params (string Key, string Value)[] settings) =>
        new ConfigurationBuilder()
            .AddInMemoryCollection(settings.Select(s => new KeyValuePair<string, string?>(s.Key, s.Value)))
            .Build();

    [Fact]
    public void FailsFastWhenTheBrokerHostIsMissing()
    {
        // The whole boot hangs on this connection. A missing host must name itself here rather than
        // surface as an unbounded retry against a destination that was never configured.
        var cfg = ConfigWith(("RabbitMq:Username", "guest"), ("RabbitMq:Password", "guest"));

        var ex = Assert.Throws<InvalidOperationException>(
            () => new BrokerIdentityBootstrap(cfg, NullLoggerFactory.Instance, TimeProvider.System));

        Assert.Contains("RabbitMq:Host", ex.Message);
    }

    [Fact]
    public void BuildsWithACompleteBrokerConfiguration()
    {
        // Construction must not connect. The connection belongs to ResolveAsync, which is the part
        // allowed to retry forever.
        var cfg = ConfigWith(
            ("RabbitMq:Host", "localhost"),
            ("RabbitMq:Username", "guest"),
            ("RabbitMq:Password", "guest"));

        var bootstrap = new BrokerIdentityBootstrap(cfg, NullLoggerFactory.Instance, TimeProvider.System);

        Assert.NotNull(bootstrap);
    }

    [Fact]
    public void TheRetryTuningSharesTheHostsConfigurationKeys()
    {
        // The host binds ProcessorLivenessOptions from this same section, and ConfigurationKeyName
        // makes the keys shorter than the property names. Reading keys directly here would let an
        // operator tune the host's timeouts while the boot silently kept the defaults — two stages of
        // one process disagreeing about the same knob.
        var cfg = ConfigWith(
            ("RabbitMq:Host", "localhost"),
            ("RabbitMq:Username", "guest"),
            ("RabbitMq:Password", "guest"),
            ("Processor:RequestTimeout", "3"),
            ("Processor:BackoffCap", "4"));

        var bootstrap = new BrokerIdentityBootstrap(cfg, NullLoggerFactory.Instance, TimeProvider.System);

        Assert.Equal(3, bootstrap.RequestTimeoutSeconds);
        Assert.Equal(4, bootstrap.BackoffCapSeconds);
    }

    [Fact]
    public void TheRetryTuningFallsBackToTheHostsOwnDefaults()
    {
        var cfg = ConfigWith(
            ("RabbitMq:Host", "localhost"),
            ("RabbitMq:Username", "guest"),
            ("RabbitMq:Password", "guest"));

        var bootstrap = new BrokerIdentityBootstrap(cfg, NullLoggerFactory.Instance, TimeProvider.System);

        var defaults = new BaseProcessor.Core.Configuration.ProcessorLivenessOptions();
        Assert.Equal(defaults.RequestTimeoutSeconds, bootstrap.RequestTimeoutSeconds);
        Assert.Equal(defaults.BackoffCapSeconds, bootstrap.BackoffCapSeconds);
    }

    [Fact]
    public async Task CancellationEndsTheLoopRatherThanReturningNothing()
    {
        // Shutdown during discovery is a cancellation, never a resolved identity. Returning null here
        // would let a half-booted host start with no identity at all.
        var cfg = ConfigWith(
            ("RabbitMq:Host", "127.0.0.1"),
            ("RabbitMq:Port", "1"),           // nothing listens; every attempt fails and retries
            ("RabbitMq:Username", "guest"),
            ("RabbitMq:Password", "guest"),
            ("Processor:BackoffCap", "1"),
            ("Processor:RequestTimeout", "1"));

        // A real hash is embedded on a concrete processor's assembly only, and this one is a test
        // host. Substituting it keeps the loop — the thing under test — reachable.
        var hash = Substitute.For<ISourceHashProvider>();
        hash.Get().Returns("0000000000000000000000000000000000000000000000000000000000000000");

        await using var bootstrap = new BrokerIdentityBootstrap(
            cfg, NullLoggerFactory.Instance, TimeProvider.System, hash);

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(2));

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => bootstrap.ResolveAsync(cts.Token));
    }

    [Fact]
    public async Task AnUnansweredAskNamesTheSourceHashItIsWaitingOn()
    {
        // The branch a processor deployed before the API sits in, and the one an operator is most
        // likely to read: it repeats for as long as the API is missing. Naming the queue tells them
        // which service to bring up; naming the hash tells them which row to register once it is up.
        // Without the hash on this line, that answer exists only on the single line emitted before
        // the first ask -- which a wait measured in hours will have pushed out of the log.
        var cfg = ConfigWith(
            ("RabbitMq:Host", "127.0.0.1"),
            ("RabbitMq:Port", "1"),           // nothing listens; every ask goes unanswered
            ("RabbitMq:Username", "guest"),
            ("RabbitMq:Password", "guest"),
            ("Processor:BackoffCap", "1"),
            ("Processor:RequestTimeout", "1"));

        const string Hash = "1111111111111111111111111111111111111111111111111111111111111111";
        var hash = Substitute.For<ISourceHashProvider>();
        hash.Get().Returns(Hash);

        var logs = new RecordingLoggerFactory();

        await using var bootstrap = new BrokerIdentityBootstrap(cfg, logs, TimeProvider.System, hash);

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(3));

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => bootstrap.ResolveAsync(cts.Token));

        // Asserted against the waiting lines alone, not against the whole log: the opening
        // "resolving identity" line already carries the hash, so a snapshot-wide search would pass
        // whether or not the branch under test names it. Selected on the remedy rather than on
        // "nothing answered" -- BrokerFaultClassifier phrases an unreachable broker with those same
        // two words, so the send-failure warning would be swept in and asserted against a hash it
        // was never meant to carry.
        var unanswered = logs.Snapshot()
            .Where(r => r.Message.Contains("baseapi-service", StringComparison.Ordinal))
            .ToArray();

        Assert.NotEmpty(unanswered);
        Assert.All(unanswered, r => Assert.Contains(Hash, r.Message, StringComparison.Ordinal));
    }

    /// <summary>Records level and message, which is all this test needs to assert.</summary>
    private sealed class RecordingLoggerFactory : ILoggerFactory
    {
        private readonly List<(LogLevel Level, string Message)> _records = [];

        public ILogger CreateLogger(string categoryName) => new Sink(this);

        public void AddProvider(ILoggerProvider provider) { }

        public void Dispose() { }

        public IReadOnlyList<(LogLevel Level, string Message)> Snapshot()
        {
            lock (_records)
            {
                return _records.ToArray();
            }
        }

        private void Add(LogLevel level, string message)
        {
            lock (_records)
            {
                _records.Add((level, message));
            }
        }

        private sealed class Sink : ILogger
        {
            private readonly RecordingLoggerFactory _owner;

            public Sink(RecordingLoggerFactory owner) => _owner = owner;

            public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

            public bool IsEnabled(LogLevel logLevel) => true;

            public void Log<TState>(
                LogLevel level,
                EventId eventId,
                TState state,
                Exception? exception,
                Func<TState, Exception?, string> formatter)
                => _owner.Add(level, formatter(state, exception));
        }
    }
}
