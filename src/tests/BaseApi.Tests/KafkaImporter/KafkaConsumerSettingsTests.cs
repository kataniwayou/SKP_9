using Confluent.Kafka;
using Processor.KafkaImporter.Kafka;
using Xunit;

namespace BaseApi.Tests.KafkaImporter;

public sealed class KafkaConsumerSettingsTests
{
    private static readonly ConsumerConfig Config =
        KafkaConsumerSettings.For("kafka-1:9092", "kafka-importer");

    [Fact]
    public void CarriesTheBrokerListAndGroupItWasGiven()
    {
        Assert.Equal("kafka-1:9092", Config.BootstrapServers);
        Assert.Equal("kafka-importer", Config.GroupId);
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
    /// session.timeout.ms — not this — is what detects a dead pod, and that one is now set
    /// deliberately rather than left at its default.
    /// </summary>
    [Fact]
    public void ToleratesAnHourBetweenPolls()
    {
        Assert.Equal(TimeSpan.FromHours(1), KafkaConsumerSettings.MaxPollInterval);
        Assert.Equal(3_600_000, Config.MaxPollIntervalMs);
    }

    /// <summary>
    /// The session timeout is what decides how long an outage reports Drained before it fails the
    /// step. A warm consumer holds its assignment locally until this expires, so until then
    /// WaitForAssignment answers true, Consume returns null with nothing to read, and the dispatch
    /// reports a healthy-looking 0/N Drained. Measured at the 45s default: two dispatches on a 30s
    /// cron said Drained before the third failed the step.
    /// </summary>
    [Fact]
    public void GivesUpTheAssignmentInTenSecondsSoAnOutageFailsTheStepQuickly()
    {
        Assert.Equal(TimeSpan.FromSeconds(10), KafkaConsumerSettings.SessionTimeout);
        Assert.Equal(10_000, Config.SessionTimeoutMs);
    }

    /// <summary>
    /// The heartbeat has to fit inside the session timeout several times over — librdkafka requires
    /// it to be lower and the convention is a third — or an ordinary scheduling delay drops a
    /// consumer that is perfectly healthy. 3s into 10s is the default heartbeat against the shortened
    /// session, and it is the constraint that stops anyone lowering the session timeout alone.
    /// </summary>
    [Fact]
    public void HeartbeatsThreeTimesInsideTheSessionTimeout()
    {
        Assert.Equal(3_000, Config.HeartbeatIntervalMs);
        Assert.True(Config.HeartbeatIntervalMs * 3 <= Config.SessionTimeoutMs);
    }
}
