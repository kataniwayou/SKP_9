using Confluent.Kafka;
using Confluent.Kafka.Admin;
using Processor.KafkaExporter.Kafka;
using Xunit;

namespace BaseApi.Tests.Live;

/// <summary>
/// The producer adapter, against a real broker. Everything else in the KafkaExporter suite runs
/// through <c>FakeRecordProducer</c>, which is what keeps the hermetic run broker-free — but it also
/// means <see cref="KafkaRecordProducer"/> itself, and every assumption it makes about how librdkafka
/// behaves, has no test above it. This file is that test.
/// <para>
/// Needs <c>tools/kafka-dev-broker.ps1 -Up</c> and <c>SKP_REALSTACK=1</c>. It shares the
/// <c>kafka-broker</c> collection with <c>KafkaImporterLiveTests</c>, which STOPS AND STARTS the
/// container — these must not run concurrently with it.
/// </para>
/// </summary>
[Trait("Category", RealStack.Category)]
[Collection("kafka-broker")]
public sealed class KafkaExporterLiveTests
{
    /// <summary>
    /// The round trip, and the one fact the fake cannot supply: bytes handed to the adapter come back
    /// off the partition unchanged, and the offset it reported is where they actually are.
    /// <para>
    /// The value is deliberately not valid UTF-8 — 0xC3 opens a two-byte sequence and 0x28 does not
    /// continue it. A <c>string</c>-typed producer would put replacement characters on the topic here
    /// and every text-valued test would still pass, which is exactly why this one exists.
    /// </para>
    /// </summary>
    [Fact]
    public async Task ProducesBytesThatComeBackOffThePartitionUnchanged()
    {
        RealStack.SkipUnlessEnabled();

        var topic = $"live-export-{Guid.NewGuid():N}";
        await CreateTopicAsync(topic);

        byte[] value = [0xC3, 0x28, 0x00, 0xFF];

        using var producer = new KafkaRecordProducer(RealStack.KafkaBrokers, TimeSpan.FromSeconds(30));
        var offset = await producer.ProduceAsync(topic, value, TestContext.Current.CancellationToken);

        Assert.Contains(topic, offset);

        using var consumer = new ConsumerBuilder<Ignore, byte[]>(new ConsumerConfig
        {
            BootstrapServers = RealStack.KafkaBrokers,
            GroupId = $"live-export-reader-{Guid.NewGuid():N}",
            AutoOffsetReset = AutoOffsetReset.Earliest,
            EnableAutoCommit = false,
        }).Build();

        consumer.Subscribe(topic);

        var read = consumer.Consume(TimeSpan.FromSeconds(30));
        Assert.NotNull(read);
        Assert.Equal(value, read.Message.Value);
        Assert.Equal(offset, read.TopicPartitionOffset.ToString());

        consumer.Close();
    }

    /// <summary>
    /// The failure the step converts into a failed outcome. A broker that is not there must make
    /// <c>ProduceAsync</c> throw within the delivery timeout rather than block on librdkafka's own
    /// five-minute default — which is the entire reason <c>message.timeout.ms</c> is set from the
    /// step payload, and the assumption no hermetic test can check.
    /// <para>
    /// Port 1 rather than the real broker stopped: this test shares its collection with a test that
    /// stops the container, and taking it down here as well would make the two orderings behave
    /// differently. An address nothing listens on is the same condition for librdkafka's purposes.
    /// </para>
    /// </summary>
    [Fact]
    public async Task ThrowsWithinTheDeliveryTimeoutWhenTheBrokerIsUnreachable()
    {
        RealStack.SkipUnlessEnabled();

        using var producer = new KafkaRecordProducer("localhost:1", TimeSpan.FromSeconds(5));

        var clock = System.Diagnostics.Stopwatch.StartNew();

        await Assert.ThrowsAnyAsync<KafkaException>(() =>
            producer.ProduceAsync("nowhere", [1, 2, 3], TestContext.Current.CancellationToken));

        // Generous against a 5s timeout, because the point is the ORDER OF MAGNITUDE: librdkafka's
        // default would have this sit for five minutes, and a dispatch cannot be interrupted while it
        // does. Anything under a minute proves the payload's timeout reached the client.
        Assert.True(
            clock.Elapsed < TimeSpan.FromSeconds(60),
            $"the produce took {clock.Elapsed}, so the delivery timeout from the step payload did not "
            + "reach librdkafka -- a dispatch would hold its lane for message.timeout.ms's five-minute "
            + "default with nothing able to interrupt it");
    }

    /// <summary>
    /// Created explicitly rather than left to <c>auto.create.topics.enable</c>. That setting defaults
    /// on, but it is a broker setting this repo does not own — the dev container's today, an org
    /// broker's tomorrow — and a test that silently depends on it fails somewhere unrelated when it is
    /// turned off.
    /// </summary>
    private static async Task CreateTopicAsync(string topic)
    {
        using var admin = new AdminClientBuilder(
            new AdminClientConfig { BootstrapServers = RealStack.KafkaBrokers }).Build();

        await admin.CreateTopicsAsync([
            new TopicSpecification { Name = topic, NumPartitions = 1, ReplicationFactor = 1 },
        ]);
    }
}
