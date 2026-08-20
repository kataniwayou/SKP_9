using BaseProcessor.Core.Identity;
using Messaging.Contracts;
using OpenTelemetry;
using OpenTelemetry.Logs;

namespace BaseProcessor.Core.Observability;

/// <summary>
/// Puts <c>ProcessorId</c> on every record this process emits, including the ones with no message
/// scope around them — the startup loops and the liveness heartbeat, which are exactly the records an
/// operator reads when a processor will not become ready.
/// <para>
/// Null-safe by design: before identity resolves it adds nothing rather than adding
/// <see cref="Guid.Empty"/>, because a zero id would read as a real processor that does not exist.
/// </para>
/// </summary>
public sealed class ProcessorIdLogEnricher(IProcessorContext context) : BaseProcessor<LogRecord>
{
    /// <summary>The resolved identity as one <c>{Name}_{Version}</c> string.</summary>
    public const string IdentityName = "IdentityName";

    public override void OnEnd(LogRecord record)
    {
        if (context.Identity is not { } identity)
        {
            return;
        }

        var attrs = (record.Attributes ?? [])
            .Append(new KeyValuePair<string, object?>(ExecutionLogScope.ProcessorId, identity.Id.ToString("D")))
            .Append(new KeyValuePair<string, object?>(IdentityName, $"{identity.Name}_{identity.Version}"));

        record.Attributes = attrs.ToList();
    }
}
