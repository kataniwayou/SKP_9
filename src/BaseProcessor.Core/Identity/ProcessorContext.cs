using Messaging.Contracts;

namespace BaseProcessor.Core.Identity;

/// <summary>
/// Backing implementation of <see cref="IProcessorContext"/> (D-06). Two synchronized fields and
/// nothing else: the immutable identity snapshot and the Healthy latch.
///
/// <para>
/// <c>public sealed</c> so <c>services.AddSingleton&lt;IProcessorContext, ProcessorContext&gt;()</c>
/// resolves across the assembly boundary without <c>InternalsVisibleTo</c> — same reason as
/// <c>BaseConsole.Core.Health.StartupGate</c>.
/// </para>
///
/// <para>
/// <b>Safe publication.</b> Each snapshot is fully constructed before its reference is stored, and
/// the store is a <see cref="Volatile.Write{T}"/> paired with a <see cref="Volatile.Read{T}"/> on the
/// read side. The release/acquire pair is what guarantees a thread observing the reference also
/// observes every field behind it — .NET makes no Java-style final-field promise, so the barrier is
/// explicit rather than inferred from the record's immutability.
/// </para>
/// <para>
/// The writers (<see cref="SetIdentity"/>, <see cref="SetDefinition"/>) are called only from the
/// startup orchestrator's own thread, in order, so read-modify-write on the snapshot needs no
/// interlocked compare-exchange. <see cref="IsHealthy"/> keeps the int-latch idiom because
/// <see cref="Interlocked"/> has no bool overload in .NET 8.
/// </para>
/// </summary>
public sealed class ProcessorContext : IProcessorContext
{
    private ProcessorIdentity? _identity;
    private int _isHealthy; // 0 = false, 1 = true (Interlocked.Exchange has no bool overload in .NET 8)

    /// <inheritdoc/>
    public ProcessorIdentity? Identity => Volatile.Read(ref _identity);

    /// <inheritdoc/>
    public bool IsHealthy => Volatile.Read(ref _isHealthy) == 1;

    /// <inheritdoc/>
    public void SetIdentity(ProcessorIdentityFound identity)
    {
        ArgumentNullException.ThrowIfNull(identity);

        Volatile.Write(ref _identity, new ProcessorIdentity(
            identity.Id,
            identity.InputSchemaId,
            identity.OutputSchemaId,
            identity.ConfigSchemaId,
            identity.Name,
            identity.Version,
            InputDefinition: null,
            OutputDefinition: null,
            ConfigDefinition: null));
    }

    /// <inheritdoc/>
    public void SetDefinition(Guid schemaId, string definition)
    {
        ArgumentNullException.ThrowIfNull(definition);

        var current = Volatile.Read(ref _identity)
            ?? throw new InvalidOperationException(
                "SetDefinition was called before SetIdentity — Loop B runs only after Loop A resolves.");

        // Independent tests, not else-if: if two roles share one schema id, a single fetch fills both
        // slots (idempotent). Copy-on-write, so a reader holding the previous snapshot is unaffected.
        var updated = current;
        if (schemaId == current.InputSchemaId)
        {
            updated = updated with { InputDefinition = definition };
        }

        if (schemaId == current.OutputSchemaId)
        {
            updated = updated with { OutputDefinition = definition };
        }

        if (schemaId == current.ConfigSchemaId)
        {
            updated = updated with { ConfigDefinition = definition };
        }

        Volatile.Write(ref _identity, updated);
    }

    /// <inheritdoc/>
    public void MarkHealthy() => Interlocked.Exchange(ref _isHealthy, 1);
}
