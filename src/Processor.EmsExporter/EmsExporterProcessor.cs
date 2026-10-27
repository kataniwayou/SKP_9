using System.Globalization;
using BaseProcessor.Core.Processing;
using Microsoft.Extensions.Logging;
using Processor.EmsExporter.Ems;

namespace Processor.EmsExporter;

/// <summary>
/// Sends the branch it is dispatched with to an EMS queue, then reports Completed with a branch that
/// carries no data. <c>KafkaExporterProcessor</c>'s twin: the same rules in the same order, the same
/// cache, the same log template, with the queue in place of the topic.
/// <para>
/// <b>The message carries the execution it was dispatched with</b> in its
/// <see cref="MessageProperties.ExecutionId"/> property. The body is the branch byte for byte.
/// </para>
/// <para>
/// <b>EMS faults fail the step and are never redelivered.</b> An <see cref="EmsSendException"/>, or a
/// send that outlives the backstop, becomes a <see cref="FailedException"/>, and the sender is
/// discarded so the next dispatch connects afresh.
/// </para>
/// <para>
/// <b>The completion can replay the send, and that is accepted</b>, for the reason
/// <c>KafkaExporterProcessor</c> gives: a duplicate is recoverable — the consumer deduplicates on the
/// execution id — and a success reported as a failure is not.
/// </para>
/// </summary>
public sealed class EmsExporterProcessor(
    IMessageSenderFactory factory,
    EmsServerOptions server,
    ILogger<EmsExporterProcessor> logger)
    : BaseProcessor<EmsExporterConfig>, IDisposable
{
    private IMessageSender? _sender;
    private string? _key;

    /// <summary>
    /// How much longer than the delivery timeout a send may run before the step stops waiting for it.
    /// The connection limits are meant to fail the send inside the timeout; this catches a server that
    /// accepted the connection and then went quiet, which no reconnect limit sees. Settable for tests
    /// only; there is no pod configuration for it.
    /// </summary>
    internal TimeSpan BackstopGrace { get; init; } = TimeSpan.FromSeconds(5);

    protected override async Task ProcessAsync(
        byte[] data, EmsExporterConfig? config, Guid executionId, CancellationToken ct)
    {
        // First, before the payload and data checks, so a mis-wired step names the wiring rather than
        // a symptom of it.
        if (executionId == Guid.Empty)
        {
            throw new FailedException(
                "EmsExporter exports the execution it is dispatched with, and it was dispatched as " +
                "an entry step with none. Wire it downstream of the step that produces its input.");
        }

        if (config is null)
        {
            throw new FailedException("EmsExporter needs a step payload naming queue and deliveryTimeoutSeconds");
        }

        if (string.IsNullOrWhiteSpace(config.Queue))
        {
            throw new FailedException("EmsExporter needs a step payload naming a queue; it named none");
        }

        var floor = (int)EmsConnectionLimits.MinimumDeliveryTimeout.TotalSeconds;
        if (config.DeliveryTimeoutSeconds < floor)
        {
            throw new FailedException(
                $"EmsExporter needs DeliveryTimeoutSeconds of at least {floor}; " +
                $"the step payload named {config.DeliveryTimeoutSeconds}");
        }

        // An empty input is a failure, not an empty export: a zero-byte message is one no reader can
        // use, reported as Completed.
        if (data.Length == 0)
        {
            throw new FailedException($"EmsExporter was dispatched with no input to export to {config.Queue}");
        }

        if (data.Length > server.MaxMessageBytes)
        {
            // Before connecting: an oversize body fails the same way whatever the server's state.
            throw new FailedException(
                $"EmsExporter was dispatched {data.Length} bytes for {config.Queue}, above this pod's " +
                $"ceiling of {server.MaxMessageBytes}; raise Ems__MaxMessageBytes (up to the server's " +
                "max_msg_size) or export something smaller");
        }

        var timeout = TimeSpan.FromSeconds(config.DeliveryTimeoutSeconds);

        IMessageSender sender;
        try
        {
            sender = Rent(timeout);
        }
        catch (EmsSendException ex)
        {
            throw new FailedException($"building a sink for {config.Queue} failed: {ex.Code}", ex);
        }

        string landed;
        try
        {
            landed = await Send(sender, config.Queue, data, executionId, timeout, ct).ConfigureAwait(false);
        }
        catch (EmsSendException ex)
        {
            Evict();
            throw new FailedException($"exporting to {config.Queue} failed: {ex.Code}", ex);
        }
        catch (TimeoutException ex)
        {
            Evict();
            throw new FailedException(
                $"exporting to {config.Queue} failed: no answer within {(timeout + BackstopGrace).TotalSeconds:0}s", ex);
        }

        // KafkaExporter's template, so one query finds the exports of both. The payload is never
        // logged: the execution id already leads back to every step that touched it.
        logger.LogInformation(
            "exported {Bytes} bytes of execution {ExecutionId} to {Destination} at {MessageId}",
            data.Length, executionId, config.Queue, landed);

        // Completed, with nothing to hand on. PostSendException must propagate -- see the summary.
        await SendToPostAsync([], executionId, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// The send, bounded. A send still running at the backstop is abandoned rather than awaited: its
    /// eventual fault is observed here so it never surfaces as an unobserved task exception, and the
    /// caller evicts the sender, which closes the connection under it.
    /// </summary>
    private async Task<string> Send(
        IMessageSender sender, string queue, byte[] data, Guid executionId, TimeSpan timeout, CancellationToken ct)
    {
        var send = sender.SendAsync(queue, data, executionId, ct);
        try
        {
            return await send.WaitAsync(timeout + BackstopGrace, ct).ConfigureAwait(false);
        }
        catch (TimeoutException)
        {
            _ = send.ContinueWith(
                t => t.Exception, CancellationToken.None,
                TaskContinuationOptions.OnlyOnFaulted, TaskScheduler.Default);
            throw;
        }
    }

    /// <summary>
    /// A cache of one sender, keyed on the delivery timeout its connection limits were built from.
    /// The queue is not in the key: a sender names its queue per send. Safe because the processor is
    /// a singleton and prefetch is one — which is also what EMS needs, a session being single-threaded.
    /// </summary>
    private IMessageSender Rent(TimeSpan timeout)
    {
        var key = timeout.TotalSeconds.ToString(CultureInfo.InvariantCulture);
        if (_sender is not null && _key == key)
        {
            return _sender;
        }

        Evict();

        var sender = factory.Create(timeout);
        _sender = sender;
        _key = key;
        return sender;
    }

    /// <summary>Discards the cached sender. Blanket catch: nothing Dispose throws changes what happens next.</summary>
    private void Evict()
    {
        if (_sender is null)
        {
            return;
        }

        try
        {
            _sender.Dispose();
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "disposing the export sink failed; discarding it anyway");
        }
        finally
        {
            _sender = null;
            _key = null;
        }
    }

    /// <summary>The container disposes this singleton at shutdown, which closes the connection.</summary>
    public void Dispose()
    {
        Evict();
        GC.SuppressFinalize(this);
    }
}
