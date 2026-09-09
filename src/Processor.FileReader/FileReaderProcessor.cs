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
            if (Path.IsPathRooted(filePath))
            {
                return filePath;
            }

            reason = "the path is relative, and only an absolute path names one location";
        }
        else if (locator is not null)
        {
            reason = "the branch carries no filePath";
        }

        // Logged BEFORE the throw. The thrown message reaches the framework; this line is what an
        // operator's saved query matches on, and step failures log at Information in this system so
        // the level distinguishes nothing.
        logger.LogInformation("input branch did not name a file path: {Reason}", reason);
        throw new FailedException($"input branch did not name a file path: {reason}");
    }
}
