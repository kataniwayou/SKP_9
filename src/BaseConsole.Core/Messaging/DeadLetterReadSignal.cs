namespace BaseConsole.Core.Messaging;

/// <summary>
/// A request to read the dead-letter depth now, raised where a message is actually refused.
/// <para>
/// <b>Why the read is event-driven and the loop is only a backstop.</b> A dead-letter depth changes
/// on exactly two occasions: something is parked, or an operator drains the queue by hand. Polling
/// it spends nearly every pass re-reading a number that cannot have moved. Raising it here makes
/// the number timely at the one moment it can change from inside the process; the slow loop exists
/// only so a manual drain is eventually noticed, because without it a drained queue would report a
/// stale non-zero forever -- the exact failure this gauge exists to prevent.
/// </para>
/// <para>
/// <b>The task is replaced on reset rather than cleared</b>, mirroring <c>L2Gate.Tripped</c>: a
/// waiter holding the completed task must not be re-armed out from under itself.
/// </para>
/// <para>
/// A static, like <see cref="Messaging.Transport.DispatchedQueues"/>, because the raiser and the
/// reader are in different assemblies and threading a seam between them would buy nothing -- there
/// is one dead-letter probe per process.
/// </para>
/// </summary>
public static class DeadLetterReadSignal
{
    private static volatile TaskCompletionSource _signal = Fresh();

    /// <summary>Completes when a read has been requested. Await it alongside an interval.</summary>
    public static Task Requested => _signal.Task;

    /// <summary>
    /// Ask for a read. Idempotent until <see cref="Reset"/>: a burst of parks is one request, not
    /// one broker round trip each, and a single read sees whatever the queue holds by the time it
    /// runs.
    /// </summary>
    public static void Request() => _signal.TrySetResult();

    /// <summary>Re-arm, after a read has been taken.</summary>
    public static void Reset() => _signal = Fresh();

    private static TaskCompletionSource Fresh() =>
        new(TaskCreationOptions.RunContinuationsAsynchronously);
}
