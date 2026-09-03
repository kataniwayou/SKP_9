using BaseConsole.Core.Startup;
using Messaging.Contracts;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace BaseProcessor.Core.Boot;

/// <summary>
/// The three-stage boot: probes up, identity resolved, host built with the answer.
/// <para>
/// <b>Why the order cannot be otherwise.</b> An OpenTelemetry resource is materialised when its
/// provider is built and is immutable afterwards — verified, including through
/// <c>IResourceDetector</c>, which is the latest hook the SDK offers and still fires before the first
/// hosted service runs. A processor's identity is a database row reached over the bus, so it can only
/// reach a resource by being known before the host is built. That is this method.
/// </para>
/// </summary>
public static class ProcessorBoot
{
    /// <summary>
    /// Serves probes on <paramref name="probePort"/>, resolves identity, releases the port, then hands
    /// the identity to <paramref name="buildHost"/> and starts what it returns.
    /// </summary>
    /// <param name="probePort">
    /// The port the real health listener will take over. The same number deliberately: the kubelet is
    /// pointed at one port and must not have to know which stage is answering.
    /// </param>
    /// <param name="bootstrap">Stage 1. Retries without limit; only cancellation ends it.</param>
    /// <param name="buildHost">
    /// Builds the real host from the resolved identity. It is a callback rather than a prebuilt host
    /// because the identity has to be in hand before the builder runs — that is the whole ordering
    /// this method exists to enforce.
    /// </param>
    /// <param name="logs">
    /// The boot sequence's console factory, shared with the identity bootstrap so Stage 1's two
    /// voices — what discovery is doing and what the kubelet is being told — land in one stream.
    /// </param>
    public static async Task<IHost> StartAsync(
        int probePort,
        IIdentityBootstrap bootstrap,
        Func<ProcessorIdentityFound, IHost> buildHost,
        ILoggerFactory logs,
        CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(bootstrap);
        ArgumentNullException.ThrowIfNull(buildHost);
        ArgumentNullException.ThrowIfNull(logs);

        // FIRST, ahead of the probe listener and the identity ask both. Every other host in the
        // stack logs this block from StartupPreflightService, second or third line of its console;
        // this one has no host to run that in until stage 1 has finished, and stage 1's wait is
        // unbounded by design -- an unregistered hash retries rather than crashing. Logged there,
        // the configuration that shaped the wait would appear only after the wait ended, which is
        // the one time nobody needs it.
        //
        // Ahead of BootProbeListener rather than after it, so a port already in use still leaves the
        // block on screen: that failure is one an operator diagnoses FROM this block.
        //
        // EnvironmentSnapshot is BaseConsole.Core's, not a copy. Its masking is what keeps
        // RabbitMq__Password out of this line, and a second implementation of that is a leak waiting
        // for the two to drift.
        // Categorised as ProcessorBoot rather than borrowing StartupPreflightService's name. This
        // line really is emitted here, and stage 1's other voices -- BootProbeListener,
        // BrokerIdentityBootstrap -- log under their own names too. The message text is identical to
        // the one every other host prints, so a grep for it still finds all four.
        var settings = EnvironmentSnapshot.Lines();
        logs.CreateLogger(typeof(ProcessorBoot).FullName!).LogInformation(
            "Loaded {SettingCount} application environment variable(s):{NewLine}{Settings}",
            settings.Count, Environment.NewLine, string.Join(Environment.NewLine, settings));

        ProcessorIdentityFound identity;

        var probes = await BootProbeListener.StartAsync(probePort, logs, ct).ConfigureAwait(false);
        try
        {
            identity = await bootstrap.ResolveAsync(ct).ConfigureAwait(false);
        }
        finally
        {
            // Released even on cancellation. A listener surviving a failed boot would hold the port
            // against the next attempt, turning one failure into a permanent one.
            await probes.DisposeAsync().ConfigureAwait(false);
        }

        var host = buildHost(identity);
        await host.StartAsync(ct).ConfigureAwait(false);
        return host;
    }
}
