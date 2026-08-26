using Messaging.Transport;
using BaseApi.Tests.Support;
using Microsoft.Extensions.Time.Testing;
using Xunit;

namespace BaseApi.Tests.Console;

[Collection(EnvironmentCollection.Name)]
public sealed class ProcessStartMetricsTests
{
    [Fact]
    public void TheFirstStampWinsAndLaterOnesAreIgnored()
    {
        var clock = new FakeTimeProvider(new DateTimeOffset(2026, 8, 26, 9, 0, 0, TimeSpan.Zero));
        ProcessStartMetrics.Stamp(clock);
        var first = clock.GetUtcNow().ToUnixTimeSeconds();

        // A second call must not move the value. The gauge's whole idiom is that it changes
        // exactly once per process -- changes() over a window counts restarts, so a value that
        // moved for any other reason would inflate the restart count.
        clock.Advance(TimeSpan.FromHours(1));
        ProcessStartMetrics.Stamp(clock);

        using var metrics = new MetricCollector(ProcessStartMetrics.MeterName);
        metrics.Collect();

        var observed = metrics.For(ProcessStartMetrics.StartTimestampInstrument);
        Assert.Single(observed);

        // The type is static and process-wide, so whichever test stamped first owns the value.
        // Assert the invariant that holds either way: it is stamped, and it did not advance by
        // the hour that passed between the two calls above.
        Assert.NotEqual(0d, observed[0].Value);
        Assert.NotEqual(first + 3600d, observed[0].Value);
    }
}
