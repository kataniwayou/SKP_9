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
}
