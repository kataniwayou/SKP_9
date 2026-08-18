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
    private T? _pending;

    /// <summary>Store a reply and wake any waiter. Safe to call from a consumer thread.</summary>
    public void Publish(T reply)
    {
        ArgumentNullException.ThrowIfNull(reply);
        Interlocked.Exchange(ref _pending, reply);
        if (_signal.CurrentCount == 0)
        {
            _signal.Release();
        }
    }

    /// <summary>Take the pending reply, leaving the slot empty. Null when nothing has arrived.</summary>
    public T? Take() => Interlocked.Exchange(ref _pending, null);

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
