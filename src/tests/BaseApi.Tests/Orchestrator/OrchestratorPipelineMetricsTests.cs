using BaseApi.Tests.Support;
using Orchestrator.Election;
using Orchestrator.Hydration;
using Orchestrator.Observability;
using Xunit;

namespace BaseApi.Tests.Orchestrator;

public sealed class OrchestratorPipelineMetricsTests
{
    [Fact]
    public void LeadershipIsReportedInBothDirections()
    {
        // Both directions, not just acquisition: the self-demotion fence is the half that matters,
        // and a gauge that only ever went up would show two leaders on one workflow as one.
        var leader = new LeaderState();
        var hydration = new HydrationAdmission();
        using var owner = new OrchestratorPipelineMetrics(leader, hydration);
        using var metrics = new MetricCollector(OrchestratorPipelineMetrics.MeterName);

        // The registry is process-wide, so another owner (e.g. the never-disposed wiring-test host)
        // can still be live here, always reporting 0. Assert over the set rather than picking a
        // single element.
        metrics.Collect();
        Assert.All(metrics.For("pipeline.leader"), m => Assert.Equal(0, m.Value));

        leader.BecomeLeader();
        metrics.Collect();
        Assert.Contains(metrics.For("pipeline.leader"), m => m.Value == 1);

        leader.BecomeFollower();

        // A fresh collector rather than reusing `metrics`: For() accumulates every measurement seen
        // since its listener started, across every Collect() call, so the existing one still carries
        // the value == 1 measurement from the round above. Assert.All over that full history would
        // fail on a value this owner legitimately reported earlier in this same test, not on a
        // leaked one. A new listener sees only what is published from here on.
        using var afterDemotion = new MetricCollector(OrchestratorPipelineMetrics.MeterName);
        afterDemotion.Collect();
        Assert.All(afterDemotion.For("pipeline.leader"), m => Assert.Equal(0, m.Value));
    }

    [Fact]
    public void HydrationAdmissionIsReportedAndIsOneShot()
    {
        // It distinguishes "not consuming because the store is down" from "not consuming because
        // the first hydration pass has not finished" -- two states that look identical otherwise.
        var leader = new LeaderState();
        var hydration = new HydrationAdmission();
        using var owner = new OrchestratorPipelineMetrics(leader, hydration);
        using var metrics = new MetricCollector(OrchestratorPipelineMetrics.MeterName);

        // The registry is process-wide, so another owner (e.g. the never-disposed wiring-test host)
        // can still be live here, always reporting 0. Assert over the set rather than picking a
        // single element.
        metrics.Collect();
        Assert.All(metrics.For("pipeline.hydration.admitted"), m => Assert.Equal(0, m.Value));

        hydration.Open();
        metrics.Collect();
        Assert.Contains(metrics.For("pipeline.hydration.admitted"), m => m.Value == 1);
    }
}
