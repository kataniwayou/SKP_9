using BaseApi.Tests.Support;
using BaseConsole.Core.DependencyInjection;
using BaseConsole.Core.Messaging;
using Messaging.Transport;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using OpenTelemetry;
using OpenTelemetry.Metrics;
using Xunit;

namespace BaseApi.Tests.Console;

/// <summary>
/// The queue-wait histogram must carry the WIDE ladder, not the transport's sub-second one.
/// <para>
/// Same class of guard as <see cref="LatencyHistogramBucketTests"/>, and for the same reason: a view
/// whose instrument name matches nothing is silently ignored, so asserting that the wiring calls
/// <c>AddView</c> would prove nothing. These read the boundaries off an exported metric, which is
/// only possible if the view both exists and matched.
/// </para>
/// <para>
/// <b>Why a different ladder matters here.</b> <c>EgressMeter.LatencySecondsBoundaries</c> stops at
/// 10s, which is right for a broker round trip. This instrument exists because a pipeline can
/// fall behind, and a backlogged step is measured in minutes — everything past the last boundary
/// lands in <c>+Inf</c>, where a quantile has nothing to interpolate between and reports the last
/// edge. That is the millisecond-ladder defect from the other end, and it would be just as silent.
/// </para>
/// </summary>
[Collection(EnvironmentCollection.Name)]
public sealed class ArrivalHistogramBucketTests
{
    private static HostApplicationBuilder BuilderWith()
    {
        var builder = Host.CreateApplicationBuilder();
        builder.Configuration.Sources.Clear();
        builder.Configuration.AddInMemoryCollection(
        [
            new KeyValuePair<string, string?>("Service:Name", "orchestrator"),
            new KeyValuePair<string, string?>("Service:Version", "1.0.0"),
        ]);
        return builder;
    }

    private static (BoundaryCapturingExporter Exporter, IHost Host) Started()
    {
        var builder = BuilderWith();
        builder.AddBaseConsoleObservability(builder.Configuration, source: "worker");

        var exporter = new BoundaryCapturingExporter();
        builder.Services.AddOpenTelemetry().WithMetrics(m => m.AddReader(
            new BaseExportingMetricReader(exporter)));

        var host = builder.Build();

        // Resolve the provider BEFORE recording, and that order is the whole of it: resolving is
        // what subscribes the SDK to the meters. Recording first measures into a listener that does
        // not exist yet, the export is empty, and the assertion fails identically to the defect
        // these tests exist to catch -- which is exactly what happened when this was written the
        // other way round.
        var provider = host.Services.GetRequiredService<MeterProvider>();

        // One real measurement through the production entry point, so the instrument is created
        // and has a metric point to export. The header is present, because the point of the call is
        // to create the stream rather than to check the value.
        IngressMetrics.RecordArrival("orchestrator-result", MessageClock.NowMilliseconds() - 100);

        provider.ForceFlush();
        return (exporter, host);
    }

    [Fact]
    public void TheQueueWaitHistogramCarriesTheArrivalLadder()
    {
        var (exporter, host) = Started();
        using (host)
        {
            var bounds = exporter.BoundariesFor(IngressMetrics.QueueWaitInstrument);

            Assert.NotNull(bounds);
            Assert.Equal(IngressMetrics.ArrivalSecondsBoundaries(), bounds!);
        }
    }

    /// <summary>
    /// Same guard as <see cref="TheQueueWaitHistogramCarriesTheArrivalLadder"/>, for the other
    /// consumer of this ladder. <c>IngressMetrics.ConsumerDurationInstrument</c> documents exactly
    /// this hazard at its declaration: "a view whose instrument name matches nothing is silently
    /// ignored, so a typo here costs the histogram its bucket boundaries and nothing reports the
    /// mistake." Asserting <c>AddView</c> was called would not catch that typo; reading the
    /// boundaries off an exported metric point is the only check that does.
    /// </summary>
    [Fact]
    public void TheConsumerDurationHistogramCarriesTheArrivalLadder()
    {
        var builder = BuilderWith();
        builder.AddBaseConsoleObservability(builder.Configuration, source: "worker");

        var exporter = new BoundaryCapturingExporter();
        builder.Services.AddOpenTelemetry().WithMetrics(m => m.AddReader(
            new BaseExportingMetricReader(exporter)));

        using var host = builder.Build();
        var provider = host.Services.GetRequiredService<MeterProvider>();

        // One real measurement through the production entry point -- same reasoning as Started()
        // above: resolving the provider first is what subscribes the SDK, and recording is what
        // gives the instrument a metric point to export.
        IngressMetrics.RecordConsumerDuration("orchestrator-result", "T", "acked", 0.01);

        provider.ForceFlush();

        var bounds = exporter.BoundariesFor(IngressMetrics.ConsumerDurationInstrument);

        Assert.NotNull(bounds);
        Assert.Equal(IngressMetrics.ArrivalSecondsBoundaries(), bounds!);
    }

