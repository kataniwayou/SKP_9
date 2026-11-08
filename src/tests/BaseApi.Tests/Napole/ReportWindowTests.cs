using Processor.Napole;
using Xunit;

namespace BaseApi.Tests.Napole;

public sealed class ReportWindowTests
{
    private static DateTimeOffset Utc(int h, int m, int s = 0, int ms = 0)
        => new(2026, 11, 8, h, m, s, ms, TimeSpan.Zero);

    [Fact]
    public void TheWorkedExampleTick()
    {
        var w = ReportWindow.For(Utc(10, 51), 10, TimeSpan.FromSeconds(60));

        Assert.Equal(new ReportWindow(Utc(10, 40), Utc(10, 50)), w);
    }

    [Fact]
    public void ALateTickStillReportsItsGridSlot()
    {
        // A dispatch that ran almost a whole slot late must not move the window: that is what keeps
        // back-to-back ticks free of gaps and overlaps whatever the queue delay was.
        var w = ReportWindow.For(Utc(10, 59, 59, 999), 10, TimeSpan.FromSeconds(60));

        Assert.Equal(new ReportWindow(Utc(10, 40), Utc(10, 50)), w);
    }

    [Fact]
    public void ATickInsideTheLagReportsThePreviousSlot()
    {
        var w = ReportWindow.For(Utc(10, 50, 30), 10, TimeSpan.FromSeconds(60));

        Assert.Equal(new ReportWindow(Utc(10, 30), Utc(10, 40)), w);
    }

    [Fact]
    public void AnOddWindowSnapsToTheEpochGrid()
    {
        // 10:50 is epoch minute 29,902,250 = 7 x 4,271,750.
        var w = ReportWindow.For(Utc(10, 51), 7, TimeSpan.Zero);

        Assert.Equal(new ReportWindow(Utc(10, 43), Utc(10, 50)), w);
    }

    [Fact]
    public void ANonUtcClockGivesTheSameWindow()
    {
        var w = ReportWindow.For(new DateTimeOffset(2026, 11, 8, 12, 51, 0, TimeSpan.FromHours(2)), 10, TimeSpan.FromSeconds(60));

        Assert.Equal(new ReportWindow(Utc(10, 40), Utc(10, 50)), w);
        Assert.Equal(TimeSpan.Zero, w.From.Offset);
        Assert.Equal(TimeSpan.Zero, w.To.Offset);
    }

    [Fact]
    public void AWindowBelowOneMinuteIsRefused()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => ReportWindow.For(Utc(10, 51), 0, TimeSpan.Zero));
    }

    [Fact]
    public void TrailSpanExtendsBothWays()
    {
        var span = new ReportWindow(Utc(10, 40), Utc(10, 50)).TrailSpan(TimeSpan.FromMinutes(10));

        Assert.Equal((Utc(10, 30), Utc(11, 0)), span);
    }
}
