using Messaging.Transport;

namespace BaseApi.Core.Health;

/// <summary>
/// Whether the schema is in place, and — while it is not — the current verdict on why.
/// <para>
/// <b>Why this is separate from <see cref="IStartupGate"/>.</b> They answer different questions about
/// the same loop, and conflating them is what used to let the kubelet kill this pod during a Postgres
/// outage. The startup gate says <i>the migration loop is running</i>, which is true on every attempt
/// including the ones that fail, and is what <c>/health/startup</c> reads — so a finite startup budget
/// can never be exhausted by an outage. This says <i>the schema is applied</i>, which is the real
/// precondition for serving, and is what <c>/health/ready</c> reads — the one probe allowed to sit
/// red indefinitely. The orchestrator already splits the same pair this way, between its startup gate
/// and <c>HydrationAdmission</c>.
/// </para>
/// </summary>
public interface IMigrationState
{
    /// <summary>True once the migration set has been applied successfully.</summary>
    bool Applied { get; }

    /// <summary>
    /// The most recent failure's verdict, or null if none has been recorded. Read by the readiness
    /// check so the probe body can say what to do rather than only that something is wrong.
    /// </summary>
    DependencyVerdict? LastFailure { get; }

    /// <summary>Idempotently records that the schema is in place. Thread-safe.</summary>
    void MarkApplied();

    /// <summary>Records the verdict on the most recent failed attempt. Thread-safe.</summary>
    void RecordFailure(DependencyVerdict verdict);
}

/// <summary>
/// Thread-safe backing store for <see cref="IMigrationState"/>. A health check runs on an arbitrary
/// thread, so both fields are written through <see cref="Volatile"/> rather than left to the JIT.
/// </summary>
public sealed class MigrationState : IMigrationState
{
    private int _applied;                    // 0 = false, 1 = true — Interlocked has no bool overload
    private DependencyVerdict? _lastFailure;

    /// <inheritdoc/>
    public bool Applied => Volatile.Read(ref _applied) == 1;

    /// <inheritdoc/>
    public DependencyVerdict? LastFailure => Volatile.Read(ref _lastFailure);

    /// <inheritdoc/>
    public void MarkApplied() => Interlocked.Exchange(ref _applied, 1);

    /// <inheritdoc/>
    public void RecordFailure(DependencyVerdict verdict) =>
        Volatile.Write(ref _lastFailure, verdict ?? throw new ArgumentNullException(nameof(verdict)));
}
