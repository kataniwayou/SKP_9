# Kimi K3 Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `Processor.Analyst`'s Anthropic model backend with Moonshot's Kimi K3 over its
OpenAI-compatible HTTP API, with model id, base URL, API key and reasoning effort supplied as deployment
environment variables.

**Architecture:** A new `KimiAnalystModel : IAnalystModel` speaks the OpenAI `/chat/completions` wire
format using `HttpClient` and `System.Text.Json` directly — no client library, so the non-standard
`reasoning_content` field survives the round-trip. The assistant turn is replayed **verbatim** from the
raw JSON the server sent, carried across the seam on the existing `ModelToolCall.ProviderEcho`. The
Anthropic adapter and its package are deleted. Everything above `IAnalystModel` is untouched.

**Tech Stack:** C# / .NET 8, `System.Text.Json` (including `System.Text.Json.Nodes`),
`Microsoft.Extensions.Http` (already referenced), xunit v3 under Microsoft Testing Platform.

**Spec:** `docs/superpowers/specs/2026-09-25-analyst-kimi-k3-backend-design.md`

## Global Constraints

- **Target framework `net8.0`; `Nullable` and `ImplicitUsings` enabled; `TreatWarningsAsErrors`.** These
  come from `Directory.Build.props`. A warning fails the build — no unused usings, no nullable slips.
- **No new NuGet packages.** `NuGet.config` clears nuget.org, so any package needs vendoring into
  `nugets/` with its full transitive closure or the Docker build fails. `System.Text.Json` is in-box and
  `Microsoft.Extensions.Http` is already referenced (`Processor.Analyst.csproj:44`). Nothing else is needed.
- **`dotnet test` silently ignores `--filter` under MTP and reports counts without names.** Always run the
  built executable directly: `src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe`. It accepts
  `--filter-class` and `--filter-method` with **fully-qualified** names (a bare class name matches zero
  tests and exits 0 — indistinguishable from passing).
- **Suite health is a shape, never a remembered total:** `0 failed`, and every skip under `Live/`.
  Disregard any run taken while the machine is under memory pressure — the test host loses results for the
  batch in flight and reports never-run tests as skips.
- **Nothing above `IAnalystModel` may gain a notion of "thinking" or "reasoning".** The echo is
  provider-opaque and only the adapter opens it. This is a load-bearing constraint from the prior design.
- **A step's disposition describes whether the analysis *ran*, never what it concluded.** Every backend
  fault must reach `Failed` via `AnalysisImpossibleException`. Silence (`Cancelled`) is read downstream as
  the all-clear, so a broken monitor must never be silent.
- **Model id, base URL and reasoning effort must be environment variables**, never a reloadable config
  file. Spec §5.2: env vars freeze at container start, so changing one rolls the pod and clears the
  per-replica `BitCache`, which is what forces the BIT to re-run.
- **Endpoint values:** base URL `https://api.moonshot.ai/v1`, model `kimi-k3`, `reasoning_effort` one of
  `low` / `high` / `max` (default `max`; we set `high` explicitly — never inherit `max`).

## File Structure

**Create:**
- `src/Processor.Analyst/Model/KimiAnalystModel.cs` — the entire adapter: request shaping, response
  parsing, verbatim echo, error translation. One file, mirroring the deleted
  `AnthropicAnalystModel.cs` (260 lines) — house style here is one adapter, one file, and splitting the
  JSON shaping out would separate things that change together.
- `src/tests/BaseApi.Tests/Analyst/KimiAnalystModelTests.cs` — its tests.

**Modify:**
- `src/Processor.Analyst/Model/AnalystModelOptions.cs` — add `ModelId`, `ReasoningEffort`; rewrite the
  `BaseUrl` comment, which currently forbids exactly this use.
- `src/Processor.Analyst/ProcessorHost.cs:136-138` — options binding plus `AddHttpClient<KimiAnalystModel>`
  and the `IAnalystModel` registration.
- `src/Processor.Analyst/Model/IAnalystModel.cs:1-20` — the seam's justification is no longer true.
- `src/Processor.Analyst/Model/ModelTypes.cs:22,55` — comments cite Anthropic specifics.
- `src/Processor.Analyst/Loop/BudgetLedger.cs:6-8` — same.
- `src/Processor.Analyst/Loop/InvestigationLoop.cs:40` — the F5 premise about client timeouts.
- `src/Processor.Analyst/Processor.Analyst.csproj:37-40`, `Directory.Packages.props:152` — drop `Anthropic`.
- `src/Processor.Analyst/appsettings.json` — dev defaults under `Analyst:Model`.
- `k8s/43-processor-analyst.yaml` — three new env vars; the Secret comment shows an `sk-ant-…` key.
- `src/tests/BaseApi.Tests/Analyst/AnalystHostTests.cs:80` — names `AnthropicAnalystModel`.
- `src/tests/BaseApi.Tests/Analyst/InvestigationLoopTests.cs:290` — cites an Opus 5 trap that cannot occur.

**Delete:**
- `src/Processor.Analyst/Model/AnthropicAnalystModel.cs`
- `src/tests/BaseApi.Tests/Analyst/AnthropicAnalystModelTests.cs`
- `nugets/anthropic.12.50.0.nupkg`, `nugets/README-anthropic.md`

