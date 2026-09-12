# SKNormalizer: the canonical XML and the first mapping handler — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the standardized XML vocabulary shared by every SKNormalizer handler, and ship `AcmeHandler` — the first handler that actually maps a provider's metadata into it.

**Architecture:** `StandardMetadata` stops being a key/value bag and becomes a fixed-shape type whose properties are the canonical elements; `XmlMetadataRenderer` becomes the single definition of the document's structure and order. `AcmeHandler` pairs a `.wav` with its `.json` sidecar, maps the JSON, passes the audio through byte-for-byte, and overrides `LayoutFor` to emit a `.zip` with two entries at depth 1. `SampleHandler` stays shipped as the pipeline's identity regression test.

**Tech Stack:** C# / .NET 8, `System.Text.Json` (reading the sidecar), `System.Xml` (writing the document), xUnit, Python 3 (the seed tool).

**Spec:** `docs/superpowers/specs/2026-09-12-sknormalizer-design.md` — §7.2, §7.3 and §8 are the sections this plan implements.

## Global Constraints

- **Target framework `net8.0`**, `Nullable=enable`, `ImplicitUsings=enable`, `LangVersion=latest`, **`TreatWarningsAsErrors=true`** — all from the repo-root `Directory.Build.props`. Never restate them in a csproj.
- **Package versions come from `Directory.Packages.props`.** Never add `Version=` to a `PackageReference`.
- **Do not modify** `src/BaseProcessor.Core/`, `src/Processor.ArchiveCollapser/`, or `src/Processor.ArchiveExpander/`.
- **Every handler emits the same document.** Element names and structure are fixed (§7.3); only values differ. No handler may add, rename or reorder an element.
- **Required elements:** `source/provider`, `source/originalName`, `source/ingestedUtc`, `descriptive/title`, `audio/fileName`. **Optional elements are omitted entirely when unknown — never emitted empty.**
- **Every value is formatted with `CultureInfo.InvariantCulture`; timestamps as `yyyy-MM-ddTHH:mm:ssZ`.** A comma-decimal locale would otherwise render `184,2` and the same handler would produce different documents on different nodes.
- **Log templates carry counts, sizes, author constants and the root file name.** Never item keys, field values, metadata or payload fragments.
- **Nothing logs before throwing `FailedException`** — the framework writes that message verbatim at Warning.
- **`dotnet test --filter` is silently ignored in this repo** (MTP runner). Isolate with `dotnet build tests/BaseApi.Tests/BaseApi.Tests.csproj` then `tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class <FULLY.QUALIFIED.ClassName>` — a bare class name matches nothing.
- **Baseline:** the suite is **1150 passed / 33 skipped / 1183 total / 0 failed** before Task 1.

---

## File Structure

| file | change |
|---|---|
| `src/Processor.SKNormalizer/Pipeline/StandardMetadata.cs` | **rewrite** — fixed-shape type |
| `src/Processor.SKNormalizer/Services/XmlMetadataRenderer.cs` | **rewrite** — writes the canonical structure |
| `src/Processor.SKNormalizer/Pipeline/NormalizationPipeline.cs` | modify — the tri-state check replaces `IsEmpty` |
| `src/Processor.SKNormalizer/Handlers/AcmeHandler.cs` | **new** |
| `src/Processor.SKNormalizer/ProcessorHost.cs` | modify — one registration |
| `src/tests/BaseApi.Tests/Schemas/sknormalizer-config.json` | modify — `enum` gains `"Acme"` |
| `src/tests/BaseApi.Tests/Schemas/standard-metadata.xml` | **new** — the golden reference document |
| `src/tests/BaseApi.Tests/BaseApi.Tests.csproj` | modify — copy `Schemas\*.xml` too |
| `src/tests/BaseApi.Tests/SKNormalizer/XmlMetadataRendererTests.cs` | **rewrite** |
| `src/tests/BaseApi.Tests/SKNormalizer/AcmeHandlerTests.cs` | **new** |
| `src/tests/BaseApi.Tests/SKNormalizer/NormalizationPipelineTests.cs` | modify — `Set(...)` call sites |
| `src/tests/BaseApi.Tests/SKNormalizer/ProviderHandlerBaseTests.cs` | modify — one `Set(...)` call site |
| `src/tests/BaseApi.Tests/EnvelopeContractTests.cs` | modify — the Acme chain test |
| `tools/make-sample-archives.py` | **new** — builds the seed zips |

---

### Task 1: The canonical `StandardMetadata` and renderer

The type change breaks every existing call site, so the rewrite, the pipeline check and the call-site fixes must land together or the tree does not build.

