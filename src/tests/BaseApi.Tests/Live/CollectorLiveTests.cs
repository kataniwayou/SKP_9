using System.Net;
using BaseProcessor.Core.Boot;
using BaseProcessor.Core.Identity;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using OpenTelemetry.Metrics;
using Xunit;

// Aliased because inside this namespace `Processor` binds to BaseApi.Tests.Processor.
using SampleHost = Processor.Sample.ProcessorHost;

namespace BaseApi.Tests.Live;

[Collection(RealStackCollection.Name)]
[Trait("Category", RealStack.Category)]
public sealed class CollectorLiveTests
{
    private readonly RealStackFixture _stack;

    public CollectorLiveTests(RealStackFixture stack) => _stack = stack;

    private static int FreePort()
    {
        var l = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
        l.Start();
        var port = ((IPEndPoint)l.LocalEndpoint).Port;
        l.Stop();
        return port;
    }

    [Fact]
    public async Task ThisProcessorsSeriesAppearAtTheCollectorTaggedWithItsProcessorId()
    {
        // The final link. Everything before this proves the resource is right in-process; this proves
        // the collector actually receives it, which is what a dashboard queries.
        RealStack.SkipUnlessEnabled();

        var probePort = FreePort();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(120));

        // Both travel as environment variables because StartAsync reads its own configuration before a
        // host exists, and the OTLP exporter resolves its endpoint from the ambient environment.
        Environment.SetEnvironmentVariable("ConsoleHealth__Port", probePort.ToString());
        Environment.SetEnvironmentVariable("OTEL_EXPORTER_OTLP_ENDPOINT", RealStack.OtlpEndpoint);

        // The real Stage 1 against the real broker — only the code identity it asks about is
        // substituted, so it resolves the row this fixture created rather than the test host's hash.
        var hash = Substitute.For<ISourceHashProvider>();
        hash.Get().Returns(_stack.SourceHash);

        await using var bootstrap = new BrokerIdentityBootstrap(
            new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["RabbitMq:Host"]     = RealStack.RabbitHost,
                ["RabbitMq:Port"]     = RealStack.RabbitPort.ToString(),
                ["RabbitMq:Username"] = "guest",
                ["RabbitMq:Password"] = "guest",
            }).Build(),
            NullLoggerFactory.Instance,
            TimeProvider.System,
            hash);

        try
        {
            using var host = await SampleHost.StartAsync(
                ["--environment", "Development"], cts.Token,
                cfg => cfg.AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["Service:Name"]                = "processor",
                    ["Service:Version"]             = "0.0.0",
                    ["ConsoleHealth:Port"]          = probePort.ToString(),
                    ["ConnectionStrings:Redis"]     = "localhost:6380,abortConnect=false",
                    ["RabbitMq:Host"]               = RealStack.RabbitHost,
                    ["RabbitMq:Port"]               = RealStack.RabbitPort.ToString(),
                    ["RabbitMq:Username"]           = "guest",
                    ["RabbitMq:Password"]           = "guest",
                    ["OTEL_EXPORTER_OTLP_ENDPOINT"] = RealStack.OtlpEndpoint,
                }),
                bootstrap);

            // ForceFlush rather than waiting out the periodic reader's default minute — the export is
            // what is under test, not the SDK's schedule.
            Assert.True(host.Services.GetRequiredService<MeterProvider>().ForceFlush(10_000));

            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
            var needle = $"processorId=\"{_stack.ProcessorId}\"";
            var deadline = DateTime.UtcNow.AddSeconds(60);
            var found = false;

            while (DateTime.UtcNow < deadline && !found)
            {
                var body = await http.GetStringAsync(RealStack.CollectorMetricsUrl, cts.Token);
                found = body.Contains(needle, StringComparison.Ordinal);

                if (!found)
                {
                    await Task.Delay(TimeSpan.FromSeconds(3), cts.Token);
                }
            }

            Assert.True(found,
                $"no series at {RealStack.CollectorMetricsUrl} carried {needle} within 60s");

            await host.StopAsync(cts.Token);
        }
        finally
        {
            Environment.SetEnvironmentVariable("ConsoleHealth__Port", null);
            Environment.SetEnvironmentVariable("OTEL_EXPORTER_OTLP_ENDPOINT", null);
        }
    }
}