---

### Task 1: Options and request shaping

**Files:**
- Modify: `src/Processor.Analyst/Model/AnalystModelOptions.cs`
- Create: `src/Processor.Analyst/Model/KimiAnalystModel.cs`
- Test: `src/tests/BaseApi.Tests/Analyst/KimiAnalystModelTests.cs`

**Interfaces:**
- Consumes: `ModelTurn`, `ModelRole`, `ModelToolCall`, `ModelToolResult`, `ToolSpec` from
  `Processor.Analyst.Model.ModelTypes` (unchanged).
- Produces: `AnalystModelOptions.ModelId`, `.ReasoningEffort` (both `string?`);
  `internal static JsonObject KimiAnalystModel.BuildRequest(AnalystModelOptions options, string system,
  IReadOnlyList<ModelTurn> transcript, IReadOnlyList<ToolSpec> tools)`;
  `internal static IEnumerable<JsonNode> KimiAnalystModel.ToMessages(ModelTurn turn)`.

- [ ] **Step 1: Add the two options**

In `AnalystModelOptions.cs`, replace the class body and the `BaseUrl` summary:

```csharp
internal sealed class AnalystModelOptions
{
    /// <summary>
    /// The model to call, e.g. <c>kimi-k3</c>.
    /// <para>
    /// <b>This must arrive as an environment variable, never a reloadable config file.</b> It changes
    /// the preflight BIT's verdict, and <c>PreflightBit</c> caches on a hash of the prompt alone. Env
    /// vars freeze at container start, so changing this rolls the pod, which discards the per-replica
    /// <c>BitCache</c>, which re-runs the BIT. A mounted ConfigMap with reloadOnChange would break that
    /// silently: a live swap against a warm cache reusing a verdict earned on the old model.
    /// </para>
    /// </summary>
    public string? ModelId { get; set; }

    /// <summary>
    /// <c>low</c>, <c>high</c> or <c>max</c>. Set it explicitly — the endpoint defaults to <c>max</c>,
    /// which is the most expensive setting, and reasoning tokens bill as output. Thinking cannot be
    /// disabled on this model. Same env-var-only rule as <see cref="ModelId"/>, for the same reason:
    /// effort changes the BIT's verdict too.
    /// </summary>
    public string? ReasoningEffort { get; set; }

    public string? ApiKey { get; set; }

    /// <summary>
    /// The endpoint's base address, e.g. <c>https://api.moonshot.ai/v1</c>. A trailing slash is added
    /// if absent — without one, <see cref="Uri"/> composition drops the last path segment and requests
    /// go to <c>/chat/completions</c> instead of <c>/v1/chat/completions</c>.
    /// </summary>
    public string? BaseUrl { get; set; }
}
```

Keep the existing class-level summary about credentials belonging to the deployment; delete only the
sentence in the old `BaseUrl` summary forbidding non-Anthropic endpoints.

- [ ] **Step 2: Write the failing tests**

Create `src/tests/BaseApi.Tests/Analyst/KimiAnalystModelTests.cs`:

```csharp
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
```

- [ ] **Step 3: Run the tests to verify they fail**

```
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -v q --nologo
```

Expected: **build failure**, `CS0103`/`CS0117` — `KimiAnalystModel` does not exist. That is the correct
red state for a new type.

- [ ] **Step 4: Write the minimal implementation**

Create `src/Processor.Analyst/Model/KimiAnalystModel.cs`:

