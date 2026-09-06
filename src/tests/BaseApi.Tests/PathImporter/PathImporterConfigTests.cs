using System.Text.Json;
using BaseProcessor.Core.Configuration;
using Processor.PathImporter;
using Xunit;

namespace BaseApi.Tests.PathImporter;

public sealed class PathImporterConfigTests
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
            {"brokerList":"kafka-1:9092,kafka-2:9092","topic":"file-paths",
             "consumerGroup":"path-importer","messageCount":100,"idleTimeoutSeconds":5}
            """;

        var config = JsonSerializer.Deserialize<PathImporterConfig>(
            payload, ProcessorConfig.SerializerOptions);

        Assert.Equal("kafka-1:9092,kafka-2:9092", config!.BrokerList);
        Assert.Equal("file-paths", config.Topic);
        Assert.Equal("path-importer", config.ConsumerGroup);
        Assert.Equal(100, config.MessageCount);
        Assert.Equal(5, config.IdleTimeoutSeconds);
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
            {"brokerList":"b","topic":"t","consumerGroup":"g","messageCount":1,
             "idleTimeoutSeconds":1,"somethingAddedLater":true}
            """;

        var config = JsonSerializer.Deserialize<PathImporterConfig>(
            payload, ProcessorConfig.SerializerOptions);

        Assert.Equal("t", config!.Topic);
    }
}
