using Microsoft.Extensions.Configuration;

namespace Processor.FilePersister;

/// <summary>
/// The pod's own write-staging suffix, bound from the <c>"FilePersister"</c> config section and set
/// in the manifest as <c>FilePersister__TempExtension</c>.
/// <para>
/// <b>A file is written in two stages, and this names the first one.</b> A write into a mounted
/// volume is not instantaneous, and for as long as it is in flight the destination folder holds a
/// file that already has its final name and does not yet have all its bytes. Anything watching that
/// folder — and something always is, or the workflow would have no reason to write there — can open
/// it and read a truncated file. So the bytes land under <c>{fileName}.{TempExtension}</c> first and
/// are moved onto the final name afterwards, and the move is a rename within one directory, which is
/// atomic: a watcher sees the file under its final name either not at all or complete.
/// </para>
/// <para>
/// <b>It is a pod option and not a step payload field, and that is the deliberate half of the
/// design.</b> <see cref="FilePersisterConfig"/> carries what a workflow author decides — where the
/// file goes. Which suffix a folder's watcher is configured to ignore is not that; it is a fact
/// about the deployment the folder lives in, settled by the operator who wired the two sides
/// together. Keeping it out of the payload also keeps the registered <c>file-persister-config</c>
/// row untouched, and that row is <c>additionalProperties: false</c> — a field here would have meant
/// a new schema row, re-pointing both sides of a published workflow, and a restart, to carry a value
/// no workflow author would ever vary.
/// </para>
/// <para>
/// <b>Every malformed value falls back rather than failing.</b> See
/// <c>FilePersisterProcessor.StagingSuffix</c> for what that costs and why it is still right.
/// </para>
/// </summary>
public sealed class FilePersisterOptions
{
    /// <summary>
    /// The staging suffix, without a leading dot (default <c>"skp"</c>). The default lives here so an
    /// unset variable still stages, rather than silently reverting to a single-stage write — the one
    /// failure mode of this feature that would look exactly like success.
    /// </summary>
    [ConfigurationKeyName("TempExtension")]
    public string TempExtension { get; set; } = "skp";
}
