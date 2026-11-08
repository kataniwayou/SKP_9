namespace Processor.Napole;

/// <summary>
/// One tick's window: the executions the kafka-importer imported at or after <see cref="From"/> and
/// before <see cref="To"/>, both UTC.
/// <para>
/// <b>Snapped to a grid, not measured from the tick.</b> The dispatch carries no fire time, so the
/// only clock is the processor's, and queue delay, a restart or a redelivery moves it. Flooring
/// <c>now − lag</c> to a multiple of the window on the epoch grid makes a late tick report the same
/// slot an on-time one would, so back-to-back ticks neither gap nor overlap. Two ticks in one slot
/// report it twice, which is the accepted duplicate; a skipped slot stays unreported (spec §2, §4.1).
/// </para>
/// </summary>
public readonly record struct ReportWindow(DateTimeOffset From, DateTimeOffset To)
{
    public static ReportWindow For(DateTimeOffset now, int windowMinutes, TimeSpan lag)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(windowMinutes, 1);

        var width = windowMinutes * 60_000L;
        var end = (now - lag).ToUnixTimeMilliseconds();
        var to = end - (((end % width) + width) % width);

        return new ReportWindow(
            DateTimeOffset.FromUnixTimeMilliseconds(to - width),
            DateTimeOffset.FromUnixTimeMilliseconds(to));
    }

    /// <summary>
    /// Where a selected execution's records are looked for: the trail runs past <see cref="To"/> so a
    /// run imported late in the window is seen to its end, and before <see cref="From"/> so a second
    /// import of the same id just across the boundary is seen and the run left out (spec §4.2).
    /// </summary>
    public (DateTimeOffset From, DateTimeOffset To) TrailSpan(TimeSpan trail) => (From - trail, To + trail);
}
