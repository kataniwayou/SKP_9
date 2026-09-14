using System.Text.Json;
using BaseProcessor.Core.Configuration;
using Processor.SKNormalizer;
using Xunit;

namespace BaseApi.Tests.SKNormalizer;

/// <summary>
/// The cache seam, declared and not yet read.
/// <para>
/// It is added ahead of the behaviour because adding it later is not free.
/// <c>ProcessorConfig.SerializerOptions</c> leaves <c>UnmappedMemberHandling</c> at its default of
/// Skip, so a payload carrying <c>cacheAddress</c> against a record that does not declare it is
/// silently discarded — the exact failure that looks like a whitelist matching nothing. Declaring it
/// now means the behaviour change later is a handler edit rather than a contract edit.
/// </para>
/// </summary>
public sealed class SKNormalizerConfigTests
{
    private static SKNormalizerConfig? Bind(string payload) =>
        JsonSerializer.Deserialize<SKNormalizerConfig>(payload, ProcessorConfig.SerializerOptions);

    [Fact]
    public void APayloadCarryingACacheAddressBindsIt()
    {
        var config = Bind(
            """{"handler":"Acme","cacheAddress":"skp:11111111-1111-1111-1111-111111111111:cache:sk-whitelist"}""");

        Assert.Equal(
            "skp:11111111-1111-1111-1111-111111111111:cache:sk-whitelist",
            config!.CacheAddress);
    }

    [Fact]
    public void APayloadOmittingItLeavesItNull()
    {
        // Null is what the processor will later treat as a payload defect rather than a cache miss,
        // so that a step whose address was forgotten fails loudly instead of cancelling every
        // document as though nothing were whitelisted.
        var config = Bind("""{"handler":"Acme"}""");

        Assert.Null(config!.CacheAddress);
    }

    [Fact]
    public void TheHandlerStillBinds()
    {
        Assert.Equal("Acme", Bind("""{"handler":"Acme"}""")!.Handler);
    }
}
