using Processor.FileFetcher;
using Xunit;

namespace BaseApi.Tests.FileFetcher;

/// <summary>
/// Every row of §6 of the split design, one fact per test. This is the one component in either
/// processor whose whole behaviour is decidable without a file, a broker or a host, so it is
/// specified here rather than through the processor.
/// </summary>
public sealed class ExtensionWhitelistTests
{
    [Fact]
    public void AnAbsentListResolvesToTheWildcard()
    {
        // The stated default AND the stated fallback. The alternative — admit nothing — makes an
        // omitted field fail every file with a message about a list the author never wrote.
        Assert.Equal([ExtensionWhitelist.Wildcard], ExtensionWhitelist.Resolve(null));
    }

    [Fact]
    public void AnEmptyListResolvesToTheWildcard()
    {
        Assert.Equal([ExtensionWhitelist.Wildcard], ExtensionWhitelist.Resolve([]));
    }

    [Fact]
    public void AListIsLeftAloneWhenItHasEntries()
    {
        Assert.Equal([".zip", ".tar"], ExtensionWhitelist.Resolve([".zip", ".tar"]));
    }

    [Fact]
    public void MatchingIsCaseInsensitive()
    {
        Assert.True(ExtensionWhitelist.Admits([".zip"], ".ZIP"));
        Assert.True(ExtensionWhitelist.Admits([".ZIP"], ".zip"));
    }

    [Fact]
    public void AnExtensionOutsideTheListIsRefused()
    {
        Assert.False(ExtensionWhitelist.Admits([".zip", ".tar"], ".pdf"));
    }

    [Fact]
    public void TheWildcardAdmitsEverything()
    {
        Assert.True(ExtensionWhitelist.Admits([ExtensionWhitelist.Wildcard], ".pdf"));
        Assert.True(ExtensionWhitelist.Admits([ExtensionWhitelist.Wildcard], ".zip"));
    }

    [Fact]
    public void TheWildcardMixedWithRealEntriesStillAdmitsEverything()
    {
        // A redundant payload, not a wrong one. Rejecting it would be a rule with no failure
        // behind it.
        Assert.True(ExtensionWhitelist.Admits([".zip", ExtensionWhitelist.Wildcard], ".pdf"));
    }

    [Fact]
    public void AnExtensionlessFileIsAdmittedOnlyUnderTheWildcard()
    {
        // FileInfo.Extension is "" for a file with no dot in its name.
        Assert.True(ExtensionWhitelist.Admits([ExtensionWhitelist.Wildcard], ""));
        Assert.False(ExtensionWhitelist.Admits([".zip"], ""));
    }

    [Theory]
    [InlineData(".zip")]
    [InlineData(".ZIP")]
    [InlineData("*.*")]
    [InlineData(".tar.gz")]
    public void AWellFormedEntryIsAccepted(string entry)
    {
        Assert.Null(ExtensionWhitelist.FirstMalformed([entry]));
    }

    [Theory]
    [InlineData("zip")]
    [InlineData("*.zip")]
    [InlineData("*.z*")]
    [InlineData("*")]
    [InlineData("")]
    [InlineData("  ")]
    [InlineData(".")]
    public void AMalformedEntryIsNamed(string entry)
    {
        // Named, not normalised. The house rule is to report the wrong value rather than quietly
        // correct it, and "*.*" is a single sentinel rather than a glob — so "*.zip" is not a
        // pattern this understands.
        Assert.Equal(entry, ExtensionWhitelist.FirstMalformed([".zip", entry]));
    }

    [Fact]
    public void TheFirstMalformedEntryIsTheOneNamed()
    {
        Assert.Equal("zip", ExtensionWhitelist.FirstMalformed([".tar", "zip", "rar"]));
    }

    [Fact]
    public void ANullEntryIsMalformedAndRendersAsTheLiteralNull()
    {
        // JsonSerializer.Deserialize will happily place a JSON null into this list despite it being
        // declared IReadOnlyList<string> (non-nullable). It must be reported, not throw when
        // FirstMalformed reaches its .Length — and reported as the literal text "null" rather than a
        // C# null, which is this method's own "nothing is malformed" signal.
        Assert.Equal("null", ExtensionWhitelist.FirstMalformed([".zip", null!]));
    }

    [Fact]
    public void DescribeRendersTheListForAnOperator()
    {
        // The rejection names the list so nobody has to go and read the step payload.
        Assert.Equal(".zip, .tar, .csv", ExtensionWhitelist.Describe([".zip", ".tar", ".csv"]));
    }
}
