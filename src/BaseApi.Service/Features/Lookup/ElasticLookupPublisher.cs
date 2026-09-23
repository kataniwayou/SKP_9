using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace BaseApi.Service.Features.Lookup;

public sealed class ElasticLookupPublisher : IEntityLookupPublisher
{
    private readonly IHttpClientFactory _httpFactory;
    private readonly ElasticLookupOptions _options;
    private readonly ILogger<ElasticLookupPublisher> _log;

    public ElasticLookupPublisher(
        IHttpClientFactory httpFactory,
        IOptions<ElasticLookupOptions> options,
        ILogger<ElasticLookupPublisher> log)
    {
        _httpFactory = httpFactory;
        _options = options.Value;
        _log = log;
    }

    /// <summary>
    /// Creates the three Elasticsearch objects this feature owns. Idempotent: every call is a PUT of
    /// the same definition, so running it on every boot converges rather than accumulating.
    /// <para>
    /// <b>logs@custom is an extension slot, not an override.</b> x-pack's managed
    /// <c>logs@default-pipeline</c> — already set as <c>index.default_pipeline</c> on the data
    /// stream — ends by calling <c>logs@custom</c> with <c>ignore_missing_pipeline: true</c>, and
    /// that pipeline does not exist by default. Writing it therefore needs no template edit, no
    /// rollover and no managed object touched.
    /// </para>
    /// </summary>
    public async Task EnsureProvisionedAsync(CancellationToken ct)
    {
        if (!Enabled)
            return;

        var client = CreateClient();

        // Explicit keyword mapping. Left to dynamic mapping the id would still come out keyword, but
        // a match policy resolves its match_field against the source index, and a field that changed
        // type because one row arrived oddly would break enrichment rather than one document.
        await PutAsync(client, $"/{_options.IndexName}", """
            {"mappings":{"properties":{
              "id":{"type":"keyword"},"name":{"type":"keyword"},
              "version":{"type":"keyword"},"kind":{"type":"keyword"}}}}
            """, ct, tolerateExisting: true);

        await PutAsync(client, $"/_enrich/policy/{_options.PolicyName}", """
            {"match":{"indices":"INDEX","match_field":"id",
                      "enrich_fields":["name","version"]}}
            """.Replace("INDEX", _options.IndexName), ct, tolerateExisting: true);

        // THE POLICY IS EXECUTED BEFORE THE PIPELINE IS CREATED, and that is not an optimisation.
        // Elasticsearch validates an enrich processor against the MATERIALISED .enrich-* index, which
        // creating the policy does not produce, so the PUT below answers 500 -- "no enrich index
        // exists for policy with name [...]" -- on any cluster where the policy has never run. That
        // is exactly a fresh one, which is the case this method exists for. An execute over the
        // still-empty source index costs nothing and makes the pipeline creatable.
        using (var seeded = await client.PostAsync(
            $"/_enrich/policy/{_options.PolicyName}/_execute", content: null, ct))
        {
            seeded.EnsureSuccessStatusCode();
        }

        // ONE POLICY SERVES ALL THREE FIELDS. The ids are GUIDs and unique across workflows, steps
        // and processors, so the same table answers every one of them; the processors differ only in
        // which field they read and which they write.
        //
        // EVERY SET THAT READS A FIELD GUARDS IT FIRST. copy_from against an absent path throws --
        // "field [WorkflowId] not present as part of path [attributes.WorkflowId]" -- and an
        // unhandled throw in logs@custom fails the indexing request, so the record is not indexed
        // unnamed, it is DROPPED. Most records here carry no ids at all: health probes, startup
        // logs, anything outside a workflow. Measured before the guards: 4,279 documents rejected
        // out of 29,518 processed.
        //
        // EACH ENRICH IS FOLLOWED BY A SET WITH override:false. On a miss the enrich writes nothing,
        // and a panel grouping on an absent field produces a "missing" bucket that reads as a
        // different entity. Falling back to the id renders the raw GUID instead — the same choice the
        // Kibana formatter made by omitting unknownKeyValue, for the same reason.
        await PutAsync(client, $"/_ingest/pipeline/{_options.PipelineName}", """
            {"description":"skp entity id -> name",
             "processors":[
              {"enrich":{"policy_name":"POLICY","field":"attributes.WorkflowId","target_field":"_wf","ignore_missing":true}},
              {"set":{"if":"ctx._wf != null","field":"attributes.WorkflowName","value":"{{{_wf.name}}}_{{{_wf.version}}}"}},
              {"set":{"if":"ctx.attributes?.WorkflowId != null","field":"attributes.WorkflowName","copy_from":"attributes.WorkflowId","override":false}},
              {"enrich":{"policy_name":"POLICY","field":"attributes.StepId","target_field":"_st","ignore_missing":true}},
              {"set":{"if":"ctx._st != null","field":"attributes.StepName","value":"{{{_st.name}}}_{{{_st.version}}}"}},
              {"set":{"if":"ctx.attributes?.StepId != null","field":"attributes.StepName","copy_from":"attributes.StepId","override":false}},
              {"enrich":{"policy_name":"POLICY","field":"attributes.ProcessorId","target_field":"_pr","ignore_missing":true}},
              {"set":{"if":"ctx._pr != null","field":"attributes.ProcessorName","value":"{{{_pr.name}}}_{{{_pr.version}}}"}},
              {"set":{"if":"ctx.attributes?.ProcessorId != null","field":"attributes.ProcessorName","copy_from":"attributes.ProcessorId","override":false}},
              {"set":{"if":"ctx.attributes?.WhitelistRoot != null && ctx.attributes?.StepName != null",
                      "field":"attributes.WhitelistOwner",
                      "value":"{{{attributes.StepName}}} · {{{attributes.WhitelistRoot}}}"}},
              {"remove":{"field":["_wf","_st","_pr"],"ignore_missing":true}}]}
            """.Replace("POLICY", _options.PolicyName), ct, tolerateExisting: false);
    }

