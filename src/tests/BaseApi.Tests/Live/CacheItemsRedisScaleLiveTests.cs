using System.Diagnostics;
using System.Net;
using System.Text;
using System.Text.Json;
using BaseApi.Service.Features.Cache;
using BaseApi.Tests.Scale;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Messaging.Transport;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using StackExchange.Redis;
using Xunit;

namespace BaseApi.Tests.Live;

/// <summary>
/// Spec 7.2 R1-R5 and the window for R7, against the deployed BaseApi, Postgres, RabbitMQ and Redis. One scale
/// cache (<c>scale-r-</c> name and root) of 1,000,000 items is built over HTTP and bound to a new
/// <c>scale-r-</c> workflow (one step on a live processor, no cron, so it activates and never dispatches).
/// Nothing else is bound, started or edited; everything is deleted in the finally.
/// <para>
/// The phases run in order inside one test because each builds on the last one's state (the 1M cache is
/// expensive). Each phase records its own PASS/FAIL line; the test fails at the end if any failed, so one
/// failure does not hide the next phase's numbers. R5 restarts Redis, which the test cannot do: it writes
/// <c>R5_READY</c> into <c>SKP_SCALE_HANDSHAKE_DIR</c> and waits for <c>R5_GO</c> (the operator restarts the
/// Redis statefulset, re-opens the port-forward, then creates the file). Without the directory R5 is skipped.
/// </para>
/// <b>R1-R5 need raised memory on the dev cluster</b> (BaseApi well above its 512Mi limit and Redis above its 144 MB maxmemory): a
/// million-item start does not fit the defaults; see <c>src/Acto/e2e/regression/BIG-CACHE-REPORT.md</c>. Do not run it on the stock limits.
/// On demand: <c>SKP_SCALE=1</c> and <c>SKP_REALSTACK=1</c>.
/// </summary>
[Trait("Category", RealStack.Category)]
[Trait("Category", ScaleGate.Category)]
public sealed class CacheItemsRedisScaleLiveTests
{
    private const int Total = 1_000_000;
    private static readonly TimeSpan Budget = TimeSpan.FromMinutes(10);
    private readonly List<string> _verdicts = [];

    private static HttpClient NewClient() =>
        new() { BaseAddress = new Uri(RealStack.BaseApiUrl), Timeout = TimeSpan.FromMinutes(10) };

    private void Verdict(string name, bool pass, string numbers)
    {
        var line = $"{name} {(pass ? "PASS" : "FAIL")}: {numbers}";
        _verdicts.Add(pass ? "" : line);
        ScaleGate.Log(line);
    }

