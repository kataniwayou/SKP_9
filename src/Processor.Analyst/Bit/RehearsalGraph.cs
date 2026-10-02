using Messaging.Contracts;
using Processor.Analyst.Graph;

namespace Processor.Analyst.Bit;

/// <summary>
/// The running graph the rehearsal's invented window came from. A v12 prompt derives every
/// expectation from the routing before it reads a panel, so a rehearsal without a graph cannot be
/// passed by a prompt that reasons correctly: its counts would have nothing to be explained by.
/// <para>
/// <b>Four steps carrying the edges model's traps, in miniature.</b> import-paths takes items in and
/// cancels on an empty poll. validate-file fails the items whose extension it refuses. persist-file
/// stores the good items; its only successor accepts Failed, so a Completed item ends its run there
/// and that outcome is terminal although the step has a successor. record-outcome records failures
/// and is the only step with no successors, so every outcome of it is terminal. An empty poll
/// cancels at import-paths, which has successors, so it writes no terminal record. (The briefing
/// labels breadth-first, so record-outcome renders as S3 and persist-file as S4.) That is the shape
/// of filefetcher-archiveexpander-chain: split-exporter and export-outcome are its exit edges.
/// </para>
/// <para>
/// <b>Compiled in, like <see cref="BitPrompt"/> and <see cref="RehearsalPanels"/>:</b> the standard a
/// prompt is judged against changes only through a rebuild that moves the SourceHash.
/// </para>
/// </summary>
internal static class RehearsalGraph
{
    internal static readonly Guid WorkflowId = Guid.Parse("7e4b1a00-0000-4000-8000-00000000a11e");

    internal static readonly Guid ImportStep = Guid.Parse("7e4b1a00-0000-4000-8000-000000000001");
    internal static readonly Guid ValidateStep = Guid.Parse("7e4b1a00-0000-4000-8000-000000000002");
    internal static readonly Guid PersistStep = Guid.Parse("7e4b1a00-0000-4000-8000-000000000003");
    internal static readonly Guid RecordStep = Guid.Parse("7e4b1a00-0000-4000-8000-000000000004");

    internal static readonly Guid ImporterProcessor = Guid.Parse("7e4b1a00-0000-4000-8000-0000000000a1");
    internal static readonly Guid ValidatorProcessor = Guid.Parse("7e4b1a00-0000-4000-8000-0000000000a2");
    internal static readonly Guid PersisterProcessor = Guid.Parse("7e4b1a00-0000-4000-8000-0000000000a3");
    internal static readonly Guid RecorderProcessor = Guid.Parse("7e4b1a00-0000-4000-8000-0000000000a4");

    /// <summary>Once a minute, so a 15-minute window schedules 15 fires.</summary>
    internal const string Cron = "0 * * * * *";

    private const int OnCompleted = 1;
    private const int OnFailed = 2;
    private const int Always = 4;

    internal static readonly RunningGraph Graph = new(
        WorkflowId,
        Live: true,
        Cron,
        EntryStepIds: [ImportStep],
        Steps:
        [
            new StepL1(ImportStep, Always, ImporterProcessor,
                """{"topic": "rehearsal-paths", "messageCount": 10, "idleTimeoutSeconds": 10}""",
                [ValidateStep, RecordStep]),
            new StepL1(ValidateStep, OnCompleted, ValidatorProcessor,
                """{"allowedExtensions": [".zip"]}""",
                [PersistStep, RecordStep]),
            new StepL1(PersistStep, OnCompleted, PersisterProcessor,
                """{"root": "/data/rehearsal"}""",
                [RecordStep]),
            new StepL1(RecordStep, OnFailed, RecorderProcessor, "{}", []),
        ],
        Names: new Dictionary<Guid, string>
        {
            [WorkflowId] = "rehearsal-chain_1.0.0",
            [ImportStep] = "import-paths_1.0.0",
            [ValidateStep] = "validate-file_1.0.0",
            [PersistStep] = "persist-file_1.0.0",
            [RecordStep] = "record-outcome_1.0.0",
            [ImporterProcessor] = "kafkaimporter_1.0.0",
            [ValidatorProcessor] = "filefetcher_1.0.0",
            [PersisterProcessor] = "filepersister_1.0.0",
            [RecorderProcessor] = "outcomerecorder_1.0.0",
        });

    /// <summary>The briefing exactly as a live dispatch renders it.</summary>
    internal static string Briefing => GraphRenderer.Render(GraphBriefing.Of(Graph));
}
