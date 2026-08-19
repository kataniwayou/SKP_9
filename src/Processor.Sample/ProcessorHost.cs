using BaseConsole.Core.DependencyInjection;
using BaseProcessor.Core.DependencyInjection;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace Processor.Sample;

/// <summary>
/// The composition root, as a method rather than inline in <c>Program</c> so that the one thing worth
/// asserting about a shell — that its service graph actually resolves — can be asserted without
/// starting a process.
/// </summary>
public static class ProcessorHost
{
    /// <param name="args">Command-line arguments, folded into configuration as usual.</param>
    /// <param name="configure">
    /// Extra configuration sources, applied last so they win. Production passes nothing; a test uses
    /// it to supply settings in place of the appsettings.json that sits beside the real binary.
    /// </param>
    public static IHost Create(string[] args, Action<IConfigurationBuilder>? configure = null)
    {
        var builder = Host.CreateApplicationBuilder(args);
        configure?.Invoke(builder.Configuration);

        // The one call the shell makes for itself. It needs the host builder rather than the service
        // collection, and it needs the emitter class — the single question only a concrete console
        // can answer, and the only reliable one on a processor, whose service name stays the
        // `unresolved` sentinel until its identity arrives per-record from the database row.
        builder.AddBaseConsoleObservability(builder.Configuration, source: "processor");

        // Everything else: broker, Redis, health probes, identity discovery and the liveness loop.
        builder.Services.AddBaseProcessor(builder.Configuration);

        return builder.Build();
    }
}
