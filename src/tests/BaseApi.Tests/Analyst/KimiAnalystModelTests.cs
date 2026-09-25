using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;
using Processor.Analyst.Loop;
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
        // additionalProperties survives the round-trip into the wire request unchanged. The loop
        // re-validates against the full schema regardless, so nothing depends on the wire carrying it.
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

    /// <summary>
    /// A realistic response body for one assistant turn that reasoned and then called a tool.
    /// Hand-built because nothing offline can reach the endpoint; `reasoning_content` is present
    /// because K3 always thinks, and its docs require the complete assistant message returned unchanged.
    /// </summary>
    private static JsonElement ReasonedThenCalled(string reasoning = "weighing two hypotheses") =>
        JsonDocument.Parse($$"""
        {
          "choices": [
            { "index": 0,
              "finish_reason": "tool_calls",
              "message": {
                "role": "assistant",
                "content": null,
                "reasoning_content": "{{reasoning}}",
                "tool_calls": [
                  { "id": "call-1", "type": "function",
                    "function": { "name": "read_panel", "arguments": "{\"panelId\":\"arrival-rate\"}" } }
                ]
              } }
          ],
          "usage": { "prompt_tokens": 1200, "completion_tokens": 340 }
        }
        """).RootElement.Clone();

    [Fact]
    public void AToolCallIsReadWithItsIdNameAndParsedArguments()
    {
        var reply = KimiAnalystModel.ToReply(ReasonedThenCalled());

        var call = Assert.Single(reply.ToolCalls);
        Assert.Equal("call-1", call.CallId);
        Assert.Equal("read_panel", call.ToolName);
        Assert.Equal("arrival-rate", call.Input.GetProperty("panelId").GetString());
    }

    [Fact]
    public void TokenCountsAreReadFromUsage()
    {
        var reply = KimiAnalystModel.ToReply(ReasonedThenCalled());

        Assert.Equal(1200, reply.InputTokens);
        Assert.Equal(340, reply.OutputTokens);
    }

    [Fact]
    public void ANullContentBecomesNoTextRatherThanTheStringNull()
    {
        var reply = KimiAnalystModel.ToReply(ReasonedThenCalled());

        Assert.Null(reply.Text);
    }

    [Fact]
    public void MalformedToolArgumentsStillProduceACallThatCannotValidate()
    {
        // The model can emit invalid JSON in `arguments`. That must not throw: every tool_call needs a
        // matching tool message in the next request, so the call has to exist for the loop to answer
        // it with an error. JSON null is used because it fails every object schema in the catalog --
        // an empty object could VALIDATE against a schema with no required fields, and the loop would
        // then run a tool with input the model never actually sent.
        var body = JsonDocument.Parse("""
        {
          "choices": [ { "message": { "role": "assistant", "content": null,
            "tool_calls": [ { "id": "call-1", "type": "function",
              "function": { "name": "read_panel", "arguments": "{not json" } } ] } } ],
          "usage": { "prompt_tokens": 1, "completion_tokens": 1 }
        }
        """).RootElement.Clone();

        var reply = KimiAnalystModel.ToReply(body);

        var call = Assert.Single(reply.ToolCalls);
        Assert.Equal(JsonValueKind.Null, call.Input.ValueKind);
    }

    [Fact]
    public void ATextOnlyReplyIsReadAsTextWithNoCalls()
    {
        var body = JsonDocument.Parse("""
        {
          "choices": [ { "message": { "role": "assistant", "content": "I need more information." } } ],
          "usage": { "prompt_tokens": 5, "completion_tokens": 6 }
        }
        """).RootElement.Clone();

        var reply = KimiAnalystModel.ToReply(body);

        Assert.Empty(reply.ToolCalls);
        Assert.Equal("I need more information.", reply.Text);
    }

    [Fact]
    public void AnAssistantTurnReplaysItsProviderEchoVerbatimRatherThanRebuildingIt()
    {
        // The whole point. reasoning_content cannot be reconstructed from content + tool_calls, and the
        // endpoint requires the complete assistant message returned unchanged on tool-call turns -- so
        // a rebuilt turn fails every investigation on its SECOND model call, the first one to replay.
        var reply = KimiAnalystModel.ToReply(ReasonedThenCalled("weighing two hypotheses"));
        var turn = new ModelTurn(ModelRole.Assistant, reply.Text, reply.ToolCalls, []);

        var message = KimiAnalystModel.ToMessages(turn).Single();

        Assert.Equal("weighing two hypotheses", message["reasoning_content"]!.GetValue<string>());
        Assert.Equal("call-1", message["tool_calls"]!.AsArray()[0]!["id"]!.GetValue<string>());
    }

    [Fact]
    public void ReplayingTheSameTurnTwiceIsSafe()
    {
        // A JsonNode cannot be attached to two parents, and the transcript is re-sent on every call --
        // so the echo must be cloned per use or the second request throws.
        var reply = KimiAnalystModel.ToReply(ReasonedThenCalled());
        var turn = new ModelTurn(ModelRole.Assistant, reply.Text, reply.ToolCalls, []);

        _ = KimiAnalystModel.BuildRequest(Options(), "contract", [turn], []);
        var second = KimiAnalystModel.BuildRequest(Options(), "contract", [turn], []);

        Assert.Equal("assistant", second["messages"]!.AsArray()[1]!["role"]!.GetValue<string>());
    }

    [Fact]
    public void AnAssistantTurnWithNoEchoIsStillRebuiltFromItsVisibleParts()
    {
        // Every hand-built transcript in the rest of the suite leaves ProviderEcho null. That path must
        // keep working.
        var turn = new ModelTurn(ModelRole.Assistant, "thinking out loud",
            [new ModelToolCall("call-1", "read_panel", JsonDocument.Parse("{}").RootElement.Clone())], []);

        var message = KimiAnalystModel.ToMessages(turn).Single();

        Assert.Equal("thinking out loud", message["content"]!.GetValue<string>());
        Assert.Equal("read_panel", message["tool_calls"]!.AsArray()[0]!["function"]!["name"]!.GetValue<string>());
    }

    [Theory]
    [InlineData("https://api.moonshot.ai/v1", "https://api.moonshot.ai/v1/chat/completions")]
    [InlineData("https://api.moonshot.ai/v1/", "https://api.moonshot.ai/v1/chat/completions")]
    public void TheBaseAddressKeepsItsPathSegment(string configured, string expected)
    {
        // Without a trailing slash, Uri composition DROPS the last segment, and requests silently go to
        // /chat/completions instead of /v1/chat/completions -- a 404 that looks like a wrong URL.
        var baseAddress = KimiAnalystModel.NormaliseBaseAddress(configured);

        Assert.Equal(expected, new Uri(baseAddress, KimiAnalystModel.RequestPath).ToString());
    }

    [Fact]
    public void AnEmptyChoicesArrayIsAnUnreadableResponseRatherThanACrash()
    {
        // The indexer on an empty array throws IndexOutOfRangeException, which no catch in SendAsync
        // translates -- so it would escape as an unhandled fault instead of a Failed step.
        var body = JsonDocument.Parse("""
        { "choices": [], "usage": { "prompt_tokens": 1, "completion_tokens": 1 } }
        """).RootElement.Clone();

        var ex = Assert.Throws<AnalysisImpossibleException>(
            () => KimiAnalystModel.ToReply(body));
        Assert.Contains("no choices", ex.Message, System.StringComparison.Ordinal);
    }

    [Fact]
    public void AMissingUsageBlockIsAnUnreadableResponse()
    {
        var body = JsonDocument.Parse("""
        { "choices": [ { "message": { "role": "assistant", "content": "hello" } } ] }
        """).RootElement.Clone();

        Assert.Throws<AnalysisImpossibleException>(
            () => KimiAnalystModel.ToReply(body));
    }

    [Fact]
    public void ANonNumericTokenCountIsAnUnreadableResponse()
    {
        // The loop enforces its budget from these numbers, so a count it cannot read is a run it
        // cannot account for -- not a run worth continuing with a fabricated zero.
        var body = JsonDocument.Parse("""
        { "choices": [ { "message": { "role": "assistant", "content": "hello" } } ],
          "usage": { "prompt_tokens": "lots", "completion_tokens": 1 } }
        """).RootElement.Clone();

        var ex = Assert.Throws<AnalysisImpossibleException>(
            () => KimiAnalystModel.ToReply(body));
        Assert.Contains("prompt_tokens", ex.Message, System.StringComparison.Ordinal);
    }
}
