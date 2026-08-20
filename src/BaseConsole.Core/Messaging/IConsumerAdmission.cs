namespace BaseConsole.Core.Messaging;

/// <summary>
/// Whether this host is ready for its consumer to begin consuming at all. One-shot in practice: a host
/// opens it once its own startup work is done and never closes it again.
/// <para>
/// <b>Distinct from the two gates already here, deliberately.</b> <c>L2Gate</c> is dynamic — it closes
/// and reopens as the projection store comes and goes. <c>IStartupGate</c> reports health. This is
/// admission to consume, and conflating it with either would change an existing service's behaviour:
/// the processor already marks the startup gate ready from its liveness heartbeat, so gating
/// consumption on that would move its timing the moment this shipped.
/// </para>
/// </summary>
public interface IConsumerAdmission
{
    /// <summary>True once this host is ready to consume.</summary>
    bool IsOpen { get; }
}

/// <summary>
/// The default: a host that has no startup work to finish before consuming. Registered by
/// <c>AddBaseConsoleGating</c> with <c>TryAddSingleton</c>, so a host that does have such work
/// registers its own implementation first and this one never takes effect.
/// </summary>
public sealed class AlwaysOpenAdmission : IConsumerAdmission
{
    /// <inheritdoc/>
    public bool IsOpen => true;
}
