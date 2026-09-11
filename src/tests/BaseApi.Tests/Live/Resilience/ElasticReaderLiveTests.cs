using Xunit;

namespace BaseApi.Tests.Live.Resilience;

/// <summary>
/// A smoke check that the reader addresses a real index and projects real records. The projection
/// itself is covered hermetically in RunLedgerTests, which loads its fixture through the same method.
/// </summary>
[Trait("Category", Chaos.Category)]
[Collection(Chaos.Category)]
public sealed class ElasticReaderLiveTests
{
    /// <summary>
    /// How far in the past every window here ends.
    /// <para>
    /// <b>The completeness check in <see cref="ElasticLogReader"/> compares the collected count to a
    /// total taken before the first page, so it holds only while nothing is indexed into the window
    /// mid-read.</b> A window ending at <c>UtcNow</c> is closed in time and open in ingest: the
    /// collector batches its exports, so records stamped before the end keep arriving after the count
    /// was taken. That is exactly how this test failed on 2026-09-11 — collected 2,344,841 against a
    /// reported 2,344,804, an overshoot of fresh ingest rather than a dropped page. Ending the window
    /// behind the exporter's batch interval closes it in both senses.
    /// </para>
    /// </summary>
    private static readonly TimeSpan IngestLag = TimeSpan.FromMinutes(2);

    /// <summary>
    /// Widths tried in order, stopping at the first that holds any record.
    /// <para>
    /// <b>This replaced a single seven-day window, which was the other half of the same failure.</b>
    /// Seven days of this workflow is over two million records: ~2,300 sequential pages, five minutes
    /// of reading, and five minutes in which the race above is not a risk but a certainty. The
    /// ladder's first rung covers a soak that just ran and reads in a second; the later rungs exist
    /// so that running this before any scenario — the collection's order is not fixed — still finds
    /// the traffic it needs rather than failing for want of it.
    /// </para>
    /// </summary>
    private static readonly TimeSpan[] Ladder =
    [
        TimeSpan.FromMinutes(15),
        TimeSpan.FromHours(1),
        TimeSpan.FromHours(6),
        TimeSpan.FromHours(24),
    ];

    [Fact]
    public async Task TheReaderProjectsRecordsFromTheLiveIndex()
    {
        Chaos.SkipUnlessEnabled();

        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
        var reader = new ElasticLogReader(http);

        var to = DateTimeOffset.UtcNow - IngestLag;
        var from = to - Ladder[^1];
        IReadOnlyList<LogRecord> records = [];

        foreach (var width in Ladder)
        {
            from = to - width;
            records = await reader.ReadRunRecordsAsync(
                Chaos.WorkflowId, from, to, TestContext.Current.CancellationToken);

            if (records.Count > 0)
            {
                break;
            }
        }

        Assert.True(records.Count > 0,
            $"no record of workflow {Chaos.WorkflowId} in the {Ladder[^1].TotalHours:0} hours before "
            + $"{to:o}. The reader reached the index and the index answered, so this is a statement "
            + "about the cluster rather than about the reader: nothing has driven that workflow for a "
            + "day.");

        Assert.All(records, r => Assert.False(string.IsNullOrEmpty(r.Template)));
        Assert.Contains(records, r => r.Template == Templates.EntryDispatched);
        Assert.All(records, r => Assert.InRange(r.Timestamp, from, to));
    }
}
