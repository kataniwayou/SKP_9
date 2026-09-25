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
internal sealed class KimiAnalystModel
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
