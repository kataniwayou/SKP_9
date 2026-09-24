using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace Processor.Analyst.Bit;

/// <summary>
/// The one value that identifies a prompt — the BIT's cache key and the finding's provenance stamp.
/// <para>
/// <b>Only the prompt goes in.</b> The BIT tests the prompt against a hardcoded scenario, window,
/// target and budget, so no payload variable participates and none belongs in the key. The target
/// workflow id and the window change on every dispatch; including them would mean the cache never
/// hits and the BIT ran every time, silently.
/// </para>
/// <para>
/// <b>Canonicalize first.</b> Two prompts that differ only in line endings or wrapping are the same
/// prompt; hashing them differently misses the cache on every reformat. But a paragraph break is not
/// mere wrapping: the most plausible fix for a MALFORMED verdict is splitting two stage descriptions
/// that ran together into their own paragraphs, so the presence of a paragraph break is treated as
/// content, not formatting — otherwise the corrected prompt would hash identically to the broken one
/// and the cache would keep serving the stale unfit verdict.
/// </para>
/// </summary>
internal static partial class PromptHash
{
    internal static string Of(string prompt)
    {
        ArgumentNullException.ThrowIfNull(prompt);

        var canonical = Canonicalize(prompt);

        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonical))).ToLowerInvariant();
    }

    /// <summary>
    /// Collapses intra-line whitespace and single line breaks to one space per paragraph — reflowing
    /// a paragraph must hash the same as before it was reflowed — but keeps the boundary between
    /// paragraphs (one or more blank lines) as a distinct, hash-relevant token.
    /// </summary>
    private static string Canonicalize(string prompt)
    {
        var normalized = prompt.Replace("\r\n", "\n").Replace('\r', '\n');

        var paragraphs = ParagraphBreak()
            .Split(normalized)
            .Select(p => Whitespace().Replace(p, " ").Trim())
            .Where(p => p.Length > 0);

        return string.Join("\n\n", paragraphs);
    }

    [GeneratedRegex(@"\s+")]
    private static partial Regex Whitespace();

    /// <summary>A blank line: two line breaks with only horizontal whitespace, or nothing, between them.</summary>
    [GeneratedRegex(@"\n\s*\n")]
    private static partial Regex ParagraphBreak();
}
