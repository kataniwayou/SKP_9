namespace Processor.EmsExporter.Ems;

/// <summary>
/// Mints a sender for one delivery timeout. Separate from <see cref="IMessageSender"/> so the
/// processor's cache can be tested by counting how many times this was called.
/// <para>
/// <b>The timeout is the one thing a sender is bound to at construction</b>: it becomes the
/// connection factory's connect and reconnect limits (see <see cref="EmsConnectionLimits"/>), which
/// EMS fixes when the connection is made. The queue is named per send, and the server and its
/// credential come from configuration — see <see cref="EmsServerOptions"/>.
/// </para>
/// </summary>
public interface IMessageSenderFactory
{
    /// <exception cref="EmsSendException">The connection could not be made.</exception>
    IMessageSender Create(TimeSpan deliveryTimeout);
}
