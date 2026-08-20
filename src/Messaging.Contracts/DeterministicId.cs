using System.Security.Cryptography;
using System.Text;

namespace Messaging.Contracts;

/// <summary>
/// Ids derived from what a message already carries, rather than minted at random.
/// <para>
/// <b>This is what makes a replay a repeat instead of a fork.</b> A dispatch whose handling fails
/// after some branches have been sent is returned to the queue and run again from the top. Random ids
/// would make each replayed branch a new branch with a new L2 key, and a partial fan-out failure — an
/// ordinary transient — would multiply the workflow. Derived ids make the replay land on the keys it
/// landed on before, so the writes are rewrites and the orchestrator can recognise the duplicates.
/// </para>
/// <para>
/// <b>The seed must be stable and unique per branch.</b> Correlation id and step id identify the hop;
/// entry id distinguishes hops within a step for a downstream dispatch and is
/// <see cref="Guid.Empty"/> for a source step, where the per-fire correlation id carries the
/// uniqueness instead. The sequence number distinguishes branches within one invocation, which is why
/// an author's fan-out must produce the same branches in the same order every time.
/// </para>
/// <para>
/// Version 5 layout, so these are recognisable as name-derived rather than random to anyone reading a
/// database or a log. The technique is already used in this codebase's Keeper partition keys.
/// </para>
/// </summary>
public static class DeterministicId
{
    /// <summary>Purpose for the id that keys the output blob and identifies the delivery.</summary>
    public const string MessagePurpose = "message";

    /// <summary>Purpose for the id that opens a new execution lineage.</summary>
    public const string ExecutionPurpose = "execution";

    /// <summary>
    /// Derives one id. <paramref name="purpose"/> separates ids built from the same seed — without it
    /// a branch's execution id and its message id would be the same value.
    /// </summary>
    public static Guid From(string purpose, Guid correlationId, Guid stepId, Guid entryId, int sequence)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(purpose);
        ArgumentOutOfRangeException.ThrowIfNegative(sequence);

        // A fixed separator that cannot appear in a Guid's "D" form or in a decimal integer, so two
        // different seeds cannot render to one canonical string.
        var canonical =
            $"{purpose}|{correlationId:D}|{stepId:D}|{entryId:D}|{sequence.ToString(System.Globalization.CultureInfo.InvariantCulture)}";

        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(canonical));

        var bytes = new byte[16];
        Array.Copy(hash, bytes, 16);

        // RFC 4122 version 5 and variant 10x. .NET's Guid(byte[]) reads the first three fields
        // little-endian, so the version nibble is byte 7 and the variant bits are byte 8.
        bytes[7] = (byte)((bytes[7] & 0x0F) | 0x50);
        bytes[8] = (byte)((bytes[8] & 0x3F) | 0x80);

        return new Guid(bytes);
    }
}
