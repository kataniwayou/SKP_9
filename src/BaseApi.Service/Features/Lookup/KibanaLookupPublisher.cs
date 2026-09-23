using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using BaseApi.Service.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace BaseApi.Service.Features.Lookup;

/// <summary>
/// Publishes the id → <c>{name}_{version}</c> lookup table into Kibana's data view.
///
/// <para><b>Why this is pushed and not read.</b> Panels and controls aggregate on the raw id —
/// <c>attributes.WorkflowId</c>, <c>StepId</c>, <c>ProcessorId</c> — because a name is not an
/// identity here: there is no unique index on <c>Name</c>, nor on <c>(Name, Version)</c>, so two
/// steps called <c>split-importer</c> can coexist and aggregating on the name would silently merge
/// them. Kibana substitutes the label at draw time from a <c>static_lookup</c> formatter, which is a
/// table it holds. It will not fetch that table from anywhere, on any schedule, so something has to
/// push it — and the thing that owns the names is this service.</para>
///
/// <para><b>The source is this database, not the log store.</b> The lookup was generated from naming
/// records in Elasticsearch, which are written on an explicit start and never by the cron; a
/// workflow that had only ever run on a schedule therefore had no names at all. Reading the entity
/// tables removes that trap and makes a freshly published step nameable before it has ever run.</para>
///
/// <para><b>Unmanaged formatters are preserved.</b> <c>fieldFormatMap</c> is one attribute holding
/// the whole map, so a PUT replaces it wholesale. The dashboard also carries a <c>whitelist_owner</c>
/// formatter whose keys are <c>{StepId} · {WhitelistRoot}</c> pairs — observed in the data, not
/// derivable from any entity — so writing only the three maps this class owns would delete it. The
/// current map is read first and merged.</para>
///
/// <para><b>Every publish sends the complete table.</b> Override semantics are what make a rename or
/// a deletion take effect, and what makes two concurrent publishers harmless: identical full tables
/// produce identical results. A partial write would lose whatever it omitted.</para>
/// </summary>
public sealed class KibanaLookupPublisher
{
    // The three id fields, and the entity each one names. They are the fields the dashboard
    // aggregates on, which is the whole point: the label is cosmetic, the id is the identity.
    private const string WorkflowField = "attributes.WorkflowId";
    private const string StepField = "attributes.StepId";
    private const string ProcessorField = "attributes.ProcessorId";

    // A SCOPE, NOT AN INJECTED CONTEXT. This class is a singleton because it owns the last
    // staleness floor and the gate, and a singleton cannot hold a scoped DbContext. The work also
    // outlives the request that triggered it - the image has already been returned - so the
    // request's own scope may be gone by the time this runs.
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly IHttpClientFactory _httpFactory;
    private readonly KibanaLookupOptions _options;
    private readonly ILogger<KibanaLookupPublisher> _log;
    private readonly TimeProvider _time;

    // Guarded by _gate. A render storm - five images a page, several operators, auto-refresh
    // ticking - arrives as concurrent requests, and without the gate they would each rebuild the
    // map and race to publish it.
    private readonly SemaphoreSlim _gate = new(1, 1);
    private DateTimeOffset _lastAttempt = DateTimeOffset.MinValue;

    public KibanaLookupPublisher(
        IServiceScopeFactory scopeFactory,
        IHttpClientFactory httpFactory,
        IOptions<KibanaLookupOptions> options,
        ILogger<KibanaLookupPublisher> log,
        TimeProvider time)
    {
        _scopeFactory = scopeFactory;
        _httpFactory = httpFactory;
        _options = options.Value;
        _log = log;
        _time = time;
    }

    internal bool Enabled => !string.IsNullOrWhiteSpace(_options.BaseUrl);

