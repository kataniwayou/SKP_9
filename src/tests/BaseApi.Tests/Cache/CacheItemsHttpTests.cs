using System.Net;
using System.Text.Json;
using Asp.Versioning;
using BaseApi.Core.Exceptions.Handlers;
using BaseApi.Service;
using BaseApi.Service.Features.Cache;
using BaseApi.Tests.Support;
using Messaging.Transport;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Xunit;

namespace BaseApi.Tests.Cache;

/// <summary>
/// The items read over a real HTTP pipeline (Kestrel on a loopback port, the real <see cref="CachesController"/>,
/// MVC model binding, the validation exception handler), because binding decides what the service sees: an
/// empty <c>?from=</c> must reach the service as an empty string, not null. The host is minimal (no broker,
/// no Redis); only the cache service is real, over the Postgres fixture.
/// </summary>
[Collection("Postgres")]
public sealed class CacheItemsHttpTests(PostgresFixture fixture)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private sealed class NullSender : IQueueSender
    {
        public Task SendAsync<T>(string queue, string type, T body, CancellationToken ct,
            string? replyTo = null, string? correlationId = null) => Task.CompletedTask;
    }

    private async Task<(WebApplication App, HttpClient Client, Guid Id)> StartAsync()
    {
        PostgresFixture.SkipUnlessEnabled();
        var db = fixture.NewContext();
        var cache = new CacheEntity { Name = "c", Version = "1.0.0", Root = $"r-{Guid.NewGuid():N}" };
        db.Set<CacheEntity>().Add(cache);
        await db.SaveChangesAsync(Ct);
        var service = CacheServiceFactory.Create(db, new NullSender());
        await service.AppendItemsAsync(cache.Id, new CacheItemsAppendDto(
            "abcdefghij".Select(c => new CacheItemDto(c.ToString(), "v")).ToList()), Ct);

        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        builder.Services.AddSingleton(service);
        builder.Services.AddControllers().AddApplicationPart(typeof(CachesController).Assembly);
        builder.Services.AddApiVersioning().AddMvc();
        builder.Services.AddProblemDetails();
        builder.Services.AddExceptionHandler<ValidationExceptionHandler>();
        var app = builder.Build();
        app.UseExceptionHandler();
        app.MapControllers();
        await app.StartAsync(Ct);

        var address = app.Urls.First();
        return (app, new HttpClient { BaseAddress = new Uri(address) }, cache.Id);
    }

    private static async Task<string> ErrorsAsync(HttpResponseMessage r)
    {
        using var doc = JsonDocument.Parse(await r.Content.ReadAsStringAsync(Ct));
        return doc.RootElement.GetProperty("errors").GetRawText();
    }

    [Fact]
    public async Task FromOverHttpReturnsIndexPrevAndMatchInCamelCase()
    {
        var (app, client, id) = await StartAsync();
        await using var _ = app;
        using var __ = client;

        var r = await client.GetAsync($"/api/v1/caches/{id}/items?from=d&limit=3", Ct);

        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        using var doc = JsonDocument.Parse(await r.Content.ReadAsStringAsync(Ct));
        Assert.Equal(3, doc.RootElement.GetProperty("index").GetInt64());
        Assert.Equal("d", doc.RootElement.GetProperty("prev").GetString());
        Assert.Equal("exact", doc.RootElement.GetProperty("fromMatch").GetString());
        Assert.Equal("f", doc.RootElement.GetProperty("next").GetString());
    }

    [Theory]
    [InlineData("from")]
    [InlineData("before")]
    public async Task AnEmptyAnchorOverHttpIsA400(string which)
    {
        var (app, client, id) = await StartAsync();
        await using var _ = app;
        using var __ = client;

        var r = await client.GetAsync($"/api/v1/caches/{id}/items?{which}=", Ct);

        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
        Assert.Contains($"{which} must not be empty", await ErrorsAsync(r));
    }

    [Fact]
    public async Task TwoAnchorsOverHttpIsA400()
    {
        var (app, client, id) = await StartAsync();
        await using var _ = app;
        using var __ = client;

        var r = await client.GetAsync($"/api/v1/caches/{id}/items?after=a&before=b", Ct);

        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
        Assert.Contains("give at most one of after, from, before", await ErrorsAsync(r));
    }
}
