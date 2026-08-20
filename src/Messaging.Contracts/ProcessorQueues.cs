namespace Messaging.Contracts;

/// <summary>
/// Single source of truth for the API responder queue endpoint names, shared between the API, which
/// binds the receive endpoints, and the processor request clients that send to them. Bare
/// short-names, no scheme prefix.
/// </summary>
public static class ProcessorQueues
{
    public const string IdentityQuery = "processor-identity-query";
    public const string SchemaQuery   = "schema-definition-query";

    /// <summary>
    /// The per-processor work queue, carrying both dispatches and processed-data branches routed by
    /// the type header. Named rather than a bare GUID: every other queue here is a readable
    /// short-name, and a bare GUID is unidentifiable in the broker's management UI.
    /// </summary>
    public static string Work(Guid processorId) => $"processor-{processorId:D}";

    /// <summary>Where <see cref="Work"/> parks a message it cannot read.</summary>
    public static string Dead(Guid processorId) => $"processor-{processorId:D}.dead";

    /// <summary>
    /// The exchange <see cref="Work"/> names in its <c>x-dead-letter-exchange</c> argument. It must
    /// be declared before the queue that names it: the argument is not validated at declare time, so
    /// a queue pointing at a missing exchange is accepted and silently discards everything it parks.
    /// </summary>
    public const string DeadLetterExchange = "processor-dlx";
}
