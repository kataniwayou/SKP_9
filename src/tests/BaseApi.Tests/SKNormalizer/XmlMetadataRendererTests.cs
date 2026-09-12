using System.Text;
using Processor.SKNormalizer;
using Xunit;

namespace BaseApi.Tests.SKNormalizer;

public sealed class XmlMetadataRendererTests
{
    private static string Golden()
        => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Schemas", "standard-metadata.xml"));

    private static string Render(StandardMetadata metadata)
        => Encoding.UTF8.GetString(new XmlMetadataRenderer().Render(metadata));

    /// <summary>Every element populated — the shape the golden file pins.</summary>
    private static StandardMetadata Full() => new()
    {
        Provider = "Acme",
        OriginalName = "track01.json",
        IngestedUtc = new DateTimeOffset(2026, 9, 12, 4, 31, 0, TimeSpan.Zero),
        Title = "Nocturne in E-flat",
        Artist = "Unknown",
        Album = "Field Recordings",
        RecordedUtc = new DateTimeOffset(2026, 3, 4, 5, 6, 7, TimeSpan.Zero),
        AudioFileName = "track01.wav",
        Codec = "pcm_s16le",
        DurationSeconds = 184.2,
        SampleRateHz = 44100,
        Channels = 2,
        BitrateKbps = 1411,
    };

    /// <summary>Only the five required elements.</summary>
    private static StandardMetadata Minimal() => new()
    {
        Provider = "Acme",
        OriginalName = "track01.json",
        IngestedUtc = new DateTimeOffset(2026, 9, 12, 4, 31, 0, TimeSpan.Zero),
        Title = "Nocturne in E-flat",
        AudioFileName = "track01.wav",
    };

    [Fact]
    public void AFullyPopulatedDocumentMatchesTheGoldenFileExactly()
    {
        // THE CANONICAL SHAPE, PINNED. Every handler emits this structure and only the values
        // differ, so the structure needs one place that fails when it drifts. Compared as text with
        // line endings normalised -- the file is checked in and git may rewrite its endings.
        Assert.Equal(
            Golden().ReplaceLineEndings("\n").TrimEnd(),
            Render(Full()).ReplaceLineEndings("\n").TrimEnd());
    }

    [Fact]
    public void AnUnknownOptionalElementIsOmittedRatherThanEmptied()
    {
        // An empty <durationSeconds/> is a claim that the duration is nothing; an absent element is
        // the truth. NormalizedAudio already sets this rule for a probe that could not determine a
        // value -- see the design's §5.3.
        var xml = Render(Minimal());

        Assert.DoesNotContain("durationSeconds", xml, StringComparison.Ordinal);
        Assert.DoesNotContain("<artist", xml, StringComparison.Ordinal);
        Assert.DoesNotContain("<album", xml, StringComparison.Ordinal);
        Assert.DoesNotContain("<codec", xml, StringComparison.Ordinal);
    }

    [Fact]
    public void TheRequiredElementsAreAlwaysPresent()
    {
        var xml = Render(Minimal());

        Assert.Contains("<provider>Acme</provider>", xml, StringComparison.Ordinal);
        Assert.Contains("<originalName>track01.json</originalName>", xml, StringComparison.Ordinal);
        Assert.Contains("<ingestedUtc>2026-09-12T04:31:00Z</ingestedUtc>", xml, StringComparison.Ordinal);
        Assert.Contains("<title>Nocturne in E-flat</title>", xml, StringComparison.Ordinal);
        Assert.Contains("<fileName>track01.wav</fileName>", xml, StringComparison.Ordinal);
    }

    [Fact]
    public void ADecimalIsRenderedInvariantlyWhateverTheMachinesLocale()
    {
        // NOT COSMETIC. On a comma-decimal locale an unpinned ToString() renders 184,2, and the same
        // handler would then produce a different document on a different node.
        var previous = Thread.CurrentThread.CurrentCulture;

        try
        {
            Thread.CurrentThread.CurrentCulture = new System.Globalization.CultureInfo("de-DE");

            Assert.Contains("<durationSeconds>184.2</durationSeconds>", Render(Full()),
                            StringComparison.Ordinal);
        }
        finally
        {
            Thread.CurrentThread.CurrentCulture = previous;
        }
    }

    [Fact]
    public void ValuesAreEscaped()
    {
        // Upstream content reaching the document unescaped is how a standardized file becomes
        // unparseable for its consumer.
        var metadata = Minimal();
        metadata.Title = "Rock & Roll <live>";

        Assert.Contains("Rock &amp; Roll &lt;live&gt;", Render(metadata), StringComparison.Ordinal);
    }

    [Fact]
    public void TheDocumentIsUtf8WithNoByteOrderMark()
    {
        var metadata = Minimal();
        metadata.Title = "Café";

        var bytes = new XmlMetadataRenderer().Render(metadata);

        Assert.Contains("utf-8", Encoding.UTF8.GetString(bytes), StringComparison.OrdinalIgnoreCase);
        // No BOM: a consumer reading this as text should not meet three surprise bytes.
        Assert.NotEqual(0xEF, bytes[0]);
    }

    [Fact]
    public void AnUnsetMetadataReportsItselfUnset()
    {
        Assert.True(new StandardMetadata().IsUnset);
        Assert.False(Minimal().IsUnset);
    }

    [Fact]
    public void MissingRequiredNamesEveryAbsentRequiredElementByItsPath()
    {
        // The message an operator reads. Paths, not property names -- they are looking at an XML
        // document, not at this class.
        var metadata = new StandardMetadata { Title = "Nocturne in E-flat" };

        var missing = metadata.MissingRequired();

        Assert.Contains("source/provider", missing);
        Assert.Contains("source/originalName", missing);
        Assert.Contains("source/ingestedUtc", missing);
        Assert.Contains("audio/fileName", missing);
        Assert.DoesNotContain("descriptive/title", missing);
    }

    [Fact]
    public void AFullyPopulatedMetadataIsMissingNothing()
    {
        Assert.Empty(Full().MissingRequired());
    }
}
