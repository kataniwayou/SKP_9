using Processor.Analyst.Panels;
using Xunit;

namespace BaseApi.Tests.Analyst;

public sealed class PanelRegistryTests
{
    [Fact]
    public void EveryPanelIdIsUnique()
    {
        var ids = PanelRegistry.All.Select(p => p.PanelId).ToArray();

        Assert.Equal(ids.Length, ids.Distinct().Count());
    }

    [Fact]
    public void EveryPanelDeclaresABusinessOrOpsLayer()
    {
        Assert.All(PanelRegistry.All, p => Assert.Contains(p.Layer, new[] { "business", "ops" }));
    }

    [Fact]
    public void EveryPanelHasADescriptionLongEnoughToBeUseful()
    {
        // The descriptions go into the system prompt: they are the only thing telling the model what
        // a panel means. "queue" is not a description.
        Assert.All(PanelRegistry.All, p => Assert.True(p.Description.Length >= 20, p.PanelId));
    }

    [Fact]
    public void BothLayersArePresent()
    {
        // An agent with only one layer cannot correlate across layers, which is the entire
        // proficiency this processor is supposed to have.
        Assert.Contains(PanelRegistry.All, p => p.Layer == "business");
        Assert.Contains(PanelRegistry.All, p => p.Layer == "ops");
    }

    [Fact]
    public void BusinessQueriesAreScopedByTheTargetWorkflowId()
    {
        // C1: both business-layer queries filter on attributes.WorkflowId via a {{WORKFLOW}}
        // placeholder -- otherwise the Analyst's own step records (it is Service:Name "processor"
        // like every other processor) satisfy "an outcome record whose emitter isn't the
        // orchestrator" and count itself.
        Assert.All(
            PanelRegistry.All.Where(p => p.Layer == "business"),
            p => Assert.Contains("{{WORKFLOW}}", p.Query, StringComparison.Ordinal));
    }

    [Fact]
    public void OpsQueriesCarryNoWorkflowPlaceholder()
    {
        // C3: pipeline_* series have no workflow label at all, so an ops query must never claim a
        // workflow scope it cannot honour.
        Assert.All(
            PanelRegistry.All.Where(p => p.Layer == "ops"),
            p => Assert.DoesNotContain("{{WORKFLOW}}", p.Query, StringComparison.Ordinal));
    }

    [Fact]
    public void EveryOpsDescriptionSaysItHasNoWorkflowDimension()
    {
        // C3: the model reads the panel descriptions, not the design doc -- the caveat has to be
        // stated in the one channel that actually reaches it.
        Assert.All(
            PanelRegistry.All.Where(p => p.Layer == "ops"),
            p => Assert.Contains("workflow dimension", p.Description, StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void EveryOpsDescriptionExplainsSeriesCount()
    {
        // Review wave 3, finding 1: seriesCount reaches the model in every Prometheus ValueJson with
        // no explanation anywhere but an implementation comment. The description is the one channel
        // that reaches the model, so it has to say what the number means and its limit (a floor, not
        // a census -- an absent replica cannot be counted).
        Assert.All(
            PanelRegistry.All.Where(p => p.Layer == "ops"),
            p => Assert.Contains("seriesCount", p.Description, StringComparison.Ordinal));
    }

    [Fact]
    public void TheSubtractionDescriptionsAreHonestAboutBeingAnApproximation()
    {
        // Review wave 3, finding 3: queue-wait and produce-duration share an estimator and a join
        // key, but they count different message populations (consumed vs published), so the
        // correction is an approximation, not an exact join -- the description must say so rather
        // than claim it "lines up exactly".
        var queueWait = PanelRegistry.All.Single(p => p.PanelId == "queue-wait").Description;
        var produceDuration = PanelRegistry.All.Single(p => p.PanelId == "produce-duration").Description;

        Assert.Contains("approximat", queueWait, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("approximat", produceDuration, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("lines up exactly", queueWait, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void EveryOpsDescriptionCarriesTheNoDataDistinguishableCaveat()
    {
        // I2: the flag's Prometheus limitation is documented on an internal class and on PanelTrust
        // itself, but neither reaches the model -- only a panel description does.
        Assert.All(
            PanelRegistry.All.Where(p => p.Layer == "ops"),
            p => Assert.Contains("distinguishable", p.Description, StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void QueueWaitAndProduceDurationShareTheSameEstimatorAndGroupingSoTheyCanBeSubtracted()
    {
        // I4: the two queries must be identical in shape -- same grouping key, same
        // rate(sum)/rate(count) estimator -- or the subtraction their descriptions instruct is
        // undefined (different estimators; "queue" and "destination" have no given mapping).
        var queueWait = PanelRegistry.All.Single(p => p.PanelId == "queue-wait").Query;
        var produceDuration = PanelRegistry.All.Single(p => p.PanelId == "produce-duration").Query;

        var normalizedQueueWait = queueWait.Replace(
            "pipeline_queue_wait_seconds", "X", StringComparison.Ordinal);
        var normalizedProduceDuration = produceDuration.Replace(
            "pipeline_produce_duration_seconds", "X", StringComparison.Ordinal);

        Assert.Equal(normalizedQueueWait, normalizedProduceDuration);
        // Neither groups by "queue" or "destination" -- service_instance_id is the only shared key.
        Assert.DoesNotContain("queue,", queueWait, StringComparison.Ordinal);
        Assert.DoesNotContain("destination,", produceDuration, StringComparison.Ordinal);
    }

    [Fact]
    public void ConsumerDurationMeanGroupsByQueueAndDisposition()
    {
        // I1: IngressMetrics's own doc comment says disposition "is what keeps a slow success and a
        // slow refusal from averaging into a number describing neither" -- dropping it would let a
        // requeue storm during a store outage read as processing latency.
        var query = PanelRegistry.All.Single(p => p.PanelId == "consumer-duration-mean").Query;

        Assert.Contains("disposition", query, StringComparison.Ordinal);
        Assert.Contains("queue", query, StringComparison.Ordinal);
    }

    [Fact]
    public void TheOldArrivalMeanIdIsGone()
    {
        // M2: renamed while it was still free to rename -- the id freezes once shipped as a model
        // tool argument. "arrival" in this codebase names pipeline.queue.wait, not the consumer-hold
        // instrument this panel actually reads.
        Assert.DoesNotContain(PanelRegistry.All, p => p.PanelId == "arrival-mean");
        Assert.Contains(PanelRegistry.All, p => p.PanelId == "consumer-duration-mean");
    }
}
