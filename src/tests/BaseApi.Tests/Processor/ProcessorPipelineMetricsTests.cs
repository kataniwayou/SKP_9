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

        // Deliberately throwing rather than returning a default: the gauge must read Identity, and
        // an implementation that reached for IsHealthy instead would fail loudly here rather than
        // quietly agreeing with the assertion for the wrong reason.
        public bool IsHealthy => throw new NotSupportedException();

        public void SetIdentity(ProcessorIdentityFound identity) =>
            throw new NotSupportedException();

        public void SetDefinition(Guid schemaId, string definition) =>
            throw new NotSupportedException();

        public void MarkHealthy() => throw new NotSupportedException();
    }

    /// <summary>
    /// How many owners currently report a resolved identity.
    /// <para>
    /// <b>A fresh collector per call, so each reading is exactly one poll.</b>
    /// <see cref="MetricCollector.For"/> replays every measurement its listener has ever seen, so a
    /// reused collector folds earlier polls into the count and the delta stops meaning anything.
    /// </para>
    /// </summary>
    private static int ReadyCount()
    {
        using var metrics = new MetricCollector(ProcessorPipelineMeter.Name);
        metrics.Collect();
        return metrics.For("pipeline.identity.ready").Count(m => m.Value == 1);
    }

    [Fact]
    public void IdentityReadyFollowsWhetherTheRowHasResolved()
    {
        // An unregistered processor waits rather than restarting -- Running/NotReady with 0 restarts
        // is by design, and this gauge is what makes that state legible instead of alarming.
        //
        // ASSERT THE DELTA, NOT THE SET. The registry is process-wide and the gauge is deliberately
        // untagged -- there is one IProcessorContext per process, so a disambiguating tag would be a
        // permanently-constant dimension on a production series. An earlier version of this test
        // asserted every measurement was 0 while waiting, which held only because every other live
        // owner happened to report 0; under SKP_REALSTACK a genuinely registered live processor
        // reports 1 and the assertion failed on a fact about a different process's identity. This
        // context is the only thing that changes between readings.
        var context = new Context { Identity = null };
        using var owner = new ProcessorPipelineMetricsHost(context);

        var whileWaiting = ReadyCount();

        context.Identity = new ProcessorIdentity(
            Guid.NewGuid(), null, null, null, "sample-proc", "1.0.0", null, null, null);

        // Both directions in one assertion pair: a gauge hard-coded to either value moves by 0 here,
        // and one reading IsHealthy throws out of the observable callback.
        Assert.Equal(whileWaiting + 1, ReadyCount());
    }
}
