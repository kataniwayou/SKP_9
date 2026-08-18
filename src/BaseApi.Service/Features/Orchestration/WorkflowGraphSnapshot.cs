using BaseApi.Service.Features.Assignment;
using BaseApi.Service.Features.Processor;
using BaseApi.Service.Features.Schema;
using BaseApi.Service.Features.Step;
using BaseApi.Service.Features.Workflow;
using Microsoft.Extensions.Logging;

namespace BaseApi.Service.Features.Orchestration;

/// <summary>
/// Transient in-memory read model of a workflow graph: five flat dictionaries projecting the
/// requested workflows' entities, built inside the orchestration service and discarded at the end of
/// the request through a <c>using</c> declaration.
/// <para>
/// <b>Disposal contract:</b> <see cref="Dispose"/> is idempotent — it clears all five dictionaries,
/// flips <see cref="IsDisposed"/>, and logs at the moment of disposal. The snapshot owns the injected
/// logger, passed by the loader, so that line lives exactly where disposal happens.
/// </para>
/// <para>
/// The logger is a positional member but not a data member: it is a dependency, and it does not
/// participate in value equality over the five dictionaries. The dictionary references are
/// init-only, so <see cref="Dispose"/> mutates their contents rather than nulling the references,
/// which the compiler would reject. <see cref="IsDisposed"/> is a separate mutable property, not a
/// positional member.
/// </para>
/// <para>
/// <b>The validation gates walk different node sets, and that asymmetry is intentional.</b> The
/// cycle and missing-step gate is seeded only from each workflow's entry steps, so it validates the
/// entry-reachable subgraph: a step unreachable from any entry can never execute and so cannot
/// contribute a runtime cycle. The schema-edge and payload gates instead iterate every step and every
/// assignment, being cheap per-item static checks that do not depend on reachability. The net effect
/// is that an unreachable orphan subgraph containing a cycle is not flagged by the cycle gate, though
/// it is still edge-walked by the others. Restricting foreign keys on the junctions make a genuinely
/// dangling edge hard to produce through the API, and an orphan cycle is unreachable at runtime, so
/// the divergence is accepted. To close it, sweep the step keys not yet completed after the
/// entry-seeded pass in the cycle gate.
/// </para>
/// </summary>
internal sealed record WorkflowGraphSnapshot(ILogger<WorkflowGraphSnapshot> Logger) : IDisposable
{
    public Dictionary<Guid, WorkflowReadDto>   Workflows   { get; init; } = new();
    public Dictionary<Guid, AssignmentReadDto> Assignments { get; init; } = new();
    public Dictionary<Guid, StepReadDto>       Steps       { get; init; } = new();
    public Dictionary<Guid, ProcessorReadDto>  Processors  { get; init; } = new();
    public Dictionary<Guid, SchemaReadDto>     Schemas     { get; init; } = new();

    public bool IsDisposed { get; private set; }

    public void Dispose()
    {
        if (IsDisposed) return;
        Workflows.Clear();
        Assignments.Clear();
        Steps.Clear();
        Processors.Clear();
        Schemas.Clear();
        IsDisposed = true;
        Logger.LogDebug("L1 snapshot disposed");
    }
}
