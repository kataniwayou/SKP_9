using BaseProcessor.Core.Identity;
using Messaging.Contracts;
using Xunit;

namespace BaseApi.Tests.Processor;

public sealed class ProcessorContextTests
{
    [Fact]
    public void StartsEmpty()
    {
        var context = new ProcessorContext();

        Assert.Null(context.Id);
        Assert.False(context.IsHealthy);
    }

    [Fact]
    public void SetIdentityPopulatesEveryField()
    {
        var id = Guid.NewGuid();
        var input = Guid.NewGuid();
        var context = new ProcessorContext();

        context.SetIdentity(new ProcessorIdentityFound(id, input, null, null, "sample", "1.0.0"));

        Assert.Equal(id, context.Id);
        Assert.Equal(input, context.InputSchemaId);
        Assert.Null(context.OutputSchemaId);
        Assert.Equal("sample", context.Name);
        Assert.Equal("1.0.0", context.Version);
    }

    [Fact]
    public void SetDefinitionRoutesBySchemaId()
    {
        var input = Guid.NewGuid();
        var config = Guid.NewGuid();
        var context = new ProcessorContext();
        context.SetIdentity(new ProcessorIdentityFound(Guid.NewGuid(), input, null, config, "s", "1"));

        context.SetDefinition(input, "{\"type\":\"object\"}");
        context.SetDefinition(config, "{\"type\":\"string\"}");

        Assert.Equal("{\"type\":\"object\"}", context.InputDefinition);
        Assert.Equal("{\"type\":\"string\"}", context.ConfigDefinition);
        Assert.Null(context.OutputDefinition);
    }

    [Fact]
    public void MarkHealthyIsIdempotent()
    {
        var context = new ProcessorContext();

        context.MarkHealthy();
        context.MarkHealthy();

        Assert.True(context.IsHealthy);
    }
}
