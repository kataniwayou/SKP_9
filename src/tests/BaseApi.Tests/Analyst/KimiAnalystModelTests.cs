using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;
using Processor.Analyst.Model;
using Xunit;

namespace BaseApi.Tests.Analyst;

public sealed class KimiAnalystModelTests
{
    private static AnalystModelOptions Options() => new()
    {
        ModelId = "kimi-k3",
        ReasoningEffort = "high",
        ApiKey = "unused-in-these-tests",
        BaseUrl = "https://api.moonshot.ai/v1",
    };

    [Fact]
    public void TheRequestCarriesTheModelAndEffortFromOptions()
    {
        var request = KimiAnalystModel.BuildRequest(Options(), "contract", [], []);

        Assert.Equal("kimi-k3", request["model"]!.GetValue<string>());
        Assert.Equal("high", request["reasoning_effort"]!.GetValue<string>());
    }

    [Fact]
    public void TheSystemPromptIsTheFirstMessage()
    {
        var request = KimiAnalystModel.BuildRequest(Options(), "the contract", [], []);

        var first = request["messages"]!.AsArray()[0]!;
        Assert.Equal("system", first["role"]!.GetValue<string>());
        Assert.Equal("the contract", first["content"]!.GetValue<string>());
    }

    [Fact]
    public void AToolSpecBecomesAFunctionToolWithItsSchemaIntact()
    {
        var spec = new ToolSpec("read_panel", "reads one panel",
            """{"type":"object","properties":{"panelId":{"type":"string"}},"required":["panelId"],"additionalProperties":false}""");

        var request = KimiAnalystModel.BuildRequest(Options(), "contract", [], [spec]);

        var tool = request["tools"]!.AsArray()[0]!;
        Assert.Equal("function", tool["type"]!.GetValue<string>());
        Assert.Equal("read_panel", tool["function"]!["name"]!.GetValue<string>());
        // additionalProperties survives here, unlike the Anthropic tool shape which had no field for
        // it. The loop re-validates against the full schema regardless.
        Assert.Contains("additionalProperties", tool["function"]!["parameters"]!.ToJsonString(), System.StringComparison.Ordinal);
    }

    [Fact]
    public void EveryToolResultForOneTurnBecomesItsOwnToolMessage()
    {
        // The API rejects a follow-up in which any tool_call id lacks a matching tool message, and
        // splitting them across requests trains the model out of parallel calls.
        var turn = new ModelTurn(ModelRole.User, null, [],
        [
            new ModelToolResult("call-a", "{}", IsError: false),
            new ModelToolResult("call-b", "boom", IsError: true),
        ]);

        var messages = KimiAnalystModel.ToMessages(turn).ToArray();

        Assert.Equal(2, messages.Length);
        Assert.All(messages, m => Assert.Equal("tool", m["role"]!.GetValue<string>()));
        Assert.Equal("call-a", messages[0]["tool_call_id"]!.GetValue<string>());
    }

    [Fact]
    public void AFailedToolResultIsMarkedInItsContent()
    {
        // The OpenAI wire format has no is_error field. Dropping the distinction would let the model
        // read a failure as ordinary data, so it is carried in the content instead.
        var turn = new ModelTurn(ModelRole.User, null, [],
            [new ModelToolResult("call-a", "panel unavailable", IsError: true)]);

        var message = KimiAnalystModel.ToMessages(turn).Single();

        Assert.Contains("ERROR", message["content"]!.GetValue<string>(), System.StringComparison.Ordinal);
        Assert.Contains("panel unavailable", message["content"]!.GetValue<string>(), System.StringComparison.Ordinal);
    }

    [Fact]
    public void AUserTurnWithTextBecomesAUserMessage()
    {
        var turn = new ModelTurn(ModelRole.User, "Investigate workflow 7", [], []);

        var message = KimiAnalystModel.ToMessages(turn).Single();

        Assert.Equal("user", message["role"]!.GetValue<string>());
        Assert.Equal("Investigate workflow 7", message["content"]!.GetValue<string>());
    }
}
