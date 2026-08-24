using System.Diagnostics.Metrics;
using BaseConsole.Core.Messaging;
using Xunit;

namespace BaseApi.Tests.Console;

/// <summary>
/// Dead-letter depth: the standing count of work this deployment has thrown away and not dealt with.
/// <para>
/// <b>Why a gauge and not the existing counter.</b> <c>pipeline.messages.consumed</c> already carries
/// <c>disposition="parked"</c>, and it fires correctly at the moment a message is refused. But a
/// counter reports an EVENT: it increments, it is visible for one rate window, and it scrolls away.
/// Nothing then reports that the message is still sitting there.
/// </para>
/// <para>
/// <b>This is not hypothetical.</b> Six parked step outcomes were found on the live stack, from four
/// incidents across two days, each one a workflow run that lost progress permanently. Every board
/// read green, all five alert rules stayed inactive, and they were found only by querying the broker
/// by hand. The counter had done its job at the time and had nothing left to say two days later.
/// </para>
/// <para>
/// <b>Zero must be reported, not omitted.</b> A dead-letter queue at zero is the healthy state and
/// has to be visibly zero — an absent series is indistinguishable from an instrument that was never
/// wired, which is the same trap the fault panels' <c>or vector(0)</c> exists to close.
/// </para>
/// </summary>
public sealed class DeadLetterDepthTests : IDisposable
{
    private readonly List<(string Queue, long Depth)> _observed = [];
    private readonly MeterListener _listener = new();

    public DeadLetterDepthTests()
    {
        _listener.InstrumentPublished = (instrument, l) =>
        {
            if (instrument.Name == DeadLetterDepthMetrics.DepthInstrument)
            {
                l.EnableMeasurementEvents(instrument);
            }
        };
        _listener.SetMeasurementEventCallback<long>((_, value, tags, _) =>
        {
            var queue = "";
            foreach (var tag in tags)
            {
                if (tag.Key == "queue")
                {
                    queue = tag.Value?.ToString() ?? "";
                }
            }

            _observed.Add((queue, value));
        });
        _listener.Start();
    }

    public void Dispose() => _listener.Dispose();

    [Fact]
    public void AReportedDepthIsObservableAgainstItsQueue()
    {
        DeadLetterDepthMetrics.Report("orchestrator-result.dead", 7);

        _listener.RecordObservableInstruments();

        Assert.Contains(("orchestrator-result.dead", 7L), _observed);
    }

    [Fact]
    public void ZeroIsReportedRatherThanOmitted()
    {
        // The healthy state, and it must be visibly zero. A queue that reports nothing when it is
        // empty cannot be told apart from one nobody is measuring.
        DeadLetterDepthMetrics.Report("processor-zero.dead", 0);

        _listener.RecordObservableInstruments();

        Assert.Contains(("processor-zero.dead", 0L), _observed);
    }

    [Fact]
    public void ASecondReportReplacesTheFirstRatherThanAccumulating()
    {
        // Depth is a level, not a total. Two observations of the same queue must not both appear, or
        // a drained queue would keep reporting the depth it used to have.
        DeadLetterDepthMetrics.Report("orchestrator-control.dead", 4);
        DeadLetterDepthMetrics.Report("orchestrator-control.dead", 1);

        _listener.RecordObservableInstruments();

        var forQueue = _observed.Where(o => o.Queue == "orchestrator-control.dead").ToList();
        Assert.Single(forQueue);
        Assert.Equal(1L, forQueue[0].Depth);
    }

    [Fact]
    public void EveryReportedQueueIsObservedInOnePass()
    {
        // One instrument covering every dead-letter queue the process owns, so a board can sum them
        // into a single "work discarded and not dealt with" number without knowing the names.
        DeadLetterDepthMetrics.Report("a.dead", 1);
        DeadLetterDepthMetrics.Report("b.dead", 2);
        DeadLetterDepthMetrics.Report("c.dead", 0);

        _listener.RecordObservableInstruments();

        Assert.Contains(("a.dead", 1L), _observed);
        Assert.Contains(("b.dead", 2L), _observed);
        Assert.Contains(("c.dead", 0L), _observed);
    }
}
