using System.Text.Json;
using BaseApi.Service.Features.Processor.Responders;
using BaseApi.Service.Features.Schema.Responders;
using BaseConsole.Core.Messaging;
using Messaging.Contracts;
using Xunit;

namespace BaseApi.Tests.Messaging;

public sealed class MalformedRequestTests
{
    // The guard is a static so it can be exercised without a handler instance. Both handlers take a
    // sealed service that cannot be substituted and null-guard it in their constructors, so there is
    // no way to build one for a test — and the guard is the whole behaviour under test anyway.
    [Fact]
    public void AMisnamedFieldBindsToItsDefaultRatherThanThrowing()
    {
        // The premise of this whole task, pinned so it cannot drift: MessagingJson is case-sensitive
        // by design, so "schemaId" does not bind to SchemaId and the property silently defaults.
        var request = JsonSerializer.Deserialize<GetSchemaDefinition>(
            """{"schemaId":"7a1d9e2c-0000-0000-0000-000000000001"}"""u8, MessagingJson.Options);

        Assert.Equal(Guid.Empty, request!.SchemaId);
    }

    [Fact]
    public void SchemaLookupRefusesAnEmptyIdInsteadOfAnsweringNotFound()
    {
        // Answering not-found here would read to the caller as "not registered yet", and it would
        // retry forever without anything being logged on either side.
        var reply = GetSchemaDefinitionHandler.Reject(new GetSchemaDefinition(Guid.Empty));

        Assert.NotNull(reply);
        Assert.Equal(MessageTypes.MalformedRequest, reply!.Type);
        var body = JsonSerializer.Deserialize<MalformedRequest>(reply.Body.Span, MessagingJson.Options);
        Assert.Equal(nameof(GetSchemaDefinition.SchemaId), body!.Field);
    }

    [Fact]
    public void SchemaLookupPassesAWellFormedRequestThrough()
    {
        Assert.Null(GetSchemaDefinitionHandler.Reject(new GetSchemaDefinition(Guid.NewGuid())));
    }

    [Fact]
    public void IdentityLookupRefusesAnEmptySourceHash()
    {
        var reply = GetProcessorBySourceHashHandler.Reject(new GetProcessorBySourceHash(""));

        Assert.NotNull(reply);
        Assert.Equal(MessageTypes.MalformedRequest, reply!.Type);
        var body = JsonSerializer.Deserialize<MalformedRequest>(reply.Body.Span, MessagingJson.Options);
        Assert.Equal(nameof(GetProcessorBySourceHash.SourceHash), body!.Field);
    }

    [Fact]
    public void IdentityLookupPassesAWellFormedRequestThrough()
    {
        Assert.Null(GetProcessorBySourceHashHandler.Reject(new GetProcessorBySourceHash("abc123")));
    }

    [Fact]
    public void TheReplyRouterRecognisesIt()
    {
        // Without this the caller drops the reply as an unknown type and still waits out its timeout,
        // which is the failure this whole task exists to remove.
        var routed = DiscoveryReplyRouter.Route(
            MessageTypes.MalformedRequest,
            JsonSerializer.SerializeToUtf8Bytes(new MalformedRequest("SchemaId"), MessagingJson.Options));

        var typed = Assert.IsType<MalformedRequest>(routed);
        Assert.Equal("SchemaId", typed.Field);
    }
}
