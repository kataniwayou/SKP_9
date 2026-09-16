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
        slot.Publish("first");

        Assert.Equal("first", slot.Take());
        Assert.Null(slot.Take());
    }

    [Fact]
    public void LatestPublishWins()
    {
        var slot = new ReplySlot<string>();
        slot.Publish("first");
        slot.Publish("second");

        Assert.Equal("second", slot.Take());
    }

    [Fact]
    public async Task WaitReturnsEarlyWhenAReplyArrives()
    {
        var slot = new ReplySlot<string>();
        var sw = Stopwatch.StartNew();

        var waiter = slot.WaitAsync(TimeSpan.FromSeconds(30), TestContext.Current.CancellationToken);
        slot.Publish("arrived");
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

        slot.Publish("the late answer to the previous ask");
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

        slot.Publish("stale");
        slot.Take();

        var waiter = slot.WaitAsync(TimeSpan.FromSeconds(30), TestContext.Current.CancellationToken);
        slot.Publish("fresh");
        await waiter;

        Assert.Equal("fresh", slot.Take());
    }
}