**Files:**
- Rewrite: `src/Processor.SKNormalizer/Pipeline/StandardMetadata.cs`
- Rewrite: `src/Processor.SKNormalizer/Services/XmlMetadataRenderer.cs`
- Modify: `src/Processor.SKNormalizer/Pipeline/NormalizationPipeline.cs:63-67`
- Create: `src/tests/BaseApi.Tests/Schemas/standard-metadata.xml`
- Modify: `src/tests/BaseApi.Tests/BaseApi.Tests.csproj:75`
- Rewrite: `src/tests/BaseApi.Tests/SKNormalizer/XmlMetadataRendererTests.cs`
- Modify: `src/tests/BaseApi.Tests/SKNormalizer/NormalizationPipelineTests.cs:62,90`
- Modify: `src/tests/BaseApi.Tests/SKNormalizer/ProviderHandlerBaseTests.cs:119`

**Interfaces:**
- Consumes: `NormalizedAudio`, `ItemNames` (unchanged).
- Produces:
  - `StandardMetadata` with settable properties `Provider`, `OriginalName`, `IngestedUtc`, `Title`, `Artist`, `Album`, `RecordedUtc`, `AudioFileName`, `Codec`, `DurationSeconds`, `SampleRateHz`, `Channels`, `BitrateKbps`; plus `bool IsUnset { get; }` and `IReadOnlyList<string> MissingRequired()`.
  - `XmlMetadataRenderer.Render(StandardMetadata) -> byte[]` (unchanged signature).
  - `StandardMetadata.Set(string, string)`, `TryGet`, `Elements`, `RootName` and `IsEmpty` are **gone**.

- [ ] **Step 1: Write the golden reference document**

Create `src/tests/BaseApi.Tests/Schemas/standard-metadata.xml`. This is the canonical shape — every handler's output must match it structurally.

```xml
<?xml version="1.0" encoding="utf-8"?>
<metadata>
  <source>
    <provider>Acme</provider>
    <originalName>track01.json</originalName>
    <ingestedUtc>2026-09-12T04:31:00Z</ingestedUtc>
  </source>
  <descriptive>
    <title>Nocturne in E-flat</title>
    <artist>Unknown</artist>
    <album>Field Recordings</album>
    <recordedUtc>2026-03-04T05:06:07Z</recordedUtc>
  </descriptive>
  <audio>
    <fileName>track01.wav</fileName>
    <codec>pcm_s16le</codec>
    <durationSeconds>184.2</durationSeconds>
    <sampleRateHz>44100</sampleRateHz>
    <channels>2</channels>
    <bitrateKbps>1411</bitrateKbps>
  </audio>
</metadata>
```

Then make the test project copy it — `BaseApi.Tests.csproj:75` currently copies only `Schemas\*.json`. Add beside it:

```xml
    <!-- The golden standardized-metadata document. Beside the JSON schemas for the same reason:
         these files are the contracts, and the tests read them from the output directory. -->
    <Content Include="Schemas\*.xml" CopyToOutputDirectory="PreserveNewest" />
```

- [ ] **Step 2: Write the failing renderer tests**

Replace the whole of `src/tests/BaseApi.Tests/SKNormalizer/XmlMetadataRendererTests.cs`:

```csharp
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
```

- [ ] **Step 3: Run to verify they fail**

```bash
cd C:/Users/UserL/source/repos/SK_P9/src
dotnet build tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: compile errors — `StandardMetadata` has no such properties yet.

- [ ] **Step 4: Write the new `StandardMetadata`**

Replace the whole of `src/Processor.SKNormalizer/Pipeline/StandardMetadata.cs`:

```csharp
namespace Processor.SKNormalizer;

/// <summary>
/// The standardized metadata document under construction, as a FIXED SHAPE rather than a bag of
/// keys. Its properties are exactly the elements of the canonical XML (design §7.3).
/// <para>
/// <b>Every handler emits the same document; only the values differ.</b> An earlier draft gave this
/// type <c>Set(string, string)</c> and an ordered element list, which let any handler invent a key,
/// misspell one, or omit one with nothing noticing — the document still rendered, just differently
/// from every other handler's. Named properties make an invented key impossible and a misspelled one
/// a compile error.
/// </para>
/// <para>
/// <b>Mutable rather than a record, because the values arrive across three stages.</b> <c>Map</c>
/// writes the provider's own metadata, <c>Augment</c> the constants it knows, and <c>Reconcile</c>
/// overwrites <see cref="Codec"/>, <see cref="DurationSeconds"/> and <see cref="BitrateKbps"/> with
/// what a conversion actually produced. The handler interface hands the same instance to each, so
/// required fields are checked by <see cref="MissingRequired"/> rather than enforced by the compiler.
/// </para>
/// </summary>
public sealed class StandardMetadata
{
    // ---- <source> : provenance. All three are required; the system always knows them. ----

