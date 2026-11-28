namespace BaseProcessor.Core.Processing;

/// <summary>
/// The one rule the framework applies to an author's verdict: it must be a member its enum defines.
/// <para>
/// A cast number (<c>(ArtistVerdict)7</c>) or a <c>[Flags]</c> combination is not, and would be
/// written as <c>7</c> or <c>Listed, Unlisted</c> — a part of its own on every board that stacks by
/// verdict. Nothing else about a verdict is checked: the framework does not know what any value means.
/// </para>
/// </summary>
internal static class VerdictValues
{
    public static bool IsDefined(Enum verdict) => Enum.IsDefined(verdict.GetType(), verdict);
}
