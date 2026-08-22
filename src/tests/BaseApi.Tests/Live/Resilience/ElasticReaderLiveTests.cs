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
    [Fact]
    public async Task TheReaderProjectsRecordsFromTheLiveIndex()
    {
        Chaos.SkipUnlessEnabled();

        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
        var reader = new ElasticLogReader(http);

        var to = DateTimeOffset.UtcNow;
        var from = to - TimeSpan.FromDays(7);

        var records = await reader.ReadRunRecordsAsync(Chaos.WorkflowId, from, to, TestContext.Current.CancellationToken);

        Assert.NotEmpty(records);
        Assert.All(records, r => Assert.False(string.IsNullOrEmpty(r.Template)));
        Assert.Contains(records, r => r.Template == Templates.EntryDispatched);
        Assert.All(records, r => Assert.InRange(r.Timestamp, from, to));
    }
}