    /// <summary>Which handler produced this. An author constant, set by <c>Augment</c>.</summary>
    public string? Provider { get; set; }

    /// <summary>The name of the provider file this was mapped from, set by <c>Map</c>.</summary>
    public string? OriginalName { get; set; }

    /// <summary>When this document was produced.</summary>
    public DateTimeOffset? IngestedUtc { get; set; }

    // ---- <descriptive> : the provider's own metadata. Where per-provider mapping work lives. ----

    /// <summary>Required — a standardized file with no title is not usable downstream.</summary>
    public string? Title { get; set; }

    public string? Artist { get; set; }

    public string? Album { get; set; }

    public DateTimeOffset? RecordedUtc { get; set; }

    // ---- <audio> : per-file fact. Claimed by the provider, corrected by Reconcile. ----

    /// <summary>Required — the name of the audio file this document describes, AS EMITTED.</summary>
    public string? AudioFileName { get; set; }

    /// <summary>
    /// Null when unknown, and it must stay null rather than being guessed: a probe that could not
    /// determine a value must not have one invented (design §5.3). The renderer omits the element.
    /// </summary>
    public string? Codec { get; set; }

    public double? DurationSeconds { get; set; }

    public int? SampleRateHz { get; set; }

    public int? Channels { get; set; }

    public int? BitrateKbps { get; set; }

    /// <summary>
    /// True when the handler populated nothing at all. <b>This is what keeps an identity handler
    /// possible</b>: the pipeline renders no document, and the mirror carries the source leaf
    /// through unchanged. Distinct from an INCOMPLETE document, which is a failure.
    /// </summary>
    public bool IsUnset
        => Provider is null && OriginalName is null && IngestedUtc is null
           && Title is null && Artist is null && Album is null && RecordedUtc is null
           && AudioFileName is null && Codec is null && DurationSeconds is null
           && SampleRateHz is null && Channels is null && BitrateKbps is null;

    /// <summary>
    /// The required elements this document is still missing, by their XML path.
    /// <para>
    /// <b>Paths, not property names.</b> The operator reading the failure is looking at an XML
    /// document, not at this class.
    /// </para>
    /// </summary>
    public IReadOnlyList<string> MissingRequired()
    {
        var missing = new List<string>();

        if (string.IsNullOrWhiteSpace(Provider))
        {
            missing.Add("source/provider");
        }

        if (string.IsNullOrWhiteSpace(OriginalName))
        {
            missing.Add("source/originalName");
        }

        if (IngestedUtc is null)
        {
            missing.Add("source/ingestedUtc");
        }

        if (string.IsNullOrWhiteSpace(Title))
        {
            missing.Add("descriptive/title");
        }

        if (string.IsNullOrWhiteSpace(AudioFileName))
        {
            missing.Add("audio/fileName");
        }

        return missing;
    }
}
```

- [ ] **Step 5: Write the new `XmlMetadataRenderer`**

Replace the whole of `src/Processor.SKNormalizer/Services/XmlMetadataRenderer.cs`:

```csharp
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
```

- [ ] **Step 6: Replace the pipeline's `IsEmpty` check with the tri-state**

In `src/Processor.SKNormalizer/Pipeline/NormalizationPipeline.cs`, replace the block at lines 63-67 (the comment and the `var document = metadata.IsEmpty ? null : renderer.Render(metadata);` line) with:

```csharp
            // ARTIFACT EMISSION IS OPTIONAL, AND INCOMPLETENESS IS A FAILURE. Three states, not two:
            // a handler that populated nothing gets no document and its leaf passes through (that is
            // what keeps an identity handler possible); a handler that populated SOME of it and left
            // a required element unset is a bug reported by name rather than a quietly different
            // file; anything else renders.
            byte[]? document = null;

            if (!metadata.IsUnset)
            {
                if (metadata.MissingRequired() is { Count: > 0 } missing)
                {
                    throw new NormalizationException(
                        $"the standardized metadata is missing {string.Join(", ", missing)}");
                }

                document = renderer.Render(metadata);
            }
```

- [ ] **Step 7: Fix the three broken `Set(...)` call sites**

These are test doubles that only needed *some* metadata; give them the required five so they still render.

`src/tests/BaseApi.Tests/SKNormalizer/NormalizationPipelineTests.cs:62` — inside `RecordingHandler.Map`, replace `metadata.Set("key", item.Key);` with:

```csharp
            var metadata = new StandardMetadata
            {
                Provider = "Recording",
                OriginalName = item.Key,
                IngestedUtc = new DateTimeOffset(2026, 9, 12, 4, 31, 0, TimeSpan.Zero),
                Title = item.Key,
                AudioFileName = item.Key,
            };
