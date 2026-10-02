using System.Globalization;
using System.Text.Json;
using Messaging.Contracts;
using Processor.Analyst.Graph;
using Processor.Analyst.Panels;

namespace Processor.Analyst.Bit;

/// <summary>One step's share of a rehearsal window: its outcomes by result, and deliveries parked before it produced one.</summary>
internal sealed record RehearsalStep(Guid StepId, int Completed, int Failed, int Cancelled, int Parked)
{
    /// <summary>The outcome records the step wrote. A parked delivery writes none.</summary>
    internal int Outcomes => Completed + Failed + Cancelled;

    /// <summary>The deliveries routed to the step, whether or not they produced an outcome.</summary>
    internal int Entered => Outcomes + Parked;
}

/// <summary>
/// Invented panel readings with a known answer, served from memory. The evidence half of the
/// rehearsal: the loop is real, the model is real, only the data is fabricated — which is the whole
/// point, because a conclusion can only be marked right or wrong against data whose content is
/// already known.
/// <para>
/// <b>Every count is one the <see cref="RehearsalGraph"/> routing explains.</b> A v12 prompt sets the
/// step-outcomes totals against the items the importer took in and the routing; a fixture whose
/// numbers do not add up plants a fault nobody intended, and fails every prompt that does the
/// arithmetic. The readings are therefore built from one per-step <see cref="Ledger"/>, and
/// <c>RehearsalFixtureTests</c> walks it against the graph.
/// </para>
/// <para>
/// <b>In the live sources' shapes.</b> Each reading has the keys the deployed Elastic and Prometheus
/// sources produce, pinned against a captured window, so a prompt is never rehearsed on a panel it
/// will not meet in production. Series are generated across the window the loop asks for.
/// </para>
/// <para>
/// <b>Compiled in rather than loaded from disk.</b> These are part of the gate, so they must travel
/// with the image and change only through a rebuild, exactly like <see cref="BitPrompt"/>. A file
/// would let the standard a prompt is judged against drift without anything moving the SourceHash.
/// </para>
/// </summary>
internal sealed class RehearsalPanels : IPanelReader
{
    internal const int Fires = 15;
    internal const int DrainedPolls = 5;
    internal const int RecordsImported = 40;

    private const int RejectedItems = 6;
    private const int LostItems = 17;
    private static readonly TimeSpan Step = TimeSpan.FromSeconds(15);

    /// <summary>
    /// A busy window with nothing to report, and the traps a prompt must not mistake for faults:
    /// 6 items failed validation for a cause in the item itself, and 5 polls found nothing and
    /// cancelled with no terminal record. terminal reads 34 at persist-file (the good items' Completed
    /// exit) and 6 at record-outcome (the rejected items' exit). Every count is the routing doing its job.
    /// </summary>
    internal static RehearsalPanels Quiet() => new(lost: 0);

    /// <summary>
    /// The same window with one unambiguous fault: work thrown away DURING the window. 17 of the 34
    /// deliveries to persist-file were parked because their input could not be read, so its dead-letter queue
    /// grows from 0 to 17, 17 parked refusals land, the step-outcomes totals fall 17 short of what
    /// the routing predicts for 40 imported items, and terminal at persist-file reads 17 against 34
    /// good items. Four readings agree on the same loss.
    /// <para>
    /// <b>Not a standing depth.</b> A depth that sits flat across the window with no refusals is an
    /// old backlog, which the prompt is allowed to rule out from other panels; planting one here
    /// would fail every prompt that reasons correctly. Growth matched by parked refusals cannot be
    /// explained away, so a prompt that stays silent here has missed real loss.
    /// </para>
    /// </summary>
    internal static RehearsalPanels HoldingDiscardedWork() => new(lost: LostItems);

    private readonly int _lost;

    private RehearsalPanels(int lost)
    {
        _lost = lost;
        var good = RecordsImported - RejectedItems;

        Ledger =
        [
            new(RehearsalGraph.ImportStep, Completed: RecordsImported, Failed: 0, Cancelled: DrainedPolls, Parked: 0),
            new(RehearsalGraph.ValidateStep, Completed: good, Failed: RejectedItems, Cancelled: 0, Parked: 0),
            new(RehearsalGraph.PersistStep, Completed: good - lost, Failed: 0, Cancelled: 0, Parked: lost),
            new(RehearsalGraph.RecordStep, Completed: RejectedItems, Failed: 0, Cancelled: 0, Parked: 0),
        ];
    }

