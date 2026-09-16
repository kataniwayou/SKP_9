namespace BaseConsole.Core.Messaging;

/// <summary>
/// The handoff between the reply consumer's thread and the loop that owns all state.
/// <para>
/// <b>Latest wins.</b> Replies to a periodic ask are idempotent, so a newer answer is never worse
/// than the one it replaces and dropping the older one costs nothing.
/// </para>
/// <para>
/// <b>Waiting is a signal, not a queue.</b> <see cref="WaitAsync"/> returns as soon as something is
/// published or the timeout elapses, whichever comes first — without it, deferring application to
/// the loop's next tick would add a full interval per discovery stage to every boot.
/// </para>
/// </summary>
public sealed class ReplySlot<T> where T : class
{
    private readonly SemaphoreSlim _signal = new(0);

    /// <summary>
    /// Guards the value and the signal as ONE unit. They are two objects describing one fact — "an
    /// answer is here" — and every bug this class has had came from letting them disagree.
    /// <para>
    /// <b>No waiter ever takes this lock</b>: <see cref="WaitAsync"/> blocks on the semaphore alone,
    /// and nothing inside the lock blocks, so a publisher can never be held up behind a waiter.
    /// </para>
    /// </summary>
    private readonly object _gate = new();

    private T? _pending;

    /// <summary>Store a reply and wake any waiter. Safe to call from a consumer thread.</summary>
    public void Publish(T reply)
    {
        ArgumentNullException.ThrowIfNull(reply);

        lock (_gate)
        {
            _pending = reply;

            // Capped at one. The slot holds one answer, so a second count could only ever release a
            // wait that has no value to collect.
            if (_signal.CurrentCount == 0)
            {
                _signal.Release();
            }
        }
    }

    /// <summary>
    /// Take the pending reply, leaving the slot empty. Null when nothing has arrived.
    /// <para>
    /// <b>The signal is drained with the value, and that is the whole point of this method.</b> A
    /// reply that lands while nobody is waiting — the late answer to an ask that already timed out —
    /// sets both. Draining only the value used to leave a signal behind that belonged to an answer
    /// already discarded, so the NEXT wait returned on it instantly, found nothing, and reported that
    /// nothing had answered. The real answer then arrived and re-armed the signal, and the caller
    /// stayed exactly one step out of phase forever: every reply consumed by the wait that had
    /// already given up on it. A processor wedged this way never recovers and only a restart clears
    /// it — see <c>BrokerIdentityBootstrap.AskAsync</c>, which drains before every send for this
    /// reason, and <c>ReplySlotTests.ADrainedReplyDoesNotLeaveASignalBehind</c>.
    /// </para>
    /// <para>
    /// <b>A late reply is returned rather than dropped.</b> Called after a wait has timed out, this
    /// still hands back an answer that arrived in the meantime, which turns the old landmine into a
    /// successful ask.
    /// </para>
    /// </summary>
    public T? Take()
    {
        lock (_gate)
        {
            var reply = _pending;
            _pending = null;

            // Wait(0) never blocks, so this cannot deadlock against a publisher holding the gate.
            while (_signal.CurrentCount > 0)
            {
                _signal.Wait(0);
            }

            return reply;
        }
    }

    /// <summary>Wait for a publish or the timeout, whichever comes first.</summary>
    public async Task WaitAsync(TimeSpan timeout, CancellationToken ct)
    {
        try
        {
            await _signal.WaitAsync(timeout, ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // Shutdown. The caller's loop condition handles it.
        }
    }
}
