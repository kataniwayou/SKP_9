using System.Text;
using Processor.SKNormalizer;
using Xunit;

namespace BaseApi.Tests.SKNormalizer;

public sealed class XmlMetadataRendererTests
{
    private static string Render(StandardMetadata metadata)
        => Encoding.UTF8.GetString(new XmlMetadataRenderer().Render(metadata));

    [Fact]
    public void ElementsAreRenderedInTheOrderTheyWereSet()
    {
        // The whole reason StandardMetadata is ordered: two runs of one handler must diff cleanly.
        var metadata = new StandardMetadata { RootName = "track" };
        metadata.Set("title", "Nocturne");
        metadata.Set("artist", "Unknown");

        var xml = Render(metadata);

        Assert.True(xml.IndexOf("title", StringComparison.Ordinal)
                    < xml.IndexOf("artist", StringComparison.Ordinal));
    }

    [Fact]
    public void SettingAnExistingElementOverwritesItInPlace()
    {
        // Stage 7 corrects stage 3's values. A correction must not move the element.
        var metadata = new StandardMetadata();
        metadata.Set("duration", "0");
        metadata.Set("codec", "mp3");
        metadata.Set("duration", "184");

        var xml = Render(metadata);

        Assert.Contains("<duration>184</duration>", xml, StringComparison.Ordinal);
        Assert.DoesNotContain("<duration>0</duration>", xml, StringComparison.Ordinal);
        Assert.True(xml.IndexOf("duration", StringComparison.Ordinal)
                    < xml.IndexOf("codec", StringComparison.Ordinal));
    }

    [Fact]
    public void ValuesAreEscaped()
    {
        // Upstream content reaching a document unescaped is how a standardized file becomes
        // unparseable for its consumer.
        var metadata = new StandardMetadata();
        metadata.Set("title", "Rock & Roll <live>");

        var xml = Render(metadata);

        Assert.Contains("Rock &amp; Roll &lt;live&gt;", xml, StringComparison.Ordinal);
    }

    [Fact]
    public void TheDocumentIsUtf8AndDeclaresIt()
    {
        var metadata = new StandardMetadata();
        metadata.Set("title", "Café");

        var bytes = new XmlMetadataRenderer().Render(metadata);

        Assert.Contains("utf-8", Encoding.UTF8.GetString(bytes), StringComparison.OrdinalIgnoreCase);
        // No BOM: a consumer reading this as text should not meet three surprise bytes.
        Assert.NotEqual(0xEF, bytes[0]);
    }

    [Fact]
    public void AnEmptyMetadataRendersAnEmptyRootRatherThanThrowing()
    {
        var xml = Render(new StandardMetadata { RootName = "track" });

        Assert.Contains("track", xml, StringComparison.Ordinal);
    }
}
