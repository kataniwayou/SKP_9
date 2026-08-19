using BaseProcessor.Core.Boot;
using BaseProcessor.Core.Identity;
using Messaging.Contracts;
using Microsoft.Extensions.Configuration;
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
}
