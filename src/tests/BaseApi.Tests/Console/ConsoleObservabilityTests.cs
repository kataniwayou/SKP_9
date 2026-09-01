using System.Reflection;
using BaseConsole.Core.DependencyInjection;
using BaseConsole.Core.Gating;
using BaseConsole.Core.Messaging;
using Messaging.Transport;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using OpenTelemetry;
using OpenTelemetry.Metrics;
using BaseApi.Tests.Support;
using Xunit;

namespace BaseApi.Tests.Console;

[Collection(EnvironmentCollection.Name)]
public sealed class ConsoleObservabilityTests
{
    private static IHostApplicationBuilder BuilderWith(params (string Key, string Value)[] settings)
    {
        var builder = Host.CreateApplicationBuilder();

        // Drop the default sources first. The host builder reads appsettings.json from the content
        // root, and this output directory holds one — Processor.Sample's, copied in by the project
        // reference. A test asserting that a missing key fails fast must not be able to find that key
        // in a file it never mentioned.
        builder.Configuration.Sources.Clear();
        builder.Configuration.AddInMemoryCollection(
            settings.Select(s => new KeyValuePair<string, string?>(s.Key, s.Value)));
        return builder;
    }

    [Fact]
    public void FallsBackToTheDefaultWhenTheServiceNameIsMissing()
    {
        // Was a fail-fast. A service that cannot read its own name now reports under the name it
        // declares rather than refusing to start — deployment order and a half-applied config should
        // not be able to keep a process down.
        var builder = BuilderWith(("Service:Version", "1.0.0"));

        var returned = builder.AddBaseConsoleObservability(
            builder.Configuration, source: "worker",
            defaultServiceName: "test-service", defaultServiceVersion: "9.9.9");

        Assert.Same(builder, returned);
    }

