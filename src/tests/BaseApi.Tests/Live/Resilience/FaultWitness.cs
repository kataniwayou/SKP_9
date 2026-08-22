namespace BaseApi.Tests.Live.Resilience;

/// <summary>Which dependency a scenario takes away.</summary>
internal enum FaultKind
{
    None,
    Redis,
    Rabbit,
    Both,
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
            [.. arrival, .. heal], injectedAt, searchTo, ct);

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

        var healed = records
            .Where(r => heal.Contains(r.Template, StringComparer.Ordinal))
            .Where(r => r.Timestamp > arrived.Timestamp)
            .OrderBy(r => r.Timestamp)
            .LastOrDefault();

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
        _ => [],
    };

    private static IReadOnlyList<string> HealTemplates(FaultKind kind) => kind switch
    {
        FaultKind.Redis => [Templates.GateOpen],
        FaultKind.Rabbit => [Templates.ConnectionRecovered, Templates.ConsumptionAdmitted],
        FaultKind.Both =>
            [Templates.GateOpen, Templates.ConnectionRecovered, Templates.ConsumptionAdmitted],
        _ => [],
    };
}
