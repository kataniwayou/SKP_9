using Messaging.Contracts;
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
    public void DeadLetterDepthIsTheOnlyPanelThatCanSeeDiscardedWork()
    {
        // The agent's whole failure mode is a confident quiet result over a blind spot, and this was
        // the widest one left: a refused message produces no StepOutcome, so BOTH business panels
        // exclude it by construction (each requires attributes.Result) and no latency series moves.
        // Without this panel every board reads clean while the deployment loses work -- which is how
        // six parked outcomes went unnoticed for two days on the live stack.
        var panel = PanelRegistry.All.Single(p => p.PanelId == "dead-letter-depth");

        Assert.Equal("ops", panel.Layer);
        Assert.Equal(PanelKind.Prometheus, panel.Kind);
        Assert.Contains("pipeline_deadletter_depth", panel.Query, StringComparison.Ordinal);
    }

    [Fact]
    public void DeadLetterDepthDedupesReplicasWithMaxRatherThanSummingThem()
    {
        // Every replica of a role probes the SAME shared dead-letter queue and reports the same
        // number, so sum by (queue) multiplies the depth by the replica count -- measured live, the
        // three orchestrator replicas turned a real depth of 10 into 30. max is the only aggregator
        // that reads the queue rather than the fleet.
        var query = PanelRegistry.All.Single(p => p.PanelId == "dead-letter-depth").Query;

        Assert.Contains("max by (queue)", query, StringComparison.Ordinal);
        Assert.DoesNotContain("sum by", query, StringComparison.Ordinal);
        // service_instance_id would re-split what max by (queue) exists to collapse.
        Assert.DoesNotContain("service_instance_id", query, StringComparison.Ordinal);
    }

    [Fact]
    public void DeadLetterDepthSaysZeroIsAReportAndAbsenceIsNot()
    {
        // This panel inverts the caveat every other ops panel carries. Its probe publishes 0
        // explicitly for a queue it read and found empty (DeadLetterDepthMetrics: "Zero is a report,
        // not a silence"), so a present zero is a genuine all-clear -- while an ABSENT series means
        // nothing is probing that queue. Read the usual way round, a missing queue would be taken as
        // a healthy one, which is the single most expensive misreading available here.
        var description = PanelRegistry.All.Single(p => p.PanelId == "dead-letter-depth").Description;

        Assert.Contains("ZERO HERE IS A REPORT", description, StringComparison.Ordinal);
        Assert.Contains("Do not read a missing queue as a healthy one", description, StringComparison.Ordinal);
    }

    [Fact]
    public void RefusedMessagesSelectsOnTheHoistedTemplatesRatherThanItsOwnCopy()
    {
        // The panel identifies a refusal by matching the emitter's message template verbatim. A
        // literal copied into this query would be a fifth copy of a string with no compiler holding
        // it to the emitter -- and the failure mode is an empty panel, not an error. Asserting the
        // SHIPPED query contains the constants also pins that the compile-time substitution actually
        // ran, which a test against the pre-substitution template would not.
        var panel = PanelRegistry.All.Single(p => p.PanelId == "refused-messages");

        Assert.Equal("business", panel.Layer);
        Assert.Equal(PanelKind.Elastic, panel.Kind);
        Assert.Contains(RefusalTemplates.Parked, panel.Query, StringComparison.Ordinal);
        Assert.Contains(RefusalTemplates.NotParked, panel.Query, StringComparison.Ordinal);
    }

    [Fact]
    public void RefusedMessagesDoesNotRequireAnOutcomeAttribute()
    {
        // The bug the Kibana refusals panel shipped with, for exactly one session: a refused message
        // produces no StepOutcome, so ANY clause requiring attributes.Result renders this panel
        // permanently empty -- and an empty panel reads as "nothing was refused", which is the most
        // expensive available misreading of this particular panel.
        var query = PanelRegistry.All.Single(p => p.PanelId == "refused-messages").Query;

        Assert.DoesNotContain("attributes.Result", query, StringComparison.Ordinal);
    }

    [Fact]
    public void RefusedMessagesDoesNotExcludeTheOrchestrator()
    {
        // Both other business panels exclude service.name "orchestrator" to drop its duplicate
        // outcome records. Copying that clause here would delete the panel's most important rows:
        // orchestrator-result.dead is the dead-letter queue that actually holds parked messages on
        // this deployment, and the orchestrator is what logs the refusal that puts them there.
        var query = PanelRegistry.All.Single(p => p.PanelId == "refused-messages").Query;

        Assert.DoesNotContain("orchestrator", query, StringComparison.Ordinal);
        Assert.DoesNotContain("must_not", query, StringComparison.Ordinal);
    }

    [Fact]
    public void RefusedMessagesDoesNotPullStackTracesIntoTheTranscript()
    {
        // A successful read_panel result enters the model transcript UNTRUNCATED -- that is why
        // MaxTokenBudget exists. Five stack traces would be a large and almost entirely redundant
        // share of the dispatch's budget; exception type and message are the part that says why.
        var query = PanelRegistry.All.Single(p => p.PanelId == "refused-messages").Query;

        Assert.DoesNotContain("stacktrace", query, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("attributes.exception.type", query, StringComparison.Ordinal);
        Assert.Contains("attributes.exception.message", query, StringComparison.Ordinal);
    }

    [Fact]
    public void RefusedMessagesAndDeadLetterDepthDescribeThemselvesAsEventsVersusLevel()
    {
        // The pair is the point: depth is a LEVEL with no attribution (still sitting there, whose
        // work unknown), refusals are EVENTS scoped to this workflow in this window. depth > 0 with
        // no refusals in window is old unresolved loss; refusals in window is losing work NOW. A
        // model that does not know they disagree on purpose will read a conflict as an error.
        var refused = PanelRegistry.All.Single(p => p.PanelId == "refused-messages").Description;
        var depth = PanelRegistry.All.Single(p => p.PanelId == "dead-letter-depth").Description;

        Assert.Contains("dead-letter-depth", refused, StringComparison.Ordinal);
        Assert.Contains("EVENTS IN THIS WINDOW, NOT A LEVEL", refused, StringComparison.Ordinal);
        Assert.Contains("LEVEL, not a rate", depth, StringComparison.Ordinal);
    }

    [Fact]
    public void RefusedMessagesAdmitsThatAnUnattributedRefusalIsInvisibleToIt()
    {
        // The panel is workflow-scoped, and the workflow id reaches a refusal record only through
        // the delivery's own headers. A message parked before the sender stamped them -- or by a
        // sender that does not -- is real lost work this panel cannot see at all, and the model has
        // to be told that rather than reading a quiet panel as an all-clear. dead-letter-depth is
        // the cross-check, because a queue depth needs no attribution to be counted.
        var description = PanelRegistry.All.Single(p => p.PanelId == "refused-messages").Description;

        Assert.Contains("carries no workflow id is invisible here", description, StringComparison.Ordinal);
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
