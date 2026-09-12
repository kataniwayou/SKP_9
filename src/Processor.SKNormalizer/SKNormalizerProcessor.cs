using System.Text.Json;
using BaseProcessor.Core.Configuration;
using BaseProcessor.Core.Processing;
using Microsoft.Extensions.Logging;

namespace Processor.SKNormalizer;

internal sealed class SKNormalizerProcessor(
    ILogger<SKNormalizerProcessor> logger,
    ProviderHandlerRegistry registry,
    NormalizationPipeline pipeline)
    : BaseProcessor<SKNormalizerConfig>
{
    protected override async Task ProcessAsync(
        byte[] data, SKNormalizerConfig? config, Guid executionId, CancellationToken ct)
    {
        // Config first: it is the cheapest check and it depends on nothing else.
        var handler = Resolve(config);
        var root = ReadDocument(data);

        NormalizationResult result;

        try
        {
            result = pipeline.Run(root, handler, ct);
        }
        catch (NormalizationException ex)
        {
            // A document this handler cannot standardize. Deterministic — it fails identically on
            // every redelivery — so it is a failed step, not something to park. No log here: the
            // framework writes this message verbatim when it catches the exception.
            //
            // ONE TYPE, NOT A LIST. Handlers and shared services wrap their own faults into
            // NormalizationException, exactly as the extractors and writers wrap theirs.
            //
            // Bare Exception is deliberately NOT caught: a NullReferenceException in a handler is a
            // programming error, and reporting it as a bad provider document buries a bug under a
            // plausible business failure.
            throw new FailedException($"normalizing {root.Metadata.Name} failed: {ex.Message}");
        }

        // The SHAPE of the result, never its content. Counts, a size and the handler name — an
        // author constant — are safe to log; item keys, field values and metadata are upstream data
        // and stay out of every template in this system.
        //
        // THE HANDLER NAME IS HERE BECAUSE THIS IS THE ONLY PLACE IT SURVIVES. The outbound envelope
        // says nothing about which handler ran, and a wrong-but-plausible handler produces a
        // SUCCESSFUL step — so without this line, nothing in the logs records which business was
        // applied to a document.
        var document = JsonSerializer.SerializeToUtf8Bytes(result.Document, FileDocument.Options);

        logger.LogInformation(
            "normalized {FileName} with {Handler} into {ItemCount} items, {ConvertedCount} converted, "
            + "{OutputBytes} bytes",
            root.Metadata.Name, handler.Name, result.ItemCount, result.ConvertedCount,
            document.LongLength);

        // ONE branch, on the execution id this dispatch arrived with. Not NewExecutionId(): this is
        // a transform, not a source, so the lineage it was handed is the lineage it continues.
        await SendToPostAsync(document, executionId, ct).ConfigureAwait(false);
    }

    private IProviderHandler Resolve(SKNormalizerConfig? config)
    {
        if (config is null)
        {
            throw BadPayload("SKNormalizer needs Handler");
        }

        if (string.IsNullOrWhiteSpace(config.Handler))
        {
            throw BadPayload("Handler is empty");
        }

        return registry.Find(config.Handler)
               ?? throw BadPayload(
                   $"no provider handler named '{config.Handler}'; this build carries "
                   + $"{string.Join(", ", registry.Names)}");
    }

    // THE TWO FAILURE CLASSES, AND NEITHER LOGS. ProcessDispatchHandler catches FailedException and
    // writes the author's message verbatim, so a line here would emit every failure twice. The
    // message text IS the contract an operator searches.
    private static FailedException BadPayload(string reason)
        => new($"step payload rejected: {reason}");

    private static FileNode ReadDocument(byte[] data)
    {
        FileNode? node;
        string reason;

        try
        {
            node = JsonSerializer.Deserialize<FileNode>(data, FileDocument.Options);

            // A successful parse can still hand back null: the bytes were valid JSON whose value was
            // literally `null`, or empty. A different fault than malformed JSON, so it gets its own
            // reason. Overwritten below if the node turns out non-null.
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
            // document must be refused before the assembler's own bound is reached.
            node = null;
            reason = "the branch is not JSON";
        }

        if (node is not null)
        {
            if (node.Metadata.Name is not { Length: > 0 })
            {
                // Caught here rather than one hop later, where the post handler reports Failed with
                // EntryId Guid.Empty, no payload and no name -- nothing an operator could act on.
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
