using System.Diagnostics;

namespace Messaging.Transport;

/// <summary>
/// One process-wide attribute the host may add to every pipeline message instrument, for facts that
/// change while the process runs and so cannot live on a frozen resource.
/// <para>
/// <b>Why this seam exists rather than the tag being added where it is known.</b> The message
/// counters are owned by <see cref="EgressMetrics"/> here and <c>IngressMetrics</c> in
/// <c>BaseConsole.Core</c>, both shared by every role. The orchestrator's leadership is meaningless
/// to a processor and unreachable from these assemblies — <c>LeaderState</c> lives in the
/// orchestrator. Teaching shared code about roles would put one role's vocabulary in the code the
/// design relies on being role-agnostic; a host-supplied tag keeps the knowledge where it belongs
/// and leaves the tag absent everywhere it does not apply.
/// </para>
/// <para>
/// <b>Read live, once per measurement.</b> The whole point is a value that moves: a replica that
/// loses the lease must attribute its next measurement to what it is now, not to what it was when
/// the provider was installed.
/// </para>
/// <para>
/// <b>It is deliberately ONE tag, not a collection.</b> A list would invite per-measurement
/// allocation on a path that runs once per message, and there is exactly one fact that needs this.
/// A second one should force a rethink rather than a bigger array.
/// </para>
/// <para>
/// <b>Cardinality:</b> setting this doubles the series count for the instruments it touches, since
/// a replica that flips ends one series and begins another. That is bounded and intended — it is
/// what lets "how much work did leaders do versus followers" be a single query.
/// </para>
/// </summary>
public static class PipelineAmbientTag
{
    // Volatile, not a lock: installed once during host construction and read on every send and
    // every delivery thereafter. A torn read is not possible for a reference, and there is no
    // window in which a half-installed provider could be observed.
    private static volatile Func<KeyValuePair<string, object?>>? _provider;

    /// <summary>
    /// Install the tag for this process. Called by a host that has a role to report; never called
    /// by a host that does not, which is what keeps the attribute absent rather than empty.
    /// </summary>
    public static void Provide(Func<KeyValuePair<string, object?>> provider) =>
        _provider = provider ?? throw new ArgumentNullException(nameof(provider));

    /// <summary>Removes the tag. Exists for tests, so one test's provider cannot leak into another.</summary>
    public static void Clear() => _provider = null;

    /// <summary>
    /// Appends the tag to <paramref name="tags"/> if a host installed one. A no-op otherwise, so a
    /// processor's series carry no empty <c>role</c> that a query could match by accident.
    /// </summary>
    public static void AppendTo(ref TagList tags)
    {
        if (_provider is { } provider)
        {
            tags.Add(provider());
        }
    }
}
