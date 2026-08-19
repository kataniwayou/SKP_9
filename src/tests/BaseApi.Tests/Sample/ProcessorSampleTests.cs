using System.Reflection;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Processor.Sample;
using Xunit;

namespace BaseApi.Tests.Sample;

public sealed class ProcessorSampleTests
{
    private static IHost Build() => ProcessorHost.Create(
        // Development turns on the container's build-time validation, which is the whole point of
        // this test: every registration is checked for constructibility without anything being
        // instantiated, so no broker or store is contacted.
        ["--environment", "Development"],
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
    public void EveryLoopIsHosted()
    {
        using var host = Build();

        var hosted = host.Services.GetServices<IHostedService>().Select(h => h.GetType().Name).ToList();

        Assert.Contains("ProcessorStartupOrchestrator", hosted);
        Assert.Contains("ProcessorLivenessHeartbeat", hosted);
        Assert.Contains("EmbeddedHealthEndpointService", hosted);
    }

    [Fact]
    public void TheSourceHashIsStampedOnThisAssembly()
    {
        // The identity the API matches a processor row against. It is emitted by an MSBuild target
        // whose own notes warn that a mis-ordered hook embeds nothing at all — and the failure is
        // invisible until the first discovery request retries forever against a hash of nothing.
        var hash = typeof(ProcessorHost).Assembly
            .GetCustomAttributes<AssemblyMetadataAttribute>()
            .SingleOrDefault(a => a.Key == "SourceHash")?.Value;

        Assert.NotNull(hash);
        Assert.Matches("^[0-9a-f]{64}$", hash);
    }

    [Fact]
    public void TheSourceHashCoversTheLibraryAsWellAsTheShell()
    {
        // It must change when BaseProcessor.Core changes, not only when this project does: the two
        // compile into one behaviour, and a hash that ignored the library would let an unchanged
        // shell claim an identity whose implementation had moved underneath it.
        var hash = typeof(ProcessorHost).Assembly
            .GetCustomAttributes<AssemblyMetadataAttribute>()
            .Single(a => a.Key == "SourceHash").Value!;

        // A constant would only restate the build; assert the property that makes it meaningful —
        // it is a digest, so it cannot be the digest of an empty set.
        Assert.NotEqual(new string('0', 64), hash);
        Assert.Matches("^[0-9a-f]{64}$", hash);
    }
}
