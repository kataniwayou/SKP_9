using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Xunit;

namespace BaseApi.Tests.Live;

/// <summary>
/// Plan 8's design save against the real Postgres (spec §8): what InMemory cannot show, the rollback,
/// the savepoints, foreign keys and unique constraints. Each test builds its own rows through the CRUD
/// endpoints and removes them afterwards.
/// </summary>
[Trait("Category", RealStack.Category)]
public sealed class WorkflowDesignLiveTests : IAsyncLifetime
{
    private const string Conflict = "changed by someone else since you opened it";

    private readonly HttpClient _http = new() { BaseAddress = new Uri(RealStack.BaseApiUrl), Timeout = TimeSpan.FromSeconds(30) };
    private readonly List<Guid> _workflows = [], _steps = [], _caches = [], _schemas = [];
    private Guid _processor;

    private bool _cleaning;

    // the test's token, except while cleaning up after it
    private CancellationToken Ct => _cleaning ? CancellationToken.None : TestContext.Current.CancellationToken;
    private static string Tag() => $"design-live-{Guid.NewGuid():N}"[..24];
    private static string Hash() => Convert.ToHexString(Guid.NewGuid().ToByteArray().Concat(Guid.NewGuid().ToByteArray()).ToArray()).ToLowerInvariant();

    public async ValueTask InitializeAsync()
    {
        if (!RealStack.Enabled) return;
        _processor = await PostAsync("processors", new { name = Tag(), version = "1.0.0", sourceHash = Hash() });
    }

    public async ValueTask DisposeAsync()
    {
        if (!RealStack.Enabled) { _http.Dispose(); return; }
        _cleaning = true;
        // FK order: workflows (they cascade their links), their steps' assignments, unwired steps, steps,
        // caches; then the processor's slots cleared so the schemas can go, then the processor.
        foreach (var w in _workflows) await DeleteAsync($"workflows/{w}");
        await TryAsync("list assignments", async () =>
        {
            var all = JsonDocument.Parse(await _http.GetStringAsync("/api/v1/assignments", CancellationToken.None)).RootElement;
            foreach (var a in all.EnumerateArray().Where(a => _steps.Contains(a.GetProperty("stepId").GetGuid())))
                await DeleteAsync($"assignments/{a.GetProperty("id").GetGuid()}");
        });
        foreach (var s in _steps) await TryAsync($"unwire step {s}", () => PutStepAsync(s, next: []));
        foreach (var s in _steps) await DeleteAsync($"steps/{s}");
        foreach (var c in _caches) await DeleteAsync($"caches/{c}");
        if (_processor != Guid.Empty)
        {
            await TryAsync("clear processor slots", () => PutProcessorAsync(clearSlots: true));
            foreach (var s in _schemas) await DeleteAsync($"schemas/{s}");
            await DeleteAsync($"processors/{_processor}");
        }
        _http.Dispose();
    }

    // Cleanup never fails a test, but a row it could not remove is reported in the test output.
    private static void Report(string message) => TestContext.Current.TestOutputHelper?.WriteLine("cleanup: " + message);

    private async Task TryAsync(string what, Func<Task> work)
    {
        try { await work(); } catch (Exception ex) { Report($"{what}: {ex.Message}"); }
    }

    private async Task DeleteAsync(string path) => await TryAsync($"DELETE {path}", async () =>
    {
        using var r = await _http.DeleteAsync($"/api/v1/{path}", CancellationToken.None);
        if (!r.IsSuccessStatusCode && r.StatusCode != HttpStatusCode.NotFound)
            Report($"DELETE {path} -> {(int)r.StatusCode}: {await r.Content.ReadAsStringAsync(CancellationToken.None)}");
    });

    private async Task<Guid> PostAsync(string resource, object body)
    {
        using var response = await _http.PostAsJsonAsync($"/api/v1/{resource}", body, Ct);
        var text = await response.Content.ReadAsStringAsync(Ct);
        Assert.True(response.IsSuccessStatusCode, $"POST {resource} -> {(int)response.StatusCode}: {text}");
        return JsonDocument.Parse(text).RootElement.GetProperty("id").GetGuid();
    }

