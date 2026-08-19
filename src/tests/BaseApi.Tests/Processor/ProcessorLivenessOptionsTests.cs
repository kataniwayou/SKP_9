using BaseProcessor.Core.Configuration;
using Microsoft.Extensions.Configuration;
using Xunit;

namespace BaseApi.Tests.Processor;

public sealed class ProcessorLivenessOptionsTests
{
    [Fact]
    public void DefaultsAreTheDocumentedBudget()
    {
        var options = new ProcessorLivenessOptions();

        Assert.Equal(10, options.IntervalSeconds);
        Assert.Equal(30, options.StartupIntervalSeconds);
        Assert.Equal(30, options.TtlSeconds);
        Assert.Equal(8, options.RequestTimeoutSeconds);
        Assert.Equal(30, options.BackoffCapSeconds);
    }

    [Fact]
    public void BindsFromTheBareConfigKeys()
    {
        // The property names carry a Seconds suffix for clarity; the bound keys do not. A rename that
        // dropped a ConfigurationKeyName would silently fall back to the default rather than fail.
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Processor:Interval"]        = "11",
            ["Processor:StartupInterval"] = "31",
            ["Processor:Ttl"]             = "41",
            ["Processor:RequestTimeout"]  = "9",
            ["Processor:BackoffCap"]      = "21",
        }).Build();

        var options = config.GetSection("Processor").Get<ProcessorLivenessOptions>()!;

        Assert.Equal(11, options.IntervalSeconds);
        Assert.Equal(31, options.StartupIntervalSeconds);
        Assert.Equal(41, options.TtlSeconds);
        Assert.Equal(9, options.RequestTimeoutSeconds);
        Assert.Equal(21, options.BackoffCapSeconds);
    }

    [Theory]
    // The startup writes ride the backoff, so their recorded interval must cover the slowest one:
    // TTL = max(interval*2, floor) has to outlast BackoffCap + RequestTimeout.
    [InlineData(30, 30, 60)]   // StartupInterval 30 -> max(60, 30) = 60 > 38s worst-case cadence
    [InlineData(10, 30, 30)]   // IntervalSeconds 10 -> max(20, 30) = 30, which would NOT cover it
    public void StartupTtlOutlivesTheSlowestBackoffWrite(int interval, int floor, int expectedTtl)
    {
        Assert.Equal(
            expectedTtl,
            BaseProcessor.Core.Liveness.ProcessorLivenessWriter.DeriveTtlSeconds(interval, floor));
    }
}
