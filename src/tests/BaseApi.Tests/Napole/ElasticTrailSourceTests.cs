using System.Net;
using System.Text;
using System.Text.Json;
using BaseProcessor.Core.Processing;
using Messaging.Contracts;
using Microsoft.Extensions.Options;
using Processor.Napole;
using Xunit;

namespace BaseApi.Tests.Napole;

public sealed class ElasticTrailSourceTests
{
    private static readonly Guid Good = Guid.Parse("09f6b055-c309-5ffb-aaa1-ee5d165d39ca");
    private static readonly Guid BadExt = Guid.Parse("11cfa200-ccc2-56c1-a32f-da781e1f13d6");
    private static readonly TimeSpan Trail = TimeSpan.FromMinutes(10);

    private static readonly WatchedSection Section = new(
        NapoleProcessorTests.Watched, NapoleProcessorTests.FromStep, NapoleProcessorTests.ToStep);

    // The answer's shape, as the live cluster returned the statement on 2026-11-09.
    private const string Columns = """
        [{"name":"attributes.ExecutionId","type":"keyword"},{"name":"roots","type":"long"},{"name":"openBranches","type":"long"},
         {"name":"failed","type":"long"},{"name":"cancelled","type":"long"},{"name":"reached","type":"long"}]
        """;

    private static string Answer(params string[] rows) => $$"""{"columns":{{Columns}},"values":[{{string.Join(",", rows)}}]}""";

    private static string Ids(params Guid[] ids)
        => Answer([.. ids.Select(i => $"""["{i}",1,0,0,0,1]""")]);

    private static ElasticTrailSource Source(HttpMessageHandler handler, string baseUrl = "http://es.test")
        => new(new HttpClient(handler), Options.Create(new NapoleOptions { ElasticBaseUrl = baseUrl }));

    private static Task<IReadOnlyList<ExecutionTrail>> Read(ElasticTrailSource source)
        => source.ReadAsync(Section, ReportBuilderTests.Window, Trail, TestContext.Current.CancellationToken);

    [Fact]
    public async Task ItPostsOneStatementWithTheSectionAsParams()
    {
        var handler = new ScriptedHandler(Ids(Good));

        await Read(Source(handler));

        var request = Assert.Single(handler.Requests);
        Assert.Equal("/_query?allow_partial_results=false", request.Path);

        var body = JsonDocument.Parse(request.Body).RootElement;
        Assert.Equal(
            [$"workflow={NapoleProcessorTests.Watched}", "trailFrom=2026-11-08T10:30:00.000Z", "trailTo=2026-11-08T11:00:00.000Z",
             $"root={OutcomeTemplates.EntryCompleted}", $"advanced={OutcomeTemplates.Advanced}",
             $"branchEnds={OutcomeTemplates.BranchEnds}", $"advancedAnyway={OutcomeTemplates.AdvancedAnyway}",
             $"fromStep={NapoleProcessorTests.FromStep}", $"toStep={NapoleProcessorTests.ToStep}",
             "from=2026-11-08T10:40:00.000Z", "to=2026-11-08T10:50:00.000Z"],
            Params(body));

        var query = body.GetProperty("query").GetString()!;
        Assert.Contains("INLINE STATS", query, StringComparison.Ordinal);
        Assert.DoesNotContain("kafka-importer", query, StringComparison.Ordinal);
        Assert.DoesNotContain("Record", query, StringComparison.Ordinal);
    }

