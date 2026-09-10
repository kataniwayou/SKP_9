using System.Text.Json;
using BaseProcessor.Core.Configuration;
using BaseProcessor.Core.Processing;
using Microsoft.Extensions.Logging;

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
internal sealed class FilePersisterProcessor(ILogger<FilePersisterProcessor> logger)
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

        Write(path, file.Content!);

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
    /// The write. Every IO fault is a failed step regardless of cause, for the reason
    /// <c>FileFetcherProcessor.Read</c> gives: there is no requeue path here — the framework requeues
    /// only <c>TransientSendException</c>, which can arise solely from <c>SendToPostAsync</c> — so
    /// classifying the fault would change nothing about the disposition.
    /// <para>
    /// <b>An existing file is overwritten</b>, which is what <c>File.WriteAllBytes</c> does and what
    /// this processor wants: re-running a workflow over the same input must land in the same state,
    /// exactly as re-running FileFetcher reads the same file twice. Refusing would make the second
    /// run of any workflow a failure.
    /// </para>
    /// </summary>
    private static void Write(string path, byte[] content)
    {
        try
        {
            File.WriteAllBytes(path, content);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException
                                      or NotSupportedException)
        {
            throw Unwritable(path, ex.Message);
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
