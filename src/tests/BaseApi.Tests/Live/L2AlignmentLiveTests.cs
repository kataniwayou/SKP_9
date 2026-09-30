using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using StackExchange.Redis;
using Xunit;

namespace BaseApi.Tests.Live;

/// <summary>
/// Start alignment against the real BaseApi, Postgres and Redis: each start makes L2 follow the
/// database for every participant of the workflow — added and kept entities written, removed ones
/// deleted — and nothing else (spec §3.5). The hermetic <c>StartDrivenProjectionTests</c> prove the
/// writer against an in-memory L2 and a fake row lookup; this proves the shipped chain end to end: the
/// HTTP start, the queued consumer, the real <c>DbStepRowLookup</c>, and the keys it leaves in Redis.
/// <para>
/// <b>Self-contained and inert.</b> Every row is created here and deleted afterwards. The workflow has
/// no cron, so starting it activates it without ever dispatching a step; the only borrowed thing is a
/// live processor id, which the steps reference and nothing here writes. Redis is read, and written
/// only at the very end to remove this run's own keys — see the <c>finally</c>.
/// </para>
/// <para>
/// <b>"Processed", not "accepted".</b> A start answers 202 before the consumer runs (spec §3.2), so
/// every check polls Redis until the expected state appears or the budget runs out.
/// </para>
/// </summary>
[Trait("Category", RealStack.Category)]
public sealed class L2AlignmentLiveTests
{
    private static readonly TimeSpan Budget = TimeSpan.FromSeconds(30);

