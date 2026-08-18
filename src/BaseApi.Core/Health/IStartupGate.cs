namespace BaseApi.Core.Health;

/// <summary>
/// One-shot startup gate, exposed via dependency injection as a singleton. A hosted service marks it
/// ready once host initialization completes, which is what lets <c>/health/startup</c> report
/// healthy. Substituting a migration runner for that hosted service is the intended way to delay
/// readiness until migrations have applied.
/// </summary>
public interface IStartupGate
{
    /// <summary>True once <see cref="MarkReady"/> has been called at least once.</summary>
    bool IsReady { get; }

    /// <summary>Idempotently transitions the gate to the ready state. Thread-safe.</summary>
    void MarkReady();
}

/// <summary>
/// Thread-safe one-shot latch backing <see cref="IStartupGate"/>. Reads use <c>Volatile.Read</c> for
/// cross-thread visibility and writes use <c>Interlocked.Exchange</c> for atomicity; calling
/// <see cref="MarkReady"/> more than once is a no-op.
///
/// <para>
/// Public rather than internal because the composition root in the service assembly resolves this
/// concrete type across the assembly boundary, which internal would require an
/// <c>InternalsVisibleTo</c> to allow.
/// </para>
/// </summary>
public sealed class StartupGate : IStartupGate
{
    private int _isReady; // 0 = false, 1 = true — Interlocked.Exchange has no bool overload

    /// <inheritdoc/>
    public bool IsReady => Volatile.Read(ref _isReady) == 1;

    /// <inheritdoc/>
    public void MarkReady() => Interlocked.Exchange(ref _isReady, 1);
}
