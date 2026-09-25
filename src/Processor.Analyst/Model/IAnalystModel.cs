namespace Processor.Analyst.Model;

/// <summary>
/// The model backend, above the wire format.
/// <para>
/// <b>Deliberately not raw wire objects.</b> This is the test seam: the investigation loop, the
/// preflight BIT and every disposition rule are exercised against a stub implementation of this
/// interface, and without it none of that behaviour is testable offline. That alone justifies it.
/// </para>
/// <para>
/// It is also what keeps a future model change contained rather than invasive. Supporting several
/// backends at once is explicitly out of scope — there is one adapter, registered in ProcessorHost —
/// but when a better model arrives, this interface is the boundary the change stops at.
/// </para>
/// <para>
/// Nothing provider-specific may become load-bearing above this line: no reasoning or thinking
/// concept, no effort, no server-side schema enforcement. The authoritative budget is loop-enforced and
/// every tool input is validated client-side, so the loop never depends on a courtesy of one backend.
/// </para>
/// </summary>
internal interface IAnalystModel
{
    /// <param name="system">The compiled contract plus the delimited payload prompt.</param>
    /// <param name="transcript">The conversation so far, oldest first.</param>
    /// <param name="tools">The full tool catalog for this dispatch.</param>
    Task<ModelReply> SendAsync(
        string system,
        IReadOnlyList<ModelTurn> transcript,
        IReadOnlyList<ToolSpec> tools,
        CancellationToken ct);
}
