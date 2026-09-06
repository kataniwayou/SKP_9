using System.Text.Json;
using BaseProcessor.Core.Configuration;
using BaseProcessor.Core.Processing;
using Confluent.Kafka;
using Microsoft.Extensions.Logging;
using Processor.PathImporter.Kafka;

namespace Processor.PathImporter;

/// <summary>
/// Reads a topic of file paths and opens one lineage per path.
/// <para>
/// <b>A source step, which is what makes the committed offset load-bearing.</b> The framework is
/// explicit that a redelivered dispatch replays this method, and that the input-key delete which
/// normally makes that a no-op does not exist for a source step — there is no input key to reclaim.
/// So the offset is the only replay guard there is, and it is committed per record: a batch-level
/// commit would have a dispatch redelivered at record sixty re-read and re-send all sixty, opening
/// sixty duplicate lineages.
/// </para>
/// </summary>
public sealed class PathImporterProcessor(
    IPathConsumerFactory factory,
    ILogger<PathImporterProcessor> logger)
    : BaseProcessor<PathImporterConfig>, IDisposable
{
    private IPathConsumer? _consumer;
    private (string Brokers, string Topic, string Group)? _key;

    protected override async Task ProcessAsync(
        byte[] data, PathImporterConfig? config, Guid executionId, CancellationToken ct)
    {
        // Unlike the sample, there is no meaningful default to fall back to. Inventing a topic would
        // have this processor read from somewhere nobody asked for, so an absent payload is a
        // workflow authoring error and is reported as one.
        if (config is null)
        {
            throw new FailedException(
                "PathImporter needs a step payload naming brokerList, topic, consumerGroup, messageCount and idleTimeoutSeconds");
        }

        // A count or timeout below 1 is not "process nothing and say so" -- the loop below never
        // enters, `consumed` stays 0, `reason` stays its Completed default, and the line at the
        // bottom reports "consumed 0/0 paths; stopped because Completed". That is a false HEALTHY
        // terminal against a topic that was never read, and Elasticsearch cannot tell it apart from
        // a real completion -- exactly the class of bug the three-reason design exists to prevent.
        if (config.MessageCount < 1)
        {
            throw new FailedException(
                $"PathImporter needs MessageCount of at least 1; the step payload named {config.MessageCount}");
        }

        if (config.IdleTimeoutSeconds < 1)
        {
            throw new FailedException(
                $"PathImporter needs IdleTimeoutSeconds of at least 1; the step payload named {config.IdleTimeoutSeconds}");
        }

        var idle = TimeSpan.FromSeconds(config.IdleTimeoutSeconds);

        var consumed = 0;
        var reason = StopReason.Completed;

        // Renting is outside the loop's try so a fault here gets its own classification rather than
        // sharing the loop's: Create/Subscribe faults are consume-side faults exactly as much as a
        // failed Consume or Commit is, and the design's rule applies unchanged -- deterministic is
        // reported to the orchestrator as a failed step, transient is a Faulted terminal with
        // nothing consumed.
        IPathConsumer? consumer = null;
        try
        {
            consumer = Rent(config);
        }
        catch (KafkaException ex) when (KafkaFaultClassifier.IsDeterministic(ex.Error))
        {
            throw new FailedException($"subscribing to {config.Topic} failed: {ex.Error.Code}");
        }
        catch (KafkaException)
        {
            reason = StopReason.Faulted;
        }

        try
        {
            if (consumer is not null)
            {
                // Before anything is read. An unassigned consumer polls empty, and an empty poll is
                // indistinguishable from an empty topic — so without this the first dispatch after every
                // pod start would report a full topic Drained.
                if (!consumer.WaitForAssignment(idle))
                {
                    reason = StopReason.Faulted;
                }

                while (reason == StopReason.Completed && consumed < config.MessageCount)
                {
                    PathRecord? record;
                    try
                    {
                        record = consumer.Consume(idle);
                    }
                    catch (KafkaException ex) when (KafkaFaultClassifier.IsDeterministic(ex.Error))
                    {
                        throw new FailedException($"consuming {config.Topic} failed: {ex.Error.Code}");
                    }
                    catch (KafkaException)
                    {
                        reason = StopReason.Faulted;
                        break;
                    }

                    if (record is null)
                    {
                        reason = StopReason.Drained;
                        break;
                    }

                    // One per path, unconditionally — including when this dispatch arrived carrying an
                    // execution id. Every path is the origin of its own lineage; there is no case where
                    // this processor continues one it was handed.
                    var pathExecutionId = NewExecutionId();

                    // The record this processor exists to produce. CorrelationId rides the dispatch scope
                    // and is not named here; ExecutionId must be, because the scope carries the
                    // DISPATCH's id — Guid.Empty for a source step — and the id minted above appears
                    // nowhere else. Without this line the correlation id leads to a hundred
                    // indistinguishable records.
                    //
                    // It renders runtime data, which SampleProcessor forbids at length. The exception is
                    // narrow and deliberate: the path is not derived content, it is the business
                    // identifier and the only thing an operator would search for. The consequence is that
                    // paths land in Elasticsearch in the clear, and the mitigation, if that ever stops
                    // being acceptable, is to hash or truncate here.
                    logger.LogInformation(
                        "imported path {Path} as execution {ExecutionId} from {Offset}",
                        record.Path, pathExecutionId, record.Offset);

                    var payload = JsonSerializer.SerializeToUtf8Bytes(
                        new { path = record.Path }, ProcessorConfig.SerializerOptions);

                    // PostSendException propagates untouched, as the framework requires. It is safer here
                    // than for a pure transform: committed offsets mean the replayed dispatch resumes at
                    // the uncommitted path rather than re-sending the ones that already landed.
                    await SendToPostAsync(payload, pathExecutionId, ct).ConfigureAwait(false);

                    // The ACK, and it follows the send. Committing first would acknowledge a path whose
                    // branch had not been sent, and a fault between the two would lose it with nothing
                    // recording that it was lost. This way the failure is a duplicate, which is
                    // recoverable.
                    try
                    {
                        consumer.Commit(record);
                    }
                    catch (KafkaException ex) when (KafkaFaultClassifier.IsDeterministic(ex.Error))
                    {
                        throw new FailedException($"committing {config.Topic} failed: {ex.Error.Code}");
                    }
                    catch (KafkaException)
                    {
                        reason = StopReason.Faulted;
                        break;
                    }

                    consumed++;
                }
            }
        }
        catch
        {
            // A failing step leaves no consumer behind either. Rebuilding costs one group join and
            // removes any chance of inheriting whatever state produced the fault.
            Evict();
            throw;
        }

        if (reason == StopReason.Faulted)
        {
            Evict();
        }

        logger.LogInformation(
            "consumed {Consumed}/{Requested} paths; stopped because {Reason}",
            consumed, config.MessageCount, reason);
    }

    /// <summary>
    /// The cached consumer, or a new one when the step names a different broker, topic or group.
    /// <para>
    /// A cache of exactly one. Safe because the processor is a singleton and prefetch is one, so
    /// exactly one dispatch is in flight per replica — the same sentence that makes
    /// <c>BaseProcessor</c>'s dispatch field safe, and it fails the same way if prefetch ever moves.
    /// </para>
    /// </summary>
    private IPathConsumer Rent(PathImporterConfig config)
    {
        var key = (config.BrokerList, config.Topic, config.ConsumerGroup);
        if (_consumer is not null && _key == key)
        {
            return _consumer;
        }

        Evict();

        var consumer = factory.Create(config.BrokerList, config.ConsumerGroup);
        try
        {
            consumer.Subscribe(config.Topic);
        }
        catch
        {
            // Never cached below this point, so without this a Subscribe that throws would leak
            // the handle Create just returned: it is never stored in _consumer, so Evict never
            // sees it, and it would sit there as a leaked librdkafka handle and a group member
            // left to session timeout, once per failed dispatch.
            consumer.Dispose();
            throw;
        }

        _consumer = consumer;
        _key = key;
        return consumer;
    }

    private void Evict()
    {
        if (_consumer is null)
        {
            return;
        }

        try
        {
            // Close before Dispose so the group is left deliberately rather than by session timeout.
            // Close can itself throw on a consumer that is already broken, which is the common case
            // here — and failing to release the field would leave the broken one cached forever.
            try
            {
                _consumer.Close();
            }
            catch (KafkaException ex)
            {
                logger.LogWarning(ex, "closing the consumer failed; discarding it anyway");
            }

            try
            {
                _consumer.Dispose();
            }
            catch (KafkaException ex)
            {
                // Guarded the same way Close is, and for the same reason. This matters more here
                // than it looks: on the catch { Evict(); throw; } path above, an exception escaping
                // this method would REPLACE the fault already in flight rather than accompany it —
                // a PostSendException the framework would requeue silently becoming something the
                // framework fails outright.
                logger.LogWarning(ex, "disposing the consumer failed; discarding it anyway");
            }
        }
        finally
        {
            // In a finally so nothing Close or Dispose throws — recognised above or not — can skip
            // this and leave a broken consumer cached forever, with the next Evict() calling Close
            // on an already-disposed object and throwing ObjectDisposedException.
            _consumer = null;
            _key = null;
        }
    }

    /// <summary>
    /// The container owns this singleton and disposes it at shutdown, so the group is left cleanly
    /// instead of waiting out the session timeout.
    /// </summary>
    public void Dispose() => Evict();
}