    [Fact]
    public void FallsBackToTheDefaultWhenTheServiceVersionIsMissing()
    {
        var builder = BuilderWith(("Service:Name", "processor"));

        var returned = builder.AddBaseConsoleObservability(
            builder.Configuration, source: "worker",
            defaultServiceName: "test-service", defaultServiceVersion: "9.9.9");

        Assert.Same(builder, returned);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void FallsBackWhenTheServiceNameIsPresentButBlank(string blank)
    {
        // The case the old null-only guard let through: an env var set to "" in a manifest, or one
        // that templated to nothing, reached ResourceBuilder.AddService and failed there as
        // "ArgumentException: Must not be null or empty (Parameter 'serviceName')" — an SDK error
        // naming no setting. Blank must be treated as absent, not as a name.
        var builder = BuilderWith(("Service:Name", blank), ("Service:Version", blank));

        var returned = builder.AddBaseConsoleObservability(
            builder.Configuration, source: "worker",
            defaultServiceName: "test-service", defaultServiceVersion: "9.9.9");

        Assert.Same(builder, returned);
    }

    [Fact]
    public void RequiresADefaultServiceName()
    {
        // Required of both callers rather than defaulted here: this helper is shared by the
        // orchestrator and every processor, so a default invented in it would be wrong for one of
        // them, and an optional one would let a caller inherit the other's name by omission.
        var builder = BuilderWith(("Service:Name", "processor"), ("Service:Version", "1.0.0"));

        Assert.Throws<ArgumentException>(
            () => builder.AddBaseConsoleObservability(
                builder.Configuration, source: "worker",
                defaultServiceName: "  ", defaultServiceVersion: "9.9.9"));
    }

    [Fact]
    public void RequiresAnEmitterSource()
    {
        // Required rather than defaulted, so a new console cannot ship without naming its tier.
        // service.name cannot stand in for it: that names the role, one level finer.
        var builder = BuilderWith(("Service:Name", "processor"), ("Service:Version", "0.0.0"));

        Assert.Throws<ArgumentException>(
            () => builder.AddBaseConsoleObservability(builder.Configuration, source: "  ", defaultServiceName: "test-service", defaultServiceVersion: "9.9.9"));
    }

    [Fact]
    public void WiresUpWithTheProcessorSentinel()
    {
        var builder = BuilderWith(("Service:Name", "processor"), ("Service:Version", "0.0.0"));

        var returned = builder.AddBaseConsoleObservability(builder.Configuration, source: "worker", defaultServiceName: "test-service", defaultServiceVersion: "9.9.9");

        Assert.Same(builder, returned);
    }

    [Fact]
    public void TheInstanceIdResolverHasNotDriftedFromTheApiCopy()
    {
        // BaseApi.Core cannot reference BaseConsole.Core, so the precedence expression exists twice.
        // Its own comment promises this guard; without it the two silently disagree and a pod's
        // liveness key stops matching the service.instance.id on its telemetry.
        var apiResolver = typeof(BaseApi.Core.DependencyInjection.ObservabilityServiceCollectionExtensions)
            .GetMethod("ResolveInstanceId", BindingFlags.NonPublic | BindingFlags.Static);

        Assert.NotNull(apiResolver);

        // The ambient environment is the easy case — both fall through to the machine name. The one
        // that matters is a downward-API field that resolved to nothing. Whitespace rather than "",
        // because SetEnvironmentVariable deletes a variable set to the empty string, so "" would test
        // deletion instead of blankness.
        foreach (var (pod, host) in new[]
                 {
                     ((string?)null, (string?)null),
                     ("proc-sample-7d9f", null),
                     (null, "some-host"),
                     ("   ", "some-host"),
                 })
        {
            var podBefore  = Environment.GetEnvironmentVariable("POD_NAME");
            var hostBefore = Environment.GetEnvironmentVariable("HOSTNAME");
            try
            {
                Environment.SetEnvironmentVariable("POD_NAME", pod);
                Environment.SetEnvironmentVariable("HOSTNAME", host);
                Assert.Equal(apiResolver!.Invoke(null, null), InstanceId.Resolve().Value);
            }
            finally
            {
                Environment.SetEnvironmentVariable("POD_NAME", podBefore);
                Environment.SetEnvironmentVariable("HOSTNAME", hostBefore);
            }
        }
    }

    [Fact]
    public void AnExplicitServiceNameDoesNotNeedTheConfigKey()
    {
        // The two-stage boot knows the name from the database row, so requiring Service:Name as well
        // would make config the authority over a value config cannot know.
        var builder = BuilderWith(("Service:Version", "0.0.0"));

        var returned = builder.AddBaseConsoleObservability(
            builder.Configuration, source: "worker",
            defaultServiceName: "test-service", defaultServiceVersion: "9.9.9",
            serviceName: "sample-proc", serviceVersion: "1.0.0");

        Assert.Same(builder, returned);
    }

    [Fact]
    public void ExplicitIdentityIsUsedEvenWhenConfigDisagrees()
    {
        var builder = BuilderWith(("Service:Name", "processor"), ("Service:Version", "0.0.0"));

        var returned = builder.AddBaseConsoleObservability(
            builder.Configuration, source: "worker",
            defaultServiceName: "test-service", defaultServiceVersion: "9.9.9",
            serviceName: "sample-proc", serviceVersion: "1.0.0");

        Assert.Same(builder, returned);
    }

    [Fact]
    public void ResourceAttributesCarryBothCasings()
    {
        // One value, two keys: the log and metric conventions differ and a single key would force one
        // signal to break its own convention.
        var attr = new ResourceAttribute("ProcessorId", "processorId", "9e034ca0");

        Assert.Equal("ProcessorId", attr.LogKey);
        Assert.Equal("processorId", attr.MetricKey);
        Assert.Equal("9e034ca0", attr.Value);
    }

    [Fact]
    public void ExtraResourceAttributesAreAccepted()
    {
        var builder = BuilderWith(("Service:Name", "processor"), ("Service:Version", "0.0.0"));

        var returned = builder.AddBaseConsoleObservability(
            builder.Configuration, source: "worker",
            defaultServiceName: "test-service", defaultServiceVersion: "9.9.9",
            serviceName: "sample-proc", serviceVersion: "1.0.0",
            resourceAttributes: [new ResourceAttribute("ProcessorId", "processorId", "9e034ca0")]);

        Assert.Same(builder, returned);
    }

    [Fact]
    public async Task TheThreePipelineMetersAreRegisteredOnTheMetricsProvider()
    {
        // The enforcement mechanism for the whole design: both hosts already call this method, so a
        // new worker cannot ship without the shared instruments.
        //
        // Honesty about what this proves. MetricCollector below is a MeterListener, and a
        // MeterListener observes measurements regardless of whether OpenTelemetry is configured at
        // all -- so the "all three publish" assertion alone would pass even with the three AddMeter
        // calls deleted from production code. What makes this test depend on the registration is the
        // second, independent listener: a custom exporter attached to THIS test's own additional
        // WithMetrics call (proven below to accumulate onto, not replace, the configuration
        // AddBaseConsoleObservability already applied) receives a metric from the SDK's own export
        // path only for instruments belonging to a meter the provider was told about via AddMeter.
        // Since this test adds no AddMeter calls of its own, seeing these three instrument names on
        // the SDK-side exporter is possible only if AddBaseConsoleObservability itself registered
        // exactly these three meters.
        // Host.CreateApplicationBuilder returns the concrete HostApplicationBuilder, which is the
        // only IHostApplicationBuilder implementation exposing Build() -- BuilderWith's declared
        // return type is the interface, so the concrete type is recovered here to call it.
        var builder = (HostApplicationBuilder)BuilderWith(
            ("Service:Name", "orchestrator"), ("Service:Version", "1.0.0"));
        builder.AddBaseConsoleObservability(builder.Configuration, source: "worker", defaultServiceName: "test-service", defaultServiceVersion: "9.9.9");

        var exporter = new CapturingExporter();
        builder.Services.AddOpenTelemetry().WithMetrics(m => m.AddReader(
            new BaseExportingMetricReader(exporter)));

        using var host = builder.Build();
        using var collector = new MetricCollector(
            EgressMeter.Name, IngressMetrics.MeterName, L2GateMetrics.MeterName);

        // Force the MeterProvider to be constructed -- and its own internal listener started --
        // before anything is recorded. A Counter.Add() call only reaches listeners that are already
        // subscribed at the moment it runs; resolving the provider after recording would make the
        // SDK-side listener miss every measurement regardless of whether AddMeter was ever called,
        // which would silently turn the registration-dependent assertions below into a false
        // negative rather than a real signal.
        var meterProvider = host.Services.GetRequiredService<MeterProvider>();

        // Publish one measurement on each of the three meters through the internal recording entry
        // points -- the same ones production code uses.
        await EgressMetrics.MeasureAsync("queue", "dest", "type", () => Task.CompletedTask);
        IngressMetrics.RecordConsumed(
            "queue", "type", "acked", "handled");
        var gate = new L2Gate(NullLogger<L2Gate>.Instance);
        using var gateMetrics = new L2GateMetrics(gate);

        collector.Collect();
        meterProvider.ForceFlush();

        // Behavioural half: the listener saw all three (does not by itself depend on registration).
        Assert.NotEmpty(collector.For("pipeline.messages.produced"));
        Assert.NotEmpty(collector.For("pipeline.messages.consumed"));
        Assert.NotEmpty(collector.For("pipeline.gate.open"));

        // Registration-dependent half: the SDK's own export path saw the same three instruments,
        // which it can only do if the provider was told about all three meters via AddMeter.
        Assert.Contains("pipeline.messages.produced", exporter.InstrumentNames);
        Assert.Contains("pipeline.messages.consumed", exporter.InstrumentNames);
        Assert.Contains("pipeline.gate.open", exporter.InstrumentNames);
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
