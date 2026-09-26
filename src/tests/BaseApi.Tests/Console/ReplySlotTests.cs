using System.Diagnostics;
using BaseConsole.Core.Messaging;
using Xunit;

namespace BaseApi.Tests.Console;

public sealed class ReplySlotTests
{
    [Fact]
    public void TakeReturnsNullWhenEmpty() => Assert.Null(new ReplySlot<string>().Take());

    [Fact]
    public void TakeDrainsTheSlot()
    {
        var slot = new ReplySlot<string>();
        slot.Expect("c1");
        slot.Publish("first", "c1");

        Assert.Equal("first", slot.Take());
        Assert.Null(slot.Take());
    }

    [Fact]
    public void LatestPublishWins()
    {
        var slot = new ReplySlot<string>();
        slot.Expect("c1");
        slot.Publish("first", "c1");
        slot.Publish("second", "c1");

        Assert.Equal("second", slot.Take());
    }

    [Fact]
    public async Task WaitReturnsEarlyWhenAReplyArrives()
    {
        var slot = new ReplySlot<string>();
        var sw = Stopwatch.StartNew();

        slot.Expect("c1");
        var waiter = slot.WaitAsync(TimeSpan.FromSeconds(30), TestContext.Current.CancellationToken);
        slot.Publish("arrived", "c1");
        await waiter;

        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(5), $"waited {sw.Elapsed}");
    }

    [Fact]
    public async Task WaitReturnsOnTimeoutWithNoReply()
    {
        var slot = new ReplySlot<string>();
        await slot.WaitAsync(TimeSpan.FromMilliseconds(50), TestContext.Current.CancellationToken);
        Assert.Null(slot.Take());
    }

    // ---- the stale signal ---------------------------------------------------------------------

    [Fact]
    public async Task ADrainedReplyDoesNotLeaveASignalBehind()
    {
        // THE WEDGE, REPRODUCED. A reply that lands while nobody is waiting -- the late answer to an
        // ask that already gave up -- sets BOTH the value and the signal. Take() drained only the
        // value, so the next wait returned instantly on a signal belonging to an answer that had
        // already been thrown away. The loop then reported "nothing has answered" microseconds after
        // sending, the real answer arrived just after and re-armed the signal, and the pod asked
        // forever while every reply was discarded by the wait that had already given up on it.
        //
        // Drives the slot exactly as BrokerIdentityBootstrap.AskAsync does: drain, send, wait.
        var slot = new ReplySlot<string>();

        slot.Expect("c1");
        slot.Publish("the late answer to the previous ask", "c1");
        slot.Take();

        var sw = Stopwatch.StartNew();
        await slot.WaitAsync(TimeSpan.FromMilliseconds(400), TestContext.Current.CancellationToken);
        sw.Stop();

        Assert.True(
            sw.ElapsedMilliseconds >= 300,
            $"the wait returned in {sw.ElapsedMilliseconds}ms instead of waiting out its timeout: a "
            + "drained reply left its signal behind, so this ask can never receive an answer");
    }

    [Fact]
    public async Task AFreshReplyStillWakesAWaitAfterAStaleOneWasDrained()
    {
        // The other half, and the one a careless fix breaks: clearing the stale signal must not
        // leave the slot deaf. A slot that never wakes again would turn every ask into a full
        // timeout -- slower than the wedge and just as wrong.
        var slot = new ReplySlot<string>();

        slot.Expect("c1");
        slot.Publish("stale", "c1");
        slot.Take();

        slot.Expect("c2");
        var waiter = slot.WaitAsync(TimeSpan.FromSeconds(30), TestContext.Current.CancellationToken);
        slot.Publish("fresh", "c2");
        await waiter;

        Assert.Equal("fresh", slot.Take());
    }

    // ---- the crossed reply --------------------------------------------------------------------

    [Fact]
    public void AReplyForAnotherAskIsRefused()
    {
        // THE CROSSING, REPRODUCED. One slot serves every asker in a process, and a reply used to be
        // published into it on message TYPE alone -- so the late answer to an ask that had already
        // timed out was handed to whoever asked next. Observed on the live stack: a processor's
        // config-schema request received the definition fetched for its output schema one request
        // earlier, and the conformance check was the only reason anyone found out. The output
        // definition stored moments before was crossed the same way and nothing noticed at all.
        var slot = new ReplySlot<string>();

        slot.Expect("the-ask-in-flight");

        Assert.False(slot.Publish("the answer to something else", "some-earlier-ask"));
        Assert.Null(slot.Take());
    }

    [Fact]
    public async Task ARefusedReplyLeavesNoSignalBehind()
    {
        // A refusal must not wake the waiter either. Storing nothing but releasing the semaphore
        // would return the ask instantly with no value -- the same "nothing has answered" wedge the
        // drained-signal bug produced, arrived at from the other side.
        var slot = new ReplySlot<string>();
        slot.Expect("mine");

        slot.Publish("not mine", "someone-elses");

        var sw = Stopwatch.StartNew();
        await slot.WaitAsync(TimeSpan.FromMilliseconds(400), TestContext.Current.CancellationToken);
        sw.Stop();

        Assert.True(sw.ElapsedMilliseconds >= 300, $"the wait returned in {sw.ElapsedMilliseconds}ms");
    }

    [Fact]
    public void AnIdLessReplyIsRefused()
    {
        // Every reply in this system carries an id -- RpcQueueConsumer echoes the request's verbatim
        // -- so one without is a reply this process cannot attribute, and an unattributable answer is
        // exactly what must not be trusted.
        var slot = new ReplySlot<string>();
        slot.Expect("mine");

        Assert.False(slot.Publish("anonymous", null));
        Assert.Null(slot.Take());
    }

    [Fact]
    public void ACollectedAskAcceptsNoDuplicate()
    {
        // The ask is over once its answer is collected. A redelivered reply must not refill the slot
        // and be collected by whichever ask comes next.
        var slot = new ReplySlot<string>();
        slot.Expect("c1");
        slot.Publish("answer", "c1");

        Assert.Equal("answer", slot.Take());
        Assert.False(slot.Publish("answer", "c1"));
    }
}
