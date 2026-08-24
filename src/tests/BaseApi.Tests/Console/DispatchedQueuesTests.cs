using Messaging.Transport;
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
    public void AQueueTheBrokerSaysIsGoneIsDroppedAfterEnoughConsecutiveMisses()
    {
        // Recording every send means recording the exclusive per-replica reply queues too, and
        // those are deleted with their process. Without a way out the set grows by one queue per
        // replica generation forever, and the probe spends a round trip per interval on each.
        DispatchedQueues.Record("proc-reply-dead");

        for (var i = 0; i < DispatchedQueues.MissesBeforeDrop; i++)
        {
            DispatchedQueues.Note("proc-reply-dead", ProbeOutcome.Missing);
        }

        Assert.DoesNotContain("proc-reply-dead", DispatchedQueues.Snapshot());
    }

    [Fact]
    public void OneMissShortOfTheThresholdKeepsTheQueue()
    {
        DispatchedQueues.Record("proc-reply-slow");

        for (var i = 0; i < DispatchedQueues.MissesBeforeDrop - 1; i++)
        {
            DispatchedQueues.Note("proc-reply-slow", ProbeOutcome.Missing);
        }

        Assert.Contains("proc-reply-slow", DispatchedQueues.Snapshot());
    }

    [Fact]
    public void AnUnreachableBrokerNeverDropsAnything()
    {
        // THE DISTINCTION THAT MAKES DROPPING SAFE. A broker outage fails every queue at once;
        // counting that as "gone" would empty the registry at the exact moment the backlog it
        // exists to measure was building. Only the broker itself answering 404 counts.
        DispatchedQueues.Record("processor-live");

        for (var i = 0; i < DispatchedQueues.MissesBeforeDrop * 3; i++)
        {
            DispatchedQueues.Note("processor-live", ProbeOutcome.Failed);
        }

        Assert.Contains("processor-live", DispatchedQueues.Snapshot());
    }

    [Fact]
    public void AQueueThatAnswersAgainHasItsCountReArmed()
    {
        // A 404 stretch during a topology re-declare must not leave a live queue one miss from
        // being forgotten for the rest of the process's life.
        DispatchedQueues.Record("processor-flapping");

        for (var i = 0; i < DispatchedQueues.MissesBeforeDrop - 1; i++)
        {
            DispatchedQueues.Note("processor-flapping", ProbeOutcome.Missing);
        }

        DispatchedQueues.Note("processor-flapping", ProbeOutcome.Ok);

        for (var i = 0; i < DispatchedQueues.MissesBeforeDrop - 1; i++)
        {
            DispatchedQueues.Note("processor-flapping", ProbeOutcome.Missing);
        }

        Assert.Contains("processor-flapping", DispatchedQueues.Snapshot());
    }

    [Fact]
    public void NotingAQueueThatWasNeverRecordedDoesNotAddIt()
    {
        // The probe reports on every queue it was given, including statically-configured ones.
        // Those are not this registry's to remember or to forget.
        DispatchedQueues.Note("orchestrator-control", ProbeOutcome.Ok);
        DispatchedQueues.Note("orchestrator-control", ProbeOutcome.Missing);

        Assert.Empty(DispatchedQueues.Snapshot());
    }

    [Fact]
    public void ABlankQueueIsRejectedRatherThanRecorded()
    {
        // A blank name would be declared passively against the default queue and report someone
        // else's depth, or nothing, with no indication which.
        Assert.Throws<ArgumentException>(() => DispatchedQueues.Record(" "));
    }
}