    private async Task<JsonElement> GetAsync(string path) =>
        JsonDocument.Parse(await _http.GetStringAsync($"/api/v1/{path}", Ct)).RootElement.Clone();

    private static string? Text(JsonElement e, string name) => e.GetProperty(name).ValueKind == JsonValueKind.Null ? null : e.GetProperty(name).GetString();
    private static string Stamp(JsonElement dto) => dto.GetProperty("updatedAt").GetString()!;

    private async Task<Guid> StepAsync(params Guid[] next)
    {
        var id = await PostAsync("steps", new { name = Tag(), version = "1.0.0", description = (string?)null, processorId = _processor, nextStepIds = next, entryCondition = 1 });
        _steps.Add(id);
        return id;
    }

    private async Task<Guid> WorkflowAsync(Guid[] entry, Guid[]? assignments = null)
    {
        var id = await PostAsync("workflows", new { name = Tag(), version = "1.0.0", entryStepIds = entry, assignmentIds = assignments ?? [], cacheIds = Array.Empty<Guid>() });
        _workflows.Add(id);
        return id;
    }

    private async Task<Guid> CacheAsync()
    {
        var id = await PostAsync("caches", new { name = Tag(), version = "1.0.0", root = Tag(), items = "{}" });
        _caches.Add(id);
        return id;
    }

    private async Task PutStepAsync(Guid id, Guid[]? next = null, string? description = null)
    {
        var s = await GetAsync($"steps/{id}");
        using var r = await _http.PutAsJsonAsync($"/api/v1/steps/{id}", new
        {
            name = Text(s, "name"), version = Text(s, "version"), description = description ?? Text(s, "description"),
            processorId = s.GetProperty("processorId").GetGuid(),
            nextStepIds = next ?? s.GetProperty("nextStepIds").EnumerateArray().Select(x => x.GetGuid()).ToArray(),
            entryCondition = s.GetProperty("entryCondition").GetInt32(),
        }, Ct);
        Assert.True(r.IsSuccessStatusCode, $"PUT step -> {(int)r.StatusCode}");
    }

    private async Task PutProcessorAsync(string? description = null, Guid? configSchemaId = null, bool clearSlots = false)
    {
        var p = await GetAsync($"processors/{_processor}");
        Guid? Slot(string name) => clearSlots ? null : p.GetProperty(name).ValueKind == JsonValueKind.Null ? null : p.GetProperty(name).GetGuid();
        using var r = await _http.PutAsJsonAsync($"/api/v1/processors/{_processor}", new
        {
            name = Text(p, "name"), version = Text(p, "version"), description = description ?? Text(p, "description"),
            sourceHash = Text(p, "sourceHash"), instanceId = Text(p, "instanceId"),
            inputSchemaId = Slot("inputSchemaId"), outputSchemaId = Slot("outputSchemaId"), configSchemaId = configSchemaId ?? Slot("configSchemaId"),
        }, Ct);
        Assert.True(r.IsSuccessStatusCode, $"PUT processor -> {(int)r.StatusCode}");
    }

    private async Task PutAssignmentAsync(Guid id, string payload)
    {
        var a = await GetAsync($"assignments/{id}");
        using var r = await _http.PutAsJsonAsync($"/api/v1/assignments/{id}", new
        {
            name = Text(a, "name"), version = Text(a, "version"), description = Text(a, "description"),
            stepId = a.GetProperty("stepId").GetGuid(), payload,
        }, Ct);
        Assert.True(r.IsSuccessStatusCode, $"PUT assignment -> {(int)r.StatusCode}");
    }

    private static object Body(object? workflow = null, object[]? steps = null, object[]? processors = null,
        object[]? caches = null, object[]? schemas = null, object[]? assignments = null) =>
        new { workflow, steps, processors, caches, schemas, assignments, layout = new { v = 1 } };

