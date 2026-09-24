namespace Processor.Analyst.Loop;

/// <summary>
/// Shared whitespace normalisation for matching free-text identifiers the model may retype with
/// incidental formatting differences -- a hypothesis name repeated across record_plan,
/// record_verification and finding.ruledOut, or a disconfirming criterion copied from record_plan
/// into finding.ruledOut.
/// <para>
/// Trims and collapses internal whitespace, nothing else. Deliberately NOT case-folded: two
/// hypothesis names or criteria differing only in capitalisation are plausibly different claims,
/// while two differing only in whitespace are the same claim typed twice.
/// </para>
/// <para>
/// <b>For matching only.</b> Callers use the normalised form as a lookup key, but keep the original,
/// unnormalised text in problem messages -- a message that echoes exactly what is in the payload is
/// far easier to debug than one echoing a normalised form the operator will not find there.
/// </para>
/// </summary>
internal static class TextNormalization
{
    internal static string Whitespace(string value)
        => string.Join(' ', value.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
}
