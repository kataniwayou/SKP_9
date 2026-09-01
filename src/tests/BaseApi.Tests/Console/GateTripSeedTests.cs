using BaseApi.Tests.Support;
using BaseConsole.Core.DependencyInjection;
using BaseConsole.Core.Gating;
using Messaging.Transport;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using OpenTelemetry;
using OpenTelemetry.Metrics;
using Xunit;

namespace BaseApi.Tests.Console;

/// <summary>
/// A seeded instrument must reach a reader that did not exist when the seed was taken.
/// <para>
/// <b>Why these tests need a real provider and the existing ones could not catch this.</b> Every
/// other metric test here uses <c>MetricCollector</c>, a <c>MeterListener</c> the test constructs
/// FIRST -- so a seed pushed afterwards is always seen and the tests pass. Production has the
/// opposite ordering: the host materialises every <c>IHostedService</c> before starting any of
/// them, and the OpenTelemetry hosted service is the one that builds the <c>MeterProvider</c>. A
/// seed taken in a constructor therefore has no reader at all, is dropped, and creates no metric
/// point -- so an instrument that is never otherwise touched exports nothing. That is why
/// <c>pipeline_gate_trips_total</c> was absent from every host while
/// <c>pipeline_gate_open_ratio</c>, an observable on the same meter registered from the same
/// constructor, read 1 everywhere.
/// </para>
/// </summary>
[Collection(EnvironmentCollection.Name)]
public sealed class GateTripSeedTests
{
    private static HostApplicationBuilder BuilderWith(params (string Key, string Value)[] settings)
    {
        var builder = Host.CreateApplicationBuilder();
        builder.Configuration.Sources.Clear();
        builder.Configuration.AddInMemoryCollection(
            settings.Select(s => new KeyValuePair<string, string?>(s.Key, s.Value)));
        return builder;
    }

    [Fact]
    public async Task ARegisteredGateExportsATripSeriesBeforeItEverTrips()
    {
        var builder = BuilderWith(("Service:Name", "orchestrator"), ("Service:Version", "1.0.0"));
        builder.AddBaseConsoleObservability(builder.Configuration, source: "worker", defaultServiceName: "test-service", defaultServiceVersion: "9.9.9");

        var exporter = new ExportedSeriesExporter();
        builder.Services.AddOpenTelemetry().WithMetrics(m => m.AddReader(
            new BaseExportingMetricReader(exporter)));

        // The production wiring: the gate's metrics owner is a hosted service, and the host
        // constructs every hosted service before it starts any of them.
        builder.Services.AddSingleton(new L2Gate(NullLogger<L2Gate>.Instance));
        builder.Services.AddHostedService<L2GateMetrics>();

        using var host = builder.Build();
        await host.StartAsync(TestContext.Current.CancellationToken);
        host.Services.GetRequiredService<MeterProvider>().ForceFlush();
        await host.StopAsync(TestContext.Current.CancellationToken);

        Assert.Contains(GateMetrics.TripsInstrument, exporter.Instruments);
    }

    [Fact]
    public async Task ASeededLoopExportsASeriesBeforeItEverIterates()
    {
        // The same defect, one instrument over. Every loop series on the live stack was present
        // only because its loop was running -- the seed itself reached no reader, so a loop that
        // failed to start would have been indistinguishable from a loop nothing was measuring,
        // which is the one case the seed exists to express.
        var builder = BuilderWith(("Service:Name", "orchestrator"), ("Service:Version", "1.0.0"));
        builder.AddBaseConsoleObservability(builder.Configuration, source: "worker", defaultServiceName: "test-service", defaultServiceVersion: "9.9.9");

        var exporter = new ExportedSeriesExporter();
        builder.Services.AddOpenTelemetry().WithMetrics(m => m.AddReader(
            new BaseExportingMetricReader(exporter)));

        using var host = builder.Build();

        // Seeded before the provider exists, and never incremented: exactly a loop that was wired
        // up and then failed to run.
        LoopMetrics.Seed("never-runs");

        await host.StartAsync(TestContext.Current.CancellationToken);
        host.Services.GetRequiredService<MeterProvider>().ForceFlush();
        await host.StopAsync(TestContext.Current.CancellationToken);

        Assert.Contains(LoopMetrics.IterationsInstrument, exporter.Instruments);
    }
}
