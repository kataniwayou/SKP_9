using System.Text.Json;
using BaseApi.Core.Exceptions;
using BaseApi.Core.Messaging;
using Messaging.Contracts;

namespace BaseApi.Service.Features.Processor.Responders;

/// <summary>
/// Answers a processor identity lookup by source hash.
/// <para>
/// <b>A miss is an answer, not a fault.</b> The lookup throws not-found, which is caught here and
/// turned into the not-found reply shape, so the caller pattern-matches on two ordinary answers
/// rather than distinguishing a reply from a timeout. Letting the not-found escape would leave the
/// caller waiting for a message that was never going to come.
/// </para>
/// </summary>
internal sealed class GetProcessorBySourceHashHandler : IRpcHandler
{
    private readonly ProcessorService _processors;

    public GetProcessorBySourceHashHandler(ProcessorService processors)
        => _processors = processors ?? throw new ArgumentNullException(nameof(processors));

    public string RequestType => MessageTypes.GetProcessorBySourceHash;

    /// <summary>
    /// The refusal reply for a request whose source hash did not bind, or null when it is usable. See
    /// <c>GetSchemaDefinitionHandler.Reject</c>: an unbound field defaults rather than throwing, and a
    /// not-found reply for one is indistinguishable from a processor that is simply not registered
    /// yet — which the caller retries forever.
    /// </summary>
    internal static RpcReply? Reject(GetProcessorBySourceHash request)
        => string.IsNullOrWhiteSpace(request.SourceHash)
            ? new RpcReply(
                MessageTypes.MalformedRequest,
                JsonSerializer.SerializeToUtf8Bytes(
                    new MalformedRequest(nameof(GetProcessorBySourceHash.SourceHash)), MessagingJson.Options))
            : null;

    public async Task<RpcReply> HandleAsync(ReadOnlyMemory<byte> body, CancellationToken ct)
    {
        var request = JsonSerializer.Deserialize<GetProcessorBySourceHash>(body.Span, MessagingJson.Options)
                      ?? throw new JsonException("processor identity request deserialized to null");

        if (Reject(request) is { } malformed)
        {
            return malformed;
        }

        try
        {
            var p = await _processors.GetBySourceHashAsync(request.SourceHash, ct);

            return new RpcReply(
                MessageTypes.ProcessorIdentityFound,
                JsonSerializer.SerializeToUtf8Bytes(
                    new ProcessorIdentityFound(
                        p.Id, p.InputSchemaId, p.OutputSchemaId, p.ConfigSchemaId, p.Name, p.Version),
                    MessagingJson.Options));
        }
        catch (NotFoundException)
        {
            return new RpcReply(
                MessageTypes.ProcessorIdentityNotFound,
                JsonSerializer.SerializeToUtf8Bytes(
                    new ProcessorIdentityNotFound(request.SourceHash), MessagingJson.Options));
        }
    }
}
