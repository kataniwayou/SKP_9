using Processor.Analyst.Panels;

namespace BaseApi.Tests.Analyst;

/// <summary>
/// Panels served from memory. This is what lets the whole five-stage loop be exercised with no
/// Elasticsearch, no Prometheus and no cluster — and it is the same seam the scored-window replay
/// will use later to judge one prompt against another.
/// </summary>
internal sealed class FixturePanelReader : IPanelReader
{
    private readonly Dictionary<string, PanelReading> _readings = [];
    private readonly Dictionary<string, string> _failures = [];
    private readonly Dictionary<string, PanelDescriptor> _descriptors = [];

    internal FixturePanelReader Reading(string panelId, string layer, string valueJson, int samples)
    {
        _readings[panelId] = new PanelReading(
            panelId, layer, valueJson, samples,
            new PanelTrust(SeriesPresent: true, WindowFullyCovered: true, NoDataDistinguishable: true));
        _descriptors[panelId] = new PanelDescriptor(panelId, layer, $"fixture panel {panelId}");
        return this;
    }

    /// <summary>A panel that answered, but whose series was not there — the orphaned-instrument case.</summary>
    internal FixturePanelReader MissingSeries(string panelId, string layer = "ops")
    {
        _readings[panelId] = new PanelReading(
            panelId, layer, "{}", 0,
            new PanelTrust(SeriesPresent: false, WindowFullyCovered: false, NoDataDistinguishable: false));
        _descriptors[panelId] = new PanelDescriptor(panelId, layer, $"fixture panel {panelId}");
        return this;
    }

    /// <summary>A panel whose source could not be reached at all.</summary>
    internal FixturePanelReader Failing(string panelId, string why)
    {
        _failures[panelId] = why;
        _descriptors[panelId] = new PanelDescriptor(panelId, "ops", $"fixture panel {panelId}");
        return this;
    }

    public PanelDescriptor Describe(string panelId)
        => _descriptors.TryGetValue(panelId, out var d)
            ? d
            : new PanelDescriptor(panelId, "unknown", "not configured in this fixture");

    public Task<PanelReading> ReadAsync(string panelId, TimeRange range, CancellationToken ct)
    {
        if (_failures.TryGetValue(panelId, out var why))
        {
            throw new PanelUnavailableException(panelId, why);
        }

        if (!_readings.TryGetValue(panelId, out var reading))
        {
            throw new PanelUnavailableException(panelId, "not configured in this fixture");
        }

        return Task.FromResult(reading);
    }
}
