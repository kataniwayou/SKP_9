namespace Messaging.Transport;

/// <summary>
/// A send failed because the broker was unreachable, not because the message was wrong.
/// <para>
/// <b>This distinction decides whether work survives.</b> A consumer classifies an unrecognised
/// exception as the message being unprocessable and parks it on the first delivery, with no retry —
/// which is correct for a body that will never parse, and catastrophic for a send that failed during
/// a broker blip. The message was fine; only the environment was not, and a redelivery would succeed.
/// </para>
/// <para>
/// <b>It is deliberately not classified as a projection-store fault.</b> Those trip the L2 gate and
/// pause consumption, which is right when the store is unreachable and wrong here — pausing over a
/// broker fault spreads one dependency's failure to a dependency that is healthy.
/// </para>
/// <para>
/// <b>Not sealed, deliberately.</b> A caller that knows which send failed subclasses this to carry
/// that detail — the processor's post send does, so an author fanning out can tell which branch was
/// lost. The consumer classifies on the base type, so a subclass inherits the requeue disposition
/// without the classifier learning about it.
/// </para>
/// </summary>
public class TransientSendException : Exception
{
    public TransientSendException(string message, Exception inner) : base(message, inner)
    {
    }
}
