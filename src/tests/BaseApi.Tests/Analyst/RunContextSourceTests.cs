using System.Net;
using System.Text;
using Processor.Analyst.Graph;
using Xunit;

namespace BaseApi.Tests.Analyst;

public sealed class RunContextSourceTests
{
    private static readonly Guid W = Guid.Parse("1a56b3ca-e276-4815-87fa-5c2f48ab6dad");
    private static readonly DateTimeOffset Now = new(2026, 10, 3, 7, 25, 0, TimeSpan.Zero);

    private static string Esql(string columns, string values)
        => $$"""{"columns":{{columns}},"values":{{values}}}""";

    private const string StartCols = """[{"name":"last_start","type":"date"},{"name":"last_stop","type":"date"}]""";
    private const string DeployCols = """[{"name":"replicas","type":"long"},{"name":"minute","type":"date"}]""";

    private static ElasticRunContextSource Source(params string[] bodies)
        => new(new HttpClient(new Sequenced(bodies)) { BaseAddress = new Uri("http://elasticsearch:9200") });

    [Fact]
    public async Task TheStartIsTheLatestAcceptedStartAndDeploysFollowIt()
    {
        var ctx = await Source(
            Esql(StartCols, """[["2026-10-02T12:51:47.310Z","2026-10-02T12:51:44.090Z"]]"""),
            Esql(DeployCols, """[[3,"2026-10-02T12:51:00.000Z"],[2,"2026-10-02T14:14:00.000Z"],[3,"2026-10-02T22:43:00.000Z"]]"""))
            .ReadAsync(W, Now, CancellationToken.None);

        Assert.Equal(DateTimeOffset.Parse("2026-10-02T12:51:47.310Z"), ctx.Start);
        Assert.Equal(ctx.Start, ctx.HistoryLimit);
        Assert.Null(ctx.Unavailable);
        // The activation in the start's own minute is the start, not a deploy.
        Assert.Equal(
            [DateTimeOffset.Parse("2026-10-02T14:14:00Z"), DateTimeOffset.Parse("2026-10-02T22:43:00Z")],
            ctx.Deploys.Select(d => d.Minute));
    }

    [Fact]
    public async Task AStopAfterTheLatestStartMeansTheWorkflowIsNotRunning()
    {
        var ctx = await Source(Esql(StartCols, """[["2026-10-02T12:51:47Z","2026-10-02T13:00:00Z"]]"""))
            .ReadAsync(W, Now, CancellationToken.None);

        Assert.Null(ctx.HistoryLimit);
        Assert.Contains("stopped", ctx.Unavailable, StringComparison.Ordinal);
    }

    [Fact]
    public async Task NoStartWithinRetentionMeansHistoryIsUnavailable()
    {
        var ctx = await Source(Esql(StartCols, "[[null,null]]")).ReadAsync(W, Now, CancellationToken.None);

        Assert.Null(ctx.HistoryLimit);
        Assert.Contains("no start", ctx.Unavailable, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AStartOlderThanThirtyDaysIsCappedAtThirtyDays()
    {
        var ctx = await Source(
            Esql(StartCols, """[["2026-08-01T00:00:00Z",null]]"""),
            Esql(DeployCols, "[]"))
            .ReadAsync(W, Now, CancellationToken.None);

        Assert.Equal(Now - ElasticRunContextSource.MaxHistory, ctx.HistoryLimit);
    }

    [Fact]
    public async Task AnUnreachableStoreIsHistoryUnavailableNotAnException()
    {
        var ctx = await new ElasticRunContextSource(
                new HttpClient(new Failing()) { BaseAddress = new Uri("http://elasticsearch:9200") })
            .ReadAsync(W, Now, CancellationToken.None);

        Assert.Null(ctx.HistoryLimit);
        Assert.Contains("could not be read", ctx.Unavailable, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ADeployRowWithoutAMinuteIsSkipped()
    {
        var ctx = await Source(
            Esql(StartCols, """[["2026-10-02T12:51:47Z",null]]"""),
            Esql(DeployCols, """[[1,null],[2,"2026-10-02T14:14:00.000Z"]]"""))
            .ReadAsync(W, Now, CancellationToken.None);

        Assert.Null(ctx.Unavailable);
        Assert.Equal(DateTimeOffset.Parse("2026-10-02T12:51:47Z"), ctx.Start);
        Assert.Equal([DateTimeOffset.Parse("2026-10-02T14:14:00Z")], ctx.Deploys.Select(d => d.Minute));
    }

    private sealed class Sequenced(params string[] bodies) : HttpMessageHandler
    {
        private int _next;

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
            => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(bodies[_next++], Encoding.UTF8, "application/json"),
            });
    }

    private sealed class Failing : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
            => throw new HttpRequestException("connection refused");
    }
}
