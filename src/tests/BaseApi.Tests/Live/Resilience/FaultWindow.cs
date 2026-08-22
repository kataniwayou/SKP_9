namespace BaseApi.Tests.Live.Resilience;

/// <summary>
/// When the fault was injected and when it was observed to heal.
/// <para>
/// <b><see cref="HealedAt"/> is observed, never scheduled.</b> It is the timestamp of the heal
/// record the pipeline actually wrote. RabbitMQ's pod start and topology re-declare take an
/// unbounded time, and a window that assumed "fault plus sixty seconds" would forgive runs the
/// fault had already released, or condemn runs it still held.
/// </para>
/// </summary>
internal sealed record FaultWindow(DateTimeOffset FaultAt, DateTimeOffset HealedAt)
{
    /// <summary>The happy path's window: empty, so nothing straddles and every short run is loss.</summary>
    public static readonly FaultWindow None =
        new(DateTimeOffset.MaxValue, DateTimeOffset.MaxValue);

    public bool IsNone => FaultAt == DateTimeOffset.MaxValue;

    /// <summary>True when a run's span touches the outage at any point.</summary>
    public bool Overlaps(DateTimeOffset startedAt, DateTimeOffset endedAt) =>
        !IsNone && startedAt <= HealedAt && endedAt >= FaultAt;
}