```

(delete the `var metadata = new StandardMetadata();` line it replaces).

`NormalizationPipelineTests.cs:90` — inside `RecordingHandler.Reconcile`, replace `metadata.Set("duration", duration.TotalSeconds.ToString("F0"));` with:

```csharp
                metadata.DurationSeconds = duration.TotalSeconds;
```

`src/tests/BaseApi.Tests/SKNormalizer/ProviderHandlerBaseTests.cs:119` — replace `metadata.Set("key", "a.wav");` with whatever that test needs to make the metadata non-unset; the minimum is:

```csharp
        metadata.Title = "a.wav";
```

Read the surrounding test first — if it asserts on rendered output rather than merely on non-emptiness, populate all five required fields instead.

- [ ] **Step 8: Run the full suite**

```bash
cd C:/Users/UserL/source/repos/SK_P9/src
dotnet build tests/BaseApi.Tests/BaseApi.Tests.csproj
tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class BaseApi.Tests.SKNormalizer.XmlMetadataRendererTests
dotnet test tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: 9 renderer tests pass; full suite green. The count moves from 1150 by whatever the renderer file's net test delta is — account for it.

- [ ] **Step 9: Commit**

```bash
cd C:/Users/UserL/source/repos/SK_P9
git add src/Processor.SKNormalizer src/tests/BaseApi.Tests
git commit -m "feat(sknormalizer): fix the canonical metadata shape in the type, not in convention"
```

---

### Task 2: `AcmeHandler`

**Files:**
- Create: `src/Processor.SKNormalizer/Handlers/AcmeHandler.cs`
- Test: `src/tests/BaseApi.Tests/SKNormalizer/AcmeHandlerTests.cs`

**Interfaces:**
- Consumes: `ProviderHandlerBase`, `StandardMetadata`, `SourceItem`, `ItemNames`, `OutputLayout`, `OutputNode`, `NormalizedItem`, `NormalizationException`, and `TimeProvider` (injected, so the test can pin `IngestedUtc`).
- Produces: `public sealed class AcmeHandler(TimeProvider clock) : ProviderHandlerBase` with `Name => "Acme"`.

- [ ] **Step 1: Write the failing tests**

Create `src/tests/BaseApi.Tests/SKNormalizer/AcmeHandlerTests.cs`:

