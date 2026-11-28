namespace Processor.SKNormalizer;

/// <summary>
/// Why an Acme step ended the way it did, as far as the artist whitelist decided it. Written by the
/// framework on the step's outcome record as <c>attributes.Verdict</c> (with
/// <c>attributes.VerdictKind</c> = <c>ArtistVerdict</c>), so the operator board can stack the step's
/// outcomes by reason.
/// <para>
/// <b>One verdict per outcome, not per lookup.</b> The per-lookup record is
/// <see cref="RedisFieldWhitelist"/>'s own <c>WhitelistVerdict</c> check log, which says which list
/// answered for which value. This says why the document completed or was cancelled.
/// </para>
/// <para>
/// <b>Names are history.</b> They are written by name into the log store; renaming or removing one
/// splits every board that stacks by it. Add members, never rename them.
/// </para>
/// </summary>
public enum ArtistVerdict
{
    /// <summary>Every artist in the document is on the whitelist; the step completed.</summary>
    Listed,

    /// <summary>An artist is not on the whitelist; the step was cancelled.</summary>
    Unlisted,
}
