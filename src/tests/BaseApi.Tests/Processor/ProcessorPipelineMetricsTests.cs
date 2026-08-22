using BaseApi.Tests.Support;
using BaseProcessor.Core.Identity;
using BaseProcessor.Core.Observability;
using Messaging.Contracts;
using Xunit;

namespace BaseApi.Tests.Processor;

public sealed class ProcessorPipelineMetricsTests
{
    private sealed class Context : IProcessorContext
    {
        public ProcessorIdentity? Identity { get; set; }

        public bool IsHealthy => throw new NotSupportedException();

        public void SetIdentity(ProcessorIdentityFound identity) =>
            throw new NotSupportedException();

        public void SetDefinition(Guid schemaId, string definition) =>
            throw new NotSupportedException();

        public void MarkHealthy() => throw new NotSupportedException();
    }

    [Fact]
    public void IdentityReadyIsZeroWhileTheProcessorIsStillWaitingToBeRegistered()
    {
        // An unregistered processor waits rather than restarting -- Running/NotReady with 0
        // restarts is by design. This gauge is what makes that state legible instead of alarming,
        // so the zero case is the one worth asserting first.
        var context = new Context { Identity = null };
        using var owner = new ProcessorPipelineMetricsHost(context);
        using var metrics = new MetricCollector(ProcessorPipelineMeter.Name);

        // The registry is process-wide, so another owner (e.g. the never-disposed wiring-test host)
        // can still be live here. Assert over the set rather than picking a single element -- the
        // identical latent shape that made the orchestrator and gate gauges order-dependent.
        metrics.Collect();

        Assert.All(metrics.For("pipeline.identity.ready"), m => Assert.Equal(0, m.Value));
    }

    [Fact]
    public void IdentityReadyIsOneOnceTheProcessorHasBeenRegistered()
    {
        // The transition to 1 is the whole reason the gauge exists -- a gauge that only ever proved
        // it could report 0 would pass even if the positive branch were deleted.
        var identity = new ProcessorIdentity(
            Guid.NewGuid(), null, null, null, "sample-proc", "1.0.0", null, null, null);
        var context = new Context { Identity = identity };
        using var owner = new ProcessorPipelineMetricsHost(context);
        using var metrics = new MetricCollector(ProcessorPipelineMeter.Name);

        metrics.Collect();

        Assert.Contains(metrics.For("pipeline.identity.ready"), m => m.Value == 1);
    }

    [Fact]
    public void ADuplicateDeliverySuppressionIsCounted()
    {
        // That path acks having done no work, so it is invisible under disposition=acked. It is
        // the primary idempotence mechanism, and its rate is the only way to notice the mechanism
        // firing more than rarely.
        using var metrics = new MetricCollector(ProcessorPipelineMeter.Name);

        ProcessorPipelineMetrics.RecordDuplicateSuppressed();

        var m = Assert.Single(metrics.For("pipeline.duplicate.suppressed"));
        Assert.Equal(1, m.Value);
    }
}
