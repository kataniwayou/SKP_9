using BaseProcessor.Core.Configuration;

namespace Processor.Napole;

/// <summary>
/// The step payload: the section of a workflow to report on, the time frame, and the report's five
/// dimensions.
/// <para>
/// <b>Nine fields, all required, in this order, by decision (reach spec §2.5).</b>
/// <see cref="FromStepId"/> and <see cref="ToStepId"/> may be any steps of
/// <see cref="WatchedWorkflowId"/> -- neither has to be an entry or a terminal step, and they may be
/// the same step. The five dimensions are copied into the report unchanged; each Napole step carries
/// its own, so two sections of one workflow can be told apart. Where Elasticsearch is, how far behind
/// the clock to stay and how far past the window to look are the same for every Napole step a
/// deployment runs, so they are pod configuration (<see cref="NapoleOptions"/>).
/// </para>
/// <para>
/// <b>The ids and the dimensions are the operator's responsibility.</b> Napole does not check them
/// against the workflow definition: a wrong <see cref="FromStepId"/> matches nothing and the tick
/// reports nothing; a wrong <see cref="ToStepId"/> is reached by nothing, which Napole warns about.
/// </para>
/// <para>
/// <b>Matching <see cref="WindowMinutes"/> to the workflow's cron is the operator's job.</b> Napole
/// cannot see the cron. When the two disagree, executions are counted in a nearby report -- twice
/// when ticks come closer than the window, never when they come further apart -- and that is
/// accepted.
/// </para>
/// <para>
/// <b>Fire mid-slot, not on the grid line.</b> The window is <c>floor(now − lag, windowMinutes)</c>, so a
/// tick on the line (<c>0 */10 * * * *</c>) has only the lag -- 60 s -- before a late dispatch rolls into
/// the next slot and silently skips one. Halfway through the slot (<c>0 5/10 * * * *</c> for 10 minutes)
/// gives about four minutes either way, and the report is 5-15 minutes old instead of 10-20.
/// </para>
/// </summary>
public sealed record NapoleConfig(
    Guid WatchedWorkflowId,
    Guid FromStepId,
    Guid ToStepId,
    int WindowMinutes,
    string ReporterComponentName,
    string ReporterSubComponentName,
    string ReporterNetworkName,
    string SrcCode,
    string SagCode)
    : ProcessorConfig;
