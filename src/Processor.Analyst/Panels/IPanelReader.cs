namespace Processor.Analyst.Panels;

/// <summary>
/// The evidence surface. The agent sees exactly what the operator sees — no raw query access — so the
/// tool list is the panel list, inspectable, and widened by registering panels rather than by
/// loosening a permission.
/// <para>
/// <b>The consequence worth stating: the agent inherits every blind spot of the boards.</b> It cannot
/// see what the panels cannot show, and it will report a confident quiet result over exactly those
/// gaps — in prose, which reads more authoritative than an empty chart does. The panel set is a
/// correctness dependency of this processor, not a convenience.
/// </para>
/// </summary>
internal interface IPanelReader
{
    /// <summary>What this panel is, for the system prompt.</summary>
    PanelDescriptor Describe(string panelId);

    /// <summary>Reads one panel over one window. Throws <see cref="PanelUnavailableException"/> if the source cannot be reached.</summary>
    Task<PanelReading> ReadAsync(string panelId, TimeRange range, CancellationToken ct);
}
