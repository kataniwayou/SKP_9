using System.Globalization;
using BaseProcessor.Core.Processing;
using Confluent.Kafka;
using Microsoft.Extensions.Logging;
using Processor.KafkaExporter.Kafka;

namespace Processor.KafkaExporter;

/// <summary>
/// Writes the branch it is dispatched with to a topic, then reports Completed with a branch that
/// carries no data.
/// <para>
/// <b>Ordinary author code since 2026-09-29.</b> It used to derive from <c>BaseExporter</c>, which
/// the framework no longer has. Every rule that class enforced is here now, as this processor's own
/// decisions: it needs the execution it exports, a payload, a delivery timeout at or above the
/// producer's floor, and non-empty data.
/// </para>
/// <para>
/// <b>Kafka faults fail the step and are never redelivered.</b> A <see cref="KafkaException"/> from
/// building or producing becomes a <see cref="FailedException"/>, and a producer that faulted on a
/// write is discarded so the next dispatch builds a fresh one.
/// </para>
/// <para>
/// <b>The completion can replay the write, and that is accepted.</b> The no-data send after the
/// write is a RabbitMQ send. If it fails, the <c>PostSendException</c> propagates, the input key is
/// still present, and the redelivery writes to Kafka a second time. This system always prefers a
/// duplicate to a success reported as a failure, so the exception is never caught here.
/// </para>
/// </summary>
public sealed class KafkaExporterProcessor(
    IRecordProducerFactory factory,
    ILogger<KafkaExporterProcessor> logger)
    : BaseProcessor<KafkaExporterConfig>, IDisposable
{
    private IRecordProducer? _producer;
    private string? _key;

    protected override async Task ProcessAsync(
        byte[] data, KafkaExporterConfig? config, Guid executionId, CancellationToken ct)
    {
        // First, before the payload and data checks, so a mis-wired step names the wiring rather than
        // a symptom of it.
        if (executionId == Guid.Empty)
        {
            throw new FailedException(
                "KafkaExporter exports the execution it is dispatched with, and it was dispatched as " +
                "an entry step with none. Wire it downstream of the step that produces its input.");
        }

        if (config is null)
        {
            throw new FailedException("KafkaExporter needs a step payload naming topic and deliveryTimeoutSeconds");
        }

        var floor = (int)KafkaProducerSettings.MinimumDeliveryTimeout.TotalSeconds;
        if (config.DeliveryTimeoutSeconds < floor)
        {
            throw new FailedException(
                $"KafkaExporter needs DeliveryTimeoutSeconds of at least {floor}; " +
                $"the step payload named {config.DeliveryTimeoutSeconds}");
        }

        // An empty input is a failure, not an empty export: writing zero bytes would put a record on
        // the topic no reader can use while reporting Completed.
        if (data.Length == 0)
        {
            throw new FailedException($"KafkaExporter was dispatched with no input to export to {config.Topic}");
        }

        IRecordProducer producer;
        try
        {
            producer = Rent(config);
        }
        catch (KafkaException ex)
        {
            throw new FailedException($"building a sink for {config.Topic} failed: {ex.Error.Code}");
        }

        string landed;
        try
        {
            landed = await producer.ProduceAsync(config.Topic, data, ct).ConfigureAwait(false);
        }
        catch (KafkaException ex)
        {
            Evict();
            throw new FailedException($"exporting to {config.Topic} failed: {ex.Error.Code}");
        }

        // The payload is never logged: the execution id already leads back to every step that
        // touched it.
        logger.LogInformation(
            "exported {Bytes} bytes of execution {ExecutionId} to {Destination} at {Offset}",
            data.Length, executionId, config.Topic, landed);

        // Completed, with nothing to hand on. PostSendException must propagate -- see the summary.
        await SendToPostAsync([], executionId, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// A cache of one producer, keyed on the delivery timeout it was built with. The topic is not in
    /// the key: a producer is not bound to the topic it writes to. Safe because the processor is a
    /// singleton and prefetch is one.
    /// </summary>
    private IRecordProducer Rent(KafkaExporterConfig config)
    {
        var key = config.DeliveryTimeoutSeconds.ToString(CultureInfo.InvariantCulture);
        if (_producer is not null && _key == key)
        {
            return _producer;
        }

        Evict();

        var producer = factory.Create(TimeSpan.FromSeconds(config.DeliveryTimeoutSeconds));
        _producer = producer;
        _key = key;
        return producer;
    }

    /// <summary>Discards the cached producer. Blanket catch: nothing Dispose throws changes what happens next.</summary>
    private void Evict()
    {
        if (_producer is null)
        {
            return;
        }

        try
        {
            _producer.Dispose();
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "disposing the export sink failed; discarding it anyway");
        }
        finally
        {
            _producer = null;
            _key = null;
        }
    }

    /// <summary>The container disposes this singleton at shutdown, which flushes and closes the producer.</summary>
    public void Dispose()
    {
        Evict();
        GC.SuppressFinalize(this);
    }
}
