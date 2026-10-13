using Messaging.Contracts;
using Xunit;

namespace BaseApi.Tests.Messaging;

public sealed class Uuid5Tests
{
    /// <summary>The RFC's DNS namespace, so the vector below can be checked against any implementation.</summary>
    private static readonly Guid Dns = Guid.Parse("6ba7b810-9dad-11d1-80b4-00c04fd430c8");

    [Fact]
    public void MatchesThePublishedVector()
    {
        // Python: uuid.uuid5(uuid.NAMESPACE_DNS, "python.org"). Pins the byte order: .NET's Guid
        // layout is little-endian in its first three fields and RFC 9562 is big-endian throughout,
        // so an implementation that forgot to swap would still be deterministic — and wrong.
        Assert.Equal(Guid.Parse("886313e1-3b8a-5372-9b90-0c9aee199e5d"), Uuid5.Create(Dns, "python.org"));
    }

    [Fact]
    public void IsStableAndCarriesVersionFiveAndTheRfcVariant()
    {
        var a = Uuid5.Create(Dns, "skp");
        var text = a.ToString("D");

        Assert.Equal(a, Uuid5.Create(Dns, "skp"));
        Assert.Equal('5', text[14]);
        Assert.Contains(text[19].ToString(), "89ab", StringComparison.Ordinal);
    }

    [Fact]
    public void DifferentNamesGiveDifferentIds()
        => Assert.NotEqual(Uuid5.Create(Dns, "a"), Uuid5.Create(Dns, "b"));
}