    [Fact]
    public async Task R1_to_R5_RedisProjectionAtAMillionItems()
    {
        ScaleGate.SkipUnlessLive();
        var ct = TestContext.Current.CancellationToken;
        using var http = NewClient();
        var run = Guid.NewGuid().ToString("N")[..8];
        var root = $"scale-r-{run}";
        Guid cache = Guid.Empty, step = Guid.Empty, workflow = Guid.Empty;
        ConnectionMultiplexer? redis = null;
        var windowStart = DateTime.UtcNow;
        try
        {
            redis = await ConnectRedisAsync();
            // A live processor with no config schema (so the start's payload gate asks for nothing): the step is never dispatched.
            var processor = Guid.TryParse(Environment.GetEnvironmentVariable("SKP_SCALE_PROCESSOR"), out var p) ? p : await FindLiveProcessorAsync(redis);

            cache = await CreateAsync(http, "caches",
                new { name = $"scale-r-cache-{run}", version = "1.0.0", description = "scale run, deleted at the end", root, items = Array.Empty<object>() }, ct);
            step = await CreateAsync(http, "steps",
                new { name = $"scale-r-step-{run}", version = "1.0.0", description = (string?)null, processorId = processor, nextStepIds = Array.Empty<Guid>(), entryCondition = 4 }, ct);
            workflow = await CreateAsync(http, "workflows",
                new { name = $"scale-r-wf-{run}", version = "1.0.0", description = (string?)null, entryStepIds = new[] { step }, assignmentIds = Array.Empty<Guid>(), cacheIds = new[] { cache } }, ct);
            ScaleGate.Log($"setup cache {cache} root {root}, step {step}, workflow {workflow}, processor {processor}");

            var build = Stopwatch.StartNew();
            for (var i = 0; i < ScaleData.Batches; i++)
                await AppendAsync(http, cache, ScaleData.Items(i * ScaleData.BatchSize, ScaleData.BatchSize), ct);
            ScaleGate.Log($"built {Total:N0} items over HTTP in {build.Elapsed.TotalSeconds:F0} s; itemCount {await ItemCountAsync(http, cache, ct)}");

            var keySet = (RedisKey)L2ProjectionKeys.CacheKeySet(workflow, root);
            var prefix = L2ProjectionKeys.Cache(workflow, root);

            // ---------------- R1 ----------------
            var startBytes = JsonSerializer.SerializeToUtf8Bytes(new StartOrchestration(new WorkflowL1(
                workflow, [step],
                [new StepL1(step, 4, processor, string.Empty, [])],
                [],
                new Dictionary<Guid, string>
                {
                    [workflow] = EntityNames.Format($"scale-r-wf-{run}", "1.0.0", workflow),
                    [step] = EntityNames.Format($"scale-r-step-{run}", "1.0.0", step),
                },
                null,
                [new CacheRefL1(cache, root)])), MessagingJson.Options).Length;

            var sw = Stopwatch.StartNew();
            await StartAsync(http, workflow, ct);
            var accepted = sw.ElapsedMilliseconds;
            await WaitCardAsync(redis, keySet, Total);
            var r1CardMs = sw.ElapsedMilliseconds;
            // SCARD is full early (the key set is written before the entries); the start is complete when the
            // handler adds the workflow to the live set, which it does only after the whole write returned.
            await WaitLiveAsync(redis, workflow);
            var r1Ms = sw.ElapsedMilliseconds;
            var scard = await redis.GetDatabase().SetLengthAsync(keySet);
            Verdict("R1", startBytes < 8192 && scard == Total,
                $"start message {startBytes} bytes (serialized WorkflowL1 of this workflow's shape with MessagingJson.Options); start accepted in {accepted} ms, SCARD {scard:N0} (first full after {r1CardMs} ms); workflow live, i.e. start complete, after {r1Ms} ms ({r1Ms / 1000.0:F1} s)");
            await CompareAsync("R1 compare", http, redis, cache, workflow, root, prefix, keySet, ct, r => _ = r);

            // ---------------- R2 ----------------
            // 40,000 new keys (a-prefix) + 10,000 existing keys overwritten with different values.
            var batch = ScaleData.Items(0, 40_000, 'a');
            for (var n = 0; n < 10_000; n++) batch.Add(new(ScaleData.Key(n), ScaleData.Value(n + 9_000_000)));
            sw.Restart();
            await AppendAsync(http, cache, batch, ct);
            var r2Post = sw.ElapsedMilliseconds;
            await WaitCardAsync(redis, keySet, Total + 40_000);
            await WaitValueAsync(redis, $"{prefix}:{ScaleData.Key(9_999)}", ScaleData.Value(9_999 + 9_000_000));
            var r2Ms = sw.ElapsedMilliseconds;
            var r2Bad = await CheckTouchedAsync(redis, prefix, batch.Select(i => (i.Key, (string?)i.Value)).ToList());
            Verdict("R2", r2Bad == 0,
                $"append of 50,000 (40,000 new + 10,000 overwritten): POST {r2Post} ms, Redis converged {r2Ms} ms after the POST started ({r2Ms - r2Post} ms after it returned); touched keys wrong in Redis: {r2Bad}; SCARD {await redis.GetDatabase().SetLengthAsync(keySet):N0}");

            // ---------------- R3 ----------------
            var gone = Enumerable.Range(10_000, 50_000).Select(n => ScaleData.Key(n)).ToList();
            sw.Restart();
            var removed = await RemoveAsync(http, cache, gone, ct);
            var r3Post = sw.ElapsedMilliseconds;
            await WaitCardAsync(redis, keySet, Total + 40_000 - 50_000);
            var r3Ms = sw.ElapsedMilliseconds;
            var r3Bad = await CheckTouchedAsync(redis, prefix, gone.Select(k => (k, (string?)null)).ToList());
            Verdict("R3", r3Bad == 0 && removed == 50_000,
                $"remove 50,000 keys: BaseApi removed {removed:N0}, POST {r3Post} ms, Redis converged {r3Ms} ms after the POST started; entries or set members still present: {r3Bad}; SCARD {await redis.GetDatabase().SetLengthAsync(keySet):N0}");
            var windowEnd = DateTime.UtcNow;
            ScaleGate.Log($"R7 window (UTC) {windowStart:O} .. {windowEnd:O}");

            // ---------------- R4 ----------------
            await using var connection = new RabbitMqConnection(Options.Create(new RabbitMqOptions
            {
                Host = RealStack.RabbitHost, Port = (ushort)RealStack.RabbitPort, Username = "guest", Password = "guest",
            }), Array.Empty<IRabbitMqTopology>(), NullLogger<RabbitMqConnection>.Instance);
            await using var sender = new QueueSender(connection, NullLogger<QueueSender>.Instance);

            // (a) Redis made wrong by hand for 2,000 keys; the same refresh published twice must fix it.
            var db = redis.GetDatabase();
            var stale = Enumerable.Range(100_000, 2_000).Select(n => ScaleData.Key(n)).ToList();
            foreach (var k in stale) await db.StringSetAsync($"{prefix}:{k}", "STALE");
            var msg = new RefreshCacheItems(cache, stale);
            await sender.SendAsync(OrchestratorQueues.Control, MessageTypes.RefreshCacheItems, msg, ct);
            await sender.SendAsync(OrchestratorQueues.Control, MessageTypes.RefreshCacheItems, msg, ct);

            // (b) a newer edit, then the "older" refresh for those keys arrives after it (keys only, so it re-reads the row).
            var edited = Enumerable.Range(200_000, 3_000).Select(n => new CacheItemDto(ScaleData.Key(n), "newer-" + n)).ToList();
            await AppendAsync(http, cache, edited, ct);
            await sender.SendAsync(OrchestratorQueues.Control, MessageTypes.RefreshCacheItems,
                new RefreshCacheItems(cache, edited.Select(e => e.Key).ToList()), ct);
            // (c) a removed key refreshed again after its removal, and a key that never existed.
            await sender.SendAsync(OrchestratorQueues.Control, MessageTypes.RefreshCacheItems,
                new RefreshCacheItems(cache, [.. gone.Take(1_000), "zz-never-existed"]), ct);
            await sender.SendAsync(OrchestratorQueues.Control, MessageTypes.RefreshCacheItems, msg, ct);
            await Task.Delay(TimeSpan.FromSeconds(20), ct);
            await CompareAsync("R4", http, redis, cache, workflow, root, prefix, keySet, ct,
                r => Verdict("R4", r.Mismatches == 0, $"5 published refresh messages (2,000 stale keys twice and once more, then the keys of 3,000 newer edits, then 1,000 removed keys + 1 never-existing; plus the server's own refresh for the HTTP edit); {r.Summary}"));

            // ---------------- R5 ----------------
            var dir = Environment.GetEnvironmentVariable("SKP_SCALE_HANDSHAKE_DIR");
            if (string.IsNullOrEmpty(dir))
            {
                // No return: execution must reach the final assert so R1-R4 verdicts are not swallowed.
                ScaleGate.Log("R5 skipped: SKP_SCALE_HANDSHAKE_DIR not set");
            }
            else
            {
                File.WriteAllText(Path.Combine(dir, "R5_READY"), DateTime.UtcNow.ToString("O"));
                ScaleGate.Log("R5 waiting for R5_GO (operator restarts Redis and the port-forward)");
                var waitUntil = DateTime.UtcNow.AddMinutes(20);
                while (!File.Exists(Path.Combine(dir, "R5_GO")) && DateTime.UtcNow < waitUntil) await Task.Delay(500, ct);
                Assert.True(File.Exists(Path.Combine(dir, "R5_GO")), "R5_GO never appeared");
                redis.Dispose();
                redis = await ConnectRedisAsync();
                db = redis.GetDatabase();
                var wiped = !await db.KeyExistsAsync(keySet) && !await db.SetContainsAsync(L2ProjectionKeys.Live(), workflow.ToString("D"));
                ScaleGate.Log($"R5 after restart: cache key set absent and workflow not live = {wiped}");

                // The liveness gate refuses until processors have re-registered; retry the start.
                sw.Restart();
                var started = false;
                var giveUp = DateTime.UtcNow.AddMinutes(5);
                string last = "";
                while (!started && DateTime.UtcNow < giveUp)
                {
                    using var res = await http.PostAsync("/api/v1/orchestration/start",
                        new StringContent(JsonSerializer.Serialize(workflow), Encoding.UTF8, "application/json"), ct);
                    if (res.StatusCode == HttpStatusCode.Accepted) { started = true; break; }
                    last = $"{(int)res.StatusCode} {await res.Content.ReadAsStringAsync(ct)}";
                    await Task.Delay(3000, ct);
                }
                Assert.True(started, "start after the Redis restart was refused for 5 minutes: " + last);
                var expected = (await ItemCountAsync(http, cache, ct));
                await WaitCardAsync(redis, keySet, expected);
                await WaitLiveAsync(redis, workflow);
                var r5Ms = sw.ElapsedMilliseconds;
                await CompareAsync("R5", http, redis, cache, workflow, root, prefix, keySet, ct,
                    r => Verdict("R5", wiped && r.Mismatches == 0,
                        $"Redis restarted (L2 empty before start: {wiped}); start to SCARD {expected:N0} in {r5Ms} ms ({r5Ms / 1000.0:F1} s, includes {(r5Ms > 0 ? "the liveness-gate retries" : "")}); {r.Summary}"));
            }
        }
        finally
        {
            ScaleGate.Log($"cleanup: workflow {workflow}, step {step}, cache {cache}");
            if (workflow != Guid.Empty)
            {
                await TryAsync(() => http.PostAsync("/api/v1/orchestration/stop",
                    new StringContent(JsonSerializer.Serialize(workflow), Encoding.UTF8, "application/json")));
                await Task.Delay(3000, TestContext.Current.CancellationToken);
                await TryAsync(() => http.DeleteAsync($"/api/v1/workflows/{workflow}"));
            }
            if (step != Guid.Empty) await TryAsync(() => http.DeleteAsync($"/api/v1/steps/{step}"));
            if (cache != Guid.Empty) await TryAsync(() => http.DeleteAsync($"/api/v1/caches/{cache}"));
            if (redis is not null && workflow != Guid.Empty)
            {
                try
                {
                    // The product never removes a deleted workflow's L2 keys; this run's own are removed by the test.
                    var server = redis.GetServer(redis.GetEndPoints()[0]);
                    var batch = new List<RedisKey>();
                    await foreach (var k in server.KeysAsync(pattern: $"{L2ProjectionKeys.Workflow(workflow)}*", pageSize: 5000))
                    {
                        batch.Add(k);
                        if (batch.Count == 5000) { await redis.GetDatabase().KeyDeleteAsync([.. batch]); batch.Clear(); }
                    }
                    if (batch.Count > 0) await redis.GetDatabase().KeyDeleteAsync([.. batch]);
                    await redis.GetDatabase().KeyDeleteAsync(L2ProjectionKeys.StepEntity(step));
                    await redis.GetDatabase().SetRemoveAsync(L2ProjectionKeys.Live(), workflow.ToString("D"));
                }
                catch (RedisException) { }
            }
            redis?.Dispose();
        }

        var failed = _verdicts.Where(v => v.Length > 0).ToList();
        Assert.True(failed.Count == 0, string.Join(Environment.NewLine, failed));
    }

