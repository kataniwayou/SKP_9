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
            ["Processor:RequestTimeout"]  = "9",
            ["Processor:BackoffCap"]      = "21",
        }).Build();

        var options = config.GetSection("Processor").Get<ProcessorLivenessOptions>()!;

        Assert.Equal(11, options.IntervalSeconds);
        Assert.Equal(31, options.StartupIntervalSeconds);
        Assert.Equal(9, options.RequestTimeoutSeconds);
        Assert.Equal(21, options.BackoffCapSeconds);
    }

    [Theory]
    // The startup writes ride the backoff, so their recorded interval must cover the slowest one:
    // the gap between two of them reaches BackoffCap + RequestTimeout = 38s.
    [InlineData(30, 120)]   // StartupInterval 30 -> 120s, comfortably past 38
    [InlineData(10, 40)]    // IntervalSeconds 10 -> 40s, which also covers it, but see below
    public void StartupTtlOutlivesTheSlowestBackoffWrite(int interval, int expectedTtl)
    {
        // Recording the steady-state interval on a startup write would still produce a TTL past the
        // 38s worst case, but it would also tell the reader the replica beats every 10s when it does
        // not — so it would read as stale at 20s while still being on schedule.
        Assert.Equal(
            expectedTtl,
            BaseProcessor.Core.Liveness.ProcessorLivenessWriter.DeriveTtlSeconds(interval));
    }
}
