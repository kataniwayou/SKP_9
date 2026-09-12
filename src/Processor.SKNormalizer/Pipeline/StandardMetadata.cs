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
