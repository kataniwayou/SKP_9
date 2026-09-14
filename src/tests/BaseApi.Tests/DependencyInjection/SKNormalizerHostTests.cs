using Messaging.Contracts;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Processor.SKNormalizer;
using Xunit;

namespace BaseApi.Tests.DependencyInjection;

public sealed class SKNormalizerHostTests
{
    private static readonly ProcessorIdentityFound Identity = new(
        Guid.Parse("77777777-7777-7777-7777-777777777777"),
        InputSchemaId: null, OutputSchemaId: null, ConfigSchemaId: null,
        Name: "sk-normalizer", Version: "1.0.0");

    private static IHost Build() => ProcessorHost.Create(
        // Development turns on the container's build-time validation, which is the whole point:
        // every registration is checked for constructibility without anything being instantiated,
        // so no broker or store is contacted.
        ["--environment", "Development"],
        Identity,
        cfg => cfg.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Service:Name"]            = "processor",
            ["Service:Version"]         = "0.0.0",
            ["ConnectionStrings:Redis"] = "localhost:6379,abortConnect=false",
            ["RabbitMq:Host"]           = "localhost",
            ["RabbitMq:Username"]       = "guest",
            ["RabbitMq:Password"]       = "guest",
        }));

    [Fact]
    public void TheServiceGraphResolves()
    {
        using var host = Build();

        var processor = host.Services
            .GetRequiredService<BaseProcessor.Core.Processing.BaseProcessor>();

        Assert.IsType<SKNormalizerProcessor>(processor);
    }

    [Fact]
    public void EveryRegisteredHandlerReachesTheRegistry()
    {
        using var host = Build();

        var registry = host.Services.GetRequiredService<ProviderHandlerRegistry>();

        // Ordinal order, which is what ProviderHandlerRegistry sorts by so an unknown-handler
        // rejection message is stable between failures.
        Assert.Equal(["Acme", "AlphaBeta", "Sample"], registry.Names);
    }

    [Fact]
    public void TheWhitelistIsRegisteredAsAPassThrough()
    {
        // The seam for the deferred Redis whitelist. Registered now so turning it on later is a
        // registration swap rather than a reshaping of stages 3 and 4.
        using var host = Build();

        Assert.True(host.Services.GetRequiredService<IFieldWhitelist>().Allows("anything"));
    }
}
