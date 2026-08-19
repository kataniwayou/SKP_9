using System.Net;
using BaseProcessor.Core.Boot;
using BaseProcessor.Core.Identity;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using OpenTelemetry.Metrics;
using Xunit;

// Aliased because inside this namespace `Processor` binds to BaseApi.Tests.Processor.
using SampleHost = Processor.Sample.ProcessorHost;

namespace BaseApi.Tests.Live;

[Collection(RealStackCollection.Name)]
[Trait("Category", RealStack.Category)]
public sealed class TwoStageBootLiveTests
{
    private readonly RealStackFixture _stack;

    public TwoStageBootLiveTests(RealStackFixture stack) => _stack = stack;

    private static int FreePort()
    {
        var l = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
        l.Start();
        var port = ((IPEndPoint)l.LocalEndpoint).Port;
        l.Stop();
        return port;
    }

    /// <summary>
    /// One booted host and the bootstrap that fed it, both of which the caller must dispose.
    /// <para>
    /// The probe port travels as an environment variable rather than through <c>configure</c>, because
    /// <c>StartAsync</c> reads its own configuration before a host exists — <c>configure</c> reaches
    /// only the host builder, so a port passed that way would leave the Stage 0 listener on whatever
    /// appsettings.json says and every test in this class fighting over one port.
    /// </para>
    /// </summary>
    private sealed record Booted(IHost Host, BrokerIdentityBootstrap Bootstrap) : IAsyncDisposable
    {
        public async ValueTask DisposeAsync()
        {
            await Host.StopAsync(CancellationToken.None);
            Host.Dispose();
            await Bootstrap.DisposeAsync();
            Environment.SetEnvironmentVariable("ConsoleHealth__Port", null);
        }
    }

    private async Task<Booted> BootAsync(CancellationToken ct)
    {
        var probePort = FreePort();
        Environment.SetEnvironmentVariable("ConsoleHealth__Port", probePort.ToString());

        // The real Stage 1 against the real broker — only the code identity it asks about is
        // substituted, so it resolves the row this fixture created rather than the test host's hash.
        var hash = Substitute.For<ISourceHashProvider>();
        hash.Get().Returns(_stack.SourceHash);

        var bootstrap = new BrokerIdentityBootstrap(
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

        var host = await SampleHost.StartAsync(
            ["--environment", "Development"],
            ct,
            cfg => cfg.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Service:Name"]            = "processor",
                ["Service:Version"]         = "0.0.0",
                ["ConsoleHealth:Port"]      = probePort.ToString(),
                ["ConnectionStrings:Redis"] = "localhost:6380,abortConnect=false",
                ["RabbitMq:Host"]           = RealStack.RabbitHost,
                ["RabbitMq:Port"]           = RealStack.RabbitPort.ToString(),
                ["RabbitMq:Username"]       = "guest",
                ["RabbitMq:Password"]       = "guest",
            }),
            bootstrap);

        return new Booted(host, bootstrap);
    }

    [Fact]
    public async Task TheMetricsResourceCarriesTheRowIdentityNotTheSentinel()
    {
        // The claim this whole change exists to make true. If service.name is still "processor" here,
        // the boot resolved an identity and then failed to get it onto the resource — which is the
        // exact failure the SDK's immutable resource makes silent.
        RealStack.SkipUnlessEnabled();

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(90));
        await using var booted = await BootAsync(cts.Token);

        var resource = ResourceReader.Read(booted.Host.Services.GetRequiredService<MeterProvider>());

        Assert.Equal(_stack.Name, resource["service.name"]);
        Assert.Equal(_stack.Version, resource["service.version"]);
        Assert.Equal(_stack.ProcessorId.ToString(), resource["processorId"]);
        Assert.Equal("worker", resource["source"]);
    }

    [Fact]
    public async Task ServiceNameIsTheNameAloneWithNoVersionSuffix()
    {
        // The interpolated {name}_{version} form is deliberately gone: it buried the version inside the
        // name and left logs and metrics disagreeing about what service.name meant.
        RealStack.SkipUnlessEnabled();

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(90));
        await using var booted = await BootAsync(cts.Token);

        var resource = ResourceReader.Read(booted.Host.Services.GetRequiredService<MeterProvider>());

        Assert.DoesNotContain("_", (string)resource["service.name"]);
    }

    [Fact]
    public async Task TheContextIsSeededSoTheOrchestratorNeverAsks()
    {
        RealStack.SkipUnlessEnabled();

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(90));
        await using var booted = await BootAsync(cts.Token);

        var context = booted.Host.Services.GetRequiredService<IProcessorContext>();

        Assert.Equal(_stack.ProcessorId, context.Identity?.Id);
    }
}
