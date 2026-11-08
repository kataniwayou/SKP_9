using BaseProcessor.Core.Processing;

namespace Processor.Napole;

public sealed class NapoleProcessor : BaseProcessor<NapoleConfig>
{
    protected override Task ProcessAsync(
        byte[] data, NapoleConfig? config, Guid executionId, CancellationToken ct)
        => throw new FailedException("not implemented");
}
