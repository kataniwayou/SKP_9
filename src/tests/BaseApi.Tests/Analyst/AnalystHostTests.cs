using BaseProcessor.Core.Configuration;
using BaseProcessor.Core.Identity;
using Messaging.Contracts;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Processor.Analyst;
using Processor.Analyst.Model;
using Processor.Analyst.Panels;
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
    };

    // No "--environment", "Development": that turns on ServiceProviderOptions.ValidateOnBuild, which
    // would validate the WHOLE graph, including AddProcessorExecution's ProcessDispatchHandler --
    // and that handler needs BaseProcessor.Core.Processing.BaseProcessor, which nothing registers
    // until Task 12 adds AddSingleton<BaseProcessor.Core.Processing.BaseProcessor, AnalystProcessor>().
    // At Task 2 that dependency is missing BY DESIGN, so asserting the whole graph here would be
    // asserting something false about this shell rather than testing it.
    internal static Microsoft.Extensions.Hosting.IHost Host()
        => ProcessorHost.Create([], Identity, cfg => cfg.AddInMemoryCollection(Configuration));

    [Fact]
    public void TheHostBuildsAndItsRegisteredServicesResolve()
    {
        // What Task 2 can honestly claim: the host builds, and the services this shell actually
        // registers -- via AddBaseConsoleObservability and AddBaseProcessor(cfg, identity) -- resolve
        // without throwing. That still catches a throwing constructor, a bad options binding or a
        // missing configuration key; it just cannot catch a missing registration, which at Task 2 is
        // expected (AnalystProcessor doesn't exist until Task 12).
        //
        // The whole-graph form -- ["--environment", "Development"], which turns on ValidateOnBuild and
        // proves every registration in the container resolves, not just the ones asserted below --
        // belongs to Task 12, once AddSingleton<BaseProcessor.Core.Processing.BaseProcessor,
        // AnalystProcessor>() makes the graph complete. That is the same shape
        // src/tests/BaseApi.Tests/PathImporter's host-wiring fact takes (see commit 58959c2, "the host
        // wiring fact validates the whole graph, not two registrations") -- meaningful only once the
        // graph it validates is actually whole. TheServiceGraphResolves, below, is that form.
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
        // IAnalystModel now resolves to the real AnthropicAnalystModel registered by
        // ProcessorHost.Create (Task 13). IPanelReader is still a placeholder until Task 14.
        using var host = ProcessorHost.Create(
            ["--environment", "Development"],
            Identity,
            cfg => cfg.AddInMemoryCollection(Configuration),
            services =>
            {
                services.AddSingleton<IPanelReader, PlaceholderPanelReader>();
            });

        // IsType, not NotNull: the registration this test exists to prove is that the base type
        // resolves to THIS AUTHOR'S implementation specifically -- AddSingleton<AnalystProcessor>()
        // alone would leave BaseProcessor unsatisfied and every other registration here could still
        // pass with a stub. This is the single fact standing between a healthy-looking pod and one
        // that processes nothing.
        Assert.IsType<AnalystProcessor>(host.Services.GetRequiredService<BaseProcessor.Core.Processing.BaseProcessor>());
    }

    /// <summary>Stands in for Task 14's real reader. Never called: the graph is only asked to resolve.</summary>
    private sealed class PlaceholderPanelReader : IPanelReader
    {
        public PanelDescriptor Describe(string panelId)
            => throw new NotSupportedException("placeholder registration; only used to complete the DI graph");

        public Task<PanelReading> ReadAsync(string panelId, TimeRange range, CancellationToken ct)
            => throw new NotSupportedException("placeholder registration; only used to complete the DI graph");
    }
}
