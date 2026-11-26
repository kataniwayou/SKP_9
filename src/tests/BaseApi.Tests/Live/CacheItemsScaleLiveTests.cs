using System.Diagnostics;
using System.Net;
using System.Text;
using System.Text.Json;
using BaseApi.Tests.Scale;
using Xunit;

namespace BaseApi.Tests.Live;

/// <summary>
/// Spec 7.1 S2 and S8 against the deployed BaseApi. Each test makes its own cache (<c>scale-</c> name and
/// root) and deletes it in a finally; no other cache is read or written. On demand: <c>SKP_SCALE=1</c> and
/// <c>SKP_REALSTACK=1</c>.
/// </summary>
[Trait("Category", RealStack.Category)]
[Trait("Category", ScaleGate.Category)]
public sealed class CacheItemsScaleLiveTests
{
    private static HttpClient NewClient() =>
        new() { BaseAddress = new Uri(RealStack.BaseApiUrl), Timeout = TimeSpan.FromMinutes(10) };

    private static async Task<Guid> CreateCacheAsync(HttpClient http, string tag, CancellationToken ct)
    {
        var run = Guid.NewGuid().ToString("N")[..10];
        var res = await http.PostAsJsonAsyncCompat("/api/v1/caches",
            new { name = $"scale-{tag}-{run}", version = "1.0.0", description = "scale test, deleted at the end", root = $"scale-{tag}-{run}" }, ct);
        res.EnsureSuccessStatusCode();
        using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync(ct));
        return doc.RootElement.GetProperty("id").GetGuid();
    }

    private static async Task<int> ItemCountAsync(HttpClient http, Guid id, CancellationToken ct)
    {
        var res = await http.GetAsync($"/api/v1/caches/{id}", ct);
        res.EnsureSuccessStatusCode();
        using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync(ct));
        return doc.RootElement.GetProperty("itemCount").GetInt32();
    }

    private static async Task DeleteQuietlyAsync(HttpClient http, Guid id)
    {
        if (id == Guid.Empty) return;
        try { await http.DeleteAsync($"/api/v1/caches/{id}"); } catch { /* a leftover scale- cache is visible and harmless */ }
    }

    /// <summary>A POST body of exactly <paramref name="bytes"/> ASCII bytes: items keyed s{n}, values padded.</summary>
    private static string BodyOfExactly(int bytes, string keyPrefix)
    {
        const string head = "{\"items\":[";
        const string tail = "]}";
        var sb = new StringBuilder(bytes + 64);
        sb.Append(head);
        var n = 0;
        var value = new string('x', ScaleData.ValueChars);
        // Whole items of fixed shape until fewer than ~1,200 bytes remain, then one item padded to land exactly.
        while (true)
        {
            var key = $"{keyPrefix}{n:D7}";
            var item = $"{{\"key\":\"{key}\",\"value\":\"{value}\"}}";
            var sep = n == 0 ? 0 : 1;
            var remaining = bytes - sb.Length - tail.Length;
            if (remaining < item.Length + sep + 1200)
            {
                // Last item: key + value sized so the whole body is exactly `bytes`.
                var fixedLen = sep + "{\"key\":\"".Length + key.Length + "\",\"value\":\"".Length + "\"}".Length;
                var valueLen = remaining - fixedLen;
                if (sep == 1) sb.Append(',');
                sb.Append($"{{\"key\":\"{key}\",\"value\":\"{new string('y', valueLen)}\"}}");
                break;
            }
            if (sep == 1) sb.Append(',');
            sb.Append(item);
            n++;
        }
        sb.Append(tail);
        Assert.Equal(bytes, Encoding.UTF8.GetByteCount(sb.ToString()));
        return sb.ToString();
    }

    private static async Task<HttpResponseMessage> PostItemsAsync(HttpClient http, Guid id, string body, CancellationToken ct) =>
        await http.PostAsync($"/api/v1/caches/{id}/items", new StringContent(body, Encoding.UTF8, "application/json"), ct);

    [Fact]
    public async Task S2_BodyJustUnderLimitAccepted_JustOverIs413()
    {
        ScaleGate.SkipUnlessLive();
        var ct = TestContext.Current.CancellationToken;
        using var http = NewClient();
        var id = Guid.Empty;
        try
        {
            id = await CreateCacheAsync(http, "s2", ct);

            var under = BodyOfExactly(29_990_000, "u");
            var sw = Stopwatch.StartNew();
            var ok = await PostItemsAsync(http, id, under, ct);
            var underMs = sw.ElapsedMilliseconds;
            Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
            var after = await ItemCountAsync(http, id, ct);
            Assert.True(after > 0);
            ScaleGate.Log($"S2 29,990,000-byte body: {(int)ok.StatusCode} in {underMs} ms, itemCount now {after}");

            var over = BodyOfExactly(30_000_100, "o");
            sw.Restart();
            var refused = await PostItemsAsync(http, id, over, ct);
            var overMs = sw.ElapsedMilliseconds;
            var afterRefused = await ItemCountAsync(http, id, ct);
            ScaleGate.Log($"S2 30,000,100-byte body: {(int)refused.StatusCode} in {overMs} ms, itemCount before {after} after {afterRefused}");
            Assert.Equal(HttpStatusCode.RequestEntityTooLarge, refused.StatusCode);
            Assert.Equal(after, afterRefused);
        }
        finally
        {
            await DeleteQuietlyAsync(http, id);
        }
    }

    [Fact]
    public async Task S8_ReadsAreSmall()
    {
        ScaleGate.SkipUnlessLive();
        var ct = TestContext.Current.CancellationToken;
        // 1,000,000 items as 20 appends of 50,000 by default. SKP_SCALE_S8_BATCH lowers the append size
        // (and raises the count) for a Postgres too small to take 25 MB in one statement.
        var size0 = int.TryParse(Environment.GetEnvironmentVariable("SKP_SCALE_S8_BATCH"), out var b) ? b : ScaleData.BatchSize;
        var batches = 1_000_000 / size0;
        using var http = NewClient();
        var id = Guid.Empty;
        try
        {
            id = await CreateCacheAsync(http, "s8", ct);
            var total = Stopwatch.StartNew();
            for (var i = 0; i < batches; i++)
            {
                var sw = Stopwatch.StartNew();
                var items = ScaleData.Items(i * size0, size0);
                var body = JsonSerializer.Serialize(new { items = items.Select(x => new { key = x.Key, value = x.Value }) });
                var res = await PostItemsAsync(http, id, body, ct);
                Assert.Equal(HttpStatusCode.OK, res.StatusCode);
                ScaleGate.Log($"S8 build batch {i + 1,2}/{batches}: {sw.ElapsedMilliseconds} ms, body {body.Length:N0} bytes");
            }
            ScaleGate.Log($"S8 built {batches * size0:N0} items over HTTP in {total.Elapsed.TotalSeconds:F0} s");

            var times = new List<long>();
            var size = 0;
            string json = "";
            for (var i = 0; i < 5; i++)
            {
                var sw = Stopwatch.StartNew();
                var res = await http.GetAsync($"/api/v1/caches/{id}", ct);
                var bytes = await res.Content.ReadAsByteArrayAsync(ct);
                times.Add(sw.ElapsedMilliseconds);
                Assert.Equal(HttpStatusCode.OK, res.StatusCode);
                size = bytes.Length;
                json = Encoding.UTF8.GetString(bytes);
            }
            using var doc = JsonDocument.Parse(json);
            Assert.Equal(batches * size0, doc.RootElement.GetProperty("itemCount").GetInt32());

            var listSw = Stopwatch.StartNew();
            var list = await http.GetAsync("/api/v1/caches", ct);
            var listBytes = (await list.Content.ReadAsByteArrayAsync(ct)).Length;
            var listMs = listSw.ElapsedMilliseconds;

            ScaleGate.Log($"S8 GET /caches/{{id}} on the {batches * size0:N0}-item cache: {size} bytes, ms per call [{string.Join(", ", times)}]");
            ScaleGate.Log($"S8 GET /caches (all caches): {listBytes} bytes, {listMs} ms");
            Assert.True(size < 4096, $"GET /caches/{{id}} returned {size} bytes");
        }
        finally
        {
            var sw = Stopwatch.StartNew();
            await DeleteQuietlyAsync(http, id);
            ScaleGate.Log($"S8 DELETE of the scale cache over HTTP: {sw.ElapsedMilliseconds} ms");
        }
    }
}

internal static class HttpJsonCompat
{
    public static Task<HttpResponseMessage> PostAsJsonAsyncCompat(this HttpClient http, string url, object body, CancellationToken ct) =>
        http.PostAsync(url, new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json"), ct);
}
