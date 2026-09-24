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

    public Task<PanelReading> ReadAsync(string panelId, Guid targetWorkflowId, TimeRange range, CancellationToken ct)
    {
        var definition = Find(panelId);

        return definition.Kind switch
        {
            PanelKind.Elastic => elastic.ReadAsync(definition, targetWorkflowId, range, ct),
            PanelKind.Prometheus => prometheus.ReadAsync(definition, targetWorkflowId, range, ct),
            _ => throw new PanelUnavailableException(panelId, $"panel kind {definition.Kind} has no source"),
        };
    }

    /// <summary>
    /// F3: an unknown panel id is the same class of problem as an unreachable source -- the
    /// investigation cannot proceed on it -- so it throws the same domain exception as everything
    /// else in this file, not a raw <see cref="ArgumentException"/>. That used to escape uncaught to
    /// <c>AnalystProcessor</c>, which only catches <see cref="AnalysisImpossibleException"/> and a
    /// filtered <see cref="OperationCanceledException"/>, landing in the framework's generic fault
    /// branch as "the transform faulted" with a stack trace instead of a clean failed step.
    /// <c>AnalystProcessor.AnalyseAsync</c> now validates <c>config.PanelSet</c> against this same
    /// registry before a dispatch ever reaches here, so this is defence in depth, not the only guard.
    /// </summary>
    private static PanelDefinition Find(string panelId)
        => PanelRegistry.All.FirstOrDefault(p => p.PanelId == panelId)
           ?? throw new PanelUnavailableException(panelId, "panel is not in the panel registry");
}
