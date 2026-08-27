using BaseApi.Tests.Support;
using BaseConsole.Core.Gating;
using Messaging.Transport;
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

    /// <summary>
    /// The running trip total, as one poll sees it.
    /// <para>
    /// <b>Polled and asserted as a delta, for the reason <see cref="OpenCount"/> is.</b> The trip
    /// total is an observable over a process-wide field: every live owner in this assembly shares
    /// it, so no absolute reading belongs to one test. It is an observable rather than a
    /// <c>Counter</c> because the seed has to survive being taken before any MeterProvider exists
    /// -- see GateMetrics.
    /// </para>
    /// </summary>
    private static double TripCount()
    {
        using var metrics = new MetricCollector(L2GateMetrics.MeterName);
        metrics.Collect();
        return metrics.For(GateMetrics.TripsInstrument).Sum(m => m.Value);
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

        // Registering the gate is what makes the trip total reportable at all: a host that owns no
        // gate stays silent rather than claiming a healthy one, so this reading exists because the
        // owner above does.
        var before = TripCount();

        // Open, then closed, then open again: one trip, not two edges and not three.
        await gate.ReportHealthyAsync();
        await gate.TripAsync();
        await gate.ReportHealthyAsync();

        Assert.Equal(before + 1, TripCount());
    }

    [Fact]
    public async Task DisposingUnsubscribesSoAStoppedOwnerCountsNothing()
    {
        var gate = new L2Gate(NullLogger<L2Gate>.Instance);
        var owner = new L2GateMetrics(gate);
        await gate.ReportHealthyAsync();

        var whileLive = OpenCount();

        // A second registration, held for the duration, so the trip total keeps being reported
        // after this owner leaves. Without it "the count did not move" could be satisfied by the
        // series going absent, which is a different claim -- and the one this file exists to
        // distinguish. It reports a closed gate, so it does not disturb OpenCount either.
        using var witness = GateMetrics.Register(() => false);

        owner.Dispose();

        var beforeTrip = TripCount();
        await gate.TripAsync();

        Assert.Equal(beforeTrip, TripCount());

        // Dispose removes this owner from the registry that backs the gauge, so its open gate stops
        // being reported at all rather than being left behind as a stale 1 -- exactly one fewer
        // measurement reading 1 than while it was live.
        Assert.Equal(whileLive - 1, OpenCount());
    }
}
