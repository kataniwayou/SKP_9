namespace BaseApi.Service.Features.Lookup;

public sealed class ElasticLookupOptions
{
    public const string SectionName = "Elasticsearch";
    public string? BaseUrl { get; set; }
    public string IndexName { get; set; } = "skp-entity-lookup";
    public string PolicyName { get; set; } = "skp-entity-lookup";
    public string PipelineName { get; set; } = "logs@custom";
}
