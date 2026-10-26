using Xunit;
using Fetcher = Processor.ObjectFetcher;

namespace BaseApi.Tests.ObjectStorage;

/// <summary>
/// The table of <c>s3://</c> cases, written once and run against every copy of the parser. The
/// copies live in separate assemblies that must not reference each other, so a second parser is
/// added by overriding <see cref="Parse"/> in another subclass, not by sharing code.
/// </summary>
public abstract class ObjectUriContract
{
    /// <summary>The parser under test, flattened to what the table asserts.</summary>
    protected abstract (bool Ok, string? Bucket, string? Key, string? Reason) Parse(string text, bool prefix);

    [Theory]
    [InlineData("s3://skp-in/feeds/a.zip", false, "skp-in", "feeds/a.zip", null)]
    [InlineData("S3://skp-in/a.zip", false, "skp-in", "a.zip", null)]
    [InlineData("s3://skp-in/a b+c%20ü.zip", false, "skp-in", "a b+c%20ü.zip", null)]
    [InlineData("s3://skp-in/q?x=1#f", false, "skp-in", "q?x=1#f", null)]
    [InlineData("s3://skp-in/", false, null, null, "names no object")]
    [InlineData("s3://skp-in/dir/", false, null, null, "names a folder")]
    [InlineData("s3://Skp-In/a.zip", false, null, null, "'Skp-In'")]
    [InlineData("s3://ab/a.zip", false, null, null, "'ab'")]
    [InlineData("s3://-bad/a.zip", false, null, null, "'-bad'")]
    [InlineData("/mnt/skp-files/in/a.zip", false, null, null, "not an s3:// location")]
    [InlineData("s3://skp-out", true, "skp-out", "", null)]
    [InlineData("s3://skp-out/", true, "skp-out", "", null)]
    [InlineData("s3://skp-out/acme", true, "skp-out", "acme/", null)]
    [InlineData("s3://skp-out/acme/", true, "skp-out", "acme/", null)]
    public void Parses(string text, bool prefix, string? bucket, string? key, string? reasonFragment)
    {
        var (ok, gotBucket, gotKey, reason) = Parse(text, prefix);

        if (reasonFragment is null)
        {
            Assert.True(ok, reason);
            Assert.Equal(bucket, gotBucket);
            Assert.Equal(key, gotKey);
        }
        else
        {
            Assert.False(ok);
            Assert.Contains(reasonFragment, reason);
        }
    }

    [Fact]
    public void A_key_over_1024_bytes_is_refused()
    {
        var (ok, _, _, reason) = Parse("s3://skp-in/" + new string('a', 1025), false);

        Assert.False(ok);
        Assert.Contains("1024", reason);
    }

    [Fact]
    public void The_key_limit_counts_utf8_bytes_not_characters()
    {
        // 600 two-byte characters: 600 chars, 1200 bytes.
        var (ok, _, _, reason) = Parse("s3://skp-in/" + new string('ü', 600), false);

        Assert.False(ok);
        Assert.Contains("1024", reason);
    }

    [Fact]
    public void A_key_of_exactly_1024_bytes_is_accepted()
    {
        var (ok, _, key, _) = Parse("s3://skp-in/" + new string('a', 1024), false);

        Assert.True(ok);
        Assert.Equal(1024, key!.Length);
    }

    [Fact]
    public void Blank_text_is_not_an_s3_location()
    {
        Assert.False(Parse("", false).Ok);
        Assert.False(Parse("   ", true).Ok);
    }
}

public sealed class ObjectUriTests : ObjectUriContract
{
    protected override (bool Ok, string? Bucket, string? Key, string? Reason) Parse(string text, bool prefix)
    {
        var ok = Fetcher.ObjectUri.TryParse(text, prefix, out var uri, out var reason);
        return (ok, uri?.Bucket, uri?.Key, reason);
    }
}