```csharp
using System.Text;
using Microsoft.Extensions.Time.Testing;
using Processor.SKNormalizer;
using Xunit;

namespace BaseApi.Tests.SKNormalizer;

public sealed class AcmeHandlerTests
{
    private static DateTime Stamp => new(2026, 3, 4, 5, 6, 7, DateTimeKind.Utc);

    private const string Sidecar = """
        {
          "title": "Nocturne in E-flat",
          "artist": "Unknown",
          "album": "Field Recordings",
          "recordedUtc": "2026-03-04T05:06:07Z",
          "audio": { "file": "track01.wav", "sampleRateHz": 44100, "channels": 2, "durationSeconds": 184.2 }
        }
        """;

    private static FileNode Leaf(string name, byte[] content)
        => new(
            new FileMetadata(name, Path.GetExtension(name), content.LongLength, null, Stamp, 0),
            new FileContent.Bytes(content));

    private static FileNode Leaf(string name, string text)
        => Leaf(name, Encoding.UTF8.GetBytes(text));

    private static FileNode Archive(params FileNode[] entries)
        => new(
            new FileMetadata("bundle.zip", ".zip", 4096, null, Stamp, entries.Length),
            new FileContent.Entries(entries));

    private static AcmeHandler Handler()
        => new(new FakeTimeProvider(new DateTimeOffset(2026, 9, 12, 4, 31, 0, TimeSpan.Zero)));

    private static readonly byte[] Wav = [0x52, 0x49, 0x46, 0x46, 0x01, 0x02, 0x03, 0x04];

    [Fact]
    public void LocatePairsTheAudioAndItsSidecarIntoOneItem()
    {
        var item = Assert.Single(
            Handler().Locate(Archive(Leaf("track01.wav", Wav), Leaf("track01.json", Sidecar))));

        Assert.Equal(2, item.Nodes.Count);
    }

    [Fact]
    public void AnItemMissingItsSidecarIsRejectedByName()
    {
        // The operator's whole diagnostic: a document of forty items whose ninth is malformed is
        // useless unless the message says which.
        var handler = Handler();
        var item = Assert.Single(handler.Locate(Archive(Leaf("track01.wav", Wav))));

        var ex = Assert.Throws<NormalizationException>(() => handler.ValidateContent(item));

        Assert.Contains("track01", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void AnItemMissingItsAudioIsRejected()
    {
        var handler = Handler();
        var item = Assert.Single(handler.Locate(Archive(Leaf("track01.json", Sidecar))));

        Assert.Throws<NormalizationException>(() => handler.ValidateContent(item));
    }

    [Fact]
    public void MalformedJsonIsABusinessFailureThatDoesNotQuoteTheContent()
    {
        // The parse error quotes the fragment that failed, and that fragment is upstream content --
        // it must not reach a log store, and a FailedException message IS logged verbatim.
        var handler = Handler();
        var item = Assert.Single(handler.Locate(
            Archive(Leaf("track01.wav", Wav), Leaf("track01.json", """{"title":"secret-value"""))));

        var ex = Assert.Throws<NormalizationException>(() => handler.Map(item));

        Assert.DoesNotContain("secret-value", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void MapProjectsEveryDescriptiveFieldAndTheProviderStatedAudioFacts()
    {
        var handler = Handler();
        var item = Assert.Single(handler.Locate(
            Archive(Leaf("track01.wav", Wav), Leaf("track01.json", Sidecar))));

        var metadata = handler.Map(item);

        Assert.Equal("Nocturne in E-flat", metadata.Title);
        Assert.Equal("Unknown", metadata.Artist);
        Assert.Equal("Field Recordings", metadata.Album);
        Assert.Equal(new DateTimeOffset(2026, 3, 4, 5, 6, 7, TimeSpan.Zero), metadata.RecordedUtc);
        Assert.Equal(44100, metadata.SampleRateHz);
        Assert.Equal(2, metadata.Channels);
        Assert.Equal(184.2, metadata.DurationSeconds);
        // The name of the file it was mapped FROM -- provenance, not the audio.
        Assert.Equal("track01.json", metadata.OriginalName);
    }

    [Fact]
    public void AugmentSuppliesTheProviderConstantAndTheIngestTime()
    {
        var handler = Handler();
        var item = Assert.Single(handler.Locate(
            Archive(Leaf("track01.wav", Wav), Leaf("track01.json", Sidecar))));

        var metadata = handler.Map(item);
        handler.Augment(metadata, item);

        Assert.Equal("Acme", metadata.Provider);
        Assert.Equal(new DateTimeOffset(2026, 9, 12, 4, 31, 0, TimeSpan.Zero), metadata.IngestedUtc);
    }

    [Fact]
    public void TheMetadataIsCompleteAfterMapAndAugment()
    {
        // The pipeline throws on an incomplete document. This is the assertion that the handler
        // actually fills every required element rather than most of them.
        var handler = Handler();
        var item = Assert.Single(handler.Locate(
            Archive(Leaf("track01.wav", Wav), Leaf("track01.json", Sidecar))));

        var metadata = handler.Map(item);
        handler.Augment(metadata, item);
        handler.Reconcile(metadata, null, handler.NameFor(metadata, item));

        Assert.Empty(metadata.MissingRequired());
    }

    [Fact]
    public void TheMetadataFileIsRenamedToXmlAndTheAudioKeepsItsName()
    {
        var handler = Handler();
        var item = Assert.Single(handler.Locate(
            Archive(Leaf("track01.wav", Wav), Leaf("track01.json", Sidecar))));

        var names = handler.NameFor(handler.Map(item), item);

        Assert.Equal("track01.xml", names.MetadataFileName);
        Assert.Equal("track01.wav", names.AudioFileName);
    }

    [Fact]
    public void NothingIsTranscoded()
    {
        // The wav passes through untouched, which is why §14's open question -- which node is the
        // audio -- cannot be answered by accident here: the pipeline's guess never fires.
        var handler = Handler();
        var item = Assert.Single(handler.Locate(
            Archive(Leaf("track01.wav", Wav), Leaf("track01.json", Sidecar))));

        Assert.Null(handler.ProfileFor(item));
    }

    [Fact]
    public void LayoutForEmitsTheAudioUnchangedAndTheRenderedXmlInPlaceOfTheJson()
    {
        var handler = Handler();
        var root = Archive(Leaf("track01.wav", Wav), Leaf("track01.json", Sidecar));
        var item = Assert.Single(handler.Locate(root));

        var metadata = handler.Map(item);
        handler.Augment(metadata, item);
        var names = handler.NameFor(metadata, item);
        var document = Encoding.UTF8.GetBytes("<metadata />");

        var layout = handler.LayoutFor(root, [new NormalizedItem(item, metadata, names, null, document)]);

        Assert.Equal(".zip", layout.Root is OutputNode.Folder f ? f.ArchiveExtension : null);

        var children = Assert.IsType<OutputNode.Folder>(layout.Root).Children!;
        Assert.Equal(2, children.Count);

        var audio = Assert.IsType<OutputNode.File>(children.Single(c => c is OutputNode.File { Name: "track01.wav" }));
        Assert.Equal(Wav, audio.Content);

        var xml = Assert.IsType<OutputNode.File>(children.Single(c => c is OutputNode.File { Name: "track01.xml" }));
        Assert.Equal(document, xml.Content);
    }
}
```

