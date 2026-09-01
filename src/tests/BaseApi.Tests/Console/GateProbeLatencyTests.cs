using BaseApi.Tests.Support;
using BaseConsole.Core.DependencyInjection;
using BaseConsole.Core.Gating;
using Messaging.Transport;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using OpenTelemetry;
using OpenTelemetry.Metrics;
using Xunit;

namespace BaseApi.Tests.Console;

/// <summary>
/// The gate probe must report how long the store took, not merely whether it answered.
/// <para>
/// <b>Why this instrument exists.</b> Measured on the live stack: Redis made 685x slower for the
/// processor — 0.44 ms to 301 ms round trip, verified with <c>redis-cli --latency</c> — moved
/// nothing on any board. Not the gate, not <c>consuming</c> (<c>pipeline.consumer.consuming</c>,
/// removed in the 2026-08-26 metrics rewrite), not <c>pipeline.process.duration</c> (also removed
/// in that rewrite), which stayed flat at 0.024 s throughout. The gate answers "did the store reply inside 2
/// seconds", which is a yes/no, so a store that is a thousand times slower and still inside the
/// budget is indistinguishable from a healthy one. Past the budget it reads as a full outage.
/// Two states, working and gone, with nothing in between — because nothing was timing the call.
/// </para>
/// <para>
/// <b>The probe is the right place to time.</b> It runs every <c>Interval</c> whether or not any
/// work is flowing, so it is a synthetic latency monitor that reports during idle periods, which a
/// histogram over real traffic cannot do. It is also already bounded by <c>ProbeTimeout</c>, so the
/// measurement has a defined ceiling instead of trailing a hung call.
/// </para>
/// <para>
/// <b>The outcome dimension is load-bearing.</b> A timeout records the ceiling rather than the true
/// duration — the ping is abandoned, not cancelled, so how long it would have taken is unknowable.
/// Mixing that into an untagged histogram would report a p99 of exactly <c>ProbeTimeout</c> and
/// invite a reader to believe it. Tagged, the timeouts can be excluded from a latency panel and
/// counted separately.
/// </para>
/// </summary>
[Collection(EnvironmentCollection.Name)]
public sealed class GateProbeLatencyTests
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
    public void ARecordedProbeIsObservableAsSeconds()
    {
        // The instrument records TotalSeconds, like every other duration here. A probe that answered
        // in 300 ms must land as 0.3, not 300 -- the mistake that put 4767 of 4772 send observations
        // into one bucket before LatencyHistogramBucketTests was written.
        var samples = new List<(double Seconds, string Outcome)>();
        using var listener = new System.Diagnostics.Metrics.MeterListener();
        listener.InstrumentPublished = (instrument, l) =>
        {
            if (instrument.Name == L2GateMetrics.ProbeDurationInstrument)
            {
                l.EnableMeasurementEvents(instrument);
            }
        };
        listener.SetMeasurementEventCallback<double>((_, value, tags, _) =>
        {
            var outcome = "";
            foreach (var tag in tags)
            {
                if (tag.Key == "outcome")
                {
                    outcome = tag.Value?.ToString() ?? "";
                }
            }

            samples.Add((value, outcome));
        });
        listener.Start();

        L2GateMetrics.RecordProbe(TimeSpan.FromMilliseconds(300), "healthy");

        var sample = Assert.Single(samples);
        Assert.Equal(0.3, sample.Seconds, precision: 6);
        Assert.Equal("healthy", sample.Outcome);
    }

    [Fact]
    public void TheProbeHistogramCarriesSecondScaledBoundaries()
    {
        var builder = BuilderWith(("Service:Name", "orchestrator"), ("Service:Version", "1.0.0"));
        builder.AddBaseConsoleObservability(builder.Configuration, source: "worker", defaultServiceName: "test-service", defaultServiceVersion: "9.9.9");

        var exporter = new BoundaryCapturingExporter();
        builder.Services.AddOpenTelemetry().WithMetrics(m => m.AddReader(
            new BaseExportingMetricReader(exporter)));

        using var host = builder.Build();
        var provider = host.Services.GetRequiredService<MeterProvider>();

        // One real measurement through the production entry point, so the instrument exists and has
        // a point to export. A view whose instrument name matches nothing is silently ignored, so
        // reading the boundaries back is the only proof the view both exists and matched.
        L2GateMetrics.RecordProbe(TimeSpan.FromMilliseconds(1), "healthy");
        provider.ForceFlush();

        var bounds = exporter.BoundariesFor(L2GateMetrics.ProbeDurationInstrument);

        Assert.NotNull(bounds);
        Assert.Equal(EgressMeter.LatencySecondsBoundaries(), bounds!);
    }

    [Fact]
    public void TheProbeHistogramIsNotOnTheMillisecondDefaults()
    {
        // Stated as its own claim, for the reason the send histogram states it: the equality above
        // would also fail if the ladder were merely changed, and the reader could not tell which.
        var builder = BuilderWith(("Service:Name", "orchestrator"), ("Service:Version", "1.0.0"));
        builder.AddBaseConsoleObservability(builder.Configuration, source: "worker", defaultServiceName: "test-service", defaultServiceVersion: "9.9.9");

        var exporter = new BoundaryCapturingExporter();
        builder.Services.AddOpenTelemetry().WithMetrics(m => m.AddReader(
            new BaseExportingMetricReader(exporter)));

        using var host = builder.Build();
        var provider = host.Services.GetRequiredService<MeterProvider>();

        L2GateMetrics.RecordProbe(TimeSpan.FromMilliseconds(1), "healthy");
        provider.ForceFlush();

        var bounds = exporter.BoundariesFor(L2GateMetrics.ProbeDurationInstrument);

        Assert.NotNull(bounds);
        Assert.NotEqual(MillisecondDefaults, bounds!);
    }

    [Fact]
    public void TheLadderSeparatesAHealthyProbeFromADegradedOne()
    {
        // The specific thing S10 needed and did not have. A healthy probe on this stack measures
        // ~0.44 ms and a degraded one 301 ms; those must not share a bucket, or the instrument
        // reproduces the blindness it was added to fix.
        var bounds = EgressMeter.LatencySecondsBoundaries();

        static int BucketOf(double[] ladder, double seconds)
        {
            for (var i = 0; i < ladder.Length; i++)
            {
                if (seconds <= ladder[i])
                {
                    return i;
                }
            }

            return ladder.Length;
        }

        var healthy = BucketOf(bounds, 0.00044);
        var degraded = BucketOf(bounds, 0.301);
        var timedOut = BucketOf(bounds, 2.0);

        Assert.True(healthy < degraded,
            $"a 0.44ms probe and a 301ms probe share bucket {healthy}; the ladder cannot show degradation");
        Assert.True(degraded < timedOut,
            $"a 301ms probe and a 2s timeout share bucket {degraded}; the ladder cannot show a stall");
    }
}
