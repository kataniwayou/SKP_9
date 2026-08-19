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
    [InlineData(10, 40)]
    [InlineData(30, 120)]   // the startup anchor
    [InlineData(1, 4)]      // no floor: a fast cadence gets a correspondingly short TTL
    public void TtlIsFourTimesTheRecordedInterval(int interval, int expected) =>
        Assert.Equal(expected, ProcessorLivenessWriter.DeriveTtlSeconds(interval));

    [Theory]
    [InlineData(1)]
    [InlineData(10)]
    [InlineData(30)]
    [InlineData(300)]
    public void TheKeyOutlivesTheWindowThatDeclaresItStale(int interval)
    {
        // The reader calls an entry stale at timestamp + interval x 2, and the key expires at
        // interval x 4. The gap between them is what makes `stale` reportable at all: were the key to
        // expire first, a replica that registered and then wedged would be indistinguishable from one
        // that was deleted an hour ago, and only `absent` would ever be counted.
        var ttl = ProcessorLivenessWriter.DeriveTtlSeconds(interval);
        var staleAfter = interval * 2;

        Assert.True(ttl > staleAfter);
        Assert.Equal(staleAfter, ttl - staleAfter);   // the stale window is exactly one more window wide
    }
}
