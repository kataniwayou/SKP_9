using BaseProcessor.Core.Processing;
using Processor.Napole;
using Xunit;

namespace BaseApi.Tests.Napole;

public sealed class ReportBuilderTests
{
    internal static readonly ReportWindow Window = new(
        new DateTimeOffset(2026, 11, 8, 10, 40, 0, TimeSpan.Zero),
        new DateTimeOffset(2026, 11, 8, 10, 50, 0, TimeSpan.Zero));

    internal static readonly DateTimeOffset InsertedAt = new(2026, 11, 8, 10, 51, 0, 412, TimeSpan.Zero);

    internal static ReportDimensions Dimensions() => new()
    {
        ReporterComponentName = "myDepartment",
        ReporterSubComponentName = "myTeam",
        ReporterNetworkName = "myNetwork",
        SrcCode = "928",
        SagCode = "LLL",
    };

    private static IEnumerable<RoundTrip> Many(RoundTrip verdict, int count) => Enumerable.Repeat(verdict, count);

    /// <summary>The 10:51 UTC tick of 2026-11-08, as ES counted it, plus three runs still in flight.</summary>
    internal static NapoleReport WorkedExample() => ReportBuilder.Build(
        Window,
        [.. Many(RoundTrip.Failed, 48), .. Many(RoundTrip.Cancelled, 16), .. Many(RoundTrip.Complete, 16), .. Many(RoundTrip.Unfinished, 3)],
        Dimensions(),
        InsertedAt)!;

    [Fact]
    public void TheWorkedExample()
    {
        var report = WorkedExample();

        Assert.Equal(new MandatoryMeasurments(InputCount: 80, OutputCount: 16, DiscardedCount: 16, FailedCount: 48),
            report.MandatoryMeasurments);
        Assert.Equal(new CommonDimentions(
            "myDepartment", "myTeam", "myNetwork",
            ReportFromTime: 1794134400000, ReportToTime: 1794135000000, InsertionTime: 1794135060412,
            "928", "LLL", TimStampHour: 2026110810), report.CommonDimentions);
    }

    [Fact]
    public void NothingTerminatedIsNoReport()
    {
        Assert.Null(ReportBuilder.Build(Window, [RoundTrip.Unfinished, RoundTrip.Unfinished], Dimensions(), InsertedAt));
        Assert.Null(ReportBuilder.Build(Window, [], Dimensions(), InsertedAt));
    }

    [Fact]
    public void TheCountsAlwaysAddUp()
    {
        var random = new Random(20261108);
        for (var i = 0; i < 200; i++)
        {
            var verdicts = Enumerable.Range(0, random.Next(1, 120))
                .Select(_ => (RoundTrip)random.Next(0, 4))
                .ToList();

            var m = ReportBuilder.Build(Window, verdicts, Dimensions(), InsertedAt)?.MandatoryMeasurments;
            if (m is null)
            {
                Assert.All(verdicts, v => Assert.Equal(RoundTrip.Unfinished, v));
                continue;
            }

            Assert.Equal(m.InputCount, m.OutputCount + m.FailedCount + m.DiscardedCount);
            Assert.Equal(verdicts.Count(v => v != RoundTrip.Unfinished), m.InputCount);
        }
    }

    [Fact]
    public void TimStampHourIsTheUtcHourOfFrom()
    {
        static long Hour(DateTimeOffset from) => ReportBuilder.Build(
            new ReportWindow(from, from.AddMinutes(10)), [RoundTrip.Complete], Dimensions(), InsertedAt)!
            .CommonDimentions.TimStampHour;

        Assert.Equal(2026123123, Hour(new DateTimeOffset(2026, 12, 31, 23, 50, 0, TimeSpan.Zero)));
        Assert.Equal(2026110806, Hour(DateTimeOffset.FromUnixTimeMilliseconds(1794119124704)));
        // Read in UTC whatever offset the instant arrives in.
        Assert.Equal(2026123123, Hour(new DateTimeOffset(2027, 1, 1, 1, 50, 0, TimeSpan.FromHours(2))));
    }

    [Fact]
    public void TheDimensionsAreCopiedUnchanged()
    {
        var d = WorkedExample().CommonDimentions;

        Assert.Equal(("myDepartment", "myTeam", "myNetwork", "928", "LLL"),
            (d.ReporterComponentName, d.ReporterSubComponentName, d.ReporterNetworkName, d.SrcCode, d.SagCode));
    }
}
