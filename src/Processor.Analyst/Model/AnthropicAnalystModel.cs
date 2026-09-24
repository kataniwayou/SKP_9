using System.Text.Json;
using Anthropic;
using Anthropic.Exceptions;
using Anthropic.Models.Messages;
using Microsoft.Extensions.Options;
using Processor.Analyst.Loop;

namespace Processor.Analyst.Model;

/// <summary>
/// The hosted-Anthropic implementation of <see cref="IAnalystModel"/>. Everything Anthropic-specific
/// — the SDK's own types, its tool-use wire shapes, its exception hierarchy — stays inside this file.
/// Nothing above <see cref="IAnalystModel"/> may see an Anthropic type.
/// </summary>
internal sealed class AnthropicAnalystModel : IAnalystModel
{
    // Compiled constants, not configuration: see AnalystModelOptions for why. Changing either
    // requires a rebuild, which restarts the pod, which clears the BIT cache.
    private const string ModelId = "claude-opus-5";
    private const int MaxTokens = 16000;

    private readonly Lazy<AnthropicClient> _client;

    public AnthropicAnalystModel(IOptions<AnalystModelOptions> options)
    {
        ArgumentNullException.ThrowIfNull(options);

        var opts = options.Value;

        // Lazy, not built here: this constructor runs during DI's ValidateOnBuild and at pod boot,
        // and the seam's design is that a bad or missing credential surfaces as a per-dispatch
        // Failed step (a 401 on the first call, translated below), never as a boot-time crash. That
        // must stay true regardless of what a future SDK version's constructor happens to validate
        // eagerly -- so nothing here does I/O or SDK construction until the first SendAsync.
        _client = new Lazy<AnthropicClient>(() =>
            // ApiKey and BaseUrl are init-only. The parameterless constructor already resolves
            // ApiKey from ANTHROPIC_API_KEY and BaseUrl from the SDK's own default -- explicitly
            // assigning either property to null in an object initializer clears that resolved value
            // rather than leaving it alone, so a property is only ever listed here when the option
            // actually has a value.
            (opts.ApiKey, opts.BaseUrl) switch
            {
                ({ Length: > 0 } key, { Length: > 0 } url) => new AnthropicClient { ApiKey = key, BaseUrl = url },
                ({ Length: > 0 } key, _) => new AnthropicClient { ApiKey = key },
                (_, { Length: > 0 } url) => new AnthropicClient { BaseUrl = url },
                _ => new AnthropicClient(),
            });
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

        // No `Thinking` parameter: thinking is on by default on this model, and explicitly disabling
        // it is a known trap -- the model occasionally writes a tool call into visible text instead
        // of a tool_use block, nothing errors, and in this loop that is a panel the agent believes it
        // read.
        var parameters = new MessageCreateParams
        {
            Model = ModelId,
            MaxTokens = MaxTokens,
            System = system,
            Messages = [.. transcript.Select(ToMessage)],
            Tools = [.. tools.Select(spec => (ToolUnion)ToTool(spec))],
        };

        Message response;
        try
        {
            response = await _client.Value.Messages.Create(parameters, ct).ConfigureAwait(false);
        }
        // Most-specific-first: every branch below reaches the same conclusion -- the analysis could
        // not run -- so the ordering exists to document intent, not to vary the handling.
        catch (AnthropicIOException ex)
        {
            // The connection itself failed: DNS, TCP, TLS, or the request never got a response.
            throw new AnalysisImpossibleException("the model backend could not be reached", ex);
        }
        catch (AnthropicApiException ex)
        {
            // The backend was reached and answered with an HTTP-level failure (auth, rate limit,
            // 5xx, ...). Still "could not run": the loop has no way to make progress from here.
            throw new AnalysisImpossibleException($"the model backend returned an error: {ex.Message}", ex);
        }
        catch (AnthropicException ex)
        {
            // Any other typed SDK failure (a malformed SSE stream, a response the client could not
            // parse, ...). Still not a programming error in this adapter.
            throw new AnalysisImpossibleException("the model backend failed", ex);
        }
        catch (TaskCanceledException ex) when (!ct.IsCancellationRequested)
        {
            // The SDK's own request timeout, not our caller's cancellation -- that case is left to
            // propagate untouched so the loop's own cancellation handling still sees it as such.
            throw new AnalysisImpossibleException("the model backend timed out", ex);
        }

        return ToReply(
            response.Content,
            checked((int)response.Usage.InputTokens),
            checked((int)response.Usage.OutputTokens));
    }

