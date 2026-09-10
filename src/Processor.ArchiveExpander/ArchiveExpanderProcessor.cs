using System.Text.Json;
using BaseProcessor.Core.Configuration;
using BaseProcessor.Core.Processing;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Processor.ArchiveExpander.Extractors;

namespace Processor.ArchiveExpander;

/// <summary>
/// Turns a file path into one structured document. A plain downstream transform: it has an input and
/// it produces output, so it is not an edge and neither <c>BaseImporter</c> nor <c>BaseExporter</c>
/// applies.
/// </summary>
internal sealed class ArchiveExpanderProcessor(
    ILogger<ArchiveExpanderProcessor> logger,
    IOptions<ArchiveExpanderOptions> options,
    FileContentBuilder builder)
    : BaseProcessor<ArchiveExpanderConfig>
{
    private readonly long _podCeiling = options.Value.MaxFileSizeBytes;

    protected override async Task ProcessAsync(
        byte[] data, ArchiveExpanderConfig? config, Guid executionId, CancellationToken ct)
    {
        // Config first: it is the cheapest check and it depends on nothing else. A step wired with a
        // ceiling this pod cannot honour is wrong before any file is named.
        var settings = Validate(config);

        var path = ReadPath(data);
        var info = Inspect(path, settings);

        var bytes = Read(info);

        FileBuildResult built;
        try
        {
            built = builder.Build(bytes, info, settings);
        }
        catch (ArchiveExtractionException ex)
        {
            // A corrupt or truncated archive, or one that expands past the ceiling. Deterministic —
            // it fails identically on every redelivery — so it is a failed step, not something to
            // park. No log here: the framework writes this message verbatim when it catches the
            // exception.
            //
            // ONE TYPE, NOT A LIST OF LIBRARY TYPES, and that is the fix for a measured seam
            // failure. This catch was originally `InvalidDataException or IOException or
            // NotSupportedException or ArgumentException` — the BCL types zip raises. When rar
            // arrived it brought SharpCompress, whose entire hierarchy descends from
            // SharpCompressException : Exception and matched none of them, so an ordinary corrupt
            // rar fell through to the framework's general catch: "the transform faulted", at Warning,
            // with a stack trace and THE FILE PATH NOWHERE. The path is the whole reason §9 puts
            // these checks here. Each extractor now wraps its own library's faults, exactly as
            // BaseExporter's sinks wrap theirs into ExportSinkException.
            //
            // Bare Exception is deliberately NOT caught: a NullReferenceException in the builder is
            // a programming error, and reporting it to an operator as a corrupt file buries a bug
            // under a plausible business failure. Anything that is not this type reaches the
            // framework's general catch with its stack trace intact.
            throw new FailedException($"extracting {info.FullName} failed: {ex.Message}");
        }

        // The SHAPE of the result, never its content. A count, a size and a depth are safe to log;
        // the bytes are upstream data and stay out of every template in this system.
        //
        // THE DEPTH IS HERE BECAUSE THIS IS THE ONLY PLACE IT SURVIVES. The registered output schema
        // states its depth structurally, and a document deeper than the schema admits fails
        // validation one hop later — reported with EntryId Guid.Empty, no payload and no file path,
        // at Information. Nothing in that failure says how deep this document actually went, so a
        // MaxDepth that disagrees with the schema would otherwise be undiagnosable from the logs.
        // Both numbers are logged: what was asked for, and what the file actually needed.
        logger.LogInformation(
            "read {FilePath} as {SizeBytes} bytes with {EntryCount} entries, expanded to depth "
            + "{DepthReached} of {MaxDepth}",
            info.FullName, info.Length, built.Node.Metadata.EntryCount, built.DepthReached,
            settings.MaxDepth);

        var document = JsonSerializer.SerializeToUtf8Bytes(built.Node, FileDocument.Options);

        // ONE branch, on the execution id this dispatch arrived with. Not NewExecutionId(): this is
        // a transform, not a source, so the lineage it was handed is the lineage it continues.
        await SendToPostAsync(document, executionId, ct).ConfigureAwait(false);
    }

    /// <summary>The payload, checked. Throws <see cref="FailedException"/> with the reason.</summary>
    private ArchiveExpanderConfig Validate(ArchiveExpanderConfig? config)
    {
        if (config is null)
        {
            // Same "step payload rejected" prefix as every other malformed-payload case below: an
            // absent payload IS a malformed payload, and an operator searching for payload faults
            // must find all of them — the commonest one included — with one query.
            throw BadPayload(
                "ArchiveExpander needs ExpectedExtension, MinimumSizeBytes and MaximumSizeBytes");
        }

        if (string.IsNullOrWhiteSpace(config.ExpectedExtension)
            || !config.ExpectedExtension.StartsWith('.'))
        {
            throw BadPayload($"ExpectedExtension must start with a dot; the payload named "
                                          + $"'{config.ExpectedExtension}'");
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
                + $"{_podCeiling}; raise ArchiveExpander__MaxFileSizeBytes or lower the step");
        }

        // An omitted MaxDepth never reaches here as 0: System.Text.Json applies the record's own
        // default parameter value to a missing property, so absent arrives as DefaultMaxDepth. A 0
        // therefore means the payload SAID zero, and that is rejected rather than read as "do not
        // expand" — a step wanting no expansion is asking for a plain file, and naming a depth of
        // nothing is far more likely to be a payload written against the wrong field.
        //
        // The upper bound is what makes the builder's recursion safe: it is the stack depth this
        // pod will ever reach, fixed before any file is opened.
        if (config.MaxDepth < 1 || config.MaxDepth > ArchiveExpanderConfig.MaxSupportedDepth)
        {
            throw BadPayload(
                $"MaxDepth must be between 1 and {ArchiveExpanderConfig.MaxSupportedDepth}; the payload "
                + $"named {config.MaxDepth}");
        }

        return config;
    }

    /// <summary>
    /// The dry inspection: existence, extension, size. Every one of these reads metadata only —
    /// <c>FileInfo</c> never opens the file — so a file that fails here is never opened at all.
    /// </summary>
    private FileInfo Inspect(string path, ArchiveExpanderConfig config)
    {
        var info = new FileInfo(path);

        if (!info.Exists)
        {
            // "reading", not "rejected": an absent file is not a file that broke a rule, and the two
            // classes are searched separately.
            throw Unreadable(path, "it does not exist");
        }

        var extension = info.Extension;
        if (!extension.Equals(config.ExpectedExtension, StringComparison.OrdinalIgnoreCase))
        {
            throw Rejected(path,
                $"expected {config.ExpectedExtension} and the file is '{extension}'");
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
    private byte[] Read(FileInfo info)
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
    // failure twice — which is why BaseImporter and BaseExporter log nothing either. The message
    // text IS the contract an operator searches; only the duplicate copy is gone.

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
    private string ReadPath(byte[] data)
    {
        FileLocator? locator = null;
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

        // No log here. ProcessDispatchHandler's catch for FailedException logs the author's message
        // verbatim at Information — "the author reported the step failed: {Reason}" with ex.Message
        // as the reason — so a pre-throw log of the same text would be a second, identical record.
        // The thrown message below IS the operator-facing contract; it survives to that framework log
        // unchanged, which is why it must not change a character.
        throw new FailedException($"input branch did not name a file path: {reason}");
    }
}
