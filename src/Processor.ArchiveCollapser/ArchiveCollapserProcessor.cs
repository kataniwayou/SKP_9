using System.Text.Json;
using BaseProcessor.Core.Processing;
using Microsoft.Extensions.Logging;
using Processor.ArchiveCollapser.Writers;

namespace Processor.ArchiveCollapser;

/// <summary>
/// Turns one structured document back into one raw file. The inverse of
/// <c>ArchiveExpanderProcessor</c>, and like it a plain downstream transform: it has an input and it
/// produces output, so it is not an edge and neither <c>BaseImporter</c> nor <c>BaseExporter</c>
/// applies.
/// <para>
/// <b>It performs no file IO.</b> There is no <c>FileInfo</c> in this assembly and no volume mount
/// on this pod. The document arrives on the branch and the archive leaves on one.
/// </para>
/// </summary>
internal sealed class ArchiveCollapserProcessor(
    ILogger<ArchiveCollapserProcessor> logger,
    ArchiveBuilder builder)
    : BaseProcessor<ArchiveCollapserConfig>
{
    protected override async Task ProcessAsync(
        byte[] data, ArchiveCollapserConfig? config, Guid executionId, CancellationToken ct)
    {
        // config IS DELIBERATELY UNREAD, AND THERE IS NO VALIDATION STEP HERE.
        //
        // ArchiveExpanderProcessor opens with `if (config is null) throw BadPayload(...)`. This one
        // must not: the payload holds nothing, because the depth is a property of the document that
        // arrived rather than a choice a workflow author makes. Null is legal, {} is legal, and a
        // payload left over from another step is legal.
        //
        // ProcessorArchiveCollapserTests.EveryPayloadIsAccepted is what fails if this is ever
        // "fixed" back into symmetry with the expander.
        var root = ReadDocument(data);

        CollapseResult built;
        try
        {
            built = builder.Build(root);
        }
        catch (ArchiveWritingException ex)
        {
            // A document that cannot be packed. Deterministic -- it fails identically on every
            // redelivery -- so it is a failed step, not something to park. No log here: the
            // framework writes this message verbatim when it catches the exception, and a line here
            // would emit every failure twice.
            //
            // ONE TYPE, NOT A LIST OF LIBRARY TYPES. Each writer wraps its own library's faults, for
            // the reason ArchiveWritingException records. Bare Exception is deliberately NOT caught:
            // a NullReferenceException in the builder is a programming error, and reporting it as a
            // bad document buries a bug under a plausible business failure.
            throw new FailedException($"collapsing {root.Metadata.Name} failed: {ex.Message}");
        }

        // The SHAPE of the result, never its content. A count, a size and a depth are safe to log;
        // the bytes are upstream data and stay out of every template in this system.
        //
        // THE DEPTH IS HERE BECAUSE THIS IS THE ONLY PLACE IT SURVIVES. The outbound envelope says
        // nothing about depth, so if the input schema row is not registered -- which is the whole of
        // phase 1 -- nothing else records how deep the document actually was.
        //
        // The entry count is the builder's, counted from content, not the document's declared
        // metadata.entryCount: the array is the fact and the count is derived.
        logger.LogInformation(
            "collapsed {FileName} of {EntryCount} entries into {SizeBytes} bytes, from depth {DepthReached}",
            root.Metadata.Name, built.EntryCount, built.Archive.LongLength, built.DepthReached);

        var envelope = new CollapsedFile(
            root.Metadata.Name,
            root.Metadata.Extension,
            // What was BUILT, not what the document declared. See CollapsedFile.
            built.Archive.LongLength,
            root.Metadata.CreatedUtc,
            root.Metadata.ModifiedUtc,
            built.Archive);

        // ONE branch, on the execution id this dispatch arrived with. Not NewExecutionId(): this is
        // a transform, not a source, so the lineage it was handed is the lineage it continues.
        await SendToPostAsync(
            JsonSerializer.SerializeToUtf8Bytes(envelope, CollapsedFileJson.Options),
            executionId,
            ct).ConfigureAwait(false);
    }

    /// <summary>
    /// The document this dispatch carries, or a failed step saying why there isn't one.
    /// <para>
    /// The parse is wrapped rather than left to throw: a malformed upstream record is a business
    /// failure with a diagnosis, not a framework exception with a sanitized message.
    /// </para>
    /// </summary>
    private static FileNode ReadDocument(byte[] data)
    {
        FileNode? node;
        string reason;

        try
        {
            node = JsonSerializer.Deserialize<FileNode>(data, FileDocument.Options);

            // A successful parse can still hand back null: the bytes were valid JSON whose value
            // was literally `null`, or empty. That is a different fault than malformed JSON -- an
            // operator chasing "not JSON" here would be chasing a parse error that never happened --
            // so it gets its own reason. Overwritten below if the node turns out non-null.
            reason = "the branch is empty";
        }
        catch (JsonException)
        {
            // Swallowed on purpose. The exception's text quotes the fragment that failed to parse,
            // and that fragment is upstream content -- it must not reach a log store. The class of
            // fault is what is reported; the ids in the open scope are how it is traced back.
            //
            // This also catches a document deeper than JsonSerializerOptions.MaxDepth, which is the
            // FIRST depth guard -- FileNodeConverter.Read recurses, so a pathologically deep
            // document must be refused before ArchiveBuilder's own bound is reached.
            node = null;
            reason = "the branch is not JSON";
        }

        if (node is not null)
        {
            if (node.Metadata.Name is not { Length: > 0 })
            {
                // The envelope schema declares fileName with minLength 1. Caught here rather than
                // one hop later, where the post handler reports Failed with EntryId Guid.Empty, no
                // payload and no name -- nothing an operator could act on.
                reason = "the root node carries no name";
            }
            else
            {
                return node;
            }
        }

        throw new FailedException($"input branch did not carry a file document: {reason}");
    }
}
