using BaseApi.Tests.Support;
using BaseConsole.Core.Health;
using BaseConsole.Core.Loop;
using BaseConsole.Core.Messaging;
using BaseConsole.Core.Naming;
using BaseProcessor.Core.Configuration;
using BaseProcessor.Core.Identity;
using BaseProcessor.Core.Liveness;
using Messaging.Contracts;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Time.Testing;
using NSubstitute;
using StackExchange.Redis;
using Xunit;

namespace BaseApi.Tests.Naming;

public sealed class ProcessorNamesTests
{
    /// <summary>Builds a heartbeat for a fixed processor id, resolves identity and goes healthy, then beats once.</summary>
    private static async Task Beat(SharedLog log, Guid processorId, IEntityNameSource source)
    {
        var context = new ProcessorContext();
        var clock = new FakeTimeProvider();
        var db = Substitute.For<IDatabase>();
        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase().Returns(db);
        var writer = new ProcessorLivenessWriter(redis, NullLogger<ProcessorLivenessWriter>.Instance);

        var heartbeat = new ProcessorLivenessHeartbeat(
            writer, context, Options.Create(new ProcessorLivenessOptions()), clock,
            new LoopHeartbeat(clock), new StartupGate(), new InstanceId("pod-1"),
            log.For<ProcessorLivenessHeartbeat>(),
            new EntityNameResolver(source, NullLogger<EntityNameResolver>.Instance));

        context.SetIdentity(new ProcessorIdentityFound(processorId, null, null, null, "sample", "1.0.0"));
        context.MarkHealthy();

        await heartbeat.BeatOnceAsync();
    }

    [Fact]
    public async Task TheHealthyAnnouncementCarriesTheProcessorName()
    {
        var log = new SharedLog();
        var processorId = Guid.NewGuid();

        await Beat(log, processorId, new FakeNameSource(new() { [processorId] = "proc_1.2.0-x" }));

        Assert.Equal("proc_1.2.0-x",
            log.ScopeOf("processor {ProcessorId} is healthy")[EntityNames.ProcessorName]);
    }

    [Fact]
    public async Task UntilTheProcessorIsKnownTheRecordCarriesTheIdSuffix()
    {
        // No workflow using this processor has started yet, so the key does not exist. Misses are
        // re-read each beat, so this is expected to self-heal once one does.
        var log = new SharedLog();
        var processorId = Guid.NewGuid();

        await Beat(log, processorId, new FakeNameSource());

        Assert.Equal(EntityNames.Fallback(processorId),
            log.ScopeOf("processor {ProcessorId} is healthy")[EntityNames.ProcessorName]);
    }
}
