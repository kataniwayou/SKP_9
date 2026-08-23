using BaseApi.Core.DependencyInjection;
using BaseApi.Tests.Live;
using BaseApi.Tests.Support;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using OpenTelemetry.Metrics;
using Xunit;

namespace BaseApi.Tests.Observability;

/// <summary>
/// The API's metrics resource must name the service and its version as two attributes, the same
/// shape <c>BaseConsole.Core</c> emits.
/// <para>
/// The console side already has this guard — <c>ServiceNameIsTheNameAloneWithNoVersionSuffix</c> —
/// but it can only speak for the worker hosts, so the API kept an interpolated
/// <c>{name}_{version}</c> form long after the workers dropped it. That form is invisible in a
/// single-service view and only shows up when the three services are read together: the API's
/// metrics carried no <c>service.version</c> at all, and because the Prometheus exporter derives
/// <c>exported_job</c> from <c>service.name</c>, the version suffix leaked into that label too.
/// </para>
/// </summary>
[Collection(EnvironmentCollection.Name)]
public sealed class ApiMetricsResourceTests
{
    private static HostApplicationBuilder BuilderWith(string name, string version)
    {
        var builder = Host.CreateApplicationBuilder();

        // Drop the default sources first: this output directory holds Processor.Sample's
        // appsettings.json, copied in by the project reference, and it carries a Service section.
        builder.Configuration.Sources.Clear();
        builder.Configuration.AddInMemoryCollection(
        [
            new KeyValuePair<string, string?>("Service:Name", name),
            new KeyValuePair<string, string?>("Service:Version", version),
        ]);
        return builder;
    }

    [Fact]
    public void ServiceNameAndVersionAreSeparateAttributesOnTheMetricsResource()
    {
        // Asserting on the frozen resource rather than on what was passed to the wiring: the latter
        // would pass just as happily if the SDK ignored it.
        var builder = BuilderWith("baseapi", "0.0.0");
        builder.AddBaseApiObservability(builder.Configuration, source: "webapi");

        using var host = builder.Build();
        var resource = ResourceReader.Read(host.Services.GetRequiredService<MeterProvider>());

        Assert.Equal("baseapi", resource["service.name"]);
        Assert.Equal("0.0.0", resource["service.version"]);
        Assert.Equal("webapi", resource["source"]);
    }

    [Fact]
    public void ServiceNameIsTheNameAloneWithNoVersionSuffix()
    {
        // The specific regression. A version whose digits cannot appear in the name on their own, so
        // a reappearing interpolation cannot coincidentally still satisfy the equality above.
        var builder = BuilderWith("baseapi", "7.3.1");
        builder.AddBaseApiObservability(builder.Configuration, source: "webapi");

        using var host = builder.Build();
        var resource = ResourceReader.Read(host.Services.GetRequiredService<MeterProvider>());

        var serviceName = Assert.IsType<string>(resource["service.name"]);
        Assert.DoesNotContain("_", serviceName);
        Assert.DoesNotContain("7.3.1", serviceName);
    }
}
