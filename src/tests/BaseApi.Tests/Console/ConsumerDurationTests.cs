using Messaging.Transport;
using BaseApi.Tests.Support;
using BaseConsole.Core.Messaging;
using Xunit;

namespace BaseApi.Tests.Console;

[Collection(EnvironmentCollection.Name)]
public sealed class ConsumerDurationTests
{
    [Fact]
    public void EveryDispositionCarriesItsOwnDuration()
    {
        using var metrics = new MetricCollector(IngressMetrics.MeterName);

        // Three terminal paths, one measurement each. A parked delivery's cost must be visible
        // beside a handled one's -- that is the whole meaning of "regardless of path", and it is
        // what pipeline.process.duration could not do, because it only measured the transform and
        // only on deliveries that reached one.
        IngressMetrics.RecordConsumerDuration("q-dur", "T", "acked", 0.010);
        IngressMetrics.RecordConsumerDuration("q-dur", "T", "requeued", 0.020);
        IngressMetrics.RecordConsumerDuration("q-dur", "T", "parked", 0.030);

        var mine = metrics.For(IngressMetrics.ConsumerDurationInstrument)
            .Where(m => m.Tags["queue"] == "q-dur")
            .ToList();

        Assert.Equal(3, mine.Count);
        Assert.Equal(
            ["acked", "requeued", "parked"],
            mine.Select(m => m.Tags["disposition"]));
        Assert.Equal([0.010, 0.020, 0.030], mine.Select(m => m.Value));
    }
}
