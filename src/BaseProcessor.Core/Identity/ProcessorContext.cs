using Messaging.Contracts;

namespace BaseProcessor.Core.Identity;

/// <summary>
/// Backing implementation of <see cref="IProcessorContext"/> (D-06). Only <see cref="IsHealthy"/>
/// carries synchronization; the identity/definition properties are plain auto-properties safe to
/// read cross-thread only after Healthy is observed (see the memory-visibility invariant on
/// <see cref="IProcessorContext"/>, WR-03).
///
/// <para>
/// <c>public sealed</c> so <c>services.AddSingleton&lt;IProcessorContext, ProcessorContext&gt;()</c>
/// resolves across the assembly boundary without <c>InternalsVisibleTo</c> — same reason as
/// <c>BaseConsole.Core.Health.StartupGate</c>.
/// </para>
///
/// <para>
/// <see cref="IsHealthy"/> is backed by the StartupGate int-latch idiom
/// (<c>Volatile.Read</c>/<c>Interlocked.Exchange</c> — Interlocked has no bool overload in .NET 8).
/// <see cref="MarkHealthy"/> is idempotent: a second call is a no-op re-assignment of the same value.
/// </para>
/// </summary>
public sealed class ProcessorContext : IProcessorContext
{
    private int _isHealthy; // 0 = false, 1 = true (Interlocked.Exchange has no bool overload in .NET 8)

    /// <inheritdoc/>
    public Guid? Id { get; private set; }

    /// <inheritdoc/>
    public Guid? InputSchemaId { get; private set; }

    /// <inheritdoc/>
    public Guid? OutputSchemaId { get; private set; }

    /// <inheritdoc/>
    public Guid? ConfigSchemaId { get; private set; }

    /// <inheritdoc/>
    public string? Name { get; private set; }

    /// <inheritdoc/>
    public string? Version { get; private set; }

    /// <inheritdoc/>
    public string? InputDefinition { get; private set; }

    /// <inheritdoc/>
    public string? OutputDefinition { get; private set; }

    /// <inheritdoc/>
    public string? ConfigDefinition { get; private set; }

    /// <inheritdoc/>
    public bool IsHealthy => Volatile.Read(ref _isHealthy) == 1;

    /// <inheritdoc/>
    public void SetIdentity(ProcessorIdentityFound identity)
    {
        Id = identity.Id;
        InputSchemaId = identity.InputSchemaId;
        OutputSchemaId = identity.OutputSchemaId;
        ConfigSchemaId = identity.ConfigSchemaId;
        Name = identity.Name;
        Version = identity.Version;
    }

    /// <inheritdoc/>
    public void SetDefinition(Guid schemaId, string definition)
    {
        if (schemaId == InputSchemaId)
            InputDefinition = definition;
        if (schemaId == OutputSchemaId)
            OutputDefinition = definition;
        // D-12/D-14: route the config schema id to ConfigDefinition (Gate A's input). Independent `if`
        // (not else-if) — if two roles share an Id, one fetch populates both slots (idempotent).
        if (schemaId == ConfigSchemaId)
            ConfigDefinition = definition;
    }

    /// <inheritdoc/>
    public void MarkHealthy()
    {
        // Full-barrier CAS publishes the prior identity/definition writes (WR-03). Idempotent: a
        // second call re-assigns the same value.
        Interlocked.Exchange(ref _isHealthy, 1);
    }
}
