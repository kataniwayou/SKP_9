using BaseApi.Tests.Support;
using BaseProcessor.Core.Processing;
using Messaging.Contracts;
using Messaging.Transport;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using NSubstitute;
using Processor.KafkaImporter;
using Processor.KafkaImporter.Kafka;
using Xunit;

namespace BaseApi.Tests.KafkaImporter;

public sealed class KafkaImporterCacheTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");

    private static string Payload(string topic, string group = "kafka-importer") =>
        $$"""
        {"topic":"{{topic}}","consumerGroup":"{{group}}",
         "messageCount":10,"idleTimeoutSeconds":1}
        """;

    private static KafkaImporterProcessor Build(FakeRecordConsumerFactory factory)
    {
        var processor = new KafkaImporterProcessor(
            factory, new RecordingLogger<KafkaImporterProcessor>());
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
        var factory = new FakeRecordConsumerFactory(
            new FakeRecordConsumer().WithRecords("value-a", "value-b"));
        var processor = Build(factory);

        await processor.ExecuteAsync([], Payload("records"), Guid.Empty, CancellationToken.None);
        await processor.ExecuteAsync([], Payload("records"), Guid.Empty, CancellationToken.None);

        Assert.Equal(1, factory.Created);
    }

    [Fact]
    public async Task RebuildsWhenTheStepNamesADifferentTopic()
    {
        var first = new FakeRecordConsumer().WithRecords("value-a");
        var second = new FakeRecordConsumer().WithRecords("value-b");
        var factory = new FakeRecordConsumerFactory(first, second);
        var processor = Build(factory);

        await processor.ExecuteAsync([], Payload("records"), Guid.Empty, CancellationToken.None);
        await processor.ExecuteAsync([], Payload("other-records"), Guid.Empty, CancellationToken.None);

        Assert.Equal(2, factory.Created);
        Assert.True(first.Closed);
        Assert.True(first.Disposed);
        Assert.Equal(["other-records"], second.Subscribed);
    }

    [Fact]
    public async Task RebuildsWhenTheStepNamesADifferentConsumerGroup()
    {
        var factory = new FakeRecordConsumerFactory(
            new FakeRecordConsumer().WithRecords("value-a"),
            new FakeRecordConsumer().WithRecords("value-b"));
        var processor = Build(factory);

        await processor.ExecuteAsync([], Payload("records", "group-one"), Guid.Empty, CancellationToken.None);
        await processor.ExecuteAsync([], Payload("records", "group-two"), Guid.Empty, CancellationToken.None);

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
        var faulted = new FakeRecordConsumer { ConsumeThrowsOnCall = 1 }.WithRecords("value-a");
        var fresh = new FakeRecordConsumer().WithRecords("value-b");
        var factory = new FakeRecordConsumerFactory(faulted, fresh);
        var processor = Build(factory);

        await processor.ExecuteAsync([], Payload("records"), Guid.Empty, CancellationToken.None);
        await processor.ExecuteAsync([], Payload("records"), Guid.Empty, CancellationToken.None);

        Assert.Equal(2, factory.Created);
        Assert.True(faulted.Disposed);
    }

    [Fact]
    public async Task DiscardsTheConsumerWhenTheStepFails()
    {
        // The fault is at assignment rather than at Consume: those are the two sides of the split,
        // and only the first fails the step. A Consume fault ends the dispatch at Faulted, which
        // evicts as well but reaches it down the other branch — the test above covers that one.
        var consumer = new FakeRecordConsumer { AssignmentThrows = true }.WithRecords("value-a");
        var processor = Build(new FakeRecordConsumerFactory(consumer, new FakeRecordConsumer()));

        await Assert.ThrowsAsync<FailedException>(() =>
            processor.ExecuteAsync([], Payload("records"), Guid.Empty, CancellationToken.None));

        Assert.True(consumer.Disposed);
    }

    /// <summary>
    /// The container disposes this singleton at shutdown, and that is what leaves the group cleanly
    /// rather than waiting out the session timeout.
    /// </summary>
    [Fact]
    public async Task LeavesTheGroupWhenTheHostShutsDown()
    {
        var consumer = new FakeRecordConsumer().WithRecords("value-a");
        var processor = Build(new FakeRecordConsumerFactory(consumer));

        await processor.ExecuteAsync([], Payload("records"), Guid.Empty, CancellationToken.None);
        processor.Dispose();

        Assert.True(consumer.Closed);
        Assert.True(consumer.Disposed);
    }
}

