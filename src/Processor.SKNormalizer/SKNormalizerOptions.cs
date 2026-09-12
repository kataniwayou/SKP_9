namespace Processor.SKNormalizer;

/// <summary>
/// Bound from <c>SKNormalizer__*</c> in the manifest. These are numbers an operator sizes against a
/// container limit, and a workflow author has no way to know them.
/// <para>
/// <b>THERE IS DELIBERATELY NO SIZE CEILING HERE, and it is not an omission left from a copy.</b>
/// The input document already passed ArchiveExpander, whose <c>MaxExpandedBytes</c> bounds total
/// expanded content, so a second input ceiling would restate an upstream guarantee with a second
/// number to keep consistent. The consequence is accepted knowingly: that number now sizes TWO
/// consumers, conversion can grow data, output size is unbounded, and an out-of-memory pod at
/// prefetch 1 is a redelivery loop rather than one failure. The mitigation is sizing, not code.
/// </para>
/// </summary>
public sealed class SKNormalizerOptions
{
    /// <summary>Resolved from PATH by default; the image installs it.</summary>
    public string FfmpegPath { get; set; } = "ffmpeg";

    /// <summary>
    /// Per conversion, not per dispatch. A wedged ffmpeg holds the one prefetched message forever,
    /// so this is what turns a hang into a failed step.
    /// </summary>
    public int ConversionTimeoutSeconds { get; set; } = 300;
}
