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

        metrics.Collect();
        Assert.Equal(0, metrics.For("pipeline.leader")[^1].Value);

        leader.BecomeLeader();
        metrics.Collect();
        Assert.Equal(1, metrics.For("pipeline.leader")[^1].Value);

        leader.BecomeFollower();
        metrics.Collect();
        Assert.Equal(0, metrics.For("pipeline.leader")[^1].Value);
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

        metrics.Collect();
        Assert.Equal(0, metrics.For("pipeline.hydration.admitted")[^1].Value);

        hydration.Open();
        metrics.Collect();
        Assert.Equal(1, metrics.For("pipeline.hydration.admitted")[^1].Value);
    }

    [Fact]
    public void ThePipelineLeaderGaugeIsIndependentOfConsumption()
    {
        // A follower still consumes: leadership fences cron fires only, because exactly one outcome
        // exists per step that ran. Asserting the two are separate instruments is what stops a
        // future reader wiring consumption to leadership on the strength of this gauge.
        var leader = new LeaderState();
        using var owner = new OrchestratorPipelineMetrics(leader, new HydrationAdmission());
        using var metrics = new MetricCollector(
            OrchestratorPipelineMetrics.MeterName, "BaseConsole.Core.Messaging");

        metrics.Collect();

        Assert.DoesNotContain(metrics.For("pipeline.leader"), m => m.Tags.ContainsKey("queue"));
    }
}
