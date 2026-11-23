using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Xunit;

namespace BaseApi.Tests.Live;

/// <summary>
/// <c>POST /workflows/validate</c> against Postgres (the user, 2026-11-23): Acto's Save check. The changes are run and
/// rolled back, every listed workflow is put through the start's gates inside that run, liveness aside. Every row a test
/// sends is a create with a client id, so nothing of it may exist afterwards; only the fixture's processor is real.
/// </summary>
[Trait("Category", RealStack.Category)]
public sealed class WorkflowsDraftValidationLiveTests : IAsyncLifetime
{
    private readonly HttpClient _http = new() { BaseAddress = new Uri(RealStack.BaseApiUrl), Timeout = TimeSpan.FromSeconds(20) };
    private Guid _processor;

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        if (!RealStack.Enabled) return;
        var hash = Convert.ToHexString(Guid.NewGuid().ToByteArray().Concat(Guid.NewGuid().ToByteArray()).ToArray()).ToLowerInvariant();
        using var response = await _http.PostAsJsonAsync("/api/v1/processors", new { SourceHash = hash, Name = $"draft-live-{Guid.NewGuid():N}"[..26], Version = "1.0.0" }, Ct);
        var text = await response.Content.ReadAsStringAsync(Ct);
        Assert.True(response.IsSuccessStatusCode, $"POST processors -> {(int)response.StatusCode}: {text}");
        _processor = JsonDocument.Parse(text).RootElement.GetProperty("id").GetGuid();
    }

    public async ValueTask DisposeAsync()
    {
        if (_processor != Guid.Empty)
        {
            try { await _http.DeleteAsync($"/api/v1/processors/{_processor}"); } catch (Exception) { }
        }
        _http.Dispose();
    }

    private object StepRow(Guid id, params Guid[] next) => new
    {
        name = $"d-{id:N}"[..12], version = "1.0.0", description = (string?)null, processorId = _processor,
        nextStepIds = next, entryCondition = 1,
    };

    private static object WorkflowRow(params Guid[] entry) => new
    {
        name = $"draft-live-{Guid.NewGuid():N}"[..27], version = "1.0.0", description = (string?)null,
        entryStepIds = entry, assignmentIds = Array.Empty<Guid>(), cacheIds = Array.Empty<Guid>(), cronExpression = (string?)null,
    };

    private static object Change(string op, string table, Guid id, object? row) => new { op, table, id, row };

    private async Task<JsonElement> CheckAsync(object[] changes, params Guid[] workflowIds)
    {
        using var response = await _http.PostAsJsonAsync("/api/v1/workflows/validate", new { changes, workflowIds }, Ct);
        var text = await response.Content.ReadAsStringAsync(Ct);
        Assert.True(response.StatusCode == HttpStatusCode.OK, $"POST workflows/validate -> {(int)response.StatusCode}: {text}");
        return JsonDocument.Parse(text).RootElement.Clone();
    }

    private async Task AssertGoneAsync(string path)
    {
        using var get = await _http.GetAsync($"/api/v1/{path}", Ct);
        Assert.Equal(HttpStatusCode.NotFound, get.StatusCode);
    }

    private static JsonElement[] Problems(JsonElement result, Guid wf) =>
        result.GetProperty("workflows").EnumerateArray().Single(w => w.GetProperty("workflowId").GetGuid() == wf).GetProperty("problems").EnumerateArray().ToArray();

    [Fact]
    public async Task ACleanDraftIsValidAndNothingIsWritten()
    {
        RealStack.SkipUnlessEnabled();
        var (wf, a) = (Guid.NewGuid(), Guid.NewGuid());

        var result = await CheckAsync([Change("create", "steps", a, StepRow(a)), Change("create", "workflows", wf, WorkflowRow(a))], wf);

        Assert.True(result.GetProperty("valid").GetBoolean(), result.GetRawText());
        Assert.Empty(Problems(result, wf));
        await AssertGoneAsync($"workflows/{wf}");
        await AssertGoneAsync($"steps/{a}");
    }

    [Fact]
    public async Task ACycleIsAProblemOfItsWorkflowUnderTheClientId()
    {
        RealStack.SkipUnlessEnabled();
        var (wf, a) = (Guid.NewGuid(), Guid.NewGuid());

        // created first, wired to itself after (a create cannot name its own id): Acto's Save sends it the same way
        var result = await CheckAsync([
            Change("create", "steps", a, StepRow(a)),
            Change("update", "steps", a, StepRow(a, a)),
            Change("create", "workflows", wf, WorkflowRow(a)),
        ], wf);

        Assert.False(result.GetProperty("valid").GetBoolean(), result.GetRawText());
        Assert.Contains(Problems(result, wf), p => p.GetProperty("gate").GetString() == "cycle");
        // the rows of the run are rolled back: a problem names them by the ids the client sent, never by ids that exist nowhere
        var cycle = Problems(result, wf).First(p => p.GetProperty("gate").GetString() == "cycle");
        Assert.Contains(a.ToString("D"), cycle.GetProperty("detail").GetString(), StringComparison.OrdinalIgnoreCase);
        Assert.Contains(a.ToString("D"), cycle.GetProperty("offending").GetRawText(), StringComparison.OrdinalIgnoreCase);
        await AssertGoneAsync($"workflows/{wf}");
    }

    [Fact]
    public async Task ARefusedRowGivesRowResultsAndNoChecks()
    {
        RealStack.SkipUnlessEnabled();
        var (wf, missing) = (Guid.NewGuid(), Guid.NewGuid());

        var result = await CheckAsync([Change("update", "steps", missing, StepRow(missing))], wf);

        Assert.False(result.GetProperty("valid").GetBoolean());
        var row = Assert.Single(result.GetProperty("results").EnumerateArray());
        Assert.False(row.GetProperty("ok").GetBoolean());
        Assert.Equal(404, row.GetProperty("status").GetInt32());
        Assert.Empty(result.GetProperty("workflows").EnumerateArray());
    }

    [Fact]
    public async Task ADeadProcessorIsNotAProblem()
    {
        // the fixture's processor has never had a replica: a start would refuse it (liveness), this check does not
        RealStack.SkipUnlessEnabled();
        var (wf, a, b) = (Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid());

        var result = await CheckAsync([
            Change("create", "steps", b, StepRow(b)),
            Change("create", "steps", a, StepRow(a, b)),
            Change("create", "workflows", wf, WorkflowRow(a)),
        ], wf);

        Assert.True(result.GetProperty("valid").GetBoolean(), result.GetRawText());
        Assert.DoesNotContain(Problems(result, wf), p => p.GetProperty("gate").GetString() == "processorLiveness");
    }
}
