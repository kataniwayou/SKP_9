using System.Linq;
using Processor.Analyst.Model;
using Xunit;

namespace BaseApi.Tests.Analyst;

public sealed class AnthropicAnalystModelTests
{
    [Fact]
    public void AToolSpecBecomesAToolWithItsSchemaIntact()
    {
        var spec = new ToolSpec("read_panel", "reads one panel",
            """{"type":"object","properties":{"panelId":{"type":"string"}},"required":["panelId"],"additionalProperties":false}""");

        var tool = AnthropicAnalystModel.ToTool(spec);

        Assert.Equal("read_panel", tool.Name);
        Assert.Contains("panelId", System.Text.Json.JsonSerializer.Serialize(tool.InputSchema), StringComparison.Ordinal);
    }

    [Fact]
    public void ToolInputSchemaHasNoFieldForRootAdditionalProperties()
    {
        // F7: confirms, by reflection, exactly what the comment on ToTool now says -- pinned here
        // so a future SDK upgrade that DOES add the field is caught by this test starting to fail,
        // which is the prompt to go carry it through instead of just documenting its absence.
        var properties = typeof(Anthropic.Models.Messages.InputSchema)
            .GetProperties()
            .Select(p => p.Name)
            .ToArray();

        Assert.DoesNotContain("AdditionalProperties", properties);
        Assert.DoesNotContain("DisallowAdditionalProperties", properties);
    }

    /// <summary>
    /// The SDK's own response shape for one assistant turn that thought and then called a tool.
    /// Built rather than recorded because nothing offline can reach the API; the block types and their
    /// required members are the SDK's, so a shape change breaks this at compile time.
    /// </summary>
    private static Anthropic.Models.Messages.ContentBlock[] ThoughtThenCalled(string signature) =>
    [
        // Thinking text is empty on purpose: `display` defaults to "omitted" on claude-opus-5, so this
        // is exactly what the wire carries -- an empty body and a signature that must survive.
        new Anthropic.Models.Messages.ThinkingBlock { Thinking = "", Signature = signature },
        new Anthropic.Models.Messages.ToolUseBlock
        {
            ID = "call-1",
            Name = "read_panel",
            Input = new Dictionary<string, System.Text.Json.JsonElement>(),
            Caller = new Anthropic.Models.Messages.DirectCaller(),
        },
    ];

    [Fact]
    public void AnAssistantEchoKeepsThinkingBlocksAndTheirSignatures()
    {
        var echo = AnthropicAnalystModel.AssistantEcho(ThoughtThenCalled("sig-abc"));

        Assert.Equal(2, echo.Count);
        Assert.True(echo[0].TryPickThinking(out var thinking));
        Assert.Equal("sig-abc", thinking!.Signature);
        Assert.True(echo[1].TryPickToolUse(out _));
    }

    [Fact]
    public void EveryToolCallInAReplyCarriesThatTurnsEcho()
    {
        // The echo has to reach the transcript, and the only thing the loop copies out of a reply
        // unchanged is the tool calls -- so every call carries it, and they all carry the same one.
        var reply = AnthropicAnalystModel.ToReply(ThoughtThenCalled("sig-abc"), 1, 2);

        var call = Assert.Single(reply.ToolCalls);
        Assert.NotNull(call.ProviderEcho);
    }

    [Fact]
    public void AnAssistantTurnReplaysItsProviderEchoVerbatimRatherThanRebuildingIt()
    {
        // THE point of the echo: a signed thinking block cannot be reconstructed from text +
        // tool_use, and an assistant turn carrying tool_use that comes back without it is rejected --
        // which would fail every investigation on its SECOND model call, the first one to replay a
        // turn. Reconstruction is why that bug existed; verbatim replay is the fix.
        var reply = AnthropicAnalystModel.ToReply(ThoughtThenCalled("sig-abc"), 0, 0);
        var turn = new ModelTurn(ModelRole.Assistant, reply.Text, reply.ToolCalls, []);

        var message = AnthropicAnalystModel.ToMessage(turn);

        Assert.True(message.Content.TryPickContentBlockParams(out var blocks));
        Assert.True(blocks![0].TryPickThinking(out var thinking));
        Assert.Equal("sig-abc", thinking!.Signature);
    }

    [Fact]
    public void AnAssistantTurnWithNoEchoIsStillReconstructedFromItsVisibleParts()
    {
        // The on-prem adapter carries no echo, and every hand-built transcript in these tests leaves
        // it null. That path must keep working exactly as it did.
        var turn = new ModelTurn(ModelRole.Assistant, "thinking out loud",
            [new ModelToolCall("call-1", "read_panel", default)], []);

        var message = AnthropicAnalystModel.ToMessage(turn);

        Assert.Equal(2, AnthropicAnalystModel.BlockCount(message));
    }

    [Fact]
    public void AUserTurnCarryingToolResultsBecomesOneMessageWithAllOfThem()
    {
        // The API rejects a follow-up in which any tool_use id lacks a matching tool_result, and
        // splitting results across messages trains the model out of parallel calls.
        var turn = new ModelTurn(ModelRole.User, null, [],
        [
            new ModelToolResult("a", "{}", IsError: false),
            new ModelToolResult("b", "boom", IsError: true),
        ]);

        var message = AnthropicAnalystModel.ToMessage(turn);

        Assert.Equal(2, AnthropicAnalystModel.BlockCount(message));
    }
}
