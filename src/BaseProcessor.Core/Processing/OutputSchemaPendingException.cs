using Messaging.Transport;

namespace BaseProcessor.Core.Processing;

/// <summary>
/// The output schema this processor declares has not resolved yet, so a branch cannot be validated.
/// <para>
/// <b>A <see cref="TransientSendException"/> on purpose</b>: that is the type the consumer requeues
/// without tripping the L2 gate. The queue hop parked this case on its own dead-letter queue; inside
/// the dispatch a park would throw the author's work away over a condition that clears in seconds.
/// <see cref="BaseProcessor.SendToPostAsync"/> lets it through unwrapped.
/// </para>
/// </summary>
internal sealed class OutputSchemaPendingException : TransientSendException
{
    public OutputSchemaPendingException(Guid outputSchemaId)
        : base(
            $"Output schema {outputSchemaId:D} has not resolved yet, so the branch cannot be validated",
            new InvalidOperationException("the processor has not reached Healthy"))
    {
    }
}
