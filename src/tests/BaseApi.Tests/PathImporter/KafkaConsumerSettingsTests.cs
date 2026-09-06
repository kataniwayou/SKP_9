using Confluent.Kafka;
using Processor.PathImporter.Kafka;
using Xunit;

namespace BaseApi.Tests.PathImporter;

public sealed class KafkaConsumerSettingsTests
{
    private static readonly ConsumerConfig Config =
        KafkaConsumerSettings.For("kafka-1:9092", "path-importer");

    [Fact]
    public void CarriesTheBrokerListAndGroupItWasGiven()
    {
        Assert.Equal("kafka-1:9092", Config.BootstrapServers);
        Assert.Equal("path-importer", Config.GroupId);
    }

    /// <summary>
    /// The loop owns when an offset moves. Auto-commit would move it on librdkafka's schedule —
    /// which is to say, possibly before the branch was sent — and that is the one ordering the whole
    /// design rests on.
    /// </summary>
    [Fact]
    public void NeverCommitsOrStoresAnOffsetOnItsOwn()
    {
        Assert.False(Config.EnableAutoCommit);
        Assert.False(Config.EnableAutoOffsetStore);
    }

    /// <summary>
    /// The topic is seeded from outside the cluster, so a group reading it for the first time must
    /// see paths written before the group existed. Latest would silently import nothing.
    /// </summary>
    [Fact]
    public void ReadsFromTheStartOfTheTopicForAGroupWithNoOffsets()
        => Assert.Equal(AutoOffsetReset.Earliest, Config.AutoOffsetReset);

    /// <summary>
    /// The consumer is held across dispatches, and nothing polls in between. At the five-minute
    /// default librdkafka would evict it from the group during any ordinary idle gap and the next
    /// dispatch would pay the rejoin the cache exists to avoid. Raising it is safe because
    /// session.timeout.ms, left at its default, is what actually detects a dead pod.
    /// </summary>
    [Fact]
    public void ToleratesAnHourBetweenPolls()
    {
        Assert.Equal(TimeSpan.FromHours(1), KafkaConsumerSettings.MaxPollInterval);
        Assert.Equal(3_600_000, Config.MaxPollIntervalMs);
    }
}