```csharp
using System.Text.Json.Nodes;

namespace Processor.Analyst.Model;

/// <summary>
/// The Kimi K3 implementation of <see cref="IAnalystModel"/>, speaking the endpoint's
/// OpenAI-compatible <c>/chat/completions</c> format over a plain <see cref="HttpClient"/>.
/// <para>
/// <b>Deliberately not a client library.</b> The endpoint returns a <c>reasoning_content</c> field that
/// is not part of OpenAI's schema and that its documentation requires returned unchanged on assistant
/// turns carrying tool calls. Holding the raw JSON is what guarantees that; a library modelled on
/// OpenAI's schema would be free to drop it. See the design's §3 and §4.
/// </para>
/// </summary>
internal sealed class KimiAnalystModel : IAnalystModel
{
    /// <summary>Builds the whole request body. Static and options-taking so a test needs no HttpClient.</summary>
    internal static JsonObject BuildRequest(
        AnalystModelOptions options,
        string system,
        IReadOnlyList<ModelTurn> transcript,
        IReadOnlyList<ToolSpec> tools)
    {
        ArgumentNullException.ThrowIfNull(options);
        ArgumentNullException.ThrowIfNull(system);
        ArgumentNullException.ThrowIfNull(transcript);
        ArgumentNullException.ThrowIfNull(tools);

        var messages = new JsonArray
        {
            new JsonObject { ["role"] = "system", ["content"] = system },
        };

        foreach (var turn in transcript)
        {
            foreach (var message in ToMessages(turn))
            {
                messages.Add(message);
            }
        }

        var toolArray = new JsonArray();
        foreach (var spec in tools)
        {
            toolArray.Add(new JsonObject
            {
                ["type"] = "function",
                ["function"] = new JsonObject
                {
                    ["name"] = spec.Name,
                    ["description"] = spec.Description,
                    // Passed through verbatim, additionalProperties included. The loop re-validates
                    // every input against this same schema client-side regardless of what the server
                    // does or does not enforce.
                    ["parameters"] = JsonNode.Parse(spec.InputSchemaJson),
                },
            });
        }

        return new JsonObject
        {
            ["model"] = options.ModelId,
            ["reasoning_effort"] = options.ReasoningEffort,
            ["messages"] = messages,
            ["tools"] = toolArray,
        };
    }

    /// <summary>
    /// Translates one transcript entry into the messages it becomes. A user turn carrying tool results
    /// becomes one <c>tool</c> message per result — all of them in the same request, because the API
    /// rejects a follow-up in which any <c>tool_call</c> id lacks a matching result, and splitting them
    /// across requests trains the model out of parallel calls.
    /// </summary>
    internal static IEnumerable<JsonNode> ToMessages(ModelTurn turn)
    {
        ArgumentNullException.ThrowIfNull(turn);

        if (turn.Role == ModelRole.Assistant)
        {
            yield return AssistantMessage(turn);
            yield break;
        }

        foreach (var result in turn.ToolResults)
        {
            yield return new JsonObject
            {
                ["role"] = "tool",
                ["tool_call_id"] = result.CallId,
                // The wire format has no is_error field. Dropping the distinction would let the model
                // read a failure as ordinary data, so it is marked in the content instead.
                ["content"] = result.IsError ? $"ERROR: {result.Content}" : result.Content,
            };
        }

        if (turn.Text is { Length: > 0 } userText)
        {
            yield return new JsonObject { ["role"] = "user", ["content"] = userText };
        }
    }

    /// <summary>Reconstruction from visible parts. Task 3 replaces this with verbatim replay.</summary>
    private static JsonNode AssistantMessage(ModelTurn turn)
    {
        var message = new JsonObject { ["role"] = "assistant" };

        if (turn.Text is { Length: > 0 } assistantText)
        {
            message["content"] = assistantText;
        }

        if (turn.ToolCalls.Count > 0)
        {
            var calls = new JsonArray();
            foreach (var call in turn.ToolCalls)
            {
                calls.Add(new JsonObject
                {
                    ["id"] = call.CallId,
                    ["type"] = "function",
                    ["function"] = new JsonObject
                    {
                        ["name"] = call.ToolName,
                        // `arguments` is a JSON *string* on this wire format, not an object.
                        ["arguments"] = call.Input.GetRawText(),
                    },
                });
            }

            message["tool_calls"] = calls;
        }

        return message;
    }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -v q --nologo
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.Analyst.KimiAnalystModelTests"
```

Expected: `failed: 0`, 6 succeeded.

- [ ] **Step 6: Commit**

```bash
git add src/Processor.Analyst/Model/AnalystModelOptions.cs src/Processor.Analyst/Model/KimiAnalystModel.cs src/tests/BaseApi.Tests/Analyst/KimiAnalystModelTests.cs
git commit -m "feat(analyst): shape Kimi K3 chat-completions requests"
```

---

### Task 2: Response parsing

**Files:**
- Modify: `src/Processor.Analyst/Model/KimiAnalystModel.cs`
- Test: `src/tests/BaseApi.Tests/Analyst/KimiAnalystModelTests.cs`

**Interfaces:**
- Consumes: Task 1's `KimiAnalystModel`.
- Produces: `internal static ModelReply KimiAnalystModel.ToReply(JsonElement body)` — reads
  `choices[0].message` and `usage`, returns tool calls, text and token counts. Each returned
  `ModelToolCall` carries the raw assistant message as its `ProviderEcho` (a `JsonNode`).

- [ ] **Step 1: Write the failing tests**

Append to `KimiAnalystModelTests.cs`:

```csharp
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
```

- [ ] **Step 2: Run the tests to verify they fail**

```
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -v q --nologo
```

Expected: **build failure**, `CS0117` — `ToReply` does not exist on `KimiAnalystModel`.

- [ ] **Step 3: Write the implementation**

Add `using System.Text.Json;` to the top of `KimiAnalystModel.cs`, then add:

