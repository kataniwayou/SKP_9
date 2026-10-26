using Amazon;
using Amazon.S3;
using Xunit;
using Fetcher = Processor.ObjectFetcher;
using Persister = Processor.ObjectPersister;

namespace BaseApi.Tests.ObjectStorage;

/// <summary>
/// What the S3 client is configured with, written once and run against every copy of
/// <c>S3Client</c>. A custom endpoint must keep its URL: the SDK's <c>RegionEndpoint</c> setter
/// clears <c>ServiceURL</c>, so the region may only sign.
/// </summary>
public abstract class S3ClientContract
{
    protected abstract AmazonS3Config Build(string? serviceUrl, string? region, bool forcePathStyle);

    [Fact]
    public void A_custom_endpoint_keeps_its_url_and_the_region_only_signs()
    {
        var config = Build("http://localhost:19000", "us-east-1", true);

        Assert.StartsWith("http://localhost:19000", config.ServiceURL);
        Assert.Equal("us-east-1", config.AuthenticationRegion);
        Assert.True(config.ForcePathStyle);
        Assert.Null(config.RegionEndpoint);
        Assert.Equal(TimeSpan.FromSeconds(30), config.Timeout);
    }

    [Fact]
    public void A_service_url_alone_is_used()
    {
        var config = Build("http://localhost:19000", null, false);

        Assert.StartsWith("http://localhost:19000", config.ServiceURL);
        Assert.Equal(TimeSpan.FromSeconds(30), config.Timeout);
    }

    [Fact]
    public void A_region_alone_selects_the_aws_endpoint()
    {
        var config = Build(null, "eu-west-1", false);

        Assert.Equal(RegionEndpoint.EUWest1, config.RegionEndpoint);
        Assert.True(string.IsNullOrEmpty(config.ServiceURL));
        Assert.Equal(TimeSpan.FromSeconds(30), config.Timeout);
    }
}

public sealed class ObjectFetcherS3ClientTests : S3ClientContract
{
    protected override AmazonS3Config Build(string? serviceUrl, string? region, bool forcePathStyle)
    {
        using var client = Fetcher.S3Client.Create(new Fetcher.S3Options
        {
            ServiceUrl = serviceUrl, Region = region, ForcePathStyle = forcePathStyle,
        });
        return (AmazonS3Config)client.Config;
    }
}

public sealed class ObjectPersisterS3ClientTests : S3ClientContract
{
    protected override AmazonS3Config Build(string? serviceUrl, string? region, bool forcePathStyle)
    {
        using var client = Persister.S3Client.Create(new Persister.S3Options
        {
            ServiceUrl = serviceUrl, Region = region, ForcePathStyle = forcePathStyle,
        });
        return (AmazonS3Config)client.Config;
    }
}
