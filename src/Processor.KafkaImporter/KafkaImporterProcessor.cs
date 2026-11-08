using System.Text;
using BaseProcessor.Core.Processing;
using Confluent.Kafka;
using Microsoft.Extensions.Logging;
using Processor.KafkaImporter.Kafka;

namespace Processor.KafkaImporter;

/// <summary>
/// Reads a topic and opens one lineage per non-empty record, sending each record's value downstream
/// as is.
/// <para>
/// <b>Ordinary author code since 2026-09-29.</b> It used to derive from the edge base class, which
/// the framework no longer has. The loop, the one-consumer cache with evict-on-fault, send-then-commit
/// ordering and the log lines moved here unchanged. Log text is matched by Kibana, the Analyst and the
/// live tests, so none of it may be reworded.
/// </para>
/// <para>
/// <b>It never returns without sending its minimum.</b> A dispatch either sends at least
/// <c>minMessageCount</c> branches, or throws <see cref="CancelledException"/> when there was not
/// enough to import, or throws <see cref="FailedException"/> when the source broke before the minimum
/// was sent. Once the minimum has gone out, a later fault ends the dispatch where it stands with a
/// Warning.
/// </para>
/// <para>
/// <b>The minimum is a hold, decided before anything is read.</b> The records waiting are counted from
/// the broker's offsets first; fewer than the minimum (none included) and the dispatch is Cancelled
/// with nothing read, sent or committed, so they wait for a later dispatch. The count also ends the
/// loop, so neither an empty topic nor the end of a short one costs an idle timeout. Because the count
/// is an upper bound, a dispatch can still come up short on empty and tombstone records; that residue
/// is reported Cancelled after the fact, and the branches it did send carry on — each is committed
/// before the next record is read.
/// </para>
/// <para>
/// <b>Each record's lineage is its <c>execution-id</c> header</b>, a contract between the producer and
/// this processor (§7 of the in-process post design): a record re-read after a commit fault derives
/// the same key and is absorbed instead of forking. A record without a valid one is committed, not
/// imported, and the dispatch reports Failed. The input execution id is ignored.
/// </para>
/// </summary>
public sealed class KafkaImporterProcessor(
    IRecordConsumerFactory factory,
    ILogger<KafkaImporterProcessor> logger)
    : BaseProcessor<KafkaImporterConfig>, IDisposable
{
    /// <summary>The value logged as {Reason}. Its member names are the text operators search for.</summary>
    private enum StopReason
    {
        Completed,
        Drained,
        Faulted,
        Refused, // A record carried no valid execution-id header.
        Held,    // Fewer than the minimum were waiting; nothing was read.
    }

    private IRecordConsumer? _consumer;
    private string? _key;
    private bool _subscribed;

    protected override async Task ProcessAsync(
        byte[] data, KafkaImporterConfig? config, Guid executionId, CancellationToken ct)
    {
        if (config is null)
        {
            throw new FailedException(
                "KafkaImporter needs a step payload naming topic, consumerGroup, maxMessageCount and idleTimeoutSeconds");
        }

        // Below 1 the loop never runs and the summary would report a false healthy "0/0 Completed".
        if (config.MaxMessageCount < 1)
        {
            throw new FailedException(
                $"KafkaImporter needs MaxMessageCount of at least 1; the step payload named {config.MaxMessageCount}");
        }

        // Below 1 an empty poll would return as a success; above the ceiling every dispatch cancels.
        if (config.MinMessageCount < 1 || config.MinMessageCount > config.MaxMessageCount)
        {
            throw new FailedException(
                $"KafkaImporter needs MinMessageCount between 1 and MaxMessageCount ({config.MaxMessageCount}); "
                + $"the step payload named {config.MinMessageCount}");
        }

        if (config.IdleTimeoutSeconds < 1)
        {
            throw new FailedException(
                $"KafkaImporter needs IdleTimeoutSeconds of at least 1; the step payload named {config.IdleTimeoutSeconds}");
        }

        var idle = TimeSpan.FromSeconds(config.IdleTimeoutSeconds);

        // PART ONE: an open, assigned consumer. Any failure here fails the step, unclassified.
        IRecordConsumer consumer;
        try
        {
            consumer = Rent(config);
        }
        catch (KafkaException ex)
        {
            throw new FailedException($"opening {config.Topic} failed: {ex.Error.Code}", ex);
        }

        bool ready;
        try
        {
            if (!_subscribed)
            {
                consumer.Subscribe(config.Topic);
                _subscribed = true;
            }

            ready = consumer.WaitForAssignment(idle);
        }
        catch (KafkaException ex)
        {
            Evict();
            throw new FailedException($"opening {config.Topic} failed: {ex.Error.Code}", ex);
        }

        // A false return, not a throw, is what a stopped broker produces. Without an assignment an
        // empty poll is indistinguishable from an empty topic.
        if (!ready)
        {
            Evict();
            throw new FailedException($"{config.Topic} was not ready within {idle}");
        }

        // The count is part of opening the source, so a fault here fails the step like the wait above.
        long backlog;
        try
        {
            backlog = consumer.Backlog(idle);
        }
        catch (KafkaException ex)
        {
            Evict();
            throw new FailedException($"opening {config.Topic} failed: {ex.Error.Code}", ex);
        }

        // THE FLOOR IS A HOLD (2026-11-08). Short of the minimum nothing is read or sent: the records stay
        // on the topic, uncommitted, and the next dispatch counts them again with whatever arrived since.
        // Known from the count, so an empty or short topic costs no idle timeout to find out.
        if (backlog < config.MinMessageCount)
        {
            logger.LogInformation(
                "consumed {Consumed}/{Requested} records; stopped because {Reason}",
                0, config.MaxMessageCount, backlog == 0 ? StopReason.Drained : StopReason.Held);

            throw new CancelledException(backlog == 0
                ? $"{config.Topic} had no records to import"
                : $"{config.Topic} had {backlog} of the {config.MinMessageCount} record(s) required; "
                  + "nothing was sent, they wait for the next dispatch");
        }

        // PART TWO: the loop. Once a branch has been sent nothing in it fails the step. It stops at the
        // counted end rather than polling past it; the idle timeout only ends it when the count was high.
        var bound = (int)Math.Min(config.MaxMessageCount, backlog);
        var read = 0;       // every record consumed, sent or skipped; bounds the dispatch
        var sent = 0;       // branches finished (in L2, outcome confirmed)
        var imported = 0;   // sent AND committed; the {Consumed} the summary has always reported
        var reason = StopReason.Completed;
        KafkaException? fault = null;
        string? refused = null;

        try
        {
            while (read < bound)
            {
                KafkaRecord? record;
                try
                {
                    record = consumer.Consume(idle);
                }
                catch (KafkaException ex)
                {
                    logger.LogWarning(ex, "reading from {Source} faulted after {Imported} item(s)",
                        config.Topic, imported);

                    fault = ex;
                    reason = StopReason.Faulted;
                    break;
                }

                if (record is null)
                {
                    reason = StopReason.Drained;
                    break;
                }

                read++;

                // EMPTY AND TOMBSTONE RECORDS ARE NOT SENT (spec D4: a no-data send would report the
                // step Completed and run the chain on nothing). They are committed, or the partition
                // re-reads them for ever. Logged by offset only -- never content.
                if (record.Value is not { Length: > 0 } value)
                {
                    try
                    {
                        consumer.Commit(record);
                    }
                    catch (KafkaException ex)
                    {
                        logger.LogWarning(ex,
                            "committing a skipped record from {Source} faulted after {Imported} item(s)",
                            config.Topic, imported);

                        fault = ex;
                        reason = StopReason.Faulted;
                        break;
                    }

                    logger.LogInformation("skipped an empty record at {Origin}; nothing was sent", record.Offset);
                    continue;
                }

                // THE PRODUCER'S CONTRACT. Missing, not a GUID, or empty: refuse the record. Commit it
                // FIRST, or it is re-read and refused on every fire — a poison record that stops the
                // partition. Nothing is sent for it, so nothing is written to L2.
                if (!Guid.TryParse(record.ExecutionId, out var lineage) || lineage == Guid.Empty)
                {
                    refused = record.Offset;
                    reason = StopReason.Refused;

                    try
                    {
                        consumer.Commit(record);
                    }
                    catch (KafkaException ex)
                    {
                        logger.LogWarning(ex,
                            "committing a refused record from {Source} faulted after {Imported} item(s); "
                            + "it will be read and refused again",
                            config.Topic, imported);

                        fault = ex;
                        reason = StopReason.Faulted;
                    }

                    logger.LogWarning(
                        "refused the record at {Origin}: it carries no valid {Header} header", record.Offset,
                        KafkaRecord.ExecutionIdHeader);
                    break;
                }

                // Logged BEFORE the send, so a send that throws still leaves the lineage it was opening.
                // The value is rendered verbatim: it is the business identifier an operator searches for.
                logger.LogInformation(
                    "imported record {Record} as execution {ExecutionId} from {Origin}",
                    Encoding.UTF8.GetString(value), lineage, record.Offset);

                // PostSendException propagates untouched (spec D8); the uncommitted record is re-read.
                await SendToPostAsync(value, lineage, ct).ConfigureAwait(false);
                sent++;

                // The commit follows the send, so a fault between the two is a duplicate, never a loss.
                try
                {
                    consumer.Commit(record);
                }
                catch (KafkaException ex)
                {
                    logger.LogWarning(ex,
                        "acknowledging an item from {Source} faulted after {Imported} item(s); it "
                        + "will be read again and its branch has already been sent",
                        config.Topic, imported);

                    fault = ex;
                    reason = StopReason.Faulted;
                    break;
                }

                imported++;
            }
        }
        catch
        {
            Evict();
            throw;
        }

        if (reason == StopReason.Faulted)
        {
            Evict();
        }

        // Stopping at the counted end, short of the ceiling, is the topic running out: Drained, as an
        // empty poll reported it before the count existed.
        if (reason == StopReason.Completed && read < config.MaxMessageCount)
        {
            reason = StopReason.Drained;
        }

        // The text is unchanged and is matched by saved queries and the Analyst's run-boundary panel.
        // It is written before either throw below, so an empty poll stays countable by Consumed=0.
        logger.Log(
            reason == StopReason.Faulted ? LogLevel.Warning : LogLevel.Information,
            "consumed {Consumed}/{Requested} records; stopped because {Reason}",
            imported, config.MaxMessageCount, reason);

        // Even after earlier records were sent: they carry on, and the refusal is reported so the
        // PreviousFailed edge records it.
        if (refused is not null)
        {
            throw new FailedException(
                $"the record at {refused} carries no valid {KafkaRecord.ExecutionIdHeader} header; "
                + "it was committed and not imported");
        }

        if (sent >= config.MinMessageCount)
        {
            return;
        }

        // Short of the minimum because the source broke: a broker problem, not a quiet topic.
        if (fault is not null)
        {
            throw new FailedException(sent == 0
                ? $"reading from {config.Topic} faulted before any record was sent: {fault.Error.Code}"
                : $"reading from {config.Topic} faulted after {sent} of the {config.MinMessageCount} "
                  + $"record(s) required: {fault.Error.Code}", fault);
        }

        // Short of the minimum because the topic was: the same Cancelled an empty poll reports.
        throw new CancelledException(
            read == 0 ? $"{config.Topic} had no records to import"
            : sent == 0 ? $"every record read from {config.Topic} was empty"
            : $"{config.Topic} had {sent} of the {config.MinMessageCount} record(s) required; "
              + "the ones sent carry on");
    }

    /// <summary>
    /// A cache of one consumer, keyed on topic and group: a subscribed consumer is bound to both.
    /// Safe because the processor is a singleton and prefetch is one.
    /// </summary>
    private IRecordConsumer Rent(KafkaImporterConfig config)
    {
        var key = $"{config.Topic}|{config.ConsumerGroup}";
        if (_consumer is not null && _key == key)
        {
            return _consumer;
        }

        Evict();

        var consumer = factory.Create(config.ConsumerGroup);
        _consumer = consumer;
        _key = key;
        _subscribed = false;
        return consumer;
    }

    /// <summary>
    /// Discards the cached consumer. The catches are blanket on purpose: this method's job is to throw
    /// the handle away, and anything propagated from here would replace a fault already in flight.
    /// </summary>
    private void Evict()
    {
        if (_consumer is null)
        {
            return;
        }

        try
        {
            try
            {
                _consumer.Close();
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "closing the import source failed; discarding it anyway");
            }

            try
            {
                _consumer.Dispose();
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "disposing the import source failed; discarding it anyway");
            }
        }
        finally
        {
            _consumer = null;
            _key = null;
            _subscribed = false;
        }
    }

    /// <summary>The container disposes this singleton at shutdown, which leaves the group cleanly.</summary>
    public void Dispose()
    {
        Evict();
        GC.SuppressFinalize(this);
    }
}
