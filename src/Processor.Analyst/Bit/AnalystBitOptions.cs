namespace Processor.Analyst.Bit;

/// <summary>How much of the preflight BIT runs before a dispatch is allowed to investigate.</summary>
internal enum BitMode
{
    /// <summary>Structure, the judge's quorum and the ground-truth rehearsal. The default.</summary>
    Full,

    /// <summary>
    /// Structure only: the free, mechanical heading check still rejects a prompt with no stages, but
    /// the judge and the rehearsal are skipped. For a proof of concept whose prompt changes faster
    /// than the exam can be kept in step with it, fired by hand and read by a human.
    /// </summary>
    StructureOnly,
}

/// <summary>
/// Bound from <c>Analyst:Bit:*</c>. Same environment-only rule as <c>AnalystModelOptions</c>: the mode
/// decides whether an unexamined prompt may run, so it must freeze at container start and change only
/// by rolling the pod, never by a reloadable file.
/// </summary>
internal sealed class AnalystBitOptions
{
    public BitMode Mode { get; set; } = BitMode.Full;
}
