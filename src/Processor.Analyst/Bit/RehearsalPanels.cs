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
/// arithmetic. <c>RehearsalFixtureTests</c> therefore walks the <see cref="ClosedLedger"/> -- the fires
/// that entered in the window, followed to their end -- against the graph, and the readings are built
/// from the range's slice: those closed fires plus the edge residues the stamped panels also count.
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

    /// <summary>The rehearsal window's length; a history range always ends where the window does.</summary>
    private static readonly TimeSpan WindowLength = TimeSpan.FromMinutes(15);

    /// <summary>
    /// A busy window with nothing to report, and the traps a prompt must not mistake for faults:
    /// 6 items failed validation for a cause in the item itself, and 5 polls found nothing and
    /// cancelled with no terminal record. terminal reads 34 at persist-file (the good items' Completed
    /// exit) and 6 at record-outcome (the rejected items' exit). Every count is the routing doing its job.
    /// </summary>
    internal static RehearsalPanels Quiet() => new(lost: 0, RehearsalGraph.TestFeed);

    /// <summary>
    /// The quiet window's mix with no declared expectation: 15% of items fail validation for a
    /// cause in the item itself, in every bucket since the workflow's start, and nobody said that is
    /// expected. The failures are the same ones <see cref="Quiet"/> treats as the routing at work;
    /// only the missing declaration makes them a deterministic data problem the operator must hear of.
    /// </summary>
    internal static RehearsalPanels RejectingBadInput() => new(lost: 0, expectations: null);

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
    internal static RehearsalPanels HoldingDiscardedWork() => new(lost: LostItems, expectations: null);

    /// <summary>Failures of one fire that entered before the window, recorded inside it (edge-skew only).</summary>
    internal const int PreWindowFailures = 1;

    /// <summary>The last fire's good items still being persisted when the window closed (edge-skew only).</summary>
    internal const int InFlightAtEnd = 2;

    /// <summary>
    /// A healthy window whose edges do not cancel. A fire that entered before the window had 1 item
    /// fail and be recorded inside it, so the stamped panels count 7 failures while run-boundaries,
    /// which never sees that fire, has 6 terminal at record-outcome. The last fire's 2 good items were
    /// validated but still being persisted at the end, so persist-file reads 32 terminal against 34
    /// validated. Nothing was lost: no dead-letter growth, no refusal, and the failed share 7/40 is inside
    /// the declared 0.2. A history read from the start loses the start residue and keeps the end one.
    /// </summary>
    internal static RehearsalPanels EdgeSkewed()
        => new(lost: 0, RehearsalGraph.TestFeed, preWindowFailures: PreWindowFailures, inFlight: InFlightAtEnd);

    private readonly int _lost;
    private readonly int _preWindowFailures;
    private readonly int _inFlight;

    private RehearsalPanels(int lost, AnalystExpectations? expectations, int preWindowFailures = 0, int inFlight = 0)
    {
        _lost = lost;
        _preWindowFailures = preWindowFailures;
        _inFlight = inFlight;
        Expectations = expectations;

        var window = SliceOf(WindowLength, startsAfterTheRunBegan: true);
        ClosedLedger = window.Closed;
        Ledger = window.Stamped;
    }

    /// <summary>What the step payload declares as expected for this scenario's source; only the quiet windows declare any.</summary>
    internal AnalystExpectations? Expectations { get; }

    /// <summary>The fires that entered in the window, followed to their end: what the routing explains.</summary>
    internal IReadOnlyList<RehearsalStep> ClosedLedger { get; }

    /// <summary>What every step logged inside the window, whatever fire it belonged to: what the stamped panels count.</summary>
    internal IReadOnlyList<RehearsalStep> Ledger { get; }

    /// <summary>One range's worth of fixture: its fires, polls and imports, the closed fires and the stamped records.</summary>
    private sealed record Slice(
        int Fires, int DrainedPolls, int Imported,
        IReadOnlyList<RehearsalStep> Closed, IReadOnlyList<RehearsalStep> Stamped);

    /// <summary>
    /// The slice for a range. It starts after the run began unless it is a history read from the start,
    /// so only then does a fire from before the range exist to leave a start residue.
    /// </summary>
    private Slice SliceOf(TimeRange range)
        => SliceOf(range.To - range.From, range.From > RehearsalGraph.RunFor(range.To).Start!.Value);

    /// <summary>
    /// The per-window rates scaled to the range. A planted loss stays constant: it happened in the window.
    /// Stamped = closed, plus a pre-range fire's failures (validated and recorded inside), less the last
    /// fire's items still being persisted at the end.
    /// </summary>
    private Slice SliceOf(TimeSpan length, bool startsAfterTheRunBegan)
    {
        var scale = length.TotalMinutes / WindowLength.TotalMinutes;
        int Scaled(int n) => (int)Math.Round(n * scale);

        var imported = Scaled(RecordsImported);
        var rejected = Scaled(RejectedItems);
        var drained = Scaled(DrainedPolls);
        var good = imported - rejected;

        IReadOnlyList<RehearsalStep> closed =
        [
            new(RehearsalGraph.ImportStep, Completed: imported, Failed: 0, Cancelled: drained, Parked: 0),
            new(RehearsalGraph.ValidateStep, Completed: good, Failed: rejected, Cancelled: 0, Parked: 0),
            new(RehearsalGraph.PersistStep, Completed: good - _lost, Failed: 0, Cancelled: 0, Parked: _lost),
            new(RehearsalGraph.RecordStep, Completed: rejected, Failed: 0, Cancelled: 0, Parked: 0),
        ];

        var pre = startsAfterTheRunBegan ? _preWindowFailures : 0;
        IReadOnlyList<RehearsalStep> stamped = closed
            .Select(s => s.StepId == RehearsalGraph.ValidateStep ? s with { Failed = s.Failed + pre }
                : s.StepId == RehearsalGraph.RecordStep ? s with { Completed = s.Completed + pre }
                : s.StepId == RehearsalGraph.PersistStep ? s with { Completed = s.Completed - _inFlight }
                : s)
            .ToList();

        return new Slice(Scaled(Fires), drained, imported, closed, stamped);
    }

    /// <summary>A string[] because <c>AnalystConfig.PanelSet</c> takes one.</summary>
    internal string[] PanelIds =>
        ["step-outcomes", "run-boundaries", "step-failures", "refused-messages",
         "dead-letter-depth", "queue-wait", "processor-liveness", "failure-causes"];

    private static string Layer(string panelId) => panelId switch
    {
        "dead-letter-depth" or "queue-wait" or "processor-liveness" => "ops",
        _ => "business",
    };

    public PanelDescriptor Describe(string panelId)
    {
        if (!PanelIds.Contains(panelId))
        {
            throw new ArgumentException($"no rehearsal panel '{panelId}'", nameof(panelId));
        }

        // The description production shows: the BIT judges a prompt on what a live dispatch reads.
        var definition = PanelRegistry.All.Single(p => p.PanelId == panelId);
        return new PanelDescriptor(definition.PanelId, definition.Layer, definition.Description);
    }

    /// <summary>
    /// failure-causes, step-outcomes, run-boundaries and step-failures are served from the range when it
    /// is at least <see cref="WindowLength"/> long. Every other panel, and any history read shorter than
    /// the window, answers with the window reading: the history range ends where the window does, so
    /// the window is its last <see cref="WindowLength"/>. A shorter range would scale the rates down but
    /// still carry a whole edge residue, breaching the declared expectation the window meets. <b>Limitation:</b> the loop builds the <c>served</c> envelope from
    /// the range it asked for, not from the reader, so the model is still told the history range was
    /// served; only the reading itself (series timestamps included) is the window's. The live loop is
    /// not changed to accommodate the rehearsal.
    /// </summary>
    public Task<PanelReading> ReadAsync(
        string panelId, Guid targetWorkflowId, TimeRange range, bool history, CancellationToken ct)
    {
        if (!PanelIds.Contains(panelId))
        {
            throw new PanelUnavailableException(panelId, "not part of the rehearsal");
        }

        var servedFromTheRange = panelId is "failure-causes" or "step-outcomes" or "run-boundaries" or "step-failures";
        var shorterThanTheWindow = history && range.To - range.From < WindowLength;
        return history && (!servedFromTheRange || shorterThanTheWindow)
            ? Task.FromResult(Build(panelId, new TimeRange(range.To - WindowLength, range.To), history: false))
            : Task.FromResult(Build(panelId, range, history));
    }

    /// <summary>Every log record of the workflow in the slice, the scope count the Elastic panels report.</summary>
    private int WorkflowRecords(Slice slice) => slice.Stamped.Sum(s => s.Outcomes) * 6 + slice.Fires * 3 + _lost;

    private PanelReading Build(string panelId, TimeRange range, bool history)
    {
        var slice = SliceOf(range);

        var (value, samples) = panelId switch
        {
            "step-outcomes" => (Serialize(new
            {
                totalOutcomeRecords = slice.Stamped.Sum(s => s.Outcomes),
                completed = slice.Stamped.Sum(s => s.Completed),
                failed = slice.Stamped.Sum(s => s.Failed),
                cancelled = slice.Stamped.Sum(s => s.Cancelled),
            }), slice.Stamped.Sum(s => s.Outcomes)),
            "run-boundaries" => RunBoundaries(slice),
            "step-failures" => (Serialize(new
            {
                totalOutcomeRecords = slice.Stamped.Sum(s => s.Outcomes),
                failedCount = slice.Stamped.Sum(s => s.Failed),
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
            }), slice.Stamped.Sum(s => s.Outcomes)),
            "failure-causes" => FailureCauses(range, history, slice),
            "refused-messages" => (Serialize(new
            {
                totalWorkflowRecords = WorkflowRecords(slice),
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
            }), WorkflowRecords(slice)),
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

    /// <summary>
    /// The one cause, and the failed share per bucket. The range's totals are the ledger's per-15-minute
    /// rates scaled to the range (the slice's stamped totals), spread over
    /// the buckets by largest remainder weighted by each bucket's overlap with the range, so the buckets
    /// sum exactly to the totals. Each share is that bucket's own failed over imported (null when it
    /// imported nothing), and the top-level share is the range's, both as the live panel computes them;
    /// the cause's count is the failed the buckets add up to.
    /// </summary>
    private (string Value, int Samples) FailureCauses(TimeRange range, bool history, Slice slice)
    {
        var windowMinutes = WindowLength.TotalMinutes;
        var bucket = ElasticPanelSource.BucketFor(range);
        var width = TimeSpan.FromMinutes(int.Parse(bucket.Split(' ')[0], CultureInfo.InvariantCulture));

        var starts = new List<DateTimeOffset>();
        for (var start = range.From; start < range.To; start += width)
        {
            starts.Add(start);
        }

        var weights = starts
            .Select(t => (Math.Min((t + width).Ticks, range.To.Ticks) - t.Ticks) / (double)TimeSpan.TicksPerMinute)
            .ToList();
        var imported = Allocate(slice.Imported, weights);
        var failed = Allocate(slice.Stamped.Sum(s => s.Failed), weights);
        var cancelled = Allocate(slice.Stamped.Sum(s => s.Cancelled), weights);

        var buckets = starts.Select((start, i) => new
        {
            start,
            imported = (long)imported[i],
            failed = (long)failed[i],
            cancelled = (long)cancelled[i],
            failedShare = ElasticPanelSource.FailedShare(failed[i], imported[i]),
        }).ToList();

        var count = failed.Sum();
        var cause = new
        {
            step = RehearsalGraph.Graph.Names[RehearsalGraph.ValidateStep],
            logged = "author-reported",
            cause = "the author reported the step failed: fetching item-<n>.dat failed: "
                  + "the extension '.dat' is not one of the allowed extensions [.zip]",
            count = (long)count,
            firstSeen = history ? range.From : range.To.AddMinutes(-14),
            lastSeen = range.To.AddSeconds(-40),
        };

        var failedShare = ElasticPanelSource.FailedShare(failed.Sum(), imported.Sum());
        return (Serialize(new { bucket, failedShare, causes = new[] { cause }, buckets }), count);
    }

    /// <summary>Splits <paramref name="total"/> across the weights by largest remainder, so the parts sum to it exactly.</summary>
    private static int[] Allocate(int total, IReadOnlyList<double> weights)
    {
        var sum = weights.Sum();
        var exact = weights.Select(w => total * w / sum).ToArray();
        var parts = exact.Select(e => (int)Math.Floor(e)).ToArray();
        var order = Enumerable.Range(0, parts.Length)
            .OrderByDescending(i => exact[i] - parts[i]).ThenBy(i => i).ToList();

        for (int k = 0, missing = total - parts.Sum(); k < missing; k++)
        {
            parts[order[k]]++;
        }

        return parts;
    }

    private (string Value, int Samples) RunBoundaries(Slice slice)
    {
        var graph = RehearsalGraph.Graph;
        var rows = graph.EntryStepIds
            .Select(id => new { role = StepRoles.Entry, step = graph.Names[id], records = slice.Fires })
            .Concat(graph.Steps
                .Select(s => new { s.StepId, records = TerminalRecords(s, graph.Steps, slice) })
                .Where(t => t.records > 0)
                .Select(t => new { role = StepRoles.Terminal, step = graph.Names[t.StepId], t.records }))
            .ToList();

        return (Serialize(new
        {
            totalWorkflowRecords = WorkflowRecords(slice),
            fires = slice.Fires,
            importerPolls = slice.Fires,
            pollsThatImported = slice.Fires - slice.DrainedPolls,
            drainedPolls = slice.DrainedPolls,
            recordsImported = slice.Imported,
            byStep = rows,
        }), rows.Sum(r => r.records));
    }

    /// <summary>
    /// The orchestrator's terminal rule applied to the CLOSED fires -- run-boundaries never sees a fire
    /// that entered before the range -- less the last fire's terminal records that land after it.
    /// </summary>
    private int TerminalRecords(StepL1 step, IReadOnlyList<StepL1> steps, Slice slice)
    {
        var closed = slice.Closed.Single(l => l.StepId == step.StepId);
        var count = step.NextStepIds.Count == 0
            ? closed.Outcomes
            : step.NextStepIds
                .Select(id => steps.Single(s => s.StepId == id))
                .Any(next => GraphRenderer.Accepts(next.EntryCondition, StepResult.Completed))
                ? 0
                : closed.Completed;

        return step.StepId == RehearsalGraph.PersistStep ? count - _inFlight : count;
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