    private async Task<(bool Applied, JsonElement[] Errors)> PutDesignAsync(Guid wf, object body)
    {
        using var r = await _http.PutAsJsonAsync($"/api/v1/workflows/{wf}/design", body, Ct);
        var text = await r.Content.ReadAsStringAsync(Ct);
        Assert.True(r.StatusCode == HttpStatusCode.OK, $"PUT design -> {(int)r.StatusCode}: {text}");
        var json = JsonDocument.Parse(text).RootElement;
        return (json.GetProperty("applied").GetBoolean(), json.GetProperty("errors").EnumerateArray().Select(e => e.Clone()).ToArray());
    }

    private static string Describe(JsonElement[] errors) => string.Join("; ", errors.Select(e => e.GetRawText()));

    private static bool Is(JsonElement e, string kind, Guid id, string? field) =>
        e.GetProperty("kind").GetString() == kind && e.GetProperty("id").GetGuid() == id && Text(e, "field") == field;

    private async Task<string> StepStampAsync(Guid id) => Stamp(await GetAsync($"steps/{id}"));

    [Fact]
    public async Task ANewWorkflowIsCreatedByItsFirstSaveAndOneThatFailsLeavesNothingBehind()
    {
        // 2026-10-10 (Workspace › New workflow): the create stage inside the real transaction, then the rollback
        RealStack.SkipUnlessEnabled();
        object Body(Guid step, Guid? processor, string name) => new
        {
            workflow = new { updatedAt = (string?)null, entryStepIds = new[] { step } },
            newSteps = new[] { new { id = step, copyOf = (Guid?)null, processorId = processor, fields = new { name = Tag(), version = "1.0.0", description = (string?)null, entryCondition = 1 }, nextStepIds = Array.Empty<Guid>() } },
            newWorkflow = new { fields = new { name, version = "1.0.0", description = (string?)null, cronExpression = (string?)null } },
            layout = new { v = 1 },
        };
        Guid wf = Guid.NewGuid(), s = Guid.NewGuid();
        _workflows.Add(wf);
        _steps.Add(s);
        var name = Tag();

        var (applied, errors) = await PutDesignAsync(wf, Body(s, _processor, name));

        Assert.True(applied, Describe(errors));
        var made = await GetAsync($"workflows/{wf}");
        Assert.Equal(name, Text(made, "name"));
        Assert.Equal([s], made.GetProperty("entryStepIds").EnumerateArray().Select(x => x.GetGuid()));
        Assert.Equal(_processor, (await GetAsync($"steps/{s}")).GetProperty("processorId").GetGuid());

        // a step with no processor fails the dry run: neither the workflow nor its step is left behind
        Guid wf2 = Guid.NewGuid(), s2 = Guid.NewGuid();
        var (applied2, errors2) = await PutDesignAsync(wf2, Body(s2, null, Tag()));
        Assert.False(applied2);
        Assert.Contains(errors2, e => Is(e, "step", s2, "processorId"));
        Assert.Equal(HttpStatusCode.NotFound, (await _http.GetAsync($"/api/v1/workflows/{wf2}", Ct)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await _http.GetAsync($"/api/v1/steps/{s2}", Ct)).StatusCode);

        // a taken name: refused, nothing created
        Guid wf3 = Guid.NewGuid(), s3 = Guid.NewGuid();
        var (applied3, errors3) = await PutDesignAsync(wf3, Body(s3, _processor, name));
        Assert.False(applied3);
        Assert.Contains(errors3, e => Is(e, "workflow", wf3, "name"));
        Assert.Equal(HttpStatusCode.NotFound, (await _http.GetAsync($"/api/v1/workflows/{wf3}", Ct)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await _http.GetAsync($"/api/v1/steps/{s3}", Ct)).StatusCode);
    }

