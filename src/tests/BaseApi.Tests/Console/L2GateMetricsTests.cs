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

        metrics.Collect();
        Assert.Equal(0, Assert.Single(metrics.For("pipeline.gate.open")).Value);

        await gate.ReportHealthyAsync();

        metrics.Collect();
        Assert.Equal(1, metrics.For("pipeline.gate.open")[^1].Value);
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
        // disposed owner's gate is not merely stale, it is entirely absent from the next poll.
        metrics.Collect();
        Assert.Empty(metrics.For("pipeline.gate.open"));
    }
}
