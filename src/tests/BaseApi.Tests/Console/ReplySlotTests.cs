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
}
