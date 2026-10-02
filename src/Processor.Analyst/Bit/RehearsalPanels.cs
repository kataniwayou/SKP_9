using Processor.Analyst.Panels;

namespace Processor.Analyst.Bit;

/// <summary>
/// Invented panel readings with a known answer, served from memory. The evidence half of the
/// rehearsal: the loop is real, the model is real, only the data is fabricated — which is the whole
/// point, because a conclusion can only be marked right or wrong against data whose content is
/// already known.
/// <para>
/// <b>Compiled in rather than loaded from disk.</b> These are part of the gate, so they must travel
/// with the image and change only through a rebuild, exactly like <see cref="BitPrompt"/>. A file
/// would let the standard a prompt is judged against drift without anything moving the SourceHash.
/// </para>
/// </summary>
internal sealed class RehearsalPanels : IPanelReader
{
    /// <summary>Every panel reads cleanly and every counter is benign: there is nothing to report.</summary>
    internal static RehearsalPanels Quiet() => new(deadLetterDepth: 0);

    /// <summary>
    /// The same window with one unambiguous fault: work thrown away DURING the window. A dead-letter
    /// queue grows from 0 to 17 while 17 parked refusals land in the same window, so two panels agree
    /// on the same loss and the insight is there to be drawn.
    /// <para>
    /// <b>Not a standing depth.</b> A depth that sits flat across the window with no refusals is an
    /// old backlog, which the prompt is allowed to rule out from other panels; planting one here
    /// would fail every prompt that reasons correctly. Growth matched by parked refusals cannot be
    /// explained away, so a prompt that stays silent here has missed real loss.
    /// </para>
    /// </summary>
    internal static RehearsalPanels HoldingDiscardedWork() => new(deadLetterDepth: 17);

    private readonly Dictionary<string, PanelReading> _readings;

    private RehearsalPanels(int deadLetterDepth)
    {
        PanelReading Clean(string id, string layer, string json, int samples)
            => new(id, layer, json, samples,
                new PanelTrust(SeriesPresent: true, WindowFullyCovered: true, NoDataDistinguishable: true));

        _readings = new()
        {
            ["step-outcomes"] = Clean("step-outcomes", "business",
                """{"Completed":412,"Failed":0,"Cancelled":3}""", 415),
            ["step-failures"] = Clean("step-failures", "business",
                """{"failed":0,"samples":[]}""", 0),
            ["refused-messages"] = Clean("refused-messages", "business",
                deadLetterDepth == 0
                    ? """{"refusals":0,"parked":0,"notParked":0,"samples":[]}"""
                    : "{\"refusals\":" + deadLetterDepth + ",\"parked\":" + deadLetterDepth
                      + ",\"notParked\":0,\"samples\":[{\"template\":\"the delivery was parked\","
                      + "\"exception\":\"the step's input could not be read from L2\"}]}",
                deadLetterDepth),
            ["run-boundaries"] = Clean("run-boundaries", "business",
                """{"totalWorkflowRecords":240,"fires":30,"importerPolls":30,"pollsThatImported":0,"drainedPolls":30,"byStep":[{"role":"entry","step":"importer","outcomes":30}]}""", 30),
            ["queue-wait"] = Clean("queue-wait", "ops",
                """{"meanSeconds":0.013,"maxSeconds":0.021}""", 91),
            ["processor-liveness"] = Clean("processor-liveness", "ops",
                """{"readyRatio":1.0,"replicas":2}""", 60),
            ["dead-letter-depth"] = Clean("dead-letter-depth", "ops",
                "{\"queues\":{\"processor-a.dead\":{\"windowStart\":0,\"windowEnd\":" + deadLetterDepth
                + "},\"processor-b.dead\":{\"windowStart\":0,\"windowEnd\":0}}}", 60),
        };
    }

    /// <summary>A string[] because <c>AnalystConfig.PanelSet</c> takes one.</summary>
    internal string[] PanelIds => [.. _readings.Keys];

    public PanelDescriptor Describe(string panelId) =>
        _readings.TryGetValue(panelId, out var reading)
            ? new PanelDescriptor(panelId, reading.Layer, $"rehearsal panel {panelId}")
            : throw new ArgumentException($"no rehearsal panel '{panelId}'", nameof(panelId));

    public Task<PanelReading> ReadAsync(
        string panelId, Guid targetWorkflowId, TimeRange range, CancellationToken ct) =>
        _readings.TryGetValue(panelId, out var reading)
            ? Task.FromResult(reading)
            : throw new PanelUnavailableException(panelId, "not part of the rehearsal");
}
