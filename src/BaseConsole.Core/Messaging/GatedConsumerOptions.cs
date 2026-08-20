namespace BaseConsole.Core.Messaging;

/// <summary>Which queue the gated consumer reads, and how it paces itself.</summary>
public sealed class GatedConsumerOptions
{
    /// <summary>The queue to consume. Must already be declared by a topology unit.</summary>
    public string Queue { get; set; } = "";

    /// <summary>
    /// How many messages the broker may have outstanding with this consumer.
    /// <para>
    /// One, deliberately. These are control messages whose order matters — a stop handled before the
    /// start it follows leaves a projection nobody intended — and a prefetch above one lets the broker
    /// hand over several at once, which is precisely where that reordering becomes possible.
    /// </para>
    /// </summary>
    public ushort PrefetchCount { get; set; } = 1;

    /// <summary>
    /// How often the consumer re-checks that its actual state matches the gate, absent a signal.
    /// <para>
    /// The consumer is signalled on every gate change, so this is a backstop rather than the
    /// mechanism: it bounds how long a missed signal, or a start that failed and needs retrying, can
    /// leave the consumer out of step.
    /// </para>
    /// </summary>
    public TimeSpan ConvergeInterval { get; set; } = TimeSpan.FromSeconds(5);
}
