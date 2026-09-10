using BaseProcessor.Core.Identity;
using Messaging.Contracts;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Processor.FileFetcher;
using Xunit;

namespace BaseApi.Tests.FileFetcher;

public sealed class ProcessorFileFetcherTests
{
    private static readonly ProcessorIdentityFound Identity = new(
        Guid.Parse("9c41b7e2-3a86-4d51-8f07-1b6e5d2c4a83"),
        InputSchemaId: null, OutputSchemaId: null, ConfigSchemaId: null,
        Name: "file-fetcher", Version: "1.0.0");

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
    public void TheHostGraphResolves()
    {
        // A shell's one failure mode is a registration nobody remembered. It surfaces at startup in
        // production and nowhere at all at compile time.
        using var host = Build();

        Assert.NotNull(host);
    }

    [Fact]
    public void TheAuthorIsRegisteredAsTheFrameworksProcessor()
    {
        using var host = Build();

        var resolved = host.Services.GetRequiredService<BaseProcessor.Core.Processing.BaseProcessor>();

        Assert.IsType<FileFetcherProcessor>(resolved);
    }
}
