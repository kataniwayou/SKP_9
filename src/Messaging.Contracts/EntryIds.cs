namespace Messaging.Contracts;

/// <summary>
/// Every derived <c>data:</c> key in the execution path, in one place, so the processor and the
/// orchestrator cannot drift apart. See §5 of
/// <c>docs/superpowers/specs/2026-10-12-in-process-post-derived-keys-design.md</c>.
/// <para>
/// <b>Derived, not random, and that is the whole point.</b> A replay of the same work names the same
/// key and rewrites it, so L2 converges instead of collecting a second copy that nothing will ever
/// read or delete — <c>data:</c> keys have no TTL and no sweeper.
/// </para>
/// <para>
/// <b>Each formula carries a purpose tag</b> (<c>branch</c>, <c>entry-branch</c>, ...) and joins its
/// inputs with a separator, so two formulas, or two splits of the same inputs, can never hash the
/// same name.
/// </para>
/// </summary>
public static class EntryIds
{
    /// <summary>
    /// The namespace every derived entry id is minted under. <b>Never change it:</b> a different
    /// namespace derives different keys, and every blob in flight across the deploy would be orphaned.
    /// </summary>
    public static readonly Guid Namespace = Guid.Parse("b3a9e1d4-6c2f-4f7a-9e85-2d1c7b0a4f63");

    /// <summary>
    /// The key a processor writes one branch to (§5.1). With an input key: that key and the
    /// execution. Without one — an entry step dispatched by the fire — the workflow, the step and the
    /// execution.
    /// </summary>
    public static Guid Branch(Guid inputEntryId, Guid workflowId, Guid stepId, Guid executionId) =>
        inputEntryId != Guid.Empty
            ? Derive("branch", inputEntryId, executionId)
            : Derive("entry-branch", workflowId, stepId, executionId);

    /// <summary>
    /// The key the orchestrator hands one successor (§5.2). With the predecessor's key: that key and
    /// the successor's step. Without one — an entry step's Failed or Cancelled outcome — the run, the
    /// step that ended and the successor's step; an entry step is dispatched once per fire, so the
    /// correlation id keeps it unique.
    /// </summary>
    public static Guid Successor(Guid entryId, Guid correlationId, Guid stepId, Guid nextStepId) =>
        entryId != Guid.Empty
            ? Derive("successor", entryId, nextStepId)
            : Derive("entry-successor", correlationId, stepId, nextStepId);

    /// <summary>
    /// The id the orchestrator's <c>handoff:</c> set is named after: the outcome's own key, or for an
    /// outcome that names none, the same run-and-step pair <see cref="Successor"/> falls back to.
    /// </summary>
    public static Guid HandoffSource(Guid entryId, Guid correlationId, Guid stepId) =>
        entryId != Guid.Empty ? entryId : Derive("entry-handoff", correlationId, stepId);

    private static Guid Derive(string purpose, params Guid[] parts) =>
        Uuid5.Create(Namespace, purpose + "|" + string.Join("|", parts.Select(p => p.ToString("D"))));
}
