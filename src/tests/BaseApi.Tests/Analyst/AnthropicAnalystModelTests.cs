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
