using BaseProcessor.Core.Configuration;

namespace Processor.ArchiveExpander;

/// <summary>
/// The step payload, and it holds exactly one field.
/// <para>
/// <b>Every file rule left with the filesystem.</b> Extension and size are knowable from
/// <c>FileInfo</c> and are checked by <c>FileFetcher</c> before the file is opened; this processor
/// never sees a path and could not re-check them if it wanted to. What is left is the one decision
/// that is genuinely about expansion.
/// </para>
/// <para>
/// <b>There is no expansion ceiling here either, and that is a decision.</b> How much an archive
/// expands to is a number an operator sizes against a container limit — a workflow author has no way
/// to know it — so it lives in the manifest as <c>ArchiveExpander__MaxExpandedBytes</c>. See
/// <see cref="ArchiveExpanderOptions"/>.
/// </para>
/// </summary>
/// <param name="MaxDepth">
/// How many levels of archive to expand. <b>Absent means 1</b> — the top-level archive is expanded
/// and its entries are left as files.
/// <para>
/// <b>The fallback is the parameter's own default, and that was verified rather than assumed.</b>
/// System.Text.Json applies a C# default parameter value when a positional record's property is
/// missing from the payload, so an omitted field arrives as 1 rather than as <c>default(int)</c>.
/// That keeps "absent" and "zero" distinguishable without a nullable: absent is 1, and an explicit 0
/// stays 0 and is a rejected payload.
/// </para>
/// <para>
/// <b>It has no memory cost of its own, which is why it has no pod-level twin.</b> Depth costs
/// nothing; bytes do, and <see cref="ArchiveExpanderOptions.MaxExpandedBytes"/> already bounds those
/// across the whole tree.
/// </para>
/// <para>
/// <b>The registered output schema is the other bound on this, and nothing keeps the two in
/// sync.</b> The schema is a row against the processor identity and it states its depth
/// structurally. A step whose <c>MaxDepth</c> produces a document deeper than the schema admits
/// fails validation in the post handler. That is the contract working, not a fault to design around,
/// but it is why raising this is a decision taken against the schema rather than alone.
/// </para>
/// </param>
public sealed record ArchiveExpanderConfig(
    int MaxDepth = ArchiveExpanderConfig.DefaultMaxDepth) : ProcessorConfig
{
    /// <summary>
    /// The default: expand the top-level archive, leave its entries as files.
    /// <para>
    /// It is the value this processor behaved as before <see cref="MaxDepth"/> existed, so every
    /// workflow authored without the field keeps its documents byte-identical in shape.
    /// </para>
    /// </summary>
    public const int DefaultMaxDepth = 1;

    /// <summary>
    /// The most any step may ask for.
    /// <para>
    /// <b>A cap exists so the expansion cannot outrun the stack.</b> The builder recurses, and a
    /// bounded depth is what makes that safe to read and safe to run. Nothing legitimate nests
    /// archives four deep, and a self-reproducing archive — which expands to a copy of itself at
    /// roughly constant size — is stopped here rather than being left to grind against the expansion
    /// ceiling for thousands of levels first.
    /// </para>
    /// <para>
    /// <b>It was 64, and 64 was a number this system could not actually reach.</b> Neither assembly
    /// sets <c>JsonSerializerOptions.MaxDepth</c>, so the deserializer's default of 64 JSON levels
    /// caps a document near 32 NODE levels — each node costs two. A step naming 40 was therefore
    /// ACCEPTED here as legal and then could not round-trip: the collapser reported it as
    /// <c>the branch is not JSON</c>, diagnosing a depth overflow as a parse error. Four sits far
    /// below that wall, so every value this validator accepts is a value the loop can carry, and
    /// every value it rejects is rejected HERE — before a file is opened, with a message naming
    /// <c>MaxDepth</c> — rather than three hops later as corrupt data.
    /// </para>
    /// <para>
    /// <b>Four rather than something roomier, because the real feeds are shallower still.</b>
    /// Observed archives nest two deep; four leaves headroom for a level nobody has seen without
    /// pretending this pipeline is in the business of deep nesting. Raising it is a one-line change
    /// and needs no schema work — v3.0.0 admits any depth — so the cheap direction is up, later,
    /// against a file that actually needs it.
    /// </para>
    /// <para>
    /// <b>The registered output schema no longer bounds this, which is why the number had to become
    /// honest.</b> <c>archive-document</c> v2.0.0 unrolled the document shape to a fixed depth 2 and
    /// rejected anything deeper with a clear schema failure; v3.0.0 is one self-referencing node and
    /// admits any depth. This constant is now the only declared ceiling on expansion.
    /// </para>
    /// </summary>
    public const int MaxSupportedDepth = 4;
}
