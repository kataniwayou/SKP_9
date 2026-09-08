namespace BaseProcessor.Core.Configuration;

/// <summary>
/// The half of an importer's step payload that every importer has, whatever it reads.
/// <para>
/// <b>These two are here because the framework enforces them.</b> <c>BaseImporter</c> rejects a
/// count or a timeout below one before it opens anything, and it can only do that if it can see
/// them — so they are not a convenience for the subclass, they are the fields the guard reads. A
/// concrete config adds whatever names its source (a broker list and a topic, a folder) and passes
/// these two through its own primary constructor, which is what keeps the payload flat: nothing
/// nests just because the type hierarchy does.
/// </para>
/// </summary>
/// <param name="MessageCount">
/// The most items one dispatch will import. A dispatch that reaches it stops at
/// <c>StopReason.Completed</c>; the next dispatch resumes where this one acknowledged.
/// </param>
/// <param name="IdleTimeoutSeconds">
/// How long a single read waits before reporting nothing there. It is also how long opening the
/// source is given, because a source that is not ready and a source with nothing in it are the same
/// wait from the caller's side.
/// </param>
public abstract record ImporterConfig(int MessageCount, int IdleTimeoutSeconds) : ProcessorConfig;

/// <summary>
/// The half of an exporter's step payload that every exporter has.
/// <para>
/// <b>One field, and it is the one with no counterpart on the importer.</b> An export handles
/// exactly one input — the branch the orchestrator dispatched — so there is nothing to count and no
/// idle to wait out. What is left is the bound on waiting for the far side to admit it stored the
/// data, and that bound belongs to the workflow author rather than the framework: they know how long
/// their step may reasonably block and the framework does not.
/// </para>
/// </summary>
/// <param name="DeliveryTimeoutSeconds">
/// How long the write may wait for an acknowledgement. Validated against
/// <c>BaseExporter.MinimumDeliveryTimeoutSeconds</c>, which the concrete exporter sets, because the
/// floor is a property of the client underneath rather than of this contract.
/// </param>
public abstract record ExporterConfig(int DeliveryTimeoutSeconds) : ProcessorConfig;
