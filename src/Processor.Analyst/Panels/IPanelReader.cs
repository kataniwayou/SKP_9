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

    /// <summary>
    /// Reads one panel over one window, scoped to the workflow under investigation. Throws
    /// <see cref="PanelUnavailableException"/> if the source cannot be reached.
    /// <para>
    /// <b><paramref name="targetWorkflowId"/> only narrows a business-layer (Elasticsearch) panel.</b>
    /// An ops-layer (Prometheus) panel carries no workflow dimension at all -- <c>pipeline_*</c>
    /// series are labelled by queue, destination and replica, never by workflow, and a single
    /// processor replica ordinarily serves several workflows -- so a Prometheus panel ignores this id
    /// and reads host-level telemetry for the whole replica.
    /// </para>
    /// </summary>
    /// <param name="history">A since-start read rather than the window: sources shape the result to
    /// fit the token budget (spec 4.3).</param>
    Task<PanelReading> ReadAsync(string panelId, Guid targetWorkflowId, TimeRange range, bool history, CancellationToken ct);
}