/// <summary>
/// The one thing worth asserting about a shell: that its service graph actually resolves, without
/// starting a process or reaching a broker. Mirrors ProcessorSampleTests for the sample.
/// </summary>
public sealed class KafkaImporterHostWiringTests
{
    [Fact]
    public void ResolvesTheProcessorAndItsConsumerFactory()
    {
        // ProcessorIdentityFound's constructor takes Id, InputSchemaId, OutputSchemaId,
        // ConfigSchemaId, Name, Version -- matching ProcessorSampleTests, not the brief's 3-arg
        // sketch (there is no 3-arg overload).
        var identity = new ProcessorIdentityFound(
            Guid.NewGuid(), InputSchemaId: null, OutputSchemaId: null, ConfigSchemaId: null,
            Name: "kafka-importer", Version: "1.0.0");

        // RabbitMq:Username and RabbitMq:Password are required by AddBaseProcessor even though the
        // brief's sketch omits them; ProcessorSampleTests.Build() is the working reference and sets
        // both, so this does too rather than leaving the host wiring test unable to resolve at all.
        //
        // "--environment", "Development" turns on the container's ValidateOnBuild/ValidateScopes,
        // which is what makes this fact prove the WHOLE graph resolves rather than just the two
        // registrations it explicitly asks for below -- matching ProcessorSampleTests.Build().
        using var host = ProcessorHost.Create(["--environment", "Development"], identity, Settings());

        Assert.IsType<KafkaImporterProcessor>(
            host.Services.GetRequiredService<BaseProcessor.Core.Processing.BaseProcessor>());
        Assert.IsType<KafkaRecordConsumerFactory>(
            host.Services.GetRequiredService<IRecordConsumerFactory>());
    }

    /// <summary>
    /// <b>Where the broker list lives now.</b> It arrives as <c>Kafka__BrokerList</c> in the
    /// deployment's environment, the same way the RabbitMQ and Redis addresses beside it do, and
    /// nothing in a step payload can reach it.
    /// </summary>
    [Fact]
    public void BindsTheOrgBrokerListFromConfiguration()
    {
        using var host = ProcessorHost.Create(
            ["--environment", "Development"], Identity(),
            Settings(brokerList: "kafka-1:9092,kafka-2:9092"));

        Assert.Equal(
            "kafka-1:9092,kafka-2:9092",
            host.Services.GetRequiredService<KafkaBrokerOptions>().BrokerList);
    }

    /// <summary>
    /// <b>A missing broker must stop the host, not the first dispatch.</b> librdkafka accepts an
    /// empty bootstrap list at construction and only fails later, when it has nothing to connect
    /// to — which would surface as a step that hangs until its idle timeout and reports Drained,
    /// the one terminal that means "the topic is empty". Binding eagerly here turns a missing
    /// setting into a pod that will not start, which is what an operator can see.
    /// </summary>
    [Fact]
    public void RefusesToBuildWithoutABrokerList()
    {
        var error = Assert.Throws<InvalidOperationException>(() =>
            ProcessorHost.Create(["--environment", "Development"], Identity(), Settings(brokerList: null)));

        Assert.Contains("Kafka:BrokerList", error.Message, StringComparison.Ordinal);
    }

    private static ProcessorIdentityFound Identity() => new(
        Guid.NewGuid(), InputSchemaId: null, OutputSchemaId: null, ConfigSchemaId: null,
        Name: "kafka-importer", Version: "1.0.0");

    private static Action<IConfigurationBuilder> Settings(string? brokerList = "kafka-1:9092") =>
        config => config.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Redis"] = "localhost:6379,abortConnect=false",
            ["RabbitMq:Host"] = "localhost",
            ["RabbitMq:Username"] = "guest",
            ["RabbitMq:Password"] = "guest",
            ["Kafka:BrokerList"] = brokerList,
        });
}
