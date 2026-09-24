using Processor.Analyst.Model;
using Xunit;

namespace BaseApi.Tests.Analyst;

public sealed class ScriptedModelTests
{
    [Fact]
    public async Task ItReturnsEachScriptedReplyInOrder()
    {
        var model = new ScriptedModel(
            ModelReply.Of(ScriptedModel.Call("read_panel", new { panelId = "queue-wait" })),
            ModelReply.Of(ScriptedModel.Call("report_no_finding", new { reason = "quiet" })));

        var first = await model.SendAsync("sys", [], [], CancellationToken.None);
        var second = await model.SendAsync("sys", [], [], CancellationToken.None);

        Assert.Equal("read_panel", first.ToolCalls[0].ToolName);
        Assert.Equal("report_no_finding", second.ToolCalls[0].ToolName);
    }

    [Fact]
    public async Task ItThrowsWhenTheLoopAsksForMoreTurnsThanTheScriptHas()
    {
        // A loop that runs past its script is a loop that failed to terminate. Making that an
        // exception rather than a default reply is what keeps a budget bug from looking like a pass.
        var model = new ScriptedModel(ModelReply.Of(ScriptedModel.Call("read_panel", new { panelId = "a" })));

        await model.SendAsync("sys", [], [], CancellationToken.None);

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => model.SendAsync("sys", [], [], CancellationToken.None));
    }

    [Fact]
    public async Task ItRecordsTheTranscriptItWasHanded()
    {
        // Tasks 10 and 11 assert on what the loop actually sent -- that the payload prompt was
        // delimited, that tool results came back in ONE user turn rather than split across several.
        var model = new ScriptedModel(ModelReply.Of(ScriptedModel.Call("report_no_finding", new { reason = "x" })));
        ModelTurn[] transcript =
        [
            new(ModelRole.User, "go", [], []),
        ];

        await model.SendAsync("sys", transcript, [], CancellationToken.None);

        Assert.Single(model.Received);
        Assert.Equal("sys", model.Received[0].System);
        Assert.Equal("go", model.Received[0].Transcript[0].Text);
    }
}
