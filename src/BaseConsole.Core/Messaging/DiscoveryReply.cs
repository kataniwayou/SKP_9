using System.Text.Json;
using Messaging.Contracts;

namespace BaseConsole.Core.Messaging;

/// <summary>
/// Turns a reply's type header plus body into the contract record it names. Unknown types return
/// null — the caller drops them. A malformed body throws, and the caller treats that as a property
/// of the message: log, ack, drop. The next ask produces a fresh answer.
/// </summary>
public static class DiscoveryReplyRouter
{
    public static object? Route(string type, ReadOnlyMemory<byte> body) => type switch
    {
        MessageTypes.ProcessorIdentityFound =>
            JsonSerializer.Deserialize<ProcessorIdentityFound>(body.Span, MessagingJson.Options),
        MessageTypes.ProcessorIdentityNotFound =>
            JsonSerializer.Deserialize<ProcessorIdentityNotFound>(body.Span, MessagingJson.Options),
        MessageTypes.SchemaDefinitionFound =>
            JsonSerializer.Deserialize<SchemaDefinitionFound>(body.Span, MessagingJson.Options),
        MessageTypes.SchemaDefinitionNotFound =>
            JsonSerializer.Deserialize<SchemaDefinitionNotFound>(body.Span, MessagingJson.Options),
        _ => null,
    };
}
