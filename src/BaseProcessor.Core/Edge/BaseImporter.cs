using BaseProcessor.Core.Configuration;
using BaseProcessor.Core.Processing;
using Microsoft.Extensions.Logging;

namespace BaseProcessor.Core.Edge;

/// <summary>
/// The class an importer derives from: a step with no input that reads a source and opens one
/// lineage per item. A subclass supplies a config record, an adapter and a cache key, and nothing
/// else — every rule about how an edge behaves lives here.
/// <para>
/// <b>What makes it an edge is <c>ExecutionId</c>, and nothing else.</b> An entry dispatch carries
/// <see cref="Guid.Empty"/>; a downstream dispatch carries the lineage it belongs to. An importer
/// that was handed a lineage was wired as a downstream step, which it cannot be: every item it reads
/// is the origin of its own lineage, so there is no lineage it could continue. That is
/// <see cref="ProcessAsync"/>'s first act, before the payload is looked at, so the diagnostic names
/// the wiring rather than a symptom of it.
/// </para>
/// <para>
/// <b>This is not defensive.</b> Until 2026-09-08 the sample workflow wired its exporter
/// <c>entryCondition: Always</c>, so a failed importer handed off to it with <c>ExecutionId</c> empty
/// and the exporter ran on an entry-shaped dispatch every time an import failed. The wiring is fixed;
/// the guard is what makes the class of error impossible rather than absent.
/// </para>
/// <para>
/// <b>It is not the framework's own source test.</b> <c>ProcessDispatchHandler</c> asks
/// <c>d.EntryId == Guid.Empty</c> — a different field, decided before the author is invoked, and it
/// governs whether L2 is read and the input schema applied. The two fields co-vary on every dispatch
/// the orchestrator produces, because <c>WorkflowFireJob</c> hard-codes both to
/// <see cref="Guid.Empty"/> on an entry fire, but they are independent on the wire. One rule on one
/// field, deliberately: no <c>EntryId</c> check is added here.
/// </para>
/// <para>
/// <b>A source step, which is what makes the acknowledgement load-bearing.</b> A redelivered dispatch
/// replays <see cref="ProcessAsync"/>, and the input-key delete that normally makes that a no-op does
/// not exist for a source step — there is no input key to reclaim. So the acknowledgement is the only
/// replay guard there is, and <see cref="IImportSource.Acknowledge"/> is called per item for exactly
/// that reason.
/// </para>
/// </summary>
public abstract class BaseImporter<TConfig>(ILogger logger) : BaseProcessor<TConfig>, IDisposable
    where TConfig : ImporterConfig
{
    private IImportSource? _source;
    private string? _key;

    /// <summary>
    /// What "the same source" means, so a dispatch naming a different one gets a different source
    /// rather than silently inheriting this one. It differs per importer on purpose: a subscribed
    /// consumer is bound to a broker list, a topic and a group; a folder reader is bound to a path.
    /// </summary>
    protected abstract string CacheKey(TConfig config);

    /// <summary>
    /// Builds the adapter. Called only on a cache miss, and never for a config the guards above have
    /// already rejected. It may throw <see cref="ImportSourceException"/>; the step fails.
    /// </summary>
    protected abstract IImportSource CreateSource(TConfig config);

    /// <summary>
    /// The source in one phrase, for the failure messages: a topic name, a folder path. This is the
    /// human-readable counterpart to <see cref="CacheKey"/> and it is separate from it because a
    /// cache key answers "is this the same one" and this answers "which one was it".
    /// </summary>
    protected abstract string SourceName(TConfig config);

    /// <summary>The payload fields this importer needs, listed for the message when there is no payload.</summary>
    protected abstract string RequiredPayload { get; }

    /// <summary>
    /// Anything else the payload must satisfy, checked after the framework's own guards and before
    /// the source is built. Throw <see cref="FailedException"/>. The default checks nothing.
    /// </summary>
    protected virtual void Validate(TConfig config)
    {
    }

    /// <summary>
    /// The opt-in for logging what an item CARRIES rather than only where it came from. Null — the
    /// default — logs <see cref="ImportedItem.Origin"/> alone, which is the safe answer: an origin is
    /// an identifier the operator chose, and a payload is arbitrary data that would land in
    /// Elasticsearch in the clear, untruncated.
    /// <para>
    /// An importer whose items ARE their identifiers — a folder reader, whose origin is the path —
    /// needs no override.
    /// </para>
    /// </summary>
    protected virtual string? Describe(ImportedItem item) => null;

    /// <summary>The concrete importer's name for the failure messages, without the Processor suffix.</summary>
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
        // THE EDGE GUARD, AND IT RUNS FIRST. Before the payload, because a downstream-wired importer
        // is a wiring error and every other message this method can produce would describe a symptom
        // of it instead.
        if (executionId != Guid.Empty)
        {
            throw new FailedException(
                $"{Name} is an importer: every item it reads opens its own lineage, so it cannot " +
                $"continue one. It was dispatched inside execution {executionId}, which means the " +
                "workflow wires it downstream of another step. An importer must be an entry step.");
        }

        // No meaningful default to fall back to. Inventing a source would have this processor read
        // from somewhere nobody asked for, so an absent payload is a workflow authoring error and is
        // reported as one.
        if (config is null)
        {
            throw new FailedException($"{Name} needs a step payload naming {RequiredPayload}");
        }

        // A count or timeout below 1 is not "import nothing and say so" -- the loop below never
        // enters, `imported` stays 0, `reason` stays its Completed default, and the line at the
        // bottom reports "consumed 0/0 records; stopped because Completed". That is a false HEALTHY
        // terminal against a source that was never read, and Elasticsearch cannot tell it apart from
        // a real completion -- exactly the class of bug the three-reason vocabulary exists to prevent.
        if (config.MessageCount < 1)
        {
            throw new FailedException(
                $"{Name} needs MessageCount of at least 1; the step payload named {config.MessageCount}");
        }

        if (config.IdleTimeoutSeconds < 1)
        {
            throw new FailedException(
                $"{Name} needs IdleTimeoutSeconds of at least 1; the step payload named {config.IdleTimeoutSeconds}");
        }

        Validate(config);

        var idle = TimeSpan.FromSeconds(config.IdleTimeoutSeconds);

        var imported = 0;
        var reason = StopReason.Completed;

        // THE DISPATCH HAS TWO PARTS AND THEY FAIL DIFFERENTLY.
        //
        // Part one is getting a source that is open and ready. ANY failure here fails the step, and
        // the fault is not classified -- transient or permanent, this dispatch got no source, and a
        // source step that never reached its source is the one condition nothing downstream can
        // infer. No branches arriving is exactly what an empty source looks like too, so silence
        // would be a lie.
        //
        // Part two is the loop, and NOTHING in it fails the step. A fault after reading has started
        // ends the dispatch where it stands, keeping the items already sent and acknowledged; the
        // next dispatch reopens, and a fault that is genuinely permanent surfaces in part one, where
        // it does fail. The split does the work a deterministic fault allow-list used to attempt,
        // without having to guess which error codes recur.
        IImportSource source;
        try
        {
            source = Rent(config);
        }
        catch (ImportSourceException ex)
        {
            // Rent evicts before it builds and caches only on success, so there is nothing left here.
            throw new FailedException($"opening {SourceName(config)} failed: {ex.Message}");
        }

        bool ready;
        try
        {
            ready = source.Open(idle);
        }
        catch (ImportSourceException ex)
        {
            Evict();
            throw new FailedException($"opening {SourceName(config)} failed: {ex.Message}");
        }

        // A false return, not a throw, is what an outage of the far side actually produces: measured
        // against a stopped broker at 87ms on a warm consumer and at the full idle timeout on a cold
        // one, neither of them throwing. It fails the step for the same reason a throw here does.
        if (!ready)
        {
            Evict();
            throw new FailedException($"{SourceName(config)} was not ready within {idle}");
        }

        try
        {
            while (reason == StopReason.Completed && imported < config.MessageCount)
            {
                ImportedItem? item;
                try
                {
                    item = source.Read(idle);
                }
                catch (ImportSourceException)
                {
                    reason = StopReason.Faulted;
                    break;
                }

                if (item is null)
                {
                    reason = StopReason.Drained;
                    break;
                }

                // One per item, unconditionally. Every item is the origin of its own lineage, which
                // is the same sentence the edge guard above enforces from the other direction.
                var itemExecutionId = NewExecutionId();

                // The record this processor exists to produce, and it is logged BEFORE the send: a
                // send that throws must still leave a line naming the lineage it was opening.
                // ExecutionId must be named explicitly, because the dispatch scope carries the
                // DISPATCH's id -- Guid.Empty for a source step -- and the id minted above appears
                // nowhere else. Without this the correlation id leads to a hundred indistinguishable
                // records.
                var described = Describe(item);
                if (described is null)
                {
                    logger.LogInformation(
                        "imported item from {Origin} as execution {ExecutionId}",
                        item.Origin, itemExecutionId);
                }
                else
                {
                    logger.LogInformation(
                        "imported record {Record} as execution {ExecutionId} from {Origin}",
                        described, itemExecutionId, item.Origin);
                }

                // AS IS: the item's data becomes the branch's data with nothing added, removed or
                // re-encoded. An importer does not interpret what its source carries, so there is no
                // envelope to build -- whatever shape the items have is the shape downstream
                // receives, and it is the processor's registered OUTPUT SCHEMA that decides whether
                // that shape is acceptable. Data that does not satisfy it fails in the post handler,
                // one hop later, not here.
                //
                // PostSendException propagates untouched, as the framework requires -- which is why
                // the catches around Read and Acknowledge name ImportSourceException rather than
                // catching broadly. It is safer here than for a pure transform: per-item
                // acknowledgement means the replayed dispatch resumes at the unacknowledged item
                // rather than re-sending the ones that already landed.
                await SendToPostAsync(item.Data, itemExecutionId, ct).ConfigureAwait(false);

                // The ACK, and it follows the send. Acknowledging first would consume an item whose
                // branch had not been sent, and a fault between the two would lose it with nothing
                // recording that it was lost. This way the failure is a duplicate, which is
                // recoverable.
                try
                {
                    source.Acknowledge(item);
                }
                catch (ImportSourceException)
                {
                    reason = StopReason.Faulted;
                    break;
                }

                imported++;
            }
        }
        catch
        {
            // A failing step leaves no source behind either. Rebuilding costs one reopen and removes
            // any chance of inheriting whatever state produced the fault.
            Evict();
            throw;
        }

        if (reason == StopReason.Faulted)
        {
            Evict();
        }

        // "records" rather than "items", because this line predates the base class and an operator's
        // saved queries and dashboards are matched against this exact text.
        logger.LogInformation(
            "consumed {Consumed}/{Requested} records; stopped because {Reason}",
            imported, config.MessageCount, reason);
    }

    /// <summary>
    /// The cached source, or a new one when the step names a different one.
    /// <para>
    /// A cache of exactly one. Safe because the processor is a singleton and prefetch is one, so
    /// exactly one dispatch is in flight per replica — the same sentence that makes
    /// <c>BaseProcessor</c>'s dispatch field safe, and it fails the same way if prefetch ever moves.
    /// </para>
    /// </summary>
    private IImportSource Rent(TConfig config)
    {
        var key = CacheKey(config);
        if (_source is not null && _key == key)
        {
            return _source;
        }

        Evict();

        var source = CreateSource(config);
        _source = source;
        _key = key;
        return source;
    }

    /// <summary>Discards the cached source. Safe to call when there is none.</summary>
    private void Evict()
    {
        if (_source is null)
        {
            return;
        }

        try
        {
            // Both catches are deliberately blanket, which is normally a smell and is right here for
            // a specific reason: this method's entire job is to discard the source, and there is no
            // failure of Close or Dispose that changes what happens next -- the handle is being
            // thrown away either way. So there is nothing here worth propagating, and anything this
            // method does propagate can only destroy information the caller already had: on the
            // catch { Evict(); throw; } path above, a throw out of Evict would REPLACE the fault
            // already in flight rather than accompany it -- a PostSendException the framework would
            // requeue silently becoming something the framework fails outright, with the real fault
            // gone. An ObjectDisposedException from a double Close, which real adapters raise, is
            // exactly the case a narrower catch would let through.
            try
            {
                _source.Close();
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "closing the import source failed; discarding it anyway");
            }

            try
            {
                _source.Dispose();
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "disposing the import source failed; discarding it anyway");
            }
        }
        finally
        {
            // In a finally so nothing Close or Dispose throws -- recognised above or not -- can skip
            // this and leave a broken source cached forever, with the next Evict calling Close on an
            // already-disposed object.
            _source = null;
            _key = null;
        }
    }

    /// <summary>
    /// The container owns this singleton and disposes it at shutdown, so the source is released
    /// cleanly instead of waiting out whatever timeout the far side keeps.
    /// </summary>
    public void Dispose()
    {
        Evict();
        GC.SuppressFinalize(this);
    }
}