    [Fact]
    public async Task EachStartAlignsEveryParticipantWithTheDatabase()
    {
        RealStack.SkipUnlessEnabled();
        var ct = TestContext.Current.CancellationToken;

        using var http = new HttpClient { BaseAddress = new Uri(RealStack.BaseApiUrl), Timeout = TimeSpan.FromSeconds(20) };
        using var redis = await ConnectionMultiplexer.ConnectAsync($"{RealStack.RedisHost}:{RealStack.RedisPort}");
        var db = redis.GetDatabase();

        var processorId = await FindLiveProcessorAsync(redis, db);
        var run = Guid.NewGuid().ToString("N")[..12];
        var root = $"l2align-{run}";

        Guid a = Guid.Empty, b = Guid.Empty, c = Guid.Empty, cache = Guid.Empty, workflow = Guid.Empty;
        var ownKeys = new List<RedisKey>();
        try
        {
            a = await CreateAsync(http, "steps", Step($"l2align-a-{run}", processorId), ct);
            ownKeys.Add(L2ProjectionKeys.StepEntity(a));
            b = await CreateAsync(http, "steps", Step($"l2align-b-{run}", processorId), ct);
            ownKeys.Add(L2ProjectionKeys.StepEntity(b));
            c = await CreateAsync(http, "steps", Step($"l2align-c-{run}", processorId), ct);
            ownKeys.Add(L2ProjectionKeys.StepEntity(c));
            cache = await CreateAsync(http, "caches", Cache(root, """{"x":"1","y":"2"}""", run), ct);
            workflow = await CreateAsync(http, "workflows", Workflow(run, [a, b, c], [cache]), ct);
            ownKeys.Add(L2ProjectionKeys.Workflow(workflow));
            ownKeys.Add(L2ProjectionKeys.Cache(workflow, root));
            ownKeys.Add(L2ProjectionKeys.CacheEntry(workflow, root, "x"));
            ownKeys.Add(L2ProjectionKeys.CacheEntry(workflow, root, "y"));

            // ── Start 1: every participant is added. ─────────────────────────────────────────────
            await StartAsync(http, workflow, ct);
            await EventuallyAsync("start 1: store holds a, b, c and the workflow is live", async () =>
                await db.SetContainsAsync(L2ProjectionKeys.Live(), workflow.ToString("D"))
                && StoreSteps(await db.HashGetAsync(L2ProjectionKeys.Workflow(workflow), L2ProjectionKeys.StoreField))
                    .SetEquals([a, b, c]));

            Assert.Equal(EntityNames.Format($"l2align-wf-{run}", "1.0.0", workflow),
                (string?)await db.HashGetAsync(L2ProjectionKeys.Workflow(workflow), L2ProjectionKeys.NameField));
            foreach (var (id, name) in new[] { (a, "a"), (b, "b"), (c, "c") })
            {
                Assert.Equal(EntityNames.Format($"l2align-{name}-{run}", "1.0.0", id),
                    (string?)await db.HashGetAsync(L2ProjectionKeys.StepEntity(id), L2ProjectionKeys.NameField));
            }

            Assert.Equal("1", (string?)await db.StringGetAsync(L2ProjectionKeys.CacheEntry(workflow, root, "x")));
            Assert.Equal("2", (string?)await db.StringGetAsync(L2ProjectionKeys.CacheEntry(workflow, root, "y")));

            // ── Database edits: rename a (kept), drop b and c, delete b's row (c's stays), change
            //    x and drop y from the cache. None of this reaches L2 until the next start. ─────────
            await UpdateAsync(http, "steps", a, Step($"l2align-a2-{run}", processorId), ct);
            await UpdateAsync(http, "workflows", workflow, Workflow(run, [a], [cache]), ct);
            var bKey = L2ProjectionKeys.StepEntity(b);
            await DeleteAsync(http, "steps", b, ct);
            b = Guid.Empty;
            await UpdateAsync(http, "caches", cache, Cache(root, """{"x":"1-new"}""", run), ct);

            Assert.True(await db.KeyExistsAsync(L2ProjectionKeys.CacheEntry(workflow, root, "y")),
                "a database edit reached L2 without a start");

            // ── Start 2: kept overwritten, removed deleted — except a dropped step whose row exists. ─
            await StartAsync(http, workflow, ct);
            await EventuallyAsync("start 2: store holds only a", async () =>
                StoreSteps(await db.HashGetAsync(L2ProjectionKeys.Workflow(workflow), L2ProjectionKeys.StoreField))
                    .SetEquals([a]));

            Assert.Equal(EntityNames.Format($"l2align-a2-{run}", "1.0.0", a),
                (string?)await db.HashGetAsync(L2ProjectionKeys.StepEntity(a), L2ProjectionKeys.NameField));
            Assert.False(await db.KeyExistsAsync(bKey), "a dropped step whose row is gone kept its name key");
            Assert.True(await db.KeyExistsAsync(L2ProjectionKeys.StepEntity(c)),
                "a dropped step whose row still exists lost its name key");

            Assert.Equal("1-new", (string?)await db.StringGetAsync(L2ProjectionKeys.CacheEntry(workflow, root, "x")));
            Assert.False(await db.KeyExistsAsync(L2ProjectionKeys.CacheEntry(workflow, root, "y")),
                "a cache item removed from the database is still in L2");
            Assert.Equal(["x"], ReadList(await db.StringGetAsync(L2ProjectionKeys.Cache(workflow, root))));

            // ── Start 3: the cache is unbound, so its root and every entry go. ─────────────────────
            await UpdateAsync(http, "workflows", workflow, Workflow(run, [a], []), ct);
            await StartAsync(http, workflow, ct);
            await EventuallyAsync("start 3: the cache root is gone", async () =>
                !await db.KeyExistsAsync(L2ProjectionKeys.Cache(workflow, root)));

            Assert.False(await db.KeyExistsAsync(L2ProjectionKeys.CacheEntry(workflow, root, "x")),
                "an unbound cache root left an entry behind");
            Assert.Empty(ReadList(await db.HashGetAsync(L2ProjectionKeys.Workflow(workflow), L2ProjectionKeys.RootsField)));
        }
        finally
        {
            // Best effort, workflow first: every other row is referenced by it (ON DELETE RESTRICT).
            if (workflow != Guid.Empty)
            {
                await TryAsync(() => http.PostAsJsonAsync("/api/v1/orchestration/stop", workflow));
                await TryAsync(() => http.DeleteAsync($"/api/v1/workflows/{workflow}"));
            }

            foreach (var id in new[] { a, b, c })
            {
                if (id != Guid.Empty)
                {
                    await TryAsync(() => http.DeleteAsync($"/api/v1/steps/{id}"));
                }
            }

            if (cache != Guid.Empty)
            {
                await TryAsync(() => http.DeleteAsync($"/api/v1/caches/{cache}"));
            }

            // This run's own L2 keys, removed by the test because the product never will: nothing
            // cleans a deleted workflow's keys, nor a step dropped while its row existed and deleted
            // after (spec §6), and both happen above. Without this every run leaves them on the shared
            // dev Redis. Test hygiene only — the product rule that only a start writes L2 is untouched.
            if (ownKeys.Count > 0)
            {
                try
                {
                    await db.KeyDeleteAsync(ownKeys.ToArray());
                }
                catch (RedisException)
                {
                }
            }
        }
    }

