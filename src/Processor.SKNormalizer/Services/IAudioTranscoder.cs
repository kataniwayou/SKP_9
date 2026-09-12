namespace Processor.SKNormalizer;

/// <summary>
/// Runs one conversion. <b>No handler shells out</b>: one place composes a command line, one place
/// has a timeout, one place cleans up temp files, and one place is what a test replaces.
/// </summary>
internal interface IAudioTranscoder
{
    /// <exception cref="NormalizationException">The conversion failed or timed out.</exception>
    NormalizedAudio Transcode(
        byte[] source, string sourceExtension, AudioProfile profile, CancellationToken ct);
}