    private static async Task PutAsync(
        HttpClient client, string path, string json, CancellationToken ct, bool tolerateExisting)
    {
        using var content = new StringContent(json, Encoding.UTF8, "application/json");
        using var response = await client.PutAsync(path, content, ct);
        if (response.IsSuccessStatusCode)
            return;
        // A second replica booting concurrently loses the race to create the index, and an index
        // that already exists is the state this method wants. Only that one is tolerated.
        if (tolerateExisting && response.StatusCode == System.Net.HttpStatusCode.BadRequest)
            return;
        response.EnsureSuccessStatusCode();
    }

    public async Task PublishAsync(IReadOnlyCollection<LookupRow> rows, CancellationToken ct)
    {
        if (!Enabled || rows.Count == 0)
            return;

        var ndjson = new StringBuilder();
        foreach (var row in rows)
        {
            ndjson.Append(JsonSerializer.Serialize(new { index = new { _id = row.Id.ToString() } })).Append('\n');
            ndjson.Append(JsonSerializer.Serialize(
                new { id = row.Id.ToString(), name = row.Name, version = row.Version, kind = row.Kind })).Append('\n');
        }

        var client = CreateClient();
        using var content = new StringContent(ndjson.ToString(), Encoding.UTF8, "application/x-ndjson");
        using var response = await client.PostAsync($"/{_options.IndexName}/_bulk?refresh=true", content, ct);
        response.EnsureSuccessStatusCode();

        // THE EXECUTE IS THE PUBLISH. The bulk above only updates the source index; the enrich
        // processor reads the materialised .enrich-* copy, which nothing but this call rebuilds.
        // Stop after the bulk and every document is enriched from the previous table, with both
        // calls returning 200 -- the failure this class exists to make impossible.
        using var executed = await client.PostAsync(
            $"/_enrich/policy/{_options.PolicyName}/_execute", content: null, ct);
        executed.EnsureSuccessStatusCode();
    }

    /// <summary>
    /// Whether a log store was configured at all. An unset base URL is the documented way to turn
    /// this feature off, which is what lets the API and its tests run with no Elasticsearch.
    /// </summary>
    internal bool Enabled => !string.IsNullOrWhiteSpace(_options.BaseUrl);

    private HttpClient CreateClient()
    {
        var client = _httpFactory.CreateClient(nameof(ElasticLookupPublisher));
        client.BaseAddress = new Uri(_options.BaseUrl!);
        return client;
    }
}
