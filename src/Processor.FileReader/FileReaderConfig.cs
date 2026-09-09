using BaseProcessor.Core.Configuration;

namespace Processor.FileReader;

/// <summary>
/// The step payload. Flat and scalar, bound case-insensitively by
/// <see cref="ProcessorConfig.SerializerOptions"/>, which also ignores unknown properties so a field
/// added later does not break workflows authored before it.
/// <para>
/// <b>There is no ExpectedEntryCount here, and that is a decision.</b> Entry count is the one
/// expectation only knowable AFTER the archive is opened, so checking it in the payload saves
/// nothing; it lives in the output schema instead. Extension and size are knowable from
/// <c>FileInfo</c>, and checking them here is what stops the file being read at all.
/// </para>
/// </summary>
/// <param name="ExpectedExtension">
/// Leading dot, compared case-insensitively — <c>".zip"</c>.
/// <para>
/// <b>It ADMITS a file to the step; it does not choose the extractor.</b> That split arrived with
/// nested expansion: below the first level nothing has a declared extension, so the extractor is
/// chosen from the bytes themselves (see <see cref="Extractors.IArchiveExtractor.CanHandle"/>) and
/// this field keeps only the job it can do at every depth — refusing a file the step did not ask
/// for, before it is opened.
/// </para>
/// </param>
/// <param name="MinimumSizeBytes">Floor, inclusive. Zero disables the check.</param>
/// <param name="MaximumSizeBytes">
/// Ceiling, inclusive, for THIS step. Admitted only if it fits inside the pod's own ceiling — see
/// <see cref="FileReaderOptions"/>.
/// <para>
/// <b>IT BOUNDS TWO THINGS, NOT ONE: the file on disk AND the cumulative size of everything the
/// archive expands to, across every level.</b> A deliberate semantic change, made because the
/// design's memory budget (and the limit in <c>k8s/37-processor-filereader.yaml</c>) prices the
/// transient cost at ~1.78x <i>the file</i> — correct for a leaf, and wrong for an archive, where
/// the document is ~1.33x the <i>expanded</i> content. An ordinary 10:1 CSV zip admitted at a 32 MiB
/// file ceiling is ~320 MB expanded before the document and the envelope are counted.
/// </para>
/// <para>
/// <b>ONE running total for the whole tree, not one per level.</b> This is what makes
/// <see cref="MaxDepth"/> safe to raise: a per-level ceiling would let a depth-5 archive hold five
/// times this number, and the pod's memory does not care which level a byte came from.
/// </para>
/// <para>
/// <b>No second field, and that is the ruling rather than an oversight.</b> A separate expansion
/// ceiling would be one more number a workflow author has to get right, and its only honest default
/// is this one. So a step that must admit a highly compressible archive raises this value, within
/// whatever the pod ceiling allows — the same knob, now meaning "the most this step will hold in
/// memory at once" rather than "the biggest file this step will open".
/// </para>
/// <para>
/// A file that expands past it fails with the <c>extracting {FilePath} failed:</c> template naming
/// both the expanded total and this ceiling, and NOT with the <c>rejected</c> template — the file
/// itself broke no rule, and an operator searching for a size rejection would not find a fault that
/// only exists once the archive was opened.
/// </para>
/// </param>
/// <param name="MaxDepth">
/// How many levels of archive to expand. <b>Absent means 1</b> — the top-level archive is expanded
/// and its entries are left as files, which is what this processor did before nesting existed. Read
/// it through <see cref="EffectiveMaxDepth"/> rather than directly.
/// <para>
/// <b>Nullable so that "absent" and "zero" are different answers.</b> System.Text.Json does not
/// apply a C# default parameter value to a missing property on a positional record — it passes
/// <c>default(int)</c>, which is 0 — so a non-nullable field could not tell a payload that omitted
/// this from one that explicitly asked for no expansion at all. Null is absent and becomes 1; 0 is a
/// rejected payload.
/// </para>
/// <para>
/// <b>It has no memory cost of its own, which is why it has no pod-level twin.</b> Depth costs
/// nothing; bytes do, and <see cref="MaximumSizeBytes"/> already bounds those across the whole tree
/// against a ceiling the pod validates. A <c>FileReader__MaxDepth</c> would be a second knob
/// guarding a thing already guarded.
/// </para>
/// <para>
/// <b>The registered output schema is the other bound on this, and nothing keeps the two in
/// sync.</b> The schema is a row against the processor identity — one schema for every workflow
/// using this processor — and it states its depth structurally. A step whose <c>MaxDepth</c>
/// produces a document deeper than the schema admits fails validation in the post handler. That is
/// the contract working, not a fault to design around, but it is why raising this is a decision
/// taken against the schema rather than alone.
/// </para>
/// </param>
public sealed record FileReaderConfig(
    string ExpectedExtension,
    long MinimumSizeBytes,
    long MaximumSizeBytes,
    int? MaxDepth = null) : ProcessorConfig
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
    /// bounded depth is what makes that safe to read and safe to run. The number is arbitrary and
    /// deliberately generous: nothing legitimate nests archives sixty-four deep, and a
    /// self-reproducing archive — which expands to a copy of itself at roughly constant size — is
    /// stopped here rather than being left to grind against
    /// <see cref="MaximumSizeBytes"/> for thousands of levels first.
    /// </para>
    /// </summary>
    public const int MaxSupportedDepth = 64;

    /// <summary>
    /// <see cref="MaxDepth"/> with the absent case resolved. Valid only once the processor has
    /// admitted the payload, which is where the range is enforced.
    /// </summary>
    public int EffectiveMaxDepth => MaxDepth ?? DefaultMaxDepth;
}
