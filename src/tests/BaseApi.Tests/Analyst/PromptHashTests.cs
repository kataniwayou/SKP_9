using Processor.Analyst.Bit;
using Xunit;

namespace BaseApi.Tests.Analyst;

public sealed class PromptHashTests
{
    [Fact]
    public void TheSamePromptHashesTheSame()
        => Assert.Equal(PromptHash.Of("look for drift"), PromptHash.Of("look for drift"));

    [Fact]
    public void DifferentPromptsHashDifferently()
        => Assert.NotEqual(PromptHash.Of("look for drift"), PromptHash.Of("look for spikes"));

    [Fact]
    public void WhitespaceIsNormalizedBeforeHashing()
    {
        // Two prompts that differ only in how they were wrapped are the same prompt. Without this
        // the cache misses on every reformat and the BIT silently runs every dispatch -- restoring
        // the doubled cost with nothing to show it.
        Assert.Equal(
            PromptHash.Of("look for drift\r\n  across the window"),
            PromptHash.Of("look for drift\n across the window"));
    }

    [Fact]
    public void LeadingAndTrailingWhitespaceDoesNotChangeTheHash()
        => Assert.Equal(PromptHash.Of("look for drift"), PromptHash.Of("  look for drift\n\n"));

    [Fact]
    public void TheHashIsLowercaseHexAndFixedLength()
    {
        var hash = PromptHash.Of("x");

        Assert.Equal(64, hash.Length);
        Assert.Equal(hash.ToLowerInvariant(), hash);
    }

    [Fact]
    public void AParagraphBreakChangesTheHash()
    {
        // The most plausible fix for a MALFORMED verdict -- two stage descriptions that ran together
        // in one paragraph -- is inserting a blank line between them. If that collapsed to the same
        // hash as the broken prompt, the corrected prompt would find its own stale unfit verdict
        // still sitting in the cache.
        Assert.NotEqual(
            PromptHash.Of("plan: state each hypothesis.\n\nverify: judge each hypothesis."),
            PromptHash.Of("plan: state each hypothesis. verify: judge each hypothesis."));
    }
}
