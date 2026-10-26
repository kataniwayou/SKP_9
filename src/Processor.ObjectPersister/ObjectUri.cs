using System.Text;

namespace Processor.ObjectPersister;

/// <summary>
/// An <c>s3://bucket/key</c> location, parsed by hand.
/// <para>
/// <b>Not <see cref="Uri"/>, because it would address a different object.</b> <c>Uri</c> lower-cases
/// the host, percent-decodes the path and treats <c>?</c> and <c>#</c> as query and fragment; all
/// three are legal, meaningful characters in an S3 key. The key here is everything after the first
/// <c>/</c>, verbatim.
/// </para>
/// <para>
/// <b>Self-contained on purpose.</b> ObjectPersister carries its own copy of this file (separate
/// assemblies do not reference each other), and one test table pins both.
/// </para>
/// </summary>
internal sealed record ObjectUri(string Bucket, string Key)
{
    private const string Scheme = "s3://";

    /// <summary>S3's limit on a key, in UTF-8 bytes rather than characters.</summary>
    private const int MaxKeyBytes = 1024;

    public override string ToString() => $"{Scheme}{Bucket}/{Key}";

    /// <summary>
    /// <paramref name="keyIsPrefix"/> false is an object key: non-empty, not ending in <c>/</c>.
    /// True is a destination prefix: it may be empty, and a non-empty one gains a trailing
    /// <c>/</c> so <c>acme</c> and <c>acme/</c> are the same instruction.
    /// </summary>
    /// <param name="reason">The operator-facing sentence on failure, quoting the bucket when the
    /// bucket is the fault.</param>
    internal static bool TryParse(string? text, bool keyIsPrefix, out ObjectUri? uri, out string? reason)
    {
        uri = null;
        reason = null;

        if (text is null || !text.StartsWith(Scheme, StringComparison.OrdinalIgnoreCase))
        {
            reason = $"'{text}' is not an s3:// location.";
            return false;
        }

        var rest = text[Scheme.Length..];
        var slash = rest.IndexOf('/');
        var bucket = slash < 0 ? rest : rest[..slash];
        var key = slash < 0 ? "" : rest[(slash + 1)..];

        if (!IsValidBucket(bucket))
        {
            reason = $"The bucket '{bucket}' is not a valid S3 bucket name (3-63 characters: lower-case "
                   + "letters, digits, '.' and '-', starting and ending with a letter or digit).";
            return false;
        }

        if (Encoding.UTF8.GetByteCount(key) > MaxKeyBytes)
        {
            reason = $"The key is longer than S3's limit of {MaxKeyBytes} bytes.";
            return false;
        }

        if (!keyIsPrefix)
        {
            if (key.Length == 0)
            {
                reason = $"'{text}' names no object, only a bucket.";
                return false;
            }

            if (key.EndsWith('/'))
            {
                reason = $"'{text}' names a folder, not an object.";
                return false;
            }
        }
        else if (key.Length > 0 && !key.EndsWith('/'))
        {
            key += "/";
        }

        uri = new ObjectUri(bucket, key);
        return true;
    }

    private static bool IsValidBucket(string bucket)
    {
        if (bucket.Length is < 3 or > 63)
        {
            return false;
        }

        foreach (var c in bucket)
        {
            if (!(c is >= 'a' and <= 'z' or >= '0' and <= '9' or '.' or '-'))
            {
                return false;
            }
        }

        return char.IsAsciiLetterOrDigit(bucket[0]) && char.IsAsciiLetterOrDigit(bucket[^1]);
    }
}
