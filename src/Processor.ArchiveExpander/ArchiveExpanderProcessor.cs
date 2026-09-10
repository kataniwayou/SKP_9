using System.Text.Json;
using BaseProcessor.Core.Configuration;
using BaseProcessor.Core.Processing;
using Microsoft.Extensions.Logging;
using Processor.ArchiveExpander.Extractors;

namespace Processor.ArchiveExpander;

/// <summary>
/// Turns a fetched file into one structured document. A plain downstream transform: it has an input
/// and it produces output, so it is not an edge and neither <c>BaseImporter</c> nor
/// <c>BaseExporter</c> applies.
/// <para>
/// <b>It performs no file IO.</b> The path, the dry inspection and the read all live in
/// <c>FileFetcher</c>, which hands this processor an envelope. There is no <c>FileInfo</c> in this
/// assembly and no volume mount on this pod.
/// </para>
/// </summary>
internal sealed class ArchiveExpanderProcessor(
    ILogger<ArchiveExpanderProcessor> logger,
    FileContentBuilder builder)
    : BaseProcessor<ArchiveExpanderConfig>
{
    protected override async Task ProcessAsync(
        byte[] data, ArchiveExpanderConfig? config, Guid executionId, CancellationToken ct)
    {
        // Config first: it is the cheapest check and it depends on nothing else.
        var settings = Validate(config);

        var file = ReadEnvelope(data);

        FileBuildResult built;
        try
        {
            built = builder.Build(file, settings);
        }
        catch (ArchiveExtractionException ex)
        {
            // A corrupt or truncated archive, or one that expands past the ceiling. Deterministic —
            // it fails identically on every redelivery — so it is a failed step, not something to
            // park. No log here: the framework writes this message verbatim when it catches the
            // exception.
            //
            // ONE TYPE, NOT A LIST OF LIBRARY TYPES. Each extractor wraps its own library's faults,
            // exactly as BaseExporter's sinks wrap theirs into ExportSinkException, because
            // SharpCompress's entire hierarchy descends from SharpCompressException and matched none
            // of the BCL types this used to catch.
            //
            // Bare Exception is deliberately NOT caught: a NullReferenceException in the builder is
            // a programming error, and reporting it to an operator as a corrupt file buries a bug
            // under a plausible business failure.
            //
            // IT NAMES THE FILE, NOT A PATH. There is no path in this assembly any more. The name
            // came from the envelope, and FileFetcher's own log line is what ties it back to a
            // location on disk — under the same ExecutionId and CorrelationId.
            throw new FailedException($"extracting {file.Name} failed: {ex.Message}");
        }

        // The SHAPE of the result, never its content. A count, a size and a depth are safe to log;
        // the bytes are upstream data and stay out of every template in this system.
        //
        // THE DEPTH IS HERE BECAUSE THIS IS THE ONLY PLACE IT SURVIVES. The registered output schema
        // states its depth structurally, and a document deeper than the schema admits fails
        // validation one hop later — reported with EntryId Guid.Empty, no payload and no file name.
        // Nothing in that failure says how deep this document actually went, so a MaxDepth that
        // disagrees with the schema would otherwise be undiagnosable from the logs. Both numbers are
        // logged: what was asked for, and what the file actually needed.
        logger.LogInformation(
            "expanded {FileName} of {SizeBytes} bytes into {EntryCount} entries, reaching depth "
            + "{DepthReached} of {MaxDepth}",
            file.Name, file.SizeBytes, built.Node.Metadata.EntryCount, built.DepthReached,
            settings.MaxDepth);

        var document = JsonSerializer.SerializeToUtf8Bytes(built.Node, FileDocument.Options);

        // ONE branch, on the execution id this dispatch arrived with. Not NewExecutionId(): this is
        // a transform, not a source, so the lineage it was handed is the lineage it continues.
        await SendToPostAsync(document, executionId, ct).ConfigureAwait(false);
    }

    /// <summary>The payload, checked. Throws <see cref="FailedException"/> with the reason.</summary>
    private static ArchiveExpanderConfig Validate(ArchiveExpanderConfig? config)
    {
        if (config is null)
        {
            // An absent payload IS a malformed payload, and it shares the prefix so one query finds
            // every payload fault including the commonest one.
            //
            // It is rejected even though every field on this record now has a default. "{}" is a
            // payload that named nothing and gets MaxDepth 1; a null payload is a step that was
            // wired without one at all, and the two are worth distinguishing.
            throw BadPayload("ArchiveExpander needs MaxDepth");
        }

        // An omitted MaxDepth never reaches here as 0: System.Text.Json applies the record's own
        // default parameter value to a missing property, so absent arrives as DefaultMaxDepth. A 0
        // therefore means the payload SAID zero, and that is rejected rather than read as "do not
        // expand" — a step wanting no expansion is asking for a plain file, and naming a depth of
        // nothing is far more likely to be a payload written against the wrong field.
        //
        // The upper bound is what makes the builder's recursion safe: it is the stack depth this
        // pod will ever reach, fixed before any archive is opened.
        if (config.MaxDepth < 1 || config.MaxDepth > ArchiveExpanderConfig.MaxSupportedDepth)
        {
            throw BadPayload(
                $"MaxDepth must be between 1 and {ArchiveExpanderConfig.MaxSupportedDepth}; the "
                + $"payload named {config.MaxDepth}");
        }

        return config;
    }

    // THE TWO FAILURE CLASSES, AND NEITHER LOGS. ProcessDispatchHandler catches FailedException and
    // writes the author's message verbatim, so a line here would emit every failure twice. The
    // message text IS the contract an operator searches.
    //
    // The `rejected` and `reading ... failed` classes left with the filesystem, to FileFetcher, with
    // their templates unchanged — so an operator's existing queries still match, they simply match a
    // different pod.

    /// <summary>A malformed payload, diagnosed before any envelope has been read.</summary>
    private static FailedException BadPayload(string reason)
        => new($"step payload rejected: {reason}");

    /// <summary>
    /// The file this dispatch carries, or a failed step saying why there isn't one.
    /// <para>
    /// The parse is wrapped rather than left to throw: a malformed upstream record is a business
    /// failure with a diagnosis, not a framework exception with a sanitized message.
    /// </para>
    /// </summary>
    private static SourceFile ReadEnvelope(byte[] data)
    {
        FetchedFile? envelope;
        var reason = "the branch is not JSON";

        try
        {
            envelope = JsonSerializer.Deserialize<FetchedFile>(
                data, ProcessorConfig.SerializerOptions);
        }
        catch (JsonException)
        {
            // Swallowed on purpose. The exception's text quotes the fragment that failed to parse,
            // and that fragment is upstream content — it must not reach a log store. The class of
            // fault is what is reported; the ids in the open scope are how it is traced back.
            envelope = null;
        }

        if (envelope is not null)
        {
            if (envelope.FileName is not { Length: > 0 } name)
            {
                reason = "the branch carries no fileName";
            }
            else if (envelope.Content is not { } content)
            {
                reason = "the branch carries no content";
            }
            else
            {
                // Extension may legitimately be absent or empty: a file with no dot in its name is
                // admitted upstream under the "*.*" whitelist. It becomes "", which is what
                // FileInfo.Extension would have said, and what the output document records.
                return new SourceFile(
                    name, envelope.Extension ?? string.Empty, content,
                    envelope.SizeBytes, envelope.CreatedUtc, envelope.ModifiedUtc);
            }
        }

        throw new FailedException($"input branch did not carry a fetched file: {reason}");
    }
}
