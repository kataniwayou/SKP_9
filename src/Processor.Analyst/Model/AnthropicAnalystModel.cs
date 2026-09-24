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

        return ToReply(response);
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

    private static ModelReply ToReply(Message response)
    {
        List<ModelToolCall> calls = [];
        string? text = null;

        foreach (var block in response.Content)
        {
            if (block.TryPickToolUse(out var toolUse))
            {
                calls.Add(new ModelToolCall(
                    toolUse.ID,
                    toolUse.Name,
                    JsonSerializer.SerializeToElement(toolUse.Input)));
            }
            else if (block.TryPickText(out var textBlock))
            {
                text = text is null ? textBlock.Text : text + textBlock.Text;
            }
            // TryPickThinking blocks are intentionally not translated: the loop above this seam has
            // no notion of "thinking" and must not gain one through a side channel.
        }

        return new ModelReply(
            calls,
            text,
            checked((int)response.Usage.InputTokens),
            checked((int)response.Usage.OutputTokens));
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