    // ------------------------------------------------------------------ helpers

    private static async Task<ConnectionMultiplexer> ConnectRedisAsync()
    {
        var o = ConfigurationOptions.Parse($"{RealStack.RedisHost}:{RealStack.RedisPort}");
        o.SyncTimeout = 60_000; o.AsyncTimeout = 60_000; o.ConnectTimeout = 30_000; o.AbortOnConnectFail = false;
        return await ConnectionMultiplexer.ConnectAsync(o);
    }

    private static async Task<Guid> FindLiveProcessorAsync(IConnectionMultiplexer redis)
    {
        var db = redis.GetDatabase();
        var server = redis.GetServer(redis.GetEndPoints()[0]);
        await foreach (var key in server.KeysAsync(pattern: $"{L2ProjectionKeys.Prefix}proc:*:instances"))
        {
            if (!L2ProjectionKeys.TryParseProcessorInstances(key!, out var id)) continue;
            foreach (var instance in await db.SetMembersAsync(key))
                if (await db.KeyExistsAsync(L2ProjectionKeys.PerInstance(id, instance!))) return id;
        }
        Assert.Fail("no live processor in L2");
        return Guid.Empty;
    }

    private static async Task<Guid> CreateAsync(HttpClient http, string resource, object body, CancellationToken ct)
    {
        using var res = await http.PostAsJsonAsyncCompat($"/api/v1/{resource}", body, ct);
        var text = await res.Content.ReadAsStringAsync(ct);
        Assert.True(res.IsSuccessStatusCode, $"POST {resource} {(int)res.StatusCode}: {text}");
        using var doc = JsonDocument.Parse(text);
        return doc.RootElement.GetProperty("id").GetGuid();
    }

