namespace BaseApi.Tests.Live.Resilience;

/// <summary>Which dependency, or which worker, a scenario takes away.</summary>
internal enum FaultKind
{
    None,
    Redis,
    Rabbit,
    Both,

    /// <summary>The processor deployment scaled to zero. Its arrival edge needs a service filter.</summary>
    Processor,

    /// <summary>The orchestrator statefulset scaled to zero. Both its edges are role-unique.</summary>
    Orchestrator,
}

/// <summary>
/// Reads the fault's arrival and heal out of the logs.
/// <para>
/// <b>Observed, never assumed, and this is the load-bearing habit of the whole suite.</b> A
/// NetworkPolicy on this cluster is accepted and enforced by nothing; a scenario that trusted its
/// own injection would have reported a clean happy path as a passing outage test. If the arrival
/// record is absent, the scenario is inconclusive — which is a failure, because the alternative is a
/// green result that means nothing.
/// </para>
/// <para>
/// <b>The heal timestamp comes from the record, not the schedule.</b> RabbitMQ's pod start and
/// topology re-declare take an unbounded time; a window that assumed the scheduled restore would
/// forgive runs the fault had already released and condemn runs it still held.
/// </para>
/// </summary>
internal static class FaultWitness
{
    public static async Task<FaultWindow> WitnessAsync(
        ElasticLogReader reader,
        FaultKind kind,
        DateTimeOffset injectedAt,
        DateTimeOffset searchTo,
        CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(reader);

        if (kind == FaultKind.None)
        {
            return FaultWindow.None;
        }

        var arrival = ArrivalTemplates(kind);
        var heal = HealTemplates(kind);

        var records = await reader.ReadTemplateRecordsAsync(
            [.. arrival, .. heal], injectedAt, searchTo, ServiceFor(kind), ct);

        var arrived = records
            .Where(r => arrival.Contains(r.Template, StringComparer.Ordinal))
            .OrderBy(r => r.Timestamp)
            .FirstOrDefault();

        if (arrived is null)
        {
            throw new InvalidOperationException(
                $"the {kind} fault was applied at {injectedAt:o} but no process reported it. "
                + $"Expected one of: {string.Join(" | ", arrival)}. "
                + "The scenario is inconclusive: an unobserved fault is indistinguishable from no fault.");
        }

        // First, not last. For Rabbit and Both the heal vocabulary includes ConsumptionAdmitted,
        // which every consumer emits per queue on any resume -- so one late or unrelated resume
        // anywhere in the search window (which runs to stoppedAt + 60s) would drag HealedAt forward
        // if we took the last match. A too-narrow heal window fails loudly: a run judged clear of the
        // window that was still affected breaks the zero-tolerance assertion in OutageVerdict. A too-
        // wide one fails silently, by excusing a run that should have been condemned. This suite's
        // whole discipline is to fail loud rather than pass quietly, so the narrow reading wins.
        var healed = records
            .Where(r => heal.Contains(r.Template, StringComparer.Ordinal))
            .Where(r => r.Timestamp > arrived.Timestamp)
            .OrderBy(r => r.Timestamp)
            .FirstOrDefault();

        if (healed is null)
        {
            throw new InvalidOperationException(
                $"the {kind} fault arrived at {arrived.Timestamp:o} and nothing reported it healing by "
                + $"{searchTo:o}. Expected one of: {string.Join(" | ", heal)}.");
        }

        return new FaultWindow(arrived.Timestamp, healed.Timestamp);
    }

    private static IReadOnlyList<string> ArrivalTemplates(FaultKind kind) => kind switch
    {
        FaultKind.Redis => [Templates.GateClosed, Templates.StoreUnreachable],
        FaultKind.Rabbit => [Templates.ChannelShutDown, Templates.ConsumptionPaused],
        FaultKind.Both =>
            [Templates.GateClosed, Templates.StoreUnreachable,
             Templates.ChannelShutDown, Templates.ConsumptionPaused],
        FaultKind.Processor => [Templates.HostShuttingDown],

        // Templates.HostShuttingDown is deliberately absent here. It is a Microsoft.Hosting.Lifetime
        // template every service in the deployment emits, and ServiceFor returns null for the
        // orchestrator (searched unscoped, see below), so matching it here would be satisfied by any
        // pod's shutdown -- witnessing a fault that never touched the orchestrator at all.
        // SchedulerShuttingDown alone is enough: Quartz runs nowhere else in this deployment.
        FaultKind.Orchestrator => [Templates.SchedulerShuttingDown],
        _ => [],
    };

    private static IReadOnlyList<string> HealTemplates(FaultKind kind) => kind switch
    {
        FaultKind.Redis => [Templates.GateOpen],
        FaultKind.Rabbit => [Templates.ConnectionRecovered, Templates.ConsumptionAdmitted],
        FaultKind.Both =>
            [Templates.GateOpen, Templates.ConnectionRecovered, Templates.ConsumptionAdmitted],
        FaultKind.Processor => [Templates.ProcessorLoopsRetired, Templates.ConsumptionAdmitted],
        FaultKind.Orchestrator => [Templates.OrchestratorHydrated],
        _ => [],
    };

    /// <summary>
    /// The service whose records witness this fault, or null to search every service.
    /// <para>
    /// Only the processor needs one. Its arrival edge is a framework template every service emits,
    /// so an unscoped match would witness whichever process happened to restart. The orchestrator's
    /// own edges are role-unique — Quartz and the hydration record run nowhere else — so it is
    /// searched unscoped, and a filter there would only add a way to be wrong.
    /// </para>
    /// </summary>
    private static string? ServiceFor(FaultKind kind) =>
        kind == FaultKind.Processor ? Chaos.ProcessorService : null;
}
