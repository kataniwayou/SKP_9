using Confluent.Kafka;
using Processor.PathImporter.Kafka;
using Xunit;

namespace BaseApi.Tests.PathImporter;

public sealed class KafkaFaultClassifierTests
{
    /// <summary>
    /// The allow-list. Each of these fails identically on every redelivery, so retrying is a loop
    /// that never terminates and the step must be reported failed instead.
    /// </summary>
    [Theory]
    [InlineData(ErrorCode.UnknownTopicOrPart)]
    [InlineData(ErrorCode.TopicAuthorizationFailed)]
    [InlineData(ErrorCode.GroupAuthorizationFailed)]
    [InlineData(ErrorCode.ClusterAuthorizationFailed)]
    [InlineData(ErrorCode.SaslAuthenticationFailed)]
    [InlineData(ErrorCode.InvalidConfig)]
    [InlineData(ErrorCode.Local_UnknownTopic)]
    [InlineData(ErrorCode.Local_InvalidArg)]
    public void NamesTheDeterministicFaults(ErrorCode code)
        => Assert.True(KafkaFaultClassifier.IsDeterministic(new Error(code)));

    /// <summary>
    /// Everything a broker or a rebalance can do to a healthy consumer. These cost a partial batch
    /// and are retried by the next dispatch — they must never become a failed step.
    /// </summary>
    [Theory]
    [InlineData(ErrorCode.Local_Transport)]
    [InlineData(ErrorCode.Local_TimedOut)]
    [InlineData(ErrorCode.Local_AllBrokersDown)]
    [InlineData(ErrorCode.LeaderNotAvailable)]
    [InlineData(ErrorCode.NotCoordinatorForGroup)]
    [InlineData(ErrorCode.RebalanceInProgress)]
    [InlineData(ErrorCode.GroupLoadInProgress)]
    [InlineData(ErrorCode.RequestTimedOut)]
    public void TreatsEverythingElseAsTransient(ErrorCode code)
        => Assert.False(KafkaFaultClassifier.IsDeterministic(new Error(code)));

    /// <summary>
    /// A code this classifier has never heard of. The default is the SAFE one for this processor —
    /// transient, retried — and it is the opposite of SendFaultClassifier's default. That inversion
    /// is deliberate and this fact is what stops someone "fixing" it to match.
    /// </summary>
    [Fact]
    public void DefaultsAnUnknownCodeToTransient()
        => Assert.False(KafkaFaultClassifier.IsDeterministic(new Error(ErrorCode.Unknown)));

    /// <summary>
    /// Fatal overrides the allow-list. librdkafka raises it for states the client cannot recover
    /// from at all, so retrying is pointless whatever the code beside it says.
    /// </summary>
    [Fact]
    public void TreatsAnyFatalErrorAsDeterministic()
        => Assert.True(KafkaFaultClassifier.IsDeterministic(
               new Error(ErrorCode.Local_Fatal, "the client is fatally broken", isFatal: true)));
}
