using Amazon;
using Amazon.S3;

namespace Processor.ObjectFetcher;

/// <summary>
/// Builds the one <see cref="IAmazonS3"/> a processor uses.
/// </summary>
internal static class S3Client
{
    /// <summary>
    /// <b>No credentials argument</b>: the SDK's default chain supplies them. <b>Checksum behaviour
    /// is left at the SDK default</b>, so the test path and the production path are the same path.
    /// The timeout bounds a single request, not a whole transfer. With a custom endpoint the region
    /// only signs (<c>AuthenticationRegion</c>): setting <c>RegionEndpoint</c> would clear <c>ServiceURL</c>.
    /// </summary>
    internal static IAmazonS3 Create(S3Options options)
    {
        ArgumentNullException.ThrowIfNull(options);

        var config = new AmazonS3Config
        {
            ForcePathStyle = options.ForcePathStyle,
            Timeout = TimeSpan.FromSeconds(30),
        };

        if (!string.IsNullOrWhiteSpace(options.ServiceUrl))
        {
            config.ServiceURL = options.ServiceUrl;

            // MinIO ignores the region, but SigV4 must sign with one.
            config.AuthenticationRegion = string.IsNullOrWhiteSpace(options.Region)
                ? "us-east-1"
                : options.Region;
        }
        else if (!string.IsNullOrWhiteSpace(options.Region))
        {
            config.RegionEndpoint = RegionEndpoint.GetBySystemName(options.Region);
        }

        return new AmazonS3Client(config);
    }
}