    [Fact]
    public async Task TheStepOutcomeTemplatesTravelAsParams()
    {
        // The outcome is read by exact equality on the orchestrator's templates, so they come from the
        // contract constants and are never spliced into the statement as text.
        var handler = new ScriptedHandler(Ids(Good));

        await Read(Source(handler));

        var query = JsonDocument.Parse(Assert.Single(handler.Requests).Body).RootElement.GetProperty("query").GetString()!;
        Assert.DoesNotContain("the entry step completed", query, StringComparison.Ordinal);
        Assert.DoesNotContain("advanced {SuccessorCount}", query, StringComparison.Ordinal);
        Assert.DoesNotContain("advancing", query, StringComparison.Ordinal);
        Assert.DoesNotContain("no successor accepts it", query, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ItReadsTheTrailsBack()
    {
        // The good file reaches split-exporter on both branches; the bad extension fails at the fetcher.
        var handler = new ScriptedHandler(Answer($"""["{Good}",1,0,0,0,2]""", $"""["{BadExt}",1,0,1,0,0]"""));

        var trails = await Read(Source(handler));

        Assert.Equal(
            [new ExecutionTrail(Good, Roots: 1, OpenBranches: 0, Failed: 0, Cancelled: 0, Reached: 2),
             new ExecutionTrail(BadExt, Roots: 1, OpenBranches: 0, Failed: 1, Cancelled: 0, Reached: 0)],
            trails);
        Assert.Equal([RoundTrip.Complete, RoundTrip.Failed], trails.Select(RoundTripRules.Decide));
    }

    [Fact]
    public async Task ItReadsRowsByColumnName()
    {
        const string shuffled = """
            [{"name":"reached","type":"long"},{"name":"cancelled","type":"long"},{"name":"failed","type":"long"},
             {"name":"openBranches","type":"long"},{"name":"roots","type":"long"},{"name":"attributes.ExecutionId","type":"keyword"}]
            """;
        var handler = new ScriptedHandler($$"""{"columns":{{shuffled}},"values":[[1,0,0,1,1,"{{Good}}"]]}""");

        var trail = Assert.Single(await Read(Source(handler)));

        Assert.Equal(new ExecutionTrail(Good, Roots: 1, OpenBranches: 1, Failed: 0, Cancelled: 0, Reached: 1), trail);
    }

    [Fact]
    public async Task AnEmptyAnswerIsNoTrails()
    {
        var handler = new ScriptedHandler(Answer());

        Assert.Empty(await Read(Source(handler)));
    }

    [Fact]
    public async Task APartialAnswerFails()
    {
        var body = Ids(Good).Insert(1, "\"is_partial\":true,");

        await Assert.ThrowsAsync<FailedException>(() => Read(Source(new ScriptedHandler(body))));
    }

    [Fact]
    public async Task AnAnswerAtTheRowLimitFails()
    {
        // 10,000 rows is what a truncated answer looks like; counting it would under-report silently.
        var ids = Enumerable.Range(0, TrailRecords.RowLimit).Select(_ => Guid.NewGuid()).ToArray();

        var ex = await Assert.ThrowsAsync<FailedException>(() => Read(Source(new ScriptedHandler(Ids(ids)))));

        Assert.Contains("10000", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ANon2xxFails()
    {
        var handler = new ScriptedHandler("""{"error":"boom"}""") { Status = HttpStatusCode.InternalServerError };

        var ex = await Assert.ThrowsAsync<FailedException>(() => Read(Source(handler)));

        Assert.Contains("500", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnUnreachableClusterFails()
    {
        var handler = new ScriptedHandler { Throw = new HttpRequestException("connection refused") };

        await Assert.ThrowsAsync<FailedException>(() => Read(Source(handler)));
    }

    [Fact]
    public async Task ATimeoutFails()
    {
        var handler = new ScriptedHandler { Throw = new TaskCanceledException("timed out") };

        await Assert.ThrowsAsync<FailedException>(() => Read(Source(handler)));
    }

    [Fact]
    public async Task AMalformedBaseUrlFailsWhenRead()
    {
        var source = Source(new ScriptedHandler(Answer()), baseUrl: "not a url");

        await Assert.ThrowsAsync<FailedException>(() => Read(source));
    }

    private static string[] Params(JsonElement body)
        => [.. body.GetProperty("params").EnumerateArray()
            .SelectMany(p => p.EnumerateObject())
            .Select(p => $"{p.Name}={p.Value.GetString()}")];

    /// <summary>Answers the i-th request with the i-th body, recording every request.</summary>
    private sealed class ScriptedHandler(params string[] bodies) : HttpMessageHandler
    {
        internal List<(string Path, string Body)> Requests { get; } = [];

        internal HttpStatusCode Status { get; init; } = HttpStatusCode.OK;

        internal Exception? Throw { get; init; }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            if (Throw is not null)
            {
                throw Throw;
            }

            var index = Requests.Count;
            Requests.Add((
                request.RequestUri?.PathAndQuery ?? string.Empty,
                request.Content is null ? string.Empty : await request.Content.ReadAsStringAsync(ct)));

            Assert.True(index < bodies.Length, $"unexpected request #{index + 1}: only {bodies.Length} responses were scripted");
            return new HttpResponseMessage(Status) { Content = new StringContent(bodies[index], Encoding.UTF8, "application/json") };
        }
    }
}
