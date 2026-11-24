using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Xunit;

namespace BaseApi.Tests.Live;

/// <summary>
/// <c>POST /workflows/{id}/validate</c> against Postgres, on stored rows. Each test builds its own rows and
/// removes them afterwards. (Draft bodies went with WorkflowStudio, 2026-11-24.)
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

    private async Task<(HttpStatusCode Status, JsonElement Body)> SendAsync(HttpMethod method, string path, object? body)
    {
        using var request = new HttpRequestMessage(method, path) { Content = body is null ? null : JsonContent.Create(body) };
        using var response = await _http.SendAsync(request, Ct);
        var text = await response.Content.ReadAsStringAsync(Ct);
        return (response.StatusCode, text.Length == 0 ? default : JsonDocument.Parse(text).RootElement.Clone());
    }

    [Fact]
    public async Task TheStoredWorkflowIsValidated()
    {
        RealStack.SkipUnlessEnabled();
        var a = await PostAsync("steps", new
        {
            name = $"v-{Guid.NewGuid():N}"[..12], version = "1.0.0", description = (string?)null,
            processorId = _processor, nextStepIds = Array.Empty<Guid>(), entryCondition = 1,
        });
        _cleanup.Add($"steps/{a}");
        var wf = await PostAsync("workflows", new
        {
            name = $"validate-live-{Guid.NewGuid():N}"[..27], version = "1.0.0", description = (string?)null,
            entryStepIds = new[] { a }, assignmentIds = Array.Empty<Guid>(), cacheIds = Array.Empty<Guid>(),
        });
        _cleanup.Add($"workflows/{wf}");

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
