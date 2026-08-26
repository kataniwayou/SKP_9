using Messaging.Transport;
using Microsoft.Extensions.Hosting;

namespace BaseApi.Core.Gating;

/// <summary>
/// Publishes this host's projection-store gate as metrics, without <see cref="L2Gate"/> knowing
/// about it.
/// <para>
/// <b>A separate owner rather than instrumentation inside the gate, and that is a constraint.</b>
/// <see cref="L2Gate"/> here and its <c>BaseConsole.Core</c> twin are deliberate copies whose
/// behaviour must not diverge, so neither is edited to record anything. The instruments live in
/// <see cref="GateMetrics"/>, below both libraries, and this type is only the wiring that hands one
/// gate to them.
/// </para>
/// <para>
/// <b>It is an <see cref="IHostedService"/> only so the container constructs it.</b> A DI singleton
/// is never built until something resolves it, and a gauge that is never registered reports nothing
/// -- with no error anywhere to say so. Start and Stop do no work.
/// </para>
/// <para>
/// The subscription honours the gate's standing rule that handlers must not perform I/O and must not
/// re-enter it: incrementing a counter is a flag flip. The gauge does not use the event at all,
/// reading <see cref="L2Gate.IsOpen"/> when it is polled.
/// </para>
/// </summary>
internal sealed class L2GateMetrics : IHostedService, IDisposable
{
    private readonly L2Gate _gate;
    private readonly IDisposable _registration;

    public L2GateMetrics(L2Gate gate)
    {
        _gate = gate ?? throw new ArgumentNullException(nameof(gate));

        _registration = GateMetrics.Register(() => gate.IsOpen);
        _gate.StateChanged += OnStateChanged;
    }

    public Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    /// <summary>
    /// The falling edge only. The gate raises this on transitions in both directions, and counting
    /// both would make the number mean "changes" rather than "outages" -- half of it would be the
    /// recoveries.
    /// </summary>
    private void OnStateChanged(bool open)
    {
        if (!open)
        {
            GateMetrics.RecordTrip();
        }
    }

    /// <summary>
    /// Unsubscribes AND deregisters, so a disposed owner is not merely stale in the next poll but
    /// genuinely absent from it.
    /// </summary>
    public void Dispose()
    {
        _gate.StateChanged -= OnStateChanged;
        _registration.Dispose();
    }
}