> `FakeTimeProvider` is in `Microsoft.Extensions.TimeProvider.Testing`. Check whether the test project already references it (`grep -rn FakeTimeProvider src/tests/BaseApi.Tests --include=*.cs | head -3`). If it does not, do NOT add the package — instead give `AcmeHandler` a `TimeProvider` parameter defaulting to `TimeProvider.System` and construct a tiny fixed `TimeProvider` subclass inside the test file.

- [ ] **Step 2: Run to verify they fail**

```bash
cd C:/Users/UserL/source/repos/SK_P9/src
dotnet build tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: compile errors — `AcmeHandler` does not exist.

- [ ] **Step 3: Write `AcmeHandler`**

Create `src/Processor.SKNormalizer/Handlers/AcmeHandler.cs`. Write it to satisfy the tests above, following these rules:

- `Name => "Acme"`. It must match an entry in the config schema `enum` (Task 3).
- **Stateless**, like every handler — it is registered as a singleton. The injected `TimeProvider` is a dependency, not state.
- **`Locate`** groups the root's entries into items by **basename** (`Path.GetFileNameWithoutExtension`), so `track01.wav` and `track01.json` become one `SourceItem` whose `Key` is that basename. A root that is not an archive yields no items. Entries whose basename matches nothing else still become their own single-node item, so `ValidateContent` can report them rather than silently dropping them.
- **`ValidateContent`** throws `NormalizationException` unless the item holds exactly one `.wav` and one `.json`, naming the item and what was wrong.
- **`Map`** deserializes the sidecar with `JsonSerializer` into a private record mirroring the JSON, then projects: `title→Title`, `artist→Artist`, `album→Album`, `recordedUtc→RecordedUtc`, `audio.sampleRateHz→SampleRateHz`, `audio.channels→Channels`, `audio.durationSeconds→DurationSeconds`, and the sidecar's own file name → `OriginalName`. **Catch `JsonException` and rethrow as `NormalizationException` WITHOUT including the exception's message** — it quotes the fragment that failed to parse, which is upstream content.
- **`Augment`** sets `Provider = "Acme"` and `IngestedUtc = clock.GetUtcNow()`.
- **`NameFor`** returns the basename plus `.xml` for the metadata, and the audio node's original name unchanged for the audio.
- **`ProfileFor`** returns `null` — the audio passes through.
- **`Reconcile`** sets `AudioFileName = names.AudioFileName`. When `audio` is non-null it also overwrites `Codec`, `DurationSeconds` and `BitrateKbps` with the measured values — it never does today, but writing that branch is what makes the handler correct if a profile is ever added, and it documents which fields are measured rather than claimed.
- **`LayoutFor`** returns an `OutputLayout` whose root is an `OutputNode.Folder` carrying the input root's extension, size and both timestamps, with one `OutputNode.File` per item's audio node (content unchanged, name from `Names.AudioFileName`) and one per item's `MetadataDocument` (name from `Names.MetadataFileName`). **Do not call `base.LayoutFor`** — the base mirror substitutes nothing (§6.2), which is the opposite of what this handler needs.

Write a class doc comment explaining that this is the first mapping handler, that it converts no audio deliberately, and that it overrides `LayoutFor` because the base mirror substitutes nothing.

- [ ] **Step 4: Run to verify they pass**

```bash
cd C:/Users/UserL/source/repos/SK_P9/src
dotnet build tests/BaseApi.Tests/BaseApi.Tests.csproj
tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class BaseApi.Tests.SKNormalizer.AcmeHandlerTests
```

Expected: 10 passed.

- [ ] **Step 5: Commit**

```bash
cd C:/Users/UserL/source/repos/SK_P9
git add src/Processor.SKNormalizer src/tests/BaseApi.Tests
git commit -m "feat(sknormalizer): the first handler that maps a provider's metadata"
```

---

### Task 3: Registration, the config schema row, and the chain test

**Files:**
- Modify: `src/Processor.SKNormalizer/ProcessorHost.cs` (one `AddSingleton` beside `SampleHandler`'s)
- Modify: `src/tests/BaseApi.Tests/Schemas/sknormalizer-config.json`
- Modify: `src/tests/BaseApi.Tests/DependencyInjection/SKNormalizerHostTests.cs`
- Modify: `src/tests/BaseApi.Tests/EnvelopeContractTests.cs`

**Interfaces:**
- Consumes: `AcmeHandler` from Task 2.
- Produces: nothing new.

- [ ] **Step 1: Register the handler**

In `ProcessorHost.Create`, beside the existing `AddSingleton<IProviderHandler, SampleHandler>()`:

```csharp
        builder.Services.AddSingleton<IProviderHandler, AcmeHandler>();
