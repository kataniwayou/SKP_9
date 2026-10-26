using BaseProcessor.Core.Identity;
using Messaging.Contracts;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Processor.ObjectPersister;
using Xunit;

namespace BaseApi.Tests.ObjectPersister;

public sealed class ObjectPersisterHostTests
{
    private static readonly ProcessorIdentityFound Identity = new(
        Guid.Parse("5e7a3c19-8b42-4f60-a1d5-2c9e6b0f7d34"),
        InputSchemaId: null, OutputSchemaId: null, ConfigSchemaId: null,
        Name: "object-persister", Version: "1.0.0");

    private static IHost Build(bool withServiceUrl) => ProcessorHost.Create(
        // Development turns on the container's build-time validation, which is the whole point:
        // every registration is checked for constructibility, so no broker, store or bucket is
        // contacted.
        ["--environment", "Development"],
        Identity,
        cfg =>
        {
            cfg.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Service:Name"]            = "processor",
                ["Service:Version"]         = "0.0.0",
                ["ConnectionStrings:Redis"] = "localhost:6379,abortConnect=false",
                ["RabbitMq:Host"]           = "localhost",
                ["RabbitMq:Username"]       = "guest",
                ["RabbitMq:Password"]       = "guest",
            });

            // Against AWS the region comes from the pod's environment through the SDK's own chain;
            // a dev machine has none, so the AWS case names one. The MinIO case needs none: a
            // service URL stands in for a region.
            cfg.AddInMemoryCollection(withServiceUrl
                ? new Dictionary<string, string?>
                {
                    ["S3:ServiceUrl"]     = "http://localhost:19000",
                    ["S3:ForcePathStyle"] = "true",
                }
                : new Dictionary<string, string?> { ["S3:Region"] = "eu-west-1" });
        });

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void TheGraphResolves(bool withServiceUrl)
    {
        // A shell's one failure mode is a registration nobody remembered. It surfaces at startup in
        // production and nowhere at all at compile time.
        using var host = Build(withServiceUrl);

        var resolved = host.Services.GetRequiredService<BaseProcessor.Core.Processing.BaseProcessor>();

        Assert.IsType<ObjectPersisterProcessor>(resolved);
    }
}
