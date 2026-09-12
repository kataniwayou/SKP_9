using System.Text;
using System.Xml;

namespace Processor.SKNormalizer;

internal sealed class XmlMetadataRenderer : IMetadataRenderer
{
    private static readonly XmlWriterSettings Settings = new()
    {
        Indent = true,
        // UTF8Encoding(false): NO BOM. A consumer reading the standardized file as text should not
        // meet three surprise bytes before the declaration.
        Encoding = new UTF8Encoding(false),
    };

    public byte[] Render(StandardMetadata metadata)
    {
        ArgumentNullException.ThrowIfNull(metadata);

        using var buffer = new MemoryStream();

        using (var writer = XmlWriter.Create(buffer, Settings))
        {
            writer.WriteStartDocument();
            writer.WriteStartElement(metadata.RootName);

            // IN ORDER, and WriteElementString escapes the value. Upstream content reaching the
            // document unescaped is how a standardized file becomes unparseable for its consumer.
            foreach (var element in metadata.Elements)
            {
                writer.WriteElementString(element.Key, element.Value);
            }

            writer.WriteEndElement();
            writer.WriteEndDocument();
        }

        return buffer.ToArray();
    }
}