```

`AcmeHandler` takes a `TimeProvider`. If the container does not already provide one, register `builder.Services.AddSingleton(TimeProvider.System);` — check first with `grep -rn "TimeProvider" src/Processor.SKNormalizer src/BaseProcessor.Core --include=*.cs`, since `BaseProcessor.Core` may already register it.

- [ ] **Step 2: Update the config schema enum**

In `src/tests/BaseApi.Tests/Schemas/sknormalizer-config.json`, change the `handler` enum to:

```json
      "enum": ["Acme", "Sample"]
```

Alphabetical, matching `ProviderHandlerRegistry.Names`'s ordinal ordering — `SKNormalizerConfigSchemaTests.TheEnumAndTheRegistryAreTheSameSet` compares the two sets and will tell you immediately if the order or content is wrong.

- [ ] **Step 3: Update the host test's expected handler list**

`SKNormalizerHostTests.EveryRegisteredHandlerReachesTheRegistry` asserts `["Sample"]`. Change it to `["Acme", "Sample"]`.

- [ ] **Step 4: Write the failing chain test**

Add to `src/tests/BaseApi.Tests/EnvelopeContractTests.cs`. It needs a `Normalize` overload taking a handler name — the existing helper hardcodes `{"handler":"Sample"}` and registers only `SampleHandler`. Widen it to register both handlers and take the name as a parameter, keeping every existing call site working by defaulting to `"Sample"`.

```csharp
    [Fact]
    public async Task AcmeStandardizesTheSidecarAndLeavesTheAudioUntouched()
    {
        // THE REAL PATH, END TO END: a zip of wav + json in, a zip of wav + xml out, same topology,
        // depth 1. This is the test that would catch the mirror, the assembler, the renderer or the
        // handler drifting apart from each other.
        const string sidecar = """
            {
              "title": "Nocturne in E-flat",
              "artist": "Unknown",
              "album": "Field Recordings",
              "recordedUtc": "2026-03-04T05:06:07Z",
              "audio": { "file": "track01.wav", "sampleRateHz": 44100, "channels": 2, "durationSeconds": 184.2 }
            }
            """;

        var envelope = await Fetch(
            "bundle.zip", Zip(("track01.wav", "RIFF-not-really-audio"), ("track01.json", sidecar)), AnyFile);

        var normalized = await Normalize(await Expand(envelope, """{"MaxDepth":1}"""), handler: "Acme");

        var root = JsonSerializer.Deserialize<FileNode>(normalized, FileDocument.Options)!;
        var entries = Assert.IsType<FileContent.Entries>(root.Content).Value;

        Assert.Equal(".zip", root.Metadata.Extension);
        Assert.Equal(2, entries.Count);

        var audio = entries.Single(e => e.Metadata.Name == "track01.wav");
        Assert.Equal(
            "RIFF-not-really-audio",
            Encoding.UTF8.GetString(Assert.IsType<FileContent.Bytes>(audio.Content).Value));

        var xml = Encoding.UTF8.GetString(
            Assert.IsType<FileContent.Bytes>(
                entries.Single(e => e.Metadata.Name == "track01.xml").Content).Value);

        Assert.Contains("<provider>Acme</provider>", xml, StringComparison.Ordinal);
        Assert.Contains("<title>Nocturne in E-flat</title>", xml, StringComparison.Ordinal);
        Assert.Contains("<fileName>track01.wav</fileName>", xml, StringComparison.Ordinal);
        Assert.DoesNotContain("track01.json", xml.Replace("<originalName>track01.json</originalName>", ""),
                              StringComparison.Ordinal);
    }

    [Fact]
    public async Task TheAcmeOutputSatisfiesTheTreeSchemaAndTheCollapserAcceptsIt()
    {
        // Its output schema IS the shared tree row, and the collapser must be able to pack what it
        // emits -- the two ends of §1.2's reuse claim, for a handler that actually reshapes content.
        const string sidecar = """
            {"title":"T","audio":{"file":"track01.wav"}}
            """;

        var envelope = await Fetch(
            "bundle.zip", Zip(("track01.wav", "RIFF"), ("track01.json", sidecar)), AnyFile);

        var normalized = await Normalize(await Expand(envelope, """{"MaxDepth":1}"""), handler: "Acme");

        Assert.True(
            ProcessorJsonSchemaValidator.TryValidate(TreeSchema(), normalized, out var errors),
            string.Join("; ", errors));

        var collapsed = await Collapse(normalized);
        Assert.Equal("bundle.zip", JsonDocument.Parse(collapsed).RootElement.GetProperty("fileName").GetString());
    }
