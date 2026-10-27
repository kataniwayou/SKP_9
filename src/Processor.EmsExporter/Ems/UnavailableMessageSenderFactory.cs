namespace Processor.EmsExporter.Ems;

/// <summary>
/// The production factory UNTIL <c>TIBCO.EMS.dll</c> IS VENDORED. It refuses every sender by name, so
/// a deployed pod fails each dispatch with a message that says what is missing, rather than coming up
/// as something it cannot be.
/// <para>
/// <b>What replaces it</b>: an <c>EmsMessageSenderFactory</c> whose sender holds one
/// <c>Connection</c>, one non-transacted <c>AUTO_ACKNOWLEDGE</c> <c>Session</c> and one producer with
/// no destination. Built from a <c>ConnectionFactory</c> on <see cref="EmsServerOptions.ServerUrl"/>
/// with every connect and reconnect limit set from <see cref="EmsConnectionLimits"/>; an
/// <c>ExceptionListener</c> on the connection marks the sender dead. Each send is a
/// <c>BytesMessage</c> with <see cref="MessageProperties.ExecutionId"/> set, sent
/// <c>PERSISTENT</c> to a <c>Queue</c> cached by name, and every <c>EMSException</c> becomes an
/// <see cref="EmsSendException"/> carrying its <c>ErrorCode</c>. Dispose closes the connection.
/// </para>
/// </summary>
public sealed class UnavailableMessageSenderFactory : IMessageSenderFactory
{
    public const string Code = "CLIENT_NOT_INSTALLED";

    public IMessageSender Create(TimeSpan deliveryTimeout)
        => throw new EmsSendException(
            Code, "this image was built without TIBCO.EMS.dll, so it has no EMS client to connect with");
}
