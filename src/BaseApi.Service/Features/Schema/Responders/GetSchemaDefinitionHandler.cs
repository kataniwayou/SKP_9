using System.Text.Json;
using BaseApi.Core.Exceptions;
using BaseApi.Core.Messaging;
using Messaging.Contracts;

namespace BaseApi.Service.Features.Schema.Responders;

/// <summary>
/// Answers a schema-definition lookup by id.
/// <para>
/// Same shape as the processor identity lookup, and for the same reason: an absent schema is a
/// not-found reply the caller can act on, never an exception that leaves them waiting.
/// </para>
/// </summary>
internal sealed class GetSchemaDefinitionHandler : IRpcHandler
{
    private readonly SchemaService _schemas;

    public GetSchemaDefinitionHandler(SchemaService schemas)
        => _schemas = schemas ?? throw new ArgumentNullException(nameof(schemas));

    public string RequestType => MessageTypes.GetSchemaDefinition;

    /// <summary>
    /// The refusal reply for a request whose id did not bind, or null when the request is usable.
    /// <para>
    /// A <see cref="Guid.Empty"/> here means the field did not bind — <c>MessagingJson</c> is
    /// case-sensitive by design, so a producer sending <c>"schemaId"</c> lands on the default rather
    /// than throwing. Answering not-found would be a valid-looking reply that the caller reads as
    /// "not registered yet", leaving it to retry forever with nothing logged anywhere.
    /// </para>
    /// </summary>
    internal static RpcReply? Reject(GetSchemaDefinition request)
        => request.SchemaId == Guid.Empty
            ? new RpcReply(
                MessageTypes.MalformedRequest,
                JsonSerializer.SerializeToUtf8Bytes(
                    new MalformedRequest(nameof(GetSchemaDefinition.SchemaId)), MessagingJson.Options))
            : null;

    public async Task<RpcReply> HandleAsync(ReadOnlyMemory<byte> body, CancellationToken ct)
    {
        var request = JsonSerializer.Deserialize<GetSchemaDefinition>(body.Span, MessagingJson.Options)
                      ?? throw new JsonException("schema definition request deserialized to null");

        if (Reject(request) is { } malformed)
        {
            return malformed;
        }

        try
        {
            var s = await _schemas.GetByIdAsync(request.SchemaId, ct);

            return new RpcReply(
                MessageTypes.SchemaDefinitionFound,
                JsonSerializer.SerializeToUtf8Bytes(
                    new SchemaDefinitionFound(s.Definition), MessagingJson.Options));
        }
        catch (NotFoundException)
        {
            return new RpcReply(
                MessageTypes.SchemaDefinitionNotFound,
                JsonSerializer.SerializeToUtf8Bytes(
                    new SchemaDefinitionNotFound(request.SchemaId), MessagingJson.Options));
        }
    }
}
