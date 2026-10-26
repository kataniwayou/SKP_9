using BaseProcessor.Core.Configuration;

namespace Processor.ObjectPersister;

/// <summary>
/// The step payload, and it holds exactly one field, as FilePersister's does. Bound
/// case-insensitively by <see cref="ProcessorConfig.SerializerOptions"/>, which also ignores unknown
/// properties so a field added later does not break workflows authored before it.
/// </summary>
/// <param name="DestinationUri">
/// Where the object is written: <c>s3://bucket</c> or <c>s3://bucket/prefix</c>. The key is a
/// PREFIX, so it may be empty (the bucket root), and a non-empty one gains a trailing <c>/</c>:
/// <c>s3://skp-out/acme</c> and <c>s3://skp-out/acme/</c> are the same instruction.
/// <para>
/// <b>The bucket must already exist rather than being created, and that is deliberate.</b> The
/// mirror of FilePersister's folder: a bucket is provisioned infrastructure, and creating one here
/// would put data somewhere with none of the policy, encryption or lifecycle the real bucket
/// carries. See <see cref="ObjectPersisterProcessor"/> for how the absence is detected.
/// </para>
/// <para>
/// <b>The file NAME is not here.</b> It rides the envelope, because it is the identity of the file
/// this branch is carrying and not a choice a workflow author makes.
/// </para>
/// </param>
public sealed record ObjectPersisterConfig(string? DestinationUri) : ProcessorConfig;
