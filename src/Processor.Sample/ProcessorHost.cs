using BaseConsole.Core.DependencyInjection;
using BaseProcessor.Core.Boot;
using BaseProcessor.Core.DependencyInjection;
using BaseProcessor.Core.Observability;
using Messaging.Contracts;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using OpenTelemetry.Metrics;

namespace Processor.Sample;

/// <summary>
/// The composition root, as methods rather than inline in <c>Program</c> so that the one thing worth
/// asserting about a shell — that its service graph actually resolves — can be asserted without
/// starting a process.
/// </summary>
public static class ProcessorHost
{
    /// <summary>
    /// The production entry point: probes, then identity, then a host built around the answer.
    /// </summary>
    /// <param name="bootstrap">
    /// Stage 1. Null uses the real broker; a test passes its own so the sequence can be exercised
    /// without one.
    /// </param>
    public static async Task<IHost> StartAsync(
        string[] args,
        CancellationToken ct,
        Action<IConfigurationBuilder>? configure = null,
        IIdentityBootstrap? bootstrap = null)
    {
        // Configuration is read twice — once for the boot, once by the host builder — because the boot
        // has to know where the broker is before a host exists to tell it.
        var bootConfig = new ConfigurationBuilder()
            .AddJsonFile("appsettings.json", optional: true)
            .AddEnvironmentVariables()
            .Build();

        // Console only. This is the whole logging surface for the identity window, which is exactly
        // where an operator is already looking: kubectl logs on a pod that is not ready yet.
        using var bootLogs = LoggerFactory.Create(b => b.AddConsole());

        var owned = bootstrap is null;
        var resolver = bootstrap ?? new BrokerIdentityBootstrap(
            bootConfig, bootLogs, TimeProvider.System);

        try
        {
            return await ProcessorBoot.StartAsync(
                bootConfig.GetValue<int?>("ConsoleHealth:Port") ?? 8081,
                resolver,
                identity => Create(args, identity, configure),
                ct).ConfigureAwait(false);
        }
        finally
        {
            if (owned && resolver is IAsyncDisposable disposable)
            {
                await disposable.DisposeAsync().ConfigureAwait(false);
            }
        }
    }

    /// <summary>
    /// Builds the host around an identity that is already known. Separate from
    /// <see cref="StartAsync"/> so a test can assert the graph resolves without a broker.
    /// </summary>
    public static IHost Create(
        string[] args, ProcessorIdentityFound identity, Action<IConfigurationBuilder>? configure = null)
    {
        ArgumentNullException.ThrowIfNull(identity);

        var builder = Host.CreateApplicationBuilder(args);
        configure?.Invoke(builder.Configuration);

        // The identity from the database row, not from configuration. It reaches the OTel resource
        // only because it was resolved before this line ran: a resource is materialised when its
        // provider is built and is immutable afterwards, so there is no later opportunity.
        //
        // ProcessorId rides alongside because it is the only exact identifier — name and version are
        // unconstrained columns, and two different builds can carry the same pair.
        builder.AddBaseConsoleObservability(
            builder.Configuration,
            source: "worker",
            serviceName: identity.Name,
            serviceVersion: identity.Version,
            resourceAttributes: [new ResourceAttribute("ProcessorId", "processorId", identity.Id.ToString())]);

        // A second WithMetrics on the same OpenTelemetryBuilder adds to the provider the shared
        // call configured rather than replacing it.
        builder.Services.AddOpenTelemetry()
            .WithMetrics(m => m.AddMeter(ProcessorPipelineMeter.Name));

        // Everything else: broker, Redis, health probes, the schema loop and the liveness loop.
        builder.Services.AddBaseProcessor(builder.Configuration, identity);

        // The concrete processor the pre/post handlers resolve as BaseProcessor. Singleton, matching
        // the seam's design: per-dispatch state lives in a plain field on this one instance, which is
        // safe only because prefetch is 1.
        builder.Services.AddSingleton<BaseProcessor.Core.Processing.BaseProcessor, SampleProcessor>();

        return builder.Build();
    }
}
