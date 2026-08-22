using BaseProcessor.Core.Identity;
using Messaging.Contracts;
using OpenTelemetry;
using OpenTelemetry.Logs;

namespace BaseProcessor.Core.Observability;

/// <summary>
/// Puts <c>ProcessorId</c> and <c>IdentityName</c> on every record this process emits, including the
/// ones with no message scope around them — the startup loops and the liveness heartbeat, which are
/// exactly the records an operator reads when a processor will not become ready.
/// <para>
/// <b>Wired from the host, not from the shared observability extension.</b> An earlier version of
/// this comment said registering it required adding a caller-supplied log-processor seam to
/// <c>AddBaseConsoleObservability</c>, because a <see cref="LogRecord"/> processor is added through
/// <c>OpenTelemetryLoggerOptions.AddProcessor</c> inside the callback that method owns. That was
/// wrong. <c>ConfigureOpenTelemetryLoggerProvider</c> is a services-side registration that
/// configures the same provider after the fact, so the host adds this in two lines and the shared
/// extension is untouched. The objection that <c>BaseConsole.Core</c> must not reference
/// <c>BaseProcessor.Core</c> does not bite either: the call is made from the processor host, which
/// already references both.
/// </para>
/// <para>
/// <b>Null-safe by design: before identity resolves it adds nothing</b> rather than adding
/// <see cref="Guid.Empty"/>, because a zero id would read as a real processor that does not exist.
/// This is the difference from <c>OrchestratorRoleLogEnricher</c>, whose value is never absent and
/// which therefore carries no guard.
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
