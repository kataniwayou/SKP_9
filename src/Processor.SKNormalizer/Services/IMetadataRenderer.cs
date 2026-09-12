namespace Processor.SKNormalizer;

/// <summary>
/// Turns the metadata a handler described into bytes. Purely mechanical — encoding, declaration,
/// escaping. <b>A handler describes the document; it never writes angle brackets.</b>
/// </summary>
internal interface IMetadataRenderer
{
    byte[] Render(StandardMetadata metadata);
}
