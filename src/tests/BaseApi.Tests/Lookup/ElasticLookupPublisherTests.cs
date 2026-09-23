using System.Net;
using System.Text;
using BaseApi.Service.Features.Lookup;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using NSubstitute;
using Xunit;

namespace BaseApi.Tests.Lookup;

/// <summary>
/// The publisher writes the id → name table into Elasticsearch at workflow start. These cover the
/// mechanics that are silent when wrong: a row addressed by anything but its entity id turns a
/// republish into a duplicate row, and a bulk write that is never followed by a policy execute
/// leaves the materialised snapshot holding the previous table while every call still returns 200.
/// </summary>
public sealed class ElasticLookupPublisherTests
{
    private static readonly Guid StepId = Guid.Parse("5e36eb17-cbe2-4abb-ac87-4488ef115599");

    /// <summary>Records every request so the test can assert on what actually went over the wire.</summary>
    private sealed class RecordingHandler : HttpMessageHandler
    {
        public List<(HttpMethod Method, string Path, string Body)> Calls { get; } = new();

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken ct)
        {
            var body = request.Content is null ? string.Empty : await request.Content.ReadAsStringAsync(ct);
            Calls.Add((request.Method, request.RequestUri!.AbsolutePath, body));
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("{\"errors\":false}", Encoding.UTF8, "application/json"),
            };
        }
    }

    private static (ElasticLookupPublisher Publisher, RecordingHandler Handler) Build()
    {
        var handler = new RecordingHandler();
        var factory = Substitute.For<IHttpClientFactory>();
        factory.CreateClient(Arg.Any<string>()).Returns(_ => new HttpClient(handler, disposeHandler: false));

        var options = Options.Create(new ElasticLookupOptions
        {
            BaseUrl = "http://elasticsearch:9200",
            IndexName = "skp-entity-lookup",
            PolicyName = "skp-entity-lookup",
        });

        return (new ElasticLookupPublisher(factory, options, NullLogger<ElasticLookupPublisher>.Instance), handler);
    }

    /// <summary>
    /// WITHOUT AN EXPLICIT _id ELASTICSEARCH MINTS ONE, so the second start of the same workflow
    /// appends a second row for the same entity rather than replacing the first. A match policy
    /// returns one match, so the name a document is enriched with would then be whichever row the
    /// policy happened to find — stable enough to look correct and arbitrary enough to be wrong.
    /// </summary>
    [Fact]
    public async Task Bulk_addresses_each_row_by_its_entity_id()
    {
        var (publisher, handler) = Build();

        await publisher.PublishAsync(
            new[] { new LookupRow(StepId, "simple-stepB", "1.0.0", "step") }, CancellationToken.None);

        var bulk = handler.Calls.Single(c => c.Path.EndsWith("_bulk", StringComparison.Ordinal));
        Assert.Contains($"\"_id\":\"{StepId}\"", bulk.Body);
    }

    /// <summary>
    /// A BULK WRITE ALONE CHANGES NOTHING THE PIPELINE CAN SEE. The enrich processor reads the
    /// materialised .enrich-* index, which only the execute rebuilds, so a publish that stops after
    /// the bulk leaves every document enriched from the PREVIOUS table while both calls return 200.
    /// The order matters as much as the presence: executing before the rows land materialises the
    /// table as it was.
    /// </summary>
    [Fact]
    public async Task Policy_is_executed_after_the_rows_are_written()
    {
        var (publisher, handler) = Build();

        await publisher.PublishAsync(
            new[] { new LookupRow(StepId, "simple-stepB", "1.0.0", "step") }, CancellationToken.None);

        var bulk = handler.Calls.FindIndex(c => c.Path.EndsWith("_bulk", StringComparison.Ordinal));
        var execute = handler.Calls.FindIndex(c => c.Path.EndsWith("/_execute", StringComparison.Ordinal));

        Assert.True(execute >= 0, "the enrich policy was never executed");
        Assert.True(execute > bulk, "the policy was executed before the rows were written");
    }

    /// <summary>
    /// NOTHING ELSE CREATES THESE THREE. The point of moving the table out of Kibana was that no
    /// human step remains, so a fresh environment has to provision itself: the source index, the
    /// match policy that reads it, and the logs@custom pipeline that x-pack's managed
    /// logs@default-pipeline already calls but which does not exist by default. Miss any one and
    /// records index perfectly well, unnamed, for as long as nobody looks.
    /// </summary>
    [Fact]
    public async Task Provisioning_creates_the_index_the_policy_and_the_pipeline()
    {
        var (publisher, handler) = Build();

        await publisher.EnsureProvisionedAsync(CancellationToken.None);

        var puts = handler.Calls.Where(c => c.Method == HttpMethod.Put).Select(c => c.Path).ToList();
        Assert.Contains(puts, p => p.EndsWith("/skp-entity-lookup", StringComparison.Ordinal));
        Assert.Contains(puts, p => p.Contains("_enrich/policy/skp-entity-lookup", StringComparison.Ordinal));
        Assert.Contains(puts, p => p.EndsWith("_ingest/pipeline/logs@custom", StringComparison.Ordinal));
    }

    /// <summary>
    /// THE TEST HOST HAS NO ELASTICSEARCH, and neither does any environment that just wants the API.
    /// An unset base URL therefore has to mean "do not publish" rather than "fail": the alternative
    /// is every unrelated test needing a log store, or a start path that throws on a machine where
    /// naming was never wanted. Nothing goes over the wire and nothing is raised.
    /// </summary>
    [Fact]
    public async Task No_base_url_publishes_nothing_and_does_not_throw()
    {
        var handler = new RecordingHandler();
        var factory = Substitute.For<IHttpClientFactory>();
        factory.CreateClient(Arg.Any<string>()).Returns(_ => new HttpClient(handler, disposeHandler: false));
        var publisher = new ElasticLookupPublisher(
            factory,
            Options.Create(new ElasticLookupOptions { BaseUrl = null }),
            NullLogger<ElasticLookupPublisher>.Instance);

        await publisher.EnsureProvisionedAsync(CancellationToken.None);
        await publisher.PublishAsync(
            new[] { new LookupRow(StepId, "simple-stepB", "1.0.0", "step") }, CancellationToken.None);

        Assert.Empty(handler.Calls);
    }

    /// <summary>
    /// A PIPELINE HOLDING AN ENRICH PROCESSOR IS REFUSED UNTIL THE POLICY HAS BEEN EXECUTED, not
    /// merely created. Elasticsearch validates the processor against the materialised .enrich-*
    /// index, and creating the policy does not make one: PUT _ingest/pipeline answers 500 with
    /// "no enrich index exists for policy with name [...]".
    /// <para>
    /// That lands precisely on a fresh cluster — the case provisioning exists for — because nothing
    /// has executed the policy yet at boot. An execute over the empty source index is what makes the
    /// pipeline creatable, so it belongs in provisioning rather than being left to the first start.
    /// </para>
    /// </summary>
    [Fact]
    public async Task Provisioning_materialises_the_policy_before_creating_the_pipeline()
    {
        var (publisher, handler) = Build();

        await publisher.EnsureProvisionedAsync(CancellationToken.None);

        var execute  = handler.Calls.FindIndex(c => c.Path.EndsWith("/_execute", StringComparison.Ordinal));
        var pipeline = handler.Calls.FindIndex(c => c.Path.EndsWith("_ingest/pipeline/logs@custom", StringComparison.Ordinal));

        Assert.True(execute >= 0, "the policy was never executed, so the pipeline cannot be created");
        Assert.True(execute < pipeline, "the pipeline was created before the policy was materialised");
    }

    /// <summary>
    /// THE LABEL A CONTROL SHOWS IS NAME + VERSION, matching what the retired Kibana formatter
    /// rendered. A control binds one field for both its options and its filter, so the readable
    /// half has to be a single value — a bare name would make two versions of one workflow
    /// indistinguishable in the dropdown while still filtering correctly, which is the worst of
    /// both. The table keeps name and version as separate columns; only the stamped label joins them.
    /// </summary>
    [Fact]
    public async Task Stamped_label_carries_name_and_version()
    {
        var (publisher, handler) = Build();

        await publisher.EnsureProvisionedAsync(CancellationToken.None);

        var pipeline = handler.Calls.Single(c => c.Path.EndsWith("_ingest/pipeline/logs@custom", StringComparison.Ordinal));
        foreach (var prefix in new[] { "_wf", "_st", "_pr" })
            Assert.Contains($"{{{{{{{prefix}.name}}}}}}_{{{{{{{prefix}.version}}}}}}", pipeline.Body);
    }

    /// <summary>
    /// EVERY set THAT READS A FIELD MUST FIRST CHECK IT IS THERE, or the pipeline rejects the
    /// document outright.
    /// <para>
    /// <c>copy_from</c> against an absent path throws "field [WorkflowId] not present as part of
    /// path [attributes.WorkflowId]", and an unhandled throw inside logs@custom fails the whole
    /// indexing request — the record is not indexed unnamed, it is not indexed at all. Most records
    /// in this system carry no ids: health probes, startup logs, anything outside a workflow. First
    /// measured live at 4,279 rejected out of 29,518 processed, which is data loss disguised as a
    /// naming feature.
    /// </para>
    /// <para>
    /// Asserted structurally rather than behaviourally because the fake transport cannot execute a
    /// pipeline: every processor reading a source field carries an <c>if</c>.
    /// </para>
    /// </summary>
    [Fact]
    public async Task Every_fallback_set_guards_the_field_it_copies_from()
    {
        var (publisher, handler) = Build();

        await publisher.EnsureProvisionedAsync(CancellationToken.None);

        var pipeline = handler.Calls.Single(c => c.Path.EndsWith("_ingest/pipeline/logs@custom", StringComparison.Ordinal));
        using var doc = System.Text.Json.JsonDocument.Parse(pipeline.Body);

        var unguarded = new List<string>();
        foreach (var processor in doc.RootElement.GetProperty("processors").EnumerateArray())
        {
            if (!processor.TryGetProperty("set", out var set)) continue;
            if (!set.TryGetProperty("copy_from", out var from)) continue;
            if (!set.TryGetProperty("if", out _))
                unguarded.Add(from.GetString()!);
        }

        Assert.Empty(unguarded);
    }
}
