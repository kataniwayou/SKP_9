using BaseProcessor.Core.Identity;
using Messaging.Contracts;
using OpenTelemetry;
using OpenTelemetry.Logs;

namespace BaseProcessor.Core.Observability;

/// <summary>
/// <b>NOT REGISTERED ANYWHERE TODAY — this type is built and unwired, deliberately.</b> Its only
/// reference in the repository is this declaration, and it is the only consumer of the direct
/// <c>OpenTelemetry</c> package reference in <c>BaseProcessor.Core.csproj</c>. Nothing here runs, so
/// records emitted outside a message scope carry no <c>ProcessorId</c>; inside one,
/// <see cref="ExecutionLogScope"/> supplies it and this would add nothing. See the known gaps in
/// <c>docs/superpowers/plans/2026-08-20-processor-execution-path.md</c>.
/// <para>
/// <b>What registering it would take.</b> A <see cref="LogRecord"/> processor is added through
/// <c>OpenTelemetryLoggerOptions.AddProcessor</c>, inside the <c>builder.Logging.AddOpenTelemetry</c>
/// callback that <c>AddBaseConsoleObservability</c> owns — and that method exposes no hook into that
/// callback. It cannot simply take one either: it lives in <c>BaseConsole.Core</c>, which must not
/// reference <c>BaseProcessor.Core</c>, and the enricher needs an <see cref="IProcessorContext"/>.
/// Closing this means adding a caller-supplied log-processor seam to that extension, not a line of
/// wiring. Do not "fix" it by registering it somewhere convenient.
/// </para>
/// <para>
/// What it would do once wired: put <c>ProcessorId</c> on every record this process emits, including
/// the ones with no message scope around them — the startup loops and the liveness heartbeat, which
/// are exactly the records an operator reads when a processor will not become ready.
/// </para>
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
