using System.Diagnostics.Metrics;

namespace BaseConsole.Core.Observability;

/// <summary>
/// When this process started, as unix seconds, so restarts are countable.
/// <para>
/// <b>Why a timestamp rather than a counter incremented once per boot.</b> That counter would sit
/// at 1 for the life of the process and read as a restart only through <c>resets()</c>, which is
/// fragile. A timestamp moves exactly once per process, so <c>changes(...[window])</c> is the whole
/// query.
/// </para>
/// <para>
/// <b>It works because <c>InstanceId.Resolve()</c> returns <c>POD_NAME</c> first</b>, which is
/// stable across container restarts within a pod -- so a restart moves the value on an EXISTING
/// series rather than spawning a new one. If that ever fell through to the GUID branch, every
/// restart would become a fresh series and this idiom would break with nothing to say so. This
/// paragraph is the only place that dependency is written down.
/// </para>
/// <para>
/// <b>It reports nothing before <see cref="Stamp"/> is called</b>, and that is not the
/// pessimistic-initial-state rule being broken. A start time has no pessimistic value to report,
/// and the stamp happens during host construction -- before the first export interval elapses, so
/// the empty window is never observable from outside.
/// </para>
/// </summary>
public static class ProcessStartMetrics
{
    /// <summary>
    /// Must match the string passed to <c>AddMeter</c> in <c>AddBaseConsoleObservability</c>. A
    /// typo'd meter name produces no error and no metrics.
    /// </summary>
    public const string MeterName = "BaseConsole.Core.Process";

    public const string StartTimestampInstrument = "pipeline.process.start.timestamp";

    private static readonly Meter Meter = new(MeterName);

    private static long _startedUnixSeconds;

    static ProcessStartMetrics()
    {
        // Registered once, in the static constructor. The returned instrument is deliberately not
        // stored: the Meter owns it and the callback keeps it alive.
        Meter.CreateObservableGauge(
            StartTimestampInstrument,
            Observe,
            unit: "s",
            description: "Unix seconds at which this process started. changes() counts restarts.");
    }

    /// <summary>
    /// Records the start time. Idempotent: the first call wins and every later one is a no-op, so
    /// a value that moved twice can never inflate a restart count.
    /// </summary>
    public static void Stamp(TimeProvider clock)
    {
        ArgumentNullException.ThrowIfNull(clock);

        // CompareExchange against 0 rather than a bool flag plus a write: the check and the store
        // must be one operation, or two racing hosts in a test process can both pass the check.
        Interlocked.CompareExchange(ref _startedUnixSeconds, clock.GetUtcNow().ToUnixTimeSeconds(), 0);
    }

    private static IEnumerable<Measurement<long>> Observe()
    {
        var stamped = Interlocked.Read(ref _startedUnixSeconds);
        return stamped == 0 ? [] : [new Measurement<long>(stamped)];
    }
}
