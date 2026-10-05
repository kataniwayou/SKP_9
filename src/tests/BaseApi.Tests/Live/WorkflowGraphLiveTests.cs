using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Xunit;

namespace BaseApi.Tests.Live;

/// <summary>
/// The graph save against the real Postgres: what EF InMemory cannot show, because it has no
/// foreign keys and no transactions. Each test builds its own rows and removes them afterwards.
/// </summary>
[Trait("Category", RealStack.Category)]
public sealed class WorkflowGraphLiveTests : IAsyncLifetime
{
    private readonly HttpClient _http = new() { BaseAddress = new Uri(RealStack.BaseApiUrl), Timeout = TimeSpan.FromSeconds(20) };
    private readonly List<string> _cleanup = [];
    private Guid _processor;

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        if (!RealStack.Enabled) return;
        var hash = Convert.ToHexString(Guid.NewGuid().ToByteArray().Concat(Guid.NewGuid().ToByteArray()).ToArray()).ToLowerInvariant();
        _processor = await PostAsync("processors", new { SourceHash = hash, Name = $"graph-live-{Guid.NewGuid():N}", Version = "1.0.0" });
    }

    public async ValueTask DisposeAsync()
    {
        // Best effort, in FK order. Workflows cascade their own junction rows. Assignments go next,
        // because they restrict their step. A step's wires restrict BOTH ends (step_next_steps has no
        // cascade), so every step is unwired before any is deleted. Schemas go last, because the
        // processor slot pointing at them was cleared by the test itself.
        static int Rank(string p) => p.StartsWith("workflows") ? 0 : p.StartsWith("assignments") ? 1 : p.StartsWith("steps") ? 2 : 3;
        var ordered = _cleanup.OrderBy(Rank).ToList();

        foreach (var path in ordered.Where(p => Rank(p) < 2))
        {
            try { await _http.DeleteAsync($"/api/v1/{path}"); } catch (Exception) { }
        }
        foreach (var path in ordered.Where(p => Rank(p) == 2))
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
        foreach (var path in ordered.Where(p => Rank(p) >= 2))
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
        id, updatedAt, name = $"s-{id:N}"[..12], version = "1.0.0", description = (string?)null,
        processorId = processor, nextStepIds = next, entryCondition = 1,
    };

    private static object Body(string? updatedAt, Guid[] entry, object[]? steps = null, object[]? assignments = null,
        object[]? schemaEdits = null, object? layout = null) => new
    {
        workflow = new { name = $"graph-live-{Guid.NewGuid():N}"[..24], version = "1.0.0", description = (string?)null,
            cronExpression = (string?)null, updatedAt, entryStepIds = entry, cacheIds = Array.Empty<Guid>() },
        steps, assignments, schemaEdits, layout,
    };

    private async Task<(HttpStatusCode Status, JsonElement Body)> PutGraphAsync(Guid wf, object body)
    {
        using var response = await _http.PutAsJsonAsync($"/api/v1/workflows/{wf}/graph", body, Ct);
        var text = await response.Content.ReadAsStringAsync(Ct);
        return (response.StatusCode, text.Length == 0 ? default : JsonDocument.Parse(text).RootElement.Clone());
    }

    private void Track(Guid wf, params Guid[] steps)
    {
        _cleanup.Add($"workflows/{wf}");
        _cleanup.AddRange(steps.Select(s => $"steps/{s}"));
    }

    [Fact]
    public async Task NewStepsWiredToEachOtherAndAnAssignmentLandInOneSave()
    {
        RealStack.SkipUnlessEnabled();
        var (wf, a, b) = (Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid());
        Track(wf, a, b);

        var (status, graph) = await PutGraphAsync(wf, Body(null, [a],
            steps: [Step(a, _processor, null, b), Step(b, _processor)],
            assignments: [new { stepId = b, payload = """{"v":1}""" }],
            layout: new { nodes = new { } }));

        if (status == HttpStatusCode.OK && graph.GetProperty("assignments").GetArrayLength() > 0)
            _cleanup.Add($"assignments/{graph.GetProperty("assignments")[0].GetProperty("id").GetGuid()}");
        Assert.Equal(HttpStatusCode.OK, status);
        Assert.Equal(2, graph.GetProperty("steps").GetArrayLength());
        var asg = graph.GetProperty("assignments")[0];
        Assert.Equal(b, asg.GetProperty("stepId").GetGuid());
    }

    [Fact]
    public async Task AnFkViolationRollsBackTheWholeSave()
    {
        // Review focus 5: the new step b points at a processor that does not exist.
        RealStack.SkipUnlessEnabled();
        var (wf, a, b) = (Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid());
        Track(wf, a, b);

        var (status, _) = await PutGraphAsync(wf, Body(null, [a],
            steps: [Step(a, _processor, null, b), Step(b, Guid.NewGuid())],
            layout: new { nodes = new { } }));

        Assert.Equal(HttpStatusCode.UnprocessableEntity, status);
        Assert.Equal(HttpStatusCode.NotFound, (await _http.GetAsync($"/api/v1/steps/{a}", Ct)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await _http.GetAsync($"/api/v1/workflows/{wf}", Ct)).StatusCode);
    }

    [Fact]
    public async Task AStaleWorkflowIs409AndNamesIt()
    {
        RealStack.SkipUnlessEnabled();
        var (wf, a) = (Guid.NewGuid(), Guid.NewGuid());
        Track(wf, a);
        var (_, first) = await PutGraphAsync(wf, Body(null, [a], steps: [Step(a, _processor)]));
        var loadedAt = first.GetProperty("workflow").GetProperty("updatedAt").GetString();

        // A second save moves updatedAt on; replaying the first stamp is now stale.
        var (ok, _) = await PutGraphAsync(wf, Body(loadedAt, [a]));
        var (status, problem) = await PutGraphAsync(wf, Body(loadedAt, [a]));

        Assert.Equal(HttpStatusCode.OK, ok);
        Assert.Equal(HttpStatusCode.Conflict, status);
        Assert.Equal("workflow", problem.GetProperty("kind").GetString());
        Assert.Equal(wf, problem.GetProperty("id").GetGuid());
    }

    [Fact]
    public async Task ASchemaEditInsertsAVersionAndRepointsTheSlot()
    {
        RealStack.SkipUnlessEnabled();
        var (wf, a) = (Guid.NewGuid(), Guid.NewGuid());
        Track(wf, a);
        var (_, first) = await PutGraphAsync(wf, Body(null, [a], steps: [Step(a, _processor)]));
        var loadedAt = first.GetProperty("workflow").GetProperty("updatedAt").GetString();

        var (status, graph) = await PutGraphAsync(wf, Body(loadedAt, [a],
            schemaEdits: [new { processorId = _processor, slot = "config", definition = """{"type":"object"}""" }]));

        Assert.Equal(HttpStatusCode.OK, status);
        var configId = graph.GetProperty("processors")[0].GetProperty("configSchemaId").GetGuid();
        Assert.Equal(HttpStatusCode.OK, (await _http.GetAsync($"/api/v1/schemas/{configId}", Ct)).StatusCode);

        // Leave the processor deletable: clear the slot, then remove the schema.
        var reloaded = graph.GetProperty("workflow").GetProperty("updatedAt").GetString();
        await PutGraphAsync(wf, Body(reloaded, [a], schemaEdits: [new { processorId = _processor, slot = "config", definition = (string?)null }]));
        _cleanup.Add($"schemas/{configId}");
    }

    [Fact]
    public async Task TheLayoutRoundTripsThroughBothEndpoints()
    {
        RealStack.SkipUnlessEnabled();
        var (wf, a) = (Guid.NewGuid(), Guid.NewGuid());
        Track(wf, a);
        await PutGraphAsync(wf, Body(null, [a], steps: [Step(a, _processor)], layout: new { nodes = new { s = new { x = 8, y = 16 } } }));

        using var put = await _http.PutAsJsonAsync($"/api/v1/workflows/{wf}/layout", new { nodes = new { s = new { x = 24, y = 16 } } }, Ct);
        var layout = JsonDocument.Parse(await _http.GetStringAsync($"/api/v1/workflows/{wf}/layout", Ct)).RootElement;

        Assert.Equal(HttpStatusCode.OK, put.StatusCode);
        Assert.True(JsonDocument.Parse(await put.Content.ReadAsStringAsync(Ct)).RootElement.TryGetProperty("updatedAt", out _));
        Assert.Equal(24, layout.GetProperty("nodes").GetProperty("s").GetProperty("x").GetInt32());
    }

    [Fact]
    public async Task ASharedAssignmentIsCopiedForOneWorkflowAndDeletedWhenTheLastLetsGo()
    {
        RealStack.SkipUnlessEnabled();
        var (wfA, s1) = (Guid.NewGuid(), Guid.NewGuid());
        Track(wfA, s1);
        var (_, first) = await PutGraphAsync(wfA, Body(null, [s1], steps: [Step(s1, _processor)],
            assignments: [new { stepId = s1, payload = """{"v":1}""" }]));
        var r = first.GetProperty("assignments")[0].GetProperty("id").GetGuid();
        _cleanup.Add($"assignments/{r}");

        // B shares R on the same step through the plain workflow endpoint.
        var wfB = await PostAsync("workflows", new
        {
            name = $"graph-live-{Guid.NewGuid():N}"[..24], version = "1.0.0",
            entryStepIds = new[] { s1 }, assignmentIds = new[] { r }, cacheIds = Array.Empty<Guid>(),
        });
        _cleanup.Add($"workflows/{wfB}");

        // A drops its assignment: R is shared, so it must stay.
        var (statusA, afterA) = await PutGraphAsync(wfA, Body(first.GetProperty("workflow").GetProperty("updatedAt").GetString(), [s1],
            assignments: [new { stepId = s1, payload = (string?)null }]));
        Assert.Equal(HttpStatusCode.OK, statusA);
        Assert.Equal(0, afterA.GetProperty("assignments").GetArrayLength());
        Assert.Equal(HttpStatusCode.OK, (await _http.GetAsync($"/api/v1/assignments/{r}", Ct)).StatusCode);

        // B drops it too: R is now an orphan and goes with the save, not a 422.
        var bStamp = JsonDocument.Parse(await _http.GetStringAsync($"/api/v1/workflows/{wfB}", Ct)).RootElement
            .GetProperty("updatedAt").GetString();
        var (statusB, _) = await PutGraphAsync(wfB, Body(bStamp, [s1],
            assignments: [new { stepId = s1, payload = (string?)null }]));
        Assert.Equal(HttpStatusCode.OK, statusB);
        Assert.Equal(HttpStatusCode.NotFound, (await _http.GetAsync($"/api/v1/assignments/{r}", Ct)).StatusCode);
    }
}
