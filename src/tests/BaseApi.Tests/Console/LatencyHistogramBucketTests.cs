using BaseApi.Tests.Support;
using BaseConsole.Core.DependencyInjection;
using Messaging.Transport;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using OpenTelemetry;
using OpenTelemetry.Metrics;
using Xunit;

namespace BaseApi.Tests.Console;

/// <summary>
/// The latency histograms must carry explicit bucket boundaries in seconds.
/// <para>
/// This is a guard against a failure that produces no error and no warning. The instruments record
/// <c>TotalSeconds</c>; the SDK's default boundaries are <c>[0, 5, 10, 25 … 10000]</c>, a ladder
/// built for milliseconds. With those defaults every observation lands in the first <c>(0, 5]</c>
/// bucket and <c>histogram_quantile</c> interpolates across it, so a p95 reports roughly 4.9
/// SECONDS for a send that really takes 15 ms. Measured on the live stack before the fix: 4767 of
/// 4772 observations in that one bucket.
/// </para>
/// <para>
/// A view whose instrument name matches nothing is silently ignored, which is the same shape of
/// failure — so asserting that the wiring <em>calls</em> AddView would prove nothing. These tests
/// read the boundaries off an exported metric instead, which is only possible if the view both
/// exists and matched.
/// </para>
/// </summary>
[Collection(EnvironmentCollection.Name)]
public sealed class LatencyHistogramBucketTests
{
    /// <summary>The default ladder the SDK applies when no view supplies one.</summary>
    private static readonly double[] MillisecondDefaults =
        [0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000];

    private static HostApplicationBuilder BuilderWith(params (string Key, string Value)[] settings)
    {
        var builder = Host.CreateApplicationBuilder();
        builder.Configuration.Sources.Clear();
        builder.Configuration.AddInMemoryCollection(
            settings.Select(s => new KeyValuePair<string, string?>(s.Key, s.Value)));
        return builder;
    }

    [Fact]
    public async Task TheSendHistogramCarriesSecondScaledBoundaries()
    {
        var builder = BuilderWith(("Service:Name", "orchestrator"), ("Service:Version", "1.0.0"));
        builder.AddBaseConsoleObservability(builder.Configuration, source: "worker");

        var exporter = new BoundaryCapturingExporter();
        builder.Services.AddOpenTelemetry().WithMetrics(m => m.AddReader(
            new BaseExportingMetricReader(exporter)));

        using var host = builder.Build();
        var provider = host.Services.GetRequiredService<MeterProvider>();

        // One real measurement through the production entry point, so the instrument is created and
        // has a metric point to export. The value is irrelevant -- boundaries are a property of the
        // stream, not of what was recorded.
        await EgressMetrics.MeasureAsync("queue", "dest", "type", () => Task.CompletedTask);
        provider.ForceFlush();

        var bounds = exporter.BoundariesFor(EgressMeter.DurationInstrument);

        Assert.NotNull(bounds);
        Assert.Equal(EgressMeter.LatencySecondsBoundaries(), bounds!);
    }

    [Fact]
    public async Task TheSendHistogramIsNotOnTheMillisecondDefaults()
    {
        // The specific regression, stated as its own claim. The equality above would also fail if the
        // ladder were merely changed, and the reader could not tell which happened.
        var builder = BuilderWith(("Service:Name", "orchestrator"), ("Service:Version", "1.0.0"));
        builder.AddBaseConsoleObservability(builder.Configuration, source: "worker");

        var exporter = new BoundaryCapturingExporter();
        builder.Services.AddOpenTelemetry().WithMetrics(m => m.AddReader(
            new BaseExportingMetricReader(exporter)));

        using var host = builder.Build();
        var provider = host.Services.GetRequiredService<MeterProvider>();

        await EgressMetrics.MeasureAsync("queue", "dest", "type", () => Task.CompletedTask);
        provider.ForceFlush();

        var bounds = exporter.BoundariesFor(EgressMeter.DurationInstrument);

        Assert.NotNull(bounds);
        Assert.NotEqual(MillisecondDefaults, bounds!);
    }

    [Fact]
    public void EveryBoundaryIsPlausibleAsSeconds()
    {
        // A ladder that is ascending, positive, and topped out in the seconds range. The top boundary
        // is the assertion that matters: 10000 would be the millisecond default leaking back in, and
        // it is three orders of magnitude past anything this pipeline can survive.
        var bounds = EgressMeter.LatencySecondsBoundaries();

        Assert.NotEmpty(bounds);
        Assert.All(bounds, b => Assert.True(b > 0, $"{b} is not a positive duration"));
        Assert.Equal(bounds.OrderBy(b => b), bounds);
        Assert.Equal(bounds.Distinct(), bounds);
        Assert.True(bounds[0] <= 0.001, "no boundary fine enough to separate sub-millisecond sends");
        Assert.True(bounds[^1] <= 60, $"top boundary {bounds[^1]}s reads as a millisecond ladder");
    }

    [Fact]
    public void TheLatencyLadderResolvesTheConfirmRoundTripThisSystemActuallyHas()
    {
        // Measured 2026-08-25: produce duration means 10.8ms and process duration 12.3ms, which put
        // 55% and 64% of their samples in a single (10, 25] rung. Both are Stopwatch measurements
        // taken inside one process, so unlike the arrival ladder there is no clock-skew argument
        // against resolving them -- the rung was simply wider than the thing being measured.
        var bounds = EgressMeter.LatencySecondsBoundaries();

        Assert.Contains(bounds, b => b > 0.01 && b < 0.025);
    }

    [Fact]
    public void TheLatencyLadderResolvesAHealthyGateProbe()
    {
        // The gate probe is the starkest case on the stack: a healthy probe answers in ~0.44ms and
        // 96.9% of them landed in the ladder's FIRST rung, (0, 1]. The instrument was added to stop
        // the store reading as two states, working and gone -- and with no rung inside the healthy
        // range it reproduced exactly that, one level down. Two boundaries below a millisecond give
        // the healthy range three rungs to live in.
        var bounds = EgressMeter.LatencySecondsBoundaries();

        Assert.True(
            bounds.Count(b => b < 0.001) >= 2,
            $"only {bounds.Count(b => b < 0.001)} boundaries below 1ms; a healthy probe is unresolved");
    }

    [Fact]
    public void TheBoundariesAreNotSharedMutableState()
    {
        // ExplicitBucketHistogramConfiguration.Boundaries takes double[], so handing every caller the
        // same instance would let one of them reorder the ladder for all of them.
        var first = EgressMeter.LatencySecondsBoundaries();
        var second = EgressMeter.LatencySecondsBoundaries();

        Assert.NotSame(first, second);

        first[0] = 999;

        Assert.NotEqual(999, EgressMeter.LatencySecondsBoundaries()[0]);
    }

    /// <summary>
    /// Reads explicit bucket boundaries off exported histograms. The SDK exposes them only through a
    /// metric point's <c>GetHistogramBuckets</c> enumerator, whose last entry is the +Inf overflow
    /// bucket -- that one is not a configured boundary and is dropped.
    /// </summary>
}
