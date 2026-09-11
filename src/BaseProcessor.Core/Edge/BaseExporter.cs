using BaseProcessor.Core.Configuration;
using BaseProcessor.Core.Processing;
using Microsoft.Extensions.Logging;

namespace BaseProcessor.Core.Edge;

/// <summary>
/// The class an exporter derives from: a step with an input that writes it somewhere and produces no
/// branches. The mirror image of <see cref="BaseImporter{TConfig}"/>.
/// <para>
/// <b>What makes it an edge is <c>ExecutionId</c>, and nothing else.</b> An entry dispatch carries
/// <see cref="Guid.Empty"/>; a downstream dispatch carries the lineage it belongs to. An exporter
/// dispatched with an empty one was wired as an entry step, which it cannot be: it has nothing to
/// export, because nothing upstream produced anything. The guard runs first, before the payload and
/// data checks, so the diagnostic names the wiring rather than a symptom of it — the old message,
/// <i>"dispatched with no input to export"</i>, was true and misleading.
/// </para>
/// <para>
/// It never calls <c>SendToPostAsync</c>, so returning from <see cref="ProcessAsync"/> ends the
/// branch — the framework documents that as one of the three legitimate ways to finish — and the
/// workflow records the step Complete. A <see cref="FailedException"/> records it Failed. Those two
/// are the whole vocabulary, which is why every failure below converges on the same throw.
/// </para>
/// <para>
/// <b>Every fault fails the step, transient or deterministic, and the fault is never classified.</b>
/// An importer's loop can keep the items it already sent and stop early, so a fault before reading
/// and one after it mean different things. An exporter has exactly one thing to place and it either
/// placed it or it did not: there is no partial success to preserve and no second terminal to report
/// it with.
/// </para>
/// <para>
/// <b>No NACK, and for a sink that is structural rather than a policy.</b> The only requeue path in
/// <c>ProcessDispatchHandler</c> is <c>TransientSendException</c> and its subclass
/// <c>PostSendException</c>, and both can only arise from <c>SendToPostAsync</c> — which a sink never
/// calls. Everything thrown here lands on either the explicit <see cref="FailedException"/> catch or
/// the general one; both send <c>StepResult.Failed</c> and both acknowledge the dispatch. The
/// accepted cost: a transient blip on the write loses that branch permanently. It is recorded as a
/// failed step, so it is visible rather than silent, and recoverable by re-running.
/// </para>
/// <para>
/// <b>THE ONLY AUTHOR SHAPE HERE WITH A SIDE EFFECT, and the framework's replay rule is written for
/// pure transforms.</b> A redelivered dispatch replays this method and writes a second time. Two
/// things keep it narrow: the input-key delete is an idempotence token, so a redelivery that finds
/// the key gone returns without calling this method at all, and a source step's exemption from that
/// token does not apply — an exporter has an input key. What is left is the case where the delete
/// itself fails, and there the data is written twice with nothing recording that it was. That is
/// deliberate and it is the recoverable direction: the alternative is a write that might not have
/// happened, reported as though it had.
/// </para>
/// </summary>
public abstract class BaseExporter<TConfig>(ILogger logger) : BaseProcessor<TConfig>, IDisposable
    where TConfig : ExporterConfig
{
    private IExportSink? _sink;
    private string? _key;

    /// <summary>
    /// A sink ends the lineage, so the pre handler reports the terminal outcome this class's silence
    /// would otherwise withhold.
    /// <para>
    /// <b>Without it the orchestrator hears about a run only when it FAILS.</b> A successful export
    /// sends no branch, so the post handler never runs, so no <c>StepOutcome</c> is reported and the
    /// orchestrator's "the run ends here" line never fires — while a failed export reports through
    /// <c>Failure(...)</c> and does log it. That asymmetry made silence at the end of a trace mean
    /// either "finished" or "the records were lost", which is the one thing an operator needs it not
    /// to mean.
    /// </para>
    /// </summary>
    internal override bool EndsLineage => true;

    /// <summary>
    /// What "the same sink" means. It differs from the importer's on purpose and the difference is
    /// worth stating: a producer is not bound to the topic it writes to, so the destination is
    /// deliberately absent from a Kafka exporter's key, while the delivery timeout — fixed at
    /// construction — is in it, because a cached sink carries the timeout it was built with.
    /// </summary>
    protected abstract string CacheKey(TConfig config);

    /// <summary>
    /// Builds the adapter. Called only on a cache miss. It may throw
    /// <see cref="ExportSinkException"/>; the step fails.
    /// </summary>
    protected abstract IExportSink CreateSink(TConfig config);

    /// <summary>
    /// Where this dispatch's data goes: a topic, a folder, a bucket key. Passed to
    /// <see cref="IExportSink.WriteAsync"/> and named in every failure message and the log line.
    /// </summary>
    protected abstract string Destination(TConfig config);

    /// <summary>The payload fields this exporter needs, listed for the message when there is no payload.</summary>
    protected abstract string RequiredPayload { get; }

    /// <summary>
    /// The floor <c>DeliveryTimeoutSeconds</c> is validated against. One second by default, which is
    /// the smallest value that is still a timeout; a concrete exporter raises it when the client
    /// underneath needs more. It exists because a timeout of zero is read by some clients as "no
    /// timeout", which would hold this dispatch — and, at a prefetch of one, the replica's only lane
    /// — until the far side answered or the pod died. Nothing in the framework interrupts that: the
    /// cancellation token is never cancelled in production, by design.
    /// </summary>
    protected virtual int MinimumDeliveryTimeoutSeconds => 1;

    /// <summary>
    /// Anything else the payload must satisfy, checked after the framework's own guards and before
    /// the sink is built. Throw <see cref="FailedException"/>. The default checks nothing.
    /// </summary>
    protected virtual void Validate(TConfig config)
    {
    }

    /// <summary>The concrete exporter's name for the failure messages, without the Processor suffix.</summary>
    private string Name
    {
        get
        {
            var name = GetType().Name;
            return name.EndsWith("Processor", StringComparison.Ordinal)
                ? name[..^"Processor".Length]
                : name;
        }
    }

    protected sealed override async Task ProcessAsync(
        byte[] data, TConfig? config, Guid executionId, CancellationToken ct)
    {
        // THE EDGE GUARD, AND IT RUNS FIRST -- before the payload and before the data check, both of
        // which an entry-dispatched exporter would also trip. Reaching either of those first names
        // the symptom; this names the cause.
        if (executionId == Guid.Empty)
        {
            throw new FailedException(
                $"{Name} is an exporter: it ends a lineage and cannot open one. It was dispatched " +
                "as an entry step, with no execution to export, which means the workflow wires it " +
                "as an entry rather than downstream of the step that produces its input.");
        }

        // No meaningful default to fall back to. Inventing a destination would have this processor
        // write somewhere nobody asked for -- and unlike a misread, a misdirected write is not
        // recoverable by fixing the payload and running again. An absent payload is a workflow
        // authoring error and is reported as one.
        if (config is null)
        {
            throw new FailedException($"{Name} needs a step payload naming {RequiredPayload}");
        }

        if (config.DeliveryTimeoutSeconds < MinimumDeliveryTimeoutSeconds)
        {
            throw new FailedException(
                $"{Name} needs DeliveryTimeoutSeconds of at least {MinimumDeliveryTimeoutSeconds}; " +
                $"the step payload named {config.DeliveryTimeoutSeconds}");
        }

        Validate(config);

        var destination = Destination(config);

        // AN EMPTY INPUT IS A FAILURE, NOT AN EMPTY EXPORT. Writing zero bytes would put something
        // at the destination that no reader can do anything with, and the step would report Complete
        // while doing it -- the same false-healthy terminal the importer's MessageCount guard exists
        // to prevent, arriving from the other direction. With the edge guard above in place the one
        // condition left that reaches here is an upstream author that sent an empty branch, which is
        // an authoring error and is better loud.
        if (data.Length == 0)
        {
            throw new FailedException($"{Name} was dispatched with no input to export to {destination}");
        }

        IExportSink sink;
        try
        {
            sink = Rent(config);
        }
        catch (ExportSinkException ex)
        {
            throw new FailedException($"building a sink for {destination} failed: {ex.Message}");
        }

        string landed;
        try
        {
            landed = await sink.WriteAsync(destination, data, ct).ConfigureAwait(false);
        }
        catch (ExportSinkException ex)
        {
            // The sink is discarded as well as the step failed, matching the importer's rule: the
            // fast path is cached and the recovery path is not. Without this a sink wedged in a state
            // that fails every write stays cached for the life of the pod, and every dispatch that
            // lands on this replica fails against it.
            Evict();
            throw new FailedException($"exporting to {destination} failed: {ex.Message}");
        }

        // The record this processor exists to produce, and the counterpart to the importer's
        // "imported" line: together they are what lets an operator follow one payload from where it
        // arrived to where it left.
        //
        // ExecutionId is named explicitly. Unlike an importer this step mints nothing -- the id it
        // reports is the one it was dispatched with, which is exactly the point: this line is where a
        // lineage that began somewhere upstream is last seen.
        //
        // THE PAYLOAD ITSELF IS NOT LOGGED, which is the one place this deliberately differs from
        // BaseImporter's Describe hook. There an item's value can be the only identifier there is.
        // Here the branch already has an execution id that leads back to every step that touched it,
        // so rendering arbitrary upstream data into Elasticsearch a second time would buy nothing and
        // would put whatever a workflow happens to carry into the log in the clear.
        logger.LogInformation(
            "exported {Bytes} bytes of execution {ExecutionId} to {Destination} at {Offset}",
            data.Length, executionId, destination, landed);
    }

    /// <summary>
    /// The cached sink, or a new one when the step names a different one.
    /// <para>
    /// A cache of exactly one, safe for the reason <see cref="BaseImporter{TConfig}"/>'s is: the
    /// processor is a singleton and prefetch is one, so exactly one dispatch is in flight per
    /// replica. It fails the same way if prefetch ever moves.
    /// </para>
    /// </summary>
    private IExportSink Rent(TConfig config)
    {
        var key = CacheKey(config);
        if (_sink is not null && _key == key)
        {
            return _sink;
        }

        Evict();

        var sink = CreateSink(config);
        _sink = sink;
        _key = key;
        return sink;
    }

    /// <summary>Discards the cached sink. Safe to call when there is none.</summary>
    private void Evict()
    {
        if (_sink is null)
        {
            return;
        }

        try
        {
            // Blanket, and right here for the reason BaseImporter's Evict gives at length: this
            // method's entire job is to discard the sink, no failure of Dispose changes what happens
            // next, and anything propagated from here can only replace a fault already in flight with
            // a less informative one.
            try
            {
                _sink.Dispose();
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "disposing the export sink failed; discarding it anyway");
            }
        }
        finally
        {
            // In a finally so nothing Dispose throws can leave a broken sink cached forever, with the
            // next Evict calling Dispose on an already-disposed object.
            _sink = null;
            _key = null;
        }
    }

    /// <summary>
    /// The container owns this singleton and disposes it at shutdown, which is what flushes and closes
    /// the client rather than leaving it to be torn down with the process.
    /// </summary>
    public void Dispose()
    {
        Evict();
        GC.SuppressFinalize(this);
    }
}
