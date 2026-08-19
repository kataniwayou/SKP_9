using BaseProcessor.Core.Boot;
using BaseProcessor.Core.Identity;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using Xunit;

namespace BaseApi.Tests.Live;

[Collection(RealStackCollection.Name)]
[Trait("Category", RealStack.Category)]
public sealed class IdentityBootstrapLiveTests
{
    private readonly RealStackFixture _stack;

    public IdentityBootstrapLiveTests(RealStackFixture stack) => _stack = stack;

    private static IConfiguration Config() =>
        new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["RabbitMq:Host"]            = RealStack.RabbitHost,
            ["RabbitMq:Port"]            = RealStack.RabbitPort.ToString(),
            ["RabbitMq:Username"]        = "guest",
            ["RabbitMq:Password"]        = "guest",
            ["Processor:RequestTimeout"] = "8",
            ["Processor:BackoffCap"]     = "5",
        }).Build();

    /// <summary>
    /// The hash the bootstrap will ask about. Injected rather than read from assembly metadata,
    /// because in a test process that metadata belongs to the test host — and resolving the sample
    /// processor's real row would mean the fixture deleted a row the running deployment depends on.
    /// </summary>
    private static ISourceHashProvider HashOf(string hash)
    {
        var provider = Substitute.For<ISourceHashProvider>();
        provider.Get().Returns(hash);
        return provider;
    }

    [Fact]
    public async Task ResolvesTheRegisteredRowOverTheRealBroker()
    {
        // The end-to-end claim the whole design rests on: a real RabbitMQ round-trip to a real BaseApi
        // reading a real Postgres row, completing before any host is built.
        RealStack.SkipUnlessEnabled();

        await using var bootstrap = new BrokerIdentityBootstrap(
            Config(), NullLoggerFactory.Instance, TimeProvider.System, HashOf(_stack.SourceHash));

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(60));
        var identity = await bootstrap.ResolveAsync(cts.Token);

        Assert.Equal(_stack.ProcessorId, identity.Id);
        Assert.Equal(_stack.Name, identity.Name);
        Assert.Equal(_stack.Version, identity.Version);
    }

    [Fact]
    public async Task KeepsWaitingWhenNoRowIsRegistered()
    {
        // "Not found" is an ordinary early answer, not a failure — a processor image may legitimately
        // be deployed before anyone registers its row. The loop must outlast the wait, not give up.
        RealStack.SkipUnlessEnabled();

        var unregistered = new string('a', 64);
        await using var bootstrap = new BrokerIdentityBootstrap(
            Config(), NullLoggerFactory.Instance, TimeProvider.System, HashOf(unregistered));

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(12));

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => bootstrap.ResolveAsync(cts.Token));
    }
}
