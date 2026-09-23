using BaseProcessor.Core.Processing;

namespace Processor.SKNormalizer;

/// <summary>
/// The whitelist handed to a dispatch whose step payload named no <c>cacheRoot</c>. Every lookup is a
/// payload defect.
/// <para>
/// <b>It fails rather than admitting or refusing, and that is the whole design.</b> Refusing every
/// field would cancel every document of a step whose root was merely forgotten, and in the logs
/// that reads exactly like a correctly-configured empty whitelist — the one outcome nothing
/// downstream can tell apart. Admitting every field would silently disable the gate a step asked
/// for. Failing says which of the three actually happened.
/// </para>
/// <para>
/// <b>It fails on use, not on construction, and that is why the other handlers still work.</b>
/// Sample and AlphaBeta never consult a whitelist, so their steps carry no root and must keep
/// running; only a handler that reaches for the list discovers the root is missing. Checking in
/// the processor instead would refuse those steps for a field they do not have.
/// </para>
/// </summary>
internal sealed class UnconfiguredFieldWhitelist : IFieldWhitelist
{
    public bool TryGet(string field, out string? value)
        => throw new FailedException(
            "step payload rejected: this handler gates a field on a whitelist, but the payload names "
            + "no cacheRoot. Bind a cache to the workflow and put that cache's root on the step "
            + "payload — the root alone, not an address: the workflow id half is composed from the "
            + "dispatch.");
}
