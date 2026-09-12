namespace Processor.SKNormalizer;

internal interface ITreeAssembler
{
    /// <summary>Builds the output document, refusing anything ArchiveCollapser would refuse.</summary>
    /// <exception cref="NormalizationException">The layout cannot be collapsed.</exception>
    FileNode Assemble(OutputLayout layout);
}