```csharp
    /// <summary>
    /// Translates one response body into the loop's reply shape. Takes the parsed body rather than an
    /// <see cref="HttpResponseMessage"/> so the translation is reachable from a test.
    /// </summary>
    internal static ModelReply ToReply(JsonElement body)
    {
        var message = body.GetProperty("choices")[0].GetProperty("message");

        // The verbatim assistant message, kept as its own tree so it outlives the caller's
        // JsonDocument and can be sent back untouched. This is what Task 3 replays.
        var echo = JsonNode.Parse(message.GetRawText())!;

        List<ModelToolCall> calls = [];

        if (message.TryGetProperty("tool_calls", out var toolCalls)
            && toolCalls.ValueKind == JsonValueKind.Array)
        {
            foreach (var toolCall in toolCalls.EnumerateArray())
            {
                var function = toolCall.GetProperty("function");

                calls.Add(new ModelToolCall(
                    toolCall.GetProperty("id").GetString()!,
                    function.GetProperty("name").GetString()!,
                    ParseArguments(function))
                {
                    ProviderEcho = echo,
                });
            }
        }

        string? text = null;
        if (message.TryGetProperty("content", out var content)
            && content.ValueKind == JsonValueKind.String)
        {
            text = content.GetString();
        }

        var usage = body.GetProperty("usage");

        return new ModelReply(
            calls,
            text,
            usage.GetProperty("prompt_tokens").GetInt32(),
            usage.GetProperty("completion_tokens").GetInt32());
    }

    /// <summary>
    /// <c>function.arguments</c> is a JSON *string* on this wire format, so it needs a second parse.
    /// Invalid JSON yields JSON null rather than throwing: the call must still exist so the loop can
    /// answer it with an error result, and null fails every object schema in the catalog. An empty
    /// object would be worse — it could validate against a schema with no required fields, and the
    /// loop would run a tool with input the model never sent.
    /// </summary>
    private static JsonElement ParseArguments(JsonElement function)
    {
        var raw = function.TryGetProperty("arguments", out var arguments)
            ? arguments.GetString()
            : null;

        if (string.IsNullOrWhiteSpace(raw))
        {
            return JsonDocument.Parse("null").RootElement.Clone();
        }

        try
        {
            return JsonDocument.Parse(raw).RootElement.Clone();
        }
        catch (JsonException)
        {
            return JsonDocument.Parse("null").RootElement.Clone();
        }
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

```
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -v q --nologo
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.Analyst.KimiAnalystModelTests"
```

Expected: `failed: 0`, 11 succeeded.

- [ ] **Step 5: Commit**

```bash
git add src/Processor.Analyst/Model/KimiAnalystModel.cs src/tests/BaseApi.Tests/Analyst/KimiAnalystModelTests.cs
git commit -m "feat(analyst): read tool calls, text and usage from a Kimi response"
```

---

### Task 3: Verbatim assistant replay — the load-bearing task

**Files:**
- Modify: `src/Processor.Analyst/Model/KimiAnalystModel.cs`
- Test: `src/tests/BaseApi.Tests/Analyst/KimiAnalystModelTests.cs`

**Interfaces:**
- Consumes: Task 2's `ToReply` and its `ProviderEcho`.
- Produces: `ToMessages` returning the stored assistant message unchanged when an echo is present,
  falling back to reconstruction when it is not.

**Why this task exists.** K3's docs require the complete assistant message returned unchanged on
multi-turn tool calls, and the response carries `reasoning_content` that cannot be rebuilt from `content`
plus `tool_calls`. The loop replays the whole transcript every call, so turn 1 replays nothing and
**turn 2 is the first replay**. Reconstruction therefore fails every investigation on its second model
call while every offline test passes. The identical defect shipped on the Anthropic adapter (Ruling 35).

- [ ] **Step 1: Write the failing test**

Append to `KimiAnalystModelTests.cs`:

```csharp
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
```

- [ ] **Step 2: Run the tests to verify they fail**

```
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -v q --nologo
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.Analyst.KimiAnalystModelTests"
```

Expected: `AnAssistantTurnReplaysItsProviderEchoVerbatimRatherThanRebuildingIt` **fails** — the rebuilt
message has no `reasoning_content`, so indexing it yields a null reference. `ReplayingTheSameTurnTwiceIsSafe`
and the no-echo test pass already.

- [ ] **Step 3: Replace `AssistantMessage` with verbatim replay**

In `KimiAnalystModel.cs`, replace the whole `AssistantMessage` method with:

```csharp
    /// <summary>
    /// An assistant turn this adapter produced goes back <b>exactly</b> as it arrived.
    /// <para>
    /// The endpoint's documentation requires the complete assistant message returned unchanged on
    /// multi-turn tool calls, and its <c>reasoning_content</c> cannot be rebuilt from <c>content</c> plus
    /// <c>tool_calls</c>. Rebuilding one therefore fails every investigation on its SECOND model call —
    /// the first that replays a turn — while every offline test still passes. The reconstruction below
    /// exists only for turns that came from somewhere else: a hand-built transcript, or any future
    /// adapter that carries no echo.
    /// </para>
    /// <para>
    /// The clone is required, not defensive: a <see cref="JsonNode"/> cannot be attached to two parents,
    /// and the transcript is re-sent on every call of the loop.
    /// </para>
    /// </summary>
    private static JsonNode AssistantMessage(ModelTurn turn)
    {
        if (turn.ToolCalls.Select(call => call.ProviderEcho).OfType<JsonNode>().FirstOrDefault()
            is { } echo)
        {
            return echo.DeepClone();
        }

        var message = new JsonObject { ["role"] = "assistant" };

        if (turn.Text is { Length: > 0 } assistantText)
        {
            message["content"] = assistantText;
        }

        if (turn.ToolCalls.Count > 0)
        {
            var calls = new JsonArray();
            foreach (var call in turn.ToolCalls)
            {
                calls.Add(new JsonObject
                {
                    ["id"] = call.CallId,
                    ["type"] = "function",
                    ["function"] = new JsonObject
                    {
                        ["name"] = call.ToolName,
                        // `arguments` is a JSON *string* on this wire format, not an object.
                        ["arguments"] = call.Input.GetRawText(),
                    },
                });
            }

            message["tool_calls"] = calls;
        }

        return message;
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

```
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -v q --nologo
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.Analyst.KimiAnalystModelTests"
```

Expected: `failed: 0`, 14 succeeded.

- [ ] **Step 5: Red-check the guard — do not skip this**

A test that passes against a reconstructing adapter is worthless, and this is the one property no
offline test would otherwise reach. Prove it fails when the replay is removed.

Temporarily change the guard's condition to `if (false && turn.ToolCalls.Select(...)...`, rebuild, and
re-run the class. Expected: exactly
`AnAssistantTurnReplaysItsProviderEchoVerbatimRatherThanRebuildingIt` fails. Then restore the line and
re-run to confirm `failed: 0` again.

- [ ] **Step 6: Commit**

```bash
git add src/Processor.Analyst/Model/KimiAnalystModel.cs src/tests/BaseApi.Tests/Analyst/KimiAnalystModelTests.cs
git commit -m "feat(analyst): replay assistant turns verbatim so reasoning_content survives"
```

---

### Task 4: `SendAsync`, error translation and DI wiring

**Files:**
- Modify: `src/Processor.Analyst/Model/KimiAnalystModel.cs`
- Modify: `src/Processor.Analyst/ProcessorHost.cs:136-138`
- Modify: `src/Processor.Analyst/appsettings.json`
- Modify: `src/tests/BaseApi.Tests/Analyst/AnalystHostTests.cs:80`
- Test: `src/tests/BaseApi.Tests/Analyst/KimiAnalystModelTests.cs`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `KimiAnalystModel(HttpClient http, IOptions<AnalystModelOptions> options)` implementing
  `IAnalystModel.SendAsync`; `internal static string RequestPath` = `"chat/completions"`;
  `internal static Uri NormaliseBaseAddress(string? baseUrl)`.

- [ ] **Step 1: Write the failing test for base-address normalisation**

The one piece of `SendAsync` worth unit-testing offline. Append to `KimiAnalystModelTests.cs`:

```csharp
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
```

- [ ] **Step 2: Run to verify it fails**

```
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -v q --nologo
```

Expected: build failure — `NormaliseBaseAddress` and `RequestPath` do not exist.

- [ ] **Step 3: Implement the constructor, `SendAsync` and the helpers**

Add `using System.Net.Http.Json;`, `using System.Text.Json;` and `using Microsoft.Extensions.Options;`
plus `using Processor.Analyst.Loop;` to `KimiAnalystModel.cs`, and add to the class:

```csharp
    internal const string RequestPath = "chat/completions";

    private readonly HttpClient _http;
    private readonly AnalystModelOptions _options;

    public KimiAnalystModel(HttpClient http, IOptions<AnalystModelOptions> options)
    {
        ArgumentNullException.ThrowIfNull(http);
        ArgumentNullException.ThrowIfNull(options);

        _http = http;
        _options = options.Value;
    }

    /// <summary>
    /// A base address must end in "/" or <see cref="Uri"/> composition discards its last path segment,
    /// sending every request to <c>/chat/completions</c> instead of <c>/v1/chat/completions</c>.
    /// </summary>
    internal static Uri NormaliseBaseAddress(string? baseUrl)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(baseUrl);

        return new Uri(baseUrl.EndsWith('/') ? baseUrl : baseUrl + "/", UriKind.Absolute);
    }

    public async Task<ModelReply> SendAsync(
        string system,
        IReadOnlyList<ModelTurn> transcript,
        IReadOnlyList<ToolSpec> tools,
        CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(system);
        ArgumentNullException.ThrowIfNull(transcript);
        ArgumentNullException.ThrowIfNull(tools);

        var request = BuildRequest(_options, system, transcript, tools);

        try
        {
            using var response = await _http
                .PostAsJsonAsync(RequestPath, request, ct)
                .ConfigureAwait(false);

            if (!response.IsSuccessStatusCode)
            {
                // Reached and answered with a failure: auth, rate limit, 5xx. Still "could not run" --
                // the loop has no way to make progress from here.
                throw new AnalysisImpossibleException(
                    $"the model backend returned {(int)response.StatusCode} {response.ReasonPhrase}");
            }

            var body = await response.Content
                .ReadFromJsonAsync<JsonElement>(ct)
                .ConfigureAwait(false);

            return ToReply(body);
        }
        catch (HttpRequestException ex)
        {
            // The connection itself failed: DNS, TCP, TLS, or no response at all.
            throw new AnalysisImpossibleException("the model backend could not be reached", ex);
        }
        catch (JsonException ex)
        {
            // Reached, answered 2xx, and sent something this adapter cannot read.
            throw new AnalysisImpossibleException(
                "the model backend returned a response that could not be parsed", ex);
        }
        catch (KeyNotFoundException ex)
        {
            // Valid JSON missing a field this adapter requires -- same conclusion.
            throw new AnalysisImpossibleException(
                "the model backend returned a response missing a required field", ex);
        }
        catch (InvalidOperationException ex)
        {
            // JsonElement accessor called against the wrong value kind: also a shape we cannot read.
            throw new AnalysisImpossibleException(
                "the model backend returned a response of an unexpected shape", ex);
        }
        catch (TaskCanceledException ex) when (!ct.IsCancellationRequested)
        {
            // The client's own timeout, not our caller's cancellation -- that case is left to
            // propagate untouched so the loop's own handling still sees it as a cancellation.
            throw new AnalysisImpossibleException("the model backend timed out", ex);
        }
    }
```

Note the ordering: `TaskCanceledException` derives from `OperationCanceledException`, not from
`HttpRequestException`, so the filtered catch is reached. A caller-cancelled token falls through
untouched, which is what lets `AnalystProcessor` distinguish a shutdown from a fault.

- [ ] **Step 4: Wire it in `ProcessorHost.cs`**

Replace line 138 (`AddSingleton<Model.IAnalystModel, Model.AnthropicAnalystModel>()`) with:

```csharp
        // Timeout.InfiniteTimeSpan is deliberate, not an oversight. Thinking is always on for this
        // model and cannot be disabled, so a single call at `high` effort can legitimately run for
        // minutes -- far past HttpClient's 100s default, which would abort healthy investigations. The
        // real bound is the wall-clock token InvestigationLoop links into every model call (F5); that
        // is the only thing that should end a call early, and it reports as a cancellation rather than
        // a backend fault. PooledConnectionLifetime matches the panel sources: this typed client is
        // captured for the process lifetime by a singleton, which defeats IHttpClientFactory's own
        // handler rotation, and recycling sockets periodically is the documented fix.
        builder.Services.AddHttpClient<Model.KimiAnalystModel>((serviceProvider, client) =>
            {
                var options = serviceProvider
                    .GetRequiredService<IOptions<Model.AnalystModelOptions>>().Value;

                client.BaseAddress = Model.KimiAnalystModel.NormaliseBaseAddress(options.BaseUrl);
                client.Timeout = Timeout.InfiniteTimeSpan;
                client.DefaultRequestHeaders.Authorization =
                    new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", options.ApiKey);
            })
            .ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler
            {
                PooledConnectionLifetime = TimeSpan.FromMinutes(5),
            });

        builder.Services.AddSingleton<Model.IAnalystModel>(serviceProvider =>
            serviceProvider.GetRequiredService<Model.KimiAnalystModel>());
```

Add `using Microsoft.Extensions.Options;` to `ProcessorHost.cs` if it is not already present.

**Why the two-step registration:** `AddHttpClient<T>` registers `T` as *transient*. `IAnalystModel` must
stay a singleton for the BIT cache's per-replica reasoning to hold, so the singleton resolves the typed
client once. That is the same captive-dependency shape the panel sources already have, and
`PooledConnectionLifetime` is why it is safe.

- [ ] **Step 5: Add dev defaults to `appsettings.json`**

Inside the existing `"Analyst"` object, before `"Panels"`:

```json
    "Model": {
      "BaseUrl": "https://api.moonshot.ai/v1",
      "ModelId": "kimi-k3",
      "ReasoningEffort": "high"
    },
```

Do **not** add `ApiKey` — it comes from the Secret, never a file in the repo.

- [ ] **Step 6: Update the host tests**

`AnalystHostTests.Configuration` (line 19-27) supplies no `Analyst:Model:*` keys, and
`NormaliseBaseAddress` throws on a missing base URL. `TheServiceGraphResolves` runs with
`--environment Development`, which turns on `ValidateOnBuild` and therefore resolves this client — so
**the test will fail without a base URL present.** Add one entry to that dictionary:

```csharp
        ["Analyst:Model:BaseUrl"]   = "https://example.invalid/v1",
```

`.invalid` is reserved by RFC 2606 and can never resolve, so no test can accidentally make a real call.
Deliberately add **no** `Analyst:Model:ApiKey` — see the note below.

Then change the comment at line 80 from naming `AnthropicAnalystModel` to:

```csharp
        // IAnalystModel resolves to the real KimiAnalystModel and IPanelReader resolves to the
        // real LivePanelReader, both registered by ProcessorHost.Create -- no configureServices
        // override is needed for either.
```

**Two different failure philosophies here, both deliberate — do not "fix" either one:**

- **A missing or malformed base URL throws at DI resolution**, i.e. a startup crash. That is loud,
  immediate, and never reaches the loop. It matches the existing accepted behaviour for a malformed panel
  base address.
- **A missing or wrong API key must NOT crash at boot.** It produces a request the endpoint rejects, which
  becomes `AnalysisImpossibleException` and so a per-dispatch `Failed` step. This preserves the prior
  design's deliberate choice, which the deleted adapter implemented with a `Lazy<T>`: a bad credential is
  a per-dispatch failure, never a boot-time crash. Passing a null key to
  `AuthenticationHeaderValue("Bearer", …)` is legal and yields a request that 401s, which is exactly the
  intended path — so do not add a guard that throws on a missing key.

- [ ] **Step 7: Run the Analyst tests**

```
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -v q --nologo
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-namespace "BaseApi.Tests.Analyst"
```

Expected: `failed: 0`. The count is the prior 145 plus the new Kimi tests, still including the Anthropic
tests — Task 5 removes those.

- [ ] **Step 8: Commit**

```bash
git add src/Processor.Analyst/Model/KimiAnalystModel.cs src/Processor.Analyst/ProcessorHost.cs src/Processor.Analyst/appsettings.json src/tests/BaseApi.Tests/Analyst/
git commit -m "feat(analyst): send Kimi requests and register the backend"
```

---

### Task 5: Delete the Anthropic backend and correct what justified it

**Files:**
- Delete: `src/Processor.Analyst/Model/AnthropicAnalystModel.cs`,
  `src/tests/BaseApi.Tests/Analyst/AnthropicAnalystModelTests.cs`,
  `nugets/anthropic.12.50.0.nupkg`, `nugets/README-anthropic.md`
- Modify: `src/Processor.Analyst/Processor.Analyst.csproj:37-40`, `Directory.Packages.props:152`,
  `src/Processor.Analyst/Model/IAnalystModel.cs`, `src/Processor.Analyst/Model/ModelTypes.cs:22,55`,
  `src/Processor.Analyst/Loop/BudgetLedger.cs:6-8`,
  `src/Processor.Analyst/Loop/InvestigationLoop.cs:40`,
  `src/tests/BaseApi.Tests/Analyst/InvestigationLoopTests.cs:290`

- [ ] **Step 1: Delete the adapter, its tests and the package**

```bash
git rm src/Processor.Analyst/Model/AnthropicAnalystModel.cs
git rm src/tests/BaseApi.Tests/Analyst/AnthropicAnalystModelTests.cs
git rm nugets/anthropic.12.50.0.nupkg nugets/README-anthropic.md
```

Remove `<PackageVersion Include="Anthropic" Version="12.50.0" />` from `Directory.Packages.props:152`,
and from `Processor.Analyst.csproj` remove the `<PackageReference Include="Anthropic" />` together with
the comment block above it that refers to `nugets/README-anthropic.md`.

- [ ] **Step 2: Rewrite the seam's justification**

`IAnalystModel.cs` currently claims the seam is "the only thing that makes one binary shippable to both
the connected cluster and the air-gapped machine". That is no longer true. Replace the two
justification paragraphs with:

```csharp
/// <summary>
/// The model backend, above the wire format.
/// <para>
/// <b>Deliberately not raw wire objects.</b> This is the test seam: the investigation loop, the
/// preflight BIT and every disposition rule are exercised against a stub implementation of this
/// interface, and without it none of that behaviour is testable offline. That alone justifies it.
/// </para>
/// <para>
/// It is also what keeps a future model change contained rather than invasive. Supporting several
/// backends at once is explicitly out of scope — there is one adapter, registered in ProcessorHost —
/// but when a better model arrives, this interface is the boundary the change stops at.
/// </para>
/// <para>
/// Nothing provider-specific may become load-bearing above this line: no reasoning or thinking
/// concept, no effort, no server-side schema enforcement. The authoritative budget is loop-enforced and
/// every tool input is validated client-side, so the loop never depends on a courtesy of one backend.
/// </para>
/// </summary>
```

- [ ] **Step 3: Correct the remaining Anthropic-specific comments**

- `ModelTypes.cs:22` — `ProviderEcho`'s summary cites "Anthropic's thinking blocks are signed". Replace
  that clause with: *"this endpoint returns a `reasoning_content` field that its documentation requires
  returned unchanged on assistant turns carrying tool calls, and that cannot be rebuilt from the turn's
  visible parts"*. Keep the rest, including why the state rides on a tool call.
- `ModelTypes.cs:55` — `ModelReply`'s summary says the budget is loop-enforced "because Anthropic's task
  budgets do not exist on the on-prem path". Replace the reason with: *"because no budget the backend
  might offer is something the loop may depend on"*.
- `BudgetLedger.cs:6-8` — same substitution: the ledger is authoritative because backend-side pacing is
  never load-bearing, not because of a specific vendor's feature.
- `InvestigationLoopTests.cs:290` — the comment cites the Opus 5 thinking-disabled trap. Replace with:
  *"The model talked instead of acting. Nothing was executed, so there is nothing to report and no way
  to continue honestly. Note this cannot be caused by disabled thinking on this backend — K3 always
  thinks and cannot be configured otherwise — so a reply with no tool calls is a genuine anomaly."*

- [ ] **Step 4: Re-verify the F5 timeout premise, do not just reword it**

`InvestigationLoop.cs:40` reasons from "the `AnthropicClient` has no configured request timeout". The
replacement client's timeout is now set explicitly in `ProcessorHost.cs` (Task 4, Step 4). Confirm that
value is `Timeout.InfiniteTimeSpan`, then update the comment to state the new premise:

> *"production passes `CancellationToken.None` all the way down and the model client is configured with
> `Timeout.InfiniteTimeSpan` — deliberately, because a thinking model at `high` effort can legitimately
> run for minutes — so without this a hung model call would wedge the pod's one consumer indefinitely
> while the liveness probe kept passing."*

The premise must be a fact about the code as it now stands, not inherited wording. If the timeout is
*not* infinite, stop and reconcile the two before continuing: a finite client timeout that is shorter
than `WallClockSeconds` would abort healthy investigations, and one that is longer makes this comment
wrong.

- [ ] **Step 5: Build and run the full suite**

```
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -v q --nologo
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe
```

Expected: `failed: 0`, every skip under `Live/`. A compile error naming `Anthropic` means a reference
was missed — the grep in Step 6 catches those.

- [ ] **Step 6: Prove nothing dangles**

```bash
git grep -n -i "anthropic\|claude-opus\|sk-ant" -- src k8s Directory.Packages.props nugets ':!*/bin/*' ':!*/obj/*'
```

Expected: no matches outside `k8s/43-processor-analyst.yaml`, which Task 6 handles. Any other hit is a
comment or reference the sweep missed.

- [ ] **Step 7: Commit**

```bash
git add -A src Directory.Packages.props nugets
git commit -m "refactor(analyst): delete the Anthropic backend and correct what justified it"
```

---

### Task 6: Deployment manifest

**Files:**
- Modify: `k8s/43-processor-analyst.yaml`

- [ ] **Step 1: Add the three new environment variables**

Beside the existing `Analyst__Model__ApiKey` block, add:

```yaml
            # The backend's three coordinates, deployment-supplied. These MUST stay environment
            # variables: they change the preflight BIT's verdict, and PreflightBit caches on a hash of
            # the prompt alone. Env vars freeze at container start, so editing one here rolls the pod,
            # which discards the per-replica BitCache, which re-runs the BIT. A mounted ConfigMap with
            # reloadOnChange would break that silently.
            - name: Analyst__Model__BaseUrl
              value: "https://api.moonshot.ai/v1"
            - name: Analyst__Model__ModelId
              value: "kimi-k3"
            # low | high | max. Set explicitly: the endpoint defaults to max, the most expensive
            # setting, reasoning tokens bill as output, and the monitor workflow runs unattended.
            - name: Analyst__Model__ReasoningEffort
              value: "high"
```

- [ ] **Step 2: Fix the Secret comment in the header**

Line 21 shows an Anthropic key format. Change the example to a Moonshot key and name its source:

```
#   kubectl -n skp create secret generic analyst-model --from-literal=apiKey='<key from platform.kimi.ai>'
```

- [ ] **Step 3: Validate the manifest parses**

```
kubectl apply -f k8s/43-processor-analyst.yaml --dry-run=client -o name
```

Expected: `deployment.apps/processor-analyst`. This is client-side only and touches nothing in the
cluster.

- [ ] **Step 4: Commit**

```bash
git add k8s/43-processor-analyst.yaml
git commit -m "build(analyst): supply the Kimi backend coordinates from the deployment"
```

---

### Task 7: Close out — ledger, offline baseline, and the live gate

**Files:**
- Modify: `.superpowers/sdd/2026-09-24-analyst-processor/progress.md` (gitignored scratch)
- Modify: `docs/superpowers/HANDOVER-2026-09-25-analyst-processor.md`

- [ ] **Step 1: Record the ruling that amends §9.2**

The prior design made model id and effort compiled constants, and the handover lists that among
decisions "a future session must not undo". This work undoes it deliberately, so the reasoning must be
written down where the next session will find it. Append a ruling to the ledger covering: that env vars
preserve the original guarantee because they freeze at container start and a change rolls the pod, which
discards the per-replica `BitCache`; that the condition is env-vars-only and never a reloadable
ConfigMap; and that `reasoning_effort` defaults to `max` at the endpoint and is therefore set explicitly.

- [ ] **Step 2: Update the handover**

Replace the Anthropic-specific sections with the new backend's shape: the four environment variables, the
`analyst-model` Secret now holding a Moonshot key, the suite shape from Task 5, and the still-open items.
Keep the disposition rule section verbatim — it is unchanged and it is the thing that matters most.

- [ ] **Step 3: Re-diff the offline baseline**

```
pwsh tools/ship-delta.ps1
```

`ship/` is the offline baseline and is never aligned to a commit, so it must be diffed rather than
assumed. Ship only the changed files.

- [ ] **Step 4: Record what is still not done**

Two items must not disappear into "shipped". State both in the handover:

1. **The scored-window replay set** (prior design §16.3) remains a **prerequisite** for trusting any
   finding from this backend, not a nicety — §9.5 says a prompt that passes its BIT on two models is not
   thereby equally good on both, and this work changed the model.
2. **A live two-turn smoke test has not run.** Nothing offline can prove the verbatim-replay requirement
   holds against the real endpoint; that is the entire lesson of Ruling 35. It must be the first thing a
   live run checks, before any irreversible registration is posted.

- [ ] **Step 5: Final suite run and commit**

```
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe
```

Expected: `failed: 0`, every skip under `Live/`. Run it on a quiet machine — under memory pressure the
host loses results for the batch in flight and reports never-run tests as skips, so a green run taken
under load is not evidence.

```bash
git add docs/superpowers/HANDOVER-2026-09-25-analyst-processor.md ship
git commit -m "docs(analyst): hand over the Kimi K3 backend, with the live smoke test still open"
```

---

## Deferred, deliberately

- **The scored-window replay set.** Separate work with its own value; it is the prerequisite for
  trusting findings, not for shipping the adapter. See Task 7 Step 4.
- **Self-hosting K3 for the air-gapped machine.** `api.moonshot.ai` is a hosted endpoint, so this design
  does not serve the offline case. At 2.8T parameters that is an infrastructure programme.
- **The offline Elasticsearch 9.3.4 gap.** Irrelevant to a connected-cluster deployment; blocking for an
  offline one.
- **Any backend-selection switch.** One adapter, wired once. Multi-model support is out of scope by
  decision, and `IAnalystModel` is what makes a future change contained.
