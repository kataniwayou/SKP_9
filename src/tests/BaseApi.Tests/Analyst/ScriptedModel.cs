using System.Text.Json;
using Processor.Analyst.Model;

namespace BaseApi.Tests.Analyst;

/// <summary>
/// A model that says exactly what the test told it to, in order, and throws if asked for more.
/// <para>
/// Running past the script is how a non-terminating loop announces itself. Returning a default reply
/// instead would let a budget bug read as a pass.
/// </para>
/// </summary>
internal sealed class ScriptedModel(params ModelReply[] script) : IAnalystModel
{
    private readonly Queue<ModelReply> _remaining = new(script);

    internal List<(string System, IReadOnlyList<ModelTurn> Transcript, IReadOnlyList<ToolSpec> Tools)> Received { get; } = [];

    public Task<ModelReply> SendAsync(
        string system, IReadOnlyList<ModelTurn> transcript, IReadOnlyList<ToolSpec> tools, CancellationToken ct)
    {
        // Snapshot, not a reference: the loop mutates the same List<ModelTurn> across every call, so
        // storing the reference would make every entry in Received alias the final transcript once
        // the run completes, silently defeating any assertion on Received[i] that expects a mid-run
        // snapshot (Tasks 10 and 12 are exactly the callers who will want that).
        Received.Add((system, [.. transcript], tools));

        if (_remaining.Count == 0)
        {
            throw new InvalidOperationException(
                $"the loop asked for turn {Received.Count} but the script has {script.Length}");
        }

        return Task.FromResult(_remaining.Dequeue());
    }

    /// <summary>Builds a tool call whose input is the JSON of the given object.</summary>
    internal static ModelToolCall Call(string toolName, object input)
        => new(
            CallId: $"call_{Guid.NewGuid():N}",
            ToolName: toolName,
            Input: JsonSerializer.SerializeToElement(input));
}
