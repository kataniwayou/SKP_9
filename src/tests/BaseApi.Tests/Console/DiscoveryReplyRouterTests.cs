using System.Text;
using System.Text.Json;
using BaseConsole.Core.Messaging;
using Messaging.Contracts;
using Xunit;

namespace BaseApi.Tests.Console;

public sealed class DiscoveryReplyRouterTests
{
    private static ReadOnlyMemory<byte> Json<T>(T value) =>
        JsonSerializer.SerializeToUtf8Bytes(value, MessagingJson.Options);

    [Fact]
    public void RoutesIdentityFound()
    {
        var found = new ProcessorIdentityFound(
            Guid.NewGuid(), null, null, null, "sample", "1.0.0");

        var routed = DiscoveryReplyRouter.Route(MessageTypes.ProcessorIdentityFound, Json(found));

        Assert.Equal(found, Assert.IsType<ProcessorIdentityFound>(routed));
    }

    [Fact]
    public void RoutesIdentityNotFound()
    {
        var routed = DiscoveryReplyRouter.Route(
            MessageTypes.ProcessorIdentityNotFound, Json(new ProcessorIdentityNotFound("abc")));

        Assert.Equal("abc", Assert.IsType<ProcessorIdentityNotFound>(routed).SourceHash);
    }

    [Fact]
    public void RoutesSchemaFound()
    {
        var routed = DiscoveryReplyRouter.Route(
            MessageTypes.SchemaDefinitionFound, Json(new SchemaDefinitionFound("{}")));

        Assert.Equal("{}", Assert.IsType<SchemaDefinitionFound>(routed).Definition);
    }

    [Fact]
    public void UnknownTypeReturnsNull() =>
        Assert.Null(DiscoveryReplyRouter.Route("no-such-type", Json(new { x = 1 })));

    [Fact]
    public void MalformedBodyThrows() =>
        Assert.ThrowsAny<JsonException>(() => DiscoveryReplyRouter.Route(
            MessageTypes.ProcessorIdentityFound,
            new ReadOnlyMemory<byte>(Encoding.UTF8.GetBytes("{not json"))));
}
