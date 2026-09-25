using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Options;
using Processor.Analyst.Loop;

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

    /// <summary>
    /// An assistant turn this adapter produced goes back <b>semantically unchanged, property-for-property</b>
    /// as it arrived. It is re-serialised via <c>JsonNode.Parse</c> → <c>DeepClone</c> →
    /// <c>PostAsJsonAsync</c>, so property order and values survive but string escaping need not (the
    /// default encoder escapes non-ASCII, <c>&lt;</c>, <c>&gt;</c>, <c>+</c>). No plausible server
    /// compares bytes, but this comment should not promise more than the code delivers.
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

    /// <summary>
    /// Translates one response body into the loop's reply shape. Takes the parsed body rather than an
    /// <see cref="HttpResponseMessage"/> so the translation is reachable from a test.
    /// </summary>
    internal static ModelReply ToReply(JsonElement body)
    {
        // The response envelope is validated here, where it is read, rather than by adding an
        // exception type per shape to SendAsync's catch chain. Every one of these is "reached the
        // backend, got a 2xx, cannot read the answer" -- which is an analysis that could not run, not
        // one that found nothing. Silence is the all-clear, so this must never become Cancelled.
        if (!body.TryGetProperty("choices", out var choices)
            || choices.ValueKind != JsonValueKind.Array
            || choices.GetArrayLength() == 0)
        {
            throw new AnalysisImpossibleException(
                "the model backend returned a response with no choices");
        }

        var message = choices[0].GetProperty("message");

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

        if (!body.TryGetProperty("usage", out var usage))
        {
            throw new AnalysisImpossibleException(
                "the model backend returned a response with no usage");
        }

        return new ModelReply(
            calls,
            text,
            TokenCount(usage, "prompt_tokens"),
            TokenCount(usage, "completion_tokens"));
    }

    /// <summary>
    /// Reads one token count. A count that is absent, non-numeric, or outside <see cref="int"/> range
    /// makes the reply unreadable rather than merely odd: the loop enforces its own token budget from
    /// these numbers, so substituting zero would let a run spend without accounting for it.
    /// </summary>
    private static int TokenCount(JsonElement usage, string name)
    {
        if (!usage.TryGetProperty(name, out var value)
            || value.ValueKind != JsonValueKind.Number
            || !value.TryGetInt32(out var count))
        {
            throw new AnalysisImpossibleException(
                $"the model backend returned a response whose usage.{name} could not be read");
        }

        return count;
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
}
