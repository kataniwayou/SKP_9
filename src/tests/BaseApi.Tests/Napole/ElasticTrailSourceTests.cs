using System.Net;
using System.Text;
using System.Text.Json;
using BaseProcessor.Core.Processing;
using Microsoft.Extensions.Options;
using Processor.Napole;
using Xunit;

namespace BaseApi.Tests.Napole;

public sealed class ElasticTrailSourceTests
{
    private static readonly Guid Workflow = Guid.Parse("8cfdbcdb-a7e0-4a7d-9b4d-e4120ccacf02");
    private static readonly Guid Good = Guid.Parse("09f6b055-c309-5ffb-aaa1-ee5d165d39ca");
    private static readonly Guid BadExt = Guid.Parse("11cfa200-ccc2-56c1-a32f-da781e1f13d6");
    private static readonly TimeSpan Trail = TimeSpan.FromMinutes(10);

    // The response shapes, as the live cluster answered the two statements on 2026-11-08.
    private static string Ids(params Guid[] ids) => JsonSerializer.Serialize(new
    {
        columns = new[] { new { name = "attributes.ExecutionId", type = "keyword" } },
        values = ids.Select(i => new object[] { i.ToString("D") }),
    });

    private const string BColumns = """
        [{"name":"imports","type":"long"},{"name":"terminals","type":"long"},{"name":"failed","type":"long"},
         {"name":"cancelled","type":"long"},{"name":"openBranches","type":"long"},{"name":"attributes.ExecutionId","type":"keyword"}]
        """;

    private static string Trails(params string[] rows) => $$"""{"columns":{{BColumns}},"values":[{{string.Join(",", rows)}}]}""";

    private static ElasticTrailSource Source(HttpMessageHandler handler, string baseUrl = "http://es.test")
        => new(new HttpClient(handler), Options.Create(new NapoleOptions { ElasticBaseUrl = baseUrl }));

    private static Task<IReadOnlyList<ExecutionTrail>> Read(ElasticTrailSource source)
        => source.ReadAsync(Workflow, ReportBuilderTests.Window, Trail, TestContext.Current.CancellationToken);

    [Fact]
    public async Task ItPostsBothStatementsWithTheWindowAsParams()
    {
        var handler = new ScriptedHandler(Ids(Good, BadExt), Trails(
            $"""[1,2,0,0,0,"{Good}"]""", $"""[1,1,1,0,0,"{BadExt}"]"""));

        await Read(Source(handler));

        Assert.Equal(2, handler.Requests.Count);
        Assert.All(handler.Requests, r => Assert.Equal("/_query?allow_partial_results=false", r.Path));

        var a = JsonDocument.Parse(handler.Requests[0].Body).RootElement;
        Assert.Equal(
            [$"workflow={Workflow}", "from=2026-11-08T10:40:00.000Z", "to=2026-11-08T10:50:00.000Z"],
            Params(a));
        Assert.Contains("\"kafka-importer\"", a.GetProperty("query").GetString(), StringComparison.Ordinal);

        var b = JsonDocument.Parse(handler.Requests[1].Body).RootElement;
        Assert.Equal(
            [$"workflow={Workflow}", "trailFrom=2026-11-08T10:30:00.000Z", "trailTo=2026-11-08T11:00:00.000Z"],
            Params(b));
        Assert.Contains($"\"{Good}\"", b.GetProperty("query").GetString(), StringComparison.Ordinal);
        Assert.Contains($"\"{BadExt}\"", b.GetProperty("query").GetString(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task ItReadsTheTrailsBack()
    {
        var handler = new ScriptedHandler(Ids(Good, BadExt), Trails(
            $"""[1,2,0,0,0,"{Good}"]""", $"""[1,1,1,0,0,"{BadExt}"]"""));

        var trails = await Read(Source(handler));

        Assert.Equal(
            [new ExecutionTrail(Good, 1, 0, 2, 0, 0), new ExecutionTrail(BadExt, 1, 0, 1, 1, 0)],
            trails.OrderBy(t => t.ExecutionId == Good ? 0 : 1));
    }

    [Fact]
    public async Task ItReadsRowsByColumnName()
    {
        const string shuffled = """
            [{"name":"attributes.ExecutionId","type":"keyword"},{"name":"openBranches","type":"long"},{"name":"cancelled","type":"long"},
             {"name":"failed","type":"long"},{"name":"terminals","type":"long"},{"name":"imports","type":"long"}]
            """;
        var handler = new ScriptedHandler(Ids(Good), $$"""{"columns":{{shuffled}},"values":[["{{Good}}",1,0,0,1,1]]}""");

        var trail = Assert.Single(await Read(Source(handler)));

        Assert.Equal(new ExecutionTrail(Good, Imports: 1, OpenBranches: 1, Terminals: 1, Failed: 0, Cancelled: 0), trail);
    }

    [Fact]
    public async Task AnIdBHasNoRowForComesBackWithNoImports()
    {
        var handler = new ScriptedHandler(Ids(Good, BadExt), Trails($"""[1,2,0,0,0,"{Good}"]"""));

        var trails = await Read(Source(handler));

        Assert.Equal(new ExecutionTrail(BadExt, 0, 0, 0, 0, 0), Assert.Single(trails, t => t.ExecutionId == BadExt));
    }

    [Fact]
    public async Task NoImportsSendsOnlyTheFirstStatement()
    {
        var handler = new ScriptedHandler(Ids());

        Assert.Empty(await Read(Source(handler)));
        Assert.Single(handler.Requests);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    public async Task APartialAnswerFails(int which)
    {
        var bodies = new[] { Ids(Good), Trails($"""[1,2,0,0,0,"{Good}"]""") };
        bodies[which] = bodies[which].Insert(1, "\"is_partial\":true,");

        await Assert.ThrowsAsync<FailedException>(() => Read(Source(new ScriptedHandler(bodies))));
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
        var source = Source(new ScriptedHandler(Ids()), baseUrl: "not a url");

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
