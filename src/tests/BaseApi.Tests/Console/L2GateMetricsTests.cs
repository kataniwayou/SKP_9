using BaseApi.Tests.Support;
using BaseConsole.Core.Gating;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace BaseApi.Tests.Console;

public sealed class L2GateMetricsTests
{
    [Fact]
    public async Task TheGaugeFollowsTheGate()
    {
        // L2Gate is constructed closed by design -- notification fires on transitions only, so a
        // gate that started open would never produce an opening edge.
        var gate = new L2Gate(NullLogger<L2Gate>.Instance);
        using var owner = new L2GateMetrics(gate);
        using var metrics = new MetricCollector(L2GateMetrics.MeterName);

        // The registry is process-wide, so another owner constructed earlier in the process (e.g.
        // the never-disposed wiring-test host) can still be live here, always reporting 0. Assert
        // over the set rather than picking a single element.
        metrics.Collect();
        Assert.All(metrics.For("pipeline.gate.open"), m => Assert.Equal(0, m.Value));

        await gate.ReportHealthyAsync();

        metrics.Collect();
        Assert.Contains(metrics.For("pipeline.gate.open"), m => m.Value == 1);
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

        owner.Dispose();

        using var metrics = new MetricCollector(L2GateMetrics.MeterName);
        await gate.TripAsync();

        Assert.Empty(metrics.For("pipeline.gate.trips"));

        // The registry backs the gauge too, and Dispose removes this owner from it -- so a
        // disposed owner's gate is not merely stale, it is entirely absent from the next poll. The
        // registry is process-wide, though, so another owner (e.g. the never-disposed wiring-test
        // host) can still be live here -- it always reports 0, so the only thing this disposed
        // owner's absence proves is that no measurement is 1: this owner's gate was driven open
        // before disposal, and a stale entry would still show it as 1.
        metrics.Collect();
        Assert.DoesNotContain(metrics.For("pipeline.gate.open"), m => m.Value == 1);
    }
}
