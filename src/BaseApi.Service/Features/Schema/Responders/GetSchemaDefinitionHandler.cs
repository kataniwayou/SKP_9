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

    public async Task<RpcReply> HandleAsync(ReadOnlyMemory<byte> body, CancellationToken ct)
    {
        var request = JsonSerializer.Deserialize<GetSchemaDefinition>(body.Span, MessagingJson.Options)
                      ?? throw new JsonException("schema definition request deserialized to null");

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
