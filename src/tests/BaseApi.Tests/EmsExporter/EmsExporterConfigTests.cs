using System.Text.Json;
using BaseProcessor.Core.Configuration;
using Messaging.Contracts;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Processor.EmsExporter;
using Processor.EmsExporter.Ems;
using Xunit;

namespace BaseApi.Tests.EmsExporter;

public sealed class EmsExporterConfigTests
{
    [Fact]
    public void BindsAFlatCamelCasedPayload()
    {
        const string payload =
            """
            {"queue":"skp.exports","deliveryTimeoutSeconds":30}
            """;

        var config = JsonSerializer.Deserialize<EmsExporterConfig>(payload, ProcessorConfig.SerializerOptions);

        Assert.Equal("skp.exports", config!.Queue);
        Assert.Equal(30, config.DeliveryTimeoutSeconds);
    }

    /// <summary>
    /// A server URL or credential left in a payload is inert, and the record has no property that
    /// could carry one: those are configuration.
    /// </summary>
    [Fact]
    public void IgnoresAServerOrCredentialInThePayload()
    {
        const string payload =
            """
            {"serverUrl":"tcp://elsewhere:7222","password":"x","queue":"q","deliveryTimeoutSeconds":1}
            """;

        var config = JsonSerializer.Deserialize<EmsExporterConfig>(payload, ProcessorConfig.SerializerOptions);

        Assert.Equal("q", config!.Queue);
        Assert.DoesNotContain(
            typeof(EmsExporterConfig).GetProperties(),
            p => p.Name.Contains("Server", StringComparison.OrdinalIgnoreCase)
                 || p.Name.Contains("Password", StringComparison.OrdinalIgnoreCase));
    }
}

/// <summary>
/// The invariant that makes the connection limits worth having: a client that exhausts every attempt
/// has done so inside the author's window.
/// </summary>
public sealed class EmsConnectionLimitsTests
{
    [Theory]
    [InlineData(1)]
    [InlineData(5)]
    [InlineData(30)]
    [InlineData(600)]
    public void ExhaustsEveryAttemptInsideTheDeliveryTimeout(int seconds)
    {
        var limits = EmsConnectionLimits.For(TimeSpan.FromSeconds(seconds));

        Assert.True(limits.AttemptTimeoutMs > 0);
        Assert.True(limits.Attempts * (limits.DelayMs + limits.AttemptTimeoutMs) <= seconds * 1000);
    }

    [Fact]
    public void CapsTheDelayBetweenAttemptsAtOneSecond()
        => Assert.Equal(1000, EmsConnectionLimits.For(TimeSpan.FromMinutes(10)).DelayMs);

    [Fact]
    public void RefusesATimeoutBelowTheFloor()
        => Assert.Throws<ArgumentOutOfRangeException>(() => EmsConnectionLimits.For(TimeSpan.FromMilliseconds(999)));
}

/// <summary>The shell's graph resolves, and a server it could never reach stops the host at startup.</summary>
public sealed class EmsExporterHostWiringTests
{
    [Fact]
    public void ResolvesTheProcessorAndItsSenderFactory()
    {
        using var host = ProcessorHost.Create(["--environment", "Development"], Identity(), Settings());

        Assert.IsType<EmsExporterProcessor>(
            host.Services.GetRequiredService<BaseProcessor.Core.Processing.BaseProcessor>());
        Assert.IsType<UnavailableMessageSenderFactory>(
            host.Services.GetRequiredService<IMessageSenderFactory>());
    }

    [Fact]
    public void BindsTheServerFromConfiguration()
    {
        using var host = ProcessorHost.Create(
            ["--environment", "Development"], Identity(),
            Settings(serverUrl: "tcp://ems-a:7222, ssl://ems-b:7243", maxMessageBytes: "2048"));

        var server = host.Services.GetRequiredService<EmsServerOptions>();
        Assert.Equal("tcp://ems-a:7222, ssl://ems-b:7243", server.ServerUrl);
        Assert.Equal("skp-exporter", server.Username);
        Assert.Equal(2048, server.MaxMessageBytes);
    }

    [Fact]
    public void RefusesToBuildWithoutAServerUrl()
    {
        var error = Assert.Throws<InvalidOperationException>(() =>
            ProcessorHost.Create(["--environment", "Development"], Identity(), Settings(serverUrl: null)));

        Assert.Contains("Ems:ServerUrl", error.Message, StringComparison.Ordinal);
    }

    /// <summary>The second URL of a pair is checked too: a list that fails over to nowhere is no pair.</summary>
    [Fact]
    public void RefusesAUrlThatIsNotTcpOrSsl()
    {
        var error = Assert.Throws<InvalidOperationException>(() =>
            ProcessorHost.Create(["--environment", "Development"], Identity(),
                Settings(serverUrl: "tcp://ems-a:7222,ems-b:7222")));

        Assert.Contains("'ems-b:7222'", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void RefusesACeilingBelowOneByte()
    {
        var error = Assert.Throws<InvalidOperationException>(() =>
            ProcessorHost.Create(["--environment", "Development"], Identity(), Settings(maxMessageBytes: "0")));

        Assert.Contains("Ems:MaxMessageBytes", error.Message, StringComparison.Ordinal);
    }

    private static ProcessorIdentityFound Identity() => new(
        Guid.NewGuid(), InputSchemaId: null, OutputSchemaId: null, ConfigSchemaId: null,
        Name: "ems-exporter", Version: "1.0.0");

    private static Action<IConfigurationBuilder> Settings(
        string? serverUrl = "tcp://ems:7222", string? maxMessageBytes = null) =>
        config => config.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Redis"] = "localhost:6379,abortConnect=false",
            ["RabbitMq:Host"] = "localhost",
            ["RabbitMq:Username"] = "guest",
            ["RabbitMq:Password"] = "guest",
            ["Ems:ServerUrl"] = serverUrl,
            ["Ems:Username"] = "skp-exporter",
            ["Ems:Password"] = "dev",
            ["Ems:MaxMessageBytes"] = maxMessageBytes,
        });
}
