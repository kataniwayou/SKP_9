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

    /// <summary>The values the dev pod sent before the dimensions moved to the payload, kept by the rollout.</summary>
    internal static ReportDimensions Dimensions() => new("myDepartment", "myTeam", "myNetwork", "928", "LLL");

    private static IEnumerable<Contribution> Many(Contribution contribution, int count) => Enumerable.Repeat(contribution, count);

    /// <summary>
    /// The live window 07:50-08:00 UTC of 2026-11-09 on the whole run, as the reach rule counts it (reach
    /// spec §5): 16 good files reaching split-exporter twice, 48 failing and 16 cancelled on the way, plus
    /// three with no proven end.
    /// </summary>
    internal static NapoleReport WorkedExample() => ReportBuilder.Build(
        Window,
        [.. Many(new(1, 2, 0, 0), 16), .. Many(new(1, 0, 1, 0), 48), .. Many(new(1, 0, 0, 1), 16), .. Many(default, 3)],
        Dimensions(),
        InsertedAt)!;

    [Fact]
    public void TheWorkedExample()
    {
        var report = WorkedExample();

        Assert.Equal(new MandatoryMeasurments(InputCount: 80, OutputCount: 32, DiscardedCount: 16, FailedCount: 48),
            report.MandatoryMeasurments);
        Assert.Equal(new CommonDimentions(
            "myDepartment", "myTeam", "myNetwork",
            ReportFromTime: 1794134400000, ReportToTime: 1794135000000, InsertionTime: 1794135060412,
            "928", "LLL", TimStampHour: 2026110810), report.CommonDimentions);
    }

    [Fact]
    public void TheCountersMayExceedTheInput()
    {
        // Input counts executions, the counters count step outcomes: no identity holds any more (reach spec §2.3).
        var m = ReportBuilder.Build(Window, [new(1, 2, 0, 0)], Dimensions(), InsertedAt)!.MandatoryMeasurments;

        Assert.Equal(new MandatoryMeasurments(InputCount: 1, OutputCount: 2, DiscardedCount: 0, FailedCount: 0), m);
    }

    [Fact]
    public void NothingWithAProvenEndIsNoReport()
    {
        Assert.Null(ReportBuilder.Build(Window, [default, default], Dimensions(), InsertedAt));
        Assert.Null(ReportBuilder.Build(Window, [], Dimensions(), InsertedAt));
    }

    [Fact]
    public void TimStampHourIsTheUtcHourOfFrom()
    {
        static long Hour(DateTimeOffset from) => ReportBuilder.Build(
            new ReportWindow(from, from.AddMinutes(10)), [new Contribution(1, 1, 0, 0)], Dimensions(), InsertedAt)!
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
