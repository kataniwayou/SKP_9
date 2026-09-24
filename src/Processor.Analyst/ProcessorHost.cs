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
using Processor.Analyst.Bit;
using Processor.Analyst.Loop;

namespace Processor.Analyst;

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
    /// <param name="args">
    /// The process arguments, forwarded to the host builder so the standard configuration providers
    /// that read them keep working.
    /// </param>
    /// <param name="ct">
    /// Cancels the identity wait. Stage 1 retries forever by design -- an unregistered processor is
    /// waiting correctly, not failing -- so this is the only thing that ends it early.
    /// </param>
    /// <param name="configure">
    /// Extra configuration applied before the host is built. Null in production; a test uses it to
    /// point the shell at its own broker and Redis.
    /// </param>
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
                bootLogs,
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
    /// <param name="configureServices">
    /// Extra service registrations applied after this shell's own, before the host is built. Null in
    /// production. A test uses it to substitute fakes for <c>IAnalystModel</c> and
    /// <c>IPanelReader</c>, which have no production implementation until Tasks 13 and 14 — without
    /// it, the whole-graph <c>ValidateOnBuild</c> form has no way to make this composition root
    /// resolve end to end.
    /// </param>
    public static IHost Create(
        string[] args,
        ProcessorIdentityFound identity,
        Action<IConfigurationBuilder>? configure = null,
        Action<IServiceCollection>? configureServices = null)
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
            // Declared for symmetry with the other two services, and unreachable in practice: the
            // identity below is a resolved database row and is never blank, so it wins every time.
            // Stating it anyway keeps all three call sites answering the same question the same way.
            defaultServiceName: "processor",
            defaultServiceVersion: "1.0.0",
            serviceName: identity.Name,
            serviceVersion: identity.Version,
            resourceAttributes: [new ResourceAttribute("ProcessorId", "processorId", identity.Id.ToString())]);

        // A second WithMetrics on the same OpenTelemetryBuilder adds to the provider the shared
        // call configured rather than replacing it.
        builder.Services.AddOpenTelemetry()
            .WithMetrics(m => m
                .AddMeter(ProcessorPipelineMeter.Name));

        // Everything else: broker, Redis, health probes, the schema loop and the liveness loop.
        builder.Services.AddBaseProcessor(builder.Configuration, identity);

        // The Analyst's own graph. The model adapter (Task 13) and the panel reader (Task 14) are not
        // registered here — nothing under src/Processor.Analyst implements IAnalystModel or
        // IPanelReader yet — so the whole-graph ValidateOnBuild form only resolves when a caller
        // supplies both through configureServices (tests do this today; the real adapters replace
        // that call when Tasks 13/14 land).
        builder.Services.AddSingleton<BitCache>(_ => new BitCache(capacity: 8));
        builder.Services.AddSingleton<PreflightBit>();
        builder.Services.AddSingleton<InvestigationLoop>();

        builder.Services.Configure<Model.AnalystModelOptions>(builder.Configuration.GetSection("Analyst:Model"));
        builder.Services.AddSingleton<Model.IAnalystModel, Model.AnthropicAnalystModel>();

        // The concrete processor the pre/post handlers resolve as BaseProcessor. AddBaseProcessor
        // deliberately does not register an author's implementation, so this exact form -- against
        // the base type, not AddSingleton<AnalystProcessor>() alone -- is what makes the framework
        // see it. Matches Processor.SKNormalizer/ProcessorHost.cs.
        builder.Services.AddSingleton<BaseProcessor.Core.Processing.BaseProcessor, AnalystProcessor>();

        configureServices?.Invoke(builder.Services);

        return builder.Build();
    }
}
