using BaseApi.Tests.Support;
using Orchestrator.Election;
using Orchestrator.Hydration;
using Orchestrator.Observability;
using Xunit;

namespace BaseApi.Tests.Orchestrator;

public sealed class OrchestratorPipelineMetricsTests
{
    /// <summary>
    /// How many owners currently report 1 on <paramref name="instrument"/>.
    /// <para>
    /// <b>A fresh collector per call, so each reading is exactly one poll.</b>
    /// <see cref="MetricCollector.For"/> replays every measurement its listener has ever seen, so a
    /// reused collector folds earlier polls into the count and the delta stops meaning anything.
    /// </para>
    /// </summary>
    private static int CountOnes(string instrument)
    {
        using var metrics = new MetricCollector(OrchestratorPipelineMetrics.MeterName);
        metrics.Collect();
        return metrics.For(instrument).Count(m => m.Value == 1);
    }

    [Fact]
    public void LeadershipIsReportedInBothDirections()
    {
        // Both directions, not just acquisition: the self-demotion fence is the half that matters,
        // and a gauge that only ever went up would show two leaders on one workflow as one.
        var leader = new LeaderState();
        using var owner = new OrchestratorPipelineMetrics(leader, new HydrationAdmission());

        // ASSERT THE DELTA, NOT THE SET. The registry is process-wide and the gauge is deliberately
        // untagged -- there is one LeaderState per process, so a disambiguating tag would be a
        // permanently-constant dimension on a production series. No assertion over the raw
        // measurement set can isolate this owner, because another live owner may report either
        // value. This LeaderState is the only thing that changes between readings.
        var before = CountOnes("pipeline.leader");

        leader.BecomeLeader();
        Assert.Equal(before + 1, CountOnes("pipeline.leader"));

        leader.BecomeFollower();
        Assert.Equal(before, CountOnes("pipeline.leader"));
    }

    [Fact]
    public void HydrationAdmissionIsReportedAndIsOneShot()
    {
        // It distinguishes "not consuming because the store is down" from "not consuming because
        // the first hydration pass has not finished" -- two states that look identical otherwise.
        var hydration = new HydrationAdmission();
        using var owner = new OrchestratorPipelineMetrics(new LeaderState(), hydration);

        var before = CountOnes("pipeline.hydration.admitted");

        hydration.Open();
        Assert.Equal(before + 1, CountOnes("pipeline.hydration.admitted"));

        // One-shot: HydrationAdmission has no close, so a second Open changes nothing. Asserting it
        // is what stops a future reader adding one on the strength of the gauge alone.
        hydration.Open();
        Assert.Equal(before + 1, CountOnes("pipeline.hydration.admitted"));
    }
}