    /// <summary>Translates one tool of the loop's catalog into the SDK's tool-definition shape.</summary>
    internal static Tool ToTool(ToolSpec spec)
    {
        ArgumentNullException.ThrowIfNull(spec);

        using var schemaDoc = JsonDocument.Parse(spec.InputSchemaJson);
        var root = schemaDoc.RootElement;

        Dictionary<string, JsonElement>? properties = null;
        if (root.TryGetProperty("properties", out var propertiesElement))
        {
            properties = [];
            foreach (var property in propertiesElement.EnumerateObject())
            {
                properties[property.Name] = property.Value.Clone();
            }
        }

        List<string>? required = null;
        if (root.TryGetProperty("required", out var requiredElement))
        {
            required = [.. requiredElement.EnumerateArray().Select(e => e.GetString()!)];
        }

        // F7: every schema in ToolCatalog.SchemaFor declares "additionalProperties":false at the
        // root, but Anthropic.Models.Messages.InputSchema -- confirmed by reflection: its only
        // members are Type, Properties, Required, RawData -- has no field for it, so this root
        // keyword is dropped when copying into the SDK's tool-definition shape. `Strict = true`
        // below therefore enforces, server-side, something looser than this comment used to claim:
        // an object with the declared Properties and Required, but NOT closed against extra ones.
        // This is not an actual hole -- InvestigationLoop.Validates re-validates every tool input
        // against the FULL schema (including additionalProperties:false) client-side, on every
        // call, on both adapters, so a model that slipped an extra property past the server's
        // laxer enforcement would still be caught here before the input is ever used.
        return new Tool
        {
            Name = spec.Name,
            Description = spec.Description,
            // Type is auto-set by the SDK; setting it ourselves is unnecessary and not exposed as a
            // meaningful choice here (the schema is always an object).
            InputSchema = new InputSchema { Properties = properties, Required = required },
            // strict: true is a top-level field on the tool definition, not on tool_choice. The loop
            // still validates every input client-side regardless (see InvestigationLoop.Validates) --
            // the on-prem adapter has no server-side enforcement, and the two paths must not diverge
            // in strictness. See the comment above: `Strict` currently enforces less than
            // additionalProperties:false would ask for, because InputSchema cannot carry that
            // keyword -- the client-side validation is what actually closes that gap.
            Strict = true,
        };
    }

    /// <summary>
    /// Translates one turn of the loop's transcript into the SDK's message shape. There is no
    /// <c>.ToParam()</c> helper on the SDK's response content blocks, so an assistant turn is
    /// reconstructed block by block rather than echoed back.
    /// </summary>
    internal static MessageParam ToMessage(ModelTurn turn)
    {
        ArgumentNullException.ThrowIfNull(turn);

        List<ContentBlockParam> blocks = [];

        if (turn.Role == ModelRole.User)
        {
            // All tool results for one assistant turn belong in a single user turn -- the API
            // rejects a follow-up in which any tool_use id lacks a matching tool_result, and
            // splitting results across messages trains the model out of parallel calls.
            foreach (var result in turn.ToolResults)
            {
                blocks.Add(new ToolResultBlockParam
                {
                    ToolUseID = result.CallId,
                    Content = result.Content,
                    IsError = result.IsError,
                });
            }

            if (turn.Text is { Length: > 0 } userText)
            {
                blocks.Add(new TextBlockParam { Text = userText });
            }

            return new MessageParam { Role = Role.User, Content = blocks };
        }

        // An assistant turn this adapter produced goes back EXACTLY as it arrived. Reconstructing one
        // drops its signed thinking blocks, and the API rejects a tool-use turn that comes back
        // without them -- so every investigation would fail on its second model call. Only a turn from
        // somewhere else (the on-prem adapter, a hand-built transcript) falls through to the
        // reconstruction below.
        if (turn.ToolCalls.Select(call => call.ProviderEcho).OfType<List<ContentBlockParam>>().FirstOrDefault()
            is { } echo)
        {
            return new MessageParam { Role = Role.Assistant, Content = echo };
        }

        if (turn.Text is { Length: > 0 } assistantText)
        {
            blocks.Add(new TextBlockParam { Text = assistantText });
        }

        foreach (var call in turn.ToolCalls)
        {
            blocks.Add(new ToolUseBlockParam
            {
                ID = call.CallId,
                Name = call.ToolName,
                Input = ToInputDictionary(call.Input),
            });
        }

        return new MessageParam { Role = Role.Assistant, Content = blocks };
    }