    [Fact]
    public void TheArrivalLadderReachesMinutesRatherThanStoppingAtTenSeconds()
    {
        // The specific regression, stated as its own claim: sharing the transport's ladder would
        // put every backlogged observation in +Inf. Asserted against the transport's own constant
        // so that changing either one fails here rather than silently converging.
        Assert.True(IngressMetrics.ArrivalSecondsBoundaries()[^1] >= 300);
        Assert.NotEqual(EgressMeter.LatencySecondsBoundaries(), IngressMetrics.ArrivalSecondsBoundaries());
    }

    [Fact]
    public void TheArrivalLadderDoesNotClaimSubSkewResolution()
    {
        // Both ends of these measurements are stamped on different processes, so nothing below NTP
        // skew is a real number. A ladder resolving 1ms would invite reading noise as a latency.
        Assert.True(IngressMetrics.ArrivalSecondsBoundaries()[0] >= 0.01);
    }

    [Fact]
    public void TheArrivalLadderResolvesTheHopLatencyThisSystemActuallyHas()
    {
        // Measured 2026-08-25: queue wait means sit at 11-14ms on every hop, which put 51% of all
        // samples in a single (10, 25] rung. A quantile drawn from a rung holding half the mass is
        // arithmetic between its two edges, not a measurement -- p95 read 24.4ms because 25 is a
        // boundary, not because anything took 24.4ms.
        var bounds = IngressMetrics.ArrivalSecondsBoundaries();

        Assert.Contains(bounds, b => b > 0.01 && b < 0.025);
    }

    [Fact]
    public void TheArrivalLadderResolvesAStepAndItsTail()
    {
        // Step elapsed means sit near 40ms, and its tail runs to 76ms. Without a rung inside either
        // span, 90% of samples landed in (25, 50] and the tail in (50, 100] -- so p95/p99 reported
        // 86 and 97ms against a measured 54 and 62. Both spans need a rung, not just the tail: the
        // body of the distribution is as unresolved as its edge.
        var bounds = IngressMetrics.ArrivalSecondsBoundaries();

        Assert.Contains(bounds, b => b > 0.025 && b < 0.05);
        Assert.Contains(bounds, b => b > 0.05 && b < 0.1);
    }

    [Fact]
    public void TheArrivalLadderResolvesTheRungTheStepTailNowLandsIn()
    {
        // Measured after the first widening shipped: p99 still overstated by 29% because the last
        // ~1% of step-elapsed samples sat in (60, 75] and a quantile has to spread them across the
        // whole rung. ES put the true maximum at 61ms, i.e. packed against the bottom edge -- the
        // same shape the (50, 100] rung had before, one rung along. Splitting it is what stops the
        // tail being reported at the far edge of wherever it happens to land.
        var bounds = IngressMetrics.ArrivalSecondsBoundaries();

        Assert.Contains(bounds, b => b > 0.06 && b < 0.075);
    }

    [Fact]
    public void NoRungInTheOperatingBandSpansMoreThanHalfAgain()
    {
        // Stated as a property rather than a boundary list, because the boundary list is what keeps
        // going stale. Every quantile is a position inside the rung that holds it, so a rung's span
        // IS the error bar on any quantile drawn from it -- and this ladder is read across two very
        // different workloads: the three-step probe lives near 32ms, the ten-step fanout near 114ms
        // with a tail to ~180. Fitting rungs to one of them left the other reading its bucket edge.
        //
        // 1.5x caps the worst-case overstatement at 50% of a rung's lower edge, everywhere between
        // 10ms and 250ms. Outside that band the ladder stays coarse on purpose: below 10ms is the
        // clock-skew floor, above 250ms is backlog territory where an order of magnitude is the
        // interesting distinction.
        var bounds = IngressMetrics.ArrivalSecondsBoundaries();
        var band = bounds.Where(b => b >= 0.01 && b <= 0.25).ToArray();

        var widest = band.Zip(band.Skip(1), (lo, hi) => (lo, hi, ratio: hi / lo))
                         .OrderByDescending(x => x.ratio)
                         .First();

        Assert.True(
            widest.ratio <= 1.5 + 1e-9,
            $"({widest.lo * 1000:g}, {widest.hi * 1000:g}]ms spans {widest.ratio:F2}x -- "
            + "a quantile landing there is that far from a measurement");
    }
}
