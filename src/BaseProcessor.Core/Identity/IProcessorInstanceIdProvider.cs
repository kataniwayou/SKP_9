namespace BaseProcessor.Core.Identity;

/// <summary>
/// The stubbable seam that supplies the processor's registration instance id — the second half of
/// the identity query, alongside <see cref="ISourceHashProvider"/>.
/// <para>
/// <b>Null is the normal answer, not a failure.</b> It means "resolve the row every replica of this
/// build shares", which is what a processor deployed as a Deployment wants: its replicas are
/// interchangeable, they resolve one identity, and RabbitMQ round-robins one work queue between
/// them. A non-null answer means the opposite — this pod holds a registration of its own, and will
/// therefore declare and consume a work queue of its own.
/// </para>
/// </summary>
public interface IProcessorInstanceIdProvider
{
    /// <summary>
    /// Returns the instance id this pod registers under, or null when it shares its build's row.
    /// Blank is normalized to null, so an env var set to the empty string reads as absent rather
    /// than as an instance named "".
    /// </summary>
    string? Get();
}
