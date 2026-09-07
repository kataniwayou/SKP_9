using BaseApi.Tests.Support;
using BaseProcessor.Core.Processing;
using Messaging.Contracts;
using Messaging.Transport;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using NSubstitute;
using Processor.PathImporter;
using Processor.PathImporter.Kafka;
using Xunit;

namespace BaseApi.Tests.PathImporter;

public sealed class PathImporterCacheTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");

    private static string Payload(string topic, string group = "path-importer") =>
        $$"""
        {"brokerList":"kafka-1:9092","topic":"{{topic}}","consumerGroup":"{{group}}",
         "messageCount":10,"idleTimeoutSeconds":1}
        """;

    private static PathImporterProcessor Build(FakePathConsumerFactory factory)
    {
        var processor = new PathImporterProcessor(
            factory, new RecordingLogger<PathImporterProcessor>());
        processor.BeginDispatch(
            new DispatchState(Substitute.For<IQueueSender>(), C, W, S, P));
        return processor;
    }

    /// <summary>
    /// The whole point of holding it: a single-member group that empties pays the broker's
    /// three-second initial rebalance delay on the next join, and a stateless consumer would pay it
    /// on every dispatch that follows an idle gap.
    /// </summary>
    [Fact]
    public async Task ReusesOneConsumerAcrossDispatchesOnTheSameTopic()
    {
        var factory = new FakePathConsumerFactory(
            new FakePathConsumer().WithPaths("/mnt/a.txt", "/mnt/b.txt"));
        var processor = Build(factory);

        await processor.ExecuteAsync([], Payload("file-paths"), Guid.Empty, CancellationToken.None);
        await processor.ExecuteAsync([], Payload("file-paths"), Guid.Empty, CancellationToken.None);

        Assert.Equal(1, factory.Created);
    }

    [Fact]
    public async Task RebuildsWhenTheStepNamesADifferentTopic()
    {
        var first = new FakePathConsumer().WithPaths("/mnt/a.txt");
        var second = new FakePathConsumer().WithPaths("/mnt/b.txt");
        var factory = new FakePathConsumerFactory(first, second);
        var processor = Build(factory);

        await processor.ExecuteAsync([], Payload("file-paths"), Guid.Empty, CancellationToken.None);
        await processor.ExecuteAsync([], Payload("other-paths"), Guid.Empty, CancellationToken.None);

        Assert.Equal(2, factory.Created);
        Assert.True(first.Closed);
        Assert.True(first.Disposed);
        Assert.Equal(["other-paths"], second.Subscribed);
    }

    [Fact]
    public async Task RebuildsWhenTheStepNamesADifferentConsumerGroup()
    {
        var factory = new FakePathConsumerFactory(
            new FakePathConsumer().WithPaths("/mnt/a.txt"),
            new FakePathConsumer().WithPaths("/mnt/b.txt"));
        var processor = Build(factory);

        await processor.ExecuteAsync([], Payload("file-paths", "group-one"), Guid.Empty, CancellationToken.None);
        await processor.ExecuteAsync([], Payload("file-paths", "group-two"), Guid.Empty, CancellationToken.None);

        Assert.Equal(2, factory.Created);
    }

    /// <summary>
    /// The rule that makes caching strictly better than a per-dispatch consumer rather than a trade:
    /// the fast path is cached and the recovery path is not. Without it, a consumer wedged in a
    /// state the classifier read as transient stays wedged for the life of the pod.
    /// </summary>
    [Fact]
    public async Task DiscardsTheConsumerAfterATransientFaultSoTheNextDispatchIsFresh()
    {
        var faulted = new FakePathConsumer { ConsumeThrowsOnCall = 1 }.WithPaths("/mnt/a.txt");
        var fresh = new FakePathConsumer().WithPaths("/mnt/b.txt");
        var factory = new FakePathConsumerFactory(faulted, fresh);
        var processor = Build(factory);

        await processor.ExecuteAsync([], Payload("file-paths"), Guid.Empty, CancellationToken.None);
        await processor.ExecuteAsync([], Payload("file-paths"), Guid.Empty, CancellationToken.None);

        Assert.Equal(2, factory.Created);
        Assert.True(faulted.Disposed);
    }

    [Fact]
    public async Task DiscardsTheConsumerWhenTheStepFails()
    {
        // The fault is at assignment rather than at Consume: those are the two sides of the split,
        // and only the first fails the step. A Consume fault ends the dispatch at Faulted, which
        // evicts as well but reaches it down the other path — the test above covers that one.
        var consumer = new FakePathConsumer { AssignmentThrows = true }.WithPaths("/mnt/a.txt");
        var processor = Build(new FakePathConsumerFactory(consumer, new FakePathConsumer()));

        await Assert.ThrowsAsync<FailedException>(() =>
            processor.ExecuteAsync([], Payload("file-paths"), Guid.Empty, CancellationToken.None));

        Assert.True(consumer.Disposed);
    }

    /// <summary>
    /// The container disposes this singleton at shutdown, and that is what leaves the group cleanly
    /// rather than waiting out the session timeout.
    /// </summary>
    [Fact]
    public async Task LeavesTheGroupWhenTheHostShutsDown()
    {
        var consumer = new FakePathConsumer().WithPaths("/mnt/a.txt");
        var processor = Build(new FakePathConsumerFactory(consumer));

        await processor.ExecuteAsync([], Payload("file-paths"), Guid.Empty, CancellationToken.None);
        processor.Dispose();

        Assert.True(consumer.Closed);
        Assert.True(consumer.Disposed);
    }
}

/// <summary>
/// The one thing worth asserting about a shell: that its service graph actually resolves, without
/// starting a process or reaching a broker. Mirrors ProcessorSampleTests for the sample.
/// </summary>
public sealed class PathImporterHostWiringTests
{
    [Fact]
    public void ResolvesTheProcessorAndItsConsumerFactory()
    {
        // ProcessorIdentityFound's constructor takes Id, InputSchemaId, OutputSchemaId,
        // ConfigSchemaId, Name, Version -- matching ProcessorSampleTests, not the brief's 3-arg
        // sketch (there is no 3-arg overload).
        var identity = new ProcessorIdentityFound(
            Guid.NewGuid(), InputSchemaId: null, OutputSchemaId: null, ConfigSchemaId: null,
            Name: "path-importer", Version: "1.0.0");

        // RabbitMq:Username and RabbitMq:Password are required by AddBaseProcessor even though the
        // brief's sketch omits them; ProcessorSampleTests.Build() is the working reference and sets
        // both, so this does too rather than leaving the host wiring test unable to resolve at all.
        //
        // "--environment", "Development" turns on the container's ValidateOnBuild/ValidateScopes,
        // which is what makes this fact prove the WHOLE graph resolves rather than just the two
        // registrations it explicitly asks for below -- matching ProcessorSampleTests.Build().
        using var host = ProcessorHost.Create(["--environment", "Development"], identity, config =>
            config.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["ConnectionStrings:Redis"] = "localhost:6379,abortConnect=false",
                ["RabbitMq:Host"] = "localhost",
                ["RabbitMq:Username"] = "guest",
                ["RabbitMq:Password"] = "guest",
            }));

        Assert.IsType<PathImporterProcessor>(
            host.Services.GetRequiredService<BaseProcessor.Core.Processing.BaseProcessor>());
        Assert.IsType<KafkaPathConsumerFactory>(
            host.Services.GetRequiredService<IPathConsumerFactory>());
    }
}
