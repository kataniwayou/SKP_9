namespace Processor.Napole;

/// <summary>
/// The five dimension values copied unchanged into a report's <c>commonDimentions</c>.
/// <para>
/// <b>From the step payload, not the pod</b> (reach spec §2.5, decided). Each Napole step carries its
/// own set, so two sections of one workflow, which share the window, can be told apart by any of them.
/// Keeping them right is the operator's responsibility, as with the step ids. A leftover
/// <c>Napole__Report__*</c> variable in a manifest binds to nothing and is ignored.
/// </para>
/// </summary>
public sealed record ReportDimensions(
    string ReporterComponentName,
    string ReporterSubComponentName,
    string ReporterNetworkName,
    string SrcCode,
    string SagCode)
{
    public static ReportDimensions Of(NapoleConfig config)
    {
        ArgumentNullException.ThrowIfNull(config);
        return new(
            config.ReporterComponentName, config.ReporterSubComponentName, config.ReporterNetworkName,
            config.SrcCode, config.SagCode);
    }
}
