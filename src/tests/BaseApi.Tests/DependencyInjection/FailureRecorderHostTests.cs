using Messaging.Contracts;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Processor.FailureRecorder;
using Xunit;

namespace BaseApi.Tests.DependencyInjection;

/// <summary>
/// The one thing worth asserting about a shell: that its service graph actually resolves. Asserted
/// without starting a process, which is why ProcessorHost.Create is separate from StartAsync.
/// </summary>
public sealed class FailureRecorderHostTests
{
    private static readonly ProcessorIdentityFound Identity = new(
        Guid.Parse("66666666-6666-6666-6666-666666666666"),
        InputSchemaId: null, OutputSchemaId: null, ConfigSchemaId: null,
        Name: "failure-recorder", Version: "1.0.0");

    private static IHost Build() => ProcessorHost.Create(
        // Development turns on the container's build-time validation, which is the whole point:
        // every registration is checked for constructibility without anything being instantiated,
        // so no broker or store is contacted.
        ["--environment", "Development"],
        Identity,
        cfg => cfg.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Service:Name"]            = "processor",
            ["Service:Version"]         = "0.0.0",
            ["ConnectionStrings:Redis"] = "localhost:6379,abortConnect=false",
            ["RabbitMq:Host"]           = "localhost",
            ["RabbitMq:Username"]       = "guest",
            ["RabbitMq:Password"]       = "guest",
        }));

    [Fact]
    public void TheServiceGraphResolves()
    {
        using var host = Build();

        var processor = host.Services
            .GetRequiredService<BaseProcessor.Core.Processing.BaseProcessor>();

        Assert.IsType<FailureRecorderProcessor>(processor);
    }

    [Fact]
    public void TheClockComesFromTheFrameworkRatherThanThisShell()
    {
        // AddBaseProcessor already does TryAddSingleton(TimeProvider.System), so this shell registers
        // no clock of its own.
        //
        // GetServices, NOT GetRequiredService, and the difference is the whole test. .NET DI accepts
        // repeated registrations of one service type and hands back the LAST — so resolving one and
        // asserting it is non-null passes just as happily when this shell has added a second clock
        // beside the framework's. Counting is what makes a later duplicate registration fail here
        // rather than pass silently.
        using var host = Build();

        Assert.Single(host.Services.GetServices<TimeProvider>());
    }
}
