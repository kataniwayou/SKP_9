using System.Text.Json;
using BaseProcessor.Core.Configuration;
using Messaging.Contracts;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Processor.KafkaExporter;
using Processor.KafkaExporter.Kafka;
using Xunit;

namespace BaseApi.Tests.KafkaExporter;

public sealed class KafkaExporterConfigTests
{
    /// <summary>
    /// The payload an orchestrator actually sends: flat, and camel-cased where the record is Pascal.
    /// The framework's options are case-insensitive, and this fact is what pins that they stay so.
    /// </summary>
    [Fact]
    public void BindsAFlatCamelCasedPayload()
    {
        const string payload =
            """
            {"brokerList":"kafka-1:9092,kafka-2:9092","topic":"exports","deliveryTimeoutSeconds":30}
            """;

        var config = JsonSerializer.Deserialize<KafkaExporterConfig>(
            payload, ProcessorConfig.SerializerOptions);

        Assert.Equal("kafka-1:9092,kafka-2:9092", config!.BrokerList);
        Assert.Equal("exports", config.Topic);
        Assert.Equal(30, config.DeliveryTimeoutSeconds);
    }

    /// <summary>
    /// A field this record gains later must not break a workflow authored before it, and a field it
    /// does not know must not fail the step. Same tolerance the framework documents on its options.
    /// </summary>
    [Fact]
    public void IgnoresAPropertyItDoesNotKnow()
    {
        const string payload =
            """
            {"brokerList":"b","topic":"t","deliveryTimeoutSeconds":1,"somethingAddedLater":true}
            """;

        var config = JsonSerializer.Deserialize<KafkaExporterConfig>(
            payload, ProcessorConfig.SerializerOptions);

        Assert.Equal("t", config!.Topic);
    }
}

/// <summary>
/// The one thing worth asserting about a shell: that its service graph actually resolves, without
/// starting a process or reaching a broker. Mirrors the importer's wiring test.
/// </summary>
public sealed class KafkaExporterHostWiringTests
{
    [Fact]
    public void ResolvesTheProcessorAndItsProducerFactory()
    {
        var identity = new ProcessorIdentityFound(
            Guid.NewGuid(), InputSchemaId: null, OutputSchemaId: null, ConfigSchemaId: null,
            Name: "kafka-exporter", Version: "1.0.0");

        // "--environment", "Development" turns on the container's ValidateOnBuild/ValidateScopes,
        // which is what makes this fact prove the WHOLE graph resolves rather than just the two
        // registrations it explicitly asks for below.
        using var host = ProcessorHost.Create(["--environment", "Development"], identity, config =>
            config.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["ConnectionStrings:Redis"] = "localhost:6379,abortConnect=false",
                ["RabbitMq:Host"] = "localhost",
                ["RabbitMq:Username"] = "guest",
                ["RabbitMq:Password"] = "guest",
            }));

        Assert.IsType<KafkaExporterProcessor>(
            host.Services.GetRequiredService<BaseProcessor.Core.Processing.BaseProcessor>());
        Assert.IsType<KafkaRecordProducerFactory>(
            host.Services.GetRequiredService<IRecordProducerFactory>());
    }
}
