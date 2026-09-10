namespace Processor.FileFetcher;

/// <summary>
/// The admitted extensions, and the four questions anyone asks of them: what the list is when the
/// payload named none, whether every entry is well formed, whether a given extension is admitted,
/// and how to render the list to an operator.
/// <para>
/// <b>Static and file-scoped because it holds no state and touches nothing.</b> It is the only part
/// of this processor decidable without a file, a broker or a host, which is what lets §6 of the
/// design be specified exhaustively in unit tests rather than through the processor.
/// </para>
/// </summary>
internal static class ExtensionWhitelist
{
    /// <summary>
    /// The one sentinel, and it is NOT a glob.
    /// <para>
    /// No other <c>*</c> pattern is recognised: <c>*.zip</c> and <c>*.z*</c> are malformed payloads,
    /// not narrower wildcards. Admitting one pattern would put this processor in the business of
    /// implementing glob semantics, and every half-implemented glob differs from every other.
    /// </para>
    /// </summary>
    public const string Wildcard = "*.*";

    /// <summary>
    /// The effective list. <b>Absent, null or empty means <see cref="Wildcard"/></b> — the stated
    /// default and the stated fallback both.
    /// <para>
    /// This is the one place in either processor where an absent value WIDENS rather than narrows,
    /// and it is deliberate. The alternative default — admit nothing — makes an omitted field fail
    /// every file with a message about a list the author never wrote.
    /// </para>
    /// </summary>
    public static IReadOnlyList<string> Resolve(IReadOnlyList<string>? configured)
        => configured is { Count: > 0 } ? configured : [Wildcard];

    /// <summary>
    /// The first entry that is neither <see cref="Wildcard"/> nor a leading-dot extension, or null
    /// when every entry is well formed.
    /// <para>
    /// It returns the offending entry rather than a bool so the rejection can quote it. An author
    /// who wrote <c>"zip"</c> needs to see <c>"zip"</c>, not a count.
    /// </para>
    /// </summary>
    public static string? FirstMalformed(IReadOnlyList<string> whitelist)
    {
        foreach (var entry in whitelist)
        {
            if (!IsWellFormed(entry))
            {
                return entry;
            }
        }

        return null;
    }

    /// <summary>
    /// True when this extension is admitted. <paramref name="extension"/> is
    /// <c>FileInfo.Extension</c> — a leading dot, or the empty string for a name with no dot in it.
    /// <para>
    /// <b>The wildcard short-circuits from anywhere in the list.</b> <c>[".zip", "*.*"]</c> is a
    /// redundant payload, not a wrong one, and rejecting it would be a rule with no failure behind
    /// it.
    /// </para>
    /// <para>
    /// <b>An extensionless file is admitted only under the wildcard</b>, and that falls out rather
    /// than being cased: <c>""</c> is not well formed, so it can never be an entry to match against.
    /// </para>
    /// </summary>
    public static bool Admits(IReadOnlyList<string> whitelist, string extension)
    {
        foreach (var entry in whitelist)
        {
            if (entry == Wildcard
                || entry.Equals(extension, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>The list as an operator reads it, for the rejection message.</summary>
    public static string Describe(IReadOnlyList<string> whitelist) => string.Join(", ", whitelist);

    private static bool IsWellFormed(string entry)
        => entry == Wildcard || (entry.Length > 1 && entry.StartsWith('.'));
}
