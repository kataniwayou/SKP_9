using BaseProcessor.Core.Processing;
using Confluent.Kafka;
using Microsoft.Extensions.Logging;
using Processor.KafkaExporter.Kafka;

namespace Processor.KafkaExporter;

/// <summary>
/// Produces a branch's data to a Kafka topic and ends the lineage there.
/// <para>
/// <b>A sink step, and the mirror image of <c>KafkaImporterProcessor</c>.</b> The importer has no
/// input and produces branches; this has an input and produces none. It never calls
/// <c>SendToPostAsync</c>, so returning from <see cref="ProcessAsync"/> ends the branch — the
/// framework documents that as one of the three legitimate ways to finish — and the workflow records
/// the step Complete. A <see cref="FailedException"/> records it Failed. Those two are the whole
/// vocabulary, which is why every failure below converges on the same throw.
/// </para>
/// <para>
/// <b>THE ONLY AUTHOR HERE WITH A SIDE EFFECT, and the framework's replay rule is written for pure
/// transforms.</b> A redelivered dispatch replays this method, and a replay produces the record a
/// second time. Two things keep it narrow: the input-key delete is an idempotence token, so a
/// redelivery that finds the key gone returns without calling this method at all, and a source step's
/// exemption from that token does not apply here — this step has an input key. What is left is the
/// case where the delete itself fails, and there the record is produced twice with nothing recording
/// that it was. That is deliberate and it is the recoverable direction: the alternative is a produce
/// that might not have happened, reported as though it had. Nothing here deduplicates, because a
/// dedup key would have to come from the payload and this processor does not interpret the payload.
/// </para>
/// </summary>
public sealed class KafkaExporterProcessor(
    IRecordProducerFactory factory,
    ILogger<KafkaExporterProcessor> logger)
    : BaseProcessor<KafkaExporterConfig>, IDisposable
{
    private IRecordProducer? _producer;
    private (string Brokers, int TimeoutSeconds)? _key;

    protected override async Task ProcessAsync(
        byte[] data, KafkaExporterConfig? config, Guid executionId, CancellationToken ct)
    {
        // No meaningful default to fall back to. Inventing a topic would have this processor write
        // somewhere nobody asked for -- and unlike a misread, a misdirected write is not recoverable
        // by fixing the payload and running again. An absent payload is a workflow authoring error
        // and is reported as one.
        if (config is null)
        {
            throw new FailedException(
                "KafkaExporter needs a step payload naming brokerList, topic and deliveryTimeoutSeconds");
        }

        // A timeout below the floor is not "wait a bit less". librdkafka reads 0 as "no timeout", so
        // it would hold this dispatch -- and at a prefetch of one, this replica's only lane -- until
        // the broker answered or the pod died, with nothing in the framework to interrupt it: the
        // cancellation token is never cancelled in production, by design. See KafkaProducerSettings.
        if (config.DeliveryTimeoutSeconds < KafkaProducerSettings.MinimumDeliveryTimeout.TotalSeconds)
        {
            throw new FailedException(
                $"KafkaExporter needs DeliveryTimeoutSeconds of at least " +
                $"{KafkaProducerSettings.MinimumDeliveryTimeout.TotalSeconds:0}; the step payload named " +
                $"{config.DeliveryTimeoutSeconds}");
        }

        // AN EMPTY INPUT IS A FAILURE, NOT AN EMPTY EXPORT. Producing a zero-byte record would put a
        // record on the topic that no downstream reader can do anything with, and the step would
        // report Complete while doing it -- the same false-healthy terminal the importer's
        // MessageCount guard exists to prevent, arriving from the other direction. The two conditions
        // that reach here are a source step wired to an exporter (data is empty by definition for a
        // source, and this is not one) and an upstream author that sent an empty branch; both are
        // authoring errors and both are better loud.
        if (data.Length == 0)
        {
            throw new FailedException(
                $"KafkaExporter was dispatched with no input to export to {config.Topic}");
        }

        // UNLIKE THE IMPORTER, THERE IS NO TWO-PART SPLIT, because there is nothing for a second part
        // to do differently. The importer's loop can keep the records it already sent and stop early,
        // so a fault after reading has started is worth distinguishing from one before it. Here the
        // step has exactly one record to place and it either placed it or it did not, so every
        // failure -- renting a producer, producing, an acknowledgement that will not confirm -- is the
        // same failed step. Classifying faults would buy nothing: there is no partial success to
        // preserve and no second terminal to report it with.
        IRecordProducer producer;
        try
        {
            producer = Rent(config);
        }
        catch (KafkaException ex)
        {
            Evict();
            throw new FailedException($"building a producer for {config.BrokerList} failed: {ex.Error.Code}");
        }

        string offset;
        try
        {
            offset = await producer.ProduceAsync(config.Topic, data, ct).ConfigureAwait(false);
        }
        catch (KafkaException ex)
        {
            // The producer is discarded as well as the step failed, matching the importer's rule: the
            // fast path is cached and the recovery path is not. Without this a producer wedged in a
            // state that fails every produce stays cached for the life of the pod, and every dispatch
            // that lands on this replica fails against it.
            Evict();
            throw new FailedException($"producing to {config.Topic} failed: {ex.Error.Code}");
        }

        // The record this processor exists to produce, and the counterpart to the importer's
        // "imported record" line: together they are what lets an operator follow one payload from the
        // topic it arrived on to the topic it left by.
        //
        // ExecutionId is named explicitly. Unlike the importer this step mints nothing -- the id it
        // reports is the one it was dispatched with, which is exactly the point: this line is where a
        // lineage that began somewhere upstream is last seen.
        //
        // THE PAYLOAD ITSELF IS NOT LOGGED, which is the one place this deliberately differs from the
        // importer. There the record value is the business identifier and the only thing an operator
        // could search for. Here the branch already has an execution id that leads back to every step
        // that touched it, so rendering arbitrary upstream data into Elasticsearch a second time would
        // buy nothing and would put whatever a workflow happens to carry into the log in the clear.
        logger.LogInformation(
            "exported {Bytes} bytes of execution {ExecutionId} to {Topic} at {Offset}",
            data.Length, executionId, config.Topic, offset);
    }

    /// <summary>
    /// The cached producer, or a new one when the step names a different broker list or delivery
    /// timeout.
    /// <para>
    /// A cache of exactly one, safe for the same reason the importer's is: the processor is a
    /// singleton and prefetch is one, so exactly one dispatch is in flight per replica. It fails the
    /// same way if prefetch ever moves.
    /// </para>
    /// <para>
    /// <b>The topic is not in the key</b> — a producer is not bound to one, and building a second
    /// producer per topic would pay a connection and a metadata fetch for nothing. The delivery
    /// timeout IS in the key, because that one is fixed at construction: a cached producer carries the
    /// timeout it was built with, and without this a dispatch naming a longer timeout would silently
    /// get the shorter one it inherited.
    /// </para>
    /// </summary>
    private IRecordProducer Rent(KafkaExporterConfig config)
    {
        var key = (config.BrokerList, config.DeliveryTimeoutSeconds);
        if (_producer is not null && _key == key)
        {
            return _producer;
        }

        Evict();

        var producer = factory.Create(
            config.BrokerList, TimeSpan.FromSeconds(config.DeliveryTimeoutSeconds));

        _producer = producer;
        _key = key;
        return producer;
    }

    private void Evict()
    {
        if (_producer is null)
        {
            return;
        }

        try
        {
            // Blanket, and right here for the reason the importer's Evict gives at length: this
            // method's entire job is to discard the producer, no failure of Dispose changes what
            // happens next, and anything propagated from here can only replace a fault already in
            // flight with a less informative one.
            try
            {
                _producer.Dispose();
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "disposing the producer failed; discarding it anyway");
            }
        }
        finally
        {
            // In a finally so nothing Dispose throws can leave a broken producer cached forever, with
            // the next Evict calling Dispose on an already-disposed object.
            _producer = null;
            _key = null;
        }
    }

    /// <summary>
    /// The container owns this singleton and disposes it at shutdown, which is what flushes and closes
    /// the producer rather than leaving librdkafka to be torn down with the process.
    /// </summary>
    public void Dispose() => Evict();
}
