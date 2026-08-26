using BaseApi.Tests.Support;
using BaseConsole.Core.Messaging;
using Messaging.Transport;
using Orchestrator.Election;
using Orchestrator.Observability;
using Xunit;

namespace BaseApi.Tests.Observability;

/// <summary>
/// The host-supplied process-wide tag on the shared message instruments.
/// <para>
/// It is process-global static state, so every test here installs its provider inside a
/// <c>try/finally</c> that clears it. A leaked provider would put a <c>role</c> on measurements
/// recorded by every other test class in the run, which is exactly the failure this file exists to
/// prevent in production.
/// </para>
/// </summary>
[Collection(nameof(PipelineAmbientTagTests))]
public sealed class PipelineAmbientTagTests
{
    private static string? RoleOf(RecordedMeasurement m) =>
        m.Tags.TryGetValue("role", out var v) ? v : null;

    [Fact]
    public async Task WithNoProviderTheTagIsAbsentRatherThanEmpty()
    {
        // The processor's case. Absent, not "": an empty value would be matched by a query looking
        // for a role and would make a processor's series answer a question about orchestrators.
        PipelineAmbientTag.Clear();
        using var metrics = new MetricCollector(EgressMetrics.MeterName, IngressMetrics.MeterName);

        await EgressMetrics.MeasureAsync(
            EgressMetrics.RouteQueue, "q", "step-outcome", () => Task.CompletedTask);
        IngressMetrics.RecordConsumed("q", "step-outcome", "acked", "handled");

        Assert.All(metrics.For("pipeline.messages.produced"), m => Assert.Null(RoleOf(m)));
        Assert.All(metrics.For("pipeline.messages.consumed"), m => Assert.Null(RoleOf(m)));
    }

    [Fact]
    public async Task TheTagLandsOnBothTheEgressAndIngressInstruments()
    {
        var state = new LeaderState();
        PipelineAmbientTag.Provide(
            () => new KeyValuePair<string, object?>(OrchestratorRoleLogEnricher.Role, state.Role));
        try
        {
            using var metrics = new MetricCollector(EgressMetrics.MeterName, IngressMetrics.MeterName);

            await EgressMetrics.MeasureAsync(
                EgressMetrics.RouteQueue, "q", "step-outcome", () => Task.CompletedTask);
            IngressMetrics.RecordConsumed("q", "step-outcome", "acked", "handled");

            Assert.Equal("follower", RoleOf(Assert.Single(metrics.For("pipeline.messages.produced"))));
            Assert.Equal("follower", RoleOf(Assert.Single(metrics.For("pipeline.messages.consumed"))));

            // The duration histogram shares the counter's TagList, so the two can never disagree
            // about which role a send belonged to.
            Assert.Equal("follower", RoleOf(Assert.Single(metrics.For("pipeline.produce.duration"))));
        }
        finally
        {
            PipelineAmbientTag.Clear();
        }
    }

    [Fact]
    public async Task ADemotionAttributesTheNextMeasurementToTheFollowerItNowIs()
    {
        // THE POINT. A provider whose value were captured at install time would keep crediting a
        // demoted replica's work to the leader for the rest of the process -- and the leader that
        // actually took over would appear to be doing none of it.
        var state = new LeaderState();
        PipelineAmbientTag.Provide(
            () => new KeyValuePair<string, object?>(OrchestratorRoleLogEnricher.Role, state.Role));
        try
        {
            state.BecomeLeader();
            using var asLeader = new MetricCollector(EgressMetrics.MeterName);
            await EgressMetrics.MeasureAsync(
                EgressMetrics.RouteQueue, "q", "process-dispatch", () => Task.CompletedTask);
            Assert.Equal("leader", RoleOf(Assert.Single(asLeader.For("pipeline.messages.produced"))));

            state.BecomeFollower();
            using var asFollower = new MetricCollector(EgressMetrics.MeterName);
            await EgressMetrics.MeasureAsync(
                EgressMetrics.RouteQueue, "q", "process-dispatch", () => Task.CompletedTask);
            Assert.Equal("follower", RoleOf(Assert.Single(asFollower.For("pipeline.messages.produced"))));
        }
        finally
        {
            PipelineAmbientTag.Clear();
        }
    }
}
