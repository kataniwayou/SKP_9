using BaseConsole.Core.Messaging;
using Xunit;

namespace BaseApi.Tests.Console;

/// <summary>
/// The record of queues this process has dispatched to, which is what lets something that OUTLIVES
/// a consumer measure how deep that consumer's queue is getting.
/// <para>
/// <b>These tests exist because the obvious design was measured and found blind.</b> The queue-depth
/// probe was first registered only on the processor, watching its own work queue — so the queue was
/// probed solely by the pods whose absence causes it to fill. Against the broker, with the processor
/// deployment scaled to zero, the real depth went 0 → 3 with 0 consumers while the gauge read a
/// confident 0 the whole time.
/// </para>
/// </summary>
[Collection("DispatchedQueues")]
public sealed class DispatchedQueuesTests : IDisposable
{
    public DispatchedQueuesTests() => DispatchedQueues.Clear();

    public void Dispose() => DispatchedQueues.Clear();

    [Fact]
    public void ARecordedQueueIsReturned()
    {
        DispatchedQueues.Record("processor-abc");

        Assert.Contains("processor-abc", DispatchedQueues.Snapshot());
    }

    [Fact]
    public void RecordingTheSameQueueTwiceYieldsOneEntry()
    {
        // Called on every dispatch, so this runs at the pipeline's full rate. Duplicates would make
        // the probe declare the same queue many times per pass.
        DispatchedQueues.Record("processor-abc");
        DispatchedQueues.Record("processor-abc");

        Assert.Single(DispatchedQueues.Snapshot(), "processor-abc");
    }

    [Fact]
    public void TheSnapshotIsOrderedSoLogLinesAreComparable()
    {
        DispatchedQueues.Record("processor-c");
        DispatchedQueues.Record("processor-a");
        DispatchedQueues.Record("processor-b");

        Assert.Equal(["processor-a", "processor-b", "processor-c"], DispatchedQueues.Snapshot());
    }

    [Fact]
    public void ItStartsEmpty()
    {
        // Empty until the first dispatch, which is not a gap: the first dispatch is also the
        // earliest moment a backlog could exist.
        Assert.Empty(DispatchedQueues.Snapshot());
    }

    [Fact]
    public void AQueueIsNeverForgotten()
    {
        // Deliberate. A processor that stops being dispatched to keeps being measured -- and a
        // queue that has genuinely gone away fails its passive declare, which the probe latches as
        // one warning and NO series. An honest silence rather than a confident zero, which is the
        // whole reason this type exists.
        DispatchedQueues.Record("processor-gone");

        for (var i = 0; i < 100; i++)
        {
            DispatchedQueues.Record("processor-busy");
        }

        Assert.Contains("processor-gone", DispatchedQueues.Snapshot());
    }

    [Fact]
    public void ABlankQueueIsRejectedRatherThanRecorded()
    {
        // A blank name would be declared passively against the default queue and report someone
        // else's depth, or nothing, with no indication which.
        Assert.Throws<ArgumentException>(() => DispatchedQueues.Record(" "));
    }
}