    [Fact]
    public async Task APastedStepWithItsAssignmentIsCreatedAndTheStepItReplacesIsDeleted()
    {
        // 2026-10-10 (copy, paste, delete): created rows and the delete in one transaction, through the real foreign keys
        RealStack.SkipUnlessEnabled();
        var b = await StepAsync();
        var a = await StepAsync(b);
        var asg = await PostAsync("assignments", new { name = Tag(), version = "1.0.0", stepId = b, payload = """{"k":7}""" });
        var wf = await WorkflowAsync([a], [asg]);
        var bDto = await GetAsync($"steps/{b}");
        Guid n = Guid.NewGuid(), nAsg = Guid.NewGuid();
        _steps.Add(n);

        var (applied, errors) = await PutDesignAsync(wf, new
        {
            workflow = new { updatedAt = Stamp(await GetAsync($"workflows/{wf}")) },
            steps = new[] { new { id = a, updatedAt = await StepStampAsync(a), fields = (object?)null, nextStepIds = new[] { n } } },
            newSteps = new[] { new { id = n, copyOf = b, processorId = _processor, fields = new { name = Text(bDto, "name"), version = "1.0.0", description = (string?)null, entryCondition = 1 }, nextStepIds = Array.Empty<Guid>() } },
            assignments = new[] { new { op = "create", id = nAsg, stepId = n, updatedAt = (string?)null, fields = new { payload = """{"k":7}""" }, copyOf = asg } },
            deletedSteps = new[] { new { id = b, updatedAt = Stamp(bDto) } },
            layout = new { v = 1 },
        });

        Assert.True(applied, Describe(errors));
        var made = await GetAsync($"steps/{n}");
        Assert.Equal((Text(bDto, "name"), _processor), (Text(made, "name"), made.GetProperty("processorId").GetGuid()));
        Assert.Equal([n], (await GetAsync($"steps/{a}")).GetProperty("nextStepIds").EnumerateArray().Select(x => x.GetGuid()));
        var copied = await GetAsync($"assignments/{nAsg}");
        // jsonb gives the payload back in its own spacing
        Assert.Equal((n, 7), (copied.GetProperty("stepId").GetGuid(), JsonDocument.Parse(Text(copied, "payload")!).RootElement.GetProperty("k").GetInt32()));
        Assert.Equal([nAsg], (await GetAsync($"workflows/{wf}")).GetProperty("assignmentIds").EnumerateArray().Select(x => x.GetGuid()));
        Assert.Equal(HttpStatusCode.NotFound, (await _http.GetAsync($"/api/v1/steps/{b}", Ct)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await _http.GetAsync($"/api/v1/assignments/{asg}", Ct)).StatusCode);
    }

    [Fact]
    public async Task APastedCacheWithItsOwnRootIsCreatedAndATakenRootIsRefusedClearly()
    {
        // review 2026-10-10: Root is unique (uq_cache_root); InMemory never shows it
        RealStack.SkipUnlessEnabled();
        var c = await CacheAsync();
        var root = Text(await GetAsync($"caches/{c}"), "root")!;
        var wf = await WorkflowAsync([await StepAsync()]);
        Guid n = Guid.NewGuid(), taken = Guid.NewGuid();
        _caches.Add(n);
        _caches.Add(taken);
        object Cache(Guid id, string r) => new { id, copyOf = c, fields = new { name = Tag(), version = "1.0.0", description = (string?)null, root = r, items = "{}" } };

        var (applied, errors) = await PutDesignAsync(wf, new
        {
            workflow = new { updatedAt = Stamp(await GetAsync($"workflows/{wf}")), cacheIds = new[] { n } },
            newCaches = new[] { Cache(n, root + "-copy") },
            layout = new { v = 1 },
        });
        Assert.True(applied, Describe(errors));
        Assert.Equal(root + "-copy", Text(await GetAsync($"caches/{n}"), "root"));

        var (again, refused) = await PutDesignAsync(wf, new
        {
            workflow = new { updatedAt = Stamp(await GetAsync($"workflows/{wf}")), cacheIds = new[] { n, taken } },
            newCaches = new[] { Cache(taken, root) },
            layout = new { v = 1 },
        });
        Assert.False(again);
        // (the workflow's cache list then names a cache that was not created: its own error)
        var error = refused.Single(e => Is(e, "cache", taken, "root"));
        Assert.Equal($"Root '{root}' is already used by cache '{Text(await GetAsync($"caches/{c}"), "name")}'.", error.GetProperty("message").GetString());
        Assert.Equal(HttpStatusCode.NotFound, (await _http.GetAsync($"/api/v1/caches/{taken}", Ct)).StatusCode);
    }

