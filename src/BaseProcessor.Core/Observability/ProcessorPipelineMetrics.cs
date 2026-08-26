using System.Collections.Concurrent;
using System.Diagnostics.Metrics;
using BaseProcessor.Core.Identity;
using Microsoft.Extensions.Hosting;

namespace BaseProcessor.Core.Observability;

/// <summary>The processor meter's name, public so the host can register it on its metrics provider.</summary>
public static class ProcessorPipelineMeter
{
    public const string Name = "BaseProcessor.Core";
}

/// <summary>
/// A static holder for the processor's pipeline meter.
/// <para>
/// The identity gauge needs something singleton to observe, which is
/// <see cref="ProcessorPipelineMetricsHost"/> below.
/// </para>
/// </summary>
internal static class ProcessorPipelineMetrics
{
    internal const string MeterName = ProcessorPipelineMeter.Name;

    internal static readonly Meter Meter = new(MeterName);
}

/// <summary>
/// Owns <c>pipeline.identity.ready</c>.
/// <para>
/// Reads <see cref="IProcessorContext.Identity"/> being non-null, deliberately NOT
/// <see cref="IProcessorContext.IsHealthy"/> — the two are distinct. An unregistered processor waits
/// for its identity row rather than restarting, so a pod sitting Running/NotReady with zero restarts
/// is by design; without this gauge that state is indistinguishable from a hang. Identity resolving
/// is the specific transition this gauge exists to make legible.
/// </para>
/// <para>
/// <b>Observable created once in a static constructor, over a registry, not in the instance
/// constructor.</b> <c>Meter.CreateObservableGauge</c> cannot be undone short of disposing the
/// <see cref="Meter"/> itself, so an observable created per instance leaks a live callback every
/// time one is constructed — every test in this class included. <see cref="Live"/> is what lets many
/// instances exist while exactly one callback is ever registered; see <c>L2GateMetrics</c> for the
/// same shape and the same reasoning.
/// </para>
/// <para>
/// <b>Hosted only so the container constructs it.</b> A DI singleton nothing resolves is an
/// observable that never publishes, with no error to say so. Start and Stop do no work.
/// </para>
/// </summary>
internal sealed class ProcessorPipelineMetricsHost : IHostedService, IDisposable
{
    /// <summary>
    /// Every live owner's processor context, keyed by the owner itself.
    /// <para>
    /// <b>This registry exists so there is ONE observable instrument rather than one per owner.</b>
    /// There is exactly one <see cref="ProcessorPipelineMetricsHost"/> per process in production, but
    /// every test in this class constructs its own — and a second <c>CreateObservableGauge</c> call
    /// on the same instrument name is the duplicate-stream hazard <c>L2GateMetrics</c> documents: the
    /// OpenTelemetry SDK warns about it and may drop the duplicate. Reading each owner's context
    /// through this registry keeps exactly one callback alive
    /// for the process's lifetime, with <see cref="Dispose"/> removing an owner's entry rather than
    /// tearing down the instrument — which cannot be done short of disposing the Meter itself.
    /// </para>
    /// </summary>
    private static readonly ConcurrentDictionary<ProcessorPipelineMetricsHost, IProcessorContext> Live = new();

    static ProcessorPipelineMetricsHost()
    {
        // Registered once, in the static constructor, because an observable created more than once
        // is the duplicate-stream hazard the registry above exists to avoid. The returned instrument
        // is intentionally not stored: the Meter owns it and the callback keeps it alive.
        ProcessorPipelineMetrics.Meter.CreateObservableGauge(
            "pipeline.identity.ready",
            Observe,
            unit: "1",
            description: "1 once this processor resolved its identity row and can accept work.");
    }

    public ProcessorPipelineMetricsHost(IProcessorContext context)
    {
        ArgumentNullException.ThrowIfNull(context);

        Live[this] = context;
    }

    public Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    private static IEnumerable<Measurement<int>> Observe() =>
        Live.Values.Select(context => new Measurement<int>(context.Identity is not null ? 1 : 0));

    /// <summary>
    /// Leaves the registry, so a disposed owner is not merely stale in the next poll but genuinely
    /// absent from it — the gauge stops reporting this owner's state.
    /// </summary>
    public void Dispose() => Live.TryRemove(this, out _);
}
