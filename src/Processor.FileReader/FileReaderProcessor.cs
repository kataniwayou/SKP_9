using System.Text.Json;
using BaseProcessor.Core.Configuration;
using BaseProcessor.Core.Processing;
using Microsoft.Extensions.Logging;

namespace Processor.FileReader;

/// <summary>
/// Turns a file path into one structured document. A plain downstream transform: it has an input and
/// it produces output, so it is not an edge and neither <c>BaseImporter</c> nor <c>BaseExporter</c>
/// applies.
/// </summary>
public sealed class FileReaderProcessor(ILogger<FileReaderProcessor> logger)
    : BaseProcessor<FileReaderConfig>
{
    protected override Task ProcessAsync(
        byte[] data, FileReaderConfig? config, Guid executionId, CancellationToken ct)
    {
        var path = ReadPath(data);

        // Not used by this task's failure path — the framework's own catch logs a thrown
        // FailedException verbatim, so there is nothing for this step to log on that route. Task 4
        // adds the success line that gives this parameter a use.
        _ = logger;
        _ = config;
        _ = executionId;
        _ = ct;
        throw new NotImplementedException($"Task 3 onwards: {path}");
    }

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