    [Fact]
    public async Task AStepAnotherWorkflowUsesIsRefusedAndThePastedStepIsRolledBack()
    {
        RealStack.SkipUnlessEnabled();
        var shared = await StepAsync();
        var a = await StepAsync(shared);
        var wf = await WorkflowAsync([a]);
        await WorkflowAsync([shared]);
        var n = Guid.NewGuid();
        _steps.Add(n);

        var (applied, errors) = await PutDesignAsync(wf, new
        {
            steps = new[] { new { id = a, updatedAt = await StepStampAsync(a), fields = (object?)null, nextStepIds = new[] { n } } },
            newSteps = new[] { new { id = n, copyOf = shared, processorId = _processor, fields = new { name = Tag(), version = "1.0.0", entryCondition = 1 }, nextStepIds = (Guid[]?)null } },
            deletedSteps = new[] { new { id = shared, updatedAt = await StepStampAsync(shared) } },
            layout = new { v = 1 },
        });

        Assert.False(applied);
        var error = Assert.Single(errors);
        Assert.True(Is(error, "step", shared, null), Describe(errors));
        Assert.StartsWith("Not deleted: still used by workflow '", error.GetProperty("message").GetString());
        Assert.Equal(HttpStatusCode.NotFound, (await _http.GetAsync($"/api/v1/steps/{n}", Ct)).StatusCode);
        Assert.Equal([shared], (await GetAsync($"steps/{a}")).GetProperty("nextStepIds").EnumerateArray().Select(x => x.GetGuid()));
    }

    [Fact]
    public async Task ADesignWithAnInvalidStepIsStoredLeavesTheRealEntitiesUntouchedAndReportsEveryError()
    {
        RealStack.SkipUnlessEnabled();
        var b = await StepAsync();
        var a = await StepAsync(b);
        var wf = await WorkflowAsync([a]);
        var workflowStamp = Stamp(await GetAsync($"workflows/{wf}"));

        var (applied, errors) = await PutDesignAsync(wf, Body(
            workflow: new { updatedAt = workflowStamp, fields = new { cronExpression = "not a cron" } },
            steps: [new { id = a, updatedAt = await StepStampAsync(a), fields = new { description = "applied?" } },
                    new { id = b, updatedAt = await StepStampAsync(b), fields = new { version = "abc" } }]));

        Assert.False(applied);
        Assert.Contains(errors, e => Is(e, "step", b, "version"));
        Assert.Contains(errors, e => Is(e, "workflow", wf, "cronExpression"));
        // rolled back: a's valid change is not there either; the store moved no stamp; the design is stored
        Assert.Null(Text(await GetAsync($"steps/{a}"), "description"));
        Assert.Equal(workflowStamp, Stamp(await GetAsync($"workflows/{wf}")));
        Assert.Equal(JsonValueKind.Object, (await GetAsync($"workflows/{wf}/graph")).GetProperty("design").ValueKind);
    }

    [Fact]
    public async Task TheStoredDesignComesBackWithTheGraphAndIsLastWriteWins()
    {
        RealStack.SkipUnlessEnabled();
        var a = await StepAsync();
        var wf = await WorkflowAsync([a]);

        await PutDesignAsync(wf, Body(steps: [new { id = a, updatedAt = (string?)null, fields = new { version = "first" } }]));
        await PutDesignAsync(wf, Body(steps: [new { id = a, updatedAt = (string?)null, fields = new { version = "second" } }]));

        var design = (await GetAsync($"workflows/{wf}/graph")).GetProperty("design");
        Assert.Equal("second", design.GetProperty("steps")[0].GetProperty("fields").GetProperty("version").GetString());
    }

