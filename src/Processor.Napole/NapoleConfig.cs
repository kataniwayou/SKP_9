using BaseProcessor.Core.Configuration;

namespace Processor.Napole;

/// <summary>
/// The step payload: the workflow to report on and the time frame, and nothing else.
/// <para>
/// <b>Two fields, by decision (spec §5).</b> Everything else Napole needs -- where Elasticsearch is,
/// how far behind the clock to stay, how far past the window to look, and the five report dimensions
/// -- is the same for every Napole step a deployment runs, so it is pod configuration
/// (<see cref="NapoleOptions"/>), not a choice the workflow author makes.
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
public sealed record NapoleConfig(Guid WatchedWorkflowId, int WindowMinutes) : ProcessorConfig;
