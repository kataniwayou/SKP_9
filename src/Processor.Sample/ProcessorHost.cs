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
        // collection, and it needs the application type — `worker`, shared by every background
        // host and paired with `webapi` on the API side. The role is carried separately by
        // service.name, which stays the `processor` sentinel for the process's whole life: the
        // database row's identity cannot reach an OTel resource, which is fixed when the provider is
        // built, so it rides per-record instead.
        builder.AddBaseConsoleObservability(builder.Configuration, source: "worker");

        // Everything else: broker, Redis, health probes, identity discovery and the liveness loop.
        builder.Services.AddBaseProcessor(builder.Configuration);

        return builder.Build();
    }
}