    /// <summary>What every step did in the window; every reading below is derived from it.</summary>
    internal IReadOnlyList<RehearsalStep> Ledger { get; }

    /// <summary>A string[] because <c>AnalystConfig.PanelSet</c> takes one.</summary>
    internal string[] PanelIds =>
        ["step-outcomes", "run-boundaries", "step-failures", "refused-messages",
         "dead-letter-depth", "queue-wait", "processor-liveness"];

    private static string Layer(string panelId) => panelId switch
    {
        "dead-letter-depth" or "queue-wait" or "processor-liveness" => "ops",
        _ => "business",
    };

    public PanelDescriptor Describe(string panelId) =>
        PanelIds.Contains(panelId)
            ? new PanelDescriptor(panelId, Layer(panelId), $"rehearsal panel {panelId}")
            : throw new ArgumentException($"no rehearsal panel '{panelId}'", nameof(panelId));

    public Task<PanelReading> ReadAsync(
        string panelId, Guid targetWorkflowId, TimeRange range, CancellationToken ct) =>
        PanelIds.Contains(panelId)
            ? Task.FromResult(Build(panelId, range))
            : throw new PanelUnavailableException(panelId, "not part of the rehearsal");

    private int Outcomes => Ledger.Sum(s => s.Outcomes);

    /// <summary>Every log record of the workflow in the window, the scope count the Elastic panels report.</summary>
    private int WorkflowRecords => Outcomes * 6 + Fires * 3 + _lost;

    private PanelReading Build(string panelId, TimeRange range)
    {
        var (value, samples) = panelId switch
        {
            "step-outcomes" => (Serialize(new
            {
                totalOutcomeRecords = Outcomes,
                completed = Ledger.Sum(s => s.Completed),
                failed = Ledger.Sum(s => s.Failed),
                cancelled = Ledger.Sum(s => s.Cancelled),
            }), Outcomes),
            "run-boundaries" => RunBoundaries(),
            "step-failures" => (Serialize(new
            {
                totalOutcomeRecords = Outcomes,
                failedCount = Ledger.Sum(s => s.Failed),
                samples = Enumerable.Range(0, Math.Min(5, RejectedItems)).Select(i => new Dictionary<string, object>
                {
                    ["@timestamp"] = EpochMillis(range.To - TimeSpan.FromSeconds(40 + 150 * i)),
                    ["scope"] = new { name = "BaseProcessor.Core.Processing.ProcessDispatchHandler" },
                    ["attributes"] = new
                    {
                        WorkflowId = RehearsalGraph.WorkflowId.ToString("D"),
                        Result = "Failed",
                        StepId = RehearsalGraph.ValidateStep.ToString("D"),
                    },
                    ["body"] = new
                    {
                        text = $"the author reported the step failed: fetching item-{1007 + 6 * i:D6}.dat failed: "
                             + "the extension '.dat' is not one of the allowed extensions [.zip]",
                    },
                }),
            }), Outcomes),
            "refused-messages" => (Serialize(new
            {
                totalWorkflowRecords = WorkflowRecords,
                refusedCount = _lost,
                parked = _lost,
                notParked = 0,
                byQueue = _lost == 0
                    ? new Dictionary<string, int>()
                    : new Dictionary<string, int> { [PersisterQueue] = _lost },
                samples = Enumerable.Range(0, Math.Min(5, _lost)).Select(i => new Dictionary<string, object>
                {
                    ["@timestamp"] = EpochMillis(range.To - TimeSpan.FromSeconds(25 + 50 * i)),
                    ["attributes"] = new Dictionary<string, object>
                    {
                        ["Queue"] = PersisterQueue,
                        ["Type"] = "ProcessDispatch",
                        ["StepId"] = RehearsalGraph.PersistStep.ToString("D"),
                        ["ProcessorId"] = RehearsalGraph.PersisterProcessor.ToString("D"),
                        ["exception"] = new
                        {
                            type = "System.InvalidOperationException",
                            message = "the step's input could not be read from L2",
                        },
                        ["{OriginalFormat}"] = RefusalTemplates.Parked,
                    },
                }),
            }), WorkflowRecords),
            "dead-letter-depth" => Series(range, "queue",
                new[] { "orchestrator-control.dead", ValidatorQueue + ".dead", PersisterQueue + ".dead", RecorderQueue + ".dead" },
                (queue, i, n) => queue == PersisterQueue + ".dead" ? (double)(_lost * i / (n - 1)) : 0),
            "queue-wait" => Series(range, "service_instance_id",
                new[] { "orchestrator-0", "processor-filefetcher-0", "processor-filepersister-0" },
                (_, i, _) => 0.012 + 0.001 * (i % 4)),
            "processor-liveness" => Series(range, "service_instance_id",
                new[] { "processor-kafkaimporter-0", "processor-filefetcher-0", "processor-filepersister-0", "processor-outcomerecorder-0" },
                (_, _, _) => 1),
            _ => throw new PanelUnavailableException(panelId, "not part of the rehearsal"),
        };

        return new PanelReading(panelId, Layer(panelId), value, samples,
            new PanelTrust(SeriesPresent: true, WindowFullyCovered: true, NoDataDistinguishable: true));
    }

