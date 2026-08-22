using OpenTelemetry;
using OpenTelemetry.Logs;
using Orchestrator.Election;

namespace Orchestrator.Observability;

/// <summary>
/// Puts <c>role</c> — <c>leader</c> or <c>follower</c> — on every log record this replica emits.
/// <para>
/// <b>Why a record attribute and not a resource attribute.</b> A resource is materialised once when
/// its provider is built and is immutable thereafter, which is exactly why
/// <c>AddBaseConsoleObservability</c> takes an identity as a parameter rather than reading one
/// later. Leadership changes while the process runs, so it cannot live there. A
/// <see cref="LogRecord"/> processor is the only place a value that moves can be stamped on every
/// line.
/// </para>
/// <para>
/// <b>The value is read live, on every record.</b> Nothing is cached at construction, so a failover
/// flip surfaces on the very next line rather than at the next restart — which is the whole point:
/// the question this answers is "was this replica leading when it logged that", and an answer that
/// lags is worse than none.
/// </para>
/// <para>
/// <b>No null-guard, unlike <c>ProcessorIdLogEnricher</c>.</b> <see cref="LeaderState.Role"/> is
/// never empty — a replica is a follower until it wins — so the tag is on every record and
/// <c>role=follower</c> means a follower rather than a value that had not resolved yet.
/// </para>
/// <para>
/// <b>A follower is expected to be logging normally.</b> Leadership fences cron fires only;
/// <c>StepOutcomeHandler</c> is deliberately not gated on it. A query that treats
/// <c>role=follower</c> as a fault would match every healthy replica but one.
/// </para>
/// </summary>
public sealed class OrchestratorRoleLogEnricher(LeaderState state) : BaseProcessor<LogRecord>
{
    /// <summary>The attribute key, lower-case, matching the convention metrics attributes use.</summary>
    public const string Role = "role";

    public override void OnEnd(LogRecord record) =>
        record.Attributes = (record.Attributes ?? [])
            .Append(new KeyValuePair<string, object?>(Role, state.Role))
            .ToList();
}
