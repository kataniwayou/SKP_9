using BaseProcessor.Core.Configuration;

namespace Processor.Napole;

/// <summary>
/// The step payload: the section of a workflow to report on, the time frame, and the name the report
/// carries for that section.
/// <para>
/// <b>Five fields, all required, by decision (sections spec §3).</b> <see cref="FromStepId"/> and
/// <see cref="ToStepId"/> may be any steps of <see cref="WatchedWorkflowId"/> -- neither has to be an
/// entry or a terminal step, and they may be the same step. <see cref="ReporterSubComponentName"/> is
/// copied into the report and is what tells two sections of one workflow apart, since they share the
/// window and the pod's dimensions. Everything else Napole needs -- where Elasticsearch is, how far
/// behind the clock to stay, how far past the window to look, and the other four report dimensions --
/// is the same for every Napole step a deployment runs, so it is pod configuration
/// (<see cref="NapoleOptions"/>), not a choice the workflow author makes.
/// </para>
/// <para>
/// <b>The ids and the sub-component name are the operator's responsibility.</b> Napole does not check
/// them against the workflow definition: a wrong id matches nothing and the tick reports nothing, and
/// two steps given the same name produce reports a consumer cannot tell apart.
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
    Guid WatchedWorkflowId, Guid FromStepId, Guid ToStepId, int WindowMinutes, string ReporterSubComponentName)
    : ProcessorConfig;
