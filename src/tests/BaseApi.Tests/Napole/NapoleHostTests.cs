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
        ["Napole:Report:ReporterComponentName"]    = "myDepartment",
        ["Napole:Report:ReporterSubComponentName"] = "myTeam",
        ["Napole:Report:ReporterNetworkName"]      = "myNetwork",
        ["Napole:Report:SrcCode"]                  = "928",
        ["Napole:Report:SagCode"]                  = "LLL",
    };

    private static IHost Host(Dictionary<string, string?> configuration)
        => ProcessorHost.Create([], Identity, cfg => cfg.AddInMemoryCollection(configuration));

    [Fact]
    public void TheGraphResolves()
    {
        using var host = Host(Configuration());

        Assert.IsType<NapoleProcessor>(
            host.Services.GetRequiredService<BaseProcessor.Core.Processing.BaseProcessor>());
        Assert.Equal("LLL", host.Services.GetRequiredService<IOptions<NapoleOptions>>().Value.Report.SagCode);
        Assert.Equal(60, host.Services.GetRequiredService<IOptions<NapoleOptions>>().Value.LagSeconds);
        Assert.Equal(10, host.Services.GetRequiredService<IOptions<NapoleOptions>>().Value.TrailMinutes);
    }

    [Fact]
    public async Task AMissingReportDimensionFailsAtStart()
    {
        // A dimension is copied into every report, so a pod without one must never start: the
        // alternative is a report the downstream system cannot attribute, on every tick.
        var configuration = Configuration();
        configuration.Remove("Napole:Report:SagCode");
        using var host = Host(configuration);

        var ex = await Assert.ThrowsAsync<OptionsValidationException>(() => host.StartAsync(TestContext.Current.CancellationToken));

        Assert.Contains("SagCode", ex.Message, StringComparison.Ordinal);
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
