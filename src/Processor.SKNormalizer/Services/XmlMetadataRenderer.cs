using System.Globalization;
using System.Text;
using System.Xml;

namespace Processor.SKNormalizer;

/// <summary>
/// THE SINGLE DEFINITION of the standardized document's structure and element order (design §7.3).
/// <para>
/// Because the vocabulary is fixed and this is the only code that writes it, "every handler emits
/// the same document" is true by construction — there is no code path by which a handler could emit
/// a different shape.
/// </para>
/// </summary>
internal sealed class XmlMetadataRenderer : IMetadataRenderer
{
    private static readonly XmlWriterSettings Settings = new()
    {
        Indent = true,
        // UTF8Encoding(false): NO BOM. A consumer reading the standardized file as text should not
        // meet three surprise bytes before the declaration.
        Encoding = new UTF8Encoding(false),
    };

    /// <summary>
    /// Timestamps are rendered in this ONE form, not round-trip "O": "O" carries fractional seconds
    /// whose digit count varies with the value, so two documents describing the same instant could
    /// differ textually.
    /// </summary>
    private const string TimestampFormat = "yyyy-MM-ddTHH:mm:ssZ";

    public byte[] Render(StandardMetadata metadata)
    {
        ArgumentNullException.ThrowIfNull(metadata);

        using var buffer = new MemoryStream();

        using (var writer = XmlWriter.Create(buffer, Settings))
        {
            writer.WriteStartDocument();
            writer.WriteStartElement("metadata");

            writer.WriteStartElement("source");
            Text(writer, "provider", metadata.Provider);
            Text(writer, "originalName", metadata.OriginalName);
            Stamp(writer, "ingestedUtc", metadata.IngestedUtc);
            writer.WriteEndElement();

            writer.WriteStartElement("descriptive");
            Text(writer, "title", metadata.Title);
            Text(writer, "artist", metadata.Artist);
            Text(writer, "album", metadata.Album);
            Stamp(writer, "recordedUtc", metadata.RecordedUtc);
            writer.WriteEndElement();

            writer.WriteStartElement("audio");
            Text(writer, "fileName", metadata.AudioFileName);
            Text(writer, "codec", metadata.Codec);
            Number(writer, "durationSeconds", metadata.DurationSeconds);
            Number(writer, "sampleRateHz", metadata.SampleRateHz);
            Number(writer, "channels", metadata.Channels);
            Number(writer, "bitrateKbps", metadata.BitrateKbps);
            writer.WriteEndElement();

            writer.WriteEndElement();
            writer.WriteEndDocument();
        }

        return buffer.ToArray();
    }

    // OMITTED, NOT EMPTIED. An empty <durationSeconds/> is a claim that the duration is nothing; an
    // absent element is the truth. WriteElementString escapes the value, which is what keeps
    // upstream content from making the document unparseable for its consumer.
    private static void Text(XmlWriter writer, string name, string? value)
    {
        if (value is not null)
        {
            writer.WriteElementString(name, value);
        }
    }

    private static void Stamp(XmlWriter writer, string name, DateTimeOffset? value)
    {
        if (value is { } stamp)
        {
            writer.WriteElementString(
                name, stamp.ToUniversalTime().ToString(TimestampFormat, CultureInfo.InvariantCulture));
        }
    }

    // INVARIANT CULTURE, AND IT IS NOT COSMETIC. On a comma-decimal locale an unpinned ToString()
    // renders 184,2, and the same handler would produce a different document on a different node.
    private static void Number(XmlWriter writer, string name, double? value)
    {
        if (value is { } number)
        {
            writer.WriteElementString(name, number.ToString(CultureInfo.InvariantCulture));
        }
    }

    private static void Number(XmlWriter writer, string name, int? value)
    {
        if (value is { } number)
        {
            writer.WriteElementString(name, number.ToString(CultureInfo.InvariantCulture));
        }
    }
}