    private (string Value, int Samples) RunBoundaries()
    {
        var graph = RehearsalGraph.Graph;
        var rows = graph.EntryStepIds
            .Select(id => new { role = StepRoles.Entry, step = graph.Names[id], records = Fires })
            .Concat(graph.Steps
                .Select(s => new { s.StepId, records = TerminalRecords(s, graph.Steps) })
                .Where(t => t.records > 0)
                .Select(t => new { role = StepRoles.Terminal, step = graph.Names[t.StepId], t.records }))
            .ToList();

        return (Serialize(new
        {
            totalWorkflowRecords = WorkflowRecords,
            fires = Fires,
            importerPolls = Fires,
            pollsThatImported = Fires - DrainedPolls,
            drainedPolls = DrainedPolls,
            recordsImported = RecordsImported,
            byStep = rows,
        }), rows.Sum(r => r.records));
    }

    /// <summary>
    /// The orchestrator's terminal rule applied to the ledger: every outcome of a step with no
    /// successors, or the Completed outcomes of a step whose successors all decline Completed.
    /// </summary>
    private int TerminalRecords(StepL1 step, IReadOnlyList<StepL1> steps)
    {
        var ledger = Ledger.Single(l => l.StepId == step.StepId);
        if (step.NextStepIds.Count == 0)
        {
            return ledger.Outcomes;
        }

        var completedAdvances = step.NextStepIds
            .Select(id => steps.Single(s => s.StepId == id))
            .Any(next => GraphRenderer.Accepts(next.EntryCondition, StepResult.Completed));

        return completedAdvances ? 0 : ledger.Completed;
    }

    private static string ValidatorQueue => $"processor-{RehearsalGraph.ValidatorProcessor:D}";
    private static string PersisterQueue => $"processor-{RehearsalGraph.PersisterProcessor:D}";
    private static string RecorderQueue => $"processor-{RehearsalGraph.RecorderProcessor:D}";

    /// <summary>One series per label value, a point every 15 seconds from the window's start to its end.</summary>
    private static (string Value, int Samples) Series(
        TimeRange range, string label, string[] values, Func<string, int, int, double> at)
    {
        var times = new List<DateTimeOffset>();
        for (var t = range.From; t < range.To; t += Step)
        {
            times.Add(t);
        }
        times.Add(range.To);

        var series = values.Select(v => new
        {
            labels = new Dictionary<string, string> { [label] = v },
            points = times.Select((t, i) => new { timestamp = t, value = at(v, i, times.Count) }),
        }).ToList();

        return (Serialize(new { seriesCount = series.Count, series }), values.Length * times.Count);
    }

    private static string EpochMillis(DateTimeOffset t)
        => t.ToUnixTimeMilliseconds().ToString(CultureInfo.InvariantCulture) + ".000000";

    private static string Serialize<T>(T value) => JsonSerializer.Serialize(value);
}
