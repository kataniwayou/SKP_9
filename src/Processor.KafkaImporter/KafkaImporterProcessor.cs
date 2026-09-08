using System.Text;
using BaseProcessor.Core.Configuration;
using BaseProcessor.Core.Processing;
using Confluent.Kafka;
using Microsoft.Extensions.Logging;
using Processor.KafkaImporter.Kafka;

namespace Processor.KafkaImporter;

/// <summary>
/// Reads a topic and opens one lineage per record, sending each record's value downstream as is.
/// <para>
/// <b>A source step, which is what makes the committed offset load-bearing.</b> The framework is
/// explicit that a redelivered dispatch replays this method, and that the input-key delete which
/// normally makes that a no-op does not exist for a source step — there is no input key to reclaim.
/// So the offset is the only replay guard there is, and it is committed per record: a batch-level
/// commit would have a dispatch redelivered at record sixty re-read and re-send all sixty, opening
/// sixty duplicate lineages.
/// </para>
/// </summary>
public sealed class KafkaImporterProcessor(
    IRecordConsumerFactory factory,
    ILogger<KafkaImporterProcessor> logger)
    : BaseProcessor<KafkaImporterConfig>, IDisposable
{
    private IRecordConsumer? _consumer;
    private (string Brokers, string Topic, string Group)? _key;

    protected override async Task ProcessAsync(
        byte[] data, KafkaImporterConfig? config, Guid executionId, CancellationToken ct)
    {
        // Unlike the sample, there is no meaningful default to fall back to. Inventing a topic would
        // have this processor read from somewhere nobody asked for, so an absent payload is a
        // workflow authoring error and is reported as one.
        if (config is null)
        {
            throw new FailedException(
                "KafkaImporter needs a step payload naming brokerList, topic, consumerGroup, messageCount and idleTimeoutSeconds");
        }

        // A count or timeout below 1 is not "process nothing and say so" -- the loop below never
        // enters, `consumed` stays 0, `reason` stays its Completed default, and the line at the
        // bottom reports "consumed 0/0 records; stopped because Completed". That is a false HEALTHY
        // terminal against a topic that was never read, and Elasticsearch cannot tell it apart from
        // a real completion -- exactly the class of bug the three-reason design exists to prevent.
        if (config.MessageCount < 1)
        {
            throw new FailedException(
                $"KafkaImporter needs MessageCount of at least 1; the step payload named {config.MessageCount}");
        }

        if (config.IdleTimeoutSeconds < 1)
        {
            throw new FailedException(
                $"KafkaImporter needs IdleTimeoutSeconds of at least 1; the step payload named {config.IdleTimeoutSeconds}");
        }

        var idle = TimeSpan.FromSeconds(config.IdleTimeoutSeconds);

        var consumed = 0;
        var reason = StopReason.Completed;

        // THE DISPATCH HAS TWO PARTS AND THEY FAIL DIFFERENTLY.
        //
        // Part one is getting a subscribed consumer with a partition under it: rent from the cache or
        // create, subscribe, wait for assignment. ANY failure here fails the step, and the fault code
        // is not consulted -- transient or permanent, this dispatch got no consumer, and a source step
        // that never reached its broker is the one condition nothing downstream can infer. No branches
        // arriving is exactly what an empty topic looks like too, so silence would be a lie.
        //
        // Part two is the loop, and NOTHING in it fails the step. A fault after reading has started
        // ends the dispatch where it stands, keeping the records already sent and committed; the next
        // dispatch re-subscribes, and a fault that is genuinely permanent surfaces in part one, where
        // it does fail. This is why the fault classifier is gone: the split does the work the
        // deterministic allow-list used to attempt, without having to guess which error codes recur.
        // Guessing was already shown to be unreliable -- 25c9ed5 removed a code Confluent does not
        // define.
        IRecordConsumer consumer;
        try
        {
            consumer = Rent(config);
        }
        catch (KafkaException ex)
        {
            throw new FailedException($"subscribing to {config.Topic} failed: {ex.Error.Code}");
        }

        try
        {
            {
                // Before anything is read. An unassigned consumer polls empty, and an empty poll is
                // indistinguishable from an empty topic — so without this the first dispatch after every
                // pod start would report a full topic Drained.
                //
                // Per §8, Subscribe does not throw on a nonexistent topic or a missing authorization
                // grant -- the error surfaces on the first read after it, which in production is the
                // read inside WaitForAssignment. So this is also where a mis-authored payload lands.
                bool assigned;
                try
                {
                    assigned = consumer.WaitForAssignment(idle);
                }
                catch (KafkaException ex)
                {
                    throw new FailedException($"waiting for {config.Topic} assignment failed: {ex.Error.Code}");
                }

                // A false return, not an exception, is what a live broker outage actually produces:
                // measured against a stopped broker at 87ms on a warm consumer and at the full idle
                // timeout on a cold one, neither of them throwing. It fails the step for the same
                // reason a throw here does.
                if (!assigned)
                {
                    throw new FailedException(
                        $"no partition of {config.Topic} was assigned within {idle}");
                }

                while (reason == StopReason.Completed && consumed < config.MessageCount)
                {
                    KafkaRecord? record;
                    try
                    {
                        record = consumer.Consume(idle);
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

                    // One per record, unconditionally — including when this dispatch arrived carrying an
                    // execution id. Every record is the origin of its own lineage; there is no case where
                    // this processor continues one it was handed.
                    var recordExecutionId = NewExecutionId();

                    // The record this processor exists to produce. CorrelationId rides the dispatch scope
                    // and is not named here; ExecutionId must be, because the scope carries the
                    // DISPATCH's id — Guid.Empty for a source step — and the id minted above appears
                    // nowhere else. Without this line the correlation id leads to a hundred
                    // indistinguishable records.
                    //
                    // It renders runtime data, which SampleProcessor forbids at length. The exception is
                    // narrow and deliberate: the record value is not derived content, it is the business
                    // identifier and the only thing an operator would search for. Two consequences that
                    // were acceptable for a file path and are worth restating now the value is arbitrary:
                    // record values land in Elasticsearch in the clear, and nothing here truncates them,
                    // so a topic of large values writes large log lines. The mitigation, if either ever
                    // stops being acceptable, is to hash or truncate at this line.
                    //
                    // THE DECODE IS FOR THE LOG AND ONLY FOR THE LOG. The branch below carries
                    // record.Value untouched; this renders a copy, and invalid UTF-8 becomes replacement
                    // characters HERE rather than in the data — which is the whole reason the seam
                    // carries bytes. See KafkaRecord.
                    logger.LogInformation(
                        "imported record {Record} as execution {ExecutionId} from {Offset}",
                        Encoding.UTF8.GetString(record.Value), recordExecutionId, record.Offset);

                    // AS IS: the record's value becomes the branch's data with nothing added, removed or
                    // re-encoded. This processor does not interpret what the topic carries, so there is
                    // no envelope to build -- whatever shape the records have is the shape downstream
                    // receives, and it is the processor's registered OUTPUT SCHEMA that decides whether
                    // that shape is acceptable. A topic whose records do not satisfy that schema fails
                    // in the post handler, one hop later, not here.
                    //
                    // PostSendException propagates untouched, as the framework requires. It is safer here
                    // than for a pure transform: committed offsets mean the replayed dispatch resumes at
                    // the uncommitted record rather than re-sending the ones that already landed.
                    await SendToPostAsync(record.Value, recordExecutionId, ct).ConfigureAwait(false);

                    // The ACK, and it follows the send. Committing first would acknowledge a record whose
                    // branch had not been sent, and a fault between the two would lose it with nothing
                    // recording that it was lost. This way the failure is a duplicate, which is
                    // recoverable.
                    try
                    {
                        consumer.Commit(record);
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
            "consumed {Consumed}/{Requested} records; stopped because {Reason}",
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
    private IRecordConsumer Rent(KafkaImporterConfig config)
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
            //
            // Both catches below are deliberately blanket, which is normally a smell and is right
            // here for a specific reason: this method's entire job is to discard the consumer, and
            // there is no failure of Close or Dispose that changes what happens next -- the handle
            // is being thrown away either way. So there is nothing here worth propagating, and
            // anything this method does propagate can only destroy information the caller already
            // had: on the catch { Evict(); throw; } path above, a throw out of Evict would REPLACE
            // the fault already in flight rather than accompany it -- a PostSendException the
            // framework would requeue silently becoming something the framework fails outright, with
            // the real fault gone. An ObjectDisposedException from a double Close, which the real
            // adapter raises, is exactly the case a narrower catch would have let through.
            try
            {
                _consumer.Close();
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "closing the consumer failed; discarding it anyway");
            }

            try
            {
                _consumer.Dispose();
            }
            catch (Exception ex)
            {
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
