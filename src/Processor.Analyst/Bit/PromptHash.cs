using System.Security.Cryptography;
using System.Text;

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
/// <b>The prompt string exactly as it arrives, byte for byte.</b> No canonicalization: any edit,
/// whitespace included, is a different prompt and a fresh judgement. A reformat that changes
/// nothing re-pays the gate once, which is the price of a key nobody has to reason about.
/// </para>
/// </summary>
internal static class PromptHash
{
    internal static string Of(string prompt)
    {
        ArgumentNullException.ThrowIfNull(prompt);

        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(prompt))).ToLowerInvariant();
    }
}
