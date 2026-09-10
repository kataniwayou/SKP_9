using Messaging.Contracts;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Processor.ArchiveCollapser;
using Processor.ArchiveCollapser.Writers;
using Xunit;

namespace BaseApi.Tests.DependencyInjection;

/// <summary>
/// The one thing worth asserting about a shell: that its service graph actually resolves. Asserted
/// without starting a process, which is why ProcessorHost.Create is separate from StartAsync.
/// </summary>
public sealed class ArchiveCollapserHostTests
{
    private static readonly ProcessorIdentityFound Identity = new(
        Guid.Parse("66666666-6666-6666-6666-666666666666"),
        InputSchemaId: null, OutputSchemaId: null, ConfigSchemaId: null,
        Name: "archive-collapser", Version: "1.0.0");

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

        Assert.IsType<ArchiveCollapserProcessor>(processor);
    }

    [Fact]
    public void BothWritersAreRegisteredAndRarIsNot()
    {
        using var host = Build();

        var extensions = host.Services
            .GetServices<IArchiveWriter>()
            .Select(w => w.Extension)
            .Order()
            .ToArray();

        // .rar is absent BY DESIGN and this asserts it stays absent: RAR is proprietary and
        // SharpCompress can only read it, so a writer for it cannot exist.
        Assert.Equal([".tar", ".zip"], extensions);
    }
}
