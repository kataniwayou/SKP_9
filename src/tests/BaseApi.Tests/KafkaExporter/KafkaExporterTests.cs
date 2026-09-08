using System.Text;
using BaseApi.Tests.Support;
using BaseProcessor.Core.Processing;
using Messaging.Contracts;
using Messaging.Transport;
using NSubstitute;
using Processor.KafkaExporter;
using Xunit;

namespace BaseApi.Tests.KafkaExporter;

public sealed class KafkaExporterTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");

    /// <summary>The lineage this step was handed. Never Guid.Empty: an exporter is not a source.</summary>
    private static readonly Guid E = Guid.Parse("55555555-5555-5555-5555-555555555555");

    private static string Payload(string topic = "exports", int deliveryTimeoutSeconds = 30) =>
        $$"""
        {"brokerList":"kafka-1:9092","topic":"{{topic}}","deliveryTimeoutSeconds":{{deliveryTimeoutSeconds}}}
        """;

    private static (KafkaExporterProcessor Processor, IQueueSender Sender, RecordingLogger<KafkaExporterProcessor> Log)
        Build(FakeRecordProducerFactory factory)
    {
        var log = new RecordingLogger<KafkaExporterProcessor>();
        var sender = Substitute.For<IQueueSender>();
        var processor = new KafkaExporterProcessor(factory, log);
        processor.BeginDispatch(new DispatchState(sender, C, W, S, P));
        return (processor, sender, log);
    }

    private static byte[] Input(string text) => Encoding.UTF8.GetBytes(text);

    // ---- The export ------------------------------------------------------------------------

    /// <summary>
    /// AS IS, in the other direction: the branch's data becomes the record's value with nothing
    /// added, removed or re-encoded. The bytes here are deliberately not valid UTF-8 — 0xC3 opens a
    /// two-byte sequence and 0x28 does not continue it — because a seam that decoded on its way to
    /// the broker would put the replacement character on the topic and no test queueing text would
    /// ever notice.
    /// </summary>
    [Fact]
    public async Task ProducesTheBranchDataByteForByteToTheTopicTheStepNamed()
    {
        byte[] data = [0xC3, 0x28, 0x00, 0xFF];
        var producer = new FakeRecordProducer();
        var (processor, _, _) = Build(new FakeRecordProducerFactory(producer));

        await processor.ExecuteAsync(data, Payload(), E, CancellationToken.None);

        var (topic, value) = Assert.Single(producer.Produced);
        Assert.Equal("exports", topic);
        Assert.Equal(data, value);
    }

    /// <summary>
    /// A sink. Returning without sending is one of the three legitimate ways an author ends, and it
    /// is the one that means Complete: the framework reclaims the input key and the lineage stops
    /// here. A branch sent from this step would open a successor subtree that nothing asked for.
    /// </summary>
    [Fact]
    public async Task SendsNoBranchSoTheLineageEndsHere()
    {
        var (processor, sender, _) = Build(new FakeRecordProducerFactory(new FakeRecordProducer()));

        await processor.ExecuteAsync(Input("payload"), Payload(), E, CancellationToken.None);

        // SendAsync, not SendTransientAsync: the latter is an extension method over the former, so
        // it is the interface call that a substitute can witness -- and the one SendToPostAsync
        // ultimately makes.
        await sender.DidNotReceive().SendAsync(
            Arg.Any<string>(), Arg.Any<string>(), Arg.Any<ProcessedData>(),
            Arg.Any<CancellationToken>(), Arg.Any<string?>());
    }

    /// <summary>
    /// The line an operator follows when they want to know where a branch went. It names the
    /// execution id it was DISPATCHED with — this step mints nothing — so it is the last place a
    /// lineage that began upstream is seen, and the offset is what makes the record findable on the
    /// topic afterwards.
    /// </summary>
    [Fact]
    public async Task LogsTheExportAgainstTheExecutionIdItWasDispatchedWith()
    {
        var (processor, _, log) = Build(new FakeRecordProducerFactory(new FakeRecordProducer()));

        await processor.ExecuteAsync(Input("payload"), Payload(), E, CancellationToken.None);

        var line = log.Records.Single(r => r.Message.Contains("exported")).Message;
        Assert.Contains(E.ToString(), line);
        Assert.Contains("exports", line);
        Assert.Contains("exports [0] @0", line);
    }

    /// <summary>
    /// The payload is NOT on that line, and the omission is deliberate rather than an oversight. The
    /// execution id already leads back to every step that touched this branch, so rendering arbitrary
    /// upstream data into Elasticsearch a second time buys nothing and puts whatever a workflow
    /// happens to carry into the log in the clear. The importer logs its record value because there
    /// the value is the only identifier there is; here there is a better one.
    /// </summary>
    [Fact]
    public async Task DoesNotLogTheDataItExported()
    {
        var (processor, _, log) = Build(new FakeRecordProducerFactory(new FakeRecordProducer()));

        await processor.ExecuteAsync(Input("account 4711 balance 12.50"), Payload(), E, CancellationToken.None);

        Assert.DoesNotContain(log.Records, r => r.Message.Contains("4711"));
    }

    // ---- Failure ---------------------------------------------------------------------------

    [Fact]
    public async Task FailsTheStepWhenTheStepPayloadIsMissing()
    {
        var (processor, _, _) = Build(new FakeRecordProducerFactory(new FakeRecordProducer()));

        await Assert.ThrowsAsync<FailedException>(() =>
            processor.ExecuteAsync(Input("payload"), "", E, CancellationToken.None));
    }

    /// <summary>
    /// Producing a zero-byte record would put something on the topic that no reader can use, and the
    /// step would report Complete while doing it — the same false-healthy terminal the importer's
    /// MessageCount guard prevents, arriving from the other direction.
    /// </summary>
    [Fact]
    public async Task FailsTheStepWhenTheBranchCarriesNoData()
    {
        var producer = new FakeRecordProducer();
        var (processor, _, _) = Build(new FakeRecordProducerFactory(producer));

        await Assert.ThrowsAsync<FailedException>(() =>
            processor.ExecuteAsync([], Payload(), E, CancellationToken.None));

        Assert.Empty(producer.Produced);
    }

    /// <summary>
    /// librdkafka reads a message timeout of 0 as "no timeout", so a step that accepted it would hold
    /// its dispatch — and at a prefetch of one, the replica's only lane — until the broker answered
    /// or the pod died. Nothing in the framework interrupts that: the cancellation token is never
    /// cancelled in production.
    /// </summary>
    [Fact]
    public async Task FailsTheStepWhenDeliveryTimeoutSecondsIsBelowTheFloor()
    {
        var (processor, _, _) = Build(new FakeRecordProducerFactory(new FakeRecordProducer()));

        await Assert.ThrowsAsync<FailedException>(() =>
            processor.ExecuteAsync(Input("payload"), Payload(deliveryTimeoutSeconds: 0), E, CancellationToken.None));
    }

    /// <summary>
    /// No two-part split here, unlike the importer. That step can keep the records it already sent
    /// and stop early, so a fault before reading and one after it mean different things. This step
    /// has one record to place: it placed it or it did not, and there is no partial success to
    /// preserve. Both faults below therefore fail, and the fault code is not consulted.
    /// </summary>
    [Fact]
    public async Task FailsTheStepWhenTheProduceThrows()
    {
        var producer = new FakeRecordProducer { ProduceThrowsOnCall = 1 };
        var (processor, _, _) = Build(new FakeRecordProducerFactory(producer));

        await Assert.ThrowsAsync<FailedException>(() =>
            processor.ExecuteAsync(Input("payload"), Payload(), E, CancellationToken.None));
    }

    [Fact]
    public async Task FailsTheStepWhenTheProducerCannotBeBuilt()
    {
        var factory = new FakeRecordProducerFactory(new FakeRecordProducer()) { CreateThrows = true };
        var (processor, _, _) = Build(factory);

        await Assert.ThrowsAsync<FailedException>(() =>
            processor.ExecuteAsync(Input("payload"), Payload(), E, CancellationToken.None));
    }

    // ---- The cache -------------------------------------------------------------------------

    /// <summary>
    /// The whole point of holding it: a producer is a connection, a metadata fetch and an idempotent
    /// producer-id registration, and paying all three per dispatch would put them on the critical
    /// path of every export.
    /// </summary>
    [Fact]
    public async Task ReusesOneProducerAcrossDispatchesOnTheSameBrokerList()
    {
        var factory = new FakeRecordProducerFactory(new FakeRecordProducer());
        var (processor, _, _) = Build(factory);

        await processor.ExecuteAsync(Input("one"), Payload(), E, CancellationToken.None);
        await processor.ExecuteAsync(Input("two"), Payload(), E, CancellationToken.None);

        Assert.Equal(1, factory.Created);
    }

    /// <summary>
    /// A producer is not bound to a topic — it names one per record — so a second topic must NOT cost
    /// a second connection and a second metadata fetch. This is the one place the exporter's cache
    /// deliberately differs from the importer's, where the topic is part of the key because a
    /// subscription is.
    /// </summary>
    [Fact]
    public async Task KeepsOneProducerWhenOnlyTheTopicChanges()
    {
        var producer = new FakeRecordProducer();
        var factory = new FakeRecordProducerFactory(producer);
        var (processor, _, _) = Build(factory);

        await processor.ExecuteAsync(Input("one"), Payload("exports"), E, CancellationToken.None);
        await processor.ExecuteAsync(Input("two"), Payload("audit"), E, CancellationToken.None);

        Assert.Equal(1, factory.Created);
        Assert.Equal(["exports", "audit"], producer.Produced.Select(p => p.Topic));
    }

    /// <summary>
    /// The delivery timeout IS fixed at construction, so a cached producer carries the one it was
    /// built with. Without this key a dispatch naming a longer timeout would silently get the shorter
    /// value it inherited, and the payload field would read as live while being inert.
    /// </summary>
    [Fact]
    public async Task RebuildsWhenTheStepNamesADifferentDeliveryTimeout()
    {
        var first = new FakeRecordProducer();
        var factory = new FakeRecordProducerFactory(first, new FakeRecordProducer());
        var (processor, _, _) = Build(factory);

        await processor.ExecuteAsync(Input("one"), Payload(deliveryTimeoutSeconds: 30), E, CancellationToken.None);
        await processor.ExecuteAsync(Input("two"), Payload(deliveryTimeoutSeconds: 5), E, CancellationToken.None);

        Assert.Equal(2, factory.Created);
        Assert.True(first.Disposed);
        Assert.Equal(
            [TimeSpan.FromSeconds(30), TimeSpan.FromSeconds(5)],
            factory.Requests.Select(r => r.DeliveryTimeout));
    }

    /// <summary>
    /// The rule that makes caching strictly better than a per-dispatch producer rather than a trade:
    /// the fast path is cached and the recovery path is not. Without it a producer wedged in a state
    /// that fails every produce stays cached for the life of the pod, and every dispatch landing on
    /// this replica fails against it.
    /// </summary>
    [Fact]
    public async Task DiscardsTheProducerAfterAFailedExportSoTheNextDispatchIsFresh()
    {
        var faulted = new FakeRecordProducer { ProduceThrowsOnCall = 1 };
        var fresh = new FakeRecordProducer();
        var factory = new FakeRecordProducerFactory(faulted, fresh);
        var (processor, _, _) = Build(factory);

        await Assert.ThrowsAsync<FailedException>(() =>
            processor.ExecuteAsync(Input("one"), Payload(), E, CancellationToken.None));
        await processor.ExecuteAsync(Input("two"), Payload(), E, CancellationToken.None);

        Assert.Equal(2, factory.Created);
        Assert.True(faulted.Disposed);
        Assert.Single(fresh.Produced);
    }

    /// <summary>
    /// The container disposes this singleton at shutdown, and that is what flushes and closes the
    /// producer rather than leaving librdkafka to be torn down with the process.
    /// </summary>
    [Fact]
    public async Task ClosesTheProducerWhenTheHostShutsDown()
    {
        var producer = new FakeRecordProducer();
        var (processor, _, _) = Build(new FakeRecordProducerFactory(producer));

        await processor.ExecuteAsync(Input("payload"), Payload(), E, CancellationToken.None);
        processor.Dispose();

        Assert.True(producer.Disposed);
    }
}
