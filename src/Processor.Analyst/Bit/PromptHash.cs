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
/// prompt; hashing them differently misses the cache on every reformat.
/// </para>
/// </summary>
internal static partial class PromptHash
{
    internal static string Of(string prompt)
    {
        ArgumentNullException.ThrowIfNull(prompt);

        var canonical = Whitespace().Replace(prompt, " ").Trim();

        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonical))).ToLowerInvariant();
    }

    [GeneratedRegex(@"\s+")]
    private static partial Regex Whitespace();
}
