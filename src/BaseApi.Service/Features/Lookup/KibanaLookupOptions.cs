namespace BaseApi.Service.Features.Lookup;

/// <summary>
/// Where Kibana is, and how eagerly to republish the id → name lookup table.
/// <para>
/// <b><see cref="BaseUrl"/> is optional, unlike every other address this service holds.</b> Postgres
/// and the broker are fail-fast because nothing works without them; Kibana is a consumer of a
/// convenience. Leaving it unset means "do not publish", so the API runs unchanged in environments
/// that have no Kibana — including the test host, which would otherwise need one.
/// </para>
/// <para>
/// This is a SERVER-TO-SERVER address, so the in-cluster Service name is the right value:
/// <c>http://kibana.skp.svc.cluster.local:5601</c>. It is not the address an operator's browser
/// uses, and it is emphatically not the diagram's base URL, which the browser does fetch.
/// </para>
/// </summary>
public sealed class KibanaLookupOptions
{
    public const string SectionName = "Kibana";

    /// <summary>Kibana's base URL, or null to disable publishing entirely.</summary>
    public string? BaseUrl { get; set; }

    /// <summary>The data view whose <c>fieldFormatMap</c> carries the lookup table.</summary>
    public string DataViewId { get; set; } = "skp-logs";

    /// <summary>
    /// An API key, sent as <c>Authorization: ApiKey ...</c>. Null for an unsecured Kibana.
    /// <para>
    /// A credential belongs in configuration and nowhere else. It is deliberately not accepted from
    /// a request: the publish endpoint is unauthenticated, so honouring a caller-supplied
    /// destination or key would let anyone make this service post its credential to a host they
    /// chose.
    /// </para>
    /// </summary>
    public string? ApiKey { get; set; }

    /// <summary>
    /// How long a published table is trusted before the next render is allowed to rebuild it.
    /// <para>
    /// The trigger is a dashboard render, and a render asks once per page load per operator, with
    /// auto-refresh on top. Without a floor this would rebuild the map from Postgres on every
    /// reload. Kibana is still spared by the content hash, but the database is not.
    /// </para>
    /// </summary>
    public TimeSpan MinimumInterval { get; set; } = TimeSpan.FromMinutes(5);
}