    [Fact]
    public async Task AValidDesignAlignsTheRealEntitiesInFullAndEmptiesTheStoredDesign()
    {
        RealStack.SkipUnlessEnabled();
        var c = await StepAsync();
        var b = await StepAsync();
        var a = await StepAsync(b);
        var wf = await WorkflowAsync([a]);

        var (applied, errors) = await PutDesignAsync(wf, Body(
            workflow: new { updatedAt = Stamp(await GetAsync($"workflows/{wf}")), fields = new { description = "designed" } },
            steps: [new { id = a, updatedAt = await StepStampAsync(a), fields = new { name = "renamed-" + Tag() }, nextStepIds = new[] { c } }]));

        Assert.True(applied, Describe(errors));
        var step = await GetAsync($"steps/{a}");
        Assert.StartsWith("renamed-", Text(step, "name"));
        Assert.Equal([c], step.GetProperty("nextStepIds").EnumerateArray().Select(x => x.GetGuid()));
        Assert.Equal("designed", Text(await GetAsync($"workflows/{wf}"), "description"));
        Assert.Equal(JsonValueKind.Null, (await GetAsync($"workflows/{wf}/graph")).GetProperty("design").ValueKind);
    }

    [Fact]
    public async Task AStepChangedSinceItWasOpenedFailsWithTheConflict()
    {
        RealStack.SkipUnlessEnabled();
        var a = await StepAsync();
        var wf = await WorkflowAsync([a]);
        var loaded = await StepStampAsync(a);
        await PutStepAsync(a, description: "someone else");

        var (applied, errors) = await PutDesignAsync(wf, Body(steps: [new { id = a, updatedAt = loaded, fields = new { name = "mine" } }]));

        Assert.False(applied);
        Assert.Equal(Conflict, Assert.Single(errors).GetProperty("message").GetString());
        Assert.Equal("someone else", Text(await GetAsync($"steps/{a}"), "description"));
    }

    [Fact]
    public async Task AProcessorIsLastWriteWins()
    {
        RealStack.SkipUnlessEnabled();
        var a = await StepAsync();
        var wf = await WorkflowAsync([a]);
        await PutProcessorAsync(description: "someone else");

        var (applied, errors) = await PutDesignAsync(wf, Body(processors: [new { id = _processor, fields = new { version = "2.0.0" } }]));

        Assert.True(applied, Describe(errors));
        var p = await GetAsync($"processors/{_processor}");
        Assert.Equal(("2.0.0", "someone else"), (Text(p, "version"), Text(p, "description")));
    }

    [Fact]
    public async Task ASchemaCopyKeepsTheNameAndVersionAndTheSlotIsRepointed()
    {
        RealStack.SkipUnlessEnabled();
        var name = "cfg-" + Tag();
        var original = await PostAsync("schemas", new { name, version = "1.2.3", description = (string?)null, definition = """{"type":"object"}""" });
        _schemas.Add(original);
        await PutProcessorAsync(configSchemaId: original);
        var wf = await WorkflowAsync([await StepAsync()]);
        var copy = Guid.NewGuid();
        _schemas.Add(copy);

        var (applied, errors) = await PutDesignAsync(wf, Body(
            processors: [new { id = _processor, slots = new { config = copy } }],
            schemas: [new { id = copy, name, version = "1.2.3", description = (string?)null, definition = """{"type":"string"}""" }]));

        Assert.True(applied, Describe(errors));
        Assert.Equal(copy, (await GetAsync($"processors/{_processor}")).GetProperty("configSchemaId").GetGuid());
        var s = await GetAsync($"schemas/{copy}");
        Assert.Equal((name, "1.2.3"), (Text(s, "name")!, Text(s, "version")!));
        Assert.Equal(HttpStatusCode.OK, (await _http.GetAsync($"/api/v1/schemas/{original}", Ct)).StatusCode);
    }

    [Fact]
    public async Task AFailedSchemaCopySkipsItsRepointAndNothingIsWritten()
    {
        RealStack.SkipUnlessEnabled();
        var original = await PostAsync("schemas", new { name = "cfg-" + Tag(), version = "1.0.0", description = (string?)null, definition = """{"type":"object"}""" });
        _schemas.Add(original);
        await PutProcessorAsync(configSchemaId: original);
        var wf = await WorkflowAsync([await StepAsync()]);
        var copy = Guid.NewGuid();

        var (applied, errors) = await PutDesignAsync(wf, Body(
            processors: [new { id = _processor, slots = new { config = copy } }],
            schemas: [new { id = copy, name = "cfg", version = "1.0.0", description = (string?)null, definition = "not json" }]));

        Assert.False(applied);
        Assert.Contains(errors, e => Is(e, "schema", copy, "definition"));
        Assert.Contains(errors, e => Is(e, "processor", _processor, "configSchemaId"));
        Assert.Equal(original, (await GetAsync($"processors/{_processor}")).GetProperty("configSchemaId").GetGuid());
        Assert.Equal(HttpStatusCode.NotFound, (await _http.GetAsync($"/api/v1/schemas/{copy}", Ct)).StatusCode);
    }

