using System.Text.Json;
using BaseProcessor.Core.Configuration;
using BaseProcessor.Core.Processing;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Processor.FileFetcher;

/// <summary>
/// Turns a file path into the file's bytes and its identity. A plain downstream transform: it has an
/// input and it produces output, so it is not an edge and neither <c>BaseImporter</c> nor
/// <c>BaseExporter</c> applies.
/// <para>
/// <b>It never opens a file it has not already admitted.</b> Every check below reads
/// <c>FileInfo</c>, which reads metadata only, so a file that fails one is never opened at all.
/// That is the whole reason this is a hop of its own.
/// </para>
/// </summary>
internal sealed class FileFetcherProcessor(
    ILogger<FileFetcherProcessor> logger,
    IOptions<FileFetcherOptions> options)
    : BaseProcessor<FileFetcherConfig>
{
    private readonly long _podCeiling = options.Value.MaxFileSizeBytes;

    protected override async Task ProcessAsync(
        byte[] data, FileFetcherConfig? config, Guid executionId, CancellationToken ct)
    {
        // Config first: it is the cheapest check and it depends on nothing else. A step wired with a
        // ceiling this pod cannot honour is wrong before any file is named.
        var (settings, whitelist) = Validate(config);

        var path = ReadPath(data);
        var info = Inspect(path, settings, whitelist);

        var bytes = Read(info);

        var envelope = new FetchedFile(
            info.Name,
            info.Extension,
            // FileInfo.Length rather than the array's length: they agree, and the former is what the
            // dry inspection already reported to an operator.
            info.Length,
            info.CreationTimeUtc,
            info.LastWriteTimeUtc,
            bytes);

        // The SHAPE, never the content. A name, a size and a timestamp are safe to log; the bytes are
        // upstream data and stay out of every template in this system.
        //
        // THIS IS THE ONLY PLACE THE FILE'S IDENTITY IS LOGGED FROM NOW ON. ArchiveExpander sees an
        // envelope and no path, so an operator tracing a file back to a location on disk has this
        // record and nothing else. It shares the dispatch's ExecutionId and CorrelationId, so one
        // query spans both hops.
        logger.LogInformation(
            "fetched {FileName} ({Extension}), {SizeBytes} bytes, modified {ModifiedUtc}",
            envelope.FileName, envelope.Extension, envelope.SizeBytes, envelope.ModifiedUtc);

        var document = JsonSerializer.SerializeToUtf8Bytes(envelope, FetchedFileJson.Options);

        // ONE branch, on the execution id this dispatch arrived with. Not NewExecutionId(): this is
        // a transform, not a source, so the lineage it was handed is the lineage it continues.
        await SendToPostAsync(document, executionId, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// The payload, checked, and the whitelist it resolves to. Throws <see cref="FailedException"/>
    /// with the reason.
    /// </summary>
    private (FileFetcherConfig Settings, IReadOnlyList<string> Whitelist) Validate(
        FileFetcherConfig? config)
    {
        if (config is null)
        {
            // Same "step payload rejected" prefix as every other malformed-payload case below: an
            // absent payload IS a malformed payload, and an operator searching for payload faults
            // must find all of them — the commonest one included — with one query.
            throw BadPayload(
                "FileFetcher needs AllowedExtensions, MinimumSizeBytes and MaximumSizeBytes");
        }

        var whitelist = ExtensionWhitelist.Resolve(config.AllowedExtensions);

        if (ExtensionWhitelist.FirstMalformed(whitelist) is { } malformed)
        {
            // Quoted back, not normalised. An author who wrote "zip" has to see "zip".
            throw BadPayload(
                $"an allowed extension must start with a dot or be "
                + $"'{ExtensionWhitelist.Wildcard}'; the payload named '{malformed}'");
        }

        if (config.MinimumSizeBytes < 0)
        {
            throw BadPayload("MinimumSizeBytes must not be negative");
        }

        if (config.MaximumSizeBytes < 1)
        {
            throw BadPayload("MaximumSizeBytes must be at least 1");
        }

        if (config.MinimumSizeBytes > config.MaximumSizeBytes)
        {
            throw BadPayload(
                $"MinimumSizeBytes {config.MinimumSizeBytes} is above MaximumSizeBytes "
                + $"{config.MaximumSizeBytes}");
        }

        if (config.MaximumSizeBytes > _podCeiling)
        {
            // NOT clamped. Silently lowering it would have the author's 100MB expectation fail at 32
            // with nothing saying which number won.
            throw BadPayload(
                $"MaximumSizeBytes {config.MaximumSizeBytes} is above this pod's ceiling of "
                + $"{_podCeiling}; raise FileFetcher__MaxFileSizeBytes or lower the step");
        }

        return (config, whitelist);
    }

    /// <summary>
    /// The dry inspection: existence, extension, size. Every one of these reads metadata only —
    /// <c>FileInfo</c> never opens the file — so a file that fails here is never opened at all.
    /// </summary>
    private static FileInfo Inspect(
        string path, FileFetcherConfig config, IReadOnlyList<string> whitelist)
    {
        var info = new FileInfo(path);

        if (!info.Exists)
        {
            // "reading", not "rejected": an absent file is not a file that broke a rule, and the two
            // classes are searched separately.
            throw Unreadable(path, "it does not exist");
        }

        if (!ExtensionWhitelist.Admits(whitelist, info.Extension))
        {
            // The list is named so an operator does not have to go and read the step payload.
            throw Rejected(path,
                $"extension '{info.Extension}' is not in the allowed list "
                + $"({ExtensionWhitelist.Describe(whitelist)})");
        }

        if (info.Length < config.MinimumSizeBytes)
        {
            throw Rejected(path,
                $"{info.Length} bytes is below the {config.MinimumSizeBytes} byte floor");
        }

        if (info.Length > config.MaximumSizeBytes)
        {
            throw Rejected(path,
                $"{info.Length} bytes is above the {config.MaximumSizeBytes} byte ceiling");
        }

        return info;
    }

    /// <summary>
    /// The read. Every IO fault is a failed step regardless of cause: there is no requeue path here
    /// — the framework requeues only <c>TransientSendException</c>, which can arise solely from
    /// <c>SendToPostAsync</c> — so classifying the fault would change nothing about the disposition.
    /// </summary>
    private static byte[] Read(FileInfo info)
    {
        try
        {
            return File.ReadAllBytes(info.FullName);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException
                                      or NotSupportedException)
        {
            throw Unreadable(info.FullName, ex.Message);
        }
    }

    // THE THREE FAILURE CLASSES, AND NONE OF THEM LOGS. ProcessDispatchHandler catches
    // FailedException and writes the author's message verbatim, so a line here would emit every
    // failure twice. The message text IS the contract an operator searches.

    /// <summary>A malformed payload, diagnosed before any path has been read.</summary>
    private static FailedException BadPayload(string reason)
        => new($"step payload rejected: {reason}");

    /// <summary>A file that broke a rule. Separate from BadPayload because this one has a path.</summary>
    private static FailedException Rejected(string path, string reason)
        => new($"file {path} rejected: {reason}");

    /// <summary>A file that could not be read, whatever the cause.</summary>
    private static FailedException Unreadable(string path, string reason)
        => new($"reading {path} failed: {reason}");

    /// <summary>
    /// The absolute path this dispatch names, or a failed step saying why there isn't one.
    /// <para>
    /// The parse is wrapped rather than left to throw: a malformed upstream record is a business
    /// failure with a diagnosis, not a framework exception with a sanitized message.
    /// </para>
    /// </summary>
    private static string ReadPath(byte[] data)
    {
        FileLocator? locator;
        var reason = "the branch is not JSON";

        try
        {
            locator = JsonSerializer.Deserialize<FileLocator>(data, ProcessorConfig.SerializerOptions);
        }
        catch (JsonException)
        {
            // Swallowed on purpose. The exception's text quotes the fragment that failed to parse,
            // and that fragment is upstream content — it must not reach a log store. The class of
            // fault is what is reported; the ids in the open scope are how it is traced back.
            locator = null;
        }

        if (locator?.FilePath is { Length: > 0 } filePath)
        {
            // IsPathFullyQualified, not IsPathRooted: on Windows a drive-relative path such as
            // "\orders.csv" is rooted but not absolute — it still resolves against whatever drive is
            // current, which is not a location any workflow author chose. Production runs on Linux,
            // where the two agree, but the tests here run on Windows, where they do not.
            if (Path.IsPathFullyQualified(filePath))
            {
                return filePath;
            }

            reason = "the path is relative, and only an absolute path names one location";
        }
        else if (locator is not null)
        {
            reason = "the branch carries no filePath";
        }

        throw new FailedException($"input branch did not name a file path: {reason}");
    }
}
