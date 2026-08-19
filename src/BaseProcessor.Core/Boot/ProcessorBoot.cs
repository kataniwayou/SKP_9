using Messaging.Contracts;
using Microsoft.Extensions.Hosting;

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
    public static async Task<IHost> StartAsync(
        int probePort,
        IIdentityBootstrap bootstrap,
        Func<ProcessorIdentityFound, IHost> buildHost,
        CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(bootstrap);
        ArgumentNullException.ThrowIfNull(buildHost);

        ProcessorIdentityFound identity;

        var probes = await BootProbeListener.StartAsync(probePort, ct).ConfigureAwait(false);
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
