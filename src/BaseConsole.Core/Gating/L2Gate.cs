using Microsoft.Extensions.Logging;

namespace BaseConsole.Core.Gating;

/// <summary>
/// A one-bit view of whether the projection store is usable, shared by the probe that measures it and
/// the consumers that must not run without it.
/// <para>
/// <b>This is a deliberate copy of <c>BaseApi.Core.Gating.L2Gate</c>, not a shared type.</b>
/// The API and console halves are siblings with no reference between them, and this repository
/// already carries paired copies of <c>RequiredConfig</c>, <c>ILoopHeartbeat</c>,
/// <c>LoopHeartbeat</c>, <c>LoopLivenessHealthCheck</c>, <c>IStartupGate</c> and
/// <c>StartupHealthCheck</c> for the same reason. Behaviour must not diverge: the two are covered by
/// parallel test classes so a change to one that is not made to the other fails a build.
/// </para>
/// <para>
/// <b>The two directions are not symmetric, and that asymmetry is the design.</b> Closing happens on
/// proof — a consumer that just failed against the store knows more than any probe. Opening happens
/// only on measurement, and only after several consecutive successes, because a single reply proves a
/// socket answered rather than that the store is back. Anything else lets one lucky response resume
/// the whole flow into an outage.
/// </para>
/// <para>
/// <b>It is constructed CLOSED, and that is load-bearing rather than cautious.</b> Notification fires
/// on transitions only, so a gate that started open would never produce an opening edge — and the
/// consumer, which is started by exactly that edge, would wait for a signal that by construction can
/// never arrive. No exception, no failing health check: just a queue that fills while nothing reads
/// it. Starting closed also happens to be the honest posture, since at startup nothing has measured
/// the store yet and every gated consumer opens with a write.
/// </para>
/// <para>
/// <b>Handlers must not call back into this type, and must not perform I/O.</b> They run while the
/// mutex is held, so re-entering deadlocks. Doing slow work there is subtler but worse: it makes
/// every caller of <see cref="TripAsync"/> wait on a broker round-trip, including the probe loop
/// whose continued ticking is what proves this process is alive. Signal and return; let the
/// subscriber converge on its own thread.
/// </para>
/// </summary>
public sealed class L2Gate
{
    private readonly ILogger<L2Gate> _logger;

    // Transition and notification happen under one mutex. Without it two racing callers can both pass
    // the equality check and notify twice, and a trip racing a recovery can deliver the two
    // notifications in the opposite order from the final state — leaving subscribers paused while the
    // gate reads open.
    private readonly SemaphoreSlim _mutex = new(1, 1);

    private volatile bool _isOpen;
    private volatile TaskCompletionSource _tripped;

    public L2Gate(ILogger<L2Gate> logger)
    {
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));

        // Pre-completed: a probe that awaits Tripped before its first measurement must not block,
        // because at startup the closed state is exactly what it is there to resolve.
        var tripped = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        tripped.TrySetResult();
        _tripped = tripped;
        _isOpen = false;
    }

    /// <summary>Whether consumers of the projection store may currently run.</summary>
    public bool IsOpen => _isOpen;

    /// <summary>
    /// Raised on transitions only, with the new state. Runs under the mutex — see the type remarks
    /// for what that forbids.
    /// </summary>
    public event Action<bool>? StateChanged;

    /// <summary>
    /// Completes the moment the gate closes, and is replaced with a fresh incomplete task when it
    /// reopens. Lets a waiter wake on the close rather than discovering it a poll interval later.
    /// </summary>
    public Task Tripped => _tripped.Task;

    /// <summary>Close the gate. Called on proof of failure; never opens.</summary>
    public Task TripAsync() => SetAsync(false);

    /// <summary>Open the gate. Called by the probe on sustained success; never closes.</summary>
    public Task ReportHealthyAsync() => SetAsync(true);

    private async Task SetAsync(bool open)
    {
        await _mutex.WaitAsync().ConfigureAwait(false);
        try
        {
            if (_isOpen == open)
            {
                return;   // notify on transitions only, so both entry points are safe to call per tick
            }

            _isOpen = open;

            // Logged here rather than at the call sites because this is the only place that knows a
            // transition happened: the probe calls both entry points on every tick, so a call-site log
            // would emit a line per tick and bury the edges. Closing is a Warning because it pauses
            // consumption; opening is the recovery, so Information.
            if (open)
            {
                _logger.LogInformation("L2 gate open — projection store healthy, consumers may run");
            }
            else
            {
                _logger.LogWarning("L2 gate closed — projection store unusable, consumers paused");
            }

            if (open)
            {
                _tripped = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            }
            else
            {
                _tripped.TrySetResult();
            }

            // Copy first: an unsubscribe between the null test and the invocation would throw off the
            // raw field.
            StateChanged?.Invoke(open);
        }
        finally
        {
            _mutex.Release();
        }
    }
}
