namespace Processor.Napole;

/// <summary>
/// The pod's half of Napole's configuration, bound from the <c>Napole</c> section: the manifest's
/// <c>Napole__*</c> environment variables in-cluster, <c>appsettings.json</c> outside it.
/// <para>
/// <b>Required values fail the pod at startup</b> (<c>ValidateOnStart</c> in
/// <see cref="ProcessorHost"/>), not a tick: a missing dimension would otherwise put an
/// unattributable report on the topic every window, and a missing address would fail every tick
/// for the same reason.
/// </para>
/// </summary>
public sealed class NapoleOptions
{
    public const string Section = "Napole";

    /// <summary>e.g. <c>http://elasticsearch:9200</c> in-cluster. Required.</summary>
    public string ElasticBaseUrl { get; set; } = "";

    /// <summary>
    /// How far behind the clock the window ends. The importer fires on the same cron second as
    /// Napole and its runs finish a few seconds later, and ES sees them later still; a window that
    /// ended at the tick would leave in-flight runs out of every report.
    /// </summary>
    public int LagSeconds { get; set; } = 60;

    /// <summary>How far either side of the window a run's records are looked for (spec §4.1, §4.2).</summary>
    public int TrailMinutes { get; set; } = 10;

    public ReportDimensions Report { get; set; } = new();
}

/// <summary>The five dimension values copied unchanged into every report's <c>commonDimentions</c>. All required.</summary>
public sealed class ReportDimensions
{
    public string ReporterComponentName { get; set; } = "";

    public string ReporterSubComponentName { get; set; } = "";

    public string ReporterNetworkName { get; set; } = "";

    public string SrcCode { get; set; } = "";

    public string SagCode { get; set; } = "";
}
