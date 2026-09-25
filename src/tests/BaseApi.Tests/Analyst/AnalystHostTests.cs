using BaseProcessor.Core.Configuration;
using BaseProcessor.Core.Identity;
using Messaging.Contracts;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Processor.Analyst;
using Xunit;

namespace BaseApi.Tests.Analyst;

public sealed class AnalystHostTests
{
    private static readonly ProcessorIdentityFound Identity = new(
        Guid.Parse("88888888-8888-8888-8888-888888888888"),
        InputSchemaId: null, OutputSchemaId: null, ConfigSchemaId: null,
        Name: "analyst", Version: "1.0.0");

    private static readonly Dictionary<string, string?> Configuration = new()
    {
        ["Service:Name"]            = "processor",
        ["Service:Version"]         = "0.0.0",
        ["ConnectionStrings:Redis"] = "localhost:6379,abortConnect=false",
        ["RabbitMq:Host"]           = "localhost",
        ["RabbitMq:Username"]       = "guest",
        ["RabbitMq:Password"]       = "guest",
        ["Analyst:Model:BaseUrl"]   = "https://example.invalid/v1",
    };

    // No "--environment", "Development" here: that turns on ServiceProviderOptions.ValidateOnBuild,
    // which validates the WHOLE graph, including AddProcessorExecution's ProcessDispatchHandler.
    // TheServiceGraphResolves, below, is the whole-graph form; this one exercises the narrower,
    // partial-resolution path on purpose so both shapes stay covered.
    internal static Microsoft.Extensions.Hosting.IHost Host()
        => ProcessorHost.Create([], Identity, cfg => cfg.AddInMemoryCollection(Configuration));

    [Fact]
    public void TheHostBuildsAndItsRegisteredServicesResolve()
    {
        // The host builds, and the services this shell registers -- via AddBaseConsoleObservability
        // and AddBaseProcessor(cfg, identity) -- resolve without throwing. That catches a throwing
        // constructor, a bad options binding or a missing configuration key, but (with ValidateOnBuild
        // off) not a missing registration elsewhere in the container.
        //
        // The whole-graph form -- ["--environment", "Development"], which turns on ValidateOnBuild and
        // proves every registration in the container resolves, not just the ones asserted below -- is
        // the same shape src/tests/BaseApi.Tests/PathImporter's host-wiring fact takes (see commit
        // 58959c2, "the host wiring fact validates the whole graph, not two registrations").
        // TheServiceGraphResolves, below, is that form.
        using var host = Host();

        // IProcessorContext is seeded with the identity Create() was handed -- proves the identity
        // this shell was given is the identity the container actually publishes, not silently dropped.
        var context = host.Services.GetRequiredService<IProcessorContext>();
        Assert.Equal(Identity.Id, context.Identity?.Id);
        Assert.Equal(Identity.Name, context.Identity?.Name);

        // Resolved, not invoked: .Get() reads Assembly.GetEntryAssembly(), which inside this test
        // process is BaseApi.Tests.dll -- deliberately not SourceHash-stamped (BaseApi.Tests.csproj
        // sets EmitProcessorSourceHash=false) -- not Processor.Analyst.dll, so calling it here would
        // fail for a reason that has nothing to do with this shell. Resolving it still proves
        // AddBaseProcessor's registration constructs cleanly, matching
        // ProcessorHostWiringTests.TheSourceHashProviderIsHereBecauseSomethingNowReadsIt.
        Assert.NotNull(host.Services.GetRequiredService<ISourceHashProvider>());

        // Configure<ProcessorLivenessOptions> binds without throwing.
        Assert.NotNull(host.Services.GetRequiredService<IOptions<ProcessorLivenessOptions>>().Value);
    }

    [Fact]
    public void TheServiceGraphResolves()
    {
        // The whole-graph form. "--environment", "Development" turns on
        // ServiceProviderOptions.ValidateOnBuild/ValidateScopes, matching ProcessorSampleTests.Build()
        // and the PathImporter host-wiring fact (commit 58959c2) -- it proves every registration in
        // the container resolves, not just the ones a caller happens to ask for. That includes
        // AddProcessorExecution's ProcessDispatchHandler, which needs
        // BaseProcessor.Core.Processing.BaseProcessor -- satisfied now that ProcessorHost.Create
        // registers AddSingleton<BaseProcessor.Core.Processing.BaseProcessor, AnalystProcessor>().
        //
        // IAnalystModel resolves to the real KimiAnalystModel and IPanelReader resolves to the
        // real LivePanelReader, both registered by ProcessorHost.Create -- no configureServices
        // override is needed for either.
        using var host = ProcessorHost.Create(
            ["--environment", "Development"],
            Identity,
            cfg => cfg.AddInMemoryCollection(Configuration));

        // IsType, not NotNull: the registration this test exists to prove is that the base type
        // resolves to THIS AUTHOR'S implementation specifically -- AddSingleton<AnalystProcessor>()
        // alone would leave BaseProcessor unsatisfied and every other registration here could still
        // pass with a stub. This is the single fact standing between a healthy-looking pod and one
        // that processes nothing.
        Assert.IsType<AnalystProcessor>(host.Services.GetRequiredService<BaseProcessor.Core.Processing.BaseProcessor>());
    }
}
