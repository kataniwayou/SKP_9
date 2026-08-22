using BaseProcessor.Core.Identity;
using Messaging.Contracts;
using OpenTelemetry;
using OpenTelemetry.Logs;

namespace BaseProcessor.Core.Observability;

/// <summary>
/// <b>NOT REGISTERED, and it should stay that way — because both values it adds are already there,
/// not because wiring it is hard.</b>
/// <para>
/// <c>ProcessorId</c> is a RESOURCE attribute on every record this process emits, set by
/// <c>ProcessorHost</c> from the resolved identity. That is the correct home for it: the two-stage
/// boot builds the host only after discovery succeeds, so the id is known when the resource is
/// materialised and cannot change afterwards — which is precisely the condition a resource
/// attribute requires. Adding it per record produces a second copy of a value that is already on
/// all of them. Measured against the live stack: 164 of 164 records carried the resource attribute.
/// </para>
/// <para>
/// <c>IdentityName</c> is <c>{Name}_{Version}</c>, which the resource already carries as
/// <c>service.name</c> and <c>service.version</c>. One string instead of two is not worth a
/// per-record attribute.
/// </para>
/// <para>
/// <b>Contrast with <c>OrchestratorRoleLogEnricher</c>, which is registered.</b> That one exists
/// because leadership CHANGES while the process runs, so it cannot live on a frozen resource and a
/// log-record processor is the only place to stamp it. The test for "does this value move" is what
/// decides between the two homes, and <c>ProcessorId</c> does not move.
/// </para>
/// <para>
/// An earlier version of this comment claimed registering it required a new caller-supplied seam in
/// <c>AddBaseConsoleObservability</c>. That was wrong — <c>ConfigureOpenTelemetryLoggerProvider</c>
/// configures that provider from the host in two lines — but the correction does not matter, since
/// the reason not to register it was never difficulty.
/// </para>
/// <para>
/// It also cannot serve the case it was written for. The startup loops that log
/// "no processor registered for source hash …" run in stage 1, BEFORE the telemetry host exists, so
/// those records never reach the exporter at all — console only. Closing that means moving stage 1
/// under the host, which no enricher can do.
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
