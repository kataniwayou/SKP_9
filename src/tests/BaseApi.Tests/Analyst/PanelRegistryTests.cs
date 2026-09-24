using Processor.Analyst.Panels;
using Xunit;

namespace BaseApi.Tests.Analyst;

public sealed class PanelRegistryTests
{
    [Fact]
    public void EveryPanelIdIsUnique()
    {
        var ids = PanelRegistry.All.Select(p => p.PanelId).ToArray();

        Assert.Equal(ids.Length, ids.Distinct().Count());
    }

    [Fact]
    public void EveryPanelDeclaresABusinessOrOpsLayer()
    {
        Assert.All(PanelRegistry.All, p => Assert.Contains(p.Layer, new[] { "business", "ops" }));
    }

    [Fact]
    public void EveryPanelHasADescriptionLongEnoughToBeUseful()
    {
        // The descriptions go into the system prompt: they are the only thing telling the model what
        // a panel means. "queue" is not a description.
        Assert.All(PanelRegistry.All, p => Assert.True(p.Description.Length >= 20, p.PanelId));
    }

    [Fact]
    public void BothLayersArePresent()
    {
        // An agent with only one layer cannot correlate across layers, which is the entire
        // proficiency this processor is supposed to have.
        Assert.Contains(PanelRegistry.All, p => p.Layer == "business");
        Assert.Contains(PanelRegistry.All, p => p.Layer == "ops");
    }
}
