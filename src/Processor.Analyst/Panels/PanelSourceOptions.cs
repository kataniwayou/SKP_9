namespace Processor.Analyst.Panels;

/// <summary>
/// Where the panel sources live. Bound from <c>Analyst:Panels:*</c>.
/// <para>
/// In-cluster these are service DNS names (Elasticsearch's own service, Prometheus's own service).
/// From a dev machine they are the forwarded ports from <c>k8s/port-forward-realstack.ps1</c> —
/// Elasticsearch <c>19200</c>, Prometheus <c>19090</c> — never the defaults: a dead forward keeps its
/// socket bound, so the default port looks free while refusing every connection, and the offset
/// ports are the only ones actually live.
/// </para>
/// </summary>
internal sealed class PanelSourceOptions
{
    public string? ElasticBaseUrl { get; set; }

    public string? PrometheusBaseUrl { get; set; }
}
