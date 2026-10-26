namespace Processor.ObjectPersister;

/// <summary>
/// Where the S3 API is, bound from the <c>"S3"</c> config section. There are no credentials here
/// by design: the SDK's default chain (environment, then the pod's role) supplies them, so the same
/// image runs against the dev MinIO and against AWS.
/// </summary>
public sealed class S3Options
{
    /// <summary>The endpoint of an S3-compatible service (MinIO). Unset means AWS.</summary>
    public string? ServiceUrl { get; set; }

    /// <summary>Path-style addressing (<c>host/bucket/key</c>), which MinIO needs.</summary>
    public bool ForcePathStyle { get; set; }

    /// <summary>The region name, e.g. <c>us-east-1</c>. Unset leaves it to the SDK's own lookup.</summary>
    public string? Region { get; set; }
}
