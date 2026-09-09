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
    /// <para>
    /// <b>No broker list</b>, for the reason <c>KafkaImporterConfigTests</c> gives: the broker is
    /// org infrastructure and arrives from configuration, so what is left here is the topic to write
    /// to and how long the author will wait for the acknowledgement.
    /// </para>
    /// </summary>
    [Fact]
    public void BindsAFlatCamelCasedPayload()
    {
        const string payload =
            """
            {"topic":"exports","deliveryTimeoutSeconds":30}
            """;

        var config = JsonSerializer.Deserialize<KafkaExporterConfig>(
            payload, ProcessorConfig.SerializerOptions);

        Assert.Equal("exports", config!.Topic);
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
            {"topic":"t","deliveryTimeoutSeconds":1,"somethingAddedLater":true}
            """;

        var config = JsonSerializer.Deserialize<KafkaExporterConfig>(
            payload, ProcessorConfig.SerializerOptions);

        Assert.Equal("t", config!.Topic);
    }

    /// <summary>
    /// <b>The migration guarantee</b>, mirroring the importer's: assignments authored while the
    /// broker list lived in the payload still carry the key, nothing rewrites those rows, and the
    /// leftover must be inert rather than either breaking the step or quietly steering the producer.
    /// </summary>
    [Fact]
    public void IgnoresABrokerListLeftOverInAnOlderPayload()
    {
        const string payload =
            """
            {"brokerList":"stale-broker:9092","topic":"exports","deliveryTimeoutSeconds":30}
            """;

        var config = JsonSerializer.Deserialize<KafkaExporterConfig>(
            payload, ProcessorConfig.SerializerOptions);

        Assert.Equal("exports", config!.Topic);
        Assert.DoesNotContain(
            typeof(KafkaExporterConfig).GetProperties(),
            p => p.Name.Contains("Broker", StringComparison.OrdinalIgnoreCase));
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
        using var host = ProcessorHost.Create(["--environment", "Development"], identity, Settings());

        Assert.IsType<KafkaExporterProcessor>(
            host.Services.GetRequiredService<BaseProcessor.Core.Processing.BaseProcessor>());
        Assert.IsType<KafkaRecordProducerFactory>(
            host.Services.GetRequiredService<IRecordProducerFactory>());
    }

    /// <summary>
    /// <b>Where the broker list lives now.</b> It arrives as <c>Kafka__BrokerList</c> in the
    /// deployment's environment, the same way the RabbitMQ and Redis addresses beside it do, and
    /// nothing in a step payload can reach it.
    /// </summary>
    [Fact]
    public void BindsTheOrgBrokerListFromConfiguration()
    {
        using var host = ProcessorHost.Create(
            ["--environment", "Development"], Identity(),
            Settings(brokerList: "kafka-1:9092,kafka-2:9092"));

        Assert.Equal(
            "kafka-1:9092,kafka-2:9092",
            host.Services.GetRequiredService<KafkaBrokerOptions>().BrokerList);
    }

    /// <summary>
    /// <b>A missing broker must stop the host, not the first dispatch.</b> The importer's version of
    /// this fact explains the failure it prevents there; here it is milder but the same shape — a
    /// producer with nowhere to connect holds the dispatch until the delivery timeout and then fails
    /// the step, once per dispatch, forever. A pod that will not start says it once.
    /// </summary>
    [Fact]
    public void RefusesToBuildWithoutABrokerList()
    {
        var error = Assert.Throws<InvalidOperationException>(() =>
            ProcessorHost.Create(["--environment", "Development"], Identity(), Settings(brokerList: null)));

        Assert.Contains("Kafka:BrokerList", error.Message, StringComparison.Ordinal);
    }

    private static ProcessorIdentityFound Identity() => new(
        Guid.NewGuid(), InputSchemaId: null, OutputSchemaId: null, ConfigSchemaId: null,
        Name: "kafka-exporter", Version: "1.0.0");

    private static Action<IConfigurationBuilder> Settings(string? brokerList = "kafka-1:9092") =>
        config => config.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Redis"] = "localhost:6379,abortConnect=false",
            ["RabbitMq:Host"] = "localhost",
            ["RabbitMq:Username"] = "guest",
            ["RabbitMq:Password"] = "guest",
            ["Kafka:BrokerList"] = brokerList,
        });
}
