using System.Security.Cryptography;
using System.Text;

namespace Messaging.Contracts;

/// <summary>
/// Name-based UUIDs, version 5 (RFC 9562 §5.5): SHA-1 over a namespace id and a name, so the same
/// inputs give the same id on every host and every run. .NET 8 has none built in.
/// <para>
/// <b>SHA-1 is not used for security here.</b> It is the hash the RFC fixes for version 5; nothing
/// relies on the id being hard to forge, only on it being stable and well spread.
/// </para>
/// </summary>
public static class Uuid5
{
    public static Guid Create(Guid namespaceId, string name)
    {
        ArgumentNullException.ThrowIfNull(name);

        var nameBytes = Encoding.UTF8.GetBytes(name);
        var input = new byte[16 + nameBytes.Length];

        // Big-endian, as the RFC lays a UUID out. Guid.ToByteArray() would swap the first three
        // fields and give a stable id that no other implementation agrees with.
        namespaceId.TryWriteBytes(input.AsSpan(0, 16), bigEndian: true, out _);
        nameBytes.CopyTo(input, 16);

        Span<byte> hash = stackalloc byte[20];
        SHA1.HashData(input, hash);

        hash[6] = (byte)((hash[6] & 0x0F) | 0x50);   // version 5
        hash[8] = (byte)((hash[8] & 0x3F) | 0x80);   // RFC variant

        return new Guid(hash[..16], bigEndian: true);
    }
}
