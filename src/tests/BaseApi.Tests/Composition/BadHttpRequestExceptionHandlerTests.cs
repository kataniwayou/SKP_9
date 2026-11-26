using BaseApi.Service.Composition;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Xunit;

namespace BaseApi.Tests.Composition;

public sealed class BadHttpRequestExceptionHandlerTests
{
    private sealed class Capture : IProblemDetailsService
    {
        public ProblemDetails? Problem;
        public ValueTask WriteAsync(ProblemDetailsContext context) { Problem = context.ProblemDetails; return ValueTask.CompletedTask; }
        public ValueTask<bool> TryWriteAsync(ProblemDetailsContext context) { Problem = context.ProblemDetails; return ValueTask.FromResult(true); }
    }

    private static BadHttpRequestException Make(int status) =>
        new("Request body too large. The max request body size is 30000000 bytes.", status);

    [Fact]
    public async Task A413IsMappedTo413WithTheLimitInTheDetail()
    {
        var pd = new Capture();
        var ctx = new DefaultHttpContext();
        var claimed = await new BadHttpRequestExceptionHandler(pd).TryHandleAsync(ctx, Make(413), TestContext.Current.CancellationToken);

        Assert.True(claimed);
        Assert.Equal(413, ctx.Response.StatusCode);
        Assert.Equal(413, pd.Problem!.Status);
        Assert.Equal("Request body too large", pd.Problem.Title);
        Assert.Contains("30,000,000", pd.Problem.Detail);
    }

    [Fact]
    public async Task AnyOtherBadRequestKeepsItsOwnStatus()
    {
        var pd = new Capture();
        var ctx = new DefaultHttpContext();
        Assert.True(await new BadHttpRequestExceptionHandler(pd).TryHandleAsync(ctx, Make(408), TestContext.Current.CancellationToken));
        Assert.Equal(408, ctx.Response.StatusCode);
        Assert.Equal(408, pd.Problem!.Status);
    }

    [Fact]
    public async Task OtherExceptionsAreNotClaimed()
    {
        var pd = new Capture();
        Assert.False(await new BadHttpRequestExceptionHandler(pd).TryHandleAsync(new DefaultHttpContext(), new InvalidOperationException(), TestContext.Current.CancellationToken));
        Assert.Null(pd.Problem);
    }
}