    [Fact]
    public async Task AssignmentsAreCreatedUpdatedAndDeleted()
    {
        RealStack.SkipUnlessEnabled();
        var (s1, s2, s3) = (await StepAsync(), await StepAsync(), await StepAsync());
        var x = await PostAsync("assignments", new { name = Tag(), version = "1.0.0", stepId = s2, payload = "{}" });
        var y = await PostAsync("assignments", new { name = Tag(), version = "1.0.0", stepId = s3, payload = "{}" });
        var wf = await WorkflowAsync([s1, s2, s3], [x, y]);
        var made = Guid.NewGuid();

        var (applied, errors) = await PutDesignAsync(wf, Body(
            workflow: new { updatedAt = Stamp(await GetAsync($"workflows/{wf}")) },
            assignments:
            [
                new { op = "create", id = made, stepId = s1, updatedAt = (string?)null, fields = new { name = Tag(), version = "1.0.0", payload = """{"a":1}""" } },
                new { op = "update", id = x, stepId = s2, updatedAt = Stamp(await GetAsync($"assignments/{x}")), fields = new { payload = """{"b":2}""" } },
                new { op = "delete", id = y, stepId = s3, updatedAt = Stamp(await GetAsync($"assignments/{y}")), fields = (object?)null },
            ]));

        Assert.True(applied, Describe(errors));
        var linked = (await GetAsync($"workflows/{wf}")).GetProperty("assignmentIds").EnumerateArray().Select(e => e.GetGuid()).OrderBy(g => g);
        Assert.Equal(new[] { made, x }.OrderBy(g => g), linked);
        Assert.Contains("\"b\"", Text(await GetAsync($"assignments/{x}"), "payload"));
        Assert.Equal(HttpStatusCode.NotFound, (await _http.GetAsync($"/api/v1/assignments/{y}", Ct)).StatusCode);
    }

    [Fact]
    public async Task ADatabaseErrorOnOneEntityIsReportedAndTheOthersStillReportTheirs()
    {
        RealStack.SkipUnlessEnabled();
        var (c1, c2) = (await CacheAsync(), await CacheAsync());
        var takenRoot = Text(await GetAsync($"caches/{c1}"), "root");
        var c2Root = Text(await GetAsync($"caches/{c2}"), "root");
        var a = await StepAsync();
        var wf = await WorkflowAsync([a]);

        var (applied, errors) = await PutDesignAsync(wf, Body(
            caches: [new { id = c2, fields = new { root = takenRoot } }],
            steps: [new { id = a, updatedAt = await StepStampAsync(a), fields = new { version = "abc" } }]));

        Assert.False(applied);
        Assert.Contains(errors, e => Is(e, "cache", c2, "root"));   // uq_cache_root, caught at its savepoint
        Assert.Contains(errors, e => Is(e, "step", a, "version"));  // the stages went on after it
        Assert.Equal(c2Root, Text(await GetAsync($"caches/{c2}"), "root"));
    }

