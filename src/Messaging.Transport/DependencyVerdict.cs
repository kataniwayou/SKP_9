namespace Messaging.Transport;

/// <summary>
/// What a failed dependency check means for the human reading the log — which is a different question
/// from what went wrong technically.
/// <para>
/// <b>Why three states and not two.</b> "Deterministic vs transient" describes the fault; it does not
/// describe the decision an operator has to make, which is <i>do I touch this pod or not</i>. A wrong
/// password and a missing database grant are both deterministic — neither clears by waiting — but one
/// needs a restart and the other must not have one, because the retry loop will pick the grant up the
/// moment it lands. Collapsing those into one bucket produces advice that is wrong half the time.
/// </para>
/// </summary>
public enum DependencyFault
{
    /// <summary>
    /// Clears by itself. Nothing answered, or it answered "not yet" — a dependency still starting, a
    /// connection refused, a timeout. The service recovers on its own and needs no intervention.
    /// </summary>
    Transient,

    /// <summary>
    /// Will not clear by waiting, but the fix is outside this pod and needs no restart: grant the
    /// permission, create the database, register the row. The loop is still running and picks the
    /// change up as soon as it lands.
    /// <para>
    /// <b>The safer default for an ambiguous refusal.</b> A refused virtual host may be a missing
    /// grant or a mistyped setting. Reported as external, a genuine config error still gets fixed —
    /// the operator edits the manifest, which redeploys the pod anyway. Reported as configuration, a
    /// missing grant earns a restart that changes nothing and buries the evidence.
    /// </para>
    /// </summary>
    BlockedExternal,

    /// <summary>
    /// This pod's own configuration is wrong; the loop can never succeed. The fix is to correct the
    /// setting <b>and then restart</b> — the manifests inject these values through
    /// <c>env.valueFrom.secretKeyRef</c>, which is resolved once at pod creation and cannot change in
    /// a running container.
    /// </summary>
    BlockedConfiguration,
}

/// <summary>
/// One dependency check's answer: what kind of failure it was, why, and what the operator should do
/// about it.
/// <para>
/// <b>Why this type lives in the transport assembly.</b> It names no client and references none — it
/// is a plain verdict every service can speak. All three hosts already reference this assembly, and
/// the alternative homes each fail: <c>BaseApi.Core</c> is behind a firewall the console cannot cross,
/// and <c>BaseConsole.Core</c> is behind the same firewall in the other direction. A dedicated
/// diagnostics assembly would be the better long-term home for this and for the per-client
/// classifiers that produce it; this is the placement that adds no project and no package reference.
/// </para>
/// </summary>
/// <param name="Fault">What the failure means for the operator's decision.</param>
/// <param name="Reason">
/// A short phrase naming the failure, readable inline in a log line without widening the console. The
/// originating exception is attached separately at every call site and stays the authority on detail.
/// </param>
/// <param name="SettingKey">
/// The configuration key at fault, when there is one — the difference between a message that names a
/// problem and one an operator can act on. Null for faults no setting controls.
/// </param>
public sealed record DependencyVerdict(DependencyFault Fault, string Reason, string? SettingKey = null)
{
    /// <summary>
    /// True only for <see cref="DependencyFault.BlockedConfiguration"/>. Restarting is useless in the
    /// other two states, and in <see cref="DependencyFault.BlockedExternal"/> it is actively harmful:
    /// it discards backoff progress and rotates away the log that explains the wait.
    /// </summary>
    public bool RestartRequired => Fault == DependencyFault.BlockedConfiguration;

    /// <summary>
    /// What to do, in the imperative. Deliberately explicit that a restart alone fixes nothing — a
    /// restart is the reflex, and on its own it reproduces the identical state and makes the advice
    /// look wrong.
    /// </summary>
    public string Guidance => Fault switch
    {
        DependencyFault.Transient =>
            "no action needed — this clears when the dependency returns, and the service recovers "
            + "without a restart",
        DependencyFault.BlockedExternal =>
            "waiting will not fix this, but a restart will not either — fix it outside this pod and "
            + "the service picks the change up on its next attempt",
        DependencyFault.BlockedConfiguration =>
            $"correct {SettingKey ?? "the configuration"} and then restart this pod — the value is "
            + "injected at pod start and cannot change in a running container",
        _ => "unclassified",
    };

    /// <summary>One line carrying the whole verdict: what failed, and what to do about it.</summary>
    public override string ToString() => $"{Reason} [{Fault}] — {Guidance}";
}
