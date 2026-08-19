using System.Reflection;
using BaseConsole.Core.DependencyInjection;
using BaseConsole.Core.Messaging;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;
using BaseApi.Tests.Support;
using Xunit;

namespace BaseApi.Tests.Console;

[Collection(EnvironmentCollection.Name)]
public sealed class ConsoleObservabilityTests
{
    private static IHostApplicationBuilder BuilderWith(params (string Key, string Value)[] settings)
    {
        var builder = Host.CreateApplicationBuilder();
        builder.Configuration.AddInMemoryCollection(
            settings.Select(s => new KeyValuePair<string, string?>(s.Key, s.Value)));
        return builder;
    }

    [Fact]
    public void FailsFastWhenTheServiceNameIsMissing()
    {
        // Letting null reach ResourceBuilder.AddService surfaces as an opaque SDK argument exception
        // pointing at OpenTelemetry rather than at the missing setting.
        var builder = BuilderWith(("Service:Version", "1.0.0"));

        var ex = Assert.Throws<InvalidOperationException>(
            () => builder.AddBaseConsoleObservability(builder.Configuration, source: "processor"));

        Assert.Contains("Service:Name", ex.Message);
    }

    [Fact]
    public void FailsFastWhenTheServiceVersionIsMissing()
    {
        var builder = BuilderWith(("Service:Name", "unresolved"));

        var ex = Assert.Throws<InvalidOperationException>(
            () => builder.AddBaseConsoleObservability(builder.Configuration, source: "processor"));

        Assert.Contains("Service:Version", ex.Message);
    }

    [Fact]
    public void RequiresAnEmitterSource()
    {
        // Required rather than defaulted, so a new console cannot ship without saying who emitted a
        // record — service.name is the sentinel on a processor and cannot answer that.
        var builder = BuilderWith(("Service:Name", "unresolved"), ("Service:Version", "0.0.0"));

        Assert.Throws<ArgumentException>(
            () => builder.AddBaseConsoleObservability(builder.Configuration, source: "  "));
    }

    [Fact]
    public void WiresUpWithTheProcessorSentinel()
    {
        var builder = BuilderWith(("Service:Name", "unresolved"), ("Service:Version", "0.0.0"));

        var returned = builder.AddBaseConsoleObservability(builder.Configuration, source: "processor");

        Assert.Same(builder, returned);
    }

    [Fact]
    public void TheInstanceIdResolverHasNotDriftedFromTheApiCopy()
    {
        // BaseApi.Core cannot reference BaseConsole.Core, so the precedence expression exists twice.
        // Its own comment promises this guard; without it the two silently disagree and a pod's
        // liveness key stops matching the service.instance.id on its telemetry.
        var apiResolver = typeof(BaseApi.Core.DependencyInjection.ObservabilityServiceCollectionExtensions)
            .GetMethod("ResolveInstanceId", BindingFlags.NonPublic | BindingFlags.Static);

        Assert.NotNull(apiResolver);

        // The ambient environment is the easy case — both fall through to the machine name. The one
        // that matters is a downward-API field that resolved to nothing. Whitespace rather than "",
        // because SetEnvironmentVariable deletes a variable set to the empty string, so "" would test
        // deletion instead of blankness.
        foreach (var (pod, host) in new[]
                 {
                     ((string?)null, (string?)null),
                     ("proc-sample-7d9f", null),
                     (null, "some-host"),
                     ("   ", "some-host"),
                 })
        {
            var podBefore  = Environment.GetEnvironmentVariable("POD_NAME");
            var hostBefore = Environment.GetEnvironmentVariable("HOSTNAME");
            try
            {
                Environment.SetEnvironmentVariable("POD_NAME", pod);
                Environment.SetEnvironmentVariable("HOSTNAME", host);
                Assert.Equal(apiResolver!.Invoke(null, null), InstanceId.Resolve().Value);
            }
            finally
            {
                Environment.SetEnvironmentVariable("POD_NAME", podBefore);
                Environment.SetEnvironmentVariable("HOSTNAME", hostBefore);
            }
        }
    }
}
