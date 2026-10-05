using Messaging.Contracts.Projections;
using StackExchange.Redis;

namespace BaseApi.Service.Features.Orchestration.Validation;

/// <summary>
/// Per-replica processor-liveness gate. Delegates classification to <see cref="ProcessorLivenessProbe"/>.
/// <para>
/// <b>ValidateAsync</b> throws for the first participating processor with no healthy, fresh replica,
/// short-circuiting the scan. <b>CollectAsync</b> reports every such processor, classifying all replicas.
/// </para>
/// </summary>
internal sealed class ProcessorLivenessValidator
{
    private readonly ProcessorLivenessProbe _probe;

    public ProcessorLivenessValidator(IConnectionMultiplexer multiplexer, TimeProvider clock)
        => _probe = new ProcessorLivenessProbe(multiplexer, clock);

    /// <summary>Throws for the first participating processor with no healthy, fresh replica.</summary>
    public async Task ValidateAsync(WorkflowGraphSnapshot snapshot, CancellationToken ct)
    {
        foreach (var proc in snapshot.Processors.Values)
        {
            var liveness = await _probe.ProbeAsync(proc.Id, ct);
            if (!liveness.Live)
            {
                throw OrchestrationValidationException.ProcessorNotLive(proc.Id, liveness.Reason);
            }
        }
    }

    /// <summary>Every participating processor with no healthy, fresh replica, in snapshot order.</summary>
    public async Task<IReadOnlyList<OrchestrationValidationException>> CollectAsync(WorkflowGraphSnapshot snapshot, CancellationToken ct)
    {
        var problems = new List<OrchestrationValidationException>();
        foreach (var proc in snapshot.Processors.Values)
        {
            var liveness = await _probe.ProbeAsync(proc.Id, ct);
            if (!liveness.Live)
            {
                problems.Add(OrchestrationValidationException.ProcessorNotLive(proc.Id, liveness.Reason));
            }
        }
        return problems;
    }
}
