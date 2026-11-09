using BaseProcessor.Core.Configuration;
using Messaging.Contracts;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;
using Processor.Napole;
using Xunit;

namespace BaseApi.Tests.Napole;

public sealed class NapoleHostTests
{
    private static readonly ProcessorIdentityFound Identity = new(
        Guid.Parse("99999999-9999-9999-9999-999999999999"),
        InputSchemaId: null, OutputSchemaId: null, ConfigSchemaId: null,
        Name: "napole", Version: "1.0.0");

    private static Dictionary<string, string?> Configuration() => new()
    {
        ["Service:Name"]            = "processor",
        ["Service:Version"]         = "0.0.0",
        ["ConnectionStrings:Redis"] = "localhost:6379,abortConnect=false",
        ["RabbitMq:Host"]           = "localhost",
        ["RabbitMq:Username"]       = "guest",
        ["RabbitMq:Password"]       = "guest",
        ["Napole:ElasticBaseUrl"]   = "http://localhost:19200",
    };

    private static IHost Host(Dictionary<string, string?> configuration)
        => ProcessorHost.Create([], Identity, cfg => cfg.AddInMemoryCollection(configuration));

    [Fact]
    public void TheGraphResolves()
    {
        using var host = Host(Configuration());

        Assert.IsType<NapoleProcessor>(
            host.Services.GetRequiredService<BaseProcessor.Core.Processing.BaseProcessor>());
        Assert.Equal(60, host.Services.GetRequiredService<IOptions<NapoleOptions>>().Value.LagSeconds);
        Assert.Equal(10, host.Services.GetRequiredService<IOptions<NapoleOptions>>().Value.TrailMinutes);
    }

    [Fact]
    public void ThePodNeedsNoReportDimensions()
    {
        // All five moved to the step payload (reach spec §2.5). Options validation runs on first read,
        // so a pod that still required one would throw here.
        using var host = Host(Configuration());

        Assert.Equal("http://localhost:19200", host.Services.GetRequiredService<IOptions<NapoleOptions>>().Value.ElasticBaseUrl);
    }

    [Fact]
    public async Task AMissingElasticBaseUrlFailsAtStart()
    {
        var configuration = Configuration();
        configuration.Remove("Napole:ElasticBaseUrl");
        using var host = Host(configuration);

        var ex = await Assert.ThrowsAsync<OptionsValidationException>(() => host.StartAsync(TestContext.Current.CancellationToken));

        Assert.Contains("ElasticBaseUrl", ex.Message, StringComparison.Ordinal);
    }
}