    /// <summary>
    /// Rebuilds and publishes if the last attempt is older than the configured floor and the table
    /// has actually changed. Never throws: the caller is serving an image.
    /// </summary>
    public async Task RefreshAsync(CancellationToken ct)
    {
        if (!Enabled)
            return;

        // Checked before taking the gate so a render storm costs one comparison per request rather
        // than queueing behind the publisher.
        if (_time.GetUtcNow() - _lastAttempt < _options.MinimumInterval)
            return;

        if (!await _gate.WaitAsync(TimeSpan.Zero, ct))
            return;     // another render is already publishing; this one has nothing to add
        try
        {
            if (_time.GetUtcNow() - _lastAttempt < _options.MinimumInterval)
                return;
            _lastAttempt = _time.GetUtcNow();

            var managed = await BuildAsync(ct);
            var published = await ReadPublishedAsync(ct);

            // Unmanaged fields are carried across untouched; the three this service owns are
            // replaced. Without the carry, a PUT would delete whitelist_owner, whose keys are
            // {StepId} - {WhitelistRoot} pairs observed in the data and derivable from no entity.
            var merged = new Dictionary<string, Dictionary<string, string>>(published, StringComparer.Ordinal);
            foreach (var (field, pairs) in managed)
                merged[field] = pairs;

            // NO COMPARISON BEFORE WRITING, DELIBERATELY. Skipping an unchanged publish would save a
            // write, and the obvious way to know it is unchanged - remembering what this pod last
            // sent - is wrong in two ways: it is per-pod memory lost on every restart, and it goes
            // stale silently when something else overwrites the attribute. Re-importing the
            // saved-object export does exactly that, and a publisher trusting its own memory would
            // conclude it had already published that content and never correct it.
            //
            // Overwriting unconditionally is the safe behaviour: whatever the table was, it is now
            // what this service says it is. The staleness floor is what bounds the cost, so it -
            // not a hash - is the knob to turn if the write rate ever matters.
            await PublishAsync(merged, ct);
            _log.LogInformation(
                "Published the Kibana lookup table: {Fields} field(s), {Entries} entries.",
                merged.Count, merged.Values.Sum(v => v.Count));
        }
        catch (Exception ex)
        {
            // WARNING, NOT AN EXCEPTION. The caller is returning an image to a dashboard; a Kibana
            // that is down must not fail that. Logged at Warning so "Kibana was unreachable" stays
            // distinguishable from "nobody opened the dashboard", which is the ambiguity that makes
            // this class of failure hard to diagnose later.
            _log.LogWarning(ex, "Could not publish the Kibana lookup table; labels may be stale.");
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>The three maps this service owns, read from the entity tables.</summary>
    private async Task<Dictionary<string, Dictionary<string, string>>> BuildAsync(CancellationToken ct)
    {
        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        static Dictionary<string, string> Pairs(IEnumerable<(Guid Id, string Name, string Version)> rows)
            => rows.ToDictionary(r => r.Id.ToString(), r => $"{r.Name}_{r.Version}");

        var workflows = await db.Set<Workflow.WorkflowEntity>()
            .Select(e => new { e.Id, e.Name, e.Version }).ToListAsync(ct);
        var steps = await db.Set<Step.StepEntity>()
            .Select(e => new { e.Id, e.Name, e.Version }).ToListAsync(ct);
        var processors = await db.Set<Processor.ProcessorEntity>()
            .Select(e => new { e.Id, e.Name, e.Version }).ToListAsync(ct);

        return new Dictionary<string, Dictionary<string, string>>
        {
            [WorkflowField] = Pairs(workflows.Select(e => (e.Id, e.Name, e.Version))),
            [StepField] = Pairs(steps.Select(e => (e.Id, e.Name, e.Version))),
            [ProcessorField] = Pairs(processors.Select(e => (e.Id, e.Name, e.Version))),
        };
    }

    /// <summary>The lookup table Kibana is holding right now, field by field.</summary>
    private async Task<Dictionary<string, Dictionary<string, string>>> ReadPublishedAsync(CancellationToken ct)
    {
        var current = new Dictionary<string, Dictionary<string, string>>(StringComparer.Ordinal);

        var client = CreateClient();
        using var response = await client.GetAsync(
            $"/api/saved_objects/index-pattern/{_options.DataViewId}", ct);
        if (response.IsSuccessStatusCode)
        {
            var body = JsonNode.Parse(await response.Content.ReadAsStringAsync(ct));
            var raw = body?["attributes"]?["fieldFormatMap"]?.GetValue<string>();
            if (!string.IsNullOrWhiteSpace(raw))
                foreach (var (field, spec) in ParsePublished(raw))
                    current[field] = spec;
        }
        return current;
    }

    /// <summary>Existing formatters, flattened back to field → (key → value).</summary>
    private static IEnumerable<(string Field, Dictionary<string, string> Entries)> ParsePublished(string raw)
    {
        var map = JsonNode.Parse(raw)?.AsObject();
        if (map is null)
            yield break;

        foreach (var (field, spec) in map)
        {
            var entries = spec?["params"]?["lookupEntries"]?.AsArray();
            if (entries is null)
                continue;
            var pairs = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var entry in entries)
            {
                var key = entry?["key"]?.GetValue<string>();
                var value = entry?["value"]?.GetValue<string>();
                if (key is not null && value is not null)
                    pairs[key] = value;
            }
            yield return (field, pairs);
        }
    }

    private async Task PublishAsync(
        Dictionary<string, Dictionary<string, string>> map, CancellationToken ct)
    {
        // Kibana stores fieldFormatMap DOUBLE-ENCODED: a JSON string inside the attributes object,
        // the same shape panelsJSON uses on a dashboard.
        var formatMap = new JsonObject();
        foreach (var (field, pairs) in map.OrderBy(p => p.Key, StringComparer.Ordinal))
        {
            var entries = new JsonArray();
            foreach (var (key, value) in pairs.OrderBy(p => p.Key, StringComparer.Ordinal))
                entries.Add(new JsonObject { ["key"] = key, ["value"] = value });

            // unknownKeyValue is deliberately ABSENT. An id with no entry renders as itself, a raw
            // GUID. Setting it would render every unmapped entity as one shared string, collapsing
            // two unlabelled steps into a single legend bucket.
            formatMap[field] = new JsonObject
            {
                ["id"] = "static_lookup",
                ["params"] = new JsonObject { ["lookupEntries"] = entries },
            };
        }

        var payload = new JsonObject
        {
            ["attributes"] = new JsonObject
            {
                // ONLY this attribute. Verified on 8.15.5 that the saved-objects PUT is a partial
                // update at attribute granularity: title, timeFieldName, fields, fieldAttrs,
                // runtimeFieldMap, sourceFilters, name and allowHidden all survive. Sending the
                // whole data view would mean a read-modify-write and a lost-update race with
                // anything else editing it.
                ["fieldFormatMap"] = formatMap.ToJsonString(),
            },
        };

        var client = CreateClient();
        using var content = new StringContent(payload.ToJsonString(), Encoding.UTF8, "application/json");
        using var response = await client.PutAsync(
            $"/api/saved_objects/index-pattern/{_options.DataViewId}", content, ct);
        response.EnsureSuccessStatusCode();
    }

    private HttpClient CreateClient()
    {
        var client = _httpFactory.CreateClient(nameof(KibanaLookupPublisher));
        client.BaseAddress = new Uri(_options.BaseUrl!);
        // Kibana rejects every non-GET without this header, with a 400 that does not say so.
        client.DefaultRequestHeaders.Add("kbn-xsrf", "true");
        if (!string.IsNullOrWhiteSpace(_options.ApiKey))
            client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("ApiKey", _options.ApiKey);
        return client;
    }
}
