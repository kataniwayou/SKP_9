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
        _ = logger;
        throw new NotImplementedException("Task 2 onwards");
    }
}
