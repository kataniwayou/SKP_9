using System.Text.Json;
using BaseProcessor.Core.Configuration;
using BaseProcessor.Core.Processing;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Processor.FilePersister;

/// <summary>
/// Turns a file's bytes and its identity back into a file on disk, and reports where it went. The
/// mirror of <c>FileFetcherProcessor</c>: a plain transform with an input and an output, so it is
/// not an edge and neither <c>BaseImporter</c> nor <c>BaseExporter</c> applies.
/// <para>
/// <b>The path is minted here, and that is the counterpart of the fetcher discarding it.</b>
/// FileFetcher receives a path, opens it, and writes no path into the envelope — deliberately, so
/// that every hop between the two ends of a workflow is location-independent. This processor is
/// where a location re-enters the branch, and it is the only place it can, because the folder is
/// configuration and the name is the file's own.
/// </para>
/// <para>
/// <b>It writes the bytes and nothing else.</b> No timestamps are restored onto the file: a
/// filesystem's idea of when a file was created is not the file, and the envelope's stamps describe
/// a source on the other side of the workflow. Verification compares CONTENT between the two
/// folders, so metadata drift is outside what this processor owes anyone.
/// </para>
/// </summary>
internal sealed class FilePersisterProcessor(
    ILogger<FilePersisterProcessor> logger, IOptions<FilePersisterOptions> options)
    : BaseProcessor<FilePersisterConfig>
{
    protected override async Task ProcessAsync(
        byte[] data, FilePersisterConfig? config, Guid executionId, CancellationToken ct)
    {
        // Config first: it is the cheapest check and it depends on nothing else. A step wired to a
        // folder that is not mounted is wrong before any envelope is parsed.
        var folder = Validate(config);

        var file = ReadEnvelope(data);
        var name = SafeName(file.FileName);

        var path = Path.Combine(folder, name);

        Write(path, file.Content!, options.Value.TempExtension);

        // The SHAPE and the destination, never the content. The bytes are upstream data and stay out
        // of every template in this system.
        //
        // THIS IS THE ONLY PLACE THE DESTINATION IS RECORDED, which mirrors FileFetcher being the
        // only place the source is. Between them the branch names no location at all, so an operator
        // tracing a file from one end of a workflow to the other has exactly these two lines — and
        // they share the dispatch's ExecutionId and CorrelationId, so one query spans both.
        logger.LogInformation(
            "persisted {FileName} ({Extension}), {SizeBytes} bytes, to {FilePath}",
            name, file.Extension, file.Content!.Length, path);

        var locator = JsonSerializer.SerializeToUtf8Bytes(new FileLocator(path), FileLocatorJson.Options);

        // ONE branch, on the execution id this dispatch arrived with. Not NewExecutionId(): this is
        // a transform, not a source, so the lineage it was handed is the lineage it continues.
        await SendToPostAsync(locator, executionId, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// The payload, checked, and the folder it names. Throws <see cref="FailedException"/> with the
    /// reason.
    /// </summary>
    private static string Validate(FilePersisterConfig? config)
    {
        if (config is null)
        {
            // Same "step payload rejected" prefix as every other malformed-payload case: an absent
            // payload IS a malformed payload, and an operator searching for payload faults must find
            // all of them — the commonest one included — with one query.
            throw BadPayload("FilePersister needs FolderPath");
        }

        if (config.FolderPath is not { Length: > 0 } folder)
        {
            throw BadPayload("FolderPath must not be empty");
        }

        // IsPathFullyQualified, not IsPathRooted, for the reason FileFetcher.ReadPath gives: on
        // Windows a drive-relative path such as "\out" is rooted but not absolute. Production runs on
        // Linux where the two agree; the tests run on Windows where they do not.
        if (!Path.IsPathFullyQualified(folder))
        {
            throw BadPayload(
                $"FolderPath must be absolute, and only an absolute path names one location; the "
                + $"payload named '{folder}'");
        }

        if (!Directory.Exists(folder))
        {
            // NOT created. See FilePersisterConfig.FolderPath: an absent folder here means the volume
            // is not mounted, and creating it would write into the container's own layer — a file
            // that reports a path and is gone at the next restart.
            throw BadPayload(
                $"FolderPath '{folder}' does not exist; this processor does not create it, because "
                + "an absent folder means the volume is not mounted");
        }

        return folder;
    }

    /// <summary>
    /// The envelope, parsed and checked far enough to write. Throws <see cref="FailedException"/>
    /// with the reason.
    /// <para>
    /// The parse is wrapped rather than left to throw, for the reason
    /// <c>FileFetcherProcessor.ReadPath</c> gives: a malformed upstream record is a business failure
    /// with a diagnosis, not a framework exception carrying a quoted fragment of upstream content
    /// into a log store.
    /// </para>
    /// </summary>
    private static PersistableFile ReadEnvelope(byte[] data)
    {
        PersistableFile? file;

        try
        {
            file = JsonSerializer.Deserialize<PersistableFile>(data, ProcessorConfig.SerializerOptions);
        }
        catch (JsonException)
        {
            // Swallowed on purpose: the exception's text quotes the fragment that failed to parse,
            // and that fragment is upstream content.
            throw MalformedEnvelope("the branch is not JSON");
        }

        if (file is null)
        {
            throw MalformedEnvelope("the branch is JSON null");
        }

        if (file.Content is null)
        {
            throw MalformedEnvelope("the branch carries no content");
        }

        // An EMPTY content is not a fault. A zero-byte file is a file, FileFetcher admits one
        // (MinimumSizeBytes 0 disables the floor), and refusing to write it here would lose a file
        // the far end of the workflow accepted.
        return file;
    }

    /// <summary>
    /// The file name, checked to be a name and not a route. Throws <see cref="FailedException"/>
    /// with the reason.
    /// <para>
    /// <b>This check exists because the name is the one piece of UPSTREAM data that reaches the
    /// filesystem.</b> The folder is configuration an operator wrote; the name arrives in the branch,
    /// and a branch can carry whatever a producer put in it. Without this, a record naming
    /// <c>../../etc/x</c> would let whoever wrote the envelope choose where this pod writes.
    /// </para>
    /// </summary>
    private static string SafeName(string? fileName)
    {
        if (fileName is not { Length: > 0 } name)
        {
            throw MalformedEnvelope("the branch carries no fileName");
        }

        // BOTH separators, explicitly, rather than Path.GetInvalidFileNameChars alone. That set is
        // platform-dependent: on Linux it is '\0' and '/', so a backslash — a separator on the
        // platform these tests run on — passes there and would make the check mean different things
        // in test and in production. Naming both makes it mean one thing everywhere.
        if (name.IndexOfAny(SeparatorChars) >= 0)
        {
            throw RejectedName(name, "it names a directory, and only a bare file name is written");
        }

        if (name is "." or "..")
        {
            throw RejectedName(name, "it names a directory, and only a bare file name is written");
        }

        if (name.IndexOf('\0') >= 0)
        {
            throw RejectedName(name, "it contains a null character");
        }

        return name;
    }

    /// <summary>Both platforms' separators, for the reason <see cref="SafeName"/> gives.</summary>
    private static readonly char[] SeparatorChars = ['/', '\\'];

    /// <summary>
    /// The write, in two stages: the bytes land under a staging name and are then moved onto the
    /// final one. Every IO fault is a failed step regardless of cause, for the reason
    /// <c>FileFetcherProcessor.Read</c> gives: there is no requeue path here — the framework requeues
    /// only <c>TransientSendException</c>, which can arise solely from <c>SendToPostAsync</c> — so
    /// classifying the fault would change nothing about the disposition.
    /// <para>
    /// <b>The two stages exist because a write into a mounted volume is not instantaneous.</b> A
    /// single <c>WriteAllBytes</c> truncates the destination the moment it opens it, so for as long
    /// as the bytes are in flight the folder holds a file that already has its final name and does
    /// not yet have its content. Anything watching that folder can open it and read a truncated
    /// file, and nothing about the result looks wrong afterwards. Staging moves that window onto a
    /// name the watcher is configured to ignore.
    /// </para>
    /// <para>
    /// <b>The staging file is in the SAME folder, and that is load-bearing rather than tidy.</b> One
    /// directory is one filesystem, so <see cref="File.Move(string, string, bool)"/> is
    /// <c>rename(2)</c> on Linux and <c>MoveFileEx(MOVEFILE_REPLACE_EXISTING)</c> on Windows —
    /// atomic, so a watcher sees the final name either absent or complete. Staging through a system
    /// temp directory would cross the volume boundary, degrade the move to copy-then-delete, and
    /// reopen the exact window this method exists to close.
    /// </para>
    /// <para>
    /// <b>An existing file is overwritten</b>, which is why the move passes <c>overwrite: true</c>
    /// and is not optional: re-running a workflow over the same input must land in the same state,
    /// exactly as re-running FileFetcher reads the same file twice, and a bare <c>File.Move</c>
    /// throws when the destination exists. A staging file left by an earlier crash is overwritten
    /// too, by <c>WriteAllBytes</c>, because nothing collects that debris and a dispatch must not
    /// fail forever on a run nobody remembers.
    /// </para>
    /// </summary>
    private static void Write(string path, byte[] content, string configuredSuffix)
    {
        var staging = $"{path}.{StagingSuffix(configuredSuffix)}";

        try
        {
            File.WriteAllBytes(staging, content);
            File.Move(staging, path, overwrite: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException
                                      or NotSupportedException)
        {
            Discard(staging);

            // THE FINAL PATH, not the staging one, because that is the path the workflow names and
            // the one an operator searches. The OS reason is kept verbatim and may itself name the
            // staging file — that is diagnosis, and it is how the two stages are told apart.
            throw Unwritable(path, ex.Message);
        }
    }

    /// <summary>The staging suffix when configuration does not supply a usable one.</summary>
    private const string DefaultSuffix = "skp";

    /// <summary>
    /// The configured suffix, normalised, or <see cref="DefaultSuffix"/>.
    /// <para>
    /// <b>Every unusable value falls back silently, and that is a decision rather than an
    /// oversight.</b> Failing the step instead would turn one typo in a manifest into every dispatch
    /// failing, to defend a value whose only job is to be a name a watcher ignores. The fallback
    /// still stages — it stages under the name the rest of this system documents — so the property
    /// that matters is never lost, which is the difference between this and the folder path, where
    /// guessing would put a file somewhere nobody is looking.
    /// </para>
    /// <para>
    /// <b>A separator is rejected for the reason <see cref="SafeName"/> exists.</b> The suffix is
    /// appended to a name that has already been checked for separators, and a suffix must not be the
    /// way one gets back in — <c>"../x"</c> here would stage outside the folder and then rename into
    /// it, which is a shorter route to the same escape.
    /// </para>
    /// </summary>
    private static string StagingSuffix(string? configured)
    {
        // A leading dot is tolerated: "part" and ".part" are the same instruction, and an operator
        // who writes the dot has not asked for a file called "orders.csv..part".
        var suffix = configured?.Trim().TrimStart('.') ?? string.Empty;

        if (suffix.Length == 0
            || suffix.IndexOfAny(SeparatorChars) >= 0
            || suffix.IndexOf(' ') >= 0)
        {
            return DefaultSuffix;
        }

        return suffix;
    }

    /// <summary>
    /// The staging file, removed on a best-effort basis after a failure.
    /// <para>
    /// <b>Hygiene, not correctness.</b> A staging file that survives is already wearing a name
    /// nothing downstream reads, so leaving one loses nothing — but this folder is a mounted volume
    /// that nobody sweeps, and a recurring fault would fill it. A failure to delete is swallowed
    /// because the step is failing already and the reason it is failing is the one worth reporting.
    /// </para>
    /// </summary>
    private static void Discard(string staging)
    {
        try
        {
            File.Delete(staging);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException
                                      or NotSupportedException)
        {
            // Deliberately empty. See the summary.
        }
    }

    // THE FOUR FAILURE CLASSES, AND NONE OF THEM LOGS. ProcessDispatchHandler catches
    // FailedException and writes the author's message verbatim, so a line here would emit every
    // failure twice. The message text IS the contract an operator searches.

    /// <summary>A malformed payload, diagnosed before any envelope is parsed.</summary>
    private static FailedException BadPayload(string reason)
        => new($"step payload rejected: {reason}");

    /// <summary>An upstream record this processor cannot write. Never quotes the record.</summary>
    private static FailedException MalformedEnvelope(string reason)
        => new($"input branch did not carry a file: {reason}");

    /// <summary>
    /// A file name that broke a rule. Separate from MalformedEnvelope because this one has a name,
    /// and the name is the thing an operator needs to see.
    /// </summary>
    private static FailedException RejectedName(string name, string reason)
        => new($"file name '{name}' rejected: {reason}");

    /// <summary>A file that could not be written, whatever the cause.</summary>
    private static FailedException Unwritable(string path, string reason)
        => new($"writing {path} failed: {reason}");
}
