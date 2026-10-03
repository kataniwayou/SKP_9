using Messaging.Contracts;
using Processor.Analyst.Graph;
using Xunit;

namespace BaseApi.Tests.Analyst;

public sealed class GraphLayersTests
{
    private static readonly RunningGraph Chain = ReplayFixtures.Graph("endless-feed-edges");

    private static string Name(RunningGraph g, Guid id) => g.Names.TryGetValue(id, out var n) ? n.Split('_')[0] : id.ToString("D");

    [Fact]
    public void TheChainHasOneFailureSinkWithFanInEight()
    {
        var layers = GraphLayers.Of(Chain, id => Name(Chain, id));

        var sink = Assert.Single(layers.Handlers);
        Assert.Equal(StepResult.Failed, sink.Takes);
        Assert.Equal("record-outcome", Name(Chain, sink.StepId));
        Assert.Equal(8, sink.FanIn.Count);
    }

    [Fact]
    public void TheSinksOwnFailureAndEveryCancellationAreUnhandled()
    {
        var layers = GraphLayers.Of(Chain, id => Name(Chain, id));

        Assert.Contains(layers.Unhandled, u => Name(Chain, u.StepId) == "record-outcome" && u.Result == StepResult.Failed);
        Assert.Contains(layers.Unhandled, u => Name(Chain, u.StepId) == "export-outcome" && u.Result == StepResult.Failed);
        Assert.Contains(layers.Unhandled, u => Name(Chain, u.StepId) == "split-importer" && u.Result == StepResult.Cancelled);
    }

    [Fact]
    public void ConservationEquatesTheFailuresInWithTheSinkPath()
    {
        var eq = Assert.Single(GraphLayers.Of(Chain, id => Name(Chain, id)).Conservation);

        Assert.StartsWith("Failed outcomes of the 8 steps routing Failed to record-outcome", eq, StringComparison.Ordinal);
        Assert.Contains("= outcomes of record-outcome", eq, StringComparison.Ordinal);
        Assert.Contains("= outcomes of export-outcome", eq, StringComparison.Ordinal);
    }

    [Fact]
    public void AGraphWithNoHandlerHasNoSinkAndSaysSo()
    {
        var a = Guid.NewGuid(); var b = Guid.NewGuid();
        var g = new RunningGraph(Guid.NewGuid(), true, "0 * * * * *", [a],
            [new StepL1(a, 4, Guid.NewGuid(), "{}", [b]), new StepL1(b, 1, Guid.NewGuid(), "{}", [])],
            new Dictionary<Guid, string>());

        var layers = GraphLayers.Of(g, id => id.ToString("D")[..4]);

        Assert.Empty(layers.Handlers);
        Assert.Empty(layers.Conservation);
        Assert.Contains("failures are recorded only in logs",
            GraphRenderer.Render(GraphBriefing.Of(g)), StringComparison.Ordinal);
    }

    [Fact]
    public void AnAlwaysSuccessorCountsAsAcceptingFailedButIsNotAHandler()
    {
        // Condition 4 (Always) takes Failed, so Failed is handled -- but an Always step is part of the
        // work path, not a failure handler, and must not be reported as a sink.
        var a = Guid.NewGuid(); var b = Guid.NewGuid();
        var g = new RunningGraph(Guid.NewGuid(), true, "0 * * * * *", [a],
            [new StepL1(a, 4, Guid.NewGuid(), "{}", [b]), new StepL1(b, 4, Guid.NewGuid(), "{}", [])],
            new Dictionary<Guid, string>());

        var layers = GraphLayers.Of(g, id => id.ToString("D")[..4]);

        Assert.Empty(layers.Handlers);
        Assert.DoesNotContain(layers.Unhandled, u => u.StepId == a);
    }

    [Fact]
    public void TheBriefingCarriesTheLayers()
    {
        var text = GraphRenderer.Render(GraphBriefing.Of(Chain));

        Assert.Contains("Layers (computed from the entry conditions):", text, StringComparison.Ordinal);
        Assert.Contains("Failure handler:", text, StringComparison.Ordinal);
        Assert.Contains("Check: Failed outcomes of the 8 steps", text, StringComparison.Ordinal);
    }
}
