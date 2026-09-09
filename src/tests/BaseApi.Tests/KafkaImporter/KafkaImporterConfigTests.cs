using System.Text.Json;
using BaseProcessor.Core.Configuration;
using Processor.KafkaImporter;
using Xunit;

namespace BaseApi.Tests.KafkaImporter;

public sealed class KafkaImporterConfigTests
{
    /// <summary>
    /// The payload an orchestrator actually sends: flat, and camel-cased where the record is Pascal.
    /// The framework's options are case-insensitive, and this fact is what pins that they stay so.
    /// <para>
    /// <b>No broker list.</b> The broker is org infrastructure and reaches the processor from
    /// configuration; what a workflow author chooses is the topic, the group and the two counts.
    /// </para>
    /// </summary>
    [Fact]
    public void BindsAFlatCamelCasedPayload()
    {
        const string payload =
            """
            {"topic":"records","consumerGroup":"kafka-importer","messageCount":100,
             "idleTimeoutSeconds":5}
            """;

        var config = JsonSerializer.Deserialize<KafkaImporterConfig>(
            payload, ProcessorConfig.SerializerOptions);

        Assert.Equal("records", config!.Topic);
        Assert.Equal("kafka-importer", config.ConsumerGroup);
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
            {"topic":"t","consumerGroup":"g","messageCount":1,
             "idleTimeoutSeconds":1,"somethingAddedLater":true}
            """;

        var config = JsonSerializer.Deserialize<KafkaImporterConfig>(
            payload, ProcessorConfig.SerializerOptions);

        Assert.Equal("t", config!.Topic);
    }

    /// <summary>
    /// <b>The migration guarantee.</b> Every assignment authored while the broker list lived in the
    /// payload still carries the key, and those rows are not rewritten by deploying this. Binding
    /// must ignore it rather than fail the step — and, more importantly, the value must be inert:
    /// an operator editing <c>brokerList</c> in a stored payload is editing nothing, which is the
    /// whole point of moving it to configuration.
    /// </summary>
    [Fact]
    public void IgnoresABrokerListLeftOverInAnOlderPayload()
    {
        const string payload =
            """
            {"brokerList":"stale-broker:9092","topic":"records","consumerGroup":"g",
             "messageCount":1,"idleTimeoutSeconds":1}
            """;

        var config = JsonSerializer.Deserialize<KafkaImporterConfig>(
            payload, ProcessorConfig.SerializerOptions);

        Assert.Equal("records", config!.Topic);
        Assert.DoesNotContain(
            typeof(KafkaImporterConfig).GetProperties(),
            p => p.Name.Contains("Broker", StringComparison.OrdinalIgnoreCase));
    }
}