```

- [ ] **Step 5: Run everything**

```bash
cd C:/Users/UserL/source/repos/SK_P9/src
dotnet build tests/BaseApi.Tests/BaseApi.Tests.csproj
tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class BaseApi.Tests.EnvelopeContractTests
dotnet test tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: full suite green. **Every pre-existing test in `EnvelopeContractTests` must still pass** — you widened a helper they all use.

- [ ] **Step 6: Commit**

```bash
cd C:/Users/UserL/source/repos/SK_P9
git add src/Processor.SKNormalizer src/tests/BaseApi.Tests
git commit -m "feat(sknormalizer): register Acme, and prove the mapping path end to end"
```

---

### Task 4: The seed tool

Today the chain's input zips are hand-placed with `docker cp`; nothing builds them. `tools/kafka-produce-records.py` seeds *paths only*.

**Files:**
- Create: `tools/make-sample-archives.py`
- Modify: `tools/kafka-produce-records.py` (docstring cross-reference only)

**Interfaces:** none — a standalone script.

- [ ] **Step 1: Write the tool**

Create `tools/make-sample-archives.py`. Requirements:

- Python 3, standard library only (`zipfile`, `json`, `wave`, `struct`, `argparse`, `pathlib`, `math`). **No third-party dependencies** — the other tools in this directory have none.
- `--count N` (default 1) archives, `--out DIR` (default `./out`), `--prefix NAME` (default `file`), producing `file-001.zip`, `file-002.zip`, …
- Each archive holds exactly two entries at depth 1: `track01.wav` and `track01.json`.
- The `.wav` is a **real, playable RIFF/WAVE file** written with the `wave` module — a short sine tone, 44100 Hz, 2 channels, 16-bit. Not a stub: the point of the tool is that a real ffmpeg could later convert it.
- The `.json` matches the sidecar shape `AcmeHandler` reads: `title`, `artist`, `album`, `recordedUtc`, and a nested `audio` object with `file`, `sampleRateHz`, `channels`, `durationSeconds`. The values must be **consistent with the wav actually written** — the same sample rate, channel count and duration.
- Vary `title` per archive so a multi-archive run is distinguishable downstream.
- A module docstring in the house style of `tools/kafka-produce-records.py`: state what it produces, that the paths must exist **on the node** and how to get them there (`docker cp ./out/file-001.zip desktop-control-plane:/mnt/skp-files/in/file-001.zip`), that the fetcher step is wired `allowedExtensions: [".zip"]`, and that this is the shape `AcmeHandler` expects — `.wav` plus `.json` sharing a basename, since `Locate` pairs them by basename.

- [ ] **Step 2: Run it and verify the output**

```bash
cd C:/Users/UserL/source/repos/SK_P9
python tools/make-sample-archives.py --count 2 --out /tmp/skp-seed
python -c "import zipfile,sys; z=zipfile.ZipFile('/tmp/skp-seed/file-001.zip'); print(z.namelist()); print(z.read('track01.json').decode())"
python -c "import wave,zipfile,io; z=zipfile.ZipFile('/tmp/skp-seed/file-001.zip'); w=wave.open(io.BytesIO(z.read('track01.wav'))); print(w.getnchannels(), w.getframerate(), w.getnframes())"
```

Expected: two entries named `track01.wav` and `track01.json`; the JSON's `sampleRateHz`, `channels` and `durationSeconds` agree with what the wave module reports.

- [ ] **Step 3: Cross-reference it from the record producer**

In `tools/kafka-produce-records.py`'s module docstring, beside the existing note that the paths must already exist on the node, add a line pointing at the new tool as the way to produce a conforming archive. One or two sentences; do not restructure the docstring.

- [ ] **Step 4: Commit**

```bash
cd C:/Users/UserL/source/repos/SK_P9
git add tools/
git commit -m "feat(tools): build the wav-plus-sidecar archives the chain expects"
```

---

## After the plan

**Not covered here, deliberately:**

- **Registration and deployment.** A new handler means a **new config schema row** POSTed from `sknormalizer-config.json` (a referenced definition is frozen), the processor's `ConfigSchemaId` repointed, a rebuild, a `kind load` and a SourceHash repoint. That is an operator act against a running cluster, not a code change — spec §10 has the six-step loop.
- **Audio conversion.** No handler sets a `ProfileFor`, so `FfmpegAudioTranscoder` stays unreachable from shipped code and §14's open question — which node in an item is the audio — stays open.

**Run the full suite before calling the plan done:**

```bash
cd C:/Users/UserL/source/repos/SK_P9/src
dotnet test tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Read the **shape** — 0 failed, exit 0, skips confined to `Live/` — not a remembered total.