    private static async Task AppendAsync(HttpClient http, Guid cache, List<CacheItemDto> items, CancellationToken ct)
    {
        var body = JsonSerializer.Serialize(new { items = items.Select(x => new { key = x.Key, value = x.Value }) });
        using var res = await http.PostAsync($"/api/v1/caches/{cache}/items", new StringContent(body, Encoding.UTF8, "application/json"), ct);
        Assert.True(res.StatusCode == HttpStatusCode.OK, $"append {(int)res.StatusCode}: {await res.Content.ReadAsStringAsync(ct)}");
    }

    private static async Task<int> RemoveAsync(HttpClient http, Guid cache, List<string> keys, CancellationToken ct)
    {
        using var res = await http.PostAsync($"/api/v1/caches/{cache}/items/remove",
            new StringContent(JsonSerializer.Serialize(new { keys }), Encoding.UTF8, "application/json"), ct);
        var text = await res.Content.ReadAsStringAsync(ct);
        Assert.True(res.StatusCode == HttpStatusCode.OK, $"remove {(int)res.StatusCode}: {text}");
        using var doc = JsonDocument.Parse(text);
        return doc.RootElement.GetProperty("removed").GetInt32();
    }

    private static async Task<int> ItemCountAsync(HttpClient http, Guid id, CancellationToken ct)
    {
        using var res = await http.GetAsync($"/api/v1/caches/{id}", ct);
        res.EnsureSuccessStatusCode();
        using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync(ct));
        return doc.RootElement.GetProperty("itemCount").GetInt32();
    }

    private static async Task StartAsync(HttpClient http, Guid workflow, CancellationToken ct)
    {
        using var res = await http.PostAsync("/api/v1/orchestration/start",
            new StringContent(JsonSerializer.Serialize(workflow), Encoding.UTF8, "application/json"), ct);
        Assert.True(res.StatusCode == HttpStatusCode.Accepted, $"start {(int)res.StatusCode}: {await res.Content.ReadAsStringAsync(ct)}");
    }

    private static async Task TryAsync(Func<Task<HttpResponseMessage>> call)
    {
        try { (await call()).Dispose(); } catch (HttpRequestException) { } catch (TaskCanceledException) { }
    }

    private static async Task WaitCardAsync(IConnectionMultiplexer redis, RedisKey set, long expected)
    {
        var deadline = DateTime.UtcNow + Budget;
        long n = -1;
        while (DateTime.UtcNow < deadline)
        {
            try { n = await redis.GetDatabase().SetLengthAsync(set); } catch (RedisException) { }
            if (n == expected) return;
            await Task.Delay(250);
        }
        Assert.Fail($"SCARD {n} never reached {expected} within {Budget.TotalMinutes} min");
    }

    private static async Task WaitLiveAsync(IConnectionMultiplexer redis, Guid workflow)
    {
        var deadline = DateTime.UtcNow + Budget;
        while (DateTime.UtcNow < deadline)
        {
            try { if (await redis.GetDatabase().SetContainsAsync(L2ProjectionKeys.Live(), workflow.ToString("D"))) return; } catch (RedisException) { }
            await Task.Delay(250);
        }
        Assert.Fail("the workflow never became live");
    }

    private static async Task WaitValueAsync(IConnectionMultiplexer redis, string key, string value)
    {
        var deadline = DateTime.UtcNow + TimeSpan.FromMinutes(5);
        while (DateTime.UtcNow < deadline)
        {
            if ((string?)await redis.GetDatabase().StringGetAsync(key) == value) return;
            await Task.Delay(250);
        }
        Assert.Fail($"{key} never held the expected value");
    }

    /// <summary>Count of keys whose Redis entry or set membership disagrees with <c>expected</c> (null = must be gone).</summary>
    private static async Task<int> CheckTouchedAsync(IConnectionMultiplexer redis, string prefix, List<(string Key, string? Value)> expected)
    {
        var db = redis.GetDatabase();
        var setKey = (RedisKey)$"{prefix}::keys";
        var bad = 0;
        foreach (var chunk in expected.Chunk(5_000))
        {
            var values = await db.StringGetAsync(chunk.Select(c => (RedisKey)$"{prefix}:{c.Key}").ToArray());
            var member = await Task.WhenAll(chunk.Select(c => db.SetContainsAsync(setKey, c.Key)));
            for (var i = 0; i < chunk.Length; i++)
            {
                var want = chunk[i].Value;
                var ok = want is null ? values[i].IsNull && !member[i] : (string?)values[i] == want && member[i];
                if (!ok) bad++;
            }
        }
        return bad;
    }

    private sealed record CompareResult(int Mismatches, string Summary);

    /// <summary>
    /// Every DB key in pages of 5,000 against Redis (MGET of the page, SISMEMBER via one SSCAN of the whole set),
    /// plus the entry-key count under the cache prefix and the set size: nothing missing, nothing extra, no wrong value.
    /// </summary>
    private async Task CompareAsync(string name, HttpClient http, IConnectionMultiplexer redis, Guid cache, Guid workflow,
        string root, string prefix, RedisKey keySet, CancellationToken ct, Action<CompareResult> report)
    {
        var sw = Stopwatch.StartNew();
        var db = redis.GetDatabase();
        var members = new HashSet<string>(StringComparer.Ordinal);
        await foreach (var m in db.SetScanAsync(keySet, pageSize: 20_000)) members.Add(m.ToString());

        long dbCount = 0, missing = 0, wrong = 0, notInSet = 0;
        string? after = null;
        var seen = new HashSet<string>(StringComparer.Ordinal);
        while (true)
        {
            var url = $"/api/v1/caches/{cache}/items?limit=5000" + (after is null ? "" : "&after=" + Uri.EscapeDataString(after));
            using var res = await http.GetAsync(url, ct);
            res.EnsureSuccessStatusCode();
            using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync(ct));
            var items = doc.RootElement.GetProperty("items").EnumerateArray()
                .Select(e => (Key: e.GetProperty("key").GetString()!, Value: e.GetProperty("value").GetString()!)).ToList();
            if (items.Count > 0)
            {
                var values = await db.StringGetAsync(items.Select(i => (RedisKey)$"{prefix}:{i.Key}").ToArray());
                for (var i = 0; i < items.Count; i++)
                {
                    seen.Add(items[i].Key);
                    if (values[i].IsNull) missing++;
                    else if ((string?)values[i] != items[i].Value) wrong++;
                    if (!members.Contains(items[i].Key)) notInSet++;
                }
            }
            dbCount += items.Count;
            var next = doc.RootElement.GetProperty("next");
            if (next.ValueKind == JsonValueKind.Null) break;
            after = next.GetString();
        }
        var extraMembers = members.Count(m => !seen.Contains(m));

        // Entry keys under the cache prefix: the key set itself and the root marker are the only non-entries.
        var server = redis.GetServer(redis.GetEndPoints()[0]);
        long entryKeys = 0;
        await foreach (var _ in server.KeysAsync(pattern: $"{prefix}:*", pageSize: 20_000)) entryKeys++;
        entryKeys -= 1; // the "::keys" set matches the pattern too
        var extraEntries = entryKeys - dbCount;

        var mismatches = missing + wrong + notInSet + extraMembers + Math.Abs(extraEntries);
        var summary = $"full compare of {dbCount:N0} DB keys: missing in Redis {missing}, wrong value {wrong}, not in key set {notInSet}, " +
                      $"key-set members without a row {extraMembers}, entry keys {entryKeys:N0} vs rows {dbCount:N0} (diff {extraEntries}), took {sw.Elapsed.TotalSeconds:F0} s";
        ScaleGate.Log($"{name}: {summary}");
        report(new CompareResult((int)Math.Min(mismatches, int.MaxValue), summary));
        if (name.EndsWith("compare")) Verdict(name, mismatches == 0, summary);
    }
}
