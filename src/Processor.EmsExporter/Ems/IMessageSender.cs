namespace Processor.EmsExporter.Ems;

/// <summary>
/// Everything the step knows about EMS, which is one verb — the same bargain
/// <c>Processor.KafkaExporter</c>'s <c>IRecordProducer</c> makes, and for the same reason: every
/// terminal rule and the sender cache can be tested against a fake, with no EMS server anywhere in
/// the hermetic suite. Nothing from <c>TIBCO.EMS</c> crosses it.
/// </summary>
public interface IMessageSender : IDisposable
{
    /// <summary>
    /// Sends <paramref name="body"/> to <paramref name="queue"/> as a persistent message and does not
    /// return until the server has stored it.
    /// <para>
    /// <b>The wait is the whole contract.</b> On a non-transacted session a <c>PERSISTENT</c> send
    /// blocks until the server confirms it, which is what lets Completed mean "the message exists".
    /// An implementation that sends <c>NON_PERSISTENT</c>, or that enables the server's
    /// <c>npsend_check_mode</c> shortcuts, does not satisfy this interface.
    /// </para>
    /// <para>
    /// <b>Binding on every implementation:</b> returning normally means the server stored the
    /// message. Anything else throws <see cref="EmsSendException"/>, never a TIBCO type.
    /// </para>
    /// <para>
    /// <b><paramref name="executionId"/> rides the message's <see cref="MessageProperties.ExecutionId"/>
    /// property</b>, never the body, which goes out byte for byte.
    /// </para>
    /// </summary>
    /// <returns>The <c>JMSMessageID</c> the server assigned, for the log line.</returns>
    Task<string> SendAsync(string queue, byte[] body, Guid executionId, CancellationToken ct);
}
