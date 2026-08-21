using System.Text.Json;
using BaseProcessor.Core.Configuration;

namespace BaseProcessor.Core.Processing;

/// <summary>
/// The class an author derives from. It turns the step's JSON payload into their config type and
/// calls their transform; they override <see cref="ProcessAsync"/> and nothing else.
/// </summary>
public abstract class BaseProcessor<TConfig> : BaseProcessor where TConfig : ProcessorConfig
{
    internal sealed override Task ExecuteAsync(
        byte[] data, string payload, Guid executionId, CancellationToken ct)
    {
        // The emptiness guard runs before the deserialize, not inside a catch: a step with no payload
        // is an ordinary configuration, and letting JsonSerializer throw on "" would turn it into a
        // failed step.
        TConfig? config = string.IsNullOrWhiteSpace(payload)
            ? null
            : JsonSerializer.Deserialize<TConfig>(payload, ProcessorConfig.SerializerOptions);

        return ProcessAsync(data, config, executionId, ct);
    }

    /// <summary>
    /// The author's transform.
    /// <para>
    /// <paramref name="data"/> is the schema-validated input, empty for a source step, which has no
    /// upstream input and produces its own. <paramref name="config"/> is the step's payload, and it is
    /// <b>null when that payload was empty</b> — handle the absence rather than assuming a value.
    /// <paramref name="executionId"/> is <see cref="Guid.Empty"/> for an entry step, where the author
    /// opens a lineage per branch with <c>NewExecutionId()</c>, and non-empty downstream, where it is
    /// reused unchanged so the lineage holds.
    /// </para>
    /// <para>
    /// <b>Three ways to end.</b> Send one or more branches with <c>SendToPostAsync</c>; return without
    /// sending, which ends the branch silently and legitimately; or throw <see cref="FailedException"/>
    /// or <see cref="CancelledException"/> to report an outcome directly. The first two both reclaim
    /// the input key once this method returns. A thrown exception does not: the key stays where it is
    /// and the outcome sent to the orchestrator names it, because nothing else ever would — execution
    /// blobs carry no TTL and no sweeper covers them.
    /// </para>
    /// <para>
    /// <b>Write this method so that running it twice on one input is acceptable.</b> A redelivered
    /// dispatch replays it, and the branches of the replay carry freshly minted ids rather than the
    /// ones the first run used — so the replay is a second set of branches, not a rewrite of the first.
    /// Redelivery is narrow (the framework reclaims the input key on the way out, and a redelivery that
    /// finds it gone returns without calling this method at all), but it is reachable, and it is not
    /// reachable at all for a source step, which has no key to reclaim. A transform pays nothing for
    /// this. A step that writes a row or calls an API does the work twice, and nothing in the framework
    /// records that it did — so make those idempotent, or key them off something the input carries.
    /// </para>
    /// <para>
    /// <paramref name="ct"/> is never cancelled in production: abandoning a handler mid-flight would
    /// leave partially applied work with the message already claimed. It is here for tests.
    /// </para>
    /// </summary>
    protected abstract Task ProcessAsync(
        byte[] data, TConfig? config, Guid executionId, CancellationToken ct);
}
