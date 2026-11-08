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
/// </summary>
public sealed record NapoleConfig(Guid WatchedWorkflowId, int WindowMinutes) : ProcessorConfig;
