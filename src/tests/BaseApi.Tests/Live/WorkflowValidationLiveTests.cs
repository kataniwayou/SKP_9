using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Xunit;

namespace BaseApi.Tests.Live;

/// <summary>
/// The dry run against Postgres: whatever the draft writes is rolled back. Each test builds its own
/// rows and removes them afterwards.
/// </summary>
[Trait("Category", RealStack.Category)]
public sealed class WorkflowValidationLiveTests : IAsyncLifetime
{
    private readonly HttpClient _http = new() { BaseAddress = new Uri(RealStack.BaseApiUrl), Timeout = TimeSpan.FromSeconds(20) };
    private readonly List<string> _cleanup = [];
    private Guid _processor;

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        if (!RealStack.Enabled) return;
        var hash = Convert.ToHexString(Guid.NewGuid().ToByteArray().Concat(Guid.NewGuid().ToByteArray()).ToArray()).ToLowerInvariant();
        _processor = await PostAsync("processors", new { SourceHash = hash, Name = $"validate-live-{Guid.NewGuid():N}", Version = "1.0.0" });
    }

    public async ValueTask DisposeAsync()
    {
        // Workflows first (they cascade their junction rows), then steps after unwiring them, then the processor.
        foreach (var path in _cleanup.Where(p => p.StartsWith("workflows")))
        {
            try { await _http.DeleteAsync($"/api/v1/{path}"); } catch (Exception) { }
        }
        foreach (var path in _cleanup.Where(p => p.StartsWith("steps")))
        {
            try
            {
                using var get = await _http.GetAsync($"/api/v1/{path}");
                if (!get.IsSuccessStatusCode) continue;
                var s = JsonDocument.Parse(await get.Content.ReadAsStringAsync()).RootElement;
                await _http.PutAsJsonAsync($"/api/v1/{path}", new
                {
                    name = s.GetProperty("name").GetString(), version = s.GetProperty("version").GetString(),
                    description = (string?)null, processorId = s.GetProperty("processorId").GetGuid(),
                    nextStepIds = Array.Empty<Guid>(), entryCondition = s.GetProperty("entryCondition").GetInt32(),
                });
            }
            catch (Exception) { }
        }
        foreach (var path in _cleanup.Where(p => p.StartsWith("steps")))
        {
            try { await _http.DeleteAsync($"/api/v1/{path}"); } catch (Exception) { }
        }
        if (_processor != Guid.Empty)
        {
            try { await _http.DeleteAsync($"/api/v1/processors/{_processor}"); } catch (Exception) { }
        }
        _http.Dispose();
    }

    private async Task<Guid> PostAsync(string resource, object body)
    {
        using var response = await _http.PostAsJsonAsync($"/api/v1/{resource}", body, Ct);
        var text = await response.Content.ReadAsStringAsync(Ct);
        Assert.True(response.IsSuccessStatusCode, $"POST {resource} -> {(int)response.StatusCode}: {text}");
        return JsonDocument.Parse(text).RootElement.GetProperty("id").GetGuid();
    }

    private static object Step(Guid id, Guid processor, string? updatedAt = null, params Guid[] next) => new
    {
        id, updatedAt, name = $"v-{id:N}"[..12], version = "1.0.0", description = (string?)null,
        processorId = processor, nextStepIds = next, entryCondition = 1,
    };

    private static object Body(string? updatedAt, Guid[] entry, object[]? steps = null) => new
    {
        workflow = new { name = $"validate-live-{Guid.NewGuid():N}"[..27], version = "1.0.0", description = (string?)null,
            cronExpression = (string?)null, updatedAt, entryStepIds = entry, cacheIds = Array.Empty<Guid>() },
        steps, assignments = (object[]?)null, schemaEdits = (object[]?)null, layout = (object?)null,
    };

    private async Task<(HttpStatusCode Status, JsonElement Body)> SendAsync(HttpMethod method, string path, object? body)
    {
        using var request = new HttpRequestMessage(method, path) { Content = body is null ? null : JsonContent.Create(body) };
        using var response = await _http.SendAsync(request, Ct);
        var text = await response.Content.ReadAsStringAsync(Ct);
        return (response.StatusCode, text.Length == 0 ? default : JsonDocument.Parse(text).RootElement.Clone());
    }

    [Fact]
    public async Task ADraftIsValidatedAndNothingOfItIsPersisted()
    {
        // Review focus 5: the draft creates the workflow and a self-looping step inside the transaction.
        RealStack.SkipUnlessEnabled();
        var (wf, a) = (Guid.NewGuid(), Guid.NewGuid());
        _cleanup.AddRange([$"workflows/{wf}", $"steps/{a}"]);

        var (status, result) = await SendAsync(HttpMethod.Post, $"/api/v1/workflows/{wf}/validate",
            Body(null, [a], [Step(a, _processor, null, a)]));

        Assert.Equal(HttpStatusCode.OK, status);
        Assert.False(result.GetProperty("valid").GetBoolean());
        var gates = result.GetProperty("problems").EnumerateArray().Select(p => p.GetProperty("gate").GetString()).ToList();
        Assert.Contains("cycle", gates);
        Assert.Contains("processorLiveness", gates);   // the throwaway processor has no replica
        Assert.Equal(HttpStatusCode.NotFound, (await _http.GetAsync($"/api/v1/steps/{a}", Ct)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await _http.GetAsync($"/api/v1/workflows/{wf}", Ct)).StatusCode);
    }

    [Fact]
    public async Task ADraftEditOfAStoredWorkflowLeavesTheStoredGraphUnchanged()
    {
        RealStack.SkipUnlessEnabled();
        var (wf, a, b) = (Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid());
        _cleanup.AddRange([$"workflows/{wf}", $"steps/{a}", $"steps/{b}"]);
        var (saved, graph) = await SendAsync(HttpMethod.Put, $"/api/v1/workflows/{wf}/graph",
            Body(null, [a], [Step(a, _processor, null, b), Step(b, _processor)]));
        Assert.Equal(HttpStatusCode.OK, saved);
        var stamp = graph.GetProperty("workflow").GetProperty("updatedAt").GetString();
        var bStamp = graph.GetProperty("steps").EnumerateArray().Single(s => s.GetProperty("id").GetGuid() == b).GetProperty("updatedAt").GetString();

        // The draft wires b back to a: a cycle.
        var (status, result) = await SendAsync(HttpMethod.Post, $"/api/v1/workflows/{wf}/validate",
            Body(stamp, [a], [Step(b, _processor, bStamp, a)]));

        Assert.Equal(HttpStatusCode.OK, status);
        Assert.Contains(result.GetProperty("problems").EnumerateArray(), p => p.GetProperty("gate").GetString() == "cycle");
        var (_, after) = await SendAsync(HttpMethod.Get, $"/api/v1/workflows/{wf}/graph", null);
        var bAfter = after.GetProperty("steps").EnumerateArray().Single(s => s.GetProperty("id").GetGuid() == b);
        Assert.Equal(0, bAfter.GetProperty("nextStepIds").GetArrayLength());
        Assert.Equal(stamp, after.GetProperty("workflow").GetProperty("updatedAt").GetString());
    }

    [Fact]
    public async Task ADraftWithAnFkViolationIsA422AndLeavesNothing()
    {
        // Review focus 1: the second new step points at a processor that does not exist.
        RealStack.SkipUnlessEnabled();
        var (wf, a, b) = (Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid());
        _cleanup.AddRange([$"workflows/{wf}", $"steps/{a}", $"steps/{b}"]);

        var (status, _) = await SendAsync(HttpMethod.Post, $"/api/v1/workflows/{wf}/validate",
            Body(null, [a], [Step(a, _processor, null, b), Step(b, Guid.NewGuid())]));

        Assert.Equal(HttpStatusCode.UnprocessableEntity, status);
        Assert.Equal(HttpStatusCode.NotFound, (await _http.GetAsync($"/api/v1/steps/{a}", Ct)).StatusCode);
    }

    [Fact]
    public async Task TheStoredWorkflowIsValidatedWhenThereIsNoBody()
    {
        RealStack.SkipUnlessEnabled();
        var (wf, a) = (Guid.NewGuid(), Guid.NewGuid());
        _cleanup.AddRange([$"workflows/{wf}", $"steps/{a}"]);
        await SendAsync(HttpMethod.Put, $"/api/v1/workflows/{wf}/graph", Body(null, [a], [Step(a, _processor)]));

        var (status, result) = await SendAsync(HttpMethod.Post, $"/api/v1/workflows/{wf}/validate", null);

        Assert.Equal(HttpStatusCode.OK, status);
        Assert.Equal("processorLiveness", Assert.Single(result.GetProperty("problems").EnumerateArray()).GetProperty("gate").GetString());
    }

    [Fact]
    public async Task TheLiveListAndTheLivenessReadAnswer()
    {
        RealStack.SkipUnlessEnabled();

        var (liveStatus, live) = await SendAsync(HttpMethod.Get, "/api/v1/orchestration/live", null);
        var (livenessStatus, liveness) = await SendAsync(HttpMethod.Get, "/api/v1/processors/liveness", null);

        Assert.Equal(HttpStatusCode.OK, liveStatus);
        Assert.Equal(JsonValueKind.Array, live.ValueKind);
        Assert.Equal(HttpStatusCode.OK, livenessStatus);
        var mine = liveness.EnumerateArray().Single(p => p.GetProperty("processorId").GetGuid() == _processor);
        Assert.False(mine.GetProperty("live").GetBoolean());
        Assert.Equal(0, mine.GetProperty("replicas").GetInt32());
    }
}
