using BaseConsole.Core.Messaging;

namespace Orchestrator.Hydration;

/// <summary>
/// Admission to consume, held shut until this replica has hydrated L1 from L2.
/// <para>
/// <b>What it buys is that the queue does the waiting.</b> This replica's fan-out queue is durable and
/// bound before anything consumes it, so announcements published during hydration accumulate there
/// rather than being missed. Consuming them earlier would not make them arrive sooner — it would mean
/// acting on a start announcement against an L1 that does not yet hold the workflows the pass is about
/// to mirror, and the pass would then overwrite whatever the announcement did.
/// </para>
/// <para>
/// <b>One-shot, in the shape of <c>StartupGate</c>.</b> Reads use <c>Volatile.Read</c> for cross-thread
/// visibility and <see cref="Open"/> uses <c>Interlocked.Exchange</c> for atomicity; opening twice is a
/// no-op. There is deliberately no way to close it: hydration happens once per process, and a latch
/// that could swing back would invite a later outage to be modelled as un-hydrating, which is what
/// <c>L2Gate</c> — dynamic, and already registered here — is for.
/// </para>
/// <para>
/// <b>It must be registered ahead of <c>AddBaseConsoleGating</c>.</b> That call resolves
/// <see cref="IConsumerAdmission"/> with <c>TryAddSingleton</c>, so a registration made after it loses
/// to <see cref="AlwaysOpenAdmission"/> silently: nothing fails, nothing is logged, and the replica
/// simply consumes before it has hydrated.
/// </para>
/// </summary>
public sealed class HydrationAdmission : IConsumerAdmission
{
    private int _isOpen; // 0 = false, 1 = true — Interlocked.Exchange has no bool overload

    /// <inheritdoc/>
    public bool IsOpen => Volatile.Read(ref _isOpen) == 1;

    /// <summary>
    /// Admit the consumer, for good. Called once, by the hydration loop, after every workflow L2 listed
    /// has reached L1.
    /// </summary>
    public void Open() => Interlocked.Exchange(ref _isOpen, 1);
}
