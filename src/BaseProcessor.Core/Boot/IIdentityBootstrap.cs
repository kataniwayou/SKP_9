using Messaging.Contracts;

namespace BaseProcessor.Core.Boot;

/// <summary>
/// Stage 1 of the boot: resolve who this process is, before anything that needs the answer exists.
/// <para>
/// An interface rather than a virtual method, because the substitution a test needs is total — it
/// replaces the broker, the reply queue and the loop at once — and because the boot sequence should
/// be exercisable without a broker at all.
/// </para>
/// </summary>
public interface IIdentityBootstrap
{
    /// <summary>
    /// Resolves the identity, retrying without limit until it does.
    /// <para>
    /// It never returns without an answer. A processor image may be deployed before its row is
    /// registered, so "not found" is an ordinary early answer rather than a failure, and the only
    /// thing that ends the wait is cancellation — which throws.
    /// </para>
    /// </summary>
    /// <exception cref="OperationCanceledException">Shutdown was requested while still resolving.</exception>
    Task<ProcessorIdentityFound> ResolveAsync(CancellationToken ct);
}