    private static object Step(string name, Guid processorId) => new
    {
        name, version = "1.0.0", description = (string?)null, processorId,
        nextStepIds = Array.Empty<Guid>(), entryCondition = 4,
    };

    private static object Cache(string root, string items, string run) => new
    {
        name = $"l2align-cache-{run}", version = "1.0.0", description = (string?)null, root, items,
    };

    // No cron: a started workflow activates but never dispatches.
    private static object Workflow(string run, Guid[] entrySteps, Guid[] caches) => new
    {
        name = $"l2align-wf-{run}", version = "1.0.0", description = (string?)null,
        entryStepIds = entrySteps, assignmentIds = Array.Empty<Guid>(), cacheIds = caches,
        cronExpression = (string?)null,
    };

    /// <summary>
    /// A processor with at least one replica whose liveness key is present, so the start's liveness
    /// gate admits it. Read from Redis rather than hard-coded: processor ids change with every rebuild.
    /// </summary>
    private static async Task<Guid> FindLiveProcessorAsync(IConnectionMultiplexer redis, IDatabase db)
    {
        var server = redis.GetServer(redis.GetEndPoints()[0]);
        await foreach (var key in server.KeysAsync(pattern: $"{L2ProjectionKeys.Prefix}proc:*:instances"))
        {
            if (!L2ProjectionKeys.TryParseProcessorInstances(key!, out var id))
            {
                continue;
            }

            foreach (var instance in await db.SetMembersAsync(key))
            {
                if (await db.KeyExistsAsync(L2ProjectionKeys.PerInstance(id, instance!)))
                {
                    return id;
                }
            }
        }

        Assert.Fail("no live processor in L2 — the start's liveness gate would refuse every workflow");
        return Guid.Empty;
    }

    private static async Task<Guid> CreateAsync(HttpClient http, string resource, object body, CancellationToken ct)
    {
        using var response = await http.PostAsJsonAsync($"/api/v1/{resource}", body, ct);
        var text = await response.Content.ReadAsStringAsync(ct);
        Assert.True(response.IsSuccessStatusCode, $"POST /api/v1/{resource} returned {(int)response.StatusCode}: {text}");
        using var doc = JsonDocument.Parse(text);
        return doc.RootElement.GetProperty("id").GetGuid();
    }

    private static async Task UpdateAsync(HttpClient http, string resource, Guid id, object body, CancellationToken ct)
    {
        using var response = await http.PutAsJsonAsync($"/api/v1/{resource}/{id}", body, ct);
        Assert.True(response.IsSuccessStatusCode,
            $"PUT /api/v1/{resource}/{id} returned {(int)response.StatusCode}: {await response.Content.ReadAsStringAsync(ct)}");
    }

    private static async Task DeleteAsync(HttpClient http, string resource, Guid id, CancellationToken ct)
    {
        using var response = await http.DeleteAsync($"/api/v1/{resource}/{id}", ct);
        Assert.True(response.IsSuccessStatusCode,
            $"DELETE /api/v1/{resource}/{id} returned {(int)response.StatusCode}: {await response.Content.ReadAsStringAsync(ct)}");
    }

    private static async Task StartAsync(HttpClient http, Guid workflow, CancellationToken ct)
    {
        using var response = await http.PostAsJsonAsync("/api/v1/orchestration/start", workflow, ct);
        Assert.True(response.StatusCode == HttpStatusCode.Accepted,
            $"start returned {(int)response.StatusCode}: {await response.Content.ReadAsStringAsync(ct)}");
    }

    private static async Task EventuallyAsync(string what, Func<Task<bool>> condition)
    {
        var deadline = DateTime.UtcNow + Budget;
        while (DateTime.UtcNow < deadline)
        {
            if (await condition())
            {
                return;
            }

            await Task.Delay(250);
        }

        Assert.Fail($"not within {Budget.TotalSeconds}s: {what}");
    }

    private static HashSet<Guid> StoreSteps(RedisValue json) =>
        json.IsNullOrEmpty
            ? []
            : (JsonSerializer.Deserialize<WorkflowStoreProjection>(json.ToString(), MessagingJson.Options)?.Steps ?? [])
                .Select(s => s.StepId).ToHashSet();

    private static List<string> ReadList(RedisValue json) =>
        json.IsNullOrEmpty ? [] : JsonSerializer.Deserialize<List<string>>(json.ToString()) ?? [];

    private static async Task TryAsync(Func<Task<HttpResponseMessage>> call)
    {
        try
        {
            (await call()).Dispose();
        }
        catch (HttpRequestException)
        {
        }
    }
}
