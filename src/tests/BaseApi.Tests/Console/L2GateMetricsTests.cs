using BaseApi.Tests.Support;
using BaseConsole.Core.Gating;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace BaseApi.Tests.Console;

public sealed class L2GateMetricsTests
{
    /// <summary>
    /// How many owners currently report an open gate.
    /// <para>
    /// <b>A fresh collector per call, so each reading is exactly one poll.</b>
    /// <see cref="MetricCollector.For"/> replays every measurement its listener has ever seen, so a
    /// reused collector folds earlier polls into the count and the delta stops meaning anything.
    /// </para>
    /// </summary>
    private static int OpenCount()
    {
        using var metrics = new MetricCollector(L2GateMetrics.MeterName);
        metrics.Collect();
        return metrics.For("pipeline.gate.open").Count(m => m.Value == 1);
    }

    [Fact]
    public async Task TheGaugeFollowsTheGate()
    {
        // L2Gate is constructed closed by design -- notification fires on transitions only, so a
        // gate that started open would never produce an opening edge.
        var gate = new L2Gate(NullLogger<L2Gate>.Instance);
        using var owner = new L2GateMetrics(gate);

        // ASSERT THE DELTA, NOT THE SET. The registry is process-wide and the gauge is deliberately
        // untagged -- there is one L2Gate per process, so a disambiguating tag would be a
        // permanently-constant dimension on a production series. That means no assertion over the
        // raw measurement set can isolate this owner: another live owner may report 0 (the
        // never-disposed wiring-test host) or 1 (under SKP_REALSTACK, a live processor whose
        // projection store is reachable). This gate is the only thing that changes between the
        // readings, so the change is attributable to it and to nothing else.
        var before = OpenCount();

        await gate.ReportHealthyAsync();
        Assert.Equal(before + 1, OpenCount());

        // The falling direction too. A gauge that only ever went up would report a store outage as
        // healthy for as long as the process lived.
        await gate.TripAsync();
        Assert.Equal(before, OpenCount());
    }

    [Fact]
    public async Task OnlyTheFallingEdgeIsCountedAsATrip()
    {
        var gate = new L2Gate(NullLogger<L2Gate>.Instance);
        using var owner = new L2GateMetrics(gate);
        using var metrics = new MetricCollector(L2GateMetrics.MeterName);

        // Open, then closed, then open again: one trip, not two edges and not three.
        await gate.ReportHealthyAsync();
        await gate.TripAsync();
        await gate.ReportHealthyAsync();

        Assert.Equal(1, metrics.For("pipeline.gate.trips").Sum(m => m.Value));
    }

    [Fact]
    public async Task DisposingUnsubscribesSoAStoppedOwnerCountsNothing()
    {
        var gate = new L2Gate(NullLogger<L2Gate>.Instance);
        var owner = new L2GateMetrics(gate);
        await gate.ReportHealthyAsync();

        var whileLive = OpenCount();

        owner.Dispose();

        using var metrics = new MetricCollector(L2GateMetrics.MeterName);
        await gate.TripAsync();

        Assert.Empty(metrics.For("pipeline.gate.trips"));

        // Dispose removes this owner from the registry that backs the gauge, so its open gate stops
        // being reported at all rather than being left behind as a stale 1 -- exactly one fewer
        // measurement reading 1 than while it was live.
        Assert.Equal(whileLive - 1, OpenCount());
    }
}
