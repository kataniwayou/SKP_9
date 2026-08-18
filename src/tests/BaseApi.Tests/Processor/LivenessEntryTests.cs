using BaseProcessor.Core.Liveness;
using Messaging.Contracts.Projections;
using Xunit;

namespace BaseApi.Tests.Processor;

public sealed class LivenessEntryTests
{
    [Fact]
    public void AllOutcomesSuccessYieldsHealthy()
    {
        var entry = ProcessorLivenessEntry.Create(
            SchemaOutcome.Success, SchemaOutcome.Success, SchemaOutcome.Success,
            DateTime.UtcNow, interval: 10);

        Assert.Equal(LivenessStatus.Healthy, entry.Status);
    }

    [Fact]
    public void NullOutcomeCountsAsSuccess()
    {
        var entry = ProcessorLivenessEntry.Create(null, null, null, DateTime.UtcNow, interval: 10);

        Assert.Equal(LivenessStatus.Healthy, entry.Status);
        Assert.Equal(SchemaOutcome.Success, entry.Summary.ConfigSchema);
    }

    [Fact]
    public void AnyFailYieldsUnhealthy()
    {
        var entry = ProcessorLivenessEntry.Create(
            SchemaOutcome.Success, SchemaOutcome.Success, SchemaOutcome.Fail,
            DateTime.UtcNow, interval: 10);

        Assert.Equal(LivenessStatus.Unhealthy, entry.Status);
    }

    [Theory]
    [InlineData(10, 30, 30)]   // floor wins
    [InlineData(30, 30, 60)]   // interval * 2 wins
    public void TtlIsIntervalTimesTwoOrTheFloor(int interval, int floor, int expected) =>
        Assert.Equal(expected, ProcessorLivenessWriter.DeriveTtlSeconds(interval, floor));
}
