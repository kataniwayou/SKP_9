using System.Diagnostics.Metrics;
using Messaging.Transport;
using Xunit;

namespace BaseApi.Tests.Console;

/// <summary>
/// Queue depth and attached consumers: how much work is waiting, and whether anything is listening.
/// <para>
/// <b>Why this exists when the hop gaps already count messages.</b> The hop-gap stats are a
/// conservation check — produced minus consumed — and a conservation check cannot tell a message
/// sitting in a queue from a message that vanished. Both read as a gap. Depth is the term that
/// separates them: gap roughly equal to depth is backlog, gap far exceeding depth is loss.
/// </para>
/// <para>
/// <b>It is also the only leading indicator on these boards.</b> Every existing verdict signal is
/// coincident or lagging — <c>consuming</c> drops once the consumer has already stopped, data
/// freshness degrades after exports stop, and a missing replica takes a liveness window plus an
/// export to notice. Depth rises while all of those are still green, because a consumer merely
/// SLOWER than its producer is not broken by any of their definitions.
/// </para>
/// <para>
/// <b>Consumers is broker-side truth, which nothing else here is.</b> <c>pipeline.consumer.consuming</c>
/// is the process asserting its own health; a dead replica's copy was held at 1 by the collector
/// until liveness windows were wrapped around every read of it. This count comes from the broker's
/// own reply to a passive declare, so it needs no such window.
/// </para>
/// </summary>
public sealed class QueueDepthTests : IDisposable
{
    private readonly List<(string Queue, long Value)> _depths = [];
    private readonly List<(string Queue, long Value)> _consumers = [];
    private readonly MeterListener _listener = new();

    public QueueDepthTests()
    {
        _listener.InstrumentPublished = (instrument, l) =>
        {
            if (instrument.Name is QueueDepthMetrics.DepthInstrument
                               or QueueDepthMetrics.ConsumersInstrument)
            {
                l.EnableMeasurementEvents(instrument);
            }
        };
        _listener.SetMeasurementEventCallback<long>((instrument, value, tags, _) =>
        {
            var queue = "";
            foreach (var tag in tags)
            {
                if (tag.Key == "queue")
                {
                    queue = tag.Value?.ToString() ?? "";
                }
            }

            var into = instrument.Name == QueueDepthMetrics.DepthInstrument ? _depths : _consumers;
            into.Add((queue, value));
        });
        _listener.Start();
    }

    public void Dispose() => _listener.Dispose();

    [Fact]
    public void AReportedDepthIsObservableAgainstItsQueue()
    {
        QueueDepthMetrics.Report("orchestrator-result", depth: 42, consumers: 3);

        _listener.RecordObservableInstruments();

        Assert.Contains(("orchestrator-result", 42L), _depths);
    }

    [Fact]
    public void ConsumersIsReportedSeparatelyFromDepth()
    {
        // Two instruments rather than one with a discriminating tag: they answer different
        // questions and a board reads them on different panels. A single instrument would force
        // every query to carry a filter that is easy to forget and silent when omitted.
        QueueDepthMetrics.Report("orchestrator-control", depth: 0, consumers: 1);

        _listener.RecordObservableInstruments();

        Assert.Contains(("orchestrator-control", 0L), _depths);
        Assert.Contains(("orchestrator-control", 1L), _consumers);
    }

    [Fact]
    public void ZeroDepthIsReportedRatherThanOmitted()
    {
        // An empty work queue is the healthy state and has to be visibly zero. A queue that
        // reports nothing when it is drained cannot be told apart from one nobody is measuring --
        // the same trap the dead-letter gauge documents, and the one that made a board render a
        // confident green 0 while the broker held 7.
        QueueDepthMetrics.Report("processor-idle", depth: 0, consumers: 2);

        _listener.RecordObservableInstruments();

        Assert.Contains(("processor-idle", 0L), _depths);
    }

    [Fact]
    public void ZeroConsumersIsReportedRatherThanOmitted()
    {
        // The whole point of the consumers gauge. Nothing attached is the fault it exists to
        // catch, so it is the one value that must never be expressed as an absent series.
        QueueDepthMetrics.Report("orchestrator-result", depth: 900, consumers: 0);

        _listener.RecordObservableInstruments();

        Assert.Contains(("orchestrator-result", 0L), _consumers);
    }

    [Fact]
    public void ASecondReportReplacesTheFirstRatherThanAccumulating()
    {
        // Depth is a level, not a total. A drained queue must stop reporting the depth it held.
        QueueDepthMetrics.Report("orchestrator-control", depth: 40, consumers: 1);
        QueueDepthMetrics.Report("orchestrator-control", depth: 2, consumers: 1);

        _listener.RecordObservableInstruments();

        var forQueue = _depths.Where(o => o.Queue == "orchestrator-control").ToList();
        Assert.Single(forQueue);
        Assert.Equal(2L, forQueue[0].Value);
    }

    [Fact]
    public void EveryReportedQueueIsObservedInOnePass()
    {
        QueueDepthMetrics.Report("q-a", depth: 1, consumers: 1);
        QueueDepthMetrics.Report("q-b", depth: 2, consumers: 0);
        QueueDepthMetrics.Report("q-c", depth: 0, consumers: 5);

        _listener.RecordObservableInstruments();

        Assert.Contains(("q-a", 1L), _depths);
        Assert.Contains(("q-b", 2L), _depths);
        Assert.Contains(("q-c", 0L), _depths);
        Assert.Contains(("q-b", 0L), _consumers);
    }

    [Fact]
    public void TheInstrumentNamesCarryNoRatioSuffix()
    {
        // Guards the unit trap this project has already paid for once. An OpenTelemetry unit of
        // "1" makes the Prometheus exporter append `_ratio` to the metric name -- which is where
        // pipeline_gate_open_ratio's name comes from, correctly, because that gauge IS a ratio.
        // On pipeline.deadletter.depth it produced pipeline_deadletter_depth_ratio for a count of
        // messages, and the panel querying the obvious name matched nothing and rendered green
        // while the broker held 7 parked messages.
        //
        // Asserting the name here is cheap; the unit itself is asserted below.
        Assert.Equal("pipeline.queue.depth", QueueDepthMetrics.DepthInstrument);
        Assert.Equal("pipeline.queue.consumers", QueueDepthMetrics.ConsumersInstrument);
    }

    [Fact]
    public void BothInstrumentsUseAnAnnotationUnitRatherThanOne()
    {
        // The other half of the trap above, and the half a name assertion cannot see. Read off the
        // published instruments rather than off a constant, so a unit changed in the metrics class
        // fails here rather than silently renaming the exported series.
        var units = new Dictionary<string, string?>();
        using var listener = new MeterListener
        {
            InstrumentPublished = (instrument, _) =>
            {
                if (instrument.Name is QueueDepthMetrics.DepthInstrument
                                   or QueueDepthMetrics.ConsumersInstrument)
                {
                    units[instrument.Name] = instrument.Unit;
                }
            },
        };
        listener.Start();

        Assert.Equal("{message}", units[QueueDepthMetrics.DepthInstrument]);
        Assert.Equal("{consumer}", units[QueueDepthMetrics.ConsumersInstrument]);
    }
}