    /// <summary>The number of content blocks a translated message carries. Test-only introspection.</summary>
    internal static int BlockCount(MessageParam message)
    {
        ArgumentNullException.ThrowIfNull(message);
        return message.Content.TryPickContentBlockParams(out var blocks) ? blocks.Count : 0;
    }

    /// <summary>
    /// Rebuilds one assistant turn's content as the parameter shapes the API expects back, in the
    /// order it arrived, so the turn can be replayed <b>verbatim</b> instead of reconstructed.
    /// <para>
    /// Thinking blocks are the reason this exists. They are signed, and the API requires an assistant
    /// turn carrying <c>tool_use</c> to come back with them intact — a turn rebuilt from text plus
    /// tool_use alone is rejected, which fails every multi-turn investigation on its second model call
    /// (the first one that replays a turn). Thinking is on by default on <c>claude-opus-5</c> and
    /// <c>display</c> defaults to <c>"omitted"</c>, so the blocks arrive with an EMPTY body and a
    /// signature that still has to survive: replay them exactly as received, empty text included.
    /// </para>
    /// <para>
    /// This does not give the loop a notion of thinking. The list is handed across the seam as an
    /// opaque <see cref="ModelToolCall.ProviderEcho"/> that only this adapter ever opens.
    /// </para>
    /// </summary>
    internal static List<ContentBlockParam> AssistantEcho(IReadOnlyList<ContentBlock> content)
    {
        ArgumentNullException.ThrowIfNull(content);

        List<ContentBlockParam> blocks = [];

        foreach (var block in content)
        {
            if (block.TryPickThinking(out var thinking))
            {
                // The signature is what the API validates; it must be passed through untouched.
                blocks.Add(new ThinkingBlockParam
                {
                    Thinking = thinking.Thinking,
                    Signature = thinking.Signature,
                });
            }
            else if (block.TryPickRedactedThinking(out var redacted))
            {
                blocks.Add(new RedactedThinkingBlockParam { Data = redacted.Data });
            }
            else if (block.TryPickText(out var textBlock))
            {
                blocks.Add(new TextBlockParam { Text = textBlock.Text });
            }
            else if (block.TryPickToolUse(out var toolUse))
            {
                // ToolUseBlock.Caller is required on the response type but optional on the param type,
                // and is not ours to assert -- it is deliberately not copied.
                blocks.Add(new ToolUseBlockParam
                {
                    ID = toolUse.ID,
                    Name = toolUse.Name,
                    Input = toolUse.Input,
                });
            }
        }

        return blocks;
    }

    /// <summary>
    /// Translates one response into the loop's reply shape. Takes the content and usage rather than a
    /// <c>Message</c> so the translation is reachable from a test without standing up a whole SDK
    /// response object.
    /// </summary>
    internal static ModelReply ToReply(IReadOnlyList<ContentBlock> content, int inputTokens, int outputTokens)
    {
        ArgumentNullException.ThrowIfNull(content);

        // Built once and shared by every call in the turn: the loop copies ModelReply.ToolCalls into
        // the transcript unchanged and copies nothing else out of a reply, so a tool call is the only
        // vehicle this can ride. A reply with no tool calls has no carrier and needs none -- the loop
        // rejects that reply outright, so such a turn is never replayed.
        var echo = AssistantEcho(content);

        List<ModelToolCall> calls = [];
        string? text = null;

        foreach (var block in content)
        {
            if (block.TryPickToolUse(out var toolUse))
            {
                calls.Add(new ModelToolCall(
                    toolUse.ID,
                    toolUse.Name,
                    JsonSerializer.SerializeToElement(toolUse.Input))
                {
                    ProviderEcho = echo,
                });
            }
            else if (block.TryPickText(out var textBlock))
            {
                text = text is null ? textBlock.Text : text + textBlock.Text;
            }
            // Thinking blocks are deliberately absent from ModelReply: the loop has no notion of
            // "thinking" and must not gain one. They travel in the opaque echo above instead, which
            // is what lets the turn be replayed intact without the loop ever seeing inside it.
        }

        return new ModelReply(calls, text, inputTokens, outputTokens);
    }

    private static Dictionary<string, JsonElement> ToInputDictionary(JsonElement input)
    {
        Dictionary<string, JsonElement> dict = [];

        if (input.ValueKind == JsonValueKind.Object)
        {
            foreach (var property in input.EnumerateObject())
            {
                dict[property.Name] = property.Value.Clone();
            }
        }

        return dict;
    }
}
