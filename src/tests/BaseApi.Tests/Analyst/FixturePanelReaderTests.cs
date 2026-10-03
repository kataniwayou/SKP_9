using Processor.Analyst.Panels;
using Xunit;

namespace BaseApi.Tests.Analyst;

public sealed class FixturePanelReaderTests
{
    private static readonly TimeRange Window = new(
        new DateTimeOffset(2026, 9, 24, 0, 0, 0, TimeSpan.Zero),
        new DateTimeOffset(2026, 9, 24, 6, 0, 0, TimeSpan.Zero));

    [Fact]
    public async Task ItReturnsTheReadingItWasGiven()
    {
        var reader = new FixturePanelReader()
            .Reading("arrival-mean", "ops", """{"mean":180}""", samples: 91);

        var reading = await reader.ReadAsync("arrival-mean", Guid.Empty, Window, history: false, CancellationToken.None);

        Assert.Equal("ops", reading.Layer);
        Assert.Equal(91, reading.SampleCount);
        Assert.True(reading.Trust.SeriesPresent);
    }

    [Fact]
    public async Task AnAbsentSeriesIsReportedAsUntrustedRatherThanEmpty()
    {
        // The distinction the whole validate stage rests on. An orphaned instrument makes a panel
        // render perfectly healthy while missing a series -- so "no data" must arrive flagged, never
        // as a clean zero.
        var reader = new FixturePanelReader().MissingSeries("liveness");

        var reading = await reader.ReadAsync("liveness", Guid.Empty, Window, history: false, CancellationToken.None);

        Assert.False(reading.Trust.SeriesPresent);
        Assert.False(reading.Trust.NoDataDistinguishable);
    }

    [Fact]
    public async Task AnUnreachablePanelThrows()
    {
        // Not a reading with a sad flag: a source that cannot be reached means the analysis could
        // not run, and the loop turns this into a failed step.
        var reader = new FixturePanelReader().Failing("queue-wait", "elasticsearch timed out");

        var ex = await Assert.ThrowsAsync<PanelUnavailableException>(
            () => reader.ReadAsync("queue-wait", Guid.Empty, Window, history: false, CancellationToken.None));

        Assert.Contains("elasticsearch", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ReadingAPanelThatWasNeverConfiguredThrows()
    {
        var reader = new FixturePanelReader();

        await Assert.ThrowsAsync<PanelUnavailableException>(
            () => reader.ReadAsync("nope", Guid.Empty, Window, history: false, CancellationToken.None));
    }
}
