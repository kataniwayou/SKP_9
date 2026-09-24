namespace Processor.Analyst.Panels;

/// <summary>
/// The real <see cref="IPanelReader"/>: dispatches each panel to Elasticsearch or Prometheus by its
/// registered <see cref="PanelKind"/> and translates any transport failure into
/// <see cref="PanelUnavailableException"/>. A source that cannot be reached means the analysis could
/// not run -- both <see cref="ElasticPanelSource"/> and <see cref="PrometheusPanelSource"/> already
/// throw that exception for their own transport failures, so this class adds nothing beyond routing
/// and the case a caller asks for a panel id the registry does not have.
/// </summary>
internal sealed class LivePanelReader(ElasticPanelSource elastic, PrometheusPanelSource prometheus) : IPanelReader
{
    public PanelDescriptor Describe(string panelId)
    {
        var definition = Find(panelId);
        return new PanelDescriptor(definition.PanelId, definition.Layer, definition.Description);
    }

    public Task<PanelReading> ReadAsync(string panelId, TimeRange range, CancellationToken ct)
    {
        var definition = Find(panelId);

        return definition.Kind switch
        {
            PanelKind.Elastic => elastic.ReadAsync(definition, range, ct),
            PanelKind.Prometheus => prometheus.ReadAsync(definition, range, ct),
            _ => throw new PanelUnavailableException(panelId, $"panel kind {definition.Kind} has no source"),
        };
    }

    private static PanelDefinition Find(string panelId)
        => PanelRegistry.All.FirstOrDefault(p => p.PanelId == panelId)
           ?? throw new ArgumentException($"panel '{panelId}' is not in the panel registry", nameof(panelId));
}
