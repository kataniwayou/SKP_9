using System.Text.Json;
using System.Text.Json.Serialization;

namespace Processor.SKNormalizer;

/// <summary>
/// <b>The first handler that MAPS a provider's metadata rather than passing a document through.</b>
/// An Acme item is two entries sharing a basename — an audio file and the JSON sidecar beside it —
/// and this handler pairs them, projects the sidecar into the canonical metadata of the design's
/// §7.3, and emits the same topology it received with the <c>.json</c> replaced by an <c>.xml</c>.
/// <para>
/// <b>It converts no audio, deliberately.</b> <see cref="ProfileFor"/> returns null, so the wav
/// passes through byte-for-byte. That keeps the design's §14 open question — which node in an item
/// is the audio — from being answered by accident: with no conversion the pipeline's "first node
/// carrying bytes" guess never fires, and this handler selects nodes by extension in its own code,
/// which is where a handler's knowledge belongs.
/// </para>
/// <para>
/// <b>It is the first handler to override <see cref="LayoutFor"/>, and it must.</b> The base mirror
/// reproduces the input document and SUBSTITUTES NOTHING (§6.2), so a handler that emits an artifact
/// builds its own layout out of the <c>MetadataDocument</c>, <c>Audio</c> and <c>Names</c> its items
/// carry. Calling the base here would emit the sidecar's JSON and drop the rendered XML.
/// </para>
/// <para>
/// <b>Stateless, as every handler must be.</b> It is registered as a singleton beside a singleton
/// processor; the injected <see cref="TimeProvider"/> is a dependency, not state, and per-dispatch
/// values live in the pipeline's locals.
/// </para>
/// </summary>
public sealed class AcmeHandler(TimeProvider clock) : ProviderHandlerBase
{
    private const string AudioExtension = ".wav";
    private const string SidecarExtension = ".json";

