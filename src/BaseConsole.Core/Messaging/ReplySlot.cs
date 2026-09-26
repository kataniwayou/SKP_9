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

    /// <summary>
    /// The correlation id of the ask currently outstanding, or null when nothing is expected.
    /// <para>
    /// <b>Without this the slot was content-addressed by nothing at all.</b> One slot is shared by
    /// every asker in the process, and a reply was published into it on message TYPE alone — so a
    /// late answer to an ask that had already timed out was handed to the NEXT caller as though it
    /// were its own. Observed on the live stack: a processor's config-schema request received the
    /// definition fetched for its output schema one request earlier, and the conformance check —
    /// which compares against a C# type and is the only check with an independent reference — was
    /// the sole reason anyone found out. The output definition stored moments before was crossed the
    /// same way and nothing noticed, because <c>SetDefinition</c> trusts the pairing.
    /// </para>
    /// </summary>
    private string? _expected;

    /// <summary>
    /// Arm the slot for exactly one ask, discarding anything already pending.
    /// <para>
    /// <b>Called before the request is sent, never after.</b> A reply can come back faster than the
    /// send call returns, and arming afterwards would drop the very answer being waited for.
    /// </para>
    /// <para>
    /// It subsumes the <see cref="Take"/> every asker used to call to drain the slot first: that
    /// drain cleared the value but left the slot willing to accept ANY reply, which is the hole this
    /// closes.
    /// </para>
    /// </summary>
    public void Expect(string correlationId)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(correlationId);

        lock (_gate)
        {
            _expected = correlationId;
            _pending = null;

            // Value and signal drained together, the invariant this class exists to hold.
            while (_signal.CurrentCount > 0)
            {
                _signal.Wait(0);
            }
        }
    }

    /// <summary>
    /// Store a reply and wake its waiter. Safe to call from a consumer thread.
    /// <para>
    /// Returns <c>false</c> when <paramref name="correlationId"/> does not match the outstanding ask
    /// — a late answer to something already given up on, or a reply to another asker sharing this
    /// slot. Dropping it is the point: handing it over would answer the wrong question with a
    /// straight face, and no caller can tell, because a reply body carries nothing identifying what
    /// it answers.
    /// </para>
    /// <para>
    /// <b>A null or absent id never matches.</b> Every reply in this system carries one —
    /// <c>RpcQueueConsumer</c> echoes the request's verbatim and never re-mints it — so an id-less
    /// reply is a reply this process cannot attribute, and an unattributable answer is exactly what
    /// must not be trusted.
    /// </para>
    /// </summary>
    public bool Publish(T reply, string? correlationId)
    {
        ArgumentNullException.ThrowIfNull(reply);

        lock (_gate)
        {
            if (_expected is null || !string.Equals(_expected, correlationId, StringComparison.Ordinal))
            {
                return false;
            }

            _pending = reply;

            // Capped at one. The slot holds one answer, so a second count could only ever release a
            // wait that has no value to collect.
            if (_signal.CurrentCount == 0)
            {
                _signal.Release();
            }

            return true;
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

            // The ask is over once its answer is collected, so a duplicate arriving afterwards
            // matches nothing. Without this, a redelivered reply could refill the slot and be
            // collected by whichever ask came next.
            _expected = null;

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
