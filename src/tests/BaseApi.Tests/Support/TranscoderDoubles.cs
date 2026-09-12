using System.Text;
using Processor.SKNormalizer;

namespace BaseApi.Tests.Support;

/// <summary>
/// Returns a fixed result and records what it was asked for.
/// <para>
/// Hand-written rather than an NSubstitute mock because <c>IAudioTranscoder</c> is internal to
/// Processor.SKNormalizer: Castle DynamicProxy cannot proxy it without that assembly naming
/// DynamicProxyGenAssembly2, and adding an InternalsVisibleTo purely to satisfy a mocking library is
/// a worse trade than twenty lines here.
/// </para>
/// </summary>
internal sealed class FakeTranscoder : IAudioTranscoder
{
    public List<AudioProfile> Calls { get; } = [];

    public NormalizedAudio Transcode(
        byte[] source, string sourceExtension, AudioProfile profile, CancellationToken ct)
    {
        Calls.Add(profile);

        var content = Encoding.UTF8.GetBytes("converted");

        return new NormalizedAudio(
            content, profile.TargetExtension, content.LongLength,
            TimeSpan.FromSeconds(184), 192, "mp3");
    }
}

/// <summary>
/// Throws if it is ever called. Used wherever a test asserts that NO conversion happened — an
/// unexercised substitute would pass silently, and this fails loudly.
/// </summary>
internal sealed class ExplodingTranscoder : IAudioTranscoder
{
    public NormalizedAudio Transcode(
        byte[] source, string sourceExtension, AudioProfile profile, CancellationToken ct)
        => throw new InvalidOperationException("the pipeline should not have transcoded");
}