    /// <summary>
    /// Cached because constructing options per call is both wasteful and a CA1869 diagnostic. The
    /// sidecar is camelCase; case-insensitivity is belt and braces for a provider that shifts one.
    /// </summary>
    private static readonly JsonSerializerOptions SidecarOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
    };

    /// <summary>
    /// Must match an entry in the <c>handler</c> enum of
    /// <c>src/tests/BaseApi.Tests/Schemas/sknormalizer-config.json</c>.
    /// </summary>
    public override string Name => "Acme";

    /// <summary>
    /// Stage 1. Groups the root's entries by BASENAME, so <c>track01.wav</c> and <c>track01.json</c>
    /// become one item keyed <c>track01</c>.
    /// <para>
    /// <b>An entry that pairs with nothing still becomes its own single-node item</b>, rather than
    /// being dropped — stage 2 is where that is reported, and an item silently discarded here would
    /// be a missing file with no failed step behind it.
    /// </para>
    /// <para>A root that is not an archive yields no items: an Acme document is a bundle.</para>
    /// </summary>
    public override IReadOnlyList<SourceItem> Locate(FileNode root)
    {
        ArgumentNullException.ThrowIfNull(root);

        if (root.Content is not FileContent.Entries entries)
        {
            return [];
        }

        return entries.Value
            .GroupBy(
                e => Path.GetFileNameWithoutExtension(e.Metadata.Name),
                StringComparer.OrdinalIgnoreCase)
            .Select(g => new SourceItem(g.Key, g.ToList()))
            .ToList();
    }

    /// <summary>
    /// Stage 2. An Acme item is exactly one audio file and exactly one sidecar. Anything else is the
    /// provider's mistake, and the message names the item so a forty-item document is diagnosable.
    /// </summary>
    public override void ValidateContent(SourceItem item)
    {
        ArgumentNullException.ThrowIfNull(item);

        var audio = Count(item, AudioExtension);
        var sidecars = Count(item, SidecarExtension);

        if (audio != 1 || sidecars != 1)
        {
            throw new NormalizationException(
                $"item '{item.Key}': an Acme item needs exactly one {AudioExtension} and one "
                + $"{SidecarExtension}, and this one holds {audio} and {sidecars}");
        }
    }

    /// <summary>
    /// Stage 3. Projects the sidecar into the standard metadata, including the audio facts the
    /// PROVIDER STATES — <see cref="Reconcile"/> is what would correct them from a measurement.
    /// </summary>
    public override StandardMetadata Map(SourceItem item)
    {
        ArgumentNullException.ThrowIfNull(item);

        var sidecar = Node(item, SidecarExtension)
            ?? throw new NormalizationException(
                $"item '{item.Key}': no {SidecarExtension} metadata sidecar to map");

        var bytes = sidecar.Content is FileContent.Bytes content
            ? content.Value
            : throw new NormalizationException(
                $"item '{item.Key}': its metadata sidecar carries no bytes");

        AcmeSidecar? parsed;

        try
        {
            parsed = JsonSerializer.Deserialize<AcmeSidecar>(bytes, SidecarOptions);
        }
        catch (JsonException)
        {
            // THE EXCEPTION'S MESSAGE IS DELIBERATELY NOT INCLUDED. It quotes the fragment that
            // failed to parse, that fragment is upstream content, and a NormalizationException
            // becomes a FailedException whose message the framework logs verbatim. Report the class
            // of fault, never the content.
            throw new NormalizationException(
                $"item '{item.Key}': its metadata sidecar is not valid JSON");
        }

        if (parsed is null)
        {
            throw new NormalizationException(
                $"item '{item.Key}': its metadata sidecar is JSON null");
        }

        return new StandardMetadata
        {
            // Provenance: the file this was mapped FROM, not the audio it describes.
            OriginalName = sidecar.Metadata.Name,
            Title = parsed.Title,
            Artist = parsed.Artist,
            Album = parsed.Album,
            RecordedUtc = parsed.RecordedUtc,
            SampleRateHz = parsed.Audio?.SampleRateHz,
            Channels = parsed.Audio?.Channels,
            DurationSeconds = parsed.Audio?.DurationSeconds,
        };
    }

    /// <summary>Stage 4. The two things knowable without reading anything: who, and when.</summary>
    public override void Augment(StandardMetadata metadata, SourceItem item)
    {
        ArgumentNullException.ThrowIfNull(metadata);

        metadata.Provider = Name;
        metadata.IngestedUtc = clock.GetUtcNow();
    }

    /// <summary>
    /// Stage 5. The metadata file takes the basename with an <c>.xml</c> extension; the audio keeps
    /// the name it arrived with, because nothing transcodes it.
    /// </summary>
    public override ItemNames NameFor(StandardMetadata metadata, SourceItem item)
    {
        ArgumentNullException.ThrowIfNull(item);

        var audio = Node(item, AudioExtension)
            ?? throw new NormalizationException(
                $"item '{item.Key}': no {AudioExtension} audio file to name");

        return new ItemNames($"{item.Key}.xml", audio.Metadata.Name);
    }

    /// <summary>Stage 6. Null: the audio passes through byte-for-byte.</summary>
    public override AudioProfile? ProfileFor(SourceItem item) => null;

    /// <summary>
    /// Stage 7. The audio file name is always folded in — it is a required element and stage 5 is
    /// the only thing that knows it.
    /// <para>
    /// <b>The measured branch never fires today</b>, since <see cref="ProfileFor"/> returns null.
    /// It is written anyway: it keeps this handler correct the day a profile is added, and it
    /// documents which three elements are MEASURED fact rather than a provider's claim.
    /// </para>
    /// <para>
    /// <b>The three do not fold the same way, and the difference is what a transcode does.</b>
    /// Duration survives one, so a provider's claim stays true when the probe read nothing and the
    /// claim is kept. Codec and bitrate describe the ENCODING the conversion just replaced, so they
    /// are overwritten unconditionally: an absent element says "unknown", which is true, while a
    /// stale one says <c>pcm_s16le</c> about a file that is now mp3.
    /// </para>
    /// </summary>
    public override void Reconcile(StandardMetadata metadata, NormalizedAudio? audio, ItemNames names)
    {
        ArgumentNullException.ThrowIfNull(metadata);
        ArgumentNullException.ThrowIfNull(names);

        metadata.AudioFileName = names.AudioFileName;

        if (audio is null)
        {
            return;
        }

        // DURATION SURVIVES A TRANSCODE; CODEC AND BITRATE DO NOT. Re-encoding does not change how
        // long the audio is, so a provider's duration claim stays true even when the probe could not
        // measure it -- hence the fallback. But codec and bitrate describe the ENCODING, which the
        // conversion just replaced: keeping a provider's claim would publish a wrong fact about the
        // file <audio><fileName> now names. An absent element says "unknown", which is true; a stale
        // one says "pcm_s16le" about a file that is now mp3.
        metadata.Codec = audio.Codec;
        metadata.DurationSeconds = audio.Duration?.TotalSeconds ?? metadata.DurationSeconds;
        metadata.BitrateKbps = audio.BitrateKbps;
    }

    /// <summary>
    /// Stage 8. The input topology, with the rendered XML in place of the sidecar.
    /// <para>
    /// <b><c>base.LayoutFor</c> is deliberately not called.</b> The mirror substitutes nothing, so
    /// it would emit the source JSON and drop the artifact this handler exists to produce.
    /// </para>
    /// <para>
    /// The root's extension, size and BOTH timestamps are carried from the input, because the
    /// assembler carries rather than synthesises them (§6.3) and a document that lost them would
    /// have lost provenance the envelope exists to convey.
    /// </para>
    /// </summary>
    public override OutputLayout LayoutFor(FileNode root, IReadOnlyList<NormalizedItem> items)
    {
        ArgumentNullException.ThrowIfNull(root);
        ArgumentNullException.ThrowIfNull(items);

        var children = new List<OutputNode>();

        foreach (var item in items)
        {
            var audio = Node(item.Source, AudioExtension);

            if (audio?.Content is FileContent.Bytes bytes)
            {
                children.Add(new OutputNode.File(
                    item.Names.AudioFileName,
                    bytes.Value,
                    audio.Metadata.CreatedUtc,
                    audio.Metadata.ModifiedUtc));
            }

            if (item.MetadataDocument is not null)
            {
                // The sidecar's own timestamps: the XML stands where the JSON stood, and a
                // downstream consumer reading modifiedUtc off it should see the item's, not now's.
                var sidecar = Node(item.Source, SidecarExtension);

                children.Add(new OutputNode.File(
                    item.Names.MetadataFileName,
                    item.MetadataDocument,
                    sidecar?.Metadata.CreatedUtc,
                    sidecar?.Metadata.ModifiedUtc));
            }
        }

        return new OutputLayout(new OutputNode.Folder(
            root.Metadata.Name,
            root.Metadata.Extension,
            root.Metadata.SizeBytes,
            root.Metadata.CreatedUtc,
            root.Metadata.ModifiedUtc,
            children));
    }

    private static FileNode? Node(SourceItem item, string extension)
        => item.Nodes.FirstOrDefault(
            n => string.Equals(n.Metadata.Extension, extension, StringComparison.OrdinalIgnoreCase));

    private static int Count(SourceItem item, string extension)
        => item.Nodes.Count(
            n => string.Equals(n.Metadata.Extension, extension, StringComparison.OrdinalIgnoreCase));

    /// <summary>
    /// The sidecar, mirrored exactly as Acme ships it. <b>Private and nested</b>: it is this
    /// handler's reading of one provider's file, not a type anything else has business naming, and
    /// keeping it here is what stops a provider's vocabulary leaking into the shared pipeline.
    /// Every member is nullable because a provider's absent field is a fact to carry, not a parse
    /// failure — the canonical XML omits an unknown element rather than emitting it empty (§7.3).
    /// </summary>
    private sealed record AcmeSidecar(
        string? Title,
        string? Artist,
        string? Album,
        DateTimeOffset? RecordedUtc,
        AcmeSidecarAudio? Audio);

    /// <summary>The sidecar's <c>audio</c> object.</summary>
    /// <param name="File">
    /// Read and deliberately unused: <see cref="NameFor"/> takes the audio name from the NODE that
    /// is actually present, so a sidecar naming a file the bundle does not contain cannot rename
    /// anything. It is mapped so the shape documents what Acme sends.
    /// </param>
    private sealed record AcmeSidecarAudio(
        [property: JsonPropertyName("file")] string? File,
        int? SampleRateHz,
        int? Channels,
        double? DurationSeconds);
}
