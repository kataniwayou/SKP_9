using System.Text.Json;

namespace BaseApi.Service.Features.Workflow.Graph;

/// <summary>
/// The one rule the server applies to a canvas layout. Everything else about it belongs to the
/// editor: the server never reads inside it, so a layout naming a step that no longer exists is not
/// an error here -- the editor ignores stale ids on load.
/// </summary>
internal static class WorkflowLayout
{
    /// <summary>The same cap as an assignment payload, roughly 1 MB.</summary>
    internal const int MaxChars = 1_048_576;

    /// <summary>Returns why the layout is unacceptable, or null when it is fine.</summary>
    internal static string? Validate(JsonElement layout)
    {
        if (layout.ValueKind != JsonValueKind.Object)
            return "Layout must be a JSON object.";

        if (layout.GetRawText().Length > MaxChars)
            return $"Layout must be at most {MaxChars} characters.";

        return null;
    }
}
