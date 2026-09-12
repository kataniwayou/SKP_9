using Processor.SKNormalizer;
using Xunit;

namespace BaseApi.Tests.SKNormalizer;

public sealed class ProviderHandlerRegistryTests
{
    /// <summary>A handler that does nothing, for tests that only care about resolution.</summary>
    private sealed class Stub(string name) : ProviderHandlerBase
    {
        public override string Name { get; } = name;

        public override IReadOnlyList<SourceItem> Locate(FileNode root) => [];
    }

    [Fact]
    public void AHandlerIsFoundByName()
    {
        var handler = new Stub("ProviderA");
        var registry = new ProviderHandlerRegistry([handler]);

        Assert.Same(handler, registry.Find("ProviderA"));
    }

    [Theory]
    [InlineData("providera")]
    [InlineData("PROVIDERA")]
    [InlineData("ProviderA")]
    public void ResolutionIsCaseInsensitive(string asked)
    {
        var registry = new ProviderHandlerRegistry([new Stub("ProviderA")]);

        Assert.NotNull(registry.Find(asked));
    }

    [Fact]
    public void AnUnknownNameReturnsNullRatherThanThrowing()
    {
        // The processor turns this into a rejected payload with a message naming what IS carried.
        // Throwing here would put that decision in the wrong place.
        var registry = new ProviderHandlerRegistry([new Stub("ProviderA")]);

        Assert.Null(registry.Find("ProviderB"));
    }

    [Fact]
    public void TwoHandlersClaimingOneNameThrowAtConstruction()
    {
        // A BUILD-TIME MISTAKE, and it must not be resolved by registration order at dispatch time.
        // The container builds this at startup, so the pod fails to start rather than serving one
        // of two providers at random.
        var ex = Assert.Throws<InvalidOperationException>(
            () => new ProviderHandlerRegistry([new Stub("ProviderA"), new Stub("providera")]));

        Assert.Contains("ProviderA", ex.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void NamesAreOrderedSoTheRejectionMessageIsStable()
    {
        // The unknown-handler message lists these, and an operator comparing two failures should not
        // see the same set in two orders.
        var registry = new ProviderHandlerRegistry([new Stub("Zeta"), new Stub("Alpha")]);

        Assert.Equal(["Alpha", "Zeta"], registry.Names);
    }

    [Fact]
    public void AnEmptyRegistryIsLegalAndFindsNothing()
    {
        var registry = new ProviderHandlerRegistry([]);

        Assert.Empty(registry.Names);
        Assert.Null(registry.Find("anything"));
    }
}
