using BaseProcessor.Core.Configuration;

namespace Processor.FilePersister;

/// <summary>
/// The step payload, and it holds exactly one field. Bound case-insensitively by
/// <see cref="ProcessorConfig.SerializerOptions"/>, which also ignores unknown properties so a field
/// added later does not break workflows authored before it.
/// <para>
/// <b>The mirror of <c>FileFetcherConfig</c>, and the asymmetry between them is the point.</b> The
/// fetcher's payload holds expectations about a file it is ABOUT to open — extension, size bounds —
/// because those are knowable from <c>FileInfo</c> before the file is read. Nothing here is an
/// expectation: the bytes already exist and have already passed whatever the fetcher admitted them
/// under, one whole workflow ago. What is left is the one decision nobody upstream could make, which
/// is where the file goes.
/// </para>
/// <para>
/// <b>There is no size ceiling here, and that is a decision.</b> The fetcher's
/// <c>MaxFileSizeBytes</c> already bounded these bytes on the way in, and a second ceiling on the
/// way out would be a number that can disagree with the first — the same coupling
/// <c>ArchiveExpanderConfig.MaxDepth</c> had against its output schema, which cost a live workflow a
/// latent failure. One bound, upstream, where the file enters the system.
/// </para>
/// </summary>
/// <param name="FolderPath">
/// The directory the file is written into. Absolute, and it must already exist.
/// <para>
/// <b>It must exist rather than being created, and that is deliberate.</b> In this deployment the
/// folder is a volume mount; a folder that is absent means the mount is missing, and creating it
/// would put the file in the container's own writable layer where it looks written, reports a path,
/// and is gone when the pod restarts. Failing names the real fault. A first run needs no seeding —
/// the volume's own <c>DirectoryOrCreate</c> covers that, on the host side where it belongs.
/// </para>
/// <para>
/// <b>The file NAME is not here.</b> It rides the envelope, because it is the identity of the file
/// this branch is carrying and not a choice a workflow author makes. See
/// <see cref="FilePersisterProcessor"/> for what that costs: a name from upstream is a name that
/// must be checked before it reaches the filesystem.
/// </para>
/// </param>
public sealed record FilePersisterConfig(string? FolderPath) : ProcessorConfig;
