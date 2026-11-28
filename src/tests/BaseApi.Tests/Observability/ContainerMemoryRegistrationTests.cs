using BaseApi.Core.DependencyInjection;
using BaseApi.Tests.Support;
using BaseConsole.Core.DependencyInjection;
using Messaging.Transport;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using OpenTelemetry;
using OpenTelemetry.Metrics;
using Xunit;

namespace BaseApi.Tests.Observability;

/// <summary>
/// Both host kinds must EXPORT the container-memory meter, not merely have it exist. A
/// <see cref="MetricCollector"/> would see the instruments whether or not a host registered the
/// meter, so these tests read the SDK's own export path instead: an exporter attached by the test,
/// which receives a metric only for a meter the host passed to <c>AddMeter</c>. The test adds no
/// <c>AddMeter</c> of its own, so the instrument reaching it proves the host's wiring.
/// <para>
/// Working set is the instrument asserted because it exists on every platform. The cgroup ones
/// depend on the machine, and <c>ContainerMemoryMetricsTests</c> covers them.
/// </para>
/// </summary>
[Collection(EnvironmentCollection.Name)]
public sealed class ContainerMemoryRegistrationTests
{
    private static HostApplicationBuilder BuilderWith(string name, string version)
    {
        var builder = Host.CreateApplicationBuilder();

        // Drop the default sources: this output directory holds Processor.Sample's appsettings.json.
        builder.Configuration.Sources.Clear();
        builder.Configuration.AddInMemoryCollection(
        [
            new KeyValuePair<string, string?>("Service:Name", name),
            new KeyValuePair<string, string?>("Service:Version", version),
        ]);
        return builder;
    }

    private static List<string> Exported(HostApplicationBuilder builder)
    {
        var exporter = new CapturingExporter();
        builder.Services.AddOpenTelemetry().WithMetrics(m => m.AddReader(new BaseExportingMetricReader(exporter)));

        using var host = builder.Build();
        host.Services.GetRequiredService<MeterProvider>().ForceFlush();
        return exporter.InstrumentNames;
    }

    [Fact]
    public void TheWorkerHostsExportTheContainerMemoryMeter()
    {
        var builder = BuilderWith("orchestrator", "1.0.0");
        builder.AddBaseConsoleObservability(builder.Configuration, source: "worker",
            defaultServiceName: "test-service", defaultServiceVersion: "9.9.9");

        Assert.Contains(ContainerMemoryMetrics.WorkingSetInstrument, Exported(builder));
    }

    [Fact]
    public void TheApiHostExportsTheContainerMemoryMeter()
    {
        var builder = BuilderWith("baseapi", "0.0.0");
        builder.AddBaseApiObservability(builder.Configuration, source: "webapi");

        var names = Exported(builder);

        Assert.Contains(ContainerMemoryMetrics.WorkingSetInstrument, names);
        Assert.Contains(ContainerMemoryMetrics.ThreadsInstrument, names);
    }

    private sealed class CapturingExporter : BaseExporter<Metric>
    {
        public List<string> InstrumentNames { get; } = [];

        public override ExportResult Export(in Batch<Metric> batch)
        {
            foreach (var metric in batch)
            {
                InstrumentNames.Add(metric.Name);
            }

            return ExportResult.Success;
        }
    }
}
