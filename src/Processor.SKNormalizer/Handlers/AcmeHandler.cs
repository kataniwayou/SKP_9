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
    /// <para>
    /// <b>A LEAF ROOT IS A FAILED STEP, NOT AN EMPTY RESULT.</b> ArchiveExpander emits a
    /// <c>Bytes</c> root for any fetched file it does not recognise as an archive, and returning
    /// no items for one would send an empty item list into <see cref="LayoutFor"/>, which builds a
    /// childless <c>Folder</c>, which the assembler emits as <c>content: null</c> — <b>the
    /// document's bytes destroyed with no failed step</b>. That is the exact defect
    /// <c>OutputLayout</c> was reshaped to make unrepresentable, and a handler must not reintroduce
    /// it. An Acme document is a bundle of paired entries, so a document this handler cannot open
    /// is a wrong-feed situation and belongs in a failure message naming the root.
    /// </para>
    /// <para>
    /// <b>An archive that expanded to nothing is left alone.</b> Empty in, empty out is correct, and
    /// only a leaf root can lose content.
    /// </para>
    /// </summary>
    /// <exception cref="NormalizationException">The root is a file rather than an archive.</exception>
    public override IReadOnlyList<SourceItem> Locate(FileNode root)
    {
        ArgumentNullException.ThrowIfNull(root);

        if (root.Content is FileContent.Bytes)
        {
            throw new NormalizationException(
                $"'{root.Metadata.Name}' is a file rather than an archive, and an Acme document is "
                + $"a bundle of {AudioExtension}/{SidecarExtension} pairs");
        }

        if (root.Content is not FileContent.Entries entries)
        {
            // An archive that expanded to nothing. No items, and nothing to lose.
            return [];
        }

        return entries.Value
            .GroupBy(
                e => Path.GetFileNameWithoutExtension(e.Metadata.Name),
                StringComparer.OrdinalIgnoreCase)
            // AUDIO FIRST, AND THE ORDER IS A CONVENTION RATHER THAN A PREFERENCE. §14 leaves "which
            // node in an item is the audio" open, and the pipeline's stage 6 answers it with
            // Nodes.FirstOrDefault(n => n.Content is FileContent.Bytes) -- so the node a handler puts
            // first is the node ffmpeg is handed. This handler transcodes nothing, so today the order
            // is inert; a clone that adds a ProfileFor inherits this Locate, and most zip writers emit
            // entries alphabetically, which would put track01.json ahead of track01.wav and feed the
            // SIDECAR to the transcoder. That fails loudly but costs the next author an afternoon, and
            // encoding the convention here costs nothing. OrderByDescending on a bool is stable, so
            // everything after the audio keeps the order the archive had.
            .Select(g => new SourceItem(
                g.Key,
                g.OrderByDescending(e => IsExtension(e, AudioExtension)).ToList()))
            .ToList();
    }

    /// <summary>
    /// Stage 2. An Acme item is exactly one audio file and exactly one sidecar — <b>two nodes, no
    /// more</b>.
    /// <para>
    /// <b>A third entry sharing the basename is rejected rather than carried.</b>
    /// <see cref="LayoutFor"/> emits one audio and one XML per item, so a <c>track01.txt</c> beside
    /// the pair would simply vanish from the output with nothing failing. Carrying unknown nodes
    /// through is the other defensible answer; rejecting is right here, because this handler's
    /// contract IS the pair and a third file means the feed is not what the operator thought.
    /// </para>
    /// <para>
    /// <b>The messages do not name the item.</b> <c>NormalizationPipeline</c> prepends
    /// <c>item '{key}': </c> to every <see cref="NormalizationException"/> a stage throws, uniformly
    /// across handlers; repeating it here reads as <c>item 'track01': item 'track01': …</c>.
    /// </para>
    /// </summary>
    public override void ValidateContent(SourceItem item)
    {
        ArgumentNullException.ThrowIfNull(item);

        var audio = Count(item, AudioExtension);
        var sidecars = Count(item, SidecarExtension);

        if (audio != 1 || sidecars != 1)
        {
            throw new NormalizationException(
                $"an Acme item needs exactly one {AudioExtension} and one {SidecarExtension}, and "
                + $"this one holds {audio} and {sidecars}");
        }

        if (item.Nodes.Count != 2)
        {
            var unexpected = item.Nodes
                .Where(n => !IsExtension(n, AudioExtension) && !IsExtension(n, SidecarExtension))
                .Select(n => n.Metadata.Name);

            throw new NormalizationException(
                $"an Acme item is exactly the {AudioExtension} and the {SidecarExtension}, and this "
                + $"one also holds {string.Join(", ", unexpected)}");
        }

        // COUNTING BY EXTENSION IS NOT ENOUGH. FileNode.Content is nullable and the expander can emit
        // a node with none, so an item can hold exactly one .wav that carries nothing. Stage 8 emits
        // the audio entry unconditionally, so a contentless node there would be a NullReference or a
        // silently dropped file; checked HERE it is a named failed step with the item key attached.
        var audioNode = Node(item, AudioExtension);

        if (audioNode?.Content is not FileContent.Bytes)
        {
            throw new NormalizationException(
                $"the {AudioExtension} audio file carries no content");
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
                $"there is no {SidecarExtension} metadata sidecar to map");

        var bytes = sidecar.Content is FileContent.Bytes content
            ? content.Value
            : throw new NormalizationException(
                "the metadata sidecar carries no bytes");

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
                "the metadata sidecar is not valid JSON");
        }

        if (parsed is null)
        {
            throw new NormalizationException(
                "the metadata sidecar is JSON null");
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
        ArgumentNullException.ThrowIfNull(item);

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
                $"there is no {AudioExtension} audio file to name");

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
            // THESE TWO MESSAGES NAME THE ITEM, unlike every other message in this file. Stage 8 runs
            // OUTSIDE the pipeline's per-item try/catch, so nothing prepends "item '{key}': " here.
            var audio = Node(item.Source, AudioExtension)
                ?? throw new NormalizationException(
                    $"item '{item.Source.Key}': there is no {AudioExtension} audio file to emit");

            if (audio.Content is not FileContent.Bytes bytes)
            {
                // ValidateContent already refused this; the throw is here so the emission below can
                // be unconditional. Silently skipping the entry was how an audio node with no bytes
                // used to leave the output an XML with no file beside it.
                throw new NormalizationException(
                    $"item '{item.Source.Key}': the {AudioExtension} audio file carries no content");
            }

            children.Add(new OutputNode.File(
                item.Names.AudioFileName,
                // THE BYTES THE PIPELINE PRODUCED, NOT THE ONES IT RECEIVED. Stage 6 puts its output
                // in NormalizedItem.Audio, stage 5 named this entry for what the conversion produces
                // (".mp3"), and Reconcile wrote the MEASURED codec and bitrate into the XML beside it.
                // Emitting the source bytes under that name would make the extension, <codec> and
                // <bitrateKbps> all lie about the entry's content, with nothing failing and the
                // collapser packing it happily. The fallback arm is this handler's OWN case:
                // ProfileFor returns null, no conversion happens, Audio is null, and the wav passes
                // through byte-for-byte -- and it is also the arm a metadata-only clone will use.
                item.Audio is { } converted ? converted.Content : bytes.Value,
                audio.Metadata.CreatedUtc,
                audio.Metadata.ModifiedUtc));

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

    private static bool IsExtension(FileNode node, string extension)
        => string.Equals(node.Metadata.Extension, extension, StringComparison.OrdinalIgnoreCase);

    private static FileNode? Node(SourceItem item, string extension)
        => item.Nodes.FirstOrDefault(n => IsExtension(n, extension));

    private static int Count(SourceItem item, string extension)
        => item.Nodes.Count(n => IsExtension(n, extension));

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
