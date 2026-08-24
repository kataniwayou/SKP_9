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
/// The two arrival histograms must carry the WIDE ladder, not the transport's sub-second one.
/// <para>
/// Same class of guard as <see cref="LatencyHistogramBucketTests"/>, and for the same reason: a view
/// whose instrument name matches nothing is silently ignored, so asserting that the wiring calls
/// <c>AddView</c> would prove nothing. These read the boundaries off an exported metric, which is
/// only possible if the view both exists and matched.
/// </para>
/// <para>
/// <b>Why a different ladder matters here.</b> <c>EgressMeter.LatencySecondsBoundaries</c> stops at
/// 10s, which is right for a broker round trip. These two instruments exist because a pipeline can
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

        // One real measurement through the production entry point, so both instruments are created
        // and have a metric point to export. Both headers present, because the point of the call is
        // to create the streams rather than to check the values.
        IngressMetrics.RecordArrival(
            "orchestrator-result",
            "step-outcome",
            MessageClock.NowMilliseconds() - 100,
            MessageClock.NowMilliseconds() - 5_000);

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

    [Fact]
    public void TheStepElapsedHistogramCarriesTheArrivalLadder()
    {
        var (exporter, host) = Started();
        using (host)
        {
            var bounds = exporter.BoundariesFor(IngressMetrics.StepElapsedInstrument);

            Assert.NotNull(bounds);
            Assert.Equal(IngressMetrics.ArrivalSecondsBoundaries(), bounds!);
        }
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
}