    [Fact]
    public async Task ANotStartableDesignIsWritten()
    {
        RealStack.SkipUnlessEnabled();
        await StepAsync(); // an unwired step, as a designer leaves one on the canvas
        var b = await StepAsync();
        var a = await StepAsync(b);
        var wf = await WorkflowAsync([a]);

        var (applied, errors) = await PutDesignAsync(wf, Body(
            steps: [new { id = b, updatedAt = await StepStampAsync(b), fields = (object?)null, nextStepIds = new[] { a } }]));

        Assert.True(applied, Describe(errors));
        Assert.Equal([a], (await GetAsync($"steps/{b}")).GetProperty("nextStepIds").EnumerateArray().Select(x => x.GetGuid()));
    }
    [Fact]
    public async Task AStaleAssignmentUpdateOrDeleteFailsWithTheConflictAndNothingIsWritten()
    {
        RealStack.SkipUnlessEnabled();
        var (s1, s2) = (await StepAsync(), await StepAsync());
        var x = await PostAsync("assignments", new { name = Tag(), version = "1.0.0", stepId = s1, payload = "{}" });
        var y = await PostAsync("assignments", new { name = Tag(), version = "1.0.0", stepId = s2, payload = "{}" });
        var wf = await WorkflowAsync([s1, s2], [x, y]);
        var (xLoaded, yLoaded) = (Stamp(await GetAsync($"assignments/{x}")), Stamp(await GetAsync($"assignments/{y}")));
        await PutAssignmentAsync(x, """{"someone":"else"}""");
        await PutAssignmentAsync(y, """{"someone":"else"}""");

        var (applied, errors) = await PutDesignAsync(wf, Body(assignments:
        [
            new { op = "update", id = x, stepId = s1, updatedAt = xLoaded, fields = new { payload = """{"mine":1}""" } },
            new { op = "delete", id = y, stepId = s2, updatedAt = yLoaded, fields = (object?)null },
        ]));

        Assert.False(applied);
        Assert.Equal(2, errors.Length);
        Assert.All(errors, e => Assert.Equal(Conflict, e.GetProperty("message").GetString()));
        Assert.Contains(errors, e => Is(e, "assignment", x, null));
        Assert.Contains(errors, e => Is(e, "assignment", y, null));
        Assert.Contains("someone", Text(await GetAsync($"assignments/{x}"), "payload"));
        Assert.Equal(HttpStatusCode.OK, (await _http.GetAsync($"/api/v1/assignments/{y}", Ct)).StatusCode);
    }

    [Fact]
    public async Task DeletingAnAssignmentAnotherWorkflowStillListsIsRefusedByTheForeignKey()
    {
        RealStack.SkipUnlessEnabled();
        var s1 = await StepAsync();
        var x = await PostAsync("assignments", new { name = Tag(), version = "1.0.0", stepId = s1, payload = "{}" });
        var wf = await WorkflowAsync([s1], [x]);
        await WorkflowAsync([s1], [x]); // the other workflow that lists it

        var (applied, errors) = await PutDesignAsync(wf, Body(assignments:
            [new { op = "delete", id = x, stepId = s1, updatedAt = Stamp(await GetAsync($"assignments/{x}")), fields = (object?)null }]));

        Assert.False(applied);
        var refused = Assert.Single(errors);
        Assert.True(Is(refused, "assignment", x, "assignmentId"), Describe(errors));
        Assert.Equal("assignments", refused.GetProperty("stage").GetString());
        Assert.Contains("Foreign key violation", refused.GetProperty("message").GetString());
        Assert.Equal(HttpStatusCode.OK, (await _http.GetAsync($"/api/v1/assignments/{x}", Ct)).StatusCode);
        Assert.Contains(x, (await GetAsync($"workflows/{wf}")).GetProperty("assignmentIds").EnumerateArray().Select(e => e.GetGuid()));
    }

    [Fact]
    public async Task AWireToAStepThatDoesNotExistIsAnErrorOnThatStepAndNothingIsWritten()
    {
        RealStack.SkipUnlessEnabled();
        var b = await StepAsync();
        var a = await StepAsync(b);
        var wf = await WorkflowAsync([a]);
        var missing = Guid.NewGuid();

        var (applied, errors) = await PutDesignAsync(wf, Body(
            steps: [new { id = a, updatedAt = await StepStampAsync(a), fields = (object?)null, nextStepIds = new[] { missing } }]));

        Assert.False(applied);
        var refused = Assert.Single(errors);
        Assert.True(Is(refused, "step", a, "nextStepId"), Describe(errors));
        Assert.Equal("wires", refused.GetProperty("stage").GetString());
        Assert.Contains("Foreign key violation", refused.GetProperty("message").GetString());
        Assert.Equal([b], (await GetAsync($"steps/{a}")).GetProperty("nextStepIds").EnumerateArray().Select(x => x.GetGuid()));
    }
}
